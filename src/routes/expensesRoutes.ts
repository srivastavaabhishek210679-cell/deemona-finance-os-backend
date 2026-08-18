import { handleExpenseAutoApproval } from '../services/automationEngine';
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createExpensesRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/expenses/claims ──────────────────────────────
  router.get('/claims', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const result = await pool.query(
        `SELECT ec.*, 
          (SELECT json_agg(ei.*) FROM expense_items ei WHERE ei.claim_id = ec.id) as items
         FROM expense_claims ec
         WHERE ec.tenant_id = $1
         ORDER BY ec.created_at DESC`,
        [tenantId]
      );
      res.json({ claims: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/expenses/claims ─────────────────────────────
  router.post('/claims', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tenantId = tid(req);
      const { employee_name, department, date, title, notes, items = [], total_amount } = req.body;

      // Generate claim number
      const numResult = await client.query(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(claim_number FROM 5) AS INTEGER)), 0) + 1 as next
         FROM expense_claims WHERE tenant_id = $1`,
        [tenantId]
      );
      const claimNum = `EXP-${String(numResult.rows[0].next).padStart(4, '0')}`;
      const total = total_amount || items.reduce((s: number, i: any) => s + parseFloat(i.amount || 0), 0);

      const claim = await client.query(
        `INSERT INTO expense_claims (tenant_id, claim_number, employee_name, department, date, title, total_amount, notes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
         RETURNING *`,
        [tenantId, claimNum, employee_name || 'Employee', department || '', date || new Date().toISOString().split('T')[0], title || 'Expense Claim', total, notes || '']
      );

      const claimId = claim.rows[0].id;

      for (const item of items) {
        await client.query(
          `INSERT INTO expense_items (claim_id, date, category, description, amount)
           VALUES ($1, $2, $3, $4, $5)`,
          [claimId, item.date || date || new Date().toISOString().split('T')[0], item.category || 'other', item.description || '', parseFloat(item.amount || 0)]
        );
      }

      await client.query('COMMIT');
      res.json({ claim: claim.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  // ── PATCH /api/expenses/claims/:id/submit ─────────────────
  router.patch('/claims/:id/submit', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const result = await pool.query(
        `UPDATE expense_claims SET status = 'submitted', updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'Claim not found' }); return; }
      res.json({ claim: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── PATCH /api/expenses/claims/:id/approve ────────────────
  router.patch('/claims/:id/approve', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const result = await pool.query(
        `UPDATE expense_claims SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3 RETURNING *`,
        [(req as any).user.id, req.params.id, tenantId]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'Claim not found' }); return; }
      res.json({ claim: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── PATCH /api/expenses/claims/:id/reject ─────────────────
  router.patch('/claims/:id/reject', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { reason } = req.body;
      const result = await pool.query(
        `UPDATE expense_claims SET status = 'rejected', rejection_reason = $1, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3 RETURNING *`,
        [reason || '', req.params.id, tenantId]
      );
      res.json({ claim: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/expenses/summary ─────────────────────────────
  router.get('/summary', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const result = await pool.query(
        `SELECT 
          COUNT(*) as total_claims,
          COALESCE(SUM(total_amount), 0) as total_amount,
          COUNT(*) FILTER (WHERE status = 'draft') as draft,
          COUNT(*) FILTER (WHERE status = 'submitted') as pending_approval,
          COUNT(*) FILTER (WHERE status = 'approved') as approved,
          COALESCE(SUM(total_amount) FILTER (WHERE status = 'approved'), 0) as approved_amount
         FROM expense_claims WHERE tenant_id = $1`,
        [tenantId]
      );
      res.json({ summary: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
