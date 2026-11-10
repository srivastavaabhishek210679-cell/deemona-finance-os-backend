// Collection risk: a transparent, rule-based score (0-100) per customer from payment history and open invoices.
// Not a statistical model and not an accounting provision: every point and every rate is visible in the output.
export interface RiskEvent { customer_id: string; customer: string; invoice_id: string; amount: number; payment_date: string; due_date: string; }
export interface OpenInv { customer_id: string; customer: string; invoice_id: string; invoice_number: string; balance: number; due_date: string; }

const day = (s: string): number => Math.floor(new Date(String(s).slice(0, 10) + 'T00:00:00Z').getTime() / 86400000);
const r1 = (n: number): number => Math.round(n * 10) / 10;
const r0 = (n: number): number => Math.round(n);
export const inrRisk = (n: number): string => { const a = Math.abs(n), s = n < 0 ? '-' : ''; return a >= 1e7 ? s + '₹' + (a / 1e7).toFixed(2) + ' Cr' : a >= 1e5 ? s + '₹' + (a / 1e5).toFixed(2) + ' lakh' : s + '₹' + Math.round(a).toLocaleString('en-IN'); };

// Chance that a balance of this age is not collected within the next quarter (before the customer score adjusts it).
export const BASE_LOSS_RATE: { max_days_overdue: number; rate: number; label: string }[] = [
  { max_days_overdue: 0, rate: 0.01, label: 'not yet due' }, { max_days_overdue: 30, rate: 0.02, label: '1-30 days overdue' },
  { max_days_overdue: 60, rate: 0.05, label: '31-60 days overdue' }, { max_days_overdue: 90, rate: 0.12, label: '61-90 days overdue' },
  { max_days_overdue: 180, rate: 0.25, label: '91-180 days overdue' }, { max_days_overdue: 100000, rate: 0.5, label: 'over 180 days overdue' },
];
const baseRate = (daysOver: number): number => (BASE_LOSS_RATE.find(b => daysOver <= b.max_days_overdue) || BASE_LOSS_RATE[BASE_LOSS_RATE.length - 1]).rate;

function wavg(ev: { amount: number; late: number }[]): number | null { const t = ev.reduce((s, e) => s + e.amount, 0); return t > 0 ? ev.reduce((s, e) => s + e.amount * e.late, 0) / t : null; }

export function scoreCollectionRisk(events: RiskEvent[], open: OpenInv[], todayYmd: string, limit: number) {
  const today = day(todayYmd);
  const byCust = new Map<string, { name: string; ev: { amount: number; late: number; age: number; inv: string }[]; open: OpenInv[] }>();
  const slot = (id: string, name: string) => { if (!byCust.has(id)) byCust.set(id, { name: name || 'Unknown', ev: [], open: [] }); return byCust.get(id)!; };
  for (const e of events) slot(e.customer_id, e.customer).ev.push({ amount: e.amount, late: day(e.payment_date) - day(e.due_date), age: today - day(e.payment_date), inv: e.invoice_id });
  for (const o of open) slot(o.customer_id, o.customer).open.push(o);

  const out: any[] = [];
  let totalOpen = 0, totalLoss = 0;
  const bands = { high: 0, medium: 0, low: 0 }; let highExposure = 0;
  byCust.forEach((c, cid) => {
    if (!c.open.length) return;
    const openBal = c.open.reduce((s, o) => s + o.balance, 0);
    const over = c.open.filter(o => day(o.due_date) < today);
    const overdueAmt = over.reduce((s, o) => s + o.balance, 0);
    const maxOver = over.length ? Math.max(...over.map(o => today - day(o.due_date))) : 0;
    const histInv = new Set(c.ev.map(e => e.inv)).size;
    const avgLate = wavg(c.ev);
    const lateAmt = c.ev.filter(e => e.late > 7).reduce((s, e) => s + e.amount, 0), evAmt = c.ev.reduce((s, e) => s + e.amount, 0);
    const lateRate = evAmt > 0 ? lateAmt / evAmt : null;
    const recent = c.ev.filter(e => e.age <= 90), prior = c.ev.filter(e => e.age > 90 && e.age <= 180);
    const rA = recent.length >= 2 ? wavg(recent) : null, pA = prior.length >= 2 ? wavg(prior) : null;
    const trend = rA !== null && pA !== null ? (rA - pA > 10 ? 'slowing' : rA - pA < -10 ? 'improving' : 'stable') : 'unknown';

    const pts = { overdue_age: 0, payment_history: 0, late_payment_rate: 0, slowing_down: 0, overdue_share: 0 };
    pts.overdue_age = maxOver > 90 ? 40 : maxOver > 60 ? 32 : maxOver > 30 ? 22 : maxOver > 0 ? 10 : 0;
    const al = avgLate === null ? 0 : avgLate;
    pts.payment_history = al > 45 ? 30 : al > 30 ? 24 : al > 15 ? 16 : al > 5 ? 8 : 0;
    pts.late_payment_rate = lateRate === null ? 0 : Math.round(lateRate * 15);
    pts.slowing_down = trend === 'slowing' ? 10 : 0;
    pts.overdue_share = Math.round((overdueAmt / openBal) * 5);
    const score = pts.overdue_age + pts.payment_history + pts.late_payment_rate + pts.slowing_down + pts.overdue_share;
    const band = score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low';
    const mult = 0.5 + score / 100;
    const loss = c.open.reduce((s, o) => s + o.balance * Math.min(1, baseRate(Math.max(0, today - day(o.due_date))) * mult), 0);

    const reasons: string[] = [];
    if (maxOver > 0) reasons.push('oldest unpaid invoice is ' + maxOver + ' days overdue (' + inrRisk(overdueAmt) + ' overdue in total)');
    if (avgLate !== null && avgLate > 5) reasons.push('has paid on average ' + Math.round(avgLate) + ' days after the due date');
    if (lateRate !== null && lateRate >= 0.5) reasons.push(Math.round(lateRate * 100) + '% of what they paid came more than 7 days late');
    if (trend === 'slowing') reasons.push('is paying slower than in the previous 90 days');
    if (trend === 'improving') reasons.push('is paying faster than in the previous 90 days');
    if (!histInv) reasons.push('no payment history recorded, so the score rests on overdue age only');
    if (!reasons.length) reasons.push('pays on time and nothing is overdue');

    totalOpen += openBal; totalLoss += loss;
    if (band === 'High') { bands.high++; highExposure += openBal; } else if (band === 'Medium') bands.medium++; else bands.low++;
    out.push({
      customer_id: cid, customer: c.name, risk_score: score, risk_band: band, open_balance: r0(openBal), overdue_amount: r0(overdueAmt), max_days_overdue: maxOver,
      expected_loss_amount: r0(loss), avg_days_paid_late: avgLate === null ? null : r1(avgLate), late_payment_rate_pct: lateRate === null ? null : Math.round(lateRate * 100),
      payment_trend: trend, paid_invoices_on_record: histInv, confidence: histInv >= 5 ? 'high' : histInv >= 2 ? 'medium' : 'low',
      score_breakdown: pts, reasons,
    });
  });
  out.sort((a, b) => b.expected_loss_amount - a.expected_loss_amount || b.risk_score - a.risk_score);
  return {
    as_of: todayYmd, customers_scored: out.length, total_open_ar: r0(totalOpen), expected_bad_debt_total: r0(totalLoss),
    expected_bad_debt_pct_of_ar: totalOpen > 0 ? r1((totalLoss / totalOpen) * 100) : 0,
    high_risk_customers: bands.high, medium_risk_customers: bands.medium, low_risk_customers: bands.low, high_risk_exposure_total: r0(highExposure),
    customers: out.slice(0, limit),
    method: [
      'Score 0-100: oldest overdue invoice (up to 40) + average days paid late (up to 30) + share of payments made over 7 days late (up to 15) + paying slower than before (10) + share of the open balance that is overdue (up to 5).',
      'Bands: High 70+, Medium 40-69, Low under 40.',
      'Expected bad debt for the next quarter = each open invoice times a base rate for its age (' + BASE_LOSS_RATE.map(b => b.label + ' ' + Math.round(b.rate * 100) + '%').join(', ') + '), scaled by 0.5 to 1.5 according to the customer score.',
    ],
    limits: ['An estimate from simple rules, not an accounting provision or a statistical forecast.', 'Customers with little payment history get a low-confidence score.', 'Only receipts recorded against invoices count as payment history.'],
  };
}
