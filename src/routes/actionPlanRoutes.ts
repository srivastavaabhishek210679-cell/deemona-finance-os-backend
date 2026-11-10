// GET /api/action-plan?days=90&min_cash=0&collection=70&defer_days=14
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { loadForecastInputs } from '../services/cashForecast';
import { buildActionPlan } from '../services/actionPlan';

export function createActionPlanRouter(pool: Pool): Router {
  const router = Router();
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = (req as any).user.tenantId;
      const q = req.query;
      const { opening, items, today } = await loadForecastInputs(pool, t);
      const plan = buildActionPlan(opening, items, today, {
        days: parseInt(String(q.days || '90'), 10) || 90,
        minCash: Math.max(0, Number(q.min_cash) || 0),
        collectionRate: Math.min(100, Math.max(0, q.collection !== undefined ? Number(q.collection) : 70)) / 100,
        deferDays: Math.max(1, Math.min(60, parseInt(String(q.defer_days || '14'), 10) || 14)),
      });
      res.json({ ...plan, note: 'Suggestions only. Nothing is sent, paid or changed automatically.' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  return router;
}
