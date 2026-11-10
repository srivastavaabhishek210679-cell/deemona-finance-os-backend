// Puts salaries and statutory payments (PF, ESIC, TDS on salary, professional tax, GST) into the cash forecast.
// Run from the backend folder. Idempotent.
const fs = require('fs');
function rw(p, fn) {
  let s = fs.readFileSync(p, 'utf8'); const bom = s.charCodeAt(0) === 0xFEFF; if (bom) s = s.slice(1);
  const crlf = s.includes('\r\n'); if (crlf) s = s.replace(/\r\n/g, '\n');
  const t = fn(s);
  if (t === s) { console.log('no change', p); return; }
  fs.writeFileSync(p, (bom ? '﻿' : '') + (crlf ? t.replace(/\n/g, '\r\n') : t)); console.log('patched', p);
}
function rep(s, a, b) { if (s.split(a).length !== 2) { console.log('ANCHOR NOT FOUND/UNIQUE:', a.slice(0, 90)); process.exit(1); } return s.replace(a, () => b); }

const CORE = String.raw`
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
`;

rw('src/services/cashForecast.ts', s => {
  if (s.includes('/*payroll-tax*/')) return s;
  s = rep(s, "export interface FcItem { kind: 'in' | 'out'; ref: string; party: string; amount: number; due: string; overdue: boolean; }",
             "export interface FcItem { kind: 'in' | 'out'; ref: string; party: string; amount: number; due: string; overdue: boolean; category?: 'salary' | 'statutory'; }");
  s = rep(s, "export async function loadForecastInputs(pool: Pool, tenantId: string): Promise<{ opening: any; items: FcItem[]; today: string }> {",
             "export async function loadForecastInputs(pool: Pool, tenantId: string, opts: { payroll?: boolean } = {}): Promise<{ opening: any; items: FcItem[]; today: string; basis: string[] }> {");
  s = rep(s, "  return { opening, items, today };\n}",
             "  let basis: string[] = [];\n  if (opts.payroll !== false) { const pt = await loadPayrollTaxItems(pool, tenantId, today); items.push(...pt.items); basis = pt.basis; }\n  return { opening, items, today, basis };\n}\n" + CORE);
  return s;
});

rw('src/routes/cashForecastRoutes.ts', s => {
  if (s.includes('/*payroll-tax-routes*/')) return s;
  s = rep(s, "  const { opening, items, today } = await loadForecastInputs(pool, tenantId);\n  const scenarios: any[] = [",
             "  const { opening, items, today, basis } = await loadForecastInputs(pool, tenantId);\n  const scenarios: any[] = [");
  s = rep(s, "  return { opening, items, today, scenarios };", "  return { opening, items, today, scenarios, basis };");
  // GET /
  s = rep(s, "      const { opening, items, today, scenarios } = await build(pool, tid(req), custom);\n      const upcoming = items.map(i => ({ ...i })).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 25);",
             "      /*payroll-tax-routes*/\n      const { opening, items, today, scenarios, basis } = await build(pool, tid(req), custom);\n      const soon = new Date(new Date(today + 'T00:00:00Z').getTime() + 45 * 86400000).toISOString().slice(0, 10);\n      const upcoming = items.filter(i => !i.category || i.due <= soon).map(i => ({ ...i })).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 25);");
  s = rep(s, "payables: items.filter(i => i.kind === 'out').length },", "payables: items.filter(i => i.kind === 'out' && !i.category).length, payroll_and_tax_items: items.filter(i => !!i.category).length },");
  s = rep(s, "note: 'Built only from your open invoices and bills plus the assumptions you set. Salaries, taxes and new sales that are not yet recorded are not included unless you enter them as monthly amounts.',",
             "basis,\n        note: 'Built from your open invoices and bills, your payroll and GST (see the basis lines) and the assumptions you set. New sales that are not yet recorded, advance tax and TDS on vendor payments are not included unless you enter them as monthly amounts.',");
  // commentary
  s = rep(s, "      const { opening, items, today, scenarios } = await build(pool, t, custom);\n      const recv = items.filter(i => i.kind === 'in');",
             "      const { opening, items, today, scenarios, basis } = await build(pool, t, custom);\n      const recv = items.filter(i => i.kind === 'in');\n      const soon30 = new Date(new Date(today + 'T00:00:00Z').getTime() + 30 * 86400000).toISOString().slice(0, 10);\n      const within30 = (c: string) => items.filter(i => i.category === c && i.due <= soon30).reduce((a, i) => a + i.amount, 0);");
  s = rep(s, "open_payables: { count: items.length - recv.length, largest: items.filter(i => i.kind === 'out')",
             "payroll_and_taxes: { included: items.some(i => !!i.category), basis, salaries_due_in_next_30_days: inrText(within30('salary')), statutory_payments_due_in_next_30_days: inrText(within30('statutory')) },\n        open_payables: { count: items.filter(i => i.kind === 'out' && !i.category).length, largest: items.filter(i => i.kind === 'out' && !i.category)");
  s = rep(s, "- Say plainly what the forecast leaves out: salaries, taxes and unbilled sales unless monthly amounts were entered.",
             "- Say plainly what the forecast leaves out: unbilled sales, advance tax and TDS on vendor payments. Salaries, PF, ESIC, TDS on salary, professional tax and GST are included when payroll_and_taxes.included is true (say in one short phrase what basis is given); if it is false, say they are not included.");
  return s;
});

rw('src/routes/recommendationRoutes.ts', s => {
  if (s.includes('i.kind === \'out\' && !i.category')) return s;
  return rep(s, "const pay = items.filter(i => i.kind === 'out' && !i.overdue &&", "const pay = items.filter(i => i.kind === 'out' && !i.category && !i.overdue &&");
});

rw('src/routes/specialistAgentRoutes.ts', s => {
  if (s.includes('salaries_and_taxes_in_forecast')) return s;
  return rep(s, "open_payables: { count: items.length - recv.length, total_inr: inrText(items.filter(i => i.kind === 'out').reduce((a, i) => a + i.amount, 0)) },",
                "open_payables: { count: items.filter(i => i.kind === 'out' && !i.category).length, total_inr: inrText(items.filter(i => i.kind === 'out' && !i.category).reduce((a, i) => a + i.amount, 0)), salaries_and_taxes_in_forecast: items.some(i => !!i.category) },");
});

rw('src/routes/commandCenterRoutes.ts', s => {
  if (s.includes('{ payroll: false }')) return s;
  // Command Center already models payroll inside its monthly cost run-rate, so payroll items are left out here to avoid counting twice.
  return rep(s, "const { opening, items, today } = await loadForecastInputs(pool, tenantId);", "const { opening, items, today } = await loadForecastInputs(pool, tenantId, { payroll: false });");
});
