// Spend optimization (backend): vendor concentration, spend jumps, possible duplicate bills, payment timing, budget overruns.
// Rule-based and transparent; nothing is changed or sent. Idempotent. Run from the backend folder.
// Needs apply-collection-risk-backend.cjs (and apply-controlled-actions-backend.cjs for the index mount) applied first.
const fs = require('fs');

const SVC = String.raw`// Spend optimization: finds where money may be leaking. Every finding states the rule that triggered it.
import { inrRisk } from './collectionRisk';

export interface SpendBill { vendor_id: string; vendor: string; number: string; date: string; due_date: string; status: string; total: number; paid: number; last_paid: string | null; }
export interface SpendBudget { name: string; department: string | null; fiscal_year: string | number | null; budgeted: number; spent: number; }

const day = (s: string): number => Math.floor(new Date(String(s).slice(0, 10) + 'T00:00:00Z').getTime() / 86400000);
const r0 = (n: number): number => Math.round(n);
const r1 = (n: number): number => Math.round(n * 10) / 10;
const ymOf = (s: string): string => String(s).slice(0, 7);
const shiftYm = (ym: string, back: number): string => { let [y, m] = ym.split('-').map(Number); m -= back; while (m < 1) { m += 12; y -= 1; } return y + '-' + String(m).padStart(2, '0'); };
const COUNTED = new Set(['approved', 'paid', 'overdue', 'partially_paid']);
const SEV: Record<string, number> = { high: 0, medium: 1, low: 2 };

export const SPEND_RULES = {
  concentration_top_vendor: 0.4, concentration_top3: 0.7, jump_ratio: 1.3, jump_min_increase: 50000, new_vendor_min_spend: 100000,
  duplicate_window_days: 7, duplicate_same_number_days: 45, early_days: 7, early_share_flag: 0.2, late_count_flag: 3, budget_warn: 0.9,
};

export function analyzeSpend(bills: SpendBill[], budgets: SpendBudget[], todayYmd: string, limit = 12) {
  const R = SPEND_RULES, today = day(todayYmd), curYm = ymOf(todayYmd);
  const counted = bills.filter(b => COUNTED.has(b.status) && today - day(b.date) <= 365 && b.total > 0);
  const findings: any[] = [];
  const add = (f: any) => findings.push(f);

  // 1. Vendor concentration (last 12 months)
  const byVendor = new Map<string, { name: string; total: number; bills: number }>();
  for (const b of counted) { const v = byVendor.get(b.vendor_id) || { name: b.vendor || 'Unknown', total: 0, bills: 0 }; v.total += b.total; v.bills++; byVendor.set(b.vendor_id, v); }
  const ranked = Array.from(byVendor.values()).sort((a, b) => b.total - a.total);
  const totalSpend = ranked.reduce((s, v) => s + v.total, 0);
  const topVendors = ranked.slice(0, 5).map(v => ({ vendor: v.name, spend: r0(v.total), share_of_spend_pct: r1(v.total / totalSpend * 100), bills_n: v.bills }));
  if (totalSpend > 0 && ranked.length >= 2) {
    const s1 = ranked[0].total / totalSpend, s3 = ranked.slice(0, 3).reduce((s, v) => s + v.total, 0) / totalSpend;
    if (s1 >= R.concentration_top_vendor) add({ type: 'vendor_concentration', severity: 'medium', vendor: ranked[0].name, amount_at_stake: r0(ranked[0].total),
      message: ranked[0].name + ' is ' + r0(s1 * 100) + '% of your vendor spend over the last 12 months (' + inrRisk(ranked[0].total) + '). A single large supplier gives you less room to negotiate and more risk if they fail to deliver.', rule: 'top vendor at least ' + r0(R.concentration_top_vendor * 100) + '% of spend' });
    else if (ranked.length > 3 && s3 >= R.concentration_top3) add({ type: 'vendor_concentration', severity: 'low', amount_at_stake: r0(ranked.slice(0, 3).reduce((s, v) => s + v.total, 0)),
      message: 'Your top 3 vendors are ' + r0(s3 * 100) + '% of vendor spend over the last 12 months.', rule: 'top 3 vendors at least ' + r0(R.concentration_top3 * 100) + '% of spend' });
  }

  // 2. Spend jumps: average of the last 3 completed months against the 3 before
  const monthly = new Map<string, Map<string, number>>();
  for (const b of counted) { const m = ymOf(b.date); if (!monthly.has(b.vendor_id)) monthly.set(b.vendor_id, new Map()); const mm = monthly.get(b.vendor_id)!; mm.set(m, (mm.get(m) || 0) + b.total); }
  const lastM = [1, 2, 3].map(i => shiftYm(curYm, i)), prevM = [4, 5, 6].map(i => shiftYm(curYm, i));
  monthly.forEach((mm, vid) => {
    const sum = (ms: string[]) => ms.reduce((s, m) => s + (mm.get(m) || 0), 0) / 3;
    const last = sum(lastM), prev = sum(prevM), name = byVendor.get(vid)?.name || 'Unknown';
    if (prev > 0 && last >= prev * R.jump_ratio && last - prev >= R.jump_min_increase) add({ type: 'spend_jump', severity: last >= prev * 2 ? 'high' : 'medium', vendor: name, amount_at_stake: r0((last - prev) * 3),
      message: 'Spend with ' + name + ' averaged ' + inrRisk(last) + ' a month over the last 3 months, against ' + inrRisk(prev) + ' a month in the 3 months before (up ' + r0((last / prev - 1) * 100) + '%). Check whether this is planned.', rule: 'recent 3-month average at least ' + R.jump_ratio + 'x the previous 3 and at least ' + inrRisk(R.jump_min_increase) + ' higher a month' });
    else if (prev === 0 && last * 3 >= R.new_vendor_min_spend && lastM.some(m => (mm.get(m) || 0) > 0)) add({ type: 'new_vendor_spend', severity: 'low', vendor: name, amount_at_stake: r0(last * 3),
      message: name + ' is a new vendor with ' + inrRisk(last * 3) + ' billed in the last 3 months and nothing in the 3 months before. Confirm it was approved and priced competitively.', rule: 'no spend in the earlier 3 months and at least ' + inrRisk(R.new_vendor_min_spend) + ' recently' });
  });

  // 3. Possible duplicate bills: same vendor and same total, close in date (rejected and draft bills are ignored)
  const live = bills.filter(b => b.status !== 'rejected' && b.status !== 'draft' && b.status !== 'cancelled' && b.total > 0);
  const groups = new Map<string, SpendBill[]>();
  for (const b of live) { const k = b.vendor_id + '|' + b.total.toFixed(2); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(b); }
  let duplicateUnpaid = 0, duplicateN = 0;
  groups.forEach(g => {
    g.sort((a, b) => day(a.date) - day(b.date));
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1], b = g[i];
      const same = String(a.number).trim().toLowerCase() === String(b.number).trim().toLowerCase();
      if (day(b.date) - day(a.date) > (same ? R.duplicate_same_number_days : R.duplicate_window_days)) continue;   // monthly repeats (rent, retainers) are not duplicates
      const unpaid = Math.max(0, b.total - b.paid);
      duplicateN++; duplicateUnpaid += unpaid;
      add({ type: 'possible_duplicate', severity: same || b.paid > 0 ? 'high' : 'medium', vendor: b.vendor, amount_at_stake: r0(b.total),
        message: 'Possible duplicate: ' + b.vendor + ' bills ' + a.number + ' (' + a.date.slice(0, 10) + ') and ' + b.number + ' (' + b.date.slice(0, 10) + ') are both ' + inrRisk(b.total) + (same ? ' with the same bill number' : '') + '.' +
          (b.paid > 0 ? ' The second one has already been paid in part or in full.' : ' The second one is still unpaid (' + inrRisk(unpaid) + '), so check it before paying.'),
        rule: same ? 'same vendor, same amount and same bill number within ' + R.duplicate_same_number_days + ' days' : 'same vendor and same amount within ' + R.duplicate_window_days + ' days' });
    }
  });

  // 4. Payment timing on paid bills
  const paid = bills.filter(b => b.status === 'paid' && b.last_paid && b.total > 0 && today - day(b.date) <= 365);
  const early = paid.filter(b => day(b.due_date) - day(b.last_paid as string) >= R.early_days), late = paid.filter(b => day(b.last_paid as string) > day(b.due_date));
  const paidTotal = paid.reduce((s, b) => s + b.total, 0), earlyTotal = early.reduce((s, b) => s + b.total, 0);
  const avgEarly = early.length ? early.reduce((s, b) => s + (day(b.due_date) - day(b.last_paid as string)), 0) / early.length : 0;
  const avgLate = late.length ? late.reduce((s, b) => s + (day(b.last_paid as string) - day(b.due_date)), 0) / late.length : 0;
  if (paidTotal > 0 && earlyTotal / paidTotal >= R.early_share_flag) add({ type: 'paying_early', severity: 'low', amount_at_stake: r0(earlyTotal),
    message: early.length + ' bills worth ' + inrRisk(earlyTotal) + ' (' + r0(earlyTotal / paidTotal * 100) + '% of what you paid in the last 12 months) were paid about ' + r0(avgEarly) + ' days before they were due. Paying on the due date would keep that cash with you longer, unless the vendor gave an early-payment discount.', rule: 'at least ' + r0(R.early_share_flag * 100) + '% of paid value settled ' + R.early_days + '+ days early' });
  if (late.length >= R.late_count_flag) add({ type: 'paying_late', severity: 'low', amount_at_stake: r0(late.reduce((s, b) => s + b.total, 0)),
    message: late.length + ' paid bills were settled after their due date, by about ' + r0(avgLate) + ' days on average. Late payment can bring interest, penalties or poorer terms from vendors.', rule: late.length + ' late payments in the last 12 months' });

  // 5. Budgets
  const fy = budgets.map(b => String(b.fiscal_year ?? '')).sort().pop();
  for (const b of budgets) {
    if (String(b.fiscal_year ?? '') !== fy || !(b.budgeted > 0)) continue;
    const u = b.spent / b.budgeted, label = b.name + (b.department ? ' (' + b.department + ')' : '');
    if (u >= 1) add({ type: 'budget_overrun', severity: 'high', amount_at_stake: r0(b.spent - b.budgeted), message: label + ' has spent ' + inrRisk(b.spent) + ' against a budget of ' + inrRisk(b.budgeted) + ', ' + inrRisk(b.spent - b.budgeted) + ' over (' + r0(u * 100) + '% used).', rule: 'spent at least 100% of budget' });
    else if (u >= R.budget_warn) add({ type: 'budget_nearly_used', severity: 'medium', amount_at_stake: r0(b.budgeted - b.spent), message: label + ' has used ' + r0(u * 100) + '% of its budget (' + inrRisk(b.spent) + ' of ' + inrRisk(b.budgeted) + '), leaving ' + inrRisk(b.budgeted - b.spent) + '.', rule: 'spent at least ' + r0(R.budget_warn * 100) + '% of budget' });
  }

  findings.sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.amount_at_stake - a.amount_at_stake);
  const summary: string[] = [];
  summary.push(totalSpend > 0 ? 'Vendor spend over the last 12 months is ' + inrRisk(totalSpend) + ' across ' + ranked.length + (ranked.length === 1 ? ' vendor.' : ' vendors.') : 'There are no approved vendor bills in the last 12 months to analyse.');
  if (duplicateN) summary.push(duplicateN + ' possible duplicate ' + (duplicateN === 1 ? 'pair' : 'pairs') + ' of bills found; ' + inrRisk(duplicateUnpaid) + ' of it is still unpaid and worth checking before payment.');
  if (!paid.length) summary.push('No paid vendor bills with a recorded payment date yet, so payment timing (early or late) could not be checked.');
  summary.push(findings.length ? findings.length + ' ' + (findings.length === 1 ? 'finding' : 'findings') + ' in total, listed by severity.' : 'No spend issues were found under the rules used.');
  return {
    as_of: todayYmd, total_spend: r0(totalSpend), vendors_n: ranked.length, top_vendors: topVendors,
    possible_duplicate_exposure: r0(duplicateUnpaid), possible_duplicates_n: duplicateN,
    paid_early_amount: r0(earlyTotal), paid_early_bills_n: early.length, paid_late_bills_n: late.length, paid_bills_checked_n: paid.length,
    findings: findings.slice(0, limit), findings_n: findings.length, summary,
    reporting_note: 'Report only the findings, summary lines and caveat in this result. Do not add a recommended action, next steps, suggestions to get quotes or qualify other suppliers, a confidence rating, or field names. Where a finding already contains advice (for example to check a possible duplicate), repeat that wording only.',
    rules: R, caveat: 'Rule-based review of recorded bills, not an audit. Possible duplicates need a human check. No savings are estimated beyond unpaid possible duplicates.',
  };
}
`;

const DATA = String.raw`import { Pool } from 'pg';
import { ensurePaymentEventsTable } from '../routes/paymentEventsRoutes';
import { SpendBill, SpendBudget } from './spendOptimization';

export async function loadSpendInputs(pool: Pool, tenantId: string): Promise<{ bills: SpendBill[]; budgets: SpendBudget[]; today: string }> {
  await ensurePaymentEventsTable(pool).catch(() => {});
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const b = await pool.query(
    "SELECT i.vendor_id::text AS vendor_id, COALESCE(v.name,'Unknown') AS vendor, i.invoice_number AS number, i.date::text AS date, i.due_date::text AS due_date, i.status, " +
    "i.total_amount::float8 AS total, i.paid_amount::float8 AS paid, " +
    "(SELECT MAX(e.payment_date)::text FROM invoice_payment_events e WHERE e.tenant_id = i.tenant_id AND e.invoice_type = 'ap' AND e.invoice_id = i.id) AS last_paid " +
    "FROM ap_invoices i LEFT JOIN vendors v ON v.id = i.vendor_id AND v.tenant_id = i.tenant_id " +
    "WHERE i.tenant_id = $1 AND i.date >= CURRENT_DATE - 400 ORDER BY i.date", [tenantId]);
  const bu = await pool.query('SELECT name, department, fiscal_year, total_budgeted::float8 AS budgeted, total_spent::float8 AS spent FROM budgets WHERE tenant_id = $1', [tenantId]).catch(() => ({ rows: [] as any[] }));
  return { bills: b.rows as SpendBill[], budgets: bu.rows as SpendBudget[], today };
}
`;

const ROUTE = String.raw`// GET /api/spend-optimization?limit=12
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { loadSpendInputs } from '../services/spendOptimizationData';
import { analyzeSpend } from '../services/spendOptimization';

export function createSpendOptimizationRouter(pool: Pool): Router {
  const router = Router();
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = (req as any).user.tenantId;
      const limit = Math.max(1, Math.min(50, parseInt(String(req.query.limit || '12'), 10) || 12));
      const { bills, budgets, today } = await loadSpendInputs(pool, t);
      res.json({ ...analyzeSpend(bills, budgets, today, limit), note: 'Review only. Nothing is paid, held or changed automatically.' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  return router;
}
`;

const METRIC = String.raw`
  /*spend-optimization*/
  spend_optimization: {
    description: 'Spend review: vendor concentration, vendors whose spend jumped, POSSIBLE duplicate vendor bills (same vendor and amount close in date), paying bills too early or late, and budget overruns, each with the rule that triggered it. Use for "where can we cut costs", "any duplicate bills", "are we overspending", "which vendors are costing more", "spend review". Rule-based; possible duplicates must be checked by a person. It does not estimate negotiation savings.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', description: 'How many findings to list, default 12, max 50.' } } },
    async run(pool, t, input) {
      const { bills, budgets, today } = await loadSpendInputs(pool, t);
      if (!bills.length) return { as_of: today, message: 'There are no vendor bills recorded yet, so there is no spend to review.' };
      return analyzeSpend(bills, budgets, today, clampInt(input?.limit, 12, 1, 50));
    },
  },
`;

function rd(p) { let s = fs.readFileSync(p, 'utf8'); const bom = s.charCodeAt(0) === 0xFEFF; if (bom) s = s.slice(1); const crlf = s.includes('\r\n'); if (crlf) s = s.replace(/\r\n/g, '\n'); return { s, bom, crlf }; }
function put(p, c) { if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== c) { fs.writeFileSync(p, c); console.log('wrote', p); } else console.log('up to date', p); }
function patch(p, fn) { if (!fs.existsSync(p)) { console.log('MISSING', p); process.exitCode = 1; return; } const o = rd(p); const t = fn(o.s); if (t !== o.s) { fs.writeFileSync(p, (o.bom ? '﻿' : '') + (o.crlf ? t.replace(/\n/g, '\r\n') : t)); console.log('patched', p); } else console.log('no change', p); }
function need(s, a, where) { if (!s.includes(a)) { console.log('anchor not found in ' + where + ': ' + a.slice(0, 70)); process.exit(1); } }

put('src/services/spendOptimization.ts', SVC);
put('src/services/spendOptimizationData.ts', DATA);
put('src/routes/spendOptimizationRoutes.ts', ROUTE);

patch('src/services/cfoMetrics.ts', s => {
  if (s.includes('/*spend-optimization*/')) return s;
  const imp = "import { scoreCollectionRisk } from './collectionRisk';", a = '\n  /*propose-actions*/';
  need(s, imp, 'cfoMetrics.ts (apply apply-collection-risk-backend.cjs first)'); need(s, a, 'cfoMetrics.ts (apply apply-controlled-actions-backend.cjs first)');
  s = s.replace(imp, imp + "\nimport { loadSpendInputs } from './spendOptimizationData';\nimport { analyzeSpend } from './spendOptimization';");
  return s.replace(a, METRIC + a);
});
patch('src/index.ts', s => {
  if (s.includes('createSpendOptimizationRouter')) return s;
  const imp = "import { createCollectionRiskRouter } from './routes/collectionRiskRoutes';", use = "app.use('/api/collection-risk', createCollectionRiskRouter(pool));";
  need(s, imp, 'index.ts'); need(s, use, 'index.ts');
  s = s.replace(imp, imp + "\nimport { createSpendOptimizationRouter } from './routes/spendOptimizationRoutes';");
  return s.replace(use, use + "\napp.use('/api/spend-optimization', createSpendOptimizationRouter(pool));");
});
patch('src/routes/cfoAgentRoutes.ts', s => {
  if (s.includes('Do not add recommended actions, next steps')) return s;
  const a = '- Get every figure from the tools. Never estimate or recall numbers.';
  // upgrade path: older spend rule already applied
  if (s.includes('use spend_optimization')) { const old = 'If there are no findings, say so plainly.\n'; need(s, old, 'cfoAgentRoutes.ts'); return s.replace(old, 'If there are no findings, say so plainly. Do not add recommended actions, next steps, quotes to get, negotiation advice, "material" savings, a confidence rating or any commentary the tool did not return; stop after the findings and the tool\'s caveat. Only say payment timing was fine if paid_bills_checked_n is above 0; otherwise say it could not be checked yet.\n'); }
  need(s, a, 'cfoAgentRoutes.ts');
  return s.replace(a, '- For "where can we cut costs / duplicate bills / are we overspending / which vendors cost more / spend review" use spend_optimization. Report only the findings the tool returns, most severe first, with the amounts and the tool\'s wording. Call duplicates "possible duplicates" that a person must check before paying. Do not invent savings, discounts, negotiation targets or vendor alternatives; the only avoidable amount is the unpaid possible-duplicate figure the tool gives. If there are no findings, say so plainly. Do not add recommended actions, next steps, quotes to get, negotiation advice, "material" savings, a confidence rating or any commentary the tool did not return; stop after the findings and the tool\'s caveat. Only say payment timing was fine if paid_bills_checked_n is above 0; otherwise say it could not be checked yet.\n' + a);
});
