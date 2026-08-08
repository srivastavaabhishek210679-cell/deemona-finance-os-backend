import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';
import * as multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

export function createDocumentAIRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── POST /api/document-ai/read-invoice ────────────────────
  // Accepts image or PDF, extracts invoice data using Claude Vision
  router.post('/read-invoice', requireAuth, (upload as any).single('file'), async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const file = (req as any).file;

      if (!file) {
        res.status(400).json({ error: 'No file uploaded. Send a file with key "file".' });
        return;
      }

      const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
      if (!allowedTypes.includes(file.mimetype)) {
        res.status(400).json({ error: 'Only JPEG, PNG, WebP, and PDF files are supported.' });
        return;
      }

      // Read file and convert to base64
      const fileBuffer = fs.readFileSync(file.path);
      const base64Data = fileBuffer.toString('base64');
      const mediaType = file.mimetype === 'application/pdf' ? 'application/pdf' : file.mimetype;

      // Get vendors for matching
      const vendors = await pool.query(
        'SELECT id, name, gstin, email FROM vendors WHERE tenant_id = $1 AND is_active = TRUE',
        [tenantId]
      );

      const prompt = `You are an invoice extraction AI. Extract all information from this invoice/document.

Return a JSON object with this exact structure (use null for missing fields):
{
  "invoice_number": string,
  "invoice_date": "YYYY-MM-DD",
  "due_date": "YYYY-MM-DD",
  "vendor_name": string,
  "vendor_gstin": string,
  "vendor_address": string,
  "vendor_email": string,
  "vendor_phone": string,
  "bill_to": string,
  "line_items": [
    {
      "description": string,
      "quantity": number,
      "unit": string,
      "unit_price": number,
      "amount": number,
      "hsn_sac": string,
      "tax_rate": number
    }
  ],
  "subtotal": number,
  "cgst": number,
  "sgst": number,
  "igst": number,
  "total_tax": number,
  "total_amount": number,
  "currency": "INR",
  "payment_terms": string,
  "bank_details": string,
  "notes": string,
  "po_reference": string,
  "confidence": "high" | "medium" | "low"
}

Known vendors in the system: ${vendors.rows.map((v: any) => v.name + (v.gstin ? ' (GSTIN: ' + v.gstin + ')' : '')).join(', ')}

Return ONLY valid JSON, no markdown, no explanation.`;

      // Call Claude with vision
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: mediaType === 'application/pdf' ? 'document' : 'image',
              source: {
                type: 'base64',
                media_type: mediaType as any,
                data: base64Data,
              },
            } as any,
            { type: 'text', text: prompt },
          ],
        }],
      });

      // Clean up temp file
      fs.unlinkSync(file.path);

      const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
      const clean = text.replace(/```json|```/g, '').trim();
      const extracted = JSON.parse(clean);

      // Try to match vendor
      let matchedVendor = null;
      if (extracted.vendor_gstin) {
        const match = vendors.rows.find((v: any) =>
          v.gstin === extracted.vendor_gstin
        );
        if (match) matchedVendor = match;
      }
      if (!matchedVendor && extracted.vendor_name) {
        const nameLower = extracted.vendor_name.toLowerCase();
        const match = vendors.rows.find((v: any) =>
          v.name.toLowerCase().includes(nameLower) ||
          nameLower.includes(v.name.toLowerCase())
        );
        if (match) matchedVendor = match;
      }

      res.json({
        extracted,
        matched_vendor: matchedVendor,
        ready_to_create: !!(extracted.invoice_number && extracted.total_amount && extracted.vendor_name),
      });
    } catch (err) {
      // Clean up temp file on error
      if ((req as any).file?.path) {
        try { fs.unlinkSync((req as any).file.path); } catch {}
      }
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/document-ai/create-invoice ─────────────────
  // Creates AP invoice from extracted data
  router.post('/create-invoice', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tenantId = tid(req);
      const { extracted, vendor_id, create_vendor_if_missing } = req.body;

      let finalVendorId = vendor_id;

      // Create vendor if not found and user wants to
      if (!finalVendorId && create_vendor_if_missing && extracted.vendor_name) {
        const newVendor = await client.query(
          `INSERT INTO vendors (tenant_id, name, gstin, email, phone)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [tenantId, extracted.vendor_name, extracted.vendor_gstin,
           extracted.vendor_email, extracted.vendor_phone]
        );
        finalVendorId = newVendor.rows[0].id;
      }

      if (!finalVendorId) {
        res.status(400).json({ error: 'vendor_id required or set create_vendor_if_missing: true' });
        return;
      }

      // Generate invoice number
      const invNum = await client.query(
        `SELECT next_accounting_number($1, 'ap_invoice', 'BILL') AS num`,
        [tenantId]
      );

      const subtotal   = parseFloat(extracted.subtotal || 0);
      const totalTax   = parseFloat(extracted.total_tax || 0);
      const totalAmount = parseFloat(extracted.total_amount || 0) || (subtotal + totalTax);

      const invoice = await client.query(
        `INSERT INTO ap_invoices (tenant_id, vendor_id, invoice_number, date, due_date, subtotal, tax_amount, total_amount, paid_amount, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'submitted',$9) RETURNING *`,
        [tenantId, finalVendorId, extracted.invoice_number || invNum.rows[0].num,
         extracted.invoice_date || new Date().toISOString().split('T')[0],
         extracted.due_date || new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0],
         subtotal, totalTax, totalAmount,
         'Auto-created by Document AI from uploaded invoice']
      );

      // Create line items if available
      if (extracted.line_items?.length) {
        for (const item of extracted.line_items) {
          await client.query(
            `INSERT INTO po_lines (po_id, description, quantity, unit_price, amount, hsn_sac)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [invoice.rows[0].id, item.description, item.quantity || 1,
             item.unit_price || 0, item.amount || 0, item.hsn_sac]
          ).catch(() => {}); // po_lines may not apply, ignore errors
        }
      }

      await client.query('COMMIT');
      res.json({ invoice: invoice.rows[0], vendor_id: finalVendorId });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally {
      client.release();
    }
  });

  // ── POST /api/document-ai/analyze-text ───────────────────
  // Analyze any financial text/email and extract key info
  router.post('/analyze-text', requireAuth, async (req: Request, res: Response) => {
    try {
      const { text, type = 'auto' } = req.body;
      if (!text) { res.status(400).json({ error: 'text is required' }); return; }

      const prompt = `You are a financial document AI. Analyze this text and extract key financial information.

Document type hint: ${type}

Text to analyze:
"""
${text}
"""

Return JSON with:
{
  "document_type": "invoice|payment|contract|email|receipt|other",
  "key_entities": { "vendor": string, "customer": string, "amount": number, "date": string, "reference": string },
  "action_required": "create_invoice|record_payment|create_po|none",
  "summary": string (one sentence),
  "extracted_data": object (relevant fields based on document type),
  "confidence": "high|medium|low"
}

Return only valid JSON.`;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      });

      const text2 = response.content[0].type === 'text' ? response.content[0].text : '{}';
      const result = JSON.parse(text2.replace(/```json|```/g, '').trim());
      res.json(result);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
