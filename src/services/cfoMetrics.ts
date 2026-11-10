// ============================================================
// Deemona AI Finance OS — CFO Metrics Service (Step 1)
// Deterministic, SQL-computed metrics. The CFO agent calls these as
// tools, so every number the model quotes comes from a query, not a guess.
// Metrics that need data the schema doesn't hold yet return
// { available:false, needs_data:[...] } so the agent says so honestly.
// ============================================================
import { Pool } from 'pg';
import { cashAsOf } from './cashPosition';
import { loadForecastInputs } from './cashForecast';
import { buildActionPlan } from './actionPlan';
import { proposeCollectionActions, proposeBoardReport, proposeComplianceTasks } from './controlledActions';
import { loadRiskInputs } from './collectionRiskData';
import { scoreCollectionRisk } from './collectionRisk';
import { loadSpendInputs } from './spendOptimizationData';
import { analyzeSpend } from './spendOptimization';
import { simulateWhatIf } from './whatIf';
import { ensurePaymentEventsTable } from '../routes/paymentEventsRoutes';
import {
  ensureCfoSetupTables, DIM_KINDS, DimKind, DIM_COLUMN, TARGET_METRICS, FORECAST_METRICS, PERIOD_TYPES,
  istTodayYmd, currentPeriodStart, periodEnd, daysBetweenInclusive, addMonthsYmd,
} from './cfoSetup';

type Json = Record<string, any>;

export interface Metric {
  description: string;
  input_schema: { type: 'object'; properties: Record<string, any>; required?: string[] };
  run: (pool: Pool, tenantId: string, input: any) => Promise<Json>;
}

// ── helpers ──────────────────────────────────────────────────
const num = (v: any): number => (v === null || v === undefined || v === '' ? 0 : parseFloat(v));
const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d;
const pct = (cur: number, prev: number): number | null => (prev !== 0 ? round(((cur - prev) / Math.abs(prev)) * 100, 1) : null);
const clampInt = (v: any, def: number, min: number, max: number): number => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const isDate = (s: any): boolean => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// "Today" in India, independent of server timezone
const istNow = (): Date => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number): Date => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const lastDayOfMonth = (y: number, m0: number): number => new Date(y, m0 + 1, 0).getDate();

async function rows(pool: Pool, sql: string, params: any[]): Promise<any[]> {
  return (await pool.query(sql, params)).rows;
}

const needsData = (what: string[], reason: string): Json => ({ available: false, needs_data: what, reason });

// Reusable core numbers -----------------------------------------------------
async function coreNumbers(pool: Pool, t: string) {
  const [bank, ar, ap, sales, purchases, inv] = await Promise.all([
    cashAsOf(pool, t).then(c => [{ v: c.amount }]),
    rows(pool, `SELECT COALESCE(SUM(balance_due),0) AS outstanding,
                COALESCE(SUM(balance_due) FILTER (WHERE due_date::date < CURRENT_DATE),0) AS overdue
                FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled','draft')`, [t]),
    rows(pool, `SELECT COALESCE(SUM(balance_due),0) AS outstanding,
                COALESCE(SUM(balance_due) FILTER (WHERE due_date::date < CURRENT_DATE),0) AS overdue
                FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','rejected','draft')`, [t]),
    rows(pool, `SELECT COALESCE(SUM(total_amount),0) AS v FROM ar_invoices
                WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled') AND date::date >= CURRENT_DATE - 90`, [t]),
    rows(pool, `SELECT COALESCE(SUM(total_amount),0) AS v FROM ap_invoices
                WHERE tenant_id=$1 AND status NOT IN ('draft','rejected') AND date::date >= CURRENT_DATE - 90`, [t]),
    rows(pool, `SELECT COALESCE(SUM(current_stock*unit_cost),0) AS v FROM inventory_items WHERE tenant_id=$1`, [t]).catch(() => [{ v: 0 }]),
  ]);
  const cash = num(bank[0].v);
  const arOut = num(ar[0].outstanding), arOverdue = num(ar[0].overdue);
  const apOut = num(ap[0].outstanding), apOverdue = num(ap[0].overdue);
  const sales90 = num(sales[0].v), purchases90 = num(purchases[0].v);
  return {
    cash, arOut, arOverdue, apOut, apOverdue, sales90, purchases90,
    inventory: num(inv[0].v),
    dso: sales90 > 0 ? round((arOut / sales90) * 90, 1) : null,
    dpo: purchases90 > 0 ? round((apOut / purchases90) * 90, 1) : null,
  };
}

/** Current and prior comparable date ranges for a named period (Indian fiscal year Apr-Mar). */
function periodRanges(period: string): { cur: [Date, Date]; prev: [Date, Date] } | null {
  const today = istNow(); const y = today.getFullYear(), m = today.getMonth();
  let cur: [Date, Date], prev: [Date, Date];
  switch (period) {
    case 'today_vs_last_week': cur = [today, today]; prev = [addDays(today, -7), addDays(today, -7)]; break;
    case 'week_vs_prev_week': cur = [addDays(today, -6), today]; prev = [addDays(today, -13), addDays(today, -7)]; break;
    case 'mtd_vs_prev_mtd': {
      const pm = m === 0 ? 11 : m - 1, py = m === 0 ? y - 1 : y;
      cur = [new Date(y, m, 1), today];
      prev = [new Date(py, pm, 1), new Date(py, pm, Math.min(today.getDate(), lastDayOfMonth(py, pm)))]; break;
    }
    case 'month_vs_prev_month': {
      const pm = m === 0 ? 11 : m - 1, py = m === 0 ? y - 1 : y;
      const ppm = pm === 0 ? 11 : pm - 1, ppy = pm === 0 ? py - 1 : py;
      cur = [new Date(py, pm, 1), new Date(py, pm, lastDayOfMonth(py, pm))];
      prev = [new Date(ppy, ppm, 1), new Date(ppy, ppm, lastDayOfMonth(ppy, ppm))]; break;
    }
    case 'last_quarter_vs_prev_quarter': {
      const fyStartYear = m >= 3 ? y : y - 1;                 // FY starts 1 Apr
      const monthsIntoFY = (y - fyStartYear) * 12 + m - 3;    // 0..11
      const qIdx = Math.floor(monthsIntoFY / 3);              // current quarter 0..3
      const curQStart = new Date(fyStartYear, 3 + qIdx * 3, 1);
      const lqStart = new Date(curQStart.getFullYear(), curQStart.getMonth() - 3, 1);
      const pqStart = new Date(curQStart.getFullYear(), curQStart.getMonth() - 6, 1);
      cur = [lqStart, addDays(curQStart, -1)]; prev = [pqStart, addDays(lqStart, -1)]; break;
    }
    case 'ytd_vs_prev_ytd': {
      const fyStartYear = m >= 3 ? y : y - 1;
      cur = [new Date(fyStartYear, 3, 1), today];
      prev = [new Date(fyStartYear - 1, 3, 1), new Date(today.getFullYear() - 1, today.getMonth(), Math.min(today.getDate(), lastDayOfMonth(today.getFullYear() - 1, today.getMonth())))]; break;
    }
    default: return null;
  }
  return { cur, prev };
}

// ── Step 2 helpers: actuals by metric/dimension, forecasts ───
type Dim = { kind: DimKind; id: string };

async function actualMetric(pool: Pool, t: string, metric: string, from: string, to: string, dim?: Dim): Promise<number> {
  const col = dim ? DIM_COLUMN[dim.kind] : '';
  const one = async (sql: string, params: any[]): Promise<number> => num((await rows(pool, sql, params))[0].v);
  switch (metric) {
    case 'revenue':
      return dim
        ? one(`SELECT COALESCE(SUM(x.subtotal),0) AS v FROM ar_invoices x LEFT JOIN cfo_entity_defaults df ON df.tenant_id=x.tenant_id::text AND df.entity_type='customer' AND df.entity_id=x.customer_id::text
               WHERE x.tenant_id=$1 AND x.status NOT IN ('draft','cancelled') AND x.date::date BETWEEN $2 AND $3 AND COALESCE(x.${col}, df.${col}) = $4::uuid`, [t, from, to, dim.id])
        : one(`SELECT COALESCE(SUM(subtotal),0) AS v FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled') AND date::date BETWEEN $2 AND $3`, [t, from, to]);
    case 'vendor_costs':
      return dim
        ? one(`SELECT COALESCE(SUM(x.subtotal),0) AS v FROM ap_invoices x LEFT JOIN cfo_entity_defaults df ON df.tenant_id=x.tenant_id::text AND df.entity_type='vendor' AND df.entity_id=x.vendor_id::text
               WHERE x.tenant_id=$1 AND x.status NOT IN ('draft','rejected') AND x.date::date BETWEEN $2 AND $3 AND COALESCE(x.${col}, df.${col}) = $4::uuid`, [t, from, to, dim.id])
        : one(`SELECT COALESCE(SUM(subtotal),0) AS v FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','rejected') AND date::date BETWEEN $2 AND $3`, [t, from, to]);
    case 'payroll':
      return one(`SELECT COALESCE(SUM(total_gross),0) AS v FROM payroll_runs WHERE tenant_id=$1
                  AND make_date(year, month, 1) >= date_trunc('month', $2::date) AND make_date(year, month, 1) <= $3::date`, [t, from, to]);
    case 'cash_in':
      return one(`SELECT COALESCE(SUM(amount),0) AS v FROM invoice_payment_events WHERE tenant_id=$1 AND invoice_type='ar' AND payment_date BETWEEN $2 AND $3`, [t, from, to]);
    case 'cash_out':
      return one(`SELECT COALESCE(SUM(amount),0) AS v FROM invoice_payment_events WHERE tenant_id=$1 AND invoice_type='ap' AND payment_date BETWEEN $2 AND $3`, [t, from, to]);
    case 'ebitda': {
      const [rev, ven, pay, clm] = await Promise.all([
        actualMetric(pool, t, 'revenue', from, to), actualMetric(pool, t, 'vendor_costs', from, to), actualMetric(pool, t, 'payroll', from, to),
        one(`SELECT COALESCE(SUM(total_amount),0) AS v FROM expense_claims WHERE tenant_id=$1 AND status='approved' AND date::date BETWEEN $2 AND $3`, [t, from, to]),
      ]);
      return rev - ven - pay - clm;
    }
    default: throw new Error('unsupported metric ' + metric);
  }
}

/** Saves a baseline (trailing 3 completed months average) forecast for this month and the next two.
 *  The first save wins (ON CONFLICT DO NOTHING) so forecast-vs-actual compares against what was forecast at the time. */
export async function recordForecasts(pool: Pool, tenantId: string): Promise<number> {
  await ensureCfoSetupTables(pool);
  const thisMonth = currentPeriodStart('month', istTodayYmd(), 0);
  const histFrom = addMonthsYmd(thisMonth, -3), histTo = periodEnd('month', addMonthsYmd(thisMonth, -1));
  let saved = 0;
  for (const metric of FORECAST_METRICS) {
    const avg = (await actualMetric(pool, tenantId, metric, histFrom, histTo)) / 3;
    if (!(avg > 0)) continue;
    for (const k of [0, 1, 2]) {
      const r = await pool.query(
        `INSERT INTO cfo_forecasts (tenant_id, metric, period_start, forecast_value, source, method)
         VALUES ($1,$2,$3::date,$4,'system','trailing 3-month average') ON CONFLICT (tenant_id, metric, period_start, source) DO NOTHING`,
        [tenantId, metric, addMonthsYmd(thisMonth, k), Math.round(avg)]);
      saved += r.rowCount || 0;
    }
  }
  return saved;
}

// ── Metric registry ──────────────────────────────────────────
export const METRICS: Record<string, Metric> = {

  /*decision-tools*/
  shortfall_action_plan: {
    description: 'When cash is forecast to fall below a minimum, returns a concrete plan: which customer invoices to collect in full and on time and which vendor bills to pay later, step by step, with how much each step lifts the lowest cash point and the cash position before and after. Use for "how do we avoid a cash shortage", "what should we collect or delay", "how do we fix the cash gap". Suggestions only; nothing is executed.',
    input_schema: { type: 'object', properties: {
      days: { type: 'integer', description: 'Horizon in days. Default 90, max 180.' },
      min_cash: { type: 'number', description: 'Minimum cash to keep, in INR. Default 0.' },
      collection_rate: { type: 'number', description: 'Share of receivables assumed to arrive on time, 0-1. Default 0.7.' },
      defer_days: { type: 'integer', description: 'How many days a deferred bill is paid later. Default 14.' },
    } },
    async run(pool, t, input) {
      const { opening, items, today } = await loadForecastInputs(pool, t);
      const plan: any = buildActionPlan(opening, items, today, {
        days: clampInt(input?.days, 90, 7, 180), minCash: Math.max(0, num(input?.min_cash)),
        collectionRate: input?.collection_rate !== undefined ? Math.min(1, Math.max(0, num(input.collection_rate))) : 0.7,
        deferDays: clampInt(input?.defer_days, 14, 1, 60),
      });
      plan.collect_total_amount = plan.collect_total; plan.defer_total_amount = plan.defer_total;
      return plan;
    },
  },

  /*what-if*/
  what_if_simulation: {
    description: 'What-if simulator. Models the effect of changes on cash, profit and runway over the next N months against a no-change baseline built from the last completed months of actuals: revenue up/down by a percentage, hiring or cutting N people, multiplying a budget line (e.g. marketing doubles), a new recurring cost (e.g. new office rent) and one-time costs (e.g. fit-out). Use for "what happens if revenue drops 20%", "if we hire 50 people", "if marketing budget doubles", "if we open a new office". Run-rate model: cash moves with operating profit, not invoice-by-invoice timing. Several changes can be combined in one call. If there is no history, pass assume_monthly or ask the user for typical monthly figures.',
    input_schema: { type: 'object', properties: {
      months: { type: 'integer', description: 'Horizon in months. Default 12, max 24.' },
      revenue_change_pct: { type: 'number', description: 'Revenue change in percent, e.g. -20 for a 20% drop, 15 for 15% growth.' },
      revenue_change_start_month: { type: 'integer', description: 'Month the revenue change starts (1 = next month). Default 1.' },
      costs_follow_revenue: { type: 'boolean', description: 'If true, vendor/purchase costs move by the same percentage as revenue (cost of sales). Default false.' },
      headcount_change: { type: 'integer', description: 'People hired (positive) or reduced (negative).' },
      cost_per_head_monthly: { type: 'number', description: 'Monthly cost to company per person in INR. Defaults to the average from payroll runs.' },
      headcount_start_month: { type: 'integer', description: 'Month the headcount change starts. Default 1.' },
      budget_change: { type: 'object', description: 'Scale a budget line, e.g. marketing doubles.', properties: {
        name: { type: 'string', description: 'Budget or department name to look up, e.g. marketing.' },
        multiplier: { type: 'number', description: '2 = doubles, 0.5 = halves.' },
        current_monthly: { type: 'number', description: 'Current monthly spend in INR if no budget with that name exists.' },
        start_month: { type: 'integer', description: 'Default 1.' } } },
      new_monthly_cost: { type: 'object', description: 'A new recurring monthly cost, e.g. rent for a new office.', properties: {
        label: { type: 'string' }, amount: { type: 'number', description: 'INR per month.' }, start_month: { type: 'integer', description: 'Default 1.' } } },
      one_time_cost: { type: 'object', description: 'A one-time cost, e.g. office fit-out.', properties: {
        label: { type: 'string' }, amount: { type: 'number', description: 'INR.' }, month: { type: 'integer', description: 'Month it is paid. Default 1.' } } },
      assume_monthly: { type: 'object', description: 'Override or supply baseline monthly figures in INR when history is missing.', properties: {
        revenue: { type: 'number' }, vendor_costs: { type: 'number' }, payroll: { type: 'number' }, other_costs: { type: 'number' } } },
    } },
    async run(pool, t, input) {
      const months = clampInt(input?.months, 12, 1, 24);
      const opening = await cashAsOf(pool, t);
      const hist = await rows(pool, "WITH ms AS (SELECT (date_trunc('month', CURRENT_DATE) - make_interval(months => g))::date AS m FROM generate_series(1, 3) g) SELECT " +
        "(SELECT COALESCE(SUM(subtotal),0) FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled') AND date::date >= m AND date::date < m + interval '1 month') AS revenue, " +
        "(SELECT COALESCE(SUM(subtotal),0) FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','rejected') AND date::date >= m AND date::date < m + interval '1 month') AS vendor_costs, " +
        "(SELECT COALESCE(SUM(total_gross + COALESCE(total_employer_pf,0)),0) FROM payroll_runs WHERE tenant_id=$1 AND year = EXTRACT(YEAR FROM m)::int AND month = EXTRACT(MONTH FROM m)::int) AS payroll, " +
        "(SELECT COALESCE(MAX(total_employees),0) FROM payroll_runs WHERE tenant_id=$1 AND year = EXTRACT(YEAR FROM m)::int AND month = EXTRACT(MONTH FROM m)::int) AS employees, " +
        "(SELECT COALESCE(SUM(total_amount),0) FROM expense_claims WHERE tenant_id=$1 AND status='approved' AND date::date >= m AND date::date < m + interval '1 month') AS claims FROM ms", [t])
        .catch(async () => rows(pool, "WITH ms AS (SELECT (date_trunc('month', CURRENT_DATE) - make_interval(months => g))::date AS m FROM generate_series(1, 3) g) SELECT " +
          "(SELECT COALESCE(SUM(subtotal),0) FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled') AND date::date >= m AND date::date < m + interval '1 month') AS revenue, " +
          "(SELECT COALESCE(SUM(subtotal),0) FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','rejected') AND date::date >= m AND date::date < m + interval '1 month') AS vendor_costs, 0 AS payroll, 0 AS employees, 0 AS claims FROM ms", [t]));
      const withData = hist.filter(h => num(h.revenue) + num(h.vendor_costs) + num(h.payroll) + num(h.claims) > 0);
      const nUse = withData.length;
      const avg = (k: string): number => (nUse ? withData.reduce((s, h) => s + num(h[k]), 0) / nUse : 0);
      const emps = withData.filter(h => num(h.employees) > 0);
      const avgEmp = emps.length ? emps.reduce((s, h) => s + num(h.employees), 0) / emps.length : 0;
      const am = input?.assume_monthly || {};
      const pick = (v: any, d: number): number => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : d);
      const base = { revenue: pick(am.revenue, avg('revenue')), vendor_costs: pick(am.vendor_costs, avg('vendor_costs')), payroll: pick(am.payroll, avg('payroll')),
        claims: pick(am.other_costs, avg('claims')), employees: avgEmp || null, months_used: nUse,
        source: Object.keys(am).length ? (nUse ? 'actuals with your assumptions' : 'your assumptions') : 'actuals' };
      if (!(base.revenue + base.vendor_costs + base.payroll + base.claims > 0)) {
        return needsData(['3 completed months of invoices, payroll or expense claims', 'or assume_monthly figures'],
          'There is no history in the last 3 completed months to build a baseline. Ask the user for typical monthly revenue and costs and call again with assume_monthly.');
      }
      const costPerHeadAuto = avgEmp > 0 && avg('payroll') > 0 ? avg('payroll') / avgEmp : 0;
      const hc = Math.round(num(input?.headcount_change));
      const costPerHead = input?.cost_per_head_monthly !== undefined ? Math.max(0, num(input.cost_per_head_monthly)) : costPerHeadAuto;
      if (hc !== 0 && !(costPerHead > 0)) {
        return needsData(['cost_per_head_monthly'], 'There is no payroll history to work out the monthly cost per person. Ask the user what a new hire costs per month (salary plus employer contributions) and call again with cost_per_head_monthly.');
      }
      const startOf = (v: any): number => clampInt(v, 1, 1, months);
      const extra: { label: string; amount: number; start: number }[] = [];
      const notes: string[] = [];
      const bc = input?.budget_change;
      if (bc && Number.isFinite(Number(bc.multiplier)) && Number(bc.multiplier) > 0) {
        const mult = Math.min(10, Number(bc.multiplier));
        let monthly = bc.current_monthly !== undefined ? Math.max(0, num(bc.current_monthly)) : 0, matched: string | null = null;
        if (!monthly && bc.name) {
          const q = await rows(pool, "SELECT name, department, fiscal_year, total_budgeted FROM budgets WHERE tenant_id=$1 AND (name ILIKE $2 OR department ILIKE $2) AND total_budgeted > 0 ORDER BY fiscal_year DESC LIMIT 1", [t, '%' + String(bc.name).slice(0, 60) + '%']).catch(() => []);
          if (q.length) { monthly = num(q[0].total_budgeted) / 12; matched = q[0].name + (q[0].department ? ' / ' + q[0].department : '') + ' (FY ' + q[0].fiscal_year + ')'; notes.push('Monthly budget taken as the annual budget of ' + matched + ' divided by 12.'); }
        }
        if (!(monthly > 0)) return needsData(['budget_change.current_monthly'], 'No budget named "' + String(bc.name || '') + '" was found. Ask the user for the current monthly spend on it and call again with budget_change.current_monthly.');
        extra.push({ label: (bc.name || 'budget') + ' x' + mult, amount: monthly * (mult - 1), start: startOf(bc.start_month) });
      }
      const nm = input?.new_monthly_cost;
      if (nm && num(nm.amount) > 0) extra.push({ label: String(nm.label || 'new monthly cost').slice(0, 60), amount: num(nm.amount), start: startOf(nm.start_month) });
      const ot = input?.one_time_cost;
      const once = ot && num(ot.amount) > 0 ? [{ label: String(ot.label || 'one-time cost').slice(0, 60), amount: num(ot.amount), month: startOf(ot.month) }] : [];
      const rc = input?.revenue_change_pct !== undefined ? Math.max(-100, Math.min(1000, num(input.revenue_change_pct))) : 0;
      if (rc === 0 && hc === 0 && !extra.length && !once.length) return { error: 'No change was specified. Give at least one of: revenue_change_pct, headcount_change, budget_change, new_monthly_cost, one_time_cost.' };
      const sim: any = simulateWhatIf(opening.amount, base, {
        months, revenue_change_pct: rc, revenue_start: startOf(input?.revenue_change_start_month), costs_follow_revenue: !!input?.costs_follow_revenue,
        headcount_change: hc, cost_per_head: costPerHead, headcount_start: startOf(input?.headcount_change_start_month ?? input?.headcount_start_month), extra_monthly: extra, one_time: once,
      });
      sim.changes_applied = { revenue_change_pct: rc || undefined, vendor_costs_follow_revenue: input?.costs_follow_revenue ? true : undefined, headcount_change: hc || undefined, cost_per_head: hc ? Math.round(costPerHead) : undefined,
        recurring: extra.map(e => ({ label: e.label, amount: Math.round(e.amount), from_month_no: e.start })), one_time: once };
      sim.assumptions = [
        'Run-rate model: the baseline is the average of the last ' + (nUse || 'assumed') + ' completed months; cash moves with operating profit and ignores invoice timing.',
        'Payroll cost includes employer provident fund where payroll runs exist. Taxes on profit, GST and loan repayments are not modelled.',
        'Vendor costs stay flat unless costs_follow_revenue is true.', ...notes];
      if (!opening.has_entry) sim.warning = 'No cash balance has been entered, so opening cash is zero and the cash figures are not meaningful. Record the current cash balance.';
      return sim;
    },
  },

  /*collection-risk*/
  customer_default_risk: {
    description: 'Collection risk: scores every customer with open invoices from 0 to 100 (High 70+, Medium 40-69, Low under 40) using their payment history and overdue invoices, ranks customers by expected loss, and estimates expected bad debt for the next quarter. Returns the reasons behind each score and the method. Use for "which customers are most likely not to pay", "expected bad debt", "collection risk score", "who should we worry about". Rule-based estimate, not an accounting provision.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', description: 'How many customers to list, default 10, max 50.' } } },
    async run(pool, t, input) {
      const { events, open, today } = await loadRiskInputs(pool, t);
      if (!open.length) return { as_of: today, customers_scored: 0, message: 'There are no open customer invoices, so there is no collection risk to score.' };
      return scoreCollectionRisk(events, open, today, clampInt(input?.limit, 10, 1, 50));
    },
  },

  /*spend-optimization*/
  spend_optimization: {
    description: 'Spend review: vendor concentration, vendors whose spend jumped, POSSIBLE duplicate vendor bills (same vendor and amount close in date), paying bills too early or late, and budget overruns, each with the rule that triggered it. Use for "where can we cut costs", "any duplicate bills", "are we overspending", "which vendors are costing more", "spend review". Rule-based; possible duplicates must be checked by a person. It does not estimate negotiation savings.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', description: 'How many findings to list, default 12, max 50.' } } },
    async run(pool, t, input) {
      const { bills, budgets, today } = await loadSpendInputs(pool, t);
      if (!bills.length) return { as_of: today, message: 'There are no vendor bills recorded yet, so there is no spend to review.' };
      return analyzeSpend(bills, budgets, today, clampInt(input?.limit, 12, 1, 50));
    },
  },

  /*propose-actions*/
  propose_actions: {
    description: 'Queues PROPOSED actions for a company admin to approve; it never sends or changes anything itself. kind payment_reminders proposes reminders to customers with overdue invoices (ranked by collection risk, email and/or WhatsApp); board_report proposes the monthly board summary email; compliance_tasks proposes the next statutory due dates (GST, TDS, PF/ESI, advance tax) as compliance items. Use for "remind the customers who owe us", "chase overdue invoices", "send the board report", "schedule compliance tasks". After calling, tell the user the proposals now wait in the Actions page (or can be approved on WhatsApp with OK <code> / NO <code>) and that nothing has been sent yet.',
    input_schema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['payment_reminders', 'board_report', 'compliance_tasks'] },
      channels: { type: 'array', items: { type: 'string', enum: ['email', 'whatsapp'] }, description: 'For payment_reminders. Default email.' },
      min_days_overdue: { type: 'integer', description: 'For payment_reminders: only customers with an invoice at least this many days overdue. Default 7.' },
      limit: { type: 'integer', description: 'For payment_reminders: max customers. Default 10.' },
    }, required: ['kind'] },
    async run(pool, t, input) {
      const by = 'digital-cfo';
      let r: any;
      if (input?.kind === 'payment_reminders') r = await proposeCollectionActions(pool, t, { channels: Array.isArray(input.channels) ? input.channels : undefined, min_days_overdue: input.min_days_overdue, limit: input.limit }, by);
      else if (input?.kind === 'board_report') r = await proposeBoardReport(pool, t, null, by);
      else if (input?.kind === 'compliance_tasks') r = await proposeComplianceTasks(pool, t, by);
      else return { error: 'kind must be payment_reminders, board_report or compliance_tasks' };
      return { kind: input.kind, proposals_created_count: r.proposed.length, proposed: r.proposed, skipped: r.skipped,
        status_note: 'These are PROPOSALS. Nothing has been sent or changed. A company admin must approve each one in the Actions page, or on WhatsApp with OK <code> or NO <code>.' };
    },
  },

  revenue_root_cause: {
    description: 'Explains WHY revenue moved between a period and the comparable prior period: how much came from lost customers, new customers, customers who bought less or more; price versus volume from invoice lines; which business unit, region or product drove it; and whether last year showed the same seasonal move. Use for "why did revenue drop/rise", "what changed in sales". Figures are pre-tax invoiced revenue.',
    input_schema: { type: 'object', properties: {
      period: { type: 'string', enum: ['week_vs_prev_week', 'mtd_vs_prev_mtd', 'month_vs_prev_month', 'last_quarter_vs_prev_quarter', 'ytd_vs_prev_ytd'], description: 'Default month_vs_prev_month (last full month vs the one before).' },
      limit: { type: 'integer', description: 'How many top customers or items to list. Default 5.' },
    } },
    async run(pool, t, input) {
      const period = input?.period || 'month_vs_prev_month';
      const pr = periodRanges(period);
      if (!pr) return { error: 'unknown period' };
      const limit = clampInt(input?.limit, 5, 1, 15);
      const [c0, c1, p0, p1] = [ymd(pr.cur[0]), ymd(pr.cur[1]), ymd(pr.prev[0]), ymd(pr.prev[1])];
      const yb = (s: string) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() - 1); return d.toISOString().slice(0, 10); };
      const byCust = async (a: string, b: string) => rows(pool,
        "SELECT x.customer_id::text AS id, COALESCE(c.name,'Unknown') AS name, SUM(x.subtotal) AS v, COUNT(*) AS n FROM ar_invoices x LEFT JOIN customers c ON c.id=x.customer_id AND c.tenant_id=x.tenant_id WHERE x.tenant_id=$1 AND x.status NOT IN ('draft','cancelled') AND x.date::date BETWEEN $2 AND $3 GROUP BY 1,2", [t, a, b]);
      const total = async (a: string, b: string) => num((await rows(pool, "SELECT COALESCE(SUM(subtotal),0) AS v FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled') AND date::date BETWEEN $2 AND $3", [t, a, b]))[0].v);
      const [cur, prev, lyCur, lyPrev] = await Promise.all([byCust(c0, c1), byCust(p0, p1), total(yb(c0), yb(c1)), total(yb(p0), yb(p1))]);
      const curSum = cur.reduce((s, r) => s + num(r.v), 0), prevSum = prev.reduce((s, r) => s + num(r.v), 0);
      const change = curSum - prevSum;
      const base: Json = { period, current_range: { from: c0, to: c1 }, previous_range: { from: p0, to: p1 },
        current_revenue: round(curSum, 0), previous_revenue: round(prevSum, 0), revenue_change: round(change, 0), change_pct: pct(curSum, prevSum) };
      if (curSum === 0 && prevSum === 0) return { ...base, findings: ['No invoices dated in either period, so there is nothing to explain. Possible causes: not yet invoiced, data not loaded, or a genuine gap.'] };

      // customer attribution: lost + new + decreased + increased = total change exactly
      const pm = new Map(prev.map(r => [r.id, r])); const cm = new Map(cur.map(r => [r.id, r]));
      const ids = new Set<string>([...Array.from(pm.keys()), ...Array.from(cm.keys())]);
      const lost: Json[] = [], added: Json[] = [], down: Json[] = [], up: Json[] = [];
      ids.forEach(id => {
        const a = num(pm.get(id)?.v), b = num(cm.get(id)?.v), name = (cm.get(id) || pm.get(id)).name, d = b - a;
        if (a > 0 && b === 0) lost.push({ customer: name, previous_revenue: round(a, 0), current_revenue: 0, revenue_change: round(d, 0) });
        else if (a === 0 && b > 0) added.push({ customer: name, previous_revenue: 0, current_revenue: round(b, 0), revenue_change: round(d, 0) });
        else if (d < 0) down.push({ customer: name, previous_revenue: round(a, 0), current_revenue: round(b, 0), revenue_change: round(d, 0), change_pct: pct(b, a) });
        else if (d > 0) up.push({ customer: name, previous_revenue: round(a, 0), current_revenue: round(b, 0), revenue_change: round(d, 0), change_pct: pct(b, a) });
      });
      const sum = (l: Json[]) => l.reduce((s, x) => s + x.revenue_change, 0);
      const worst = (l: Json[]) => l.sort((x, y) => x.revenue_change - y.revenue_change).slice(0, limit);
      const best = (l: Json[]) => l.sort((x, y) => y.revenue_change - x.revenue_change).slice(0, limit);
      const customers = {
        lost_customers: { count: lost.length, revenue_change: round(sum(lost), 0), top: worst(lost) },
        new_customers: { count: added.length, revenue_change: round(sum(added), 0), top: best(added) },
        existing_customers_bought_less: { count: down.length, revenue_change: round(sum(down), 0), top: worst(down) },
        existing_customers_bought_more: { count: up.length, revenue_change: round(sum(up), 0), top: best(up) },
      };

      // invoice lines: price vs volume by item description
      let priceVolume: Json = { available: false, reason: 'No invoice lines found for these periods.' };
      try {
        const lines = async (a: string, b: string) => rows(pool,
          "SELECT LOWER(TRIM(l.description)) AS item, MIN(l.description) AS label, SUM(l.quantity) AS q, SUM(l.amount) AS amt FROM ar_invoice_lines l JOIN ar_invoices x ON x.id=l.ar_invoice_id WHERE x.tenant_id=$1 AND x.status NOT IN ('draft','cancelled') AND x.date::date BETWEEN $2 AND $3 GROUP BY 1", [t, a, b]);
        const [lc, lp] = await Promise.all([lines(c0, c1), lines(p0, p1)]);
        const lcSum = lc.reduce((s, r) => s + num(r.amt), 0), lpSum = lp.reduce((s, r) => s + num(r.amt), 0);
        if ((lcSum > 0 || lpSum > 0) && (curSum > 0 || prevSum > 0)) {
          const pmap = new Map(lp.map(r => [r.item, r])), cmap = new Map(lc.map(r => [r.item, r]));
          let priceE = 0, volE = 0, newE = 0, lostE = 0; const movers: Json[] = [];
          new Set<string>([...Array.from(pmap.keys()), ...Array.from(cmap.keys())]).forEach(k => {
            const a = pmap.get(k), b = cmap.get(k), qa = num(a?.q), qb = num(b?.q), aa = num(a?.amt), ab = num(b?.amt);
            if (!a) { newE += ab; movers.push({ item: b.label, effect: 'new item', revenue_change: round(ab, 0) }); return; }
            if (!b) { lostE -= aa; movers.push({ item: a.label, effect: 'item not sold this period', revenue_change: round(-aa, 0) }); return; }
            if (qa > 0 && qb > 0) {
              const pa = aa / qa, pb = ab / qb; const v = (qb - qa) * pa, p = (pb - pa) * qb;
              volE += v; priceE += p; movers.push({ item: b.label, effect: Math.abs(p) > Math.abs(v) ? 'price' : 'volume', revenue_change: round(ab - aa, 0), average_price_change_pct: pct(pb, pa), quantity_change_pct: pct(qb, qa) });
            } else { volE += ab - aa; movers.push({ item: b.label, effect: 'volume', revenue_change: round(ab - aa, 0) }); }
          });
          priceVolume = { available: true, price_effect: round(priceE, 0), volume_effect: round(volE, 0), new_items_effect: round(newE, 0), items_not_sold_effect: round(lostE, 0),
            line_coverage_pct: curSum > 0 ? round((lcSum / curSum) * 100, 0) : null,
            biggest_movers: movers.sort((x, y) => Math.abs(y.revenue_change) - Math.abs(x.revenue_change)).slice(0, limit),
            caveat: 'Items are matched by invoice line description; renamed items show as new/not sold.' };
        }
      } catch { /* lines table missing: leave unavailable */ }

      // business unit / region / product
      const dims: Json = {};
      for (const kind of DIM_KINDS) {
        try {
          const d: any = await METRICS.breakdown_by_dimension.run(pool, t, { dimension: kind, measure: 'revenue', period });
          if (d && !d.error && d.available !== false && Array.isArray(d.items)) {
            const moved = d.items.filter((x: any) => x.name !== 'Untagged').map((x: any) => ({ name: x.name, previous_revenue: x.previous, current_revenue: x.current, revenue_change: round(x.current - x.previous, 0), change_pct: x.change_pct }))
              .sort((x: any, y: any) => x.revenue_change - y.revenue_change);
            dims[kind] = { biggest_decliners: moved.filter((x: any) => x.revenue_change < 0).slice(0, limit), biggest_gainers: moved.filter((x: any) => x.revenue_change > 0).reverse().slice(0, limit), untagged_share_pct: d.untagged_share_pct, warning: d.warning };
          } else dims[kind] = { available: false, reason: d?.reason || 'not set up' };
        } catch { dims[kind] = { available: false, reason: 'not set up' }; }
      }

      // seasonality: did the same two periods move the same way a year earlier?
      const lyPct = pct(lyCur, lyPrev), curPct = pct(curSum, prevSum);
      const seasonality: Json = (lyPrev > 0 && lyCur > 0 && lyPct !== null) ? {
        available: true, same_move_last_year_pct: lyPct, this_year_pct: curPct,
        seasonal_pattern_likely: curPct !== null && Math.sign(lyPct) === Math.sign(curPct) && Math.abs(lyPct) >= Math.abs(curPct) * 0.5,
      } : { available: false, reason: 'Not enough invoices a year earlier to compare.' };

      // plain-language findings (all numbers copied from above; nothing recomputed by the model)
      const findings: string[] = [];
      const cn = (n: number): string => n + (n === 1 ? ' customer' : ' customers');
      if (lost.length) findings.push(cn(lost.length) + (lost.length === 1 ? ' who bought' : ' who bought') + ' in the prior period did not buy this period.');
      if (added.length) findings.push(cn(added.length) + ' new to the period bought this period.');
      if (down.length) findings.push(cn(down.length) + ' who bought in both periods bought less.');
      if (up.length) findings.push(cn(up.length) + ' who bought in both periods bought more.');
      if (priceVolume.available && Math.abs(priceVolume.price_effect) > Math.abs(priceVolume.volume_effect) * 0.5) findings.push('Price changes contributed materially (see price_effect).');
      if (seasonality.available && seasonality.seasonal_pattern_likely) findings.push('The same two periods moved in the same direction last year, so part of this may be seasonal.');
      const dominant = ['lost_customers', 'new_customers', 'existing_customers_bought_less', 'existing_customers_bought_more']
        .map(k => ({ k, v: (customers as any)[k].revenue_change })).filter(x => change < 0 ? x.v < 0 : x.v > 0).sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
      return { ...base, largest_customer_driver: dominant ? dominant.k : null, customers, price_and_volume: priceVolume, by_dimension: dims, seasonality, findings,
        limits: ['Revenue is invoiced pre-tax revenue by invoice date.', 'Credit notes and cancelled invoices are excluded.', 'Competitor or market causes are not in the data.'] };
    },
  },

  cash_position: {
    description: 'Current cash: the balance the user entered manually plus receipts less payments recorded since. No bank data is held.',
    input_schema: { type: 'object', properties: { low_threshold: { type: 'number', description: 'Flag accounts below this INR balance. Default: 25% of the mean account balance.' } } },
    async run(pool, t, input) {
      const c = await cashAsOf(pool, t);
      return {
        total_cash: c.amount, cash_entered: c.has_entry, balance_entered_on: c.entry_date, balance_entered: c.entry_amount,
        receipts_less_payments_since: c.movement, note: c.has_entry ? undefined : 'No cash balance has been entered yet. Ask the user to add it on the Cash Balance page; cash is shown as 0 until then.',
        as_of: new Date().toISOString(),
      };
    },
  },

  cash_runway: {
    description: 'Cash runway based on actual bank inflows/outflows over the last 90 days (gross and net burn). Falls back to payroll if there are no transactions.',
    input_schema: { type: 'object', properties: {} },
    async run(pool, t) {
      const [bank, tx, payroll] = await Promise.all([
        cashAsOf(pool, t).then(c => [{ v: c.amount }]),
        rows(pool, `SELECT CASE WHEN invoice_type='ar' THEN 'credit' ELSE 'debit' END AS type, COALESCE(SUM(amount),0) AS total FROM invoice_payment_events WHERE tenant_id=$1 AND payment_date >= CURRENT_DATE - 90 GROUP BY 1`, [t]),
        rows(pool, `SELECT total_gross FROM payroll_runs WHERE tenant_id=$1 ORDER BY year DESC, month DESC LIMIT 1`, [t]),
      ]);
      const cash = num(bank[0].v);
      const out = num(tx.find(r => r.type === 'debit')?.total) / 3;
      const inn = num(tx.find(r => r.type === 'credit')?.total) / 3;
      const payrollMonthly = num(payroll[0]?.total_gross);
      const grossOut = out > 0 ? out : payrollMonthly;
      const netBurn = grossOut - inn;
      return {
        cash, avg_monthly_outflow: round(grossOut, 0), avg_monthly_inflow: round(inn, 0), net_monthly_burn: round(netBurn, 0),
        runway_days_gross: grossOut > 0 ? Math.round((cash / grossOut) * 30) : null,
        runway_days_net: netBurn > 0 ? Math.round((cash / netBurn) * 30) : null,
        cash_flow_positive: netBurn <= 0,
        basis: out > 0 ? 'recorded receipts and payments, last 90 days' : 'latest payroll run only (no receipts or payments recorded)',
      };
    },
  },

  payments_due: {
    description: 'Vendor payables (AP) due within the next N days, including already-overdue ones, grouped by vendor with the largest invoices.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'Look-ahead window in days. Default 7.' } } },
    async run(pool, t, input) {
      const days = clampInt(input?.days, 7, 1, 90);
      const list = await rows(pool, `
        SELECT v.name AS vendor, ap.due_date::date::text AS due_date, ap.balance_due, ap.status,
               to_jsonb(ap)->>'invoice_number' AS invoice_number,
               (ap.due_date::date < CURRENT_DATE) AS overdue
        FROM ap_invoices ap LEFT JOIN vendors v ON v.id = ap.vendor_id
        WHERE ap.tenant_id=$1 AND ap.status NOT IN ('paid','rejected','draft') AND ap.balance_due > 0
          AND ap.due_date::date <= CURRENT_DATE + $2::int
        ORDER BY ap.due_date ASC, ap.balance_due DESC LIMIT 200`, [t, days]);
      const total = list.reduce((s, r) => s + num(r.balance_due), 0);
      const overdue = list.filter(r => r.overdue).reduce((s, r) => s + num(r.balance_due), 0);
      return {
        window_days: days, invoice_count: list.length, total_due: total, of_which_already_overdue: overdue,
        largest: list.slice().sort((a, b) => num(b.balance_due) - num(a.balance_due)).slice(0, 10)
          .map(r => ({ vendor: r.vendor, invoice: r.invoice_number, due_date: r.due_date, amount: num(r.balance_due), overdue: r.overdue })),
      };
    },
  },

  cash_shortage_projection: {
    description: 'Projects the day-by-day cash balance for the next N days using AP due dates (100%) and AR due dates (weighted by an assumed collection rate). Flags the first day the balance goes negative or below one month of outflows.',
    input_schema: { type: 'object', properties: {
      days: { type: 'integer', description: 'Default 30, max 90.' },
      ar_collection_rate: { type: 'number', description: 'Share of AR due that is collected on its due date, 0-1. Default 0.7.' },
    } },
    async run(pool, t, input) {
      const days = clampInt(input?.days, 30, 1, 90);
      const rate = Math.min(1, Math.max(0, input?.ar_collection_rate !== undefined ? num(input.ar_collection_rate) : 0.7));
      const [bank, ap, ar, tx] = await Promise.all([
        cashAsOf(pool, t).then(c => [{ v: c.amount }]),
        rows(pool, `SELECT GREATEST(due_date::date, CURRENT_DATE) AS d, SUM(balance_due) AS amt FROM ap_invoices
                    WHERE tenant_id=$1 AND status NOT IN ('paid','rejected','draft') AND due_date::date <= CURRENT_DATE + $2::int GROUP BY 1`, [t, days]),
        rows(pool, `SELECT GREATEST(due_date::date, CURRENT_DATE) AS d, SUM(balance_due) AS amt FROM ar_invoices
                    WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled','draft') AND due_date::date <= CURRENT_DATE + $2::int GROUP BY 1`, [t, days]),
        rows(pool, `SELECT COALESCE(SUM(amount),0) AS v FROM invoice_payment_events WHERE tenant_id=$1 AND invoice_type='ap' AND payment_date >= CURRENT_DATE - 90`, [t]),
      ]);
      const key = (d: any) => ymd(new Date(d));
      const apBy: Record<string, number> = {}; ap.forEach(r => { apBy[key(r.d)] = num(r.amt); });
      const arBy: Record<string, number> = {}; ar.forEach(r => { arBy[key(r.d)] = num(r.amt) * rate; });
      const monthlyOut = num(tx[0].v) / 3;
      let bal = num(bank[0].v);
      const start = istNow();
      let firstNegative: string | null = null, firstBelowBuffer: string | null = null, lowest = { date: ymd(start), balance: bal };
      const series: Json[] = [];
      for (let i = 0; i <= days; i++) {
        const k = ymd(addDays(start, i));
        bal += (arBy[k] || 0) - (apBy[k] || 0);
        if (bal < lowest.balance) lowest = { date: k, balance: bal };
        if (bal < 0 && !firstNegative) firstNegative = k;
        if (bal < monthlyOut && !firstBelowBuffer) firstBelowBuffer = k;
        if (i % 7 === 0 || (arBy[k] || apBy[k])) series.push({ date: k, balance: round(bal, 0) });
      }
      return {
        horizon_days: days, assumptions: { ar_collection_rate: rate, ap_paid_on_due_date: true, excludes: 'payroll, tax and run-rate spend not yet invoiced' },
        opening_cash: num(bank[0].v), closing_cash: round(bal, 0), lowest_point: { ...lowest, balance: round(lowest.balance, 0) },
        first_negative_date: firstNegative, first_date_below_one_month_outflow: firstBelowBuffer,
        one_month_outflow_buffer: round(monthlyOut, 0), series: series.slice(0, 40),
      };
    },
  },

  ar_aging: {
    description: 'Receivables aging buckets (not yet due, 1-30, 31-60, 61-90, 90+ days past due) plus invoices that crossed the 30/60/90-day thresholds recently.',
    input_schema: { type: 'object', properties: { crossed_within_days: { type: 'integer', description: 'Report invoices that crossed 30/60/90 days past due within the last N days. Default 1 (i.e. today).' } } },
    async run(pool, t, input) {
      const n = clampInt(input?.crossed_within_days, 1, 1, 30);
      const buckets = await rows(pool, `
        SELECT CASE WHEN due_date IS NULL OR due_date::date >= CURRENT_DATE THEN 'not_due'
                    WHEN CURRENT_DATE - due_date::date <= 30 THEN '1-30'
                    WHEN CURRENT_DATE - due_date::date <= 60 THEN '31-60'
                    WHEN CURRENT_DATE - due_date::date <= 90 THEN '61-90' ELSE '90+' END AS bucket,
               COUNT(*) AS invoices, COALESCE(SUM(balance_due),0) AS amount
        FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled','draft') AND balance_due > 0 GROUP BY 1`, [t]);
      const crossed = await rows(pool, `
        SELECT c.name AS customer, ar.balance_due, ar.due_date::date::text AS due_date, to_jsonb(ar)->>'invoice_number' AS invoice_number,
               (CURRENT_DATE - ar.due_date::date) AS days_past_due,
               CASE WHEN CURRENT_DATE - ar.due_date::date > 90 AND CURRENT_DATE - ar.due_date::date <= 90 + $2::int THEN 90
                    WHEN CURRENT_DATE - ar.due_date::date > 60 AND CURRENT_DATE - ar.due_date::date <= 60 + $2::int THEN 60
                    WHEN CURRENT_DATE - ar.due_date::date > 30 AND CURRENT_DATE - ar.due_date::date <= 30 + $2::int THEN 30 END AS threshold_crossed
        FROM ar_invoices ar LEFT JOIN customers c ON c.id = ar.customer_id
        WHERE ar.tenant_id=$1 AND ar.status NOT IN ('paid','cancelled','draft') AND ar.balance_due > 0 AND ar.due_date IS NOT NULL
        ORDER BY ar.balance_due DESC`, [t, n]);
      const order = ['not_due', '1-30', '31-60', '61-90', '90+'];
      const total = buckets.reduce((s, b) => s + num(b.amount), 0);
      return {
        total_outstanding: total,
        buckets: order.map(k => { const b = buckets.find(x => x.bucket === k); return { bucket: k, invoices: b ? parseInt(b.invoices) : 0, amount: b ? num(b.amount) : 0, share_pct: total > 0 && b ? round((num(b.amount) / total) * 100, 1) : 0 }; }),
        crossed_thresholds: crossed.filter(r => r.threshold_crossed).slice(0, 25)
          .map(r => ({ customer: r.customer, invoice: r.invoice_number, amount: num(r.balance_due), days_past_due: r.days_past_due, threshold: r.threshold_crossed })),
        crossed_window_days: n,
      };
    },
  },

  overdue_customers: {
    description: 'Customers with overdue receivables ranked by amount, with days overdue; also customers whose invoices became overdue yesterday/today (newly overdue) and an escalation flag (>60 days or >10% of total AR).',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', description: 'Default 10.' }, min_days_overdue: { type: 'integer', description: 'Default 1.' } } },
    async run(pool, t, input) {
      const limit = clampInt(input?.limit, 10, 1, 50), minDays = clampInt(input?.min_days_overdue, 1, 1, 3650);
      const [list, fresh, total] = await Promise.all([
        rows(pool, `SELECT c.name AS customer, COUNT(*) AS invoices, SUM(ar.balance_due) AS overdue_amount,
                           MAX(CURRENT_DATE - ar.due_date::date) AS max_days_overdue
                    FROM ar_invoices ar LEFT JOIN customers c ON c.id = ar.customer_id
                    WHERE ar.tenant_id=$1 AND ar.status NOT IN ('paid','cancelled','draft') AND ar.balance_due > 0
                      AND CURRENT_DATE - ar.due_date::date >= $2::int
                    GROUP BY c.name ORDER BY SUM(ar.balance_due) DESC LIMIT $3`, [t, minDays, limit]),
        rows(pool, `SELECT c.name AS customer, ar.balance_due, to_jsonb(ar)->>'invoice_number' AS invoice_number
                    FROM ar_invoices ar LEFT JOIN customers c ON c.id = ar.customer_id
                    WHERE ar.tenant_id=$1 AND ar.status NOT IN ('paid','cancelled','draft') AND ar.balance_due > 0
                      AND ar.due_date::date = CURRENT_DATE - 1 ORDER BY ar.balance_due DESC LIMIT 25`, [t]),
        rows(pool, `SELECT COALESCE(SUM(balance_due),0) AS v FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled','draft')`, [t]),
      ]);
      const totalAr = num(total[0].v);
      const customers = list.map(r => ({
        customer: r.customer, invoices: parseInt(r.invoices), overdue_amount: num(r.overdue_amount), max_days_overdue: r.max_days_overdue,
        escalate: r.max_days_overdue > 60 || (totalAr > 0 && num(r.overdue_amount) / totalAr > 0.1),
      }));
      const escalate = customers.filter(c => c.escalate);
      return {
        total_ar_outstanding: totalAr,
        customers_listed: customers.length, escalation_count: escalate.length, escalate_customers: escalate.map(c => c.customer),
        escalation_exposure_total: escalate.reduce((s, c) => s + c.overdue_amount, 0),
        monitor_count: customers.length - escalate.length, monitor_customers: customers.filter(c => !c.escalate).map(c => c.customer),
        monitor_exposure_total: customers.filter(c => !c.escalate).reduce((s, c) => s + c.overdue_amount, 0),
        customers,
        newly_overdue_today: fresh.map(r => ({ customer: r.customer, invoice: r.invoice_number, amount: num(r.balance_due) })),
        escalation_rule: 'flagged if any invoice is >60 days overdue or the customer owes >10% of total AR',
      };
    },
  },

  expected_collections: {
    description: 'Receivables falling due in the next N days (expected collections), plus the overdue backlog still to be recovered.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'Default 7.' } } },
    async run(pool, t, input) {
      const days = clampInt(input?.days, 7, 1, 90);
      const r = await rows(pool, `
        SELECT COALESCE(SUM(balance_due) FILTER (WHERE due_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + $2::int),0) AS due_in_window,
               COUNT(*) FILTER (WHERE due_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + $2::int) AS invoices_in_window,
               COALESCE(SUM(balance_due) FILTER (WHERE due_date::date < CURRENT_DATE),0) AS overdue_backlog
        FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled','draft') AND balance_due > 0`, [t, days]);
      const top = await rows(pool, `
        SELECT c.name AS customer, SUM(ar.balance_due) AS amt FROM ar_invoices ar LEFT JOIN customers c ON c.id = ar.customer_id
        WHERE ar.tenant_id=$1 AND ar.status NOT IN ('paid','cancelled','draft') AND ar.balance_due > 0
          AND ar.due_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + $2::int GROUP BY c.name ORDER BY 2 DESC LIMIT 10`, [t, days]);
      return {
        window_days: days, due_in_window: num(r[0].due_in_window), invoices_in_window: parseInt(r[0].invoices_in_window),
        overdue_backlog: num(r[0].overdue_backlog), top_customers_due: top.map(x => ({ customer: x.customer, amount: num(x.amt) })),
        note: 'amounts are invoices DUE in the window, not predicted receipts; use cash_shortage_projection for a collection-rate-weighted view',
      };
    },
  },

  collection_efficiency: {
    description: 'Collection efficiency for invoices raised in the last N days: share of billed value already collected, plus the share currently overdue.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'Default 90.' } } },
    async run(pool, t, input) {
      const days = clampInt(input?.days, 90, 7, 365);
      const r = await rows(pool, `
        SELECT COALESCE(SUM(total_amount),0) AS billed, COALESCE(SUM(paid_amount),0) AS collected,
               COALESCE(SUM(balance_due) FILTER (WHERE due_date::date < CURRENT_DATE),0) AS overdue
        FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled') AND date::date >= CURRENT_DATE - $2::int`, [t, days]);
      const billed = num(r[0].billed), collected = num(r[0].collected), overdue = num(r[0].overdue);
      return {
        window_days: days, billed, collected, overdue,
        collection_efficiency_pct: billed > 0 ? round((collected / billed) * 100, 1) : null,
        overdue_pct_of_billed: billed > 0 ? round((overdue / billed) * 100, 1) : null,
        definition: 'collected ÷ billed for invoices dated in the window (simplified CEI)',
      };
    },
  },

  working_capital: {
    description: 'Working capital, current ratio, DSO, DPO and inventory value — with DSO/DPO computed from the last 90 days of invoicing.',
    input_schema: { type: 'object', properties: {} },
    async run(pool, t) {
      const c = await coreNumbers(pool, t);
      const current = c.cash + c.arOut + c.inventory;
      return {
        cash: c.cash, receivables: c.arOut, payables: c.apOut, inventory: c.inventory,
        working_capital: round(current - c.apOut, 0),
        current_ratio: c.apOut > 0 ? round(current / c.apOut, 2) : null,
        quick_ratio: c.apOut > 0 ? round((c.cash + c.arOut) / c.apOut, 2) : null,
        dso_days: c.dso, dpo_days: c.dpo,
        ar_overdue: c.arOverdue, ap_overdue: c.apOverdue,
        definitions: 'DSO = AR outstanding ÷ credit sales (90d) × 90; DPO = AP outstanding ÷ purchases (90d) × 90',
      };
    },
  },

  period_comparison: {
    description: 'Compares a measure between the current period and the prior comparable period (e.g. today vs same weekday last week, MTD vs prior MTD, last quarter vs the one before, FY-to-date vs last FY-to-date). Indian fiscal year (Apr-Mar).',
    input_schema: { type: 'object', properties: {
      measure: { type: 'string', enum: ['revenue', 'cash_in', 'cash_out', 'ap_invoiced'], description: 'revenue = AR invoices (pre-tax); cash_in/cash_out = bank credits/debits; ap_invoiced = vendor invoices' },
      period: { type: 'string', enum: ['today_vs_last_week', 'week_vs_prev_week', 'mtd_vs_prev_mtd', 'month_vs_prev_month', 'last_quarter_vs_prev_quarter', 'ytd_vs_prev_ytd'] },
    }, required: ['measure', 'period'] },
    async run(pool, t, input) {
      const pr = periodRanges(input?.period);
      if (!pr) return { error: 'unknown period' };
      const { cur, prev } = pr;
      const sqlByMeasure: Record<string, string> = {
        revenue: `SELECT COALESCE(SUM(subtotal),0) AS v, COUNT(*) AS n FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled') AND date::date BETWEEN $2 AND $3`,
        cash_in: `SELECT COALESCE(SUM(amount),0) AS v, COUNT(*) AS n FROM invoice_payment_events WHERE tenant_id=$1 AND invoice_type='ar' AND payment_date BETWEEN $2 AND $3`,
        cash_out: `SELECT COALESCE(SUM(amount),0) AS v, COUNT(*) AS n FROM invoice_payment_events WHERE tenant_id=$1 AND invoice_type='ap' AND payment_date BETWEEN $2 AND $3`,
        ap_invoiced: `SELECT COALESCE(SUM(subtotal),0) AS v, COUNT(*) AS n FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','rejected') AND date::date BETWEEN $2 AND $3`,
      };
      const sql = sqlByMeasure[input?.measure];
      if (!sql) return { error: 'unknown measure' };
      const [a, b] = await Promise.all([
        rows(pool, sql, [t, ymd(cur[0]), ymd(cur[1])]),
        rows(pool, sql, [t, ymd(prev[0]), ymd(prev[1])]),
      ]);
      const cv = num(a[0].v), pv = num(b[0].v);
      return {
        measure: input.measure, period: input.period,
        current: { from: ymd(cur[0]), to: ymd(cur[1]), value: cv, records: parseInt(a[0].n) },
        previous: { from: ymd(prev[0]), to: ymd(prev[1]), value: pv, records: parseInt(b[0].n) },
        change: round(cv - pv, 0), change_pct: pct(cv, pv),
      };
    },
  },

  cash_movement: {
    description: 'Net cash movement between two dates with the largest inflows, largest outflows and net by category (for weekly/monthly cash reviews).',
    input_schema: { type: 'object', properties: {
      from: { type: 'string', description: 'YYYY-MM-DD. Default: 7 days ago.' }, to: { type: 'string', description: 'YYYY-MM-DD. Default: today.' },
      limit: { type: 'integer', description: 'Top-N size, default 5.' } } },
    async run(pool, t, input) {
      const today = istNow();
      const from = isDate(input?.from) ? input.from : ymd(addDays(today, -7));
      const to = isDate(input?.to) ? input.to : ymd(today);
      const limit = clampInt(input?.limit, 5, 1, 20);
      const [tot, inflows, outflows, cats] = await Promise.all([
        rows(pool, `SELECT type, COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM bank_transactions WHERE tenant_id=$1 AND date::date BETWEEN $2 AND $3 GROUP BY type`, [t, from, to]),
        rows(pool, `SELECT date::date::text AS date, description, category, amount FROM invoice_payment_events WHERE tenant_id=$1 AND invoice_type='ar' AND payment_date BETWEEN $2 AND $3 ORDER BY amount DESC LIMIT $4`, [t, from, to, limit]),
        rows(pool, `SELECT date::date::text AS date, description, category, amount FROM invoice_payment_events WHERE tenant_id=$1 AND invoice_type='ap' AND payment_date BETWEEN $2 AND $3 ORDER BY amount DESC LIMIT $4`, [t, from, to, limit]),
        rows(pool, `SELECT COALESCE(category,'uncategorised') AS category,
                           SUM(CASE WHEN type='credit' THEN amount ELSE -amount END) AS net
                    FROM bank_transactions WHERE tenant_id=$1 AND date::date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY ABS(SUM(CASE WHEN type='credit' THEN amount ELSE -amount END)) DESC LIMIT 10`, [t, from, to]),
      ]);
      const cin = num(tot.find(r => r.type === 'credit')?.total), cout = num(tot.find(r => r.type === 'debit')?.total);
      const mapTx = (r: any) => ({ date: r.date, description: r.description, category: r.category, amount: num(r.amount) });
      return {
        from, to, total_inflow: cin, total_outflow: cout, net_movement: round(cin - cout, 0),
        top_inflows: inflows.map(mapTx), top_outflows: outflows.map(mapTx),
        net_by_category: cats.map(r => ({ category: r.category, net: num(r.net) })),
        caveat: 'Business-unit attribution is not available (no business-unit tag on transactions).',
      };
    },
  },

  top_cost_drivers: {
    description: 'Biggest cost drivers over the last N days: spend by bank category and by vendor (AP invoices), with growth vs the previous equal period and the fastest-growing category.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'Default 30.' }, limit: { type: 'integer', description: 'Default 10.' } } },
    async run(pool, t, input) {
      const days = clampInt(input?.days, 30, 7, 180), limit = clampInt(input?.limit, 10, 1, 25);
      const [cats, vendors] = await Promise.all([
        rows(pool, `SELECT COALESCE(category,'uncategorised') AS category,
                           COALESCE(SUM(amount) FILTER (WHERE date::date > CURRENT_DATE - $2::int),0) AS cur,
                           COALESCE(SUM(amount) FILTER (WHERE date::date <= CURRENT_DATE - $2::int AND date::date > CURRENT_DATE - 2*$2::int),0) AS prev
                    FROM bank_transactions WHERE tenant_id=$1 AND type='debit' AND date::date > CURRENT_DATE - 2*$2::int GROUP BY 1`, [t, days]),
        rows(pool, `SELECT v.name AS vendor, SUM(ap.subtotal) AS spend, COUNT(*) AS invoices
                    FROM ap_invoices ap LEFT JOIN vendors v ON v.id = ap.vendor_id
                    WHERE ap.tenant_id=$1 AND ap.status NOT IN ('draft','rejected') AND ap.date::date > CURRENT_DATE - $2::int
                    GROUP BY v.name ORDER BY SUM(ap.subtotal) DESC LIMIT $3`, [t, days, limit]),
      ]);
      const byCat = cats.map(r => ({ category: r.category, current: num(r.cur), previous: num(r.prev), growth_pct: pct(num(r.cur), num(r.prev)), increase: num(r.cur) - num(r.prev) }));
      const growing = byCat.filter(c => c.previous > 0).sort((a, b) => (b.growth_pct ?? -1e9) - (a.growth_pct ?? -1e9));
      return {
        window_days: days,
        top_categories: byCat.slice().sort((a, b) => b.current - a.current).slice(0, limit),
        fastest_growing_category: growing[0] || null,
        biggest_absolute_increase: byCat.slice().sort((a, b) => b.increase - a.increase)[0] || null,
        top_vendors: vendors.map(r => ({ vendor: r.vendor, spend: num(r.spend), invoices: parseInt(r.invoices) })),
      };
    },
  },

  unusual_expenses: {
    description: 'Outgoing bank transactions in the last N days that are statistical outliers for their category (more than 3 standard deviations above that category\'s 180-day mean).',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'Default 7.' } } },
    async run(pool, t, input) {
      const days = clampInt(input?.days, 7, 1, 90);
      const list = await rows(pool, `
        WITH stats AS (
          SELECT COALESCE(category,'uncategorised') AS cat, AVG(amount) AS m, STDDEV_SAMP(amount) AS s, COUNT(*) AS n
          FROM bank_transactions WHERE tenant_id=$1 AND type='debit' AND date::date >= CURRENT_DATE - 180 GROUP BY 1)
        SELECT bt.date::date::text AS date, bt.description, st.cat AS category, bt.amount, st.m AS category_avg, st.s AS category_std, st.n
        FROM bank_transactions bt JOIN stats st ON st.cat = COALESCE(bt.category,'uncategorised')
        WHERE bt.tenant_id=$1 AND bt.type='debit' AND bt.date::date > CURRENT_DATE - $2::int
          AND st.n >= 5 AND st.s > 0 AND bt.amount > st.m + 3*st.s
        ORDER BY bt.amount DESC LIMIT 20`, [t, days]);
      return {
        window_days: days, rule: 'amount > category mean + 3σ over 180 days, categories with ≥5 transactions',
        count: list.length,
        items: list.map(r => ({ date: r.date, description: r.description, category: r.category, amount: num(r.amount), category_avg: round(num(r.category_avg), 0), times_average: round(num(r.amount) / num(r.category_avg), 1) })),
      };
    },
  },

  pnl_trend: {
    description: 'Monthly profit-and-loss trend (revenue, vendor costs, payroll, expense claims, gross profit, EBITDA, margins, month-on-month change) for the last N months, plus whether payroll has been growing faster than revenue. Invoice-based, not general-ledger based; tax is not computed.',
    input_schema: { type: 'object', properties: { months: { type: 'integer', description: 'Default 6, max 24.' } } },
    async run(pool, t, input) {
      const n = clampInt(input?.months, 6, 2, 24);
      const r = await rows(pool, `
        WITH months AS (SELECT (date_trunc('month', CURRENT_DATE) - make_interval(months => g))::date AS m FROM generate_series(0, $2::int - 1) g)
        SELECT to_char(m,'YYYY-MM') AS ym, EXTRACT(YEAR FROM m)::int AS y, EXTRACT(MONTH FROM m)::int AS mo,
          (SELECT COALESCE(SUM(subtotal),0) FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled') AND date::date >= m AND date::date < m + interval '1 month') AS revenue,
          (SELECT COALESCE(SUM(subtotal),0) FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','rejected') AND date::date >= m AND date::date < m + interval '1 month') AS vendor_costs,
          (SELECT COALESCE(SUM(total_gross),0) FROM payroll_runs WHERE tenant_id=$1 AND year = EXTRACT(YEAR FROM m)::int AND month = EXTRACT(MONTH FROM m)::int) AS payroll,
          (SELECT COALESCE(SUM(total_amount),0) FROM expense_claims WHERE tenant_id=$1 AND status='approved' AND date::date >= m AND date::date < m + interval '1 month') AS claims
        FROM months ORDER BY m ASC`, [t, n]);
      const series = r.map((x, i) => {
        const revenue = num(x.revenue), vendor = num(x.vendor_costs), payroll = num(x.payroll), claims = num(x.claims);
        const gp = revenue - vendor, ebitda = gp - payroll - claims;
        return { month: x.ym, revenue, vendor_costs: vendor, payroll, expense_claims: claims, gross_profit: gp, ebitda,
          gross_margin_pct: revenue > 0 ? round((gp / revenue) * 100, 1) : null, ebitda_margin_pct: revenue > 0 ? round((ebitda / revenue) * 100, 1) : null,
          partial_month: i === r.length - 1 };
      });
      const withGrowth = series.map((s, i) => ({ ...s,
        revenue_mom_pct: i > 0 ? pct(s.revenue, series[i - 1].revenue) : null,
        payroll_mom_pct: i > 0 ? pct(s.payroll, series[i - 1].payroll) : null }));
      let streak = 0;   // consecutive completed months where payroll growth > revenue growth
      for (let i = withGrowth.length - 2; i >= 1; i--) {
        const g = withGrowth[i];
        if (g.payroll_mom_pct !== null && g.revenue_mom_pct !== null && g.payroll_mom_pct > g.revenue_mom_pct) streak++; else break;
      }
      return {
        basis: 'AR invoices (pre-tax) minus AP invoices, payroll runs and approved expense claims. Not a GL-based P&L; net profit/tax intentionally omitted.',
        months: withGrowth, payroll_outgrowing_revenue_consecutive_months: streak,
        note: 'the latest month is partial (month-to-date)',
      };
    },
  },

  budget_vs_actual: {
    description: 'Budget utilisation by budget/department using budgets.total_budgeted vs total_spent, flagging overruns. Expense-side only: revenue budgets/targets are not stored.',
    input_schema: { type: 'object', properties: {} },
    async run(pool, t) {
      const list = await rows(pool, `SELECT name, department, fiscal_year, status, total_budgeted, total_spent FROM budgets WHERE tenant_id=$1 ORDER BY fiscal_year DESC, department`, [t]);
      return {
        budgets: list.map(b => { const bud = num(b.total_budgeted), sp = num(b.total_spent);
          return { name: b.name, department: b.department, fiscal_year: b.fiscal_year, status: b.status, budgeted: bud, spent: sp, utilisation_pct: bud > 0 ? round((sp / bud) * 100, 1) : null, over_budget: sp > bud && bud > 0 }; }),
        over_budget_count: list.filter(b => num(b.total_spent) > num(b.total_budgeted) && num(b.total_budgeted) > 0).length,
        caveat: 'total_spent must be kept up to date by the budgeting module; revenue budgets are not available.',
      };
    },
  },

  customer_analysis: {
    description: 'Customer revenue ranking, concentration (top-1/top-5 share) and a churn-risk heuristic (customers with ≥3 invoices whose time since last invoice exceeds twice their usual gap).',
    input_schema: { type: 'object', properties: { months: { type: 'integer', description: 'Look-back, default 12.' }, limit: { type: 'integer', description: 'Default 10.' } } },
    async run(pool, t, input) {
      const months = clampInt(input?.months, 12, 1, 36), limit = clampInt(input?.limit, 10, 1, 50);
      const r = await rows(pool, `
        SELECT c.name AS customer, COUNT(*) AS invoices, SUM(ar.subtotal) AS revenue,
               (MAX(ar.date::date) - MIN(ar.date::date)) AS span_days, (CURRENT_DATE - MAX(ar.date::date)) AS days_since_last
        FROM ar_invoices ar LEFT JOIN customers c ON c.id = ar.customer_id
        WHERE ar.tenant_id=$1 AND ar.status NOT IN ('draft','cancelled') AND ar.date::date >= CURRENT_DATE - make_interval(months => $2::int)
        GROUP BY c.name ORDER BY SUM(ar.subtotal) DESC`, [t, months]);
      const total = r.reduce((s, x) => s + num(x.revenue), 0);
      const share = (k: number) => total > 0 ? round((r.slice(0, k).reduce((s, x) => s + num(x.revenue), 0) / total) * 100, 1) : 0;
      const atRisk = r.filter(x => parseInt(x.invoices) >= 3 && x.span_days > 0 && x.days_since_last > 2 * (x.span_days / (parseInt(x.invoices) - 1)))
        .map(x => ({ customer: x.customer, days_since_last_invoice: x.days_since_last, usual_gap_days: Math.round(x.span_days / (parseInt(x.invoices) - 1)), revenue: num(x.revenue) })).slice(0, 15);
      return {
        window_months: months, total_revenue: total, customer_count: r.length,
        top_customers: r.slice(0, limit).map(x => ({ customer: x.customer, revenue: num(x.revenue), share_pct: total > 0 ? round((num(x.revenue) / total) * 100, 1) : 0, invoices: parseInt(x.invoices) })),
        concentration: { top1_pct: share(1), top5_pct: share(5), top10_pct: share(10), high_risk: share(1) > 30 || share(5) > 70 },
        churn_risk_candidates: atRisk,
        caveat: 'Customer PROFIT is not available — costs are not attributed to customers.',
      };
    },
  },

  compliance_alerts: {
    description: 'Overdue compliance items and tax filings due or overdue in the next 14 days.',
    input_schema: { type: 'object', properties: {} },
    async run(pool, t) {
      const [items, filings] = await Promise.all([
        rows(pool, `SELECT to_jsonb(c) AS r FROM compliance_items c WHERE tenant_id=$1 AND status='pending' AND due_date::date < CURRENT_DATE ORDER BY due_date ASC LIMIT 20`, [t]).catch(() => []),
        rows(pool, `SELECT filing_type, period_month, period_year, status, tax_liability, due_date::date::text AS due_date FROM tax_filings
                    WHERE tenant_id=$1 AND status NOT IN ('filed','completed','paid') AND due_date::date <= CURRENT_DATE + 14 ORDER BY due_date ASC LIMIT 20`, [t]).catch(() => []),
      ]);
      return {
        overdue_compliance_items: items.length, items: items.map(x => x.r),
        filings_due_or_overdue_14d: filings.map(f => ({ type: f.filing_type, period: `${f.period_month}/${f.period_year}`, status: f.status, liability: num(f.tax_liability), due_date: f.due_date, overdue: new Date(f.due_date) < new Date() })),
      };
    },
  },

  risk_signals: {
    description: 'Open AI anomaly alerts from the last 14 days, grouped by severity. (Fraud-rule results are not exposed yet.)',
    input_schema: { type: 'object', properties: {} },
    async run(pool, t) {
      const list = await rows(pool, `SELECT category, metric, severity, description, status, detected_at FROM anomaly_alerts
                                     WHERE tenant_id=$1 AND detected_at > NOW() - INTERVAL '14 days' AND COALESCE(status,'open') <> 'resolved'
                                     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, detected_at DESC LIMIT 20`, [t]).catch(() => []);
      const bySeverity: Record<string, number> = {}; list.forEach(a => { bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1; });
      return { open_alerts: list.length, by_severity: bySeverity, alerts: list.map(a => ({ category: a.category, metric: a.metric, severity: a.severity, description: a.description, detected_at: a.detected_at })),
        caveat: 'Anomaly alerts are generated by an AI scan of aggregate totals, not by transaction-level statistics (see unusual_expenses for that).' };
    },
  },

  integration_health: {
    description: 'Recent data-load / integration activity from poller and ingest logs, highlighting failures in the last N days.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'Default 1.' } } },
    async run(pool, t, input) {
      const days = clampInt(input?.days, 1, 1, 30);
      const read = async (table: string) => {
        try {
          const r = await rows(pool, `SELECT to_jsonb(l) AS r FROM ${table} l WHERE tenant_id=$1 AND created_at > NOW() - make_interval(days => $2::int) ORDER BY created_at DESC LIMIT 50`, [t, days]);
          const items = r.map(x => x.r);
          const failed = items.filter((x: any) => /fail|error/i.test(String(x.status ?? '')) || x.success === false || (x.error ?? x.error_message));
          return { available: true, runs: items.length, failures: failed.length, latest_failures: failed.slice(0, 5) };
        } catch (e: any) { return { available: false, reason: String(e.message || e) }; }
      };
      const [poller, ingest] = await Promise.all([read('poller_logs'), read('ingest_logs')]);
      return { window_days: days, poller, ingest };
    },
  },

  metric_history: {
    description: 'History of key daily snapshots (cash, AR, overdue AR, AP, DSO, DPO, inventory) with change vs 7 and 30 days ago. History only exists from when daily snapshots started being recorded.',
    input_schema: { type: 'object', properties: {
      metric: { type: 'string', enum: ['cash', 'ar_outstanding', 'ar_overdue', 'ap_outstanding', 'dso', 'dpo', 'inventory'] },
      days: { type: 'integer', description: 'Default 30, max 365.' } }, required: ['metric'] },
    async run(pool, t, input) {
      const days = clampInt(input?.days, 30, 2, 365);
      const metric = input?.metric;
      if (!['cash', 'ar_outstanding', 'ar_overdue', 'ap_outstanding', 'dso', 'dpo', 'inventory'].includes(metric)) return { error: 'unknown metric' };
      await ensureSnapshotTable(pool);
      const r = await rows(pool, `SELECT snapshot_date::text AS d, (metrics->>$3)::numeric AS v FROM cfo_daily_snapshots
                                  WHERE tenant_id=$1 AND snapshot_date >= CURRENT_DATE - $2::int ORDER BY snapshot_date ASC`, [t, days, metric]);
      if (r.length < 2) return { available: false, metric, reason: `Only ${r.length} daily snapshot(s) recorded so far; trends need at least 2 days of history.`, snapshots: r.map(x => ({ date: x.d, value: num(x.v) })) };
      const last = r[r.length - 1]; const at = (n: number) => { const target = new Date(last.d); target.setUTCDate(target.getUTCDate() - n); const f = r.filter(x => new Date(x.d) <= target); return f.length ? f[f.length - 1] : null; };
      const d7 = at(7), d30 = at(30);
      return {
        metric, latest: { date: last.d, value: num(last.v) },
        vs_7_days_ago: d7 ? { date: d7.d, value: num(d7.v), change_pct: pct(num(last.v), num(d7.v)) } : null,
        vs_30_days_ago: d30 ? { date: d30.d, value: num(d30.v), change_pct: pct(num(last.v), num(d30.v)) } : null,
        series: r.map(x => ({ date: x.d, value: num(x.v) })),
      };
    },
  },

  // ── Step 2 metrics (plan, dimensions, forecasts) ──────────────
  target_vs_actual: {
    description: 'Actual vs target (plan) for a metric over the current or a past month / fiscal quarter / fiscal year, company-wide and per business unit, region or product where targets were set. Gives achievement %, straight-line projection to period end and status (on_track / at_risk / behind / met / missed). Use for "are we meeting our revenue target", "did we meet annual targets", "which BUs underperformed".',
    input_schema: { type: 'object', properties: {
      metric: { type: 'string', enum: Object.keys(TARGET_METRICS), description: 'Default revenue.' },
      period_type: { type: 'string', enum: ['month', 'quarter', 'year'], description: 'Default month. Quarters and year follow the Indian fiscal year (Apr–Mar).' },
      offset: { type: 'integer', description: '0 = current period (default), -1 = previous period, -2 = the one before…' },
      dimension_kind: { type: 'string', enum: ['business_unit', 'region', 'product'], description: 'Restrict to targets set for this dimension (plus the company-wide target).' },
    } },
    async run(pool, t, input) {
      await ensureCfoSetupTables(pool);
      const metric = TARGET_METRICS[input?.metric] ? input.metric : 'revenue';
      const pt = (PERIOD_TYPES as readonly string[]).includes(input?.period_type) ? input.period_type : 'month';
      const offset = clampInt(input?.offset, 0, -24, 0);
      const today = istTodayYmd();
      const start = currentPeriodStart(pt, today, offset), end = periodEnd(pt, start);
      const dk = (DIM_KINDS as readonly string[]).includes(input?.dimension_kind) ? input.dimension_kind : null;
      const targets = await rows(pool,
        `SELECT t.target_value, t.dimension_kind, t.dimension_id::text AS dimension_id, d.name AS dimension_name
         FROM cfo_targets t LEFT JOIN cfo_dimensions d ON d.id = t.dimension_id
         WHERE t.tenant_id=$1 AND t.metric=$2 AND t.period_type=$3 AND t.period_start=$4::date
           AND ($5::text IS NULL OR t.dimension_kind IS NULL OR t.dimension_kind = $5)`, [t, metric, pt, start, dk]);
      if (!targets.length) {
        return needsData([`${metric} target for ${pt} starting ${start}`],
          `No ${TARGET_METRICS[metric].label} target is set for this ${pt} (${start} to ${end}). Targets are entered in CFO Setup → Targets.`);
      }
      const hib = TARGET_METRICS[metric].higher_is_better;
      const isOver = end < today;
      const elapsed = isOver ? 1 : Math.min(1, daysBetweenInclusive(start, today) / daysBetweenInclusive(start, end));
      const to = isOver ? end : today;
      const items: Json[] = [];
      for (const tg of targets) {
        const target = num(tg.target_value);
        const dim: Dim | undefined = tg.dimension_id ? { kind: tg.dimension_kind, id: tg.dimension_id } : undefined;
        const actual = await actualMetric(pool, t, metric, start, to, dim);
        const projected = elapsed > 0 ? actual / elapsed : null;
        let status: string;
        if (hib) status = isOver ? (actual >= target ? 'met' : 'missed') : (projected! >= target ? 'on_track' : projected! >= 0.9 * target ? 'at_risk' : 'behind');
        else status = isOver ? (actual <= target ? 'within_limit' : 'exceeded') : (projected! <= target ? 'on_track' : projected! <= 1.1 * target ? 'at_risk' : 'over_pace');
        items.push({
          scope: dim ? `${tg.dimension_kind}: ${tg.dimension_name}` : 'company', target, actual: round(actual, 0),
          achievement_pct: target > 0 ? round((actual / target) * 100, 1) : null,
          gap_to_target: round(hib ? target - actual : actual - target, 0),
          projected_at_period_end: isOver ? null : projected === null ? null : round(projected, 0), status,
        });
      }
      const bad = hib ? ['missed', 'behind', 'at_risk'] : ['exceeded', 'over_pace', 'at_risk'];
      return {
        metric, label: TARGET_METRICS[metric].label, period_type: pt, period: { from: start, to: end }, as_of: today,
        period_complete: isOver, elapsed_pct: round(elapsed * 100, 0), direction: hib ? 'higher is better' : 'lower is better (spending ceiling)',
        results: items, needing_attention: items.filter(i => bad.includes(i.status)).map(i => i.scope),
        note: isOver ? undefined : 'Projection is straight-line (actual ÷ share of period elapsed); it ignores seasonality.',
      };
    },
  },

  breakdown_by_dimension: {
    description: 'Revenue (or vendor cost) split by business unit, region or product for a period versus the prior comparable period, with share, growth, decliners and tagging coverage. Cost by business unit is AP-invoiced cost, a proxy for cash consumption. Use for "which products contributed most revenue", "which business units underperformed", "which BUs consumed the most cash".',
    input_schema: { type: 'object', properties: {
      dimension: { type: 'string', enum: ['business_unit', 'region', 'product'] },
      measure: { type: 'string', enum: ['revenue', 'vendor_costs'], description: 'Default revenue.' },
      period: { type: 'string', enum: ['today_vs_last_week', 'week_vs_prev_week', 'mtd_vs_prev_mtd', 'month_vs_prev_month', 'last_quarter_vs_prev_quarter', 'ytd_vs_prev_ytd'], description: 'Default mtd_vs_prev_mtd.' },
    }, required: ['dimension'] },
    async run(pool, t, input) {
      await ensureCfoSetupTables(pool);
      const kind: DimKind = input?.dimension;
      if (!(DIM_KINDS as readonly string[]).includes(kind)) return { error: 'dimension must be business_unit, region or product' };
      const label = kind.replace('_', ' ');
      const defined = await rows(pool, `SELECT id::text AS id, name FROM cfo_dimensions WHERE tenant_id=$1 AND kind=$2 AND is_active ORDER BY name`, [t, kind]);
      if (!defined.length) return needsData([`${label} list`], `No ${label}s are defined yet. Add them in CFO Setup → Dimensions, then map customers/vendors to them.`);
      const pr = periodRanges(input?.period || 'mtd_vs_prev_mtd');
      if (!pr) return { error: 'unknown period' };
      const cost = input?.measure === 'vendor_costs';
      const tbl = cost ? 'ap_invoices' : 'ar_invoices', ent = cost ? 'vendor' : 'customer', fk = cost ? 'vendor_id' : 'customer_id';
      const excl = cost ? `('draft','rejected')` : `('draft','cancelled')`;
      const col = DIM_COLUMN[kind];
      const sql = `SELECT d.id::text AS dim_id, COALESCE(d.name,'Untagged') AS name, COALESCE(SUM(x.subtotal),0) AS v, COUNT(*) AS n
                   FROM ${tbl} x
                   LEFT JOIN cfo_entity_defaults df ON df.tenant_id=x.tenant_id::text AND df.entity_type='${ent}' AND df.entity_id=x.${fk}::text
                   LEFT JOIN cfo_dimensions d ON d.id = COALESCE(x.${col}, df.${col})
                   WHERE x.tenant_id=$1 AND x.status NOT IN ${excl} AND x.date::date BETWEEN $2 AND $3 GROUP BY d.id, d.name`;
      const [cur, prev] = await Promise.all([
        rows(pool, sql, [t, ymd(pr.cur[0]), ymd(pr.cur[1])]), rows(pool, sql, [t, ymd(pr.prev[0]), ymd(pr.prev[1])]),
      ]);
      type Row = { name: string; current: number; previous: number; invoices: number };
      const map = new Map<string, Row>();
      const ensure = (id: string | null, name: string): Row => { const k = id || 'untagged'; if (!map.has(k)) map.set(k, { name, current: 0, previous: 0, invoices: 0 }); return map.get(k)!; };
      defined.forEach(d => ensure(d.id, d.name));
      cur.forEach(r => { const e = ensure(r.dim_id, r.name); e.current = num(r.v); e.invoices = parseInt(r.n); });
      prev.forEach(r => { ensure(r.dim_id, r.name).previous = num(r.v); });
      const totalCur = Array.from(map.values()).reduce((s, e) => s + e.current, 0);
      const list = Array.from(map.values()).map(e => ({ ...e, change_pct: pct(e.current, e.previous), share_pct: totalCur > 0 ? round((e.current / totalCur) * 100, 1) : 0 }))
        .sort((a, b) => b.current - a.current);
      const untagged = list.find(e => e.name === 'Untagged');
      const tagged = list.filter(e => e.name !== 'Untagged');
      const untaggedPct = untagged ? untagged.share_pct : 0;
      return {
        dimension: kind, measure: cost ? 'vendor_costs (AP invoiced)' : 'revenue (AR invoiced, pre-tax)',
        period: input?.period || 'mtd_vs_prev_mtd',
        current_range: { from: ymd(pr.cur[0]), to: ymd(pr.cur[1]) }, previous_range: { from: ymd(pr.prev[0]), to: ymd(pr.prev[1]) },
        total_current: totalCur, items: list,
        top_contributor: tagged.length && tagged[0].current > 0 ? tagged[0].name : null,
        declined_vs_previous: tagged.filter(e => e.change_pct !== null && e.change_pct < 0).map(e => `${e.name} (${e.change_pct}%)`),
        untagged_share_pct: untaggedPct,
        warning: untaggedPct > 30 ? `${untaggedPct}% of this ${cost ? 'cost' : 'revenue'} is not mapped to any ${label}; the split is incomplete. Map customers/vendors in CFO Setup → Mapping.` : undefined,
        caveat: kind === 'product' ? 'Product is tagged at invoice/customer level, not per invoice line, so multi-product invoices count wholly under one product.' : undefined,
      };
    },
  },

  open_alerts: {
    description: 'Open proactive alerts ("AI asks") the system has raised on its own from threshold rules: severity, what was detected, the question for the CFO, and when first raised. Use for "what needs my attention", "what should I know", "any red flags".',
    input_schema: { type: 'object', properties: { include_acknowledged: { type: 'boolean', description: 'Also list alerts already acknowledged. Default false.' } } },
    async run(pool, t, input) {
      const statuses = input?.include_acknowledged ? ['open', 'acknowledged'] : ['open'];
      let list: any[];
      try {
        list = await rows(pool, `SELECT severity, title, detail, ask, status, first_raised_at::text AS first_raised_at FROM cfo_alerts
                                 WHERE tenant_id=$1 AND status = ANY($2::text[])
                                 ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, first_raised_at ASC LIMIT 25`, [t, statuses]);
      } catch { return needsData(['proactive alert scan'], 'The alert scan has not run yet for this company (it runs hourly once Step 3 is deployed).'); }
      const bySeverity: Record<string, number> = {}; list.forEach(a => { bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1; });
      return { open_count: list.length, by_severity: bySeverity, alerts: list,
        note: 'Alerts come from fixed threshold rules checked hourly; a missing alert means a rule did not trigger, not that the area was reviewed.' };
    },
  },

  forecast_vs_actual: {
    description: 'Compares the saved forecast for a month with actual (or month-to-date projected) revenue, cash received or cash paid. Uses the CFO\'s manual forecast if one was entered, otherwise the system baseline (trailing 3-month average) saved when the month was first seen. Use for "are we ahead or behind forecast".',
    input_schema: { type: 'object', properties: {
      metric: { type: 'string', enum: [...FORECAST_METRICS], description: 'Default revenue.' },
      month_offset: { type: 'integer', description: '0 = current month (default), -1 = last month…' },
    } },
    async run(pool, t, input) {
      await ensureCfoSetupTables(pool);
      const metric = (FORECAST_METRICS as readonly string[]).includes(input?.metric) ? input.metric : 'revenue';
      const today = istTodayYmd();
      const start = currentPeriodStart('month', today, clampInt(input?.month_offset, 0, -24, 0)), end = periodEnd('month', start);
      const f = await rows(pool, `SELECT forecast_value, source, method, made_on::text AS made_on FROM cfo_forecasts
                                  WHERE tenant_id=$1 AND metric=$2 AND period_start=$3::date ORDER BY (source='manual') DESC LIMIT 1`, [t, metric, start]);
      if (!f.length) return needsData([`${metric} forecast for ${start}`], 'No forecast was saved for that month. The system saves a baseline daily from first deploy onward (months before that have none); a manual forecast can be entered in CFO Setup → Forecasts.');
      const forecast = num(f[0].forecast_value);
      const isOver = end < today;
      const elapsed = isOver ? 1 : Math.min(1, daysBetweenInclusive(start, today) / daysBetweenInclusive(start, end));
      const actual = await actualMetric(pool, t, metric, start, isOver ? end : today);
      const projected = elapsed > 0 ? actual / elapsed : actual;
      const compare = isOver ? actual : projected;
      const variancePct = pct(compare, forecast);
      const hib = metric !== 'cash_out';
      const within = variancePct !== null && Math.abs(variancePct) <= 5;
      return {
        metric, month: start, forecast, forecast_source: f[0].source, forecast_method: f[0].method, forecast_made_on: f[0].made_on,
        actual_to_date: round(actual, 0), month_complete: isOver, projected_month_end: isOver ? null : round(projected, 0),
        variance_pct: variancePct, status: within ? 'on_forecast' : (variancePct! > 0) === hib ? 'ahead' : 'behind',
        note: 'System baselines are simple trailing averages, so "ahead/behind" mostly reflects change against recent run-rate.',
      };
    },
  },
};

// ── Daily snapshots (builds the history that trend questions need) ──
let snapshotTableReady = false;
export async function ensureSnapshotTable(pool: Pool): Promise<void> {
  if (snapshotTableReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS cfo_daily_snapshots (
    tenant_id TEXT NOT NULL, snapshot_date DATE NOT NULL, metrics JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, snapshot_date))`);
  snapshotTableReady = true;
}

export async function recordSnapshot(pool: Pool, tenantId: string): Promise<Json> {
  await ensureSnapshotTable(pool);
  const c = await coreNumbers(pool, tenantId);
  const metrics = { cash: c.cash, ar_outstanding: c.arOut, ar_overdue: c.arOverdue, ap_outstanding: c.apOut, dso: c.dso, dpo: c.dpo, inventory: c.inventory };
  await pool.query(
    `INSERT INTO cfo_daily_snapshots (tenant_id, snapshot_date, metrics) VALUES ($1, $2::date, $3)
     ON CONFLICT (tenant_id, snapshot_date) DO UPDATE SET metrics = EXCLUDED.metrics, created_at = NOW()`,
    [tenantId, ymd(istNow()), JSON.stringify(metrics)]);
  await recordForecasts(pool, tenantId).catch(e => console.error('[CFO forecasts]', String(e)));
  return metrics;
}

export async function recordAllSnapshots(pool: Pool): Promise<number> {
  const tenants = await pool.query(`SELECT DISTINCT tenant_id FROM users WHERE is_active=true`).catch(() => ({ rows: [] as any[] }));
  let n = 0;
  for (const row of tenants.rows) { try { await recordSnapshot(pool, String(row.tenant_id)); n++; } catch (e) { console.error('[CFO snapshot] failed for tenant', row.tenant_id, String(e)); } }
  return n;
}

/** Call once at startup. Idempotent upsert, so running every 6h is safe (last run of the day wins). */
export function startCfoSnapshotJob(pool: Pool): void {
  const run = () => recordAllSnapshots(pool).then(n => console.log(`[CFO snapshot] recorded ${n} tenant(s)`)).catch(e => console.error('[CFO snapshot]', String(e)));
  setTimeout(run, 30_000);
  setInterval(run, 6 * 60 * 60 * 1000);
}

export async function runMetric(pool: Pool, tenantId: string, name: string, input: any): Promise<Json> {
  await ensurePaymentEventsTable(pool).catch(() => {});
  const m = METRICS[name];
  if (!m) return { error: `unknown metric ${name}` };
  try { return await m.run(pool, tenantId, input || {}); }
  catch (e: any) { return { error: `metric ${name} failed: ${String(e.message || e)}` }; }   // isolated: one bad query never breaks an answer
}
