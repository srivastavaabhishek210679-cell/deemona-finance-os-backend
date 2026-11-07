// ============================================================
// Cash forecast (Predictive Twin). Pure arithmetic over your own books: opening cash from the Cash Balance page,
// open sales invoices (receipts) and open bills (payments) by due date, plus assumptions you type in.
// No AI is involved in any number here. Nothing is stored.
// ============================================================
import { Pool } from 'pg';
import { cashAsOf } from './cashPosition';

export interface FcItem { kind: 'in' | 'out'; ref: string; party: string; amount: number; due: string; overdue: boolean; }
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

export async function loadForecastInputs(pool: Pool, tenantId: string): Promise<{ opening: any; items: FcItem[]; today: string }> {
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
  return { opening, items, today };
}
