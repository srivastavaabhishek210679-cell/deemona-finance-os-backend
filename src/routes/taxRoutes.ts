import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createTaxRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/tax/filings ──────────────────────────────────
  router.get('/filings', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT * FROM tax_filings WHERE tenant_id=$1 ORDER BY due_date DESC`,
        [tid(req)]
      );
      res.json({ filings: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/tax/filings ─────────────────────────────────
  router.post('/filings', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { filing_type, period_month, period_year, due_date, tax_liability, tax_paid, notes } = req.body;
      const result = await pool.query(
        `INSERT INTO tax_filings (tenant_id, filing_type, period_month, period_year, due_date, tax_liability, tax_paid, notes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
        [tenantId, filing_type || 'GSTR-3B',
         parseInt(period_month) || new Date().getMonth() + 1,
         parseInt(period_year) || new Date().getFullYear(),
         due_date || new Date().toISOString().split('T')[0],
         parseFloat(tax_liability) || 0,
         parseFloat(tax_paid) || 0,
         notes || '']
      );
      res.json({ filing: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── PATCH /api/tax/filings/:id/file ──────────────────────
  router.patch('/filings/:id/file', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { arn_number, filed_date, tax_paid } = req.body;
      const result = await pool.query(
        `UPDATE tax_filings SET
           status = 'filed',
           arn_number = COALESCE($1, arn_number),
           filed_date = COALESCE($2, filed_date),
           tax_paid = COALESCE($3, tax_paid),
           updated_at = NOW()
         WHERE id=$4 AND tenant_id=$5 RETURNING *`,
        [arn_number || null,
         filed_date || new Date().toISOString().split('T')[0],
         tax_paid ? parseFloat(tax_paid) : null,
         req.params.id, tenantId]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'Filing not found' }); return; }
      res.json({ filing: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/tax/summary ──────────────────────────────────
  router.get('/summary', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const [filings, gst, tds] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) as total,
            COUNT(*) FILTER (WHERE status='pending') as pending,
            COUNT(*) FILTER (WHERE status='filed') as filed,
            COALESCE(SUM(tax_liability),0) as total_liability,
            COALESCE(SUM(tax_paid),0) as total_paid
           FROM tax_filings WHERE tenant_id=$1`,
          [tenantId]
        ),
        pool.query(
          `SELECT COALESCE(SUM(tax_amount),0) as collected
           FROM ar_invoices
           WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled')
           AND date >= date_trunc('month', CURRENT_DATE)`,
          [tenantId]
        ),
        pool.query(
          `SELECT COALESCE(SUM(tds),0) as total
           FROM payslips
           WHERE tenant_id=$1 AND year=EXTRACT(YEAR FROM CURRENT_DATE)`,
          [tenantId]
        ),
      ]);

      res.json({
        filings: filings.rows[0],
        gst_collected_this_month: parseFloat(gst.rows[0].collected),
        tds_paid_ytd: parseFloat(tds.rows[0].total),
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/tax/gst-transactions ────────────────────────
  router.get('/gst-transactions', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { month, year } = req.query;
      const m = parseInt(month as string) || new Date().getMonth() + 1;
      const y = parseInt(year as string) || new Date().getFullYear();
      const from = `${y}-${String(m).padStart(2,'0')}-01`;
      const to = new Date(y, m, 0).toISOString().split('T')[0];

      const [sales, purchases] = await Promise.all([
        pool.query(
          `SELECT ar.*, c.name as party_name, c.gstin
           FROM ar_invoices ar LEFT JOIN customers c ON c.id=ar.customer_id
           WHERE ar.tenant_id=$1 AND ar.date BETWEEN $2 AND $3
           AND ar.status NOT IN ('draft','cancelled') ORDER BY ar.date`,
          [tenantId, from, to]
        ),
        pool.query(
          `SELECT ap.*, v.name as party_name, v.gstin
           FROM ap_invoices ap LEFT JOIN vendors v ON v.id=ap.vendor_id
           WHERE ap.tenant_id=$1 AND ap.date BETWEEN $2 AND $3
           AND ap.status NOT IN ('draft','rejected') ORDER BY ap.date`,
          [tenantId, from, to]
        ),
      ]);

      const gstCollected = sales.rows.reduce((s: number, r: any) => s + parseFloat(r.tax_amount || 0), 0);
      const itcAvailable = purchases.rows.reduce((s: number, r: any) => s + parseFloat(r.tax_amount || 0), 0);

      res.json({
        period: { month: m, year: y, from, to },
        sales: sales.rows,
        purchases: purchases.rows,
        summary: {
          gst_collected: gstCollected,
          itc_available: itcAvailable,
          net_payable: Math.max(0, gstCollected - itcAvailable),
        },
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
