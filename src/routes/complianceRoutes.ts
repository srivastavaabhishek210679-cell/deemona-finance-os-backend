import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createComplianceRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT * FROM compliance_items WHERE tenant_id=$1 ORDER BY due_date ASC`,
        [tid(req)]
      );
      res.json({ items: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { category, title, description, frequency, due_date, penalty_if_missed, notes } = req.body;
      const result = await pool.query(
        `INSERT INTO compliance_items (tenant_id, category, title, description, frequency, due_date, penalty_if_missed, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [tenantId, category || 'other', title, description || '',
         frequency || 'monthly',
         due_date || new Date().toISOString().split('T')[0],
         penalty_if_missed || '', notes || '']
      );
      res.json({ item: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/:id/complete', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { completed_date, reference_number } = req.body;
      const result = await pool.query(
        `UPDATE compliance_items SET
           status = 'completed',
           completed_date = $1,
           reference_number = COALESCE($2, reference_number),
           updated_at = NOW()
         WHERE id=$3 AND tenant_id=$4 RETURNING *`,
        [completed_date || new Date().toISOString().split('T')[0],
         reference_number || null, req.params.id, tenantId]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'Item not found' }); return; }
      res.json({ item: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      await pool.query(`DELETE FROM compliance_items WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
