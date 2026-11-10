// GET /api/spend-optimization?limit=12
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { loadSpendInputs } from '../services/spendOptimizationData';
import { analyzeSpend } from '../services/spendOptimization';

export function createSpendOptimizationRouter(pool: Pool): Router {
  const router = Router();
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = (req as any).user.tenantId;
      const limit = Math.max(1, Math.min(50, parseInt(String(req.query.limit || '12'), 10) || 12));
      const { bills, budgets, today } = await loadSpendInputs(pool, t);
      res.json({ ...analyzeSpend(bills, budgets, today, limit), note: 'Review only. Nothing is paid, held or changed automatically.' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  return router;
}
