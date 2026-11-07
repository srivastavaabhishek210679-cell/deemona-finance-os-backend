// ============================================================
// Finance specialist agents: Treasury, FP&A, Compliance.
// Same design as the Digital CFO: the model calls SQL-backed metrics (services/cfoMetrics.ts) and never computes
// figures itself. Each agent only sees its own tools. Money fields get a ready-written "_inr" text twin so the model
// copies amounts instead of formatting them (a model can misread Indian digit grouping).
// POST /api/specialists/:key/ask   { question, conversation_history }   key = treasury | fpa | compliance
// GET  /api/specialists            agent cards for the UI
// ============================================================
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../middleware/auth';
import { METRICS, runMetric } from '../services/cfoMetrics';
import { runForecast, loadForecastInputs, FcOpts } from '../services/cashForecast';

const MODEL = 'claude-sonnet-4-6';
const MAX_ROUNDS = 6;
const MAX_RESULT_CHARS = 14000;

export const inrText = (n: number): string => {
  const a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e7) return sign + '₹' + (a / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return sign + '₹' + (a / 1e5).toFixed(2) + ' lakh';
  return sign + '₹' + Math.round(a).toLocaleString('en-IN');
};
const MONEY = /(amount|total|balance|cash|revenue|cost|outstanding|exposure|burn|payable|receivable|overdue|value|spend|spent|outflow|inflow|budget|actual|variance|ebitda|profit|payroll|claims|gross|liability|shortfall|due)/i;
const NOT_MONEY = /(count|days|pct|percent|ratio|rate|number|index|month|year|period|score|_n$|^n$|id$)/i;
export function withInrText(v: any, key = ''): any {
  if (Array.isArray(v)) return v.map(x => withInrText(x, key));
  if (v && typeof v === 'object') {
    const out: any = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = withInrText(x, k);
      if (typeof x === 'number' && Number.isFinite(x) && MONEY.test(k) && !NOT_MONEY.test(k) && Math.abs(x) >= 1000) out[k + '_inr'] = inrText(x);
    }
    return out;
  }
  return v;
}

const FORECAST_TOOL = {
  name: 'cash_forecast',
  description: 'Day-by-day cash forecast from today: opening cash (Cash Balance page) plus open sales invoices and approved bills by due date, plus any assumptions. Returns three cases (as booked, customers pay 30 days late, and a custom case when settings differ) with closing cash, lowest point and date, first day cash goes negative, and the cover needed. Salaries, taxes and unbilled sales are NOT included unless monthly amounts are passed.',
  input_schema: { type: 'object', properties: {
    days: { type: 'integer', description: 'Horizon, 7-365. Default 90.' },
    ar_delay_days: { type: 'integer', description: 'Extra days customers take to pay (custom case).' },
    collection_pct: { type: 'number', description: 'Share of receivables actually collected, 0-100 (custom case).' },
    ap_delay_days: { type: 'integer', description: 'Extra days the company takes to pay suppliers (custom case).' },
    monthly_outflow: { type: 'number', description: 'Other monthly costs not in bills, e.g. salaries, in INR.' },
    monthly_inflow: { type: 'number', description: 'New monthly sales not yet invoiced, in INR.' },
  } },
};
const cl = (v: any, d: number, lo: number, hi: number) => { const n = Number(v); return v === undefined || v === null || !Number.isFinite(n) ? d : Math.max(lo, Math.min(hi, n)); };
async function runForecastTool(pool: Pool, tenantId: string, input: any) {
  const custom: FcOpts = { days: cl(input?.days, 90, 7, 365), ar_delay_days: cl(input?.ar_delay_days, 0, 0, 180), collection_pct: cl(input?.collection_pct, 100, 0, 100), ap_delay_days: cl(input?.ap_delay_days, 0, 0, 180), monthly_inflow: cl(input?.monthly_inflow, 0, 0, 1e11), monthly_outflow: cl(input?.monthly_outflow, 0, 0, 1e11) };
  const { opening, items, today } = await loadForecastInputs(pool, tenantId);
  const cases: Array<[string, FcOpts]> = [
    ['As booked', { ...custom, ar_delay_days: 0, collection_pct: 100, ap_delay_days: 0 }],
    ['Customers pay 30 days late', { ...custom, ar_delay_days: 30, collection_pct: 100, ap_delay_days: 0 }],
  ];
  if (custom.ar_delay_days !== 0 || custom.collection_pct !== 100 || custom.ap_delay_days !== 0) if (!(custom.ar_delay_days === 30 && custom.collection_pct === 100 && custom.ap_delay_days === 0)) cases.push(['Custom case', custom]);
  const recv = items.filter(i => i.kind === 'in');
  return {
    as_of: today, has_cash_entry: opening.has_entry, cash_today_inr: inrText(opening.amount),
    open_receivables: { count: recv.length, total_inr: inrText(recv.reduce((a, i) => a + i.amount, 0)) },
    open_payables: { count: items.length - recv.length, total_inr: inrText(items.filter(i => i.kind === 'out').reduce((a, i) => a + i.amount, 0)) },
    cases: cases.map(([label, o]) => { const r = runForecast(opening.amount, items, o, today); return {
      case: label, closing_cash_inr: inrText(r.closing), total_receipts_inr: inrText(r.total_in), total_payments_inr: inrText(r.total_out),
      lowest_cash_inr: inrText(r.lowest.amount), lowest_cash_date: r.lowest.date, first_day_cash_negative: r.first_negative, cover_needed_inr: r.shortfall > 0 ? inrText(r.shortfall) : null }; }),
    caveat: 'Built only from open invoices and approved bills (drafts and bills awaiting approval are excluded) plus the assumptions passed in.',
  };
}

interface AgentDef { key: string; name: string; role: string; blurb: string; examples: string[]; tools: string[]; forecast: boolean; prompt: string; }
const COMMON = `HOW TO ANSWER
- Get every figure from the tools. Never estimate, recall or calculate numbers yourself. Call several tools in one turn when a question spans areas.
- Money fields come with a ready-made text twin ending in "_inr" (for example "cash_inr": "₹11.80 Cr"). Copy those strings exactly. Never convert, re-spell, round or add up amounts, and never write amounts in words. If a field has no "_inr" twin, quote the number as the tool gives it.
- Lead with the direct answer, then the evidence, then ONE recommended action. Say how confident you are and why.
- If a tool returns "available": false, "needs_data", an "error", or empty lists, say plainly what data is missing or that nothing is recorded. Do not substitute a guess.
- Respect each tool's "definition", "basis" and "caveat" fields. The books are invoice-based, not a general ledger; salaries and taxes are not in the cash forecast unless supplied.
- Be concise (under about 250 words unless asked for detail). Short paragraphs or bullets. Do not give tax, legal or investment advice; point to a qualified professional where needed.`;
const AGENTS: AgentDef[] = [
  { key: 'treasury', name: 'Treasury Agent', role: 'Cash, liquidity and collections',
    blurb: 'Watches cash, runway and the 90-day forecast, and tells you which receivables to chase and which payments can wait.',
    examples: ['Will we run out of cash in the next 90 days?', 'Which customers should I chase first?', 'What if our biggest customer pays 45 days late?', 'Which bills are due this week?'],
    tools: ['cash_position', 'cash_runway', 'payments_due', 'cash_shortage_projection', 'expected_collections', 'ar_aging', 'overdue_customers', 'working_capital', 'cash_movement'], forecast: true,
    prompt: `You are the Treasury Agent inside Deemona AI Finance OS. You manage liquidity: cash today, runway, the forecast, collections and payment timing. Cash comes from the balance the owner types on the Cash Balance page plus receipts and payments recorded since; there is no bank feed, so say so if asked about bank-level detail. When asked "what if" questions, call cash_forecast with the right settings. Prefer actions the owner controls: chase these invoices, time these payments, arrange cover before a date.` },
  { key: 'fpa', name: 'FP&A Agent', role: 'Performance, budgets and variance',
    blurb: 'Explains revenue and cost trends, budget overruns and what drives profit, from your invoices, payroll and approved claims.',
    examples: ['How did we do this month versus last month?', 'What are our biggest cost drivers?', 'Which budgets are over?', 'Is payroll growing faster than revenue?'],
    tools: ['pnl_trend', 'period_comparison', 'budget_vs_actual', 'target_vs_actual', 'forecast_vs_actual', 'top_cost_drivers', 'unusual_expenses', 'breakdown_by_dimension', 'customer_analysis', 'metric_history', 'collection_efficiency'], forecast: true,
    prompt: `You are the FP&A Agent inside Deemona AI Finance OS. You explain performance: revenue and cost trends, margins, budget versus actual, drivers and variances. The latest month in pnl_trend is month-to-date, so never compare it with a full month as if it were complete; say so. Revenue budgets and targets may not exist, so report only what the tools return. Use cash_forecast only for forward-looking cash questions.` },
  { key: 'compliance', name: 'Compliance Agent', role: 'Statutory dates, filings and risk',
    blurb: 'Tracks overdue compliance items, tax filings and risk signals, and tells you what needs attention before a deadline.',
    examples: ['What compliance items are overdue?', 'Which tax filings are due in the next two weeks?', 'Are there any risk signals I should know about?', 'What needs my attention today?'],
    tools: ['compliance_alerts', 'risk_signals', 'open_alerts', 'payments_due', 'integration_health', 'unusual_expenses'], forecast: false,
    prompt: `You are the Compliance Agent inside Deemona AI Finance OS. You track statutory and internal compliance: overdue compliance items, tax filings due or overdue, open alerts and risk signals. You only know what is recorded in the app's compliance and tax-filing tables. If they are empty, say that nothing is recorded and that the owner should add their compliance calendar and filings so you can track them; never claim the company is compliant just because nothing is recorded. You do not file returns or give tax or legal advice; for interpretation of law, recommend the company's CA or counsel.` },
];

const lastCall = new Map<string, number>();

export function createSpecialistRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;
  const def = (k: string) => AGENTS.find(a => a.key === k);

  router.get('/', requireAuth, (_req: Request, res: Response) => {
    res.json({ agents: AGENTS.map(a => ({ key: a.key, name: a.name, role: a.role, blurb: a.blurb, examples: a.examples })) });
  });

  router.post('/:key/ask', requireAuth, async (req: Request, res: Response) => {
    try {
      const agent = def(String(req.params.key));
      if (!agent) { res.status(404).json({ error: 'Unknown agent' }); return; }
      if (!process.env.ANTHROPIC_API_KEY) { res.status(503).json({ error: 'AI agents are not configured on this server.' }); return; }
      const question = String((req.body || {}).question || '').trim();
      if (!question) { res.status(400).json({ error: 'question is required' }); return; }
      if (question.length > 2000) { res.status(400).json({ error: 'Please keep the question under 2000 characters.' }); return; }
      const t = tid(req), rk = t + ':' + agent.key, now = Date.now();
      if (now - (lastCall.get(rk) || 0) < 3000) { res.status(429).json({ error: 'Please wait a moment before asking again.' }); return; }
      lastCall.set(rk, now);
      const history = (Array.isArray((req.body || {}).conversation_history) ? req.body.conversation_history : [])
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-10);
      const allowed = new Set(agent.tools.filter(n => METRICS[n]));
      const tools: any[] = [...allowed].map(n => ({ name: n, description: METRICS[n].description, input_schema: METRICS[n].input_schema }));
      if (agent.forecast) { tools.push(FORECAST_TOOL); allowed.add('cash_forecast'); }
      const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const system = agent.prompt + `\nToday is ${today} (India, fiscal year April to March). Currency: INR.\n\n` + COMMON;
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const messages: any[] = [...history, { role: 'user', content: question }];
      const used: string[] = [];
      let answer = '';
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const resp: any = await anthropic.messages.create({ model: MODEL, max_tokens: 1500, system, tools, messages });
        const text = (resp.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
        if (resp.stop_reason !== 'tool_use') { answer = text; break; }
        const calls = (resp.content || []).filter((b: any) => b.type === 'tool_use');
        messages.push({ role: 'assistant', content: resp.content });
        const results = await Promise.all(calls.map(async (c: any) => {
          used.push(c.name);
          let out: any;
          if (!allowed.has(c.name)) out = { error: 'This tool is not available to the ' + agent.name };
          else if (c.name === 'cash_forecast') out = await runForecastTool(pool, t, c.input).catch((e: any) => ({ error: String(e.message || e) }));
          else out = withInrText(await runMetric(pool, t, c.name, c.input));
          let s = JSON.stringify(out);
          if (s.length > MAX_RESULT_CHARS) s = s.slice(0, MAX_RESULT_CHARS) + '…[truncated]';
          return { type: 'tool_result', tool_use_id: c.id, content: s };
        }));
        messages.push({ role: 'user', content: results });
        if (round === MAX_ROUNDS - 1) answer = text || 'I gathered the data but ran out of analysis steps. Please ask a narrower question.';
      }
      if (!answer) { res.status(502).json({ error: 'The agent returned an empty answer. Please try again.' }); return; }
      res.json({ agent: agent.key, answer, tools_used: Array.from(new Set(used)) });
    } catch (err) { res.status(500).json({ error: 'The agent could not answer: ' + String((err as any)?.message || err) }); }
  });

  return router;
}
