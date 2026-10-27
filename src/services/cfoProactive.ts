// ============================================================
// Deemona AI Finance OS — Proactive CFO engine (Step 3)
//  1. Threshold rules that raise "AI asks" (alerts) on their own
//  2. Scheduled daily / weekly / monthly CFO briefs
//  3. One-click board pack (data + narrative)
// Rules are plain code over the Step 1/2 metrics, so every alert is
// traceable to a number. The model only writes briefs and narratives.
// ============================================================
import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { runMetric } from './cfoMetrics';
import { agentLoop } from '../routes/cfoAgentRoutes';

type Json = Record<string, any>;
export type Severity = 'critical' | 'warning' | 'info';
export type Cadence = 'daily' | 'weekly' | 'monthly';
export const CADENCES: Cadence[] = ['daily', 'weekly', 'monthly'];

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// ── tables ───────────────────────────────────────────────────
let ready = false;
export async function ensureProactiveTables(pool: Pool): Promise<void> {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cfo_alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      rule_key TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      ask TEXT NOT NULL,
      evidence JSONB,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','dismissed','resolved')),
      note TEXT,
      first_raised_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      UNIQUE (tenant_id, rule_key, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS cfo_alerts_tenant_status ON cfo_alerts (tenant_id, status);
    CREATE TABLE IF NOT EXISTS cfo_alert_rules (
      tenant_id TEXT NOT NULL, rule_key TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE, threshold NUMERIC,
      PRIMARY KEY (tenant_id, rule_key)
    );
    CREATE TABLE IF NOT EXISTS cfo_proactive_settings (
      tenant_id TEXT PRIMARY KEY,
      daily_brief BOOLEAN NOT NULL DEFAULT TRUE,
      weekly_brief BOOLEAN NOT NULL DEFAULT TRUE,
      monthly_brief BOOLEAN NOT NULL DEFAULT TRUE,
      brief_hour INT NOT NULL DEFAULT 8 CHECK (brief_hour BETWEEN 0 AND 23),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cfo_briefs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly','monthly','board')),
      period_label TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      data JSONB,
      tools_used JSONB,
      source TEXT NOT NULL DEFAULT 'schedule',
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, cadence, period_label)
    );
    CREATE INDEX IF NOT EXISTS cfo_briefs_tenant ON cfo_briefs (tenant_id, cadence, generated_at DESC);
  `);
  ready = true;
}

// ── helpers ──────────────────────────────────────────────────
const ok = (r: Json | undefined): r is Json => !!r && !r.error && r.available !== false;
const inr = (v: number): string => {
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} crore`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)} lakh`;
  return `${s}₹${Math.round(a).toLocaleString('en-IN')}`;
};
const istNow = (): Date => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const KIND_LABEL: Record<string, string> = { business_unit: 'business unit', region: 'region', product: 'product' };

// ── rules ────────────────────────────────────────────────────
interface Finding { dedupe_key: string; severity: Severity; title: string; detail: string; ask: string; evidence?: Json }
interface RuleResult { ran: boolean; findings: Finding[] }   // ran=false → data unavailable, so existing alerts are left alone
interface Rule {
  key: string; label: string; description: string;
  default_threshold: number | null; threshold_unit: string | null;
  run: (pool: Pool, t: string, thr: number | null) => Promise<RuleResult>;
}
const none = (ran = true): RuleResult => ({ ran, findings: [] });

export const RULES: Rule[] = [
  {
    key: 'runway_low', label: 'Cash runway running short', description: 'Net-burn runway (cash ÷ monthly net outflow) falls below the threshold.',
    default_threshold: 180, threshold_unit: 'days',
    async run(pool, t, thr) {
      const r = await runMetric(pool, t, 'cash_runway', {}); if (!ok(r)) return none(false);
      const limit = thr ?? 180;
      if (r.cash_flow_positive || r.runway_days_net == null || r.runway_days_net >= limit) return none();
      const d: number = r.runway_days_net;
      return { ran: true, findings: [{ dedupe_key: 'runway', severity: d < 90 ? 'critical' : 'warning',
        title: `Cash runway is ${d} days at current net burn`,
        detail: `Cash ${inr(r.cash)}; net monthly burn ${inr(r.net_monthly_burn)} (outflow ${inr(r.avg_monthly_outflow)}, inflow ${inr(r.avg_monthly_inflow)}). Threshold ${limit} days.`,
        ask: `At the current burn we have about ${d} days of cash. Do we cut outflows, accelerate collections or raise funding — and by when do we decide?`, evidence: r }] };
    },
  },
  {
    key: 'cash_shortage', label: 'Projected cash shortfall (30 days)', description: 'The 30-day projection from AR/AP due dates goes negative or below one month of outflows.',
    default_threshold: null, threshold_unit: null,
    async run(pool, t) {
      const r = await runMetric(pool, t, 'cash_shortage_projection', { days: 30 }); if (!ok(r)) return none(false);
      if (r.first_negative_date) return { ran: true, findings: [{ dedupe_key: 'shortage', severity: 'critical',
        title: `Cash projected to go negative on ${r.first_negative_date}`,
        detail: `Opening cash ${inr(r.opening_cash)}, lowest point ${inr(r.lowest_point.balance)} on ${r.lowest_point.date} (AR collected at ${Math.round(r.assumptions.ar_collection_rate * 100)}% of due, AP paid on due date).`,
        ask: `Based on due dates we run out of cash around ${r.first_negative_date}. Which payments can we defer and which receivables can we pull forward?`, evidence: r }] };
      if (r.first_date_below_one_month_outflow) return { ran: true, findings: [{ dedupe_key: 'shortage', severity: 'warning',
        title: `Cash projected below one month of outflows from ${r.first_date_below_one_month_outflow}`,
        detail: `Buffer needed ${inr(r.one_month_outflow_buffer)}; lowest projected balance ${inr(r.lowest_point.balance)} on ${r.lowest_point.date}.`,
        ask: `Our projected cash falls under a one-month buffer on ${r.first_date_below_one_month_outflow}. Do we want to protect that buffer, and how?`, evidence: r }] };
      return none();
    },
  },
  {
    key: 'ar_overdue_share', label: 'Large share of receivables overdue', description: 'Overdue receivables as a percentage of total receivables exceeds the threshold.',
    default_threshold: 40, threshold_unit: '% of AR',
    async run(pool, t, thr) {
      const r = await runMetric(pool, t, 'working_capital', {}); if (!ok(r)) return none(false);
      const limit = thr ?? 40;
      if (!(r.receivables > 0)) return none();
      const share = (r.ar_overdue / r.receivables) * 100;
      if (share <= limit) return none();
      return { ran: true, findings: [{ dedupe_key: 'ar_overdue', severity: share >= 75 ? 'critical' : 'warning',
        title: `${Math.round(share)}% of receivables are overdue`,
        detail: `${inr(r.ar_overdue)} overdue out of ${inr(r.receivables)} outstanding. DSO ${r.dso_days ?? 'n/a'} days. Threshold ${limit}%.`,
        ask: `Most of our receivables are past due. Should we tighten credit terms or start a structured collections drive for the largest accounts?`, evidence: { receivables: r.receivables, ar_overdue: r.ar_overdue, dso_days: r.dso_days } }] };
    },
  },
  {
    key: 'escalation_customers', label: 'Customers needing escalation', description: 'Customers with an invoice >60 days overdue or owing >10% of total AR.',
    default_threshold: null, threshold_unit: null,
    async run(pool, t) {
      const r = await runMetric(pool, t, 'overdue_customers', { limit: 25 }); if (!ok(r)) return none(false);
      if (!r.escalation_count) return none();
      const names: string[] = r.escalate_customers.slice(0, 5);
      const share = r.total_ar_outstanding > 0 ? r.escalation_exposure_total / r.total_ar_outstanding : 0;
      return { ran: true, findings: [{ dedupe_key: 'escalation', severity: share > 0.5 ? 'critical' : 'warning',
        title: `${r.escalation_count} customer${r.escalation_count > 1 ? 's' : ''} need escalation (${inr(r.escalation_exposure_total)} overdue)`,
        detail: `${names.join(', ')}${r.escalation_count > names.length ? ` and ${r.escalation_count - names.length} more` : ''}.`,
        ask: `${r.escalation_count} customers meet our escalation rule. Who should own each conversation, and are any worth a provision or legal notice?`, evidence: { escalate_customers: r.escalate_customers, exposure: r.escalation_exposure_total } }] };
    },
  },
  {
    key: 'ap_overdue', label: 'Overdue vendor payments', description: 'Vendor invoices already past their due date (checked over the next 7 days of payables).',
    default_threshold: null, threshold_unit: null,
    async run(pool, t) {
      const r = await runMetric(pool, t, 'payments_due', { days: 7 }); if (!ok(r)) return none(false);
      if (!(r.of_which_already_overdue > 0)) return none();
      return { ran: true, findings: [{ dedupe_key: 'ap_overdue', severity: 'warning',
        title: `${inr(r.of_which_already_overdue)} of vendor payments already overdue`,
        detail: `Total due within 7 days including overdue: ${inr(r.total_due)} across ${r.invoice_count} invoices.`,
        ask: `We have overdue vendor payments. Which vendors are critical to pay first, and can we negotiate terms with the rest?`, evidence: r }] };
    },
  },
  {
    key: 'revenue_drop', label: 'Revenue fell versus prior month', description: 'Revenue for the last full month is lower than the month before by more than the threshold.',
    default_threshold: 15, threshold_unit: '% drop',
    async run(pool, t, thr) {
      const r = await runMetric(pool, t, 'period_comparison', { measure: 'revenue', period: 'month_vs_prev_month' }); if (!ok(r)) return none(false);
      const limit = thr ?? 15;
      if (!(r.previous.value > 0) || r.change_pct === null || r.change_pct >= -limit) return none();
      return { ran: true, findings: [{ dedupe_key: 'rev_mom:' + r.current.from.slice(0, 7), severity: r.change_pct <= -30 ? 'critical' : 'warning',
        title: `Revenue fell ${Math.abs(r.change_pct)}% in ${r.current.from.slice(0, 7)}`,
        detail: `${inr(r.current.value)} versus ${inr(r.previous.value)} the month before (${r.previous.from.slice(0, 7)}). Threshold ${limit}%.`,
        ask: `Revenue dropped ${Math.abs(r.change_pct)}% month on month. Is this timing of invoices, a lost customer or a real demand problem?`, evidence: r }] };
    },
  },
  {
    key: 'target_behind', label: 'Behind revenue target', description: 'Revenue for the current month or fiscal year is behind its target (needs targets in CFO Setup).',
    default_threshold: null, threshold_unit: null,
    async run(pool, t) {
      const findings: Finding[] = []; let ran = false;
      for (const pt of ['month', 'year'] as const) {
        const r = await runMetric(pool, t, 'target_vs_actual', { metric: 'revenue', period_type: pt, offset: 0 }); if (!ok(r)) continue;
        ran = true;
        if (!r.period_complete && r.elapsed_pct < 20) continue;        // too early for a straight-line projection
        for (const it of r.results as Json[]) {
          if (!['behind', 'missed', 'at_risk'].includes(it.status)) continue;
          findings.push({ dedupe_key: `target:${pt}:${r.period.from}:${it.scope}`, severity: it.status === 'at_risk' ? 'info' : 'warning',
            title: `Revenue ${it.status.replace('_', ' ')} for ${pt === 'year' ? 'the fiscal year' : 'this month'} (${it.scope})`,
            detail: `Target ${inr(it.target)}, actual ${inr(it.actual)} (${it.achievement_pct}%)${it.projected_at_period_end != null ? `, straight-line projection ${inr(it.projected_at_period_end)}` : ''}; ${r.elapsed_pct}% of the period elapsed.`,
            ask: `Revenue for ${it.scope} is ${it.status.replace('_', ' ')} against target by ${inr(it.gap_to_target)}. What is the plan to close the gap?`, evidence: it });
        }
      }
      return { ran, findings };
    },
  },
  {
    key: 'segment_decline', label: 'Business unit / region / product revenue decline', description: 'Revenue of a mapped business unit, region or product fell versus the prior month by more than the threshold.',
    default_threshold: 20, threshold_unit: '% drop',
    async run(pool, t, thr) {
      const limit = thr ?? 20; const findings: Finding[] = []; let ran = false;
      for (const kind of ['business_unit', 'region', 'product']) {
        const r = await runMetric(pool, t, 'breakdown_by_dimension', { dimension: kind, measure: 'revenue', period: 'month_vs_prev_month' }); if (!ok(r)) continue;
        ran = true;
        for (const it of r.items as Json[]) {
          if (it.name === 'Untagged' || !(it.previous > 0) || it.change_pct === null || it.change_pct >= -limit) continue;
          findings.push({ dedupe_key: `seg:${kind}:${it.name}:${r.current_range.from.slice(0, 7)}`, severity: it.change_pct <= -40 ? 'critical' : 'warning',
            title: `Revenue in ${KIND_LABEL[kind]} "${it.name}" fell ${Math.abs(it.change_pct)}%`,
            detail: `${inr(it.current)} in ${r.current_range.from.slice(0, 7)} versus ${inr(it.previous)} before. Threshold ${limit}%.`,
            ask: `${it.name} (${KIND_LABEL[kind]}) lost ${Math.abs(it.change_pct)}% of its revenue month on month. What changed there?`, evidence: it });
        }
      }
      return { ran, findings };
    },
  },
  {
    key: 'payroll_outgrowing', label: 'Payroll growing faster than revenue', description: 'Payroll month-on-month growth exceeded revenue growth for N consecutive completed months.',
    default_threshold: 3, threshold_unit: 'months',
    async run(pool, t, thr) {
      const r = await runMetric(pool, t, 'pnl_trend', { months: 8 }); if (!ok(r)) return none(false);
      const limit = thr ?? 3, n: number = r.payroll_outgrowing_revenue_consecutive_months;
      if (n < limit) return none();
      return { ran: true, findings: [{ dedupe_key: 'payroll_vs_revenue', severity: 'warning',
        title: `Payroll has grown faster than revenue for ${n} months running`,
        detail: `Compared month on month over the last ${n} completed months. Threshold ${limit} months.`,
        ask: `Payroll has outpaced revenue for ${n} straight months. Are the hires ahead of demand, and do we pause or reprioritise hiring?`, evidence: { consecutive_months: n } }] };
    },
  },
  {
    key: 'customer_concentration', label: 'Customer concentration risk', description: 'Top customer share of revenue (12 months) above the threshold, or top five above 70%.',
    default_threshold: 30, threshold_unit: '% top customer',
    async run(pool, t, thr) {
      const r = await runMetric(pool, t, 'customer_analysis', { months: 12, limit: 5 }); if (!ok(r)) return none(false);
      const limit = thr ?? 30, c = r.concentration;
      if (!(c.top1_pct > limit || c.top5_pct > 70)) return none();
      const top = r.top_customers[0];
      return { ran: true, findings: [{ dedupe_key: 'concentration', severity: 'warning',
        title: `${top ? top.customer : 'Top customer'} is ${c.top1_pct}% of revenue (top 5: ${c.top5_pct}%)`,
        detail: `Over the last 12 months. Thresholds: top customer ${limit}%, top five 70%.`,
        ask: `Our revenue depends heavily on a few customers. Do we set a diversification target, and what happens to cash if the largest one leaves?`, evidence: c }] };
    },
  },
  {
    key: 'unusual_expense', label: 'Unusual expense detected', description: 'An outgoing transaction in the last 7 days is >3σ above its category average.',
    default_threshold: null, threshold_unit: null,
    async run(pool, t) {
      const r = await runMetric(pool, t, 'unusual_expenses', { days: 7 }); if (!ok(r)) return none(false);
      if (!r.count) return none();
      const top: Json = r.items[0];
      return { ran: true, findings: [{ dedupe_key: `unusual:${top.date}:${top.amount}`, severity: 'warning',
        title: `${r.count} unusual outgoing payment${r.count > 1 ? 's' : ''} this week (largest ${inr(top.amount)})`,
        detail: `${top.description || top.category} on ${top.date}: ${top.times_average}× the usual ${top.category} payment.`,
        ask: `A payment of ${inr(top.amount)} (${top.category}) is far above normal. Was it approved and is it correctly coded?`, evidence: r.items.slice(0, 5) }] };
    },
  },
  {
    key: 'dso_rising', label: 'DSO rising', description: 'Days sales outstanding rose versus 30 days ago by more than the threshold (needs daily snapshot history).',
    default_threshold: 15, threshold_unit: '% rise',
    async run(pool, t, thr) {
      const r = await runMetric(pool, t, 'metric_history', { metric: 'dso', days: 60 }); if (!ok(r)) return none(false);
      const limit = thr ?? 15, ch = r.vs_30_days_ago?.change_pct;
      if (ch == null || ch <= limit) return none();
      return { ran: true, findings: [{ dedupe_key: 'dso_rising', severity: 'warning',
        title: `DSO up ${ch}% in 30 days (now ${r.latest.value} days)`,
        detail: `Was ${r.vs_30_days_ago.value} days on ${r.vs_30_days_ago.date}. Threshold ${limit}%.`,
        ask: `Customers are taking longer to pay. Is this a few late accounts or a broader slowdown, and should we change terms?`, evidence: r.vs_30_days_ago }] };
    },
  },
  {
    key: 'inventory_rising', label: 'Inventory building up', description: 'Inventory value rose versus 30 days ago by more than the threshold (needs daily snapshot history).',
    default_threshold: 25, threshold_unit: '% rise',
    async run(pool, t, thr) {
      const r = await runMetric(pool, t, 'metric_history', { metric: 'inventory', days: 60 }); if (!ok(r)) return none(false);
      const limit = thr ?? 25, ch = r.vs_30_days_ago?.change_pct;
      if (ch == null || ch <= limit || !(r.latest.value > 0)) return none();
      return { ran: true, findings: [{ dedupe_key: 'inventory_rising', severity: 'info',
        title: `Inventory value up ${ch}% in 30 days (${inr(r.latest.value)})`,
        detail: `Was ${inr(r.vs_30_days_ago.value)} on ${r.vs_30_days_ago.date}. Threshold ${limit}%.`,
        ask: `Stock is building up, which ties up cash. Is it planned ahead of demand or are items slowing down?`, evidence: r.vs_30_days_ago }] };
    },
  },
  {
    key: 'compliance_overdue', label: 'Compliance or filing overdue', description: 'Overdue compliance items, or tax filings overdue / due within 14 days.',
    default_threshold: null, threshold_unit: null,
    async run(pool, t) {
      const r = await runMetric(pool, t, 'compliance_alerts', {}); if (!ok(r)) return none(false);
      const overdueFilings = (r.filings_due_or_overdue_14d as Json[]).filter(f => f.overdue);
      const dueSoon = (r.filings_due_or_overdue_14d as Json[]).length - overdueFilings.length;
      if (!r.overdue_compliance_items && !overdueFilings.length && !dueSoon) return none();
      const bits: string[] = [];
      if (r.overdue_compliance_items) bits.push(`${r.overdue_compliance_items} compliance item(s) overdue`);
      if (overdueFilings.length) bits.push(`${overdueFilings.length} tax filing(s) overdue (${overdueFilings.slice(0, 3).map((f: Json) => f.type).join(', ')})`);
      if (dueSoon) bits.push(`${dueSoon} filing(s) due within 14 days`);
      return { ran: true, findings: [{ dedupe_key: 'compliance', severity: r.overdue_compliance_items || overdueFilings.length ? 'critical' : 'warning',
        title: bits.join('; '), detail: 'Late filings can attract interest and penalties.',
        ask: `Compliance deadlines are slipping. Who owns each overdue item, and can they be filed this week?`, evidence: { overdue_items: r.overdue_compliance_items, filings: r.filings_due_or_overdue_14d } }] };
    },
  },
  {
    key: 'forecast_miss', label: 'Behind revenue forecast', description: 'Month-to-date revenue is on pace to miss the saved forecast by more than the threshold (checked after the 10th).',
    default_threshold: 15, threshold_unit: '% below',
    async run(pool, t, thr) {
      if (istNow().getDate() < 10) return none(false);
      const r = await runMetric(pool, t, 'forecast_vs_actual', { metric: 'revenue', month_offset: 0 }); if (!ok(r)) return none(false);
      const limit = thr ?? 15;
      if (r.variance_pct === null || r.variance_pct >= -limit) return none();
      return { ran: true, findings: [{ dedupe_key: 'forecast:' + r.month, severity: 'warning',
        title: `Revenue pacing ${Math.abs(r.variance_pct)}% below forecast for ${r.month.slice(0, 7)}`,
        detail: `Forecast ${inr(r.forecast)} (${r.forecast_source}); actual to date ${inr(r.actual_to_date)}, projected month end ${r.projected_month_end != null ? inr(r.projected_month_end) : 'n/a'}.`,
        ask: `We are pacing below this month's forecast. Which deals or invoices can still land before month end?`, evidence: r }] };
    },
  },
  {
    key: 'integration_failures', label: 'Data pipeline failures', description: 'Poller or ingest runs failed in the last 24 hours.',
    default_threshold: null, threshold_unit: null,
    async run(pool, t) {
      const r = await runMetric(pool, t, 'integration_health', { days: 1 }); if (!ok(r)) return none(false);
      const f = (r.poller?.failures || 0) + (r.ingest?.failures || 0);
      if (!f) return none();
      return { ran: true, findings: [{ dedupe_key: 'integration', severity: 'warning',
        title: `${f} data load failure${f > 1 ? 's' : ''} in the last 24 hours`,
        detail: 'Figures in this app may be missing recent data until the failing connection is fixed.',
        ask: `Some data loads failed. Which connection is affected, and can the numbers I am looking at be trusted today?`, evidence: { poller: r.poller, ingest: r.ingest } }] };
    },
  },
  {
    key: 'risk_signals', label: 'High-severity anomaly alerts', description: 'Open critical or high-severity AI anomaly alerts from the last 14 days.',
    default_threshold: null, threshold_unit: null,
    async run(pool, t) {
      const r = await runMetric(pool, t, 'risk_signals', {}); if (!ok(r)) return none(false);
      const n = (r.by_severity?.critical || 0) + (r.by_severity?.high || 0);
      if (!n) return none();
      return { ran: true, findings: [{ dedupe_key: 'risk_signals', severity: r.by_severity?.critical ? 'critical' : 'warning',
        title: `${n} critical/high anomaly alert${n > 1 ? 's' : ''} open`,
        detail: (r.alerts as Json[]).filter(a => ['critical', 'high'].includes(a.severity)).slice(0, 3).map(a => a.description).join(' | '),
        ask: `The anomaly scan flagged items needing a decision. Which are real issues and which can be closed?`, evidence: r.alerts.slice(0, 5) }] };
    },
  },
];
const RULE_BY_KEY: Record<string, Rule> = Object.fromEntries(RULES.map(r => [r.key, r]));

// ── rule settings ────────────────────────────────────────────
export async function getRuleSettings(pool: Pool, t: string) {
  await ensureProactiveTables(pool);
  const saved = (await pool.query(`SELECT rule_key, enabled, threshold FROM cfo_alert_rules WHERE tenant_id=$1`, [t])).rows;
  return RULES.map(r => {
    const s = saved.find(x => x.rule_key === r.key);
    return { key: r.key, label: r.label, description: r.description, enabled: s ? s.enabled : true,
      threshold: s && s.threshold !== null ? parseFloat(s.threshold) : r.default_threshold,
      default_threshold: r.default_threshold, threshold_unit: r.threshold_unit };
  });
}
export async function setRuleSetting(pool: Pool, t: string, key: string, enabled: boolean, threshold: number | null) {
  await ensureProactiveTables(pool);
  if (!RULE_BY_KEY[key]) throw new Error('unknown rule');
  await pool.query(
    `INSERT INTO cfo_alert_rules (tenant_id, rule_key, enabled, threshold) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, rule_key) DO UPDATE SET enabled=EXCLUDED.enabled, threshold=EXCLUDED.threshold`, [t, key, enabled, threshold]);
}

// ── evaluation ───────────────────────────────────────────────
export async function evaluateAlerts(pool: Pool, t: string) {
  await ensureProactiveTables(pool);
  const settings = await getRuleSettings(pool, t);
  const out = { rules_checked: 0, rules_skipped_no_data: [] as string[], rules_failed: [] as string[], raised: 0, updated: 0, resolved: 0 };
  for (const s of settings) {
    if (!s.enabled) continue;
    const rule = RULE_BY_KEY[s.key];
    let res: RuleResult;
    try { res = await rule.run(pool, t, s.threshold); } catch (e) { console.error('[CFO alerts]', s.key, String(e)); out.rules_failed.push(s.key); continue; }
    if (!res.ran) { out.rules_skipped_no_data.push(s.key); continue; }
    out.rules_checked++;
    for (const f of res.findings) {
      const r = await pool.query(
        `INSERT INTO cfo_alerts (tenant_id, rule_key, dedupe_key, severity, title, detail, ask, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, rule_key, dedupe_key) DO UPDATE SET
           severity=EXCLUDED.severity, title=EXCLUDED.title, detail=EXCLUDED.detail, ask=EXCLUDED.ask, evidence=EXCLUDED.evidence, last_seen_at=NOW(),
           first_raised_at = CASE WHEN cfo_alerts.status='resolved' THEN NOW() ELSE cfo_alerts.first_raised_at END,
           resolved_at     = CASE WHEN cfo_alerts.status='resolved' THEN NULL ELSE cfo_alerts.resolved_at END,
           status          = CASE WHEN cfo_alerts.status='resolved' THEN 'open' ELSE cfo_alerts.status END
         RETURNING (xmax = 0) AS inserted`,
        [t, s.key, f.dedupe_key, f.severity, f.title, f.detail, f.ask, f.evidence ? JSON.stringify(f.evidence) : null]);
      if (r.rows[0].inserted) out.raised++; else out.updated++;
    }
    // condition cleared → close anything this rule raised earlier (dismissed ones too, so a recurrence re-opens)
    const closed = await pool.query(
      `UPDATE cfo_alerts SET status='resolved', resolved_at=NOW()
       WHERE tenant_id=$1 AND rule_key=$2 AND status IN ('open','acknowledged','dismissed') AND dedupe_key <> ALL($3::text[])`,
      [t, s.key, res.findings.map(f => f.dedupe_key)]);
    out.resolved += closed.rowCount || 0;
  }
  return out;
}

// ── briefs ───────────────────────────────────────────────────
export async function getBriefSettings(pool: Pool, t: string) {
  await ensureProactiveTables(pool);
  const r = (await pool.query(`SELECT daily_brief, weekly_brief, monthly_brief, brief_hour FROM cfo_proactive_settings WHERE tenant_id=$1`, [t])).rows[0];
  return r || { daily_brief: true, weekly_brief: true, monthly_brief: true, brief_hour: 8 };
}
export async function setBriefSettings(pool: Pool, t: string, s: { daily_brief: boolean; weekly_brief: boolean; monthly_brief: boolean; brief_hour: number }) {
  await ensureProactiveTables(pool);
  await pool.query(
    `INSERT INTO cfo_proactive_settings (tenant_id, daily_brief, weekly_brief, monthly_brief, brief_hour) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id) DO UPDATE SET daily_brief=EXCLUDED.daily_brief, weekly_brief=EXCLUDED.weekly_brief, monthly_brief=EXCLUDED.monthly_brief,
       brief_hour=EXCLUDED.brief_hour, updated_at=NOW()`, [t, s.daily_brief, s.weekly_brief, s.monthly_brief, s.brief_hour]);
}

async function openAlertsContext(pool: Pool, t: string): Promise<string> {
  const rows = (await pool.query(
    `SELECT severity, title, ask FROM cfo_alerts WHERE tenant_id=$1 AND status='open'
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, first_raised_at LIMIT 12`, [t])).rows;
  if (!rows.length) return 'There are no open system alerts.';
  return 'Open system alerts (already detected by threshold rules; list them under "Questions for you" in your own words):\n' +
    rows.map(r => `- [${r.severity}] ${r.title} — ${r.ask}`).join('\n');
}

const BRIEF_FORMAT = `Format: start with a one-line verdict (e.g. "Stable", "Needs attention", "Urgent") then short sections with bold key numbers. End with a section "Questions for you" listing the open alerts as questions (max 5), and "Data gaps" only if some tools reported available:false. Do not do arithmetic across rows; use the tool totals.`;
const BRIEF_PROMPTS: Record<Cadence, string> = {
  daily: `Write today's daily CFO brief (about 250 words). Cover: cash position and runway, payments due in the next 7 days, receivables newly overdue and escalations, unusual expenses, risk signals and compliance. Compare today with the same weekday last week where a tool allows.`,
  weekly: `Write this week's CFO review (about 350 words). Cover: revenue, cash in and cash out versus the previous week; the week's largest inflows and outflows; working capital (DSO, DPO); the main cost drivers and the fastest-growing cost category; collections progress and what is expected next week.`,
  monthly: `Write the monthly CFO review for the last full month (about 450 words). Cover: month-on-month revenue and the P&L trend (margins, payroll versus revenue); progress against revenue/EBITDA targets and forecast versus actual; revenue by business unit, region and product; customer concentration and churn risks; budget utilisation; and the three decisions leadership should take.`,
};

function briefLabel(cadence: Cadence, now: Date): { label: string; startYmd: string; title: string } {
  const pretty = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  if (cadence === 'daily') return { label: ymd(now), startYmd: ymd(now), title: `Daily CFO brief — ${pretty(now)}` };
  if (cadence === 'weekly') {
    const mon = new Date(now); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    return { label: ymd(mon), startYmd: ymd(mon), title: `Weekly CFO review — week of ${pretty(mon)}` };
  }
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  return { label: ymd(first).slice(0, 7), startYmd: ymd(first), title: `Monthly CFO review — ${first.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}` };
}

export async function generateBrief(pool: Pool, t: string, cadence: Cadence, source: 'schedule' | 'manual') {
  await ensureProactiveTables(pool);
  const { label, title } = briefLabel(cadence, istNow());
  const ctx = await openAlertsContext(pool, t);
  const { answer, tools_used } = await agentLoop(pool, t, [], `${BRIEF_PROMPTS[cadence]}\n\n${ctx}\n\n${BRIEF_FORMAT}`);
  if (!answer) throw new Error('The CFO agent returned no text');
  const r = await pool.query(
    `INSERT INTO cfo_briefs (tenant_id, cadence, period_label, title, content, tools_used, source) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, cadence, period_label) DO UPDATE SET content=EXCLUDED.content, tools_used=EXCLUDED.tools_used, source=EXCLUDED.source, generated_at=NOW()
     RETURNING id, cadence, period_label, title, generated_at`, [t, cadence, label, title, answer, JSON.stringify(tools_used), source]);
  return r.rows[0];
}

/** Generates whichever scheduled briefs are due for this tenant and not yet written. Catches up if the server was down at the scheduled hour. */
export async function runDueBriefs(pool: Pool, t: string): Promise<string[]> {
  const s = await getBriefSettings(pool, t);
  const now = istNow(); const todayYmd = ymd(now);
  const made: string[] = [];
  for (const c of CADENCES) {
    if (!(s as Json)[`${c}_brief`]) continue;
    const { label, startYmd } = briefLabel(c, now);
    const due = todayYmd > startYmd || now.getHours() >= s.brief_hour;     // on the first day wait for the hour; later days catch up
    if (!due) continue;
    const exists = (await pool.query(`SELECT 1 FROM cfo_briefs WHERE tenant_id=$1 AND cadence=$2 AND period_label=$3`, [t, c, label])).rowCount;
    if (exists) continue;
    try { await generateBrief(pool, t, c, 'schedule'); made.push(c); } catch (e) { console.error('[CFO brief]', t, c, String(e)); }
  }
  return made;
}

// ── board pack ───────────────────────────────────────────────
const BOARD_SYSTEM = `You are the CFO of a company writing the narrative for a board pack. You are given a JSON object of figures computed by the finance system. Rules:
- Use ONLY figures present in the data. Do not calculate new totals, ratios or percentages; quote what is given. Write amounts in INR with lakh/crore wording.
- A section whose data has "available": false or "error" is a data gap: say what is missing in the "Data gaps" section and do not guess.
- Be direct and brief. Bold the key numbers with **...**. No filler.
Write in Markdown with exactly these sections: "## Executive summary" (4-5 bullets), "## Financial performance", "## Plan, forecast and segments", "## Cash and liquidity", "## Customers and collections", "## Risks and compliance", "## Matters for the board" (3-5 decisions or discussion points), "## Data gaps".`;

export async function buildBoardPack(pool: Pool, t: string) {
  await ensureProactiveTables(pool);
  const m = (name: string, input: Json = {}) => runMetric(pool, t, name, input);
  const [cash, runway, wc, pnl, ytd, qoq, tYear, tQuarter, tVendor, fc, bu, region, product, cust, overdue, aging, comp, risk, budget] = await Promise.all([
    m('cash_position'), m('cash_runway'), m('working_capital'), m('pnl_trend', { months: 6 }),
    m('period_comparison', { measure: 'revenue', period: 'ytd_vs_prev_ytd' }), m('period_comparison', { measure: 'revenue', period: 'last_quarter_vs_prev_quarter' }),
    m('target_vs_actual', { metric: 'revenue', period_type: 'year' }), m('target_vs_actual', { metric: 'revenue', period_type: 'quarter' }),
    m('target_vs_actual', { metric: 'vendor_costs', period_type: 'year' }), m('forecast_vs_actual', { metric: 'revenue' }),
    m('breakdown_by_dimension', { dimension: 'business_unit', period: 'ytd_vs_prev_ytd' }), m('breakdown_by_dimension', { dimension: 'region', period: 'ytd_vs_prev_ytd' }),
    m('breakdown_by_dimension', { dimension: 'product', period: 'ytd_vs_prev_ytd' }),
    m('customer_analysis', { months: 12, limit: 5 }), m('overdue_customers', { limit: 8 }), m('ar_aging'),
    m('compliance_alerts'), m('risk_signals'), m('budget_vs_actual'),
  ]);
  const alerts = (await pool.query(
    `SELECT severity, title, ask, first_raised_at::text AS first_raised_at FROM cfo_alerts WHERE tenant_id=$1 AND status IN ('open','acknowledged')
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, first_raised_at LIMIT 15`, [t])).rows;
  const slimCash = ok(cash) ? { total_cash: cash.total_cash, account_count: cash.account_count, low_balance_accounts: cash.low_balance_accounts } : cash;
  const data = {
    generated_for: ymd(istNow()), currency: 'INR',
    cash: slimCash, runway, working_capital: wc, pnl_trend: pnl,
    revenue_ytd_vs_prior: ytd, revenue_last_quarter_vs_prior: qoq,
    targets: { revenue_year: tYear, revenue_quarter: tQuarter, vendor_costs_year: tVendor }, forecast: fc,
    segments: { business_unit: bu, region, product },
    customers: cust, overdue_customers: overdue, ar_aging: aging, budgets: budget,
    compliance: comp, risk_signals: risk, open_alerts: alerts,
  };
  let json = JSON.stringify(data);
  if (json.length > 60000) json = json.slice(0, 60000) + '…[truncated]';
  const resp: any = await anthropic.messages.create({ model: MODEL, max_tokens: 3000, system: BOARD_SYSTEM, messages: [{ role: 'user', content: json }] });
  const narrative = (resp.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  if (!narrative) throw new Error('The narrative came back empty');
  const now = istNow();
  const label = `${ymd(now)}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const title = `Board pack — ${now.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const r = await pool.query(
    `INSERT INTO cfo_briefs (tenant_id, cadence, period_label, title, content, data, source) VALUES ($1,'board',$2,$3,$4,$5,'manual')
     ON CONFLICT (tenant_id, cadence, period_label) DO UPDATE SET content=EXCLUDED.content, data=EXCLUDED.data, generated_at=NOW()
     RETURNING id, cadence, period_label, title, generated_at`, [t, label, title, narrative, JSON.stringify(data)]);
  return r.rows[0];
}

// ── scheduler ────────────────────────────────────────────────
async function forEachTenant(pool: Pool, label: string, fn: (t: string) => Promise<unknown>): Promise<void> {
  const tenants = await pool.query(`SELECT DISTINCT tenant_id FROM users WHERE is_active=true`).catch(() => ({ rows: [] as any[] }));
  for (const row of tenants.rows) {
    try { await fn(String(row.tenant_id)); } catch (e) { console.error(`[CFO ${label}] failed for tenant`, row.tenant_id, String(e)); }
  }
}

/** Call once at startup. Alerts are re-evaluated hourly; briefs are checked every 15 minutes and written once per period. */
export function startCfoProactiveJob(pool: Pool): void {
  let alertsBusy = false, briefsBusy = false;
  const alertsRun = async () => {
    if (alertsBusy) return; alertsBusy = true;
    try { await forEachTenant(pool, 'alerts', t => evaluateAlerts(pool, t)); console.log('[CFO alerts] evaluated'); } finally { alertsBusy = false; }
  };
  const briefsRun = async () => {
    if (briefsBusy) return; briefsBusy = true;
    try { await forEachTenant(pool, 'briefs', async t => { const made = await runDueBriefs(pool, t); if (made.length) console.log(`[CFO briefs] ${t}: generated ${made.join(', ')}`); }); }
    finally { briefsBusy = false; }
  };
  setTimeout(alertsRun, 90_000); setInterval(alertsRun, 60 * 60 * 1000);
  setTimeout(briefsRun, 150_000); setInterval(briefsRun, 15 * 60 * 1000);
}
