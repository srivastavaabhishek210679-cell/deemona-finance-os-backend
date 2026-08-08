import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createInventoryRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM inventory_items WHERE tenant_id = $1 ORDER BY category, name', [tid(req)]);
      res.json({ items: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const { sku, name, category, unit, current_stock, reorder_level, reorder_qty, unit_cost, selling_price, location, hsn_code, notes } = req.body;
      const result = await pool.query(
        'INSERT INTO inventory_items (tenant_id, sku, name, category, unit, current_stock, reorder_level, reorder_qty, unit_cost, selling_price, location, hsn_code, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
        [tid(req), sku, name, category, unit || 'pcs', current_stock || 0, reorder_level || 0, reorder_qty || 0, unit_cost || 0, selling_price || 0, location, hsn_code, notes]
      );
      res.json({ item: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/:id/movement', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { type, quantity, date, reference, notes } = req.body;
      const item = await client.query('SELECT * FROM inventory_items WHERE id = $1 AND tenant_id = $2', [req.params.id, tid(req)]);
      if (!item.rows.length) { res.status(404).json({ error: 'Item not found' }); return; }
      const current = parseFloat(item.rows[0].current_stock);
      const qty = parseFloat(quantity);
      const isInbound = ['purchase', 'return'].includes(type);
      const newStock = isInbound ? current + qty : current - qty;
      if (newStock < 0) { res.status(400).json({ error: 'Insufficient stock' }); return; }
      await client.query(
        'INSERT INTO inventory_movements (tenant_id, item_id, date, type, quantity, reference, notes, stock_after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [tid(req), req.params.id, date, type, qty, reference, notes, newStock]
      );
      await client.query('UPDATE inventory_items SET current_stock = $1, updated_at = NOW() WHERE id = $2', [newStock, req.params.id]);
      await client.query('COMMIT');
      res.json({ new_stock: newStock });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  return router;
}
