import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createProjectsRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM projects WHERE tenant_id = \ ORDER BY status, start_date DESC', [tid(req)]);
      res.json({ projects: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const { project_code, name, client_name, status, priority, start_date, end_date, budget, description } = req.body;
      const result = await pool.query(
        "INSERT INTO projects (tenant_id, project_code, name, client_name, status, priority, start_date, end_date, budget, description) VALUES (\,\,\,\,\,\,\,\,\,\) RETURNING *",
        [tid(req), project_code, name, client_name, status||'planning', priority||'normal', start_date, end_date, budget||0, description]
      );
      res.json({ project: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, spent, billed } = req.body;
      const result = await pool.query(
        'UPDATE projects SET status=COALESCE(\,status), spent=COALESCE(\,spent), billed=COALESCE(\,billed), updated_at=NOW() WHERE id=\ AND tenant_id=\ RETURNING *',
        [status, spent, billed, req.params.id, tid(req)]
      );
      res.json({ project: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
