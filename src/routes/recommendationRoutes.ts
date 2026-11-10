// ============================================================
// Level 4 (Prescriptive): recommended actions, all computed in code from open invoices and bills.
// GET /api/recommendations?days=90&min_cash=0
// No AI is involved: every figure and sentence is built here, so nothing can be invented.
// ============================================================
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { runForecast, loadForecastInputs, FcOpts, FcItem } from '../services/cashForecast';

const inrText = (n: number): string => {
  const a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e7) return sign + '₹' + (a / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return sign + '₹' + (a / 1e5).toFixed(2) + ' lakh';
  return sign + '₹' + Math.round(a).toLocaleString('en-IN');
};
const addDays = (s: string, n: number) => new Date(new Date(s + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
const longDate = (s: string) => new Date(s + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });


function effectText(c: any, base: any, createsGap: any, today: string, days: number): string {
  const slipDate = addDays(c.expected, 30);
  const outside = slipDate > addDays(today, days);
  if (createsGap) return 'If it slips 30 days (to ' + longDate(slipDate) + '), cash goes negative on ' + longDate(c.slipped.first_negative) + '.';
  if (base.first_negative) return 'Cash is already forecast to go negative. If this slips 30 days, the lowest point falls to ' + inrText(c.slipped.lowest.amount) + '.';
  if (c.closeDrop > 1 || c.lowDrop > 1) return 'If it slips 30 days (to ' + longDate(slipDate) + '), ' + (c.closeDrop > 1 ? 'cash at day ' + days + ' falls by ' + inrText(c.closeDrop) : 'the lowest point falls by ' + inrText(c.lowDrop)) + (outside ? ', because it lands after the ' + days + '-day window.' : '.');
  return 'If it slips 30 days to ' + longDate(slipDate) + (outside ? ' (after the ' + days + '-day window)' : '') + ', your lowest cash point does not change and cash stays above zero.';
}

export interface Rec { priority: number; type: 'shortfall' | 'chase' | 'delay_bill' | 'data' | 'ok'; title: string; detail: string; amount_inr?: string; effect?: string; ref?: string; party?: string; }

export function buildRecommendations(opening: { amount: number; has_entry: boolean }, items: FcItem[], today: string, days: number, minCash: number): { recs: Rec[]; base: any } {
  const o: FcOpts = { days, ar_delay_days: 0, collection_pct: 100, ap_delay_days: 0, monthly_inflow: 0, monthly_outflow: 0 };
  const base = runForecast(opening.amount, items, o, today);
  const recs: Rec[] = [];

  if (!opening.has_entry) recs.push({ priority: 1, type: 'data', title: 'Record your current cash balance', detail: 'No cash balance entry exists, so every forecast starts from zero. Add one on the Cash Balance page.' });

  // 1. Shortfall: how much must be found, and whether chasing receivables covers it.
  const recv = items.filter(i => i.kind === 'in');
  if (base.first_negative) {
    const chaseTotal = recv.reduce((a, i) => a + i.amount, 0);
    recs.push({ priority: 1, type: 'shortfall', title: 'Cash is forecast to run out on ' + longDate(base.first_negative),
      detail: 'The lowest point is ' + inrText(base.lowest.amount) + ' on ' + longDate(base.lowest.date) + '. All open receivables together are ' + inrText(chaseTotal) + (chaseTotal >= base.shortfall ? ', which is enough to cover the gap if collected on time.' : ', which is not enough to cover the gap, so also consider delaying bills or arranging funds.'),
      amount_inr: inrText(base.shortfall) });
  }

  // 2. Receivables to chase: biggest damage if the invoice slips 30 days; overdue first.
  const chase = recv.map(i => {
    const slipped = runForecast(opening.amount, items.map(x => (x === i ? { ...x, due: addDays(x.overdue ? addDays(today, 7) : x.due, 30), overdue: false } : x)), o, today);
    const expected = i.overdue ? addDays(today, 7) : i.due;
    return { i, slipped, expected, lowDrop: base.lowest.amount - slipped.lowest.amount, closeDrop: base.closing - slipped.closing };
  }).sort((a, b) => (Number(b.i.overdue) - Number(a.i.overdue)) || (b.i.amount - a.i.amount)).slice(0, 5);
  chase.forEach((c, idx) => {
    const late = c.i.overdue ? ('overdue by ' + daysBetween(c.i.due, today) + ' days') : ('due ' + longDate(c.i.due));
    const createsGap = !base.first_negative && c.slipped.first_negative;
    recs.push({ priority: 2 + idx, type: 'chase', ref: c.i.ref, party: c.i.party,
      title: 'Chase ' + (c.i.party || 'customer') + ' for ' + c.i.ref,
      amount_inr: inrText(c.i.amount),
      detail: inrText(c.i.amount) + ' ' + late + '. The forecast expects it around ' + longDate(c.expected) + '.',
      effect: effectText(c, base, createsGap, today, days) });
  });

  // 3. Bills that could be delayed 14 days without breaching the minimum cash level.
  const pay = items.filter(i => i.kind === 'out' && !i.category && !i.overdue && daysBetween(today, i.due) <= 30 && daysBetween(today, i.due) >= 0).sort((a, b) => b.amount - a.amount).slice(0, 5);
  let nDelay = 0;
  for (const b of pay) {
    const after = runForecast(opening.amount, items.map(x => (x === b ? { ...x, due: addDays(x.due, 14) } : x)), o, today);
    if (after.lowest.amount >= minCash && after.lowest.amount >= base.lowest.amount) {
      if (base.lowest.amount < minCash || after.lowest.amount > base.lowest.amount + 1) {
        recs.push({ priority: 10 + nDelay++, type: 'delay_bill', ref: b.ref, party: b.party, title: 'Consider paying ' + (b.party || 'vendor') + ' (' + b.ref + ') 14 days later',
          amount_inr: inrText(b.amount), detail: inrText(b.amount) + ' is due ' + longDate(b.due) + '.',
          effect: 'Lowest cash improves from ' + inrText(base.lowest.amount) + ' to ' + inrText(after.lowest.amount) + '. Check payment terms first: a micro or small enterprise supplier must be paid within 45 days of acceptance under Indian law, and late fees may apply.' });
      }
    }
  }

  if (!recs.some(r => r.type !== 'data')) recs.push({ priority: 99, type: 'ok', title: 'Nothing urgent', detail: 'No receivables to chase and no shortfall in the next ' + days + ' days.' });
  recs.sort((a, b) => a.priority - b.priority);
  return { recs, base };
}

export function createRecommendationRouter(pool: Pool): Router {
  const router = Router();
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = (req as any).user.tenantId;
      const days = Math.max(7, Math.min(365, parseInt(String(req.query.days || '90'), 10) || 90));
      const minCash = Math.max(0, Number(req.query.min_cash) || 0);
      const { opening, items, today } = await loadForecastInputs(pool, t);
      const { recs, base } = buildRecommendations(opening, items, today, days, minCash);
      res.json({ as_of: today, horizon_days: days, min_cash_inr: inrText(minCash), lowest_cash_inr: inrText(base.lowest.amount), recommendations: recs,
        note: 'Suggestions only. They are calculated from your open invoices and bills; nothing is sent or changed automatically.' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  return router;
}
