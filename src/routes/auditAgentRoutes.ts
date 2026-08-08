import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function createAuditAgentRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/audit/dashboard ──────────────────────────────
  router.get('/dashboard', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);

      const [apAnomalies, arAnomalies, expAnomalies, dupInvoices, largePayments, overdueAR] = await Promise.all([
        // AP invoices without PO reference (potential unauthorized purchases)
        pool.query(`SELECT COUNT(*) as count FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','rejected') AND total_amount > 50000`, [tenantId]),
        // AR invoices overdue > 60 days
        pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(balance_due),0) as amount FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled') AND due_date < CURRENT_DATE - INTERVAL '60 days'`, [tenantId]),
        // Expense claims without receipts (high amount)
        pool.query(`SELECT COUNT(*) as count FROM expense_claims WHERE tenant_id=$1 AND total_amount > 10000 AND status='submitted'`, [tenantId]),
        // Duplicate invoice amounts from same vendor
        pool.query(`SELECT vendor_id, total_amount, COUNT(*) as count FROM ap_invoices WHERE tenant_id=$1 AND date >= CURRENT_DATE - INTERVAL '90 days' GROUP BY vendor_id, total_amount HAVING COUNT(*) > 1`, [tenantId]),
        // Large payments (> 5L) in last 30 days
        pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(amount),0) as total FROM bank_transactions WHERE tenant_id=$1 AND type='debit' AND amount > 500000 AND date >= CURRENT_DATE - INTERVAL '30 days'`, [tenantId]),
        // Overdue AR
        pool.query(`SELECT COUNT(*) as count FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled') AND due_date < CURRENT_DATE`, [tenantId]),
      ]);

      const anomalyCount = dupInvoices.rows.length + parseInt(arAnomalies.rows[0].count);
      const riskScore = Math.min(100, anomalyCount * 10 + parseInt(overdueAR.rows[0].count) * 5);

      res.json({
        risk_score: riskScore,
        risk_level: riskScore > 70 ? 'high' : riskScore > 40 ? 'medium' : 'low',
        anomalies: {
          duplicate_invoices: dupInvoices.rows.length,
          large_payments: parseInt(largePayments.rows[0].count),
          large_payments_amount: parseFloat(largePayments.rows[0].total),
          overdue_ar: parseInt(overdueAR.rows[0].count),
          overdue_ar_amount: parseFloat(arAnomalies.rows[0].amount),
          pending_expenses: parseInt(expAnomalies.rows[0].count),
          high_value_ap: parseInt(apAnomalies.rows[0].count),
        },
        total_anomalies: dupInvoices.rows.length + parseInt(largePayments.rows[0].count) + parseInt(overdueAR.rows[0].count),
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/audit/anomalies ──────────────────────────────
  router.get('/anomalies', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);

      const [dupInvoices, largePayments, overdueAR, roundAmounts, frequentVendor] = await Promise.all([
        // Duplicate invoice amounts
        pool.query(`
          SELECT ap.invoice_number, v.name as vendor_name, ap.total_amount, ap.date, ap.status,
                 'duplicate_amount' as anomaly_type, 'medium' as severity,
                 'Same amount invoiced multiple times by this vendor' as description
          FROM ap_invoices ap
          JOIN vendors v ON v.id = ap.vendor_id
          WHERE ap.tenant_id=$1
          AND ap.date >= CURRENT_DATE - INTERVAL '90 days'
          AND (ap.vendor_id, ap.total_amount) IN (
            SELECT vendor_id, total_amount FROM ap_invoices
            WHERE tenant_id=$1 GROUP BY vendor_id, total_amount HAVING COUNT(*) > 1
          )
          ORDER BY ap.total_amount DESC LIMIT 10
        `, [tenantId]),
        // Large round-number payments
        pool.query(`
          SELECT description, amount, date, category,
                 'round_number_payment' as anomaly_type, 'low' as severity,
                 'Large round number payment - verify authorization' as description2
          FROM bank_transactions
          WHERE tenant_id=$1 AND type='debit'
          AND amount >= 100000
          AND amount::numeric % 100000 = 0
          AND date >= CURRENT_DATE - INTERVAL '60 days'
          ORDER BY amount DESC LIMIT 10
        `, [tenantId]),
        // Overdue AR > 60 days
        pool.query(`
          SELECT ar.invoice_number, c.name as customer_name, ar.total_amount, ar.balance_due,
                 ar.due_date, ar.status,
                 'overdue_receivable' as anomaly_type, 'high' as severity,
                 'Invoice overdue by more than 60 days' as description
          FROM ar_invoices ar
          JOIN customers c ON c.id = ar.customer_id
          WHERE ar.tenant_id=$1
          AND ar.status NOT IN ('paid','cancelled')
          AND ar.due_date < CURRENT_DATE - INTERVAL '60 days'
          ORDER BY ar.balance_due DESC LIMIT 10
        `, [tenantId]),
        // Weekend/holiday bank transactions
        pool.query(`
          SELECT description, amount, date, type,
                 'weekend_transaction' as anomaly_type, 'medium' as severity,
                 'Transaction processed on weekend - verify authorization' as description2
          FROM bank_transactions
          WHERE tenant_id=$1
          AND EXTRACT(DOW FROM date) IN (0,6)
          AND amount > 50000
          AND date >= CURRENT_DATE - INTERVAL '90 days'
          ORDER BY date DESC LIMIT 5
        `, [tenantId]),
        // Vendor with unusually high payment frequency
        pool.query(`
          SELECT v.name as vendor_name, COUNT(*) as payment_count,
                 COALESCE(SUM(ap.total_amount),0) as total_amount,
                 'frequent_vendor' as anomaly_type, 'low' as severity,
                 'Unusually high number of invoices from this vendor' as description
          FROM ap_invoices ap
          JOIN vendors v ON v.id = ap.vendor_id
          WHERE ap.tenant_id=$1
          AND ap.date >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY v.id, v.name
          HAVING COUNT(*) > 3
          ORDER BY COUNT(*) DESC LIMIT 5
        `, [tenantId]),
      ]);

      const allAnomalies = [
        ...dupInvoices.rows.map(r => ({ ...r, category: 'AP Invoice' })),
        ...largePayments.rows.map(r => ({ ...r, description: r.description2, category: 'Bank Transaction' })),
        ...overdueAR.rows.map(r => ({ ...r, category: 'AR Invoice' })),
        ...roundAmounts.rows.map(r => ({ ...r, description: r.description2, category: 'Bank Transaction' })),
        ...frequentVendor.rows.map(r => ({ ...r, category: 'Vendor' })),
      ];

      res.json({
        total: allAnomalies.length,
        high: allAnomalies.filter(a => a.severity === 'high').length,
        medium: allAnomalies.filter(a => a.severity === 'medium').length,
        low: allAnomalies.filter(a => a.severity === 'low').length,
        anomalies: allAnomalies,
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/audit/analyze ───────────────────────────────
  // AI deep analysis of financial data
  router.post('/analyze', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { module = 'all' } = req.body;

      const [banks, ar, ap, payroll, expenses, projects] = await Promise.all([
        pool.query(`SELECT COALESCE(SUM(current_balance),0) as total FROM bank_accounts WHERE tenant_id=$1`, [tenantId]),
        pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(balance_due),0) as outstanding, COALESCE(SUM(total_amount),0) as total FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled')`, [tenantId]),
        pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(balance_due),0) as outstanding FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','rejected')`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(total_gross),0) as gross, COALESCE(SUM(total_net),0) as net FROM payroll_runs WHERE tenant_id=$1 AND status='paid'`, [tenantId]),
        pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as amount FROM expense_claims WHERE tenant_id=$1 AND status='submitted'`, [tenantId]),
        pool.query(`SELECT COUNT(*) FILTER (WHERE spent > budget) as over_budget FROM projects WHERE tenant_id=$1`, [tenantId]),
      ]);

      const context = `
Financial data for audit analysis:
- Cash position: INR ${parseFloat(banks.rows[0].total).toLocaleString('en-IN')}
- AR outstanding: INR ${parseFloat(ar.rows[0].outstanding).toLocaleString('en-IN')} (${ar.rows[0].count} invoices)
- AP outstanding: INR ${parseFloat(ap.rows[0].outstanding).toLocaleString('en-IN')} (${ap.rows[0].count} invoices)
- Total payroll paid: INR ${parseFloat(payroll.rows[0].gross).toLocaleString('en-IN')}
- Pending expense claims: ${expenses.rows[0].count} worth INR ${parseFloat(expenses.rows[0].amount).toLocaleString('en-IN')}
- Projects over budget: ${projects.rows[0].over_budget}
      `;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: `You are an expert financial auditor specializing in Indian company audits. Analyze the financial data and provide:
1. KEY RISKS (3-5 risks with severity High/Medium/Low)
2. AUDIT OBSERVATIONS (specific findings)
3. RECOMMENDED ACTIONS (prioritized list)
4. COMPLIANCE GAPS (any regulatory concerns)

Be specific and actionable. Format with clear sections.`,
        messages: [{ role: 'user', content: `Perform a financial audit analysis for this company. ${context}` }],
      });

      const analysis = response.content[0].type === 'text' ? response.content[0].text : '';
      res.json({ analysis, data_summary: { banks: banks.rows[0], ar: ar.rows[0], ap: ap.rows[0], expenses: expenses.rows[0] } });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/audit/trail ──────────────────────────────────
  router.get('/trail', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { limit = 50 } = req.query;

      // Combine recent activities across modules
      const [apActivity, arActivity, bankActivity, expActivity] = await Promise.all([
        pool.query(`SELECT 'AP Invoice' as module, invoice_number as reference, status, total_amount as amount, date, updated_at FROM ap_invoices WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 15`, [tenantId]),
        pool.query(`SELECT 'AR Invoice' as module, invoice_number as reference, status, total_amount as amount, date, updated_at FROM ar_invoices WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 15`, [tenantId]),
        pool.query(`SELECT 'Bank Transaction' as module, description as reference, type as status, amount, date, date as updated_at FROM bank_transactions WHERE tenant_id=$1 ORDER BY date DESC LIMIT 15`, [tenantId]),
        pool.query(`SELECT 'Expense Claim' as module, claim_number as reference, status, total_amount as amount, date, updated_at FROM expense_claims WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 10`, [tenantId]),
      ]);

      const trail = [
        ...apActivity.rows,
        ...arActivity.rows,
        ...bankActivity.rows,
        ...expActivity.rows,
      ].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
       .slice(0, parseInt(limit as string));

      res.json({ trail, total: trail.length });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
