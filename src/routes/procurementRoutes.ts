// ============================================================
// Deemona AI Finance OS — Procurement Routes
// File: src/routes/procurementRoutes.ts
// Mount: app.use('/api/procurement', procurementRouter(pool))
// ============================================================

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function createProcurementRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── Summary ───────────────────────────────────────────────
  router.get('/summary', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT
          COUNT(*) FILTER (WHERE status = 'draft') as draft,
          COUNT(*) FILTER (WHERE status = 'submitted') as pending_approval,
          COUNT(*) FILTER (WHERE status = 'approved') as approved,
          COUNT(*) FILTER (WHERE status NOT IN ('cancelled','received')) as active,
          COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('cancelled')), 0) as total_value,
          COALESCE(SUM(total_amount) FILTER (WHERE status = 'submitted'), 0) as pending_value
         FROM purchase_orders WHERE tenant_id = $1`,
        [tid(req)]
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET all POs ───────────────────────────────────────────
  router.get('/purchase-orders', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, vendor_id, priority, limit = 50 } = req.query;
      let q = `SELECT po.*, v.name as vendor_name,
               (SELECT COUNT(*) FROM po_lines WHERE po_id = po.id) as line_count
               FROM purchase_orders po
               LEFT JOIN vendors v ON v.id = po.vendor_id
               WHERE po.tenant_id = $1`;
      const params: any[] = [tid(req)];
      let pIdx = 2;
      if (status)    { q += ` AND po.status = $${pIdx++}`; params.push(status); }
      if (vendor_id) { q += ` AND po.vendor_id = $${pIdx++}`; params.push(vendor_id); }
      if (priority)  { q += ` AND po.priority = $${pIdx++}`; params.push(priority); }
      q += ` ORDER BY po.date DESC LIMIT $${pIdx}`;
      params.push(limit);
      const result = await pool.query(q, params);
      res.json({ orders: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET single PO with lines ──────────────────────────────
  router.get('/purchase-orders/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const po = await pool.query(
        `SELECT po.*, v.name as vendor_name, v.gstin as vendor_gstin,
                v.email as vendor_email, v.phone as vendor_phone
         FROM purchase_orders po
         LEFT JOIN vendors v ON v.id = po.vendor_id
         WHERE po.id = $1 AND po.tenant_id = $2`,
        [req.params.id, tid(req)]
      );
      if (!po.rows.length) { res.status(404).json({ error: 'PO not found' }); return; }

      const lines = await pool.query(
        `SELECT pl.*, a.name as account_name, a.code as account_code
         FROM po_lines pl LEFT JOIN accounts a ON a.id = pl.account_id
         WHERE pl.po_id = $1`,
        [req.params.id]
      );

      const history = await pool.query(
        `SELECT * FROM po_approvals WHERE po_id = $1 ORDER BY created_at ASC`,
        [req.params.id]
      );

      res.json({ order: po.rows[0], lines: lines.rows, history: history.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── CREATE PO ─────────────────────────────────────────────
  router.post('/purchase-orders', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { expected_date, priority, department, lines, notes } = req.body;
      // Sanitize UUID fields - convert empty string to null
      const vendor_id = req.body.vendor_id || null;

      const subtotal    = lines.reduce((s: number, l: any) => s + parseFloat(l.amount), 0);
      const tax_amount  = subtotal * 0.18; // default 18% GST
      const total_amount = subtotal + tax_amount;

      const poNum = await client.query(
        `SELECT next_accounting_number($1, 'purchase_order', 'PO') AS num`,
        [tid(req)]
      );

      const po = await client.query(
        `INSERT INTO purchase_orders
         (tenant_id, po_number, vendor_id, expected_date, priority, department,
          subtotal, tax_amount, total_amount, notes, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [tid(req), poNum.rows[0].num, vendor_id, expected_date, priority ?? 'normal',
         department, subtotal, tax_amount, total_amount, notes,
         (req as any).user.id]
      );

      for (const line of lines) {
        await client.query(
          `INSERT INTO po_lines (po_id, description, quantity, unit, unit_price, amount, account_id, hsn_sac, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [po.rows[0].id, line.description, parseFloat(line.quantity) || 1, line.unit || 'pcs',
           parseFloat(line.unit_price) || 0, parseFloat(line.amount) || 0,
           line.account_id || null, line.hsn_sac || null, line.notes || null]
        );
      }

      await client.query(
        `INSERT INTO po_approvals (po_id, action, actor_id, actor_name, comment)
         VALUES ($1, 'created', $2, $3, 'PO created')`,
        [po.rows[0].id, (req as any).user.id, (req as any).user.name]
      );

      await client.query('COMMIT');
      res.json({ order: po.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  // ── SUBMIT for approval ───────────────────────────────────
  router.patch('/purchase-orders/:id/submit', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE purchase_orders SET status = 'submitted', updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND status = 'draft' RETURNING *`,
        [req.params.id, tid(req)]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'PO not found or not in draft' }); return; }
      await client.query(
        `INSERT INTO po_approvals (po_id, action, actor_id, actor_name, comment)
         VALUES ($1, 'submitted', $2, $3, $4)`,
        [req.params.id, (req as any).user.id, (req as any).user.name, req.body.comment ?? 'Submitted for approval']
      );
      await client.query('COMMIT');
      res.json({ order: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  // ── APPROVE ───────────────────────────────────────────────
  router.patch('/purchase-orders/:id/approve', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE purchase_orders
         SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3 AND status = 'submitted' RETURNING *`,
        [(req as any).user.id, req.params.id, tid(req)]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'PO not found or not submitted' }); return; }
      await client.query(
        `INSERT INTO po_approvals (po_id, action, actor_id, actor_name, comment)
         VALUES ($1, 'approved', $2, $3, $4)`,
        [req.params.id, (req as any).user.id, (req as any).user.name, req.body.comment ?? 'Approved']
      );
      await client.query('COMMIT');
      res.json({ order: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  // ── REJECT ────────────────────────────────────────────────
  router.patch('/purchase-orders/:id/reject', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE purchase_orders
         SET status = 'draft', rejected_by = $1, rejection_reason = $2, updated_at = NOW()
         WHERE id = $3 AND tenant_id = $4 RETURNING *`,
        [(req as any).user.id, req.body.reason, req.params.id, tid(req)]
      );
      await client.query(
        `INSERT INTO po_approvals (po_id, action, actor_id, actor_name, comment)
         VALUES ($1, 'rejected', $2, $3, $4)`,
        [req.params.id, (req as any).user.id, (req as any).user.name, req.body.reason]
      );
      await client.query('COMMIT');
      res.json({ order: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  // ── AI PROCUREMENT AGENT ──────────────────────────────────
  router.post('/ai-agent', requireAuth, async (req: Request, res: Response) => {
    try {
      const { question } = req.body;
      const tenantId = tid(req);

      const [vendors, recentPOs, pendingApproval] = await Promise.all([
        pool.query(
          `SELECT v.name, v.gstin, v.payment_terms,
                  COUNT(ap.id) as invoice_count,
                  COALESCE(SUM(ap.total_amount), 0) as total_spend,
                  v.is_blocked, v.block_reason
           FROM vendors v
           LEFT JOIN ap_invoices ap ON ap.vendor_id = v.id
           WHERE v.tenant_id = $1
           GROUP BY v.id ORDER BY total_spend DESC LIMIT 10`,
          [tenantId]
        ),
        pool.query(
          `SELECT po.po_number, po.date, po.status, po.total_amount,
                  po.priority, v.name as vendor_name
           FROM purchase_orders po
           LEFT JOIN vendors v ON v.id = po.vendor_id
           WHERE po.tenant_id = $1
           ORDER BY po.date DESC LIMIT 10`,
          [tenantId]
        ),
        pool.query(
          `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as value
           FROM purchase_orders WHERE tenant_id = $1 AND status = 'submitted'`,
          [tenantId]
        ),
      ]);

      const context = [
        'TOP VENDORS BY SPEND:',
        vendors.rows.map(v =>
          v.name + ' | Spend: INR ' + parseFloat(v.total_spend).toLocaleString('en-IN') +
          ' | Invoices: ' + v.invoice_count +
          (v.is_blocked ? ' | BLOCKED: ' + v.block_reason : '')
        ).join('\n') || 'No vendors yet',
        '',
        'RECENT PURCHASE ORDERS:',
        recentPOs.rows.map(p =>
          p.po_number + ' | ' + p.vendor_name + ' | INR ' +
          parseFloat(p.total_amount).toLocaleString('en-IN') +
          ' | ' + p.status + ' | ' + p.priority
        ).join('\n') || 'No POs yet',
        '',
        'PENDING APPROVAL: ' + pendingApproval.rows[0].count +
        ' POs worth INR ' + parseFloat(pendingApproval.rows[0].value).toLocaleString('en-IN'),
      ].join('\n');

      const prompt = 'You are the Procurement Agent of Deemona AI Finance OS. '
        + 'You help procurement teams make better purchasing decisions. '
        + 'Current procurement data:\n' + context + '\n\n'
        + 'Question: ' + question + '\n\n'
        + 'Provide actionable advice. Flag vendor risks. Suggest cost optimizations. '
        + 'Use INR and Indian business context. Plain text, no markdown, under 200 words.';

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      });

      const answer = response.content[0].type === 'text' ? response.content[0].text : '';
      res.json({ answer });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}

