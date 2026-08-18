import { handleNewLeadNurture } from '../services/automationEngine';
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createCRMRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/leads', requireAuth, async (req: Request, res: Response) => {
    try {
      const { stage } = req.query;
      let q = `SELECT * FROM crm_leads WHERE tenant_id=$1`;
      const params: any[] = [tid(req)];
      if (stage) { params.push(stage); q += ` AND stage=$${params.length}`; }
      q += ' ORDER BY created_at DESC';
      const result = await pool.query(q, params);
      res.json({ leads: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/leads', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { name, company, email, phone, source, stage, value, probability, expected_close, notes } = req.body;
      const result = await pool.query(
        `INSERT INTO crm_leads (tenant_id, name, company, email, phone, source, stage, value, probability, expected_close, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [tenantId, name, company || '', email || '', phone || '',
         source || 'direct', stage || 'lead',
         parseFloat(value) || 0,
         parseFloat(probability) || 20,
         expected_close || null, notes || '']
      );
      res.json({ lead: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/leads/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { stage, probability, value, notes, lost_reason } = req.body;
      const result = await pool.query(
        `UPDATE crm_leads SET
           stage = COALESCE($1, stage),
           probability = COALESCE($2, probability),
           value = COALESCE($3, value),
           notes = COALESCE($4, notes),
           lost_reason = COALESCE($5, lost_reason),
           updated_at = NOW()
         WHERE id=$6 AND tenant_id=$7 RETURNING *`,
        [stage || null,
         probability != null ? parseFloat(probability) : null,
         value != null ? parseFloat(value) : null,
         notes || null, lost_reason || null,
         req.params.id, tenantId]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'Lead not found' }); return; }
      res.json({ lead: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get('/leads/:id/activities', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT * FROM crm_activities WHERE lead_id=$1 ORDER BY date DESC`,
        [req.params.id]
      );
      res.json({ activities: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/leads/:id/activities', requireAuth, async (req: Request, res: Response) => {
    try {
      const { type, date, notes, next_action } = req.body;
      const result = await pool.query(
        `INSERT INTO crm_activities (lead_id, type, date, notes, next_action)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.params.id, type || 'call',
         date || new Date().toISOString().split('T')[0],
         notes || '', next_action || '']
      );
      res.json({ activity: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.delete('/leads/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      await pool.query(`DELETE FROM crm_leads WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
