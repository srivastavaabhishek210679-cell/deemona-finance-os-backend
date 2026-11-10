// Simple run-rate what-if model. Baseline = average of the last completed months of actuals (or amounts the user assumes).
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
