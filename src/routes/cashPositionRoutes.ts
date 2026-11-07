// ============================================================
// GET    /api/cash-position        current cash + entry history
// POST   /api/cash-position        { as_of, amount, note }  set the balance as of a date
// DELETE /api/cash-position/:id    remove a mistaken entry
// ============================================================
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { cashAsOf, ensureCashTable } from '../services/cashPosition';

export function createCashPositionRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensureCashTable(pool);
      const current = await cashAsOf(pool, tid(req));
      const entries = await pool.query(
        `SELECT id, as_of::text AS as_of, amount, note, created_by, created_at FROM cash_balance_entries
         WHERE tenant_id = $1 ORDER BY as_of DESC, created_at DESC LIMIT 50`, [tid(req)]);
      res.json({ current, entries: entries.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensureCashTable(pool);
      const { as_of, amount, note } = req.body || {};
      const amt = Number(amount);
      if (!Number.isFinite(amt) || Math.abs(amt) > 1e13) { res.status(400).json({ error: 'Enter a valid amount' }); return; }
      const d = String(as_of || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d))) { res.status(400).json({ error: 'Enter a valid date' }); return; }
      if (d > new Date().toISOString().split('T')[0]) { res.status(400).json({ error: 'Date cannot be in the future' }); return; }
      const r = await pool.query(
        `INSERT INTO cash_balance_entries (tenant_id, as_of, amount, note, created_by) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, as_of::text AS as_of, amount, note`,
        [tid(req), d, amt, note ? String(note).slice(0, 200) : null, (req as any).user.email || (req as any).user.id || null]);
      res.json({ entry: r.rows[0], current: await cashAsOf(pool, tid(req)) });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensureCashTable(pool);
      const r = await pool.query(`DELETE FROM cash_balance_entries WHERE id = $1 AND tenant_id = $2`, [req.params.id, tid(req)]);
      res.json({ deleted: r.rowCount });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
