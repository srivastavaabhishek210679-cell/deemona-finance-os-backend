import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createComplianceRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM compliance_items WHERE tenant_id = \ ORDER BY due_date ASC', [tid(req)]);
      res.json({ items: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const { category, title, description, frequency, due_date, penalty_if_missed, notes } = req.body;
      const result = await pool.query(
        'INSERT INTO compliance_items (tenant_id, category, title, description, frequency, due_date, penalty_if_missed, notes) VALUES (\,\,\,\,\,\,\,\) RETURNING *',
        [tid(req), category, title, description, frequency||'annual', due_date, penalty_if_missed||0, notes]
      );
      res.json({ item: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/:id/complete', requireAuth, async (req: Request, res: Response) => {
    try {
      const { completed_date, reference_number } = req.body;
      const result = await pool.query(
        "UPDATE compliance_items SET status='completed', completed_date=\, reference_number=COALESCE(\,reference_number), updated_at=NOW() WHERE id=\ AND tenant_id=\ RETURNING *",
        [completed_date, reference_number, req.params.id, tid(req)]
      );
      res.json({ item: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
