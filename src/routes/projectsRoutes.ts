import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createProjectsRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT * FROM projects WHERE tenant_id=$1 ORDER BY created_at DESC`,
        [tid(req)]
      );
      res.json({ projects: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { project_code, name, client_name, status, priority, start_date, end_date, budget, description } = req.body;
      const numResult = await pool.query(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(project_code FROM 4) AS INTEGER)), 0) + 1 as next FROM projects WHERE tenant_id=$1`,
        [tenantId]
      ).catch(() => ({ rows: [{ next: 1 }] }));
      const code = project_code || `PRJ${String(numResult.rows[0].next).padStart(3,'0')}`;
      const result = await pool.query(
        `INSERT INTO projects (tenant_id, project_code, name, client_name, status, priority, start_date, end_date, budget, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [tenantId, code, name, client_name || '', status || 'active',
         priority || 'medium',
         start_date || new Date().toISOString().split('T')[0],
         end_date || null,
         parseFloat(budget) || 0, description || '']
      );
      res.json({ project: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { status, spent, billed } = req.body;
      const result = await pool.query(
        `UPDATE projects SET
           status = COALESCE($1, status),
           spent = COALESCE($2, spent),
           billed = COALESCE($3, billed),
           updated_at = NOW()
         WHERE id=$4 AND tenant_id=$5 RETURNING *`,
        [status || null,
         spent != null ? parseFloat(spent) : null,
         billed != null ? parseFloat(billed) : null,
         req.params.id, tenantId]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'Project not found' }); return; }
      res.json({ project: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      await pool.query(`DELETE FROM projects WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
