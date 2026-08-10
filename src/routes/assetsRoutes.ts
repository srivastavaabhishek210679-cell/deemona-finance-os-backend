import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createAssetsRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT * FROM fixed_assets WHERE tenant_id=$1 ORDER BY created_at DESC`,
        [tid(req)]
      );
      res.json({ assets: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { asset_code, name, category, purchase_date, purchase_price, current_value, location, useful_life_years, depreciation_method, depreciation_rate, salvage_value, notes } = req.body;
      const result = await pool.query(
        `INSERT INTO fixed_assets (tenant_id, asset_code, name, category, purchase_date, purchase_price, current_value, location, useful_life_years, depreciation_method, depreciation_rate, salvage_value, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [tenantId, asset_code, name, category || 'other',
         purchase_date || new Date().toISOString().split('T')[0],
         parseFloat(purchase_price) || 0,
         parseFloat(current_value || purchase_price) || 0,
         location || '', parseInt(useful_life_years) || 5,
         depreciation_method || 'straight_line',
         parseFloat(depreciation_rate) || 20,
         parseFloat(salvage_value) || 0, notes || '']
      );
      res.json({ asset: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { status, current_value, disposed_date, disposed_value } = req.body;
      const result = await pool.query(
        `UPDATE fixed_assets SET
           status = COALESCE($1, status),
           current_value = COALESCE($2, current_value),
           disposed_date = COALESCE($3, disposed_date),
           disposed_value = COALESCE($4, disposed_value),
           updated_at = NOW()
         WHERE id=$5 AND tenant_id=$6 RETURNING *`,
        [status || null, current_value ? parseFloat(current_value) : null,
         disposed_date || null, disposed_value ? parseFloat(disposed_value) : null,
         req.params.id, tenantId]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'Asset not found' }); return; }
      res.json({ asset: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      await pool.query(`DELETE FROM fixed_assets WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
