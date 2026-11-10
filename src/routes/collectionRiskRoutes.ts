// GET /api/collection-risk?limit=10
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { loadRiskInputs } from '../services/collectionRiskData';
import { scoreCollectionRisk } from '../services/collectionRisk';

export function createCollectionRiskRouter(pool: Pool): Router {
  const router = Router();
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = (req as any).user.tenantId;
      const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || '10'), 10) || 10));
      const { events, open, today } = await loadRiskInputs(pool, t);
      res.json({ ...scoreCollectionRisk(events, open, today, limit), note: 'Estimates only. Nothing is sent or changed automatically.' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  return router;
}
