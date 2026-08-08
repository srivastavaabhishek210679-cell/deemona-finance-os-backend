import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createAssetsRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM fixed_assets WHERE tenant_id = \ ORDER BY category, name', [tid(req)]);
      res.json({ assets: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const { asset_code, name, category, purchase_date, purchase_price, location, useful_life_years, depreciation_method, depreciation_rate, salvage_value, notes } = req.body;
      const current_value = parseFloat(purchase_price || 0);
      const result = await pool.query(
        "INSERT INTO fixed_assets (tenant_id, asset_code, name, category, purchase_date, purchase_price, current_value, location, useful_life_years, depreciation_method, depreciation_rate, salvage_value, notes) VALUES (\,\,\,\,\,\,\,\,\,\,\,\,\) RETURNING *",
        [tid(req), asset_code, name, category, purchase_date, purchase_price || 0, current_value, location, useful_life_years || 5, depreciation_method || 'straight_line', depreciation_rate || 20, salvage_value || 0, notes]
      );
      res.json({ asset: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, current_value, disposed_date, disposed_value } = req.body;
      const result = await pool.query(
        'UPDATE fixed_assets SET status=COALESCE(\,status), current_value=COALESCE(\,current_value), disposed_date=COALESCE(\,disposed_date), disposed_value=COALESCE(\,disposed_value), updated_at=NOW() WHERE id=\ AND tenant_id=\ RETURNING *',
        [status, current_value, disposed_date, disposed_value, req.params.id, tid(req)]
      );
      res.json({ asset: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
