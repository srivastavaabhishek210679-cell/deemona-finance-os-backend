import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createTaxRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/filings', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM tax_filings WHERE tenant_id = \ ORDER BY due_date ASC', [tid(req)]);
      res.json({ filings: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/filings', requireAuth, async (req: Request, res: Response) => {
    try {
      const { filing_type, period_month, period_quarter, period_year, due_date, tax_liability, notes } = req.body;
      const result = await pool.query(
        'INSERT INTO tax_filings (tenant_id, filing_type, period_month, period_quarter, period_year, due_date, tax_liability, notes) VALUES (\,\,\,\,\,\,\,\) RETURNING *',
        [tid(req), filing_type, period_month, period_quarter, period_year, due_date, tax_liability || 0, notes]
      );
      res.json({ filing: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/filings/:id/file', requireAuth, async (req: Request, res: Response) => {
    try {
      const { reference_number, tax_paid } = req.body;
      const result = await pool.query(
        "UPDATE tax_filings SET status='filed', filed_date=CURRENT_DATE, reference_number=\, tax_paid=COALESCE(\,tax_liability), updated_at=NOW() WHERE id=\ AND tenant_id=\ RETURNING *",
        [reference_number, tax_paid, req.params.id, tid(req)]
      );
      res.json({ filing: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
