// ============================================================
// Deemona AI Finance OS — CFO Metrics Service (Step 1)
// Deterministic, SQL-computed metrics. The CFO agent calls these as
// tools, so every number the model quotes comes from a query, not a guess.
// Metrics that need data the schema doesn't hold yet return
// { available:false, needs_data:[...] } so the agent says so honestly.
// ============================================================
import { Pool } from 'pg';

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
    rows(pool, `SELECT COALESCE(SUM(current_balance),0) AS v FROM bank_accounts WHERE tenant_id=$1 AND is_active=TRUE`, [t]),
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

// ── Metric registry ──────────────────────────────────────────
export const METRICS: Record<string, Metric> = {

  cash_position: {
    description: 'Current cash across active bank accounts, per-account balances, and accounts with unusually low or negative balances.',
    input_schema: { type: 'object', properties: { low_threshold: { type: 'number', description: 'Flag accounts below this INR balance. Default: 25% of the mean account balance.' } } },
    async run(pool, t, input) {
      const accts = await rows(pool, `SELECT name, account_type, current_balance, is_primary FROM bank_accounts WHERE tenant_id=$1 AND is_active=TRUE ORDER BY current_balance ASC`, [t]);
      const total = accts.reduce((s, a) => s + num(a.current_balance), 0);
      const mean = accts.length ? total / accts.length : 0;
      const thr = input?.low_threshold !== undefined ? num(input.low_threshold) : mean * 0.25;
      return {
        total_cash: total, account_count: accts.length, low_balance_threshold: round(thr, 0),
        accounts: accts.map(a => ({ name: a.name, type: a.account_type, balance: num(a.current_balance), primary: a.is_primary })),
        low_balance_accounts: accts.filter(a => num(a.current_balance) < thr).map(a => ({ name: a.name, balance: num(a.current_balance) })),
        as_of: new Date().toISOString(),
      };
    },
  },

  cash_runway: {
    description: 'Cash runway based on actual bank inflows/outflows over the last 90 days (gross and net burn). Falls back to payroll if there are no transactions.',
    input_schema: { type: 'object', properties: {} },
    async run(pool, t) {
      const [bank, tx, payroll] = await Promise.all([
        rows(pool, `SELECT COALESCE(SUM(current_balance),0) AS v FROM bank_accounts WHERE tenant_id=$1 AND is_active=TRUE`, [t]),
        rows(pool, `SELECT type, COALESCE(SUM(amount),0) AS total FROM bank_transactions WHERE tenant_id=$1 AND date::date >= CURRENT_DATE - 90 GROUP BY type`, [t]),
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
        basis: out > 0 ? 'bank transactions, last 90 days (transfers between own accounts, if recorded, inflate both sides)' : 'latest payroll run only (no bank transactions found)',
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
        rows(pool, `SELECT COALESCE(SUM(current_balance),0) AS v FROM bank_accounts WHERE tenant_id=$1 AND is_active=TRUE`, [t]),
        rows(pool, `SELECT GREATEST(due_date::date, CURRENT_DATE) AS d, SUM(balance_due) AS amt FROM ap_invoices
                    WHERE tenant_id=$1 AND status NOT IN ('paid','rejected','draft') AND due_date::date <= CURRENT_DATE + $2::int GROUP BY 1`, [t, days]),
        rows(pool, `SELECT GREATEST(due_date::date, CURRENT_DATE) AS d, SUM(balance_due) AS amt FROM ar_invoices
                    WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled','draft') AND due_date::date <= CURRENT_DATE + $2::int GROUP BY 1`, [t, days]),
        rows(pool, `SELECT COALESCE(SUM(amount),0) AS v FROM bank_transactions WHERE tenant_id=$1 AND type='debit' AND date::date >= CURRENT_DATE - 90`, [t]),
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
      return {
        total_ar_outstanding: totalAr,
        customers: list.map(r => ({
          customer: r.customer, invoices: parseInt(r.invoices), overdue_amount: num(r.overdue_amount), max_days_overdue: r.max_days_overdue,
          escalate: r.max_days_overdue > 60 || (totalAr > 0 && num(r.overdue_amount) / totalAr > 0.1),
        })),
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
      const today = istNow(); const y = today.getFullYear(), m = today.getMonth();
      let cur: [Date, Date], prev: [Date, Date];
      switch (input?.period) {
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
        default: return { error: 'unknown period' };
      }
      const sqlByMeasure: Record<string, string> = {
        revenue: `SELECT COALESCE(SUM(subtotal),0) AS v, COUNT(*) AS n FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled') AND date::date BETWEEN $2 AND $3`,
        cash_in: `SELECT COALESCE(SUM(amount),0) AS v, COUNT(*) AS n FROM bank_transactions WHERE tenant_id=$1 AND type='credit' AND date::date BETWEEN $2 AND $3`,
        cash_out: `SELECT COALESCE(SUM(amount),0) AS v, COUNT(*) AS n FROM bank_transactions WHERE tenant_id=$1 AND type='debit' AND date::date BETWEEN $2 AND $3`,
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
        rows(pool, `SELECT date::date::text AS date, description, category, amount FROM bank_transactions WHERE tenant_id=$1 AND type='credit' AND date::date BETWEEN $2 AND $3 ORDER BY amount DESC LIMIT $4`, [t, from, to, limit]),
        rows(pool, `SELECT date::date::text AS date, description, category, amount FROM bank_transactions WHERE tenant_id=$1 AND type='debit' AND date::date BETWEEN $2 AND $3 ORDER BY amount DESC LIMIT $4`, [t, from, to, limit]),
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

  // ── Placeholders for Step 2 (need new data). They tell the agent honestly what's missing. ──
  target_vs_actual: {
    description: 'Compare actual revenue/profit/cash against targets or plan (monthly, quarterly, annual).',
    input_schema: { type: 'object', properties: { metric: { type: 'string' }, period: { type: 'string' } } },
    async run() { return needsData(['kpi_targets'], 'No revenue / profit / cash targets or annual plan are stored yet, so actual-vs-target and "are we on plan" cannot be answered.'); },
  },
  breakdown_by_dimension: {
    description: 'Revenue, margin or cash by business unit, region or product.',
    input_schema: { type: 'object', properties: { dimension: { type: 'string', enum: ['business_unit', 'region', 'product'] } }, required: ['dimension'] },
    async run(_p, _t, input) { return needsData([`${input?.dimension || 'dimension'} tag on invoices/transactions`], 'Invoices and transactions carry no business-unit, region or product tag yet.'); },
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
  const m = METRICS[name];
  if (!m) return { error: `unknown metric ${name}` };
  try { return await m.run(pool, tenantId, input || {}); }
  catch (e: any) { return { error: `metric ${name} failed: ${String(e.message || e)}` }; }   // isolated: one bad query never breaks an answer
}
