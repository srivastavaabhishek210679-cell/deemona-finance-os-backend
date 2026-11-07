// ============================================================
// Payment prioritization: which approved bills to pay, in what order and on which date, keeping cash above a floor and
// capturing early-payment discounts that are worth more than the cost of money. All figures calculated in code (no AI).
// Discount terms are read from the vendor's payment terms text in the usual form "2/10 net 30" (2% if paid within 10 days, else due in 30).
// GET /api/payment-plan?min_cash=0&hurdle=12
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

// "2/10 net 30", "2/10, n/30", "2% 10 net 30" -> { pct: 2, days: 10, net: 30 }
export function parseDiscountTerms(text: string | null | undefined): { pct: number; days: number; net: number } | null {
  if (!text) return null;
  const m = String(text).match(/(\d+(?:\.\d+)?)\s*%?\s*[\/ ]\s*(\d+)\s*[,;]?\s*(?:net|n)\s*[\/ ]?\s*(\d+)/i);
  if (!m) return null;
  const pct = parseFloat(m[1]), days = parseInt(m[2], 10), net = parseInt(m[3], 10);
  if (!(pct > 0 && pct < 50) || !(days >= 0) || !(net > days)) return null;
  return { pct, days, net };
}

export interface Bill { id: string; ref: string; party: string; amount: number; due: string; billDate: string; terms: string | null; }
export interface PlanRow { ref: string; party: string; amount_inr: string; tier: 'overdue' | 'discount' | 'due_soon' | 'scheduled' | 'deferred'; pay_on: string; pay_on_text: string; due_text: string; reason: string; saving_inr?: string; }

export function buildPaymentPlan(opening: number, arItems: FcItem[], bills: Bill[], today: string, minCash: number, hurdlePct: number) {
  const o: FcOpts = { days: 90, ar_delay_days: 0, collection_pct: 100, ap_delay_days: 0, monthly_inflow: 0, monthly_outflow: 0 };
  type Plan = { b: Bill; tier: PlanRow['tier']; payOn: string; reason: string; saving: number; annual?: number; locked: boolean };
  const plans: Plan[] = bills.map(b => {
    const dt = parseDiscountTerms(b.terms);
    const overdue = b.due < today;
    if (overdue) return { b, tier: 'overdue' as const, payOn: today, reason: 'Already ' + daysBetween(b.due, today) + ' day(s) past due.', saving: 0, locked: true };
    if (dt) {
      const deadline = addDays(b.billDate, dt.days);
      const annual = (dt.pct / (100 - dt.pct)) * (365 / Math.max(1, dt.net - dt.days)) * 100;
      if (deadline >= today && annual >= hurdlePct) {
        const saving = b.amount * dt.pct / 100;
        return { b, tier: 'discount' as const, payOn: deadline, reason: dt.pct + '% discount if paid by ' + longDate(deadline) + ', worth about ' + annual.toFixed(0) + '% a year, more than your ' + hurdlePct + '% cost of money.', saving, annual, locked: false };
      }
    }
    const soon = daysBetween(today, b.due) <= 7;
    return { b, tier: soon ? 'due_soon' as const : 'scheduled' as const, payOn: b.due, reason: soon ? 'Due within a week.' : 'Pay on the due date; paying earlier only uses up cash.', saving: 0, locked: false };
  });

  const run = () => {
    const outs: FcItem[] = plans.map(p => ({ kind: 'out' as const, ref: p.b.ref, party: p.b.party, amount: p.b.amount, due: p.payOn, overdue: p.payOn <= today }));
    return runForecast(opening, [...arItems, ...outs], o, today);
  };
  let f = run();
  // A discount is only worth taking if the cash can afford it: if the plan breaches the floor, drop the discount that helps most to drop.
  for (const p of plans.filter(x => x.tier === 'discount').sort((a, b) => b.b.amount - a.b.amount)) {
    if (f.lowest.amount >= minCash) break;
    const before = f.lowest.amount; const old = p.payOn; p.payOn = p.b.due;
    const g = run();
    if (g.lowest.amount > before) { p.tier = 'scheduled'; p.reason = 'Discount skipped: paying early would push cash below ' + inrText(minCash) + '. Pay on the due date.'; p.saving = 0; f = g; } else p.payOn = old;
  }
  // If the plan dips below the cash floor, push back the least costly bills (no discount, not overdue), largest first, up to 14 days each.
  const deferrable = plans.filter(p => p.tier === 'scheduled' || p.tier === 'due_soon').sort((a, b) => b.b.amount - a.b.amount);
  for (const p of deferrable) {
    if (f.lowest.amount >= minCash) break;
    const before = f.lowest.amount;
    const old = p.payOn; p.payOn = addDays(p.b.due, 14);
    const g = run();
    if (g.lowest.amount > before) { p.tier = 'deferred'; p.reason = 'Paid 14 days after the due date to keep cash above ' + inrText(minCash) + '. Check supplier terms first: a micro or small enterprise supplier must be paid within 45 days of acceptance under Indian law.'; f = g; } else p.payOn = old;
  }
  const rank: Record<string, number> = { overdue: 0, discount: 1, due_soon: 2, scheduled: 3, deferred: 4 };
  const rows: PlanRow[] = plans.sort((a, b) => rank[a.tier] - rank[b.tier] || a.payOn.localeCompare(b.payOn) || b.b.amount - a.b.amount).map(p => ({
    ref: p.b.ref, party: p.b.party, amount_inr: inrText(p.b.amount), tier: p.tier, pay_on: p.payOn, pay_on_text: p.payOn <= today ? 'Today' : longDate(p.payOn), due_text: longDate(p.b.due), reason: p.reason,
    saving_inr: p.saving > 0 ? inrText(p.saving) : undefined }));
  const total = plans.reduce((a, p) => a + p.b.amount, 0), saved = plans.reduce((a, p) => a + p.saving, 0);
  const nowPay = plans.filter(p => p.payOn <= today).reduce((a, p) => a + p.b.amount, 0);
  return { rows, lowest_cash_inr: inrText(f.lowest.amount), lowest_date: longDate(f.lowest.date), breaches_floor: f.lowest.amount < minCash,
    warning: f.lowest.amount < minCash ? 'Even with this plan, cash falls to ' + inrText(f.lowest.amount) + ' on ' + longDate(f.lowest.date) + ', which is ' + inrText(minCash - f.lowest.amount) + ' below your minimum of ' + inrText(minCash) + '. Delaying bills alone cannot fix this: collect receivables earlier or arrange funds before that date.' : null, summary: {
    bills: plans.length, total_inr: inrText(total), pay_today_inr: inrText(nowPay), discount_savings_inr: inrText(saved), deferred: plans.filter(p => p.tier === 'deferred').length } };
}

export function createPaymentPlanRouter(pool: Pool): Router {
  const router = Router();
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = (req as any).user.tenantId;
      const minCash = Math.max(0, Number(req.query.min_cash) || 0);
      const hurdle = Math.max(0, Math.min(100, Number(req.query.hurdle) || 12));
      const { opening, items, today } = await loadForecastInputs(pool, t);
      const r = await pool.query(
        `SELECT a.id::text AS id, a.invoice_number AS ref, v.name AS party, a.balance_due::float8 AS amount, a.due_date::text AS due, a.date::text AS bill_date, v.payment_terms AS terms
           FROM ap_invoices a LEFT JOIN vendors v ON v.id = a.vendor_id WHERE a.tenant_id=$1 AND a.status IN ('approved','overdue') AND a.balance_due > 0`, [t]);
      const bills: Bill[] = r.rows.map((x: any) => ({ id: x.id, ref: x.ref, party: x.party || 'Vendor', amount: x.amount, due: x.due, billDate: x.bill_date, terms: x.terms }));
      const plan = buildPaymentPlan(opening.amount, items.filter(i => i.kind === 'in'), bills, today, minCash, hurdle);
      res.json({ as_of: today, min_cash_inr: inrText(minCash), hurdle_pct: hurdle, has_cash_entry: opening.has_entry, ...plan,
        note: 'Suggestions only: nothing is paid or scheduled for you. Discounts are read from each vendor\'s payment terms, written like "2/10 net 30".' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  return router;
}
