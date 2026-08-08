import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function createEmailAIRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── POST /api/email-ai/analyze ────────────────────────────
  // Analyzes email text and extracts financial data
  router.post('/analyze', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { email_text, email_subject = '', email_from = '' } = req.body;
      if (!email_text) { res.status(400).json({ error: 'email_text is required' }); return; }

      const vendors = await pool.query('SELECT id, name, gstin, email FROM vendors WHERE tenant_id=$1 AND is_active=TRUE', [tenantId]);
      const customers = await pool.query('SELECT id, name, gstin, email FROM customers WHERE tenant_id=$1 AND is_active=TRUE', [tenantId]);

      const prompt = `You are a financial email AI. Analyze this email and extract all financial information.

From: ${email_from}
Subject: ${email_subject}
Body:
${email_text}

Known vendors: ${vendors.rows.map((v: any) => v.name).join(', ')}
Known customers: ${customers.rows.map((c: any) => c.name).join(', ')}

Return JSON:
{
  "email_type": "invoice|payment_confirmation|payment_reminder|quote|purchase_order|contract|statement|other",
  "action_required": "create_ap_invoice|record_payment|create_ar_invoice|create_po|flag_for_review|none",
  "urgency": "high|medium|low",
  "summary": "one sentence summary",
  "extracted": {
    "invoice_number": string|null,
    "amount": number|null,
    "currency": "INR",
    "date": "YYYY-MM-DD"|null,
    "due_date": "YYYY-MM-DD"|null,
    "vendor_name": string|null,
    "customer_name": string|null,
    "gstin": string|null,
    "payment_terms": string|null,
    "description": string|null,
    "tax_amount": number|null,
    "subtotal": number|null,
    "reference_number": string|null
  },
  "matched_vendor_name": string|null,
  "matched_customer_name": string|null,
  "suggested_response": string|null,
  "confidence": "high|medium|low"
}
Return only valid JSON.`;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
      const result = JSON.parse(text.replace(/```json|```/g, '').trim());

      // Find matched vendor/customer IDs
      const matchedVendor = vendors.rows.find((v: any) =>
        result.matched_vendor_name && v.name.toLowerCase().includes(result.matched_vendor_name.toLowerCase())
      );
      const matchedCustomer = customers.rows.find((c: any) =>
        result.matched_customer_name && c.name.toLowerCase().includes(result.matched_customer_name.toLowerCase())
      );

      res.json({ ...result, matched_vendor: matchedVendor || null, matched_customer: matchedCustomer || null });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/email-ai/create-from-email ─────────────────
  router.post('/create-from-email', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tenantId = tid(req);
      const { analysis, vendor_id, customer_id } = req.body;
      const ext = analysis.extracted;

      let created: any = {};

      if (analysis.action_required === 'create_ap_invoice' && (vendor_id || analysis.matched_vendor?.id)) {
        const vid = vendor_id || analysis.matched_vendor?.id;
        const invoice = await client.query(
          `INSERT INTO ap_invoices (tenant_id, vendor_id, invoice_number, date, due_date, subtotal, tax_amount, total_amount, paid_amount, status, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'submitted','Auto-created by Email AI') RETURNING *`,
          [tenantId, vid, ext.invoice_number || `EMAIL-${Date.now()}`,
           ext.date || new Date().toISOString().split('T')[0],
           ext.due_date || new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0],
           ext.subtotal || ext.amount || 0, ext.tax_amount || 0,
           ext.amount || (ext.subtotal || 0) + (ext.tax_amount || 0)]
        );
        created.ap_invoice = invoice.rows[0];
      }

      if (analysis.action_required === 'create_ar_invoice' && (customer_id || analysis.matched_customer?.id)) {
        const cid = customer_id || analysis.matched_customer?.id;
        const invoice = await client.query(
          `INSERT INTO ar_invoices (tenant_id, customer_id, invoice_number, date, due_date, subtotal, tax_amount, total_amount, paid_amount, status, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'sent','Auto-created by Email AI') RETURNING *`,
          [tenantId, cid, ext.invoice_number || `AR-EMAIL-${Date.now()}`,
           ext.date || new Date().toISOString().split('T')[0],
           ext.due_date || new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0],
           ext.subtotal || ext.amount || 0, ext.tax_amount || 0,
           ext.amount || (ext.subtotal || 0) + (ext.tax_amount || 0)]
        );
        created.ar_invoice = invoice.rows[0];
      }

      await client.query('COMMIT');
      res.json({ success: true, created });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  // ── POST /api/email-ai/draft-reply ───────────────────────
  router.post('/draft-reply', requireAuth, async (req: Request, res: Response) => {
    try {
      const { email_text, email_subject, context, tone = 'professional' } = req.body;
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: `Draft a professional reply to this business email in Indian context.
Original email subject: ${email_subject}
Original email: ${email_text}
Context/instructions: ${context || 'Reply professionally'}
Tone: ${tone}
Write only the reply body, no subject line, no "Here is" preamble.`,
        }],
      });
      const reply = response.content[0].type === 'text' ? response.content[0].text : '';
      res.json({ reply });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/email-ai/history ─────────────────────────────
  router.get('/history', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      let history: any[] = [];
      try {
        const r = await pool.query(`SELECT * FROM email_ai_log WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 20`, [tenantId]);
        history = r.rows;
      } catch { history = []; }
      res.json({ history });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
