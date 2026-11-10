// Shortfall action plan: when the cash forecast dips below a floor, name the receivables to secure and the bills to defer,
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
