// /api/actions: proposed actions, approval, audit. Admins and owners only.
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { runMetric } from '../services/cfoMetrics';
import { listActions, listAudit, approveAction, rejectAction, proposeCollectionActions, proposeBoardReport, proposeComplianceTasks } from '../services/controlledActions';

export function createActionsRouter(pool: Pool): Router {
  const router = Router();
  const admin = requireRole('admin', 'owner');
  const t = (req: Request): string => (req as any).user.tenantId;
  const actor = (req: Request) => { const u = (req as any).user; return { id: String(u.id), email: String(u.email || ''), name: u.name, role: String(u.role || '') }; };
  const wrap = (fn: (req: Request, res: Response) => Promise<any>) => async (req: Request, res: Response) => { try { await fn(req, res); } catch (e) { console.error('[actions]', e); res.status(500).json({ error: 'Something went wrong. Please try again.' }); } };

  router.get('/', requireAuth, admin, wrap(async (req, res) => { res.json({ actions: await listActions(pool, t(req), String(req.query.scope || 'open'), parseInt(String(req.query.limit || '50'), 10)) }); }));
  router.get('/audit', requireAuth, admin, wrap(async (req, res) => { res.json({ audit: await listAudit(pool, t(req), parseInt(String(req.query.limit || '100'), 10)) }); }));
  router.post('/propose/reminders', requireAuth, admin, wrap(async (req, res) => {
    const b = req.body || {};
    res.json(await proposeCollectionActions(pool, t(req), { channels: Array.isArray(b.channels) ? b.channels : undefined, min_days_overdue: b.min_days_overdue, limit: b.limit }, actor(req).email));
  }));
  router.post('/propose/board-report', requireAuth, admin, wrap(async (req, res) => { res.json(await proposeBoardReport(pool, t(req), actor(req).email || null, actor(req).email)); }));
  router.post('/propose/compliance', requireAuth, admin, wrap(async (req, res) => { res.json(await proposeComplianceTasks(pool, t(req), actor(req).email)); }));
  router.post('/:id/approve', requireAuth, admin, wrap(async (req, res) => {
    const r = await approveAction(pool, t(req), String(req.params.id), actor(req), { runMetric }, { message: typeof req.body?.message === 'string' ? req.body.message : undefined });
    res.status(r.status).json(r.ok ? { action: r.action } : { error: r.error, action: r.action });
  }));
  router.post('/:id/reject', requireAuth, admin, wrap(async (req, res) => {
    const r = await rejectAction(pool, t(req), String(req.params.id), actor(req), typeof req.body?.reason === 'string' ? req.body.reason : undefined);
    res.status(r.status).json(r.ok ? { action: r.action } : { error: r.error });
  }));
  return router;
}
