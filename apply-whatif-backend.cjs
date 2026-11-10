// What-if simulator for the Digital CFO: revenue change, headcount, budget multiplier, new monthly or one-time costs.
// Run-rate model from recent actuals. Idempotent. Run from the backend folder.
const fs = require('fs');

const SIM = String.raw`// Simple run-rate what-if model. Baseline = average of the last completed months of actuals (or amounts the user assumes).
// Cash is projected as opening cash plus each month's operating profit (no invoice-by-invoice timing). Every number is computed here.
export interface WhatIfBase { revenue: number; vendor_costs: number; payroll: number; claims: number; employees: number | null; months_used: number; source: string; }
export interface WhatIfParams {
  months: number; revenue_change_pct: number; revenue_start: number; costs_follow_revenue: boolean;
  headcount_change: number; cost_per_head: number; headcount_start: number;
  extra_monthly: { label: string; amount: number; start: number }[]; one_time: { label: string; amount: number; month: number }[];
}
const r0 = (n: number): number => Math.round(n);

export function simulateWhatIf(opening: number, b: WhatIfBase, p: WhatIfParams) {
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const label = (i: number): string => { const d = new Date(today.getFullYear(), today.getMonth() + i, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
  const baseProfit = b.revenue - b.vendor_costs - b.payroll - b.claims;
  let cashBase = opening, cashScn = opening;
  let lowB = { cash: opening, month_no: 0 }, lowS = { cash: opening, month_no: 0 };
  let firstNegB: string | null = opening < 0 ? 'now' : null, firstNegS: string | null = opening < 0 ? 'now' : null;
  const tot = { revenue: 0, vendor: 0, headcount: 0, extra: 0, one_time: 0 };
  const series: any[] = [];
  for (let m = 1; m <= p.months; m++) {
    const revDelta = m >= p.revenue_start ? b.revenue * (p.revenue_change_pct / 100) : 0;
    const vendDelta = p.costs_follow_revenue && m >= p.revenue_start ? b.vendor_costs * (p.revenue_change_pct / 100) : 0;
    const headDelta = m >= p.headcount_start ? p.headcount_change * p.cost_per_head : 0;
    const extra = p.extra_monthly.reduce((s, e) => s + (m >= e.start ? e.amount : 0), 0);
    const once = p.one_time.reduce((s, e) => s + (m === e.month ? e.amount : 0), 0);
    const profitScn = baseProfit + revDelta - vendDelta - headDelta - extra - once;
    cashBase += baseProfit; cashScn += profitScn;
    tot.revenue += revDelta; tot.vendor += vendDelta; tot.headcount += headDelta; tot.extra += extra; tot.one_time += once;
    if (cashBase < lowB.cash) lowB = { cash: cashBase, month_no: m };
    if (cashScn < lowS.cash) lowS = { cash: cashScn, month_no: m };
    if (cashBase < 0 && !firstNegB) firstNegB = label(m);
    if (cashScn < 0 && !firstNegS) firstNegS = label(m);
    series.push({ label: label(m), month_no: m, profit_base: r0(baseProfit), profit_scenario: r0(profitScn), cash_base: r0(cashBase), cash_scenario: r0(cashScn) });
  }
  const profitTotalBase = baseProfit * p.months;
  const profitTotalScn = profitTotalBase + tot.revenue - tot.vendor - tot.headcount - tot.extra - tot.one_time;
  const avgScn = profitTotalScn / p.months, avgBase = baseProfit;
  const runway = (avg: number): number | null => (avg < 0 ? Math.max(0, Math.round((opening / -avg) * 10) / 10) : null);
  const inr = (n: number): string => { const a = Math.abs(n), sg = n < 0 ? '-' : ''; return a >= 1e7 ? sg + '₹' + (a / 1e7).toFixed(2) + ' Cr' : a >= 1e5 ? sg + '₹' + (a / 1e5).toFixed(2) + ' lakh' : sg + '₹' + Math.round(a).toLocaleString('en-IN'); };
  const summary: string[] = ['Without the change, profit is ' + inr(baseProfit) + ' a month.'];
  if (p.revenue_change_pct) summary.push('Revenue change of ' + p.revenue_change_pct + '%: ' + inr(b.revenue * p.revenue_change_pct / 100) + ' a month' + (p.costs_follow_revenue ? ', with vendor costs moving ' + inr(-b.vendor_costs * p.revenue_change_pct / 100) + ' a month in the opposite direction' : '') + (p.revenue_start > 1 ? ', from month ' + p.revenue_start : '') + '.');
  if (p.headcount_change) summary.push((p.headcount_change > 0 ? 'Hiring ' : 'Reducing ') + Math.abs(p.headcount_change) + ' people at ' + inr(p.cost_per_head) + ' each: ' + inr(-p.headcount_change * p.cost_per_head) + ' a month' + (p.headcount_start > 1 ? ', from month ' + p.headcount_start : '') + '.');
  p.extra_monthly.forEach(e => summary.push(e.label + ': ' + inr(-e.amount) + ' a month' + (e.start > 1 ? ', from month ' + e.start : '') + '.'));
  p.one_time.forEach(e => summary.push(e.label + ': ' + inr(-e.amount) + ' once, in month ' + e.month + '.'));
  summary.push('With the changes, average profit is ' + inr(avgScn) + ' a month, and total profit over ' + p.months + ' months is ' + inr(profitTotalScn) + ' against ' + inr(profitTotalBase) + ' without them.');
  summary.push('Cash after ' + p.months + ' months: ' + inr(cashScn) + ' with the changes against ' + inr(cashBase) + ' without, a difference of ' + inr(cashScn - cashBase) + '.');
  const rwS = runway(avgScn);
  summary.push(firstNegS ? 'Cash goes negative in ' + firstNegS + ' with the changes.' : (rwS !== null ? 'Profit is negative, so at this rate the opening cash of ' + inr(opening) + ' lasts about ' + rwS + ' months.' : 'Cash stays positive and profit stays positive across the period.'));
  return {
    summary,
    horizon_months: p.months,
    baseline: { avg_revenue: r0(b.revenue), avg_vendor_costs: r0(b.vendor_costs), avg_payroll_cost: r0(b.payroll), avg_other_costs: r0(b.claims), avg_profit: r0(baseProfit), months_of_actuals_used: b.months_used, source: b.source },
    opening_cash: r0(opening),
    without_change: { cash_end: r0(cashBase), lowest_cash: r0(lowB.cash), lowest_cash_label: lowB.month_no ? label(lowB.month_no) : 'now', first_negative_label: firstNegB, avg_profit: r0(avgBase), runway_months: runway(avgBase), profit_total: r0(profitTotalBase) },
    with_change: { cash_end: r0(cashScn), lowest_cash: r0(lowS.cash), lowest_cash_label: lowS.month_no ? label(lowS.month_no) : 'now', first_negative_label: firstNegS, avg_profit: r0(avgScn), runway_months: runway(avgScn), profit_total: r0(profitTotalScn) },
    difference: { cash_end_change: r0(cashScn - cashBase), profit_total_change: r0(profitTotalScn - profitTotalBase) },
    effect_by_change: {
      revenue_profit_effect: r0(tot.revenue), vendor_cost_effect: r0(-tot.vendor), staff_cost_effect: r0(-tot.headcount),
      new_recurring_costs_effect: r0(-tot.extra), one_time_costs_effect: r0(-tot.one_time),
    },
    series,
  };
}
`;

const METRIC = String.raw`
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
`;

function rd(p) { let s = fs.readFileSync(p, 'utf8'); const bom = s.charCodeAt(0) === 0xFEFF; if (bom) s = s.slice(1); const crlf = s.includes('\r\n'); if (crlf) s = s.replace(/\r\n/g, '\n'); return { s, bom, crlf }; }
function patch(p, fn) { if (!fs.existsSync(p)) { console.log('MISSING', p); process.exitCode = 1; return; } const o = rd(p); const t = fn(o.s); if (t !== o.s) { fs.writeFileSync(p, (o.bom ? '﻿' : '') + (o.crlf ? t.replace(/\n/g, '\r\n') : t)); console.log('patched', p); } else console.log('no change', p); }
if (!fs.existsSync('src/services/whatIf.ts') || fs.readFileSync('src/services/whatIf.ts', 'utf8') !== SIM) { fs.writeFileSync('src/services/whatIf.ts', SIM); console.log('wrote src/services/whatIf.ts'); } else console.log('up to date src/services/whatIf.ts');

patch('src/services/cfoMetrics.ts', s => {
  if (s.includes('/*what-if*/')) return s;
  const a = '\n  revenue_root_cause: {';
  if (!s.includes(a)) { console.log('cfoMetrics anchor not found (apply apply-decision-tools-backend.cjs first)'); process.exit(1); }
  s = s.replace(a, METRIC + a);
  return s.replace("import { buildActionPlan } from './actionPlan';", "import { buildActionPlan } from './actionPlan';\nimport { simulateWhatIf } from './whatIf';");
});
patch('src/routes/cfoAgentRoutes.ts', s => {
  if (s.includes('what_if_simulation') && !s.includes('/*whatif-summary*/')) {
    const k = 'and state that it is a run-rate model.';
    if (!s.includes(k)) { console.log('whatif prompt anchor not found'); return s; }
    return s.replace(k, k + ' Present the tool\'s "summary" lines as written and copy every _inr value exactly; never rewrite an amount as L, K or Cr yourself and never re-derive monthly figures. /*whatif-summary*/');
  }
  if (s.includes('what_if_simulation')) return s;
  const a = '- Get every figure from the tools. Never estimate or recall numbers.';
  if (!s.includes(a)) { console.log('prompt anchor not found'); process.exit(1); }
  return s.replace(a, '- For "what if" questions (revenue up or down, hiring, a budget doubling, a new office or cost) use what_if_simulation. Combine all the changes the user names in one call, show without-change versus with-change for end cash, lowest cash, runway and profit, and state that it is a run-rate model. Present the tool\'s "summary" lines as written and copy every _inr value exactly; never rewrite an amount as L, K or Cr yourself and never re-derive monthly figures. /*whatif-summary*/ If the tool asks for missing inputs (cost per person, current spend, baseline), ask the user for just those. Never invent them.\n' + a);
});
