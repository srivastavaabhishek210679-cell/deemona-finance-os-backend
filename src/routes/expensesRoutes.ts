import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createExpensesRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/claims', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM expense_claims WHERE tenant_id = \ ORDER BY date DESC', [tid(req)]);
      res.json({ claims: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/claims', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { employee_name, department, date, title, total_amount, notes, items } = req.body;
      const num = await client.query("SELECT next_accounting_number(\, 'expense_claim', 'EXP') AS num", [tid(req)]);
      const claim = await client.query(
        "INSERT INTO expense_claims (tenant_id, claim_number, employee_name, department, date, title, total_amount, notes) VALUES (\,\,\,\,\,\,\,\) RETURNING *",
        [tid(req), num.rows[0].num, employee_name, department, date, title, total_amount || 0, notes]
      );
      if (items?.length) {
        for (const item of items) {
          await client.query('INSERT INTO expense_items (claim_id, date, category, description, amount) VALUES (\,\,\,\,\)',
            [claim.rows[0].id, item.date, item.category, item.description, item.amount]);
        }
      }
      await client.query('COMMIT');
      res.json({ claim: claim.rows[0] });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: String(err) }); }
    finally { client.release(); }
  });

  router.patch('/claims/:id/submit', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query("UPDATE expense_claims SET status='submitted', submitted_at=NOW(), updated_at=NOW() WHERE id=\ AND tenant_id=\ RETURNING *", [req.params.id, tid(req)]);
      res.json({ claim: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/claims/:id/approve', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query("UPDATE expense_claims SET status='approved', approved_by=\, approved_at=NOW(), approved_amount=total_amount, updated_at=NOW() WHERE id=\ AND tenant_id=\ RETURNING *",
        [(req as any).user.id, req.params.id, tid(req)]);
      res.json({ claim: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
