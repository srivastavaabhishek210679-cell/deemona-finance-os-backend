// ============================================================
// Risk scores: explainable, rule-based scores for customers (late-payment risk), vendors (supply and payment-control risk)
// and revenue (concentration and trend). Every score lists the reasons behind it. No AI and no statistical model, so
// every number can be checked by hand. GET /api/risk
// ============================================================
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

const inrText = (n: number): string => {
  const a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e7) return sign + '₹' + (a / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return sign + '₹' + (a / 1e5).toFixed(2) + ' lakh';
  return sign + '₹' + Math.round(a).toLocaleString('en-IN');
};
const num = (v: any) => Number(v) || 0;
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
export const band = (s: number) => (s >= 50 ? 'High' : s >= 25 ? 'Medium' : 'Low');

export interface CustInput { id: string; name: string; open: number; overdue: number; max_days_overdue: number; credit_limit: number; paid_n: number; late_n: number; avg_days_late: number; total_open: number; }
export function scoreCustomer(c: CustInput) {
  const reasons: string[] = []; let score = 0;
  // 1. Payment history (35): how late this customer has paid in the past.
  const hist = c.paid_n >= 2;
  if (hist) {
    const s = 35 * clamp(c.avg_days_late / 60) * 0.7 + 35 * clamp(c.late_n / c.paid_n) * 0.3;
    score += s;
    if (c.avg_days_late > 5 || c.late_n > 0) reasons.push('Paid ' + c.late_n + ' of ' + c.paid_n + ' past invoices late' + (c.avg_days_late > 0 ? ', ' + c.avg_days_late.toFixed(0) + ' days late on average.' : '.'));
    else reasons.push('Has paid ' + c.paid_n + ' past invoices on time.');
  } else reasons.push('Fewer than 2 paid invoices on record, so there is not enough payment history to judge.');
  // 2. Overdue now (30)
  if (c.overdue > 0) {
    const share = c.open > 0 ? c.overdue / c.open : 0;
    score += 30 * (0.6 * clamp(c.max_days_overdue / 90) + 0.4 * clamp(share));
    reasons.push(inrText(c.overdue) + ' is overdue now, up to ' + c.max_days_overdue + ' days.');
  }
  // 3. Exposure (20): how much of all open receivables depends on this customer.
  const exposure = c.total_open > 0 ? c.open / c.total_open : 0;
  if (c.open > 0) { score += 20 * clamp((exposure - 0.1) / 0.5); if (exposure >= 0.3) reasons.push('Makes up ' + (exposure * 100).toFixed(0) + '% of everything owed to you.'); }
  // 4. Credit limit (15)
  if (c.credit_limit > 0 && c.open > 0) {
    const u = c.open / c.credit_limit; score += 15 * clamp((u - 0.7) / 0.5);
    if (u >= 0.8) reasons.push('Owes ' + (u * 100).toFixed(0) + '% of the ' + inrText(c.credit_limit) + ' credit limit.');
  }
  score = Math.round(clamp(score / 100, 0, 1) * 100);
  return { score, band: band(score), confidence: hist ? 'Based on payment history' : 'Low: little history', reasons };
}

export interface VendInput { id: string; name: string; blocked: boolean; has_gstin: boolean; has_pan: boolean; share_of_spend: number; overdue_to_them: number; max_days_overdue: number; spike: { ref: string; amount: number; avg: number } | null; duplicate: string | null; }
export function scoreVendor(v: VendInput) {
  const reasons: string[] = []; let score = 0;
  if (v.blocked) { score += 30; reasons.push('Marked as blocked.'); }
  if (!v.has_gstin) { score += 10; reasons.push('No GSTIN on record, so input tax credit may be at risk.'); }
  if (!v.has_pan) { score += 8; reasons.push('No PAN on record, which affects TDS deduction.'); }
  if (v.share_of_spend >= 0.3) { score += 12 * clamp((v.share_of_spend - 0.3) / 0.4 + 0.5); reasons.push('Receives ' + (v.share_of_spend * 100).toFixed(0) + '% of your supplier spend over the last 12 months.'); }
  if (v.overdue_to_them > 0) { score += 20 * clamp(v.max_days_overdue / 60); reasons.push('You owe them ' + inrText(v.overdue_to_them) + ' past due, up to ' + v.max_days_overdue + ' days. This can disrupt supply.'); }
  if (v.spike) { score += 25; reasons.push('Bill ' + v.spike.ref + ' of ' + inrText(v.spike.amount) + ' is ' + (v.spike.amount / v.spike.avg).toFixed(1) + ' times their usual bill of ' + inrText(v.spike.avg) + '. Check before paying.'); }
  if (v.duplicate) { score += 25; reasons.push('Possible duplicate: ' + v.duplicate); }
  score = Math.round(clamp(score / 100, 0, 1) * 100);
  return { score, band: band(score), reasons };
}

export async function buildRisk(pool: Pool, t: string) {
  // Customers
  const open = (await pool.query(
    `SELECT c.id::text AS id, c.name, c.credit_limit::float8 AS credit_limit,
            COALESCE(SUM(a.balance_due),0)::float8 AS open,
            COALESCE(SUM(a.balance_due) FILTER (WHERE a.due_date < CURRENT_DATE),0)::float8 AS overdue,
            COALESCE(MAX(CURRENT_DATE - a.due_date) FILTER (WHERE a.due_date < CURRENT_DATE),0)::int AS max_days_overdue
       FROM customers c LEFT JOIN ar_invoices a ON a.customer_id=c.id AND a.tenant_id=c.tenant_id AND a.status IN ('sent','partially_paid','overdue') AND a.balance_due > 0
      WHERE c.tenant_id=$1 GROUP BY c.id, c.name, c.credit_limit`, [t])).rows;
  const hist = (await pool.query(
    `WITH last_pay AS (SELECT e.invoice_id, MAX(e.payment_date) AS paid_on FROM invoice_payment_events e WHERE e.tenant_id=$1 AND e.invoice_type='ar' GROUP BY e.invoice_id)
     SELECT a.customer_id::text AS id, COUNT(*)::int AS paid_n, COUNT(*) FILTER (WHERE lp.paid_on > a.due_date + 5)::int AS late_n,
            COALESCE(AVG(GREATEST(lp.paid_on - a.due_date, 0)),0)::float8 AS avg_days_late
       FROM ar_invoices a JOIN last_pay lp ON lp.invoice_id=a.id
      WHERE a.tenant_id=$1 AND a.status='paid' AND a.due_date > CURRENT_DATE - INTERVAL '18 months' GROUP BY a.customer_id`, [t])).rows;
  const hm = new Map<string, any>(hist.map((h: any) => [h.id, h]));
  const totalOpen = open.reduce((a: number, c: any) => a + num(c.open), 0);
  const customers = open.filter((c: any) => num(c.open) > 0 || hm.has(c.id)).map((c: any) => {
    const h = hm.get(c.id) || {};
    const r = scoreCustomer({ id: c.id, name: c.name, open: num(c.open), overdue: num(c.overdue), max_days_overdue: num(c.max_days_overdue), credit_limit: num(c.credit_limit),
      paid_n: num(h.paid_n), late_n: num(h.late_n), avg_days_late: num(h.avg_days_late), total_open: totalOpen });
    return { id: c.id, name: c.name, owed_inr: inrText(num(c.open)), owed: num(c.open), ...r };
  }).sort((a: any, b: any) => b.score - a.score || b.owed - a.owed).slice(0, 25);

  // Vendors
  const spend = (await pool.query(
    `SELECT v.id::text AS id, v.name, COALESCE(v.is_blocked,false) AS blocked, (v.gstin IS NOT NULL AND v.gstin <> '') AS has_gstin, (v.pan IS NOT NULL AND v.pan <> '') AS has_pan,
            COALESCE(SUM(a.total_amount) FILTER (WHERE a.date > CURRENT_DATE - INTERVAL '12 months' AND a.status NOT IN ('draft','rejected')),0)::float8 AS spend,
            COALESCE(SUM(a.balance_due) FILTER (WHERE a.status IN ('approved','overdue') AND a.due_date < CURRENT_DATE),0)::float8 AS overdue_to_them,
            COALESCE(MAX(CURRENT_DATE - a.due_date) FILTER (WHERE a.status IN ('approved','overdue') AND a.balance_due > 0 AND a.due_date < CURRENT_DATE),0)::int AS max_days_overdue
       FROM vendors v LEFT JOIN ap_invoices a ON a.vendor_id=v.id AND a.tenant_id=v.tenant_id WHERE v.tenant_id=$1 GROUP BY v.id, v.name, v.is_blocked, v.gstin, v.pan`, [t])).rows;
  const totalSpend = spend.reduce((a: number, v: any) => a + num(v.spend), 0);
  const bills = (await pool.query(
    `SELECT vendor_id::text AS vid, invoice_number AS ref, total_amount::float8 AS amt, date::text AS d FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','rejected') AND date > CURRENT_DATE - INTERVAL '12 months' ORDER BY date ASC`, [t])).rows;
  const byV = new Map<string, any[]>(); for (const b of bills) { (byV.get(b.vid) || byV.set(b.vid, []).get(b.vid)!).push(b); }
  const vendors = spend.map((v: any) => {
    const bs = byV.get(v.id) || []; let spike: any = null, dup: string | null = null;
    if (bs.length >= 4) { const last = bs[bs.length - 1], prev = bs.slice(0, -1), avg = prev.reduce((a: number, x: any) => a + x.amt, 0) / prev.length; if (avg > 0 && last.amt > 3 * avg) spike = { ref: last.ref, amount: last.amt, avg }; }
    const seen = new Map<string, any>(); for (const b of bs) { const k = Math.round(b.amt) + '|' + b.d.slice(0, 7); if (seen.has(k)) { dup = seen.get(k).ref + ' and ' + b.ref + ' are for the same amount (' + inrText(b.amt) + ') in the same month.'; break; } seen.set(k, b); }
    const r = scoreVendor({ id: v.id, name: v.name, blocked: !!v.blocked, has_gstin: !!v.has_gstin, has_pan: !!v.has_pan, share_of_spend: totalSpend > 0 ? num(v.spend) / totalSpend : 0,
      overdue_to_them: num(v.overdue_to_them), max_days_overdue: num(v.max_days_overdue), spike, duplicate: dup });
    return { id: v.id, name: v.name, spend_inr: inrText(num(v.spend)), spend: num(v.spend), ...r };
  }).filter((v: any) => v.spend > 0 || v.score > 0).sort((a: any, b: any) => b.score - a.score || b.spend - a.spend).slice(0, 25);

  // Revenue
  const m = (await pool.query(
    `SELECT to_char(date_trunc('month', date),'YYYY-MM') AS ym, COALESCE(SUM(subtotal),0)::float8 AS v FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled') AND date >= date_trunc('month', CURRENT_DATE) - INTERVAL '6 months' AND date < date_trunc('month', CURRENT_DATE) GROUP BY 1 ORDER BY 1`, [t])).rows;
  const top = (await pool.query(
    `SELECT c.name, COALESCE(SUM(a.subtotal),0)::float8 AS v FROM ar_invoices a JOIN customers c ON c.id=a.customer_id WHERE a.tenant_id=$1 AND a.status NOT IN ('draft','cancelled') AND a.date > CURRENT_DATE - INTERVAL '12 months' GROUP BY c.name ORDER BY v DESC LIMIT 3`, [t])).rows;
  const tot12 = (await pool.query(`SELECT COALESCE(SUM(subtotal),0)::float8 AS v FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled') AND date > CURRENT_DATE - INTERVAL '12 months'`, [t])).rows[0].v;
  const revReasons: string[] = []; let rscore = 0;
  if (top.length && tot12 > 0) { const sh = top[0].v / tot12; rscore += 50 * clamp((sh - 0.2) / 0.5); if (sh >= 0.3) revReasons.push(top[0].name + ' brought ' + (sh * 100).toFixed(0) + '% of the last 12 months\' revenue.'); }
  const last3 = m.slice(-3).reduce((a: number, x: any) => a + x.v, 0), prev3 = m.slice(-6, -3).reduce((a: number, x: any) => a + x.v, 0);
  let trend: number | null = null;
  if (m.length >= 6 && prev3 > 0) { trend = (last3 - prev3) / prev3 * 100; if (trend < 0) { rscore += 50 * clamp(-trend / 40); revReasons.push('Revenue over the last 3 completed months is ' + Math.abs(trend).toFixed(0) + '% lower than the 3 months before.'); } }
  else revReasons.push('Fewer than 6 completed months of invoices, so a revenue trend cannot be judged yet.');
  rscore = Math.round(clamp(rscore / 100, 0, 1) * 100);
  const flags = [...customers.filter((c: any) => c.band === 'High').map((c: any) => ({ kind: 'customer', name: c.name, text: 'High late-payment risk: ' + c.reasons[0] })),
                 ...vendors.filter((v: any) => v.band === 'High').map((v: any) => ({ kind: 'vendor', name: v.name, text: 'High vendor risk: ' + v.reasons[0] }))];
  return { customers, vendors, revenue: { score: rscore, band: band(rscore), reasons: revReasons, top_customers: top.map((x: any) => ({ name: x.name, share_pct: tot12 > 0 ? Math.round(x.v / tot12 * 100) : 0 })), trend_pct: trend === null ? null : Math.round(trend) }, flags };
}

export function createRiskRouter(pool: Pool): Router {
  const router = Router();
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      res.json({ ...(await buildRisk(pool, (req as any).user.tenantId)),
        note: 'Scores run from 0 (safe) to 100 (risky) and come from simple rules on your own invoices and payments. Each score lists its reasons.' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  return router;
}
