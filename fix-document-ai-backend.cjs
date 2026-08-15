const fs = require('fs');
const path = require('path');

const BACKEND = 'C:/deemona-finance-os/backend/src';
const routeFile = path.join(BACKEND.replace(/\//g,'\\'), 'routes', 'documentAIRoutes.ts');

const newContent = `import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function createDocumentAIRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── POST /api/document-ai/extract — Claude Vision OCR ─────
  router.post('/extract', requireAuth, async (req: Request, res: Response) => {
    try {
      const { image_base64, mime_type, filename, prompt } = req.body;

      if (!image_base64) {
        return res.status(400).json({ error: 'image_base64 is required' }) as any;
      }

      const extractPrompt = prompt || \`Extract all financial information from this Indian invoice/bill image. Return ONLY valid JSON:
{
  "document_type": "invoice|bill|receipt|purchase_order",
  "invoice_number": "string or null",
  "invoice_date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD or null",
  "vendor_name": "string or null",
  "vendor_gstin": "string or null",
  "vendor_address": "string or null",
  "customer_name": "string or null",
  "customer_gstin": "string or null",
  "line_items": [{"description": "string", "quantity": 1, "unit_price": 0, "amount": 0}],
  "subtotal": 0,
  "cgst_amount": 0,
  "sgst_amount": 0,
  "igst_amount": 0,
  "total_tax": 0,
  "total_amount": 0,
  "currency": "INR",
  "notes": null,
  "payment_terms": null
}
All amounts as numbers without currency symbols. Use null for missing fields.\`;

      // Determine media type
      const mediaType = (mime_type || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

      // Call Claude Vision
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: image_base64,
              },
            },
            {
              type: 'text',
              text: extractPrompt,
            },
          ],
        }],
      });

      const rawText = (response.content[0] as any).text || '';

      // Parse JSON from response
      let extracted: any = {};
      try {
        const jsonMatch = rawText.match(/\\{[\\s\\S]*\\}/);
        if (jsonMatch) {
          extracted = JSON.parse(jsonMatch[0]);
        } else {
          extracted = { raw_text: rawText, error: 'Could not parse JSON from response' };
        }
      } catch (parseErr) {
        extracted = { raw_text: rawText, parse_error: String(parseErr) };
      }

      // Log extraction to DB
      await pool.query(
        \`INSERT INTO document_ai_logs (tenant_id, filename, document_type, vendor_name, total_amount, extracted_data, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT DO NOTHING\`,
        [tid(req), filename || 'unknown', extracted.document_type || 'invoice',
         extracted.vendor_name || null, extracted.total_amount || 0, JSON.stringify(extracted)]
      ).catch(() => {}); // Non-blocking

      res.json({
        success: true,
        extracted,
        raw_text: rawText,
        model: 'claude-sonnet-4-6',
        filename,
      });

    } catch (err: any) {
      console.error('[DocumentAI] Extract error:', err);
      res.status(500).json({ error: String(err), message: 'Failed to extract data from document' });
    }
  });

  // ── POST /api/document-ai/extract-url — Extract from URL ──
  router.post('/extract-url', requireAuth, async (req: Request, res: Response) => {
    try {
      const { url, prompt } = req.body;
      if (!url) return res.status(400).json({ error: 'url is required' }) as any;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url } },
            { type: 'text', text: prompt || 'Extract all financial data from this invoice. Return JSON.' },
          ],
        }],
      });

      const rawText = (response.content[0] as any).text || '';
      let extracted = {};
      try {
        const m = rawText.match(/\\{[\\s\\S]*\\}/);
        if (m) extracted = JSON.parse(m[0]);
      } catch {}

      res.json({ success: true, extracted, raw_text: rawText });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/document-ai/history — Extraction history ─────
  router.get('/history', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        \`SELECT id, filename, document_type, vendor_name, total_amount, created_at
         FROM document_ai_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 20\`,
        [tid(req)]
      );
      res.json({ logs: result.rows });
    } catch (err) {
      res.json({ logs: [] });
    }
  });

  return router;
}
`;

fs.writeFileSync(routeFile, newContent, 'utf8');
console.log('✓ documentAIRoutes.ts rewritten with real Claude Vision');

// Check if router is wired in index.ts
const indexFile = path.join(BACKEND.replace(/\//g,'\\'), 'index.ts');
let idx = fs.readFileSync(indexFile, 'utf8');
if (!idx.includes('createDocumentAIRouter')) {
  idx = idx.replace(
    "app.use('/api/automation',",
    "app.use('/api/document-ai', createDocumentAIRouter(pool));\napp.use('/api/automation',"
  );
  // Add import
  idx = idx.replace(
    "import { createAutomationRouter }",
    "import { createDocumentAIRouter } from './routes/documentAIRoutes';\nimport { createAutomationRouter }"
  );
  fs.writeFileSync(indexFile, idx, 'utf8');
  console.log('✓ documentAIRouter wired in index.ts');
} else {
  console.log('- documentAIRouter already wired');
}

console.log('\n✅ Document AI backend ready!');
