import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function createTaxAgentRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/tax-agent/dashboard ─────────────────────────
  router.get('/dashboard', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);

      const [filings, arInvoices, apInvoices, txns] = await Promise.all([
        pool.query(`SELECT * FROM tax_filings WHERE tenant_id=$1 ORDER BY due_date ASC`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(tax_amount),0) as gst_collected, COALESCE(SUM(subtotal),0) as turnover FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled') AND date >= date_trunc('month', CURRENT_DATE)`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(tax_amount),0) as itc_available FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','rejected') AND date >= date_trunc('month', CURRENT_DATE)`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(amount),0) as tds_paid FROM bank_transactions WHERE tenant_id=$1 AND category='tax_payment' AND date >= date_trunc('year', CURRENT_DATE)`, [tenantId]),
      ]);

      const gstCollected = parseFloat(arInvoices.rows[0].gst_collected);
      const itcAvailable = parseFloat(apInvoices.rows[0].itc_available);
      const netGstPayable = Math.max(0, gstCollected - itcAvailable);
      const turnover = parseFloat(arInvoices.rows[0].turnover);

      const pending = filings.rows.filter(f => f.status === 'pending');
      const overdue = pending.filter(f => new Date(f.due_date) < new Date());

      res.json({
        current_month: {
          gst_collected: gstCollected,
          itc_available: itcAvailable,
          net_gst_payable: netGstPayable,
          turnover: turnover,
        },
        tds_paid_ytd: parseFloat(txns.rows[0].tds_paid),
        pending_filings: pending.length,
        overdue_filings: overdue.length,
        filings: filings.rows,
        next_due: pending.length > 0 ? pending[0] : null,
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/tax-agent/gst-computation ───────────────────
  router.get('/gst-computation', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;
      const year  = parseInt(req.query.year  as string) || new Date().getFullYear();

      const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
      const endDate   = new Date(year, month, 0).toISOString().split('T')[0];

      const [sales, purchases, customers, vendors] = await Promise.all([
        pool.query(`SELECT ai.*, c.name as customer_name, c.gstin as customer_gstin FROM ar_invoices ai LEFT JOIN customers c ON c.id=ai.customer_id WHERE ai.tenant_id=$1 AND ai.date BETWEEN $2 AND $3 AND ai.status NOT IN ('draft','cancelled')`, [tenantId, startDate, endDate]),
        pool.query(`SELECT ap.*, v.name as vendor_name, v.gstin as vendor_gstin FROM ap_invoices ap LEFT JOIN vendors v ON v.id=ap.vendor_id WHERE ap.tenant_id=$1 AND ap.date BETWEEN $2 AND $3 AND ap.status NOT IN ('draft','rejected')`, [tenantId, startDate, endDate]),
        pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as total, COALESCE(SUM(tax_amount),0) as gst FROM ar_invoices WHERE tenant_id=$1 AND date BETWEEN $2 AND $3 AND status NOT IN ('draft','cancelled')`, [tenantId, startDate, endDate]),
        pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as total, COALESCE(SUM(tax_amount),0) as itc FROM ap_invoices WHERE tenant_id=$1 AND date BETWEEN $2 AND $3 AND status NOT IN ('draft','rejected')`, [tenantId, startDate, endDate]),
      ]);

      const gstCollected  = parseFloat(customers.rows[0].gst);
      const itcAvailable  = parseFloat(vendors.rows[0].itc);
      const netPayable    = Math.max(0, gstCollected - itcAvailable);
      const cgst          = netPayable / 2;
      const sgst          = netPayable / 2;

      res.json({
        period: { month, year, from: startDate, to: endDate },
        outward_supplies: {
          count: parseInt(customers.rows[0].count),
          taxable_value: parseFloat(customers.rows[0].total) - gstCollected,
          gst_collected: gstCollected,
          cgst: gstCollected / 2,
          sgst: gstCollected / 2,
          invoices: sales.rows,
        },
        inward_supplies: {
          count: parseInt(vendors.rows[0].count),
          taxable_value: parseFloat(vendors.rows[0].total) - itcAvailable,
          itc_available: itcAvailable,
          invoices: purchases.rows,
        },
        net_liability: {
          gross_gst: gstCollected,
          less_itc: itcAvailable,
          net_payable: netPayable,
          cgst_payable: cgst,
          sgst_payable: sgst,
          igst_payable: 0,
        },
        gstr3b_summary: {
          table_3_1: { taxable_value: parseFloat(customers.rows[0].total) - gstCollected, igst: 0, cgst: gstCollected/2, sgst: gstCollected/2 },
          table_4: { itc_available: itcAvailable, itc_reversed: 0, net_itc: itcAvailable },
          net_payable: { igst: 0, cgst: cgst, sgst: sgst },
        },
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/tax-agent/tds-computation ───────────────────
  router.get('/tds-computation', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const year = parseInt(req.query.year as string) || new Date().getFullYear();

      const [employees, payrolls, vendors] = await Promise.all([
        pool.query(`SELECT e.*, COALESCE(SUM(p.tds),0) as tds_deducted FROM employees e LEFT JOIN payslips p ON p.employee_id=e.id AND p.year=$2 WHERE e.tenant_id=$1 AND e.status='active' GROUP BY e.id`, [tenantId, year]),
        pool.query(`SELECT COALESCE(SUM(tds),0) as total_tds, COALESCE(SUM(gross_salary),0) as gross FROM payslips WHERE tenant_id=$1 AND year=$2`, [tenantId, year]),
        pool.query(`SELECT v.name, v.gstin, COALESCE(SUM(ap.total_amount),0) as paid, COALESCE(SUM(ap.total_amount)*0.1,0) as tds_applicable FROM vendors v LEFT JOIN ap_invoices ap ON ap.vendor_id=v.id AND EXTRACT(YEAR FROM ap.date)=$2 AND ap.status='paid' WHERE v.tenant_id=$1 GROUP BY v.id, v.name, v.gstin HAVING SUM(ap.total_amount) > 30000`, [tenantId, year]),
      ]);

      const totalSalaryTDS = parseFloat(payrolls.rows[0].total_tds);
      const totalVendorTDS = vendors.rows.reduce((s: number, v: any) => s + parseFloat(v.tds_applicable), 0);

      res.json({
        year,
        salary_tds: {
          total_gross: parseFloat(payrolls.rows[0].gross),
          total_tds_deducted: totalSalaryTDS,
          employees: employees.rows.map((e: any) => ({
            name: `${e.first_name} ${e.last_name}`,
            pan: e.pan || 'Not provided',
            gross_salary: parseFloat(e.basic_salary + e.hra + e.special_allowance + e.other_allowances) * 12,
            tds_deducted: parseFloat(e.tds_deducted),
            section: '192',
          })),
        },
        vendor_tds: {
          total_applicable: totalVendorTDS,
          vendors: vendors.rows.map((v: any) => ({
            name: v.name,
            gstin: v.gstin,
            amount_paid: parseFloat(v.paid),
            tds_applicable: parseFloat(v.tds_applicable),
            section: '194C',
            rate: '10%',
          })),
        },
        challan_summary: {
          section_192: totalSalaryTDS,
          section_194c: totalVendorTDS,
          total: totalSalaryTDS + totalVendorTDS,
          due_date: `15th of each month`,
        },
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/tax-agent/ask ───────────────────────────────
  router.post('/ask', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { question } = req.body;
      if (!question) { res.status(400).json({ error: 'question required' }); return; }

      const [filings, gst, tds] = await Promise.all([
        pool.query(`SELECT filing_type, period_month, period_year, due_date, status, tax_liability, tax_paid FROM tax_filings WHERE tenant_id=$1 ORDER BY due_date DESC LIMIT 10`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(tax_amount),0) as collected FROM ar_invoices WHERE tenant_id=$1 AND date >= date_trunc('month', CURRENT_DATE) AND status NOT IN ('draft','cancelled')`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(tds),0) as total FROM payslips WHERE tenant_id=$1 AND year=EXTRACT(YEAR FROM CURRENT_DATE)`, [tenantId]),
      ]);

      const context = `
TAX DATA SNAPSHOT:
- GST collected this month: INR ${parseFloat(gst.rows[0].collected).toLocaleString('en-IN')}
- TDS deducted this FY: INR ${parseFloat(tds.rows[0].total).toLocaleString('en-IN')}
- Recent filings: ${filings.rows.map((f: any) => `${f.filing_type} ${f.period_month}/${f.period_year}: ${f.status}, Liability INR ${parseFloat(f.tax_liability).toLocaleString('en-IN')}`).join(' | ')}
`;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: `You are an Indian tax expert specializing in GST, TDS, Income Tax, and corporate compliance. Answer questions about Indian tax law with specific sections, rates, and deadlines. Be concise and practical. Context: ${context}`,
        messages: [{ role: 'user', content: question }],
      });

      const answer = response.content[0].type === 'text' ? response.content[0].text : '';
      res.json({ answer });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/tax-agent/calendar ──────────────────────────
  router.get('/calendar', requireAuth, async (req: Request, res: Response) => {
    const calendar = [
      { date: '7th of month',  filing: 'TDS Payment',        section: '194C/194J/192', penalty: 'INR 200/day' },
      { date: '11th of month', filing: 'GSTR-1',             section: 'GST Act',       penalty: 'INR 50/day' },
      { date: '20th of month', filing: 'GSTR-3B',            section: 'GST Act',       penalty: 'INR 50/day + interest 18%' },
      { date: '15th of month', filing: 'PF Payment',         section: 'EPF Act',       penalty: '12% p.a.' },
      { date: '15 Jun',        filing: 'Advance Tax Q1',     section: '211',           penalty: 'Interest u/s 234B/C' },
      { date: '15 Sep',        filing: 'Advance Tax Q2',     section: '211',           penalty: 'Interest u/s 234B/C' },
      { date: '15 Dec',        filing: 'Advance Tax Q3',     section: '211',           penalty: 'Interest u/s 234B/C' },
      { date: '15 Mar',        filing: 'Advance Tax Q4',     section: '211',           penalty: 'Interest u/s 234B/C' },
      { date: '31 Jul',        filing: 'ITR Filing',         section: '139(1)',        penalty: 'INR 5000 u/s 234F' },
      { date: '31 Oct',        filing: 'TDS Annual Return',  section: '206',           penalty: 'INR 200/day' },
      { date: '31 Oct',        filing: 'Audit Report',       section: '44AB',          penalty: '0.5% of turnover' },
      { date: '30 Nov',        filing: 'Transfer Pricing',   section: '92E',           penalty: 'INR 1 lakh' },
    ];
    res.json({ calendar });
  });

  return router;
}
