// Autonomous-CFO tools: shortfall_action_plan (who to chase, which bills to defer, effect on cash) and revenue_root_cause
// (why revenue moved: lost/new/changed customers, price vs volume, business unit/region/product, seasonality). Idempotent. Run from the backend folder.
const fs = require('fs');

const PLAN = String.raw`// Shortfall action plan: when the cash forecast dips below a floor, name the receivables to secure and the bills to defer,
// with the cash effect of each step. All figures are computed here; nothing is sent or changed.
import { runForecast, FcItem, FcOpts } from './cashForecast';

const addDays = (s: string, n: number): string => new Date(new Date(s + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string): number => Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
const r0 = (n: number): number => Math.round(n);
export const inrTxt = (n: number): string => {
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(2) + ' lakh';
  return s + '₹' + Math.round(a).toLocaleString('en-IN');
};

export interface PlanAction { step: number; action: 'collect' | 'pull_forward' | 'defer'; ref: string; party: string; amount: number; due: string; new_due?: string; improves_lowest_cash_by: number; what_to_do: string; caution?: string; }

export function buildActionPlan(
  opening: { amount: number; has_entry: boolean }, items: FcItem[], today: string,
  p: { days: number; minCash: number; collectionRate: number; deferDays: number },
) {
  const days = Math.max(7, Math.min(180, p.days));
  const rate = Math.min(1, Math.max(0, p.collectionRate));
  const o: FcOpts = { days, ar_delay_days: 0, collection_pct: 100, ap_delay_days: 0, monthly_inflow: 0, monthly_outflow: 0 };
  // Receivables not yet secured are counted at collectionRate; secured ones at 100%. Bills at 100% on their due date.
  const secured = new Set<number>();
  const deferred = new Map<number, string>();
  const eff = (): FcItem[] => items.map((it, i) => {
    if (it.kind === 'in') return secured.has(i) ? it : { ...it, amount: it.amount * rate };
    return deferred.has(i) ? { ...it, due: deferred.get(i)!, overdue: false } : it;
  });
  const run = () => runForecast(opening.amount, eff(), o, today);
  const before = run();
  const out: any = {
    as_of: today, horizon_days: days, minimum_cash: p.minCash,
    assumptions: {
      receivables_collected_on_time_pct: Math.round(rate * 100), bills_paid_on_due_date: true, defer_days: p.deferDays,
      includes: 'open sales invoices, approved vendor bills, and salary and tax items when payroll data exists (salary and statutory items are never deferred)', excludes: 'spend not yet invoiced',
    },
    before: { lowest_cash: before.lowest.amount, lowest_cash_date: before.lowest.date, first_negative_date: before.first_negative, closing_cash: before.closing },
  };
  if (!opening.has_entry) { out.status = 'no_cash_entry'; out.message = 'No cash balance has been entered, so a shortfall cannot be judged. Record the current cash balance first.'; return out; }
  const gap0 = Math.max(0, p.minCash - before.lowest.amount);
  if (gap0 <= 0) { out.status = 'no_shortfall'; out.message = 'Cash stays at or above ' + inrTxt(p.minCash) + ' for the next ' + days + ' days under these assumptions. Lowest point: ' + inrTxt(before.lowest.amount) + ' on ' + before.lowest.date + '.'; out.gap_to_close = 0; out.actions = []; return out; }

  const recvIdx = items.map((it, i) => ({ it, i })).filter(x => x.it.kind === 'in' && rate < 1 && x.it.amount > 0).sort((a, b) => b.it.amount - a.it.amount).slice(0, 25).map(x => x.i);
  const billIdx = items.map((it, i) => ({ it, i })).filter(x => x.it.kind === 'out' && !x.it.category && !x.it.overdue && x.it.amount > 0 && daysBetween(today, x.it.due) >= 0 && daysBetween(today, x.it.due) <= days)
    .sort((a, b) => b.it.amount - a.it.amount).slice(0, 25).map(x => x.i);

  const actions: PlanAction[] = [];
  const pulled = new Map<number, string>();
  const deferLens = Array.from(new Set([p.deferDays, 30, 45, 60])).sort((x, y) => x - y);
  const pullLens = [15, 30];
  const eff2 = (): FcItem[] => items.map((it, i) => {
    if (it.kind === 'in') return secured.has(i) ? (pulled.has(i) ? { ...it, due: pulled.get(i)!, overdue: false } : it) : { ...it, amount: it.amount * rate };
    return deferred.has(i) ? { ...it, due: deferred.get(i)!, overdue: false } : it;
  });
  const run2 = () => runForecast(opening.amount, eff2(), o, today);
  type Opt = { kind: 'collect' | 'pull_forward' | 'defer'; i: number; days: number; gain: number; resolves: boolean; rank: number };
  let current2 = before.lowest.amount;
  for (let step = 1; step <= 12 && current2 < p.minCash; step++) {
    const need = p.minCash - current2;
    const picks: Opt[] = [];
    for (const i of recvIdx) {
      if (secured.has(i)) continue;
      const it = items[i];
      const opts: Opt[] = [];
      secured.add(i); opts.push({ kind: 'collect', i, days: 0, gain: run2().lowest.amount - current2, resolves: false, rank: 0 });
      if (!it.overdue) for (const d of pullLens) {
        const nd = addDays(it.due, -d); if (nd <= addDays(today, 2)) continue;
        pulled.set(i, nd); opts.push({ kind: 'pull_forward', i, days: d, gain: run2().lowest.amount - current2, resolves: false, rank: 1 + d / 100 }); pulled.delete(i);
      }
      secured.delete(i);
      opts.forEach(x => { x.resolves = x.gain >= need - 1; });
      const ok = opts.filter(x => x.gain > 1); if (!ok.length) continue;
      const res = ok.filter(x => x.resolves).sort((x, y) => x.rank - y.rank)[0];
      picks.push(res || ok.sort((x, y) => y.gain - x.gain || x.rank - y.rank)[0]);
    }
    for (const i of billIdx) {
      if (deferred.has(i)) continue;
      const it = items[i]; const opts: Opt[] = [];
      for (const d of deferLens) { deferred.set(i, addDays(it.due, d)); opts.push({ kind: 'defer', i, days: d, gain: run2().lowest.amount - current2, resolves: false, rank: 3 + d / 100 }); deferred.delete(i); }
      opts.forEach(x => { x.resolves = x.gain >= need - 1; });
      const ok = opts.filter(x => x.gain > 1); if (!ok.length) continue;
      const res = ok.filter(x => x.resolves).sort((x, y) => x.rank - y.rank)[0];
      picks.push(res || ok.sort((x, y) => y.gain - x.gain || x.rank - y.rank)[0]);
    }
    if (!picks.length) break;
    const resolving = picks.filter(x => x.resolves).sort((x, y) => x.rank - y.rank || y.gain - x.gain);
    const best = resolving.length ? resolving[0] : picks.sort((x, y) => y.gain - x.gain || x.rank - y.rank)[0];
    const it = items[best.i];
    if (best.kind === 'collect' || best.kind === 'pull_forward') {
      secured.add(best.i);
      const late = it.overdue ? 'overdue by ' + daysBetween(it.due, today) + ' days' : 'due ' + it.due;
      if (best.kind === 'pull_forward') {
        const nd = addDays(it.due, -best.days); pulled.set(best.i, nd);
        actions.push({ step, action: 'pull_forward', ref: it.ref, party: it.party, amount: r0(it.amount), due: it.due, new_due: nd, improves_lowest_cash_by: r0(best.gain),
          what_to_do: 'Ask ' + (it.party || 'the customer') + ' to pay ' + it.ref + ' (' + inrTxt(it.amount) + ') by ' + nd + ', ' + best.days + ' days before its due date of ' + it.due + '.',
          caution: 'Needs the customer to agree. An early-payment discount may be the price; weigh it against the cost of the shortfall.' });
      } else {
        actions.push({ step, action: 'collect', ref: it.ref, party: it.party, amount: r0(it.amount), due: it.due, improves_lowest_cash_by: r0(best.gain),
          what_to_do: 'Collect ' + inrTxt(it.amount) + ' from ' + (it.party || 'the customer') + ' (' + it.ref + ', ' + late + ') in full and on time.' });
      }
    } else {
      const nd = addDays(it.due, best.days); deferred.set(best.i, nd);
      actions.push({ step, action: 'defer', ref: it.ref, party: it.party, amount: r0(it.amount), due: it.due, new_due: nd, improves_lowest_cash_by: r0(best.gain),
        what_to_do: 'Pay ' + (it.party || 'the vendor') + ' (' + it.ref + ', ' + inrTxt(it.amount) + ') on ' + nd + ' instead of ' + it.due + ' (' + best.days + ' days later).',
        caution: 'Check payment terms and the vendor relationship first. A micro or small enterprise supplier must be paid within 45 days of acceptance.' });
    }
    current2 = run2().lowest.amount;
  }
  const run3 = run2;
  const after = run3();
  const collectTotal = actions.filter(a => a.action !== 'defer').reduce((s, a) => s + a.amount, 0);
  const deferTotal = actions.filter(a => a.action === 'defer').reduce((s, a) => s + a.amount, 0);
  const remaining = Math.max(0, p.minCash - after.lowest.amount);
  out.gap_to_close = r0(gap0);
  out.actions = actions;
  out.collect_total = r0(collectTotal); out.defer_total = r0(deferTotal);
  out.after = { lowest_cash: after.lowest.amount, lowest_cash_date: after.lowest.date, first_negative_date: after.first_negative, closing_cash: after.closing };
  out.remaining_gap = r0(remaining);
  out.status = remaining <= 0 ? 'shortfall_resolved' : (actions.length ? 'shortfall_reduced' : 'no_action_found');
  out.message = remaining <= 0
    ? (() => { const nc = actions.filter(a => a.action !== 'defer').length, nd = actions.filter(a => a.action === 'defer').length;
        return (nc ? 'Collect ' + inrTxt(collectTotal) + ' from ' + nc + (nc === 1 ? ' customer' : ' customers') + (actions.some(a => a.action === 'pull_forward') ? ' (some earlier than due)' : '') : '') + (nc && nd ? ' and ' : '') + (nd ? 'defer ' + nd + (nd === 1 ? ' bill' : ' bills') + ' (' + inrTxt(deferTotal) + ')' : '')
          + ' to keep cash at or above ' + inrTxt(p.minCash) + ' for the next ' + days + ' days.'; })()
    : (actions.length ? 'These steps reduce the gap but ' + inrTxt(remaining) + ' is still missing. Further funding, a larger deferral or faster collections would be needed.' : 'No receivable or bill change closes the gap. External funding or cost cuts would be needed.');
  return out;
}
`;

const ROUTE = String.raw`// GET /api/action-plan?days=90&min_cash=0&collection=70&defer_days=14
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { loadForecastInputs } from '../services/cashForecast';
import { buildActionPlan } from '../services/actionPlan';

export function createActionPlanRouter(pool: Pool): Router {
  const router = Router();
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = (req as any).user.tenantId;
      const q = req.query;
      const { opening, items, today } = await loadForecastInputs(pool, t);
      const plan = buildActionPlan(opening, items, today, {
        days: parseInt(String(q.days || '90'), 10) || 90,
        minCash: Math.max(0, Number(q.min_cash) || 0),
        collectionRate: Math.min(100, Math.max(0, q.collection !== undefined ? Number(q.collection) : 70)) / 100,
        deferDays: Math.max(1, Math.min(60, parseInt(String(q.defer_days || '14'), 10) || 14)),
      });
      res.json({ ...plan, note: 'Suggestions only. Nothing is sent, paid or changed automatically.' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  return router;
}
`;

const METRIC_BLOCK = String.raw`
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
`;

function rd(p) { let s = fs.readFileSync(p, 'utf8'); const bom = s.charCodeAt(0) === 0xFEFF; if (bom) s = s.slice(1); const crlf = s.includes('\r\n'); if (crlf) s = s.replace(/\r\n/g, '\n'); return { s, bom, crlf }; }
function wr(p, o, s) { fs.writeFileSync(p, (o.bom ? '﻿' : '') + (o.crlf ? s.replace(/\n/g, '\r\n') : s)); console.log('patched', p); }
function put(p, c) { if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== c) { fs.writeFileSync(p, c); console.log('wrote', p); } else console.log('up to date', p); }
function patch(p, fn) { if (!fs.existsSync(p)) { console.log('MISSING', p); process.exitCode = 1; return; } const o = rd(p); const t = fn(o.s); if (t !== o.s) wr(p, o, t); else console.log('no change', p); }

put('src/services/actionPlan.ts', PLAN);
put('src/routes/actionPlanRoutes.ts', ROUTE);

patch('src/services/cfoMetrics.ts', s => {
  if (s.includes('/*decision-tools*/')) return s;
  const a = 'export const METRICS: Record<string, Metric> = {\n';
  if (!s.includes(a)) { console.log('cfoMetrics anchor not found'); process.exit(1); }
  s = s.replace(a, a + METRIC_BLOCK);
  return s.replace("import { cashAsOf } from './cashPosition';", "import { cashAsOf } from './cashPosition';\nimport { loadForecastInputs } from './cashForecast';\nimport { buildActionPlan } from './actionPlan';");
});

patch('src/index.ts', s => {
  if (s.includes('createActionPlanRouter')) return s;
  const imp = "import { createRecommendationRouter } from './routes/recommendationRoutes';";
  const use = "app.use('/api/recommendations', createRecommendationRouter(pool));";
  if (!s.includes(imp) || !s.includes(use)) { console.log('index anchors not found'); process.exit(1); }
  return s.replace(imp, imp + "\nimport { createActionPlanRouter } from './routes/actionPlanRoutes';").replace(use, use + "\napp.use('/api/action-plan', createActionPlanRouter(pool));");
});

patch('src/routes/cfoAgentRoutes.ts', s => {
  if (s.includes('shortfall_action_plan')) return s;
  const a = '- Get every figure from the tools. Never estimate or recall numbers.';
  if (!s.includes(a)) { console.log('prompt anchor not found'); process.exit(1); }
  return s.replace(a, '- For "how do we avoid a cash shortage / what should we collect or delay" use shortfall_action_plan and present its actions in order, with the before and after cash. For "why did revenue change" use revenue_root_cause and lead with the largest driver, then the evidence. Both are suggestions: say nothing has been executed.\n' + a);
});
