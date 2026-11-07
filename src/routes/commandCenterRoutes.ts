// ============================================================
// CFO Command Center: the questions executives actually ask, answered by code (no AI), from open invoices,
// recent P&L and the 365-day cash model. GET /api/command-center?drop=25&share=80
// ============================================================
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { runForecast, loadForecastInputs, FcOpts, FcItem, FcResult } from '../services/cashForecast';
import { runMetric } from '../services/cfoMetrics';

const inrText = (n: number): string => {
  const a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e7) return sign + '₹' + (a / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return sign + '₹' + (a / 1e5).toFixed(2) + ' lakh';
  return sign + '₹' + Math.round(a).toLocaleString('en-IN');
};
const longDate = (s: string) => new Date(s + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const daysBetween = (a: string, b: string) => Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
const num = (v: any) => Number(v) || 0;

export interface Card { key: string; question: string; headline: string; details: string[]; table?: { columns: string[]; rows: string[][] }; needs_data?: boolean; }

const OPTS = (inflow: number, outflow: number, pct = 100): FcOpts => ({ days: 365, ar_delay_days: 0, collection_pct: pct, ap_delay_days: 0, monthly_inflow: inflow, monthly_outflow: outflow });
const lastsUntil = (f: FcResult, today: string) => f.first_negative ? 'cash runs out on ' + longDate(f.first_negative) + ' (' + daysBetween(today, f.first_negative) + ' days from now)' : 'cash stays above zero for the full 12 months';

export async function buildCommandCenter(pool: Pool, tenantId: string, dropPct: number, sharePct: number): Promise<{ as_of: string; assumptions: string[]; cards: Card[] }> {
  const { opening, items, today } = await loadForecastInputs(pool, tenantId);
  const cards: Card[] = [];

  // Monthly revenue and cost from the last 3 completed months of the P&L (invoiced basis).
  const pnl: any = await runMetric(pool, tenantId, 'pnl_trend', { months: 4 }).catch(() => null);
  const months: any[] = (pnl && pnl.months ? pnl.months : []).filter((m: any) => !m.partial_month);
  const used = months.slice(-3);
  const avg = (k: string) => used.length ? used.reduce((a, m) => a + num(m[k]), 0) / used.length : 0;
  const R = avg('revenue'), C = avg('vendor_costs') + avg('payroll') + avg('expense_claims');
  const haveRates = used.length > 0 && (R > 0 || C > 0);
  const assumptions = [
    'Opening cash is your latest recorded balance' + (opening.has_entry ? '' : ' (none recorded, so zero is used)') + ': ' + inrText(opening.amount) + '.',
    haveRates ? 'Typical month, from the last ' + used.length + ' completed month(s): revenue ' + inrText(R) + ', costs ' + inrText(C) + ' (supplier bills, payroll and approved expense claims).' : 'There is not enough completed-month history to estimate a typical month.',
    'Open invoices and approved bills are placed on their due dates; new sales are assumed to be collected in the month they are earned.',
  ];

  // 1. Concentration
  const recv = items.filter(i => i.kind === 'in');
  const byCust = new Map<string, { amt: number; overdue: number }>();
  for (const i of recv) { const k = i.party || 'Unnamed customer'; const e = byCust.get(k) || { amt: 0, overdue: 0 }; e.amt += i.amount; if (i.overdue) e.overdue += i.amount; byCust.set(k, e); }
  const ranked = Array.from(byCust.entries()).sort((a, b) => b[1].amt - a[1].amt);
  const total = ranked.reduce((a, r) => a + r[1].amt, 0);
  if (!ranked.length) cards.push({ key: 'concentration', question: 'Which customers hold ' + sharePct + '% of what we are owed?', headline: 'No open receivables.', details: [] });
  else {
    let cum = 0, n = 0; for (const r of ranked) { cum += r[1].amt; n++; if (cum / total * 100 >= sharePct) break; }
    let run = 0;
    cards.push({ key: 'concentration', question: 'Which customers hold ' + sharePct + '% of what we are owed?',
      headline: n + ' of ' + ranked.length + ' customer(s) hold ' + sharePct + '% or more of the ' + inrText(total) + ' owed to you.',
      details: [ranked[0][0] + ' alone is ' + (ranked[0][1].amt / total * 100).toFixed(0) + '% of open receivables.' + (ranked.reduce((a, r) => a + r[1].overdue, 0) > 0 ? ' ' + inrText(ranked.reduce((a, r) => a + r[1].overdue, 0)) + ' of the total is already overdue.' : '')],
      table: { columns: ['Customer', 'Owed', 'Share', 'Running total', 'Overdue'], rows: ranked.slice(0, 20).map(r => { run += r[1].amt; return [r[0], inrText(r[1].amt), (r[1].amt / total * 100).toFixed(1) + '%', (run / total * 100).toFixed(1) + '%', r[1].overdue > 0 ? inrText(r[1].overdue) : '-']; }) } });
  }

  // 2. Business unit cash use (supplier cost by business unit, year to date vs last year)
  const bu: any = await runMetric(pool, tenantId, 'breakdown_by_dimension', { dimension: 'business_unit', measure: 'vendor_costs', period: 'ytd_vs_prev_ytd' }).catch(() => null);
  if (!bu || bu.available === false || bu.error || !Array.isArray(bu.items)) {
    cards.push({ key: 'business_unit', question: 'Which business unit uses the most cash?', headline: 'Not available yet.', needs_data: true, details: [(bu && (bu.reason || bu.error)) || 'Business units are not set up. Add them in CFO Setup, then map vendors to them.'] });
  } else {
    const rows = bu.items.filter((x: any) => x.current > 0);
    cards.push({ key: 'business_unit', question: 'Which business unit uses the most cash?',
      headline: rows.length ? rows[0].name + ' has the most supplier cost this year so far: ' + inrText(rows[0].current) + ' (' + rows[0].share_pct + '% of the total).' : 'No supplier cost is recorded against any business unit yet.',
      details: [bu.warning || 'Supplier bills are used as a stand-in for cash use. Payroll is not split by business unit.'],
      table: rows.length ? { columns: ['Business unit', 'Supplier cost (year to date)', 'Share', 'Change vs last year'], rows: rows.map((x: any) => [x.name, inrText(x.current), x.share_pct + '%', x.change_pct == null ? '-' : x.change_pct + '%']) } : undefined });
  }

  // 3. Revenue drop
  if (!haveRates) {
    cards.push({ key: 'revenue_drop', question: 'What happens if revenue drops ' + dropPct + '%?', headline: 'Not enough history to estimate.', needs_data: true, details: ['This needs at least one completed month of invoices and costs.'] });
  } else {
    const base = runForecast(opening.amount, items, OPTS(R, C), today);
    const down = runForecast(opening.amount, items, OPTS(R * (1 - dropPct / 100), C), today);
    cards.push({ key: 'revenue_drop', question: 'What happens if revenue drops ' + dropPct + '%?',
      headline: 'New sales fall by ' + inrText(R * dropPct / 100) + ' a month, so cash after 12 months is ' + inrText(down.closing) + ' instead of ' + inrText(base.closing) + ' (' + inrText(down.closing - base.closing) + ').',
      details: ['As things stand, ' + lastsUntil(base, today) + '. With the drop, ' + lastsUntil(down, today) + '.', down.first_negative ? 'The funding gap at the lowest point would be ' + inrText(-down.lowest.amount) + ' on ' + longDate(down.lowest.date) + '.' : 'Lowest cash with the drop: ' + inrText(down.lowest.amount) + ' on ' + longDate(down.lowest.date) + '.'] });

    // 4. No sales at all
    const none = runForecast(opening.amount, items, OPTS(0, C), today);
    const noCollect = runForecast(opening.amount, items, OPTS(0, C, 0), today);
    cards.push({ key: 'no_sales', question: 'How long can we survive with no sales?',
      headline: none.first_negative ? 'About ' + daysBetween(today, none.first_negative) + ' days: ' + lastsUntil(none, today) + '.' : 'More than 12 months: ' + lastsUntil(none, today) + '.',
      details: ['This assumes no new sales, typical monthly costs of ' + inrText(C) + ', and open invoices still paid on their due dates.', 'If no open invoice were paid either, ' + lastsUntil(noCollect, today) + '.'] });

    // 5. Funding
    const need = base.first_negative ? -base.lowest.amount : 0;
    cards.push({ key: 'funding', question: 'When will we need funding?',
      headline: base.first_negative ? 'On current trends, from ' + longDate(base.first_negative) + '. The gap reaches ' + inrText(need) + ' by ' + longDate(base.lowest.date) + '.' : 'Not in the next 12 months on current trends. Lowest cash is ' + inrText(base.lowest.amount) + ' on ' + longDate(base.lowest.date) + '.',
      details: [down.first_negative && !base.first_negative ? 'A ' + dropPct + '% revenue drop would change that: funding would be needed from ' + longDate(down.first_negative) + '.' : 'Tax payments and any planned spending outside invoices and payroll are not included.'] });
  }
  return { as_of: today, assumptions, cards };
}

export function createCommandCenterRouter(pool: Pool): Router {
  const router = Router();
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const drop = Math.max(1, Math.min(90, parseInt(String(req.query.drop || '25'), 10) || 25));
      const share = Math.max(50, Math.min(95, parseInt(String(req.query.share || '80'), 10) || 80));
      res.json({ drop_pct: drop, share_pct: share, ...(await buildCommandCenter(pool, (req as any).user.tenantId, drop, share)),
        note: 'Every figure is calculated from your records. No AI is used on this page.' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  return router;
}
