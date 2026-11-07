import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { cashAsOf } from '../services/cashPosition';
import { ensurePaymentEventsTable } from './paymentEventsRoutes';

export function createStatementsRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── P&L Statement ─────────────────────────────────────────
  router.get('/pnl', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { from, to, compare } = req.query;

      const fromDate = from || new Date(new Date().getFullYear(), 3, 1).toISOString().split('T')[0]; // Apr 1
      const toDate   = to   || new Date().toISOString().split('T')[0];

      // Get all income and expense accounts with balances from journal entries
      const result = await pool.query(`
        WITH journal_totals AS (
          SELECT
            a.id, a.code, a.name, a.type, a.sub_type,
            COALESCE(SUM(CASE WHEN jel.debit > 0 THEN jel.debit ELSE 0 END), 0) as total_debit,
            COALESCE(SUM(CASE WHEN jel.credit > 0 THEN jel.credit ELSE 0 END), 0) as total_credit
          FROM accounts a
          LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
          LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
            AND je.tenant_id = $1
            AND je.date BETWEEN $2 AND $3
            AND je.status = 'posted'
          WHERE a.tenant_id = $1
          AND a.type IN ('income', 'expense')
          GROUP BY a.id, a.code, a.name, a.type, a.sub_type
        )
        SELECT *,
          CASE
            WHEN type = 'income'  THEN total_credit - total_debit
            WHEN type = 'expense' THEN total_debit - total_credit
          END as net_amount
        FROM journal_totals
        ORDER BY type DESC, sub_type, code
      `, [tenantId, fromDate, toDate]);

      // Also get AR invoice revenue and AP invoice expenses
      const arRevenue = await pool.query(`
        SELECT COALESCE(SUM(subtotal), 0) as amount
        FROM ar_invoices
        WHERE tenant_id = $1 AND date BETWEEN $2 AND $3
        AND status NOT IN ('draft', 'cancelled')
      `, [tenantId, fromDate, toDate]);

      const apExpenses = await pool.query(`
        SELECT COALESCE(SUM(subtotal), 0) as amount
        FROM ap_invoices
        WHERE tenant_id = $1 AND date BETWEEN $2 AND $3
        AND status NOT IN ('draft', 'rejected')
      `, [tenantId, fromDate, toDate]);

      const rows = result.rows;
      const income  = rows.filter(r => r.type === 'income');
      const expense = rows.filter(r => r.type === 'expense');

      const totalIncome  = income.reduce((s: number, r: any) => s + parseFloat(r.net_amount || 0), 0);
      const totalExpense = expense.reduce((s: number, r: any) => s + parseFloat(r.net_amount || 0), 0);

      // Use AR/AP data if no journal entries
      const effectiveIncome  = totalIncome  || parseFloat(arRevenue.rows[0].amount);
      const effectiveExpense = totalExpense || parseFloat(apExpenses.rows[0].amount);

      const grossProfit  = effectiveIncome - effectiveExpense * 0.4; // COGS estimate
      const ebitda       = effectiveIncome - effectiveExpense;
      const netProfit    = ebitda * 0.75; // after tax estimate

      res.json({
        period: { from: fromDate, to: toDate },
        income: {
          items: income,
          total: effectiveIncome,
          ar_invoiced: parseFloat(arRevenue.rows[0].amount),
        },
        expense: {
          items: expense,
          total: effectiveExpense,
          ap_invoiced: parseFloat(apExpenses.rows[0].amount),
        },
        gross_profit: grossProfit,
        ebitda,
        net_profit: netProfit,
        gross_margin: effectiveIncome > 0 ? (grossProfit / effectiveIncome * 100).toFixed(1) : 0,
        ebitda_margin: effectiveIncome > 0 ? (ebitda / effectiveIncome * 100).toFixed(1) : 0,
        net_margin: effectiveIncome > 0 ? (netProfit / effectiveIncome * 100).toFixed(1) : 0,
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── Balance Sheet ─────────────────────────────────────────
  router.get('/balance-sheet', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const asOf = req.query.as_of as string || new Date().toISOString().split('T')[0];

      const result = await pool.query(`
        WITH account_balances AS (
          SELECT
            a.id, a.code, a.name, a.type, a.sub_type,
            a.opening_balance,
            COALESCE(SUM(CASE WHEN jel.debit > 0 THEN jel.debit ELSE 0 END), 0) as total_debit,
            COALESCE(SUM(CASE WHEN jel.credit > 0 THEN jel.credit ELSE 0 END), 0) as total_credit
          FROM accounts a
          LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
          LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
            AND je.tenant_id = $1
            AND je.date <= $2
            AND je.status = 'posted'
          WHERE a.tenant_id = $1
          AND a.type IN ('asset', 'liability', 'equity')
          GROUP BY a.id, a.code, a.name, a.type, a.sub_type, a.opening_balance
        )
        SELECT *,
          CASE
            WHEN type = 'asset'     THEN opening_balance + total_debit - total_credit
            WHEN type = 'liability' THEN opening_balance + total_credit - total_debit
            WHEN type = 'equity'    THEN opening_balance + total_credit - total_debit
          END as balance
        FROM account_balances
        ORDER BY type, sub_type, code
      `, [tenantId, asOf]);

      // Cash, receivables and payables as of the requested date. For a past date these are rebuilt
      // from dated records only (never today's balances); what cannot be rebuilt is reported, not guessed.
      const todayStr = new Date().toISOString().split('T')[0];
      const isPast = asOf < todayStr;
      const warnings: string[] = [];
      let arUnknown = { count: 0, total: 0 };
      let apUnknown = { count: 0, total: 0 };
      let bankBals: any, arBal: any, apBal: any;
      if (!isPast) {
        const c0 = await cashAsOf(pool, tenantId, asOf);
        bankBals = { rows: [{ total: c0.amount }] };
        if (!c0.has_entry) warnings.push('Cash and bank balance has not been entered, so cash is shown as 0. Add it on the Cash Balance page.');
        arBal = await pool.query(`
          SELECT COALESCE(SUM(balance_due), 0) as total FROM ar_invoices
          WHERE tenant_id = $1 AND status NOT IN ('paid','cancelled')
        `, [tenantId]);
        apBal = await pool.query(`
          SELECT COALESCE(SUM(balance_due), 0) as total FROM ap_invoices
          WHERE tenant_id = $1 AND status NOT IN ('paid','rejected')
        `, [tenantId]);
      } else {
        await ensurePaymentEventsTable(pool);
        const c1 = await cashAsOf(pool, tenantId, asOf);
        bankBals = { rows: [{ total: c1.amount }] };
        if (!c1.has_entry) warnings.push('No cash balance was entered on or before ' + asOf + ', so cash is shown as 0. Add a balance on the Cash Balance page.');
        else if (c1.entry_date !== asOf) warnings.push('Cash is the balance entered on ' + c1.entry_date + ' plus receipts and payments recorded since.');
        const settled = async (tbl: string, type: string, skip: string) => (await pool.query(`
          WITH inv AS (
            SELECT i.total_amount, i.paid_amount, i.status AS inv_status,
                   COALESCE((SELECT SUM(e.amount) FROM invoice_payment_events e WHERE e.tenant_id = $1 AND e.invoice_type = $3 AND e.invoice_id = i.id), 0) AS ev_total,
                   COALESCE((SELECT SUM(e.amount) FROM invoice_payment_events e WHERE e.tenant_id = $1 AND e.invoice_type = $3 AND e.invoice_id = i.id AND e.payment_date <= $2), 0) AS ev_by_date
            FROM ${tbl} i WHERE i.tenant_id = $1 AND i.date <= $2 AND i.status NOT IN (${skip}))
          SELECT COALESCE(SUM(CASE WHEN NOT ((paid_amount > 0 OR inv_status = 'paid') AND ev_total + 0.005 < GREATEST(paid_amount, CASE WHEN inv_status = 'paid' THEN total_amount ELSE 0 END)) THEN total_amount - ev_by_date END), 0) AS known,
                 COUNT(*) FILTER (WHERE (paid_amount > 0 OR inv_status = 'paid') AND ev_total + 0.005 < GREATEST(paid_amount, CASE WHEN inv_status = 'paid' THEN total_amount ELSE 0 END)) AS unknown_count,
                 COALESCE(SUM(CASE WHEN (paid_amount > 0 OR inv_status = 'paid') AND ev_total + 0.005 < GREATEST(paid_amount, CASE WHEN inv_status = 'paid' THEN total_amount ELSE 0 END) THEN total_amount END), 0) AS unknown_total
          FROM inv
        `, [tenantId, asOf, type])).rows[0];
        const ar = await settled('ar_invoices', 'ar', `'draft','cancelled'`);
        const ap = await settled('ap_invoices', 'ap', `'draft','rejected'`);
        arBal = { rows: [{ total: ar.known }] };
        apBal = { rows: [{ total: ap.known }] };
        arUnknown = { count: parseInt(ar.unknown_count), total: parseFloat(ar.unknown_total) };
        apUnknown = { count: parseInt(ap.unknown_count), total: parseFloat(ap.unknown_total) };
        if (arUnknown.count > 0) warnings.push(arUnknown.count + ' receivable invoice(s) worth ' + arUnknown.total.toFixed(2) + ' were paid before payment dates were recorded, so their balance on ' + asOf + ' cannot be rebuilt and is left out.');
        if (apUnknown.count > 0) warnings.push(apUnknown.count + ' payable invoice(s) worth ' + apUnknown.total.toFixed(2) + ' were paid before payment dates were recorded, so their balance on ' + asOf + ' cannot be rebuilt and is left out.');
        warnings.push('Invoices cancelled or rejected since ' + asOf + ' are not included.');
      }

      const rows = result.rows;
      const assets      = rows.filter(r => r.type === 'asset');
      const liabilities = rows.filter(r => r.type === 'liability');
      const equity      = rows.filter(r => r.type === 'equity');

      const totalAssets      = assets.reduce((s: number, r: any) => s + parseFloat(r.balance || 0), 0);
      const totalLiabilities = liabilities.reduce((s: number, r: any) => s + parseFloat(r.balance || 0), 0);
      const totalEquity      = equity.reduce((s: number, r: any) => s + parseFloat(r.balance || 0), 0);

      // Use bank + AR as current assets if no journal entries
      const effectiveAssets = totalAssets || (
        parseFloat(bankBals.rows[0].total) + parseFloat(arBal.rows[0].total)
      );
      const effectiveLiabilities = totalLiabilities || parseFloat(apBal.rows[0].total);
      const effectiveEquity = totalEquity || (effectiveAssets - effectiveLiabilities);

      res.json({
        as_of: asOf,
        data_quality: { is_past_date: isPast, warnings, receivables_not_rebuildable: arUnknown, payables_not_rebuildable: apUnknown },
        assets: {
          current: assets.filter(a => a.sub_type?.includes('current')),
          fixed:   assets.filter(a => a.sub_type?.includes('fixed')),
          items:   assets,
          total:   effectiveAssets,
          bank_balance: parseFloat(bankBals.rows[0].total),
          ar_balance:   parseFloat(arBal.rows[0].total),
        },
        liabilities: {
          current: liabilities.filter(l => l.sub_type?.includes('current')),
          items:   liabilities,
          total:   effectiveLiabilities,
          ap_balance: parseFloat(apBal.rows[0].total),
        },
        equity: {
          items: equity,
          total: effectiveEquity,
        },
        total_assets:      effectiveAssets,
        total_liabilities: effectiveLiabilities,
        total_equity:      effectiveEquity,
        is_balanced:       Math.abs(effectiveAssets - (effectiveLiabilities + effectiveEquity)) < 1,
        working_capital:   effectiveAssets - effectiveLiabilities,
        debt_to_equity:    effectiveEquity > 0 ? (effectiveLiabilities / effectiveEquity).toFixed(2) : 0,
        current_ratio:     effectiveLiabilities > 0 ? (effectiveAssets / effectiveLiabilities).toFixed(2) : 0,
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── Cash Flow Statement ───────────────────────────────────
  router.get('/cash-flow-statement', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { from, to } = req.query;
      const fromDate = from as string || new Date(new Date().getFullYear(), 3, 1).toISOString().split('T')[0];
      const toDate   = to as string   || new Date().toISOString().split('T')[0];

      // Operating: customer receipts and vendor payments (recorded payment events). /*cfs-events*/
      await ensurePaymentEventsTable(pool);
      const receipts = await pool.query(`
        SELECT COALESCE(SUM(amount), 0) as total FROM invoice_payment_events
        WHERE tenant_id = $1 AND invoice_type = 'ar' AND payment_date BETWEEN $2 AND $3
      `, [tenantId, fromDate, toDate]);

      const payments = await pool.query(`
        SELECT COALESCE(SUM(amount), 0) as total FROM invoice_payment_events
        WHERE tenant_id = $1 AND invoice_type = 'ap' AND payment_date BETWEEN $2 AND $3
      `, [tenantId, fromDate, toDate]);

      // Salaries and taxes paid are not recorded as dated payments yet.
      const salaries = { rows: [{ total: '0' }] };
      const taxes = { rows: [{ total: '0' }] };

      // Investing: asset purchases
      const assetPurchases = await pool.query(`
        SELECT COALESCE(SUM(purchase_price), 0) as total
        FROM fixed_assets
        WHERE tenant_id = $1 AND purchase_date BETWEEN $2 AND $3
      `, [tenantId, fromDate, toDate]);

      // Opening and closing cash come from the manual cash balance plus recorded receipts and payments.
      const dayBefore = new Date(new Date(fromDate + 'T00:00:00Z').getTime() - 86400000).toISOString().split('T')[0];
      const cOpen = await cashAsOf(pool, tenantId, dayBefore);
      const cClose = await cashAsOf(pool, tenantId, toDate);
      const openingBal = { rows: [{ total: String(cOpen.amount) }] };
      const closingBal = { rows: [{ total: String(cClose.amount) }] };

      const operatingInflow  = parseFloat(receipts.rows[0].total);
      const operatingOutflow = parseFloat(payments.rows[0].total);
      const netOperating     = operatingInflow - operatingOutflow;
      const netInvesting     = -parseFloat(assetPurchases.rows[0].total);
      const netFinancing     = 0;
      const opening          = parseFloat(openingBal.rows[0].total);
      const closing          = parseFloat(closingBal.rows[0].total);

      res.json({
        period: { from: fromDate, to: toDate },
        operating: {
          inflows: [
            { label: 'Cash received from customers', amount: operatingInflow },
          ],
          outflows: [
            { label: 'Payments to vendors',   amount: parseFloat(payments.rows[0].total) - parseFloat(salaries.rows[0].total) - parseFloat(taxes.rows[0].total) },
            { label: 'Salaries paid',          amount: parseFloat(salaries.rows[0].total) },
            { label: 'Taxes paid',             amount: parseFloat(taxes.rows[0].total) },
          ],
          net: netOperating,
        },
        investing: {
          outflows: [
            { label: 'Purchase of fixed assets', amount: parseFloat(assetPurchases.rows[0].total) },
          ],
          net: netInvesting,
        },
        financing: {
          items: [],
          net: netFinancing,
        },
        opening_balance: opening,
        closing_balance: closing,
        net_change: closing - opening,
        free_cash_flow: netOperating + netInvesting,
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── Key Ratios ────────────────────────────────────────────
  router.get('/ratios', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);

      const [banks, ar, ap, payroll, sales90, purch90, outflow90] = await Promise.all([
        pool.query('SELECT COALESCE(SUM(current_balance),0) as total FROM bank_accounts WHERE tenant_id=$1 AND is_active=TRUE', [tenantId]),
        pool.query("SELECT COALESCE(SUM(balance_due),0) as total FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled')", [tenantId]),
        pool.query("SELECT COALESCE(SUM(balance_due),0) as total FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','rejected')", [tenantId]),
        pool.query("SELECT total_gross as monthly FROM payroll_runs WHERE tenant_id=$1 AND status='paid' ORDER BY year DESC, month DESC LIMIT 1", [tenantId]),
        pool.query("SELECT COALESCE(SUM(total_amount),0) as total FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled') AND date::date >= CURRENT_DATE - 90", [tenantId]),
        pool.query("SELECT COALESCE(SUM(total_amount),0) as total FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','rejected') AND date::date >= CURRENT_DATE - 90", [tenantId]),
        pool.query("SELECT COALESCE(SUM(amount),0) as total FROM bank_transactions WHERE tenant_id=$1 AND type='debit' AND date::date >= CURRENT_DATE - 90", [tenantId]),
      ]);

      const cash = parseFloat(banks.rows[0].total);
      const arBal = parseFloat(ar.rows[0].total);
      const apBal = parseFloat(ap.rows[0].total);
      const payrollMonthly = parseFloat(payroll.rows[0]?.monthly || 0);
      const bankBurn = parseFloat(outflow90.rows[0].total) / 3;   // real average monthly outflow
      const monthlyBurn = bankBurn > 0 ? bankBurn : (payrollMonthly || 1);
      const runway = cash / monthlyBurn;
      const sales = parseFloat(sales90.rows[0].total), purchases = parseFloat(purch90.rows[0].total);

      res.json({
        cash_position: cash,
        accounts_receivable: arBal,
        accounts_payable: apBal,
        working_capital: cash + arBal - apBal,
        runway_months: parseFloat(runway.toFixed(1)),
        current_ratio: apBal > 0 ? parseFloat(((cash + arBal) / apBal).toFixed(2)) : 0,
        quick_ratio: apBal > 0 ? parseFloat((cash / apBal).toFixed(2)) : 0,
        monthly_burn: monthlyBurn,
        // DSO = AR outstanding / credit sales (90d) x 90 ; DPO likewise on purchases (was a constant 30 before)
        dso: sales > 0 ? Math.round((arBal / sales) * 90) : null,
        dpo: purchases > 0 ? Math.round((apBal / purchases) * 90) : null,
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // real_statements_v2
  // ── GET /api/statements/pl — Real P&L from AR/AP data ─────
  router.get('/pl', requireAuth, async (req, res) => {
    try {
      const tenantId = tid(req);
      const { month, year } = req.query;
      const m = parseInt(month as string) || new Date().getMonth() + 1;
      const y = parseInt(year as string) || new Date().getFullYear();
      const from = `${y}-${String(m).padStart(2,'0')}-01`;
      const to = new Date(y, m, 0).toISOString().split('T')[0];

      const [revenue, cogs, opex, payrollData] = await Promise.all([
        // Revenue from AR invoices
        pool.query(
          `SELECT COALESCE(SUM(subtotal),0) as total, COUNT(*) as count
           FROM ar_invoices WHERE tenant_id=$1 AND date BETWEEN $2 AND $3
           AND status NOT IN ('draft','cancelled')`,
          [tenantId, from, to]
        ),
        // COGS from AP invoices (IT services, software)
        pool.query(
          `SELECT COALESCE(SUM(subtotal),0) as total
           FROM ap_invoices WHERE tenant_id=$1 AND date BETWEEN $2 AND $3
           AND status NOT IN ('draft','rejected')`,
          [tenantId, from, to]
        ),
        // Operating expenses from expense claims
        pool.query(
          `SELECT COALESCE(SUM(total_amount),0) as total
           FROM expense_claims WHERE tenant_id=$1
           AND date BETWEEN $2 AND $3 AND status='approved'`,
          [tenantId, from, to]
        ),
        // Payroll
        pool.query(
          `SELECT COALESCE(SUM(total_gross),0) as total
           FROM payroll_runs WHERE tenant_id=$1 AND month=$2 AND year=$3`,
          [tenantId, m, y]
        ),
      ]);

      const rev = parseFloat(revenue.rows[0].total);
      const vendorCosts = parseFloat(cogs.rows[0].total);
      const expenses = parseFloat(opex.rows[0].total);
      const payroll = parseFloat(payrollData.rows[0].total);
      const grossProfit = rev - vendorCosts;
      const ebitda = grossProfit - expenses - payroll;
      const taxRate = 0.25;
      const tax = Math.max(0, ebitda * taxRate);
      const netProfit = ebitda - tax;

      res.json({
        period: { month: m, year: y, from, to },
        revenue: { total: rev, invoice_count: parseInt(revenue.rows[0].count) },
        cost_of_goods: vendorCosts,
        gross_profit: grossProfit,
        gross_margin: rev > 0 ? ((grossProfit / rev) * 100).toFixed(1) : '0',
        operating_expenses: {
          payroll,
          vendor_expenses: vendorCosts,
          employee_expenses: expenses,
          total: payroll + expenses,
        },
        ebitda,
        ebitda_margin: rev > 0 ? ((ebitda / rev) * 100).toFixed(1) : '0',
        tax,
        tax_is_estimate: true,
        tax_note: 'Flat 25% of positive EBITDA; not a computed tax liability',
        net_profit: netProfit,
        net_margin: rev > 0 ? ((netProfit / rev) * 100).toFixed(1) : '0',
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/statements/cash-flow — Cash Flow Statement ────
  router.get('/cash-flow', requireAuth, async (req, res) => {
    try {
      const tenantId = tid(req);
      const { month, year } = req.query;
      const m = parseInt(month as string) || new Date().getMonth() + 1;
      const y = parseInt(year as string) || new Date().getFullYear();
      const from = `${y}-${String(m).padStart(2,'0')}-01`;
      const to = new Date(y, m, 0).toISOString().split('T')[0];

      const [credits, debits] = await Promise.all([
        pool.query(
          "SELECT COALESCE(SUM(amount),0) as total FROM bank_transactions WHERE tenant_id=$1 AND type='credit' AND date BETWEEN $2 AND $3",
          [tenantId, from, to]
        ),
        pool.query(
          "SELECT COALESCE(SUM(amount),0) as total FROM bank_transactions WHERE tenant_id=$1 AND type='debit' AND date BETWEEN $2 AND $3",
          [tenantId, from, to]
        ),
      ]);

      const inflows = parseFloat(credits.rows[0].total);
      const outflows = parseFloat(debits.rows[0].total);

      res.json({
        period: { month: m, year: y },
        operating: { inflows, outflows, net: inflows - outflows },
        investing: { inflows: 0, outflows: 0, net: 0 },
        financing: { inflows: 0, outflows: 0, net: 0 },
        net_change: inflows - outflows,
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
