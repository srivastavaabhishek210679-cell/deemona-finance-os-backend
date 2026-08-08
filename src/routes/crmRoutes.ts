import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createCRMRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/leads', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM crm_leads WHERE tenant_id = \ ORDER BY created_at DESC', [tid(req)]);
      res.json({ leads: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/leads', requireAuth, async (req: Request, res: Response) => {
    try {
      const { name, company, email, phone, source, stage, value, probability, expected_close, notes } = req.body;
      const result = await pool.query(
        "INSERT INTO crm_leads (tenant_id, name, company, email, phone, source, stage, value, probability, expected_close, notes) VALUES (\,\,\,\,\,\,\,\,\,\,\) RETURNING *",
        [tid(req), name, company, email, phone, source||'other', stage||'new', value||0, probability||20, expected_close, notes]
      );
      res.json({ lead: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/leads/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { stage, probability, value, notes, lost_reason } = req.body;
      const result = await pool.query(
        'UPDATE crm_leads SET stage=COALESCE(\,stage), probability=COALESCE(\,probability), value=COALESCE(\,value), notes=COALESCE(\,notes), lost_reason=COALESCE(\,lost_reason), updated_at=NOW() WHERE id=\ AND tenant_id=\ RETURNING *',
        [stage, probability, value, notes, lost_reason, req.params.id, tid(req)]
      );
      res.json({ lead: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get('/activities', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM crm_activities WHERE tenant_id = \ ORDER BY date DESC LIMIT 50', [tid(req)]);
      res.json({ activities: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
