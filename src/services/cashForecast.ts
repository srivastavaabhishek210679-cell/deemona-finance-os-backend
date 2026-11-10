// ============================================================
// Cash forecast (Predictive Twin). Pure arithmetic over your own books: opening cash from the Cash Balance page,
// open sales invoices (receipts) and open bills (payments) by due date, plus assumptions you type in.
// No AI is involved in any number here. Nothing is stored.
// ============================================================
import { Pool } from 'pg';
import { cashAsOf } from './cashPosition';

export interface FcItem { kind: 'in' | 'out'; ref: string; party: string; amount: number; due: string; overdue: boolean; category?: 'salary' | 'statutory'; }
export interface FcOpts { days: number; ar_delay_days: number; collection_pct: number; ap_delay_days: number; monthly_inflow: number; monthly_outflow: number; }
export interface FcPoint { date: string; inflow: number; outflow: number; close: number; }
export interface FcResult {
  opts: FcOpts; points: FcPoint[]; opening: number; closing: number; total_in: number; total_out: number;
  lowest: { amount: number; date: string }; first_negative: string | null; shortfall: number;
}

const DAY = 86400000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => ymd(new Date(new Date(s + 'T00:00:00Z').getTime() + n * DAY));

export function runForecast(opening: number, items: FcItem[], o: FcOpts, today: string): FcResult {
  const days = Math.max(7, Math.min(365, Math.round(o.days)));
  const inflow: Record<string, number> = {}, outflow: Record<string, number> = {};
  const end = addDays(today, days);
  const pct = Math.max(0, Math.min(100, o.collection_pct)) / 100;
  for (const it of items) {
    let when: string;
    if (it.kind === 'in') {
      when = addDays(it.overdue ? addDays(today, 7) : it.due, Math.round(o.ar_delay_days));
      if (when <= today) when = addDays(today, 1);
      if (when > end) continue;
      inflow[when] = (inflow[when] || 0) + it.amount * pct;
    } else {
      when = addDays(it.overdue ? addDays(today, 1) : it.due, Math.round(o.ap_delay_days));
      if (when <= today) when = addDays(today, 1);
      if (when > end) continue;
      outflow[when] = (outflow[when] || 0) + it.amount;
    }
  }
  const dIn = (o.monthly_inflow || 0) * 12 / 365, dOut = (o.monthly_outflow || 0) * 12 / 365;
  const points: FcPoint[] = [];
  let bal = opening, tin = 0, tout = 0;
  let low = { amount: opening, date: today };
  let firstNeg: string | null = opening < 0 ? today : null;
  for (let i = 1; i <= days; i++) {
    const d = addDays(today, i);
    const a = (inflow[d] || 0) + dIn, b = (outflow[d] || 0) + dOut;
    bal += a - b; tin += a; tout += b;
    points.push({ date: d, inflow: Math.round(a * 100) / 100, outflow: Math.round(b * 100) / 100, close: Math.round(bal * 100) / 100 });
    if (bal < low.amount) low = { amount: Math.round(bal * 100) / 100, date: d };
    if (bal < 0 && !firstNeg) firstNeg = d;
  }
  return { opts: { ...o, days }, points, opening, closing: Math.round(bal * 100) / 100, total_in: Math.round(tin * 100) / 100, total_out: Math.round(tout * 100) / 100, lowest: low, first_negative: firstNeg, shortfall: low.amount < 0 ? Math.round(-low.amount * 100) / 100 : 0 };
}

export async function loadForecastInputs(pool: Pool, tenantId: string, opts: { payroll?: boolean } = {}): Promise<{ opening: any; items: FcItem[]; today: string; basis: string[] }> {
  const today = new Date().toLocaleDateString('en-CA');
  const opening = await cashAsOf(pool, tenantId, today);
  const ar = await pool.query(
    `SELECT a.invoice_number, c.name AS party, a.balance_due::float8 AS amt, a.due_date::text AS due
     FROM ar_invoices a LEFT JOIN customers c ON c.id = a.customer_id
     WHERE a.tenant_id = $1 AND a.status IN ('sent','partially_paid','overdue') AND a.balance_due > 0`, [tenantId]);
  const ap = await pool.query(
    `SELECT a.invoice_number, v.name AS party, a.balance_due::float8 AS amt, a.due_date::text AS due
     FROM ap_invoices a LEFT JOIN vendors v ON v.id = a.vendor_id
     WHERE a.tenant_id = $1 AND a.status IN ('approved','overdue') AND a.balance_due > 0`, [tenantId]);
  const items: FcItem[] = [
    ...ar.rows.map((r: any): FcItem => ({ kind: 'in', ref: r.invoice_number, party: r.party || '', amount: r.amt, due: r.due, overdue: r.due < today })),
    ...ap.rows.map((r: any): FcItem => ({ kind: 'out', ref: r.invoice_number, party: r.party || '', amount: r.amt, due: r.due, overdue: r.due < today })),
  ];
  let basis: string[] = [];
  if (opts.payroll !== false) { const pt = await loadPayrollTaxItems(pool, tenantId, today); items.push(...pt.items); basis = pt.basis; }
  return { opening, items, today, basis };
}

/*payroll-tax*/
// ── Salaries and statutory payments ──────────────────────────────────────────────────────────────
// Rule-based and explainable. Amounts come from your last approved/paid payroll run (or, if there is none, from the salary
// structure of active employees). GST is output tax on your invoices minus input tax on your bills. Only future dates are added.
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monLabel = (y: number, m: number): string => { const d = new Date(Date.UTC(y, m - 1, 1)); return MON3[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };
const mkDate = (y: number, m: number, day: number): string => {
  const d = new Date(Date.UTC(y, m - 1, 1)); const yy = d.getUTCFullYear(), mm = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return yy + '-' + String(mm).padStart(2, '0') + '-' + String(Math.min(day, last)).padStart(2, '0');
};

export async function loadPayrollTaxItems(pool: Pool, tenantId: string, today: string): Promise<{ items: FcItem[]; basis: string[] }> {
  const items: FcItem[] = []; const basis: string[] = [];
  const push = (ref: string, party: string, amount: number, due: string, category: 'salary' | 'statutory') => {
    if (amount > 0.5 && due >= today) items.push({ kind: 'out', ref, party, amount: Math.round(amount * 100) / 100, due, overdue: false, category });
  };
  const curY = parseInt(today.slice(0, 4), 10), curM = parseInt(today.slice(5, 7), 10);
  // 1. Payroll
  try {
    const run = await pool.query(
      'SELECT id, month, year, status, total_net::float8 AS net, total_tds::float8 AS tds, paid_at::date::text AS paid_on ' +
      "FROM payroll_runs WHERE tenant_id = $1 AND status IN ('approved','paid') AND total_net > 0 ORDER BY year DESC, month DESC LIMIT 1", [tenantId]);
    if (run.rows.length) {
      const r: any = run.rows[0];
      const ps: any = (await pool.query(
        'SELECT COALESCE(SUM(pf_employee + pf_employer),0)::float8 AS pf, COALESCE(SUM(esic_employee + esic_employer),0)::float8 AS esic, ' +
        'COALESCE(SUM(professional_tax),0)::float8 AS pt, COALESCE(SUM(tds),0)::float8 AS tds FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2', [tenantId, r.id])).rows[0];
      const tds = ps.tds > 0 ? ps.tds : (r.tds || 0);
      let offset = 0, payDay = 31;
      if (r.paid_on) {
        payDay = Math.min(31, parseInt(String(r.paid_on).slice(8, 10), 10));
        offset = Math.max(0, Math.min(1, (parseInt(String(r.paid_on).slice(0, 4), 10) * 12 + parseInt(String(r.paid_on).slice(5, 7), 10)) - (r.year * 12 + r.month)));
      }
      for (let k = 0; k <= 13; k++) {
        const m = r.month + k;
        const label = monLabel(r.year, m);
        if (!(k === 0 && r.status === 'paid')) push('Salaries (net pay) - ' + label, 'Payroll', r.net, mkDate(r.year, m + offset, payDay), 'salary');
        push('TDS on salary - ' + label, 'Income tax dept', tds, mkDate(r.year, m + 1, 7), 'statutory');
        push('PF and ESIC - ' + label, 'EPFO / ESIC', ps.pf + ps.esic, mkDate(r.year, m + 1, 15), 'statutory');
        push('Professional tax - ' + label, 'State tax dept', ps.pt, mkDate(r.year, m + 1, 20), 'statutory');
      }
      basis.push('Salaries and PF, ESIC, TDS and professional tax follow your last payroll run (' + monLabel(r.year, r.month) + '), repeated every month at the same amounts.');
    } else {
      const e: any = (await pool.query(
        "SELECT COALESCE(SUM(basic_salary + hra + special_allowance + other_allowances),0)::float8 AS gross, " +
        "COALESCE(SUM(CASE WHEN pf_applicable THEN LEAST(basic_salary, 15000) * 0.12 ELSE 0 END),0)::float8 AS pf, COUNT(*)::int AS n " +
        "FROM employees WHERE tenant_id = $1 AND status = 'active'", [tenantId])).rows[0];
      if (e.n > 0 && e.gross > 0) {
        for (let k = -1; k <= 13; k++) {
          if (k >= 0) push('Salaries (estimated gross) - ' + monLabel(curY, curM + k), 'Payroll', e.gross, mkDate(curY, curM + k, 31), 'salary');
          push('Employer PF (estimated) - ' + monLabel(curY, curM + k), 'EPFO', e.pf, mkDate(curY, curM + k + 1, 15), 'statutory');
        }
        basis.push('No payroll run is recorded yet, so salaries are estimated from the salary structure of ' + e.n + ' active employee(s), paid at month end, plus employer PF.');
      }
    }
  } catch (err) { console.warn('[cash-forecast] payroll items skipped:', String((err as any)?.message || err)); }
  // 2. GST payable (net of input credit), due on the 20th of the following month
  try {
    const g = await pool.query(
      'SELECT to_char(date_trunc(\'month\', d), \'YYYY-MM\') AS ym, SUM(out_tax)::float8 AS out_tax, SUM(in_tax)::float8 AS in_tax FROM (' +
      "SELECT date AS d, tax_amount AS out_tax, 0 AS in_tax FROM ar_invoices WHERE tenant_id = $1 AND status NOT IN ('draft','cancelled') AND COALESCE(tax_type,'GST') = 'GST' " +
      'UNION ALL ' +
      "SELECT date AS d, 0 AS out_tax, tax_amount AS in_tax FROM ap_invoices WHERE tenant_id = $1 AND status IN ('approved','paid','overdue') AND COALESCE(tax_type,'GST') = 'GST'" +
      ') x WHERE d >= (date_trunc(\'month\', $2::date) - INTERVAL \'3 months\')::date GROUP BY 1', [tenantId, today]);
    const net = new Map<string, number>();
    for (const row of g.rows as any[]) net.set(row.ym, (row.out_tax || 0) - (row.in_tax || 0));
    const ymOf = (m: number) => { const d = new Date(Date.UTC(curY, m - 1, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
    const last3 = [1, 2, 3].map(i => net.get(ymOf(curM - i)) || 0);
    const avg = Math.max(0, (last3[0] + last3[1] + last3[2]) / 3);
    const prev = Math.max(0, last3[0]);
    if (prev > 0 || avg > 0) {
      push('GST payable - ' + monLabel(curY, curM - 1), 'GST portal', prev, mkDate(curY, curM, 20), 'statutory');
      for (let k = 0; k <= 12; k++) push('GST payable (estimate) - ' + monLabel(curY, curM + k), 'GST portal', avg, mkDate(curY, curM + k + 1, 20), 'statutory');
      basis.push('GST is output tax on your invoices minus input tax on your bills, due on the 20th of the next month; future months use the average of the last 3 months.');
    }
  } catch (err) { console.warn('[cash-forecast] GST items skipped:', String((err as any)?.message || err)); }
  return { items, basis };
}

