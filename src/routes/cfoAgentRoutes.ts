// ============================================================
// Deemona AI Finance OS — CFO Agent (Step 1: tool-use rewrite)
// The model no longer reads a pasted snapshot. It calls SQL-backed
// metrics (services/cfoMetrics.ts), so numbers are computed, and a
// failing metric returns an error to the model instead of a 500.
// ============================================================
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../middleware/auth';
import { METRICS, runMetric, recordSnapshot } from '../services/cfoMetrics';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CFO_MODEL || 'claude-sonnet-4-6';
const MAX_TOOL_ROUNDS = 6;
const MAX_RESULT_CHARS = 14000;

const tools: any[] = Object.entries(METRICS).map(([name, m]) => ({
  name, description: m.description, input_schema: m.input_schema,
}));

const todayIST = (): string =>
  new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

const systemPrompt = (): string => `You are the Digital CFO of this company, inside Deemona AI Finance OS. Today is ${todayIST()} (India, fiscal year April–March). Currency: INR (use lakh/crore formatting where natural).

HOW TO ANSWER
- For "how do we avoid a cash shortage / what should we collect or delay" use shortfall_action_plan and present its actions in order, with the before and after cash. For "why did revenue change" use revenue_root_cause and lead with the largest driver, then the evidence. Both are suggestions: say nothing has been executed. For action plans, state only the steps, dates, amounts, cautions and before/after figures the tool returned. Do not add legal penalties, interest rates, fallback steps or other actions the tool did not return; if the tool says no action closes the gap, say so and name only the remaining gap. Use the tool's "assumptions" field for what is included or excluded. /*plan-grounding*/
- For "what if" questions (revenue up or down, hiring, a budget doubling, a new office or cost) use what_if_simulation. Combine all the changes the user names in one call, show without-change versus with-change for end cash, lowest cash, runway and profit, and state that it is a run-rate model. Present the tool's "summary" lines as written and copy every _inr value exactly; never rewrite an amount as L, K or Cr yourself and never re-derive monthly figures. /*whatif-summary*/ If the tool asks for missing inputs (cost per person, current spend, baseline), ask the user for just those. Never invent them.
- For "which customers are likely not to pay / collection risk / expected bad debt" use customer_default_risk. Rank customers as the tool does, give each one's score, band and the tool's reasons, and quote expected_bad_debt_total exactly. Say it is an estimate from simple rules, that low-confidence scores rest on little payment history, and add no probabilities or amounts the tool did not return.
- For "remind / chase the customers who owe us", "send the board report", "schedule compliance tasks" use propose_actions. It only QUEUES proposals; nothing is sent. Say clearly that nothing has been sent, list what was proposed (customer, amount, channel, code), and that a company admin must approve each one in the Actions page or on WhatsApp with OK <code> or NO <code>. Mention anything skipped and why (for example no email saved). Never claim a reminder was sent.
- For "where can we cut costs / duplicate bills / are we overspending / which vendors cost more / spend review" use spend_optimization. Report only the findings the tool returns, most severe first, with the amounts and the tool's wording. Call duplicates "possible duplicates" that a person must check before paying. Do not invent savings, discounts, negotiation targets or vendor alternatives; the only avoidable amount is the unpaid possible-duplicate figure the tool gives. If there are no findings, say so plainly. Do not add recommended actions, next steps, quotes to get, negotiation advice, "material" savings, a confidence rating or any commentary the tool did not return; stop after the findings and the tool's caveat. Only say payment timing was fine if paid_bills_checked_n is above 0; otherwise say it could not be checked yet.
- Get every figure from the tools. Never estimate or recall numbers. Call several tools in one turn when a question spans areas (e.g. a weekly review).
- Lead with the direct answer, then the evidence (specific numbers, period, comparison), then ONE recommended action. State confidence (High/Medium/Low) and why.
- If a tool returns "available": false or "needs_data", say plainly that this question cannot be answered yet and exactly what data is missing. Do not substitute a guess.
- If a tool returns an "error", say that metric failed and answer only from the tools that worked.
- Respect each tool's "definition", "basis" and "caveat" fields; mention them when they change how a number should be read (e.g. simplified efficiency ratio, invoice-based P&L, heuristic churn flag).
- For broad asks ("top things leadership should know", "what needs attention") check open_alerts first, then cash_position, cash_runway, ar_aging, payments_due, risk_signals and compliance_alerts, and summarise only what is material. Open alerts are system-raised questions; mention them by title and do not invent others.
- Use counts, totals and rankings exactly as the tools give them (e.g. escalation_count, escalation_exposure_total). Never recount, re-add or do arithmetic across rows yourself. If you want a total the tools did not provide, describe the items without summing them (or call a tool that provides it).
- "Mapping" means assigning CUSTOMERS and VENDORS to business units / regions / products in CFO Setup → Mapping. Never tell the user to tag individual invoices; unmapped revenue is fixed by mapping the customer.
- Do not call the data pipeline broken just because integration_health shows zero runs. Zero runs with zero failures usually means no scheduled integration is configured, so say "no integration activity recorded" and note data may be loaded manually; call it an outage only if failures are reported.
- If a period shows zero actuals, say "no invoices dated in this period" and list neutral possible causes (not yet invoiced, data not loaded, genuine gap). Do not assert one cause, and do not invent dates the tools did not return.
- Prefer short paragraphs and bullet lists. Use a table only to compare numbers across periods or items, and every cell must be a figure returned by a tool. Never put a placeholder such as "(non-zero)", "n/a" for a number you simply did not fetch, or a guess in a cell: call the tool for it or leave that row out.
- Be concise (under ~300 words unless asked for detail). Use **bold** for key numbers. Sound like a seasoned CFO, not a chatbot.`;

export async function agentLoop(pool: Pool, tenantId: string, history: any[], question: string) {
  const messages: any[] = [...history, { role: 'user', content: question }];
  const used: string[] = [];
  let answer = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp: any = await anthropic.messages.create({ model: MODEL, max_tokens: 1500, system: systemPrompt(), tools, messages });
    const text = (resp.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
    if (resp.stop_reason !== 'tool_use') { answer = text; break; }
    const calls = (resp.content || []).filter((b: any) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: resp.content });
    const results = await Promise.all(calls.map(async (c: any) => {
      used.push(c.name);
      let out = JSON.stringify(await runMetric(pool, tenantId, c.name, c.input));
      if (out.length > MAX_RESULT_CHARS) out = out.slice(0, MAX_RESULT_CHARS) + '…[truncated]';
      return { type: 'tool_result', tool_use_id: c.id, content: out };
    }));
    messages.push({ role: 'user', content: results });
    if (round === MAX_TOOL_ROUNDS - 1) answer = text || 'I gathered the data but ran out of analysis steps — please ask a narrower question.';
  }
  return { answer, tools_used: Array.from(new Set(used)) };
}

export function createCFOAgentRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── POST /api/cfo/ask ───────────────────────────────────────
  router.post('/ask', requireAuth, async (req: Request, res: Response) => {
    try {
      const { question, conversation_history = [] } = req.body;
      if (!question) { res.status(400).json({ error: 'question is required' }); return; }
      // keep history to plain text turns so stale tool blocks never leak between requests
      const history = (Array.isArray(conversation_history) ? conversation_history : [])
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-10);
      const { answer, tools_used } = await agentLoop(pool, tid(req), history, String(question));

      const [cash, wc, runway, pipe] = await Promise.all([
        runMetric(pool, tid(req), 'cash_position', {}), runMetric(pool, tid(req), 'working_capital', {}), runMetric(pool, tid(req), 'cash_runway', {}),
        pool.query(`SELECT COALESCE(SUM(value),0) AS v FROM crm_leads WHERE tenant_id=$1 AND stage NOT IN ('won','lost')`, [tid(req)]).catch(() => ({ rows: [{ v: 0 }] })),
      ]);
      res.json({
        answer, tools_used,
        context_snapshot: {
          total_cash: cash.total_cash ?? null, ar_outstanding: wc.receivables ?? null, ap_outstanding: wc.payables ?? null,
          runway_days: runway.runway_days_net ?? runway.runway_days_gross ?? null, dso_days: wc.dso_days ?? null,
          // kept for the existing frontend (same keys as before)
          runway_months: runway.runway_days_gross != null ? Math.min(36, parseFloat((runway.runway_days_gross / 30).toFixed(1))) : 0, /*runway-cap*/
          monthly_burn: runway.avg_monthly_outflow ?? 0, pipeline_value: parseFloat((pipe.rows[0] as any).v || 0),
        },
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/cfo/dashboard (previously 500'd on an invalid ORDER BY) ──
  router.get('/dashboard', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = tid(req);
      const [cash, wc, runway, proj, comp, pipeline] = await Promise.all([
        runMetric(pool, t, 'cash_position', {}), runMetric(pool, t, 'working_capital', {}), runMetric(pool, t, 'cash_runway', {}),
        pool.query(`SELECT COUNT(*) FILTER (WHERE status='active') AS active, COALESCE(SUM(budget) FILTER (WHERE status='active'),0) AS total_budget,
                    COALESCE(SUM(spent) FILTER (WHERE status='active'),0) AS total_spent FROM projects WHERE tenant_id=$1`, [t]).catch(() => ({ rows: [{}] })),
        runMetric(pool, t, 'compliance_alerts', {}),
        pool.query(`SELECT COALESCE(SUM(value*probability/100),0) AS weighted FROM crm_leads WHERE tenant_id=$1 AND stage NOT IN ('won','lost')`, [t]).catch(() => ({ rows: [{}] })),
      ]);
      const p: any = proj.rows[0] || {};
      const budget = parseFloat(p.total_budget || 0);
      res.json({
        cash: cash.total_cash ?? 0, ar: wc.receivables ?? 0, ap: wc.payables ?? 0, working_capital: wc.working_capital ?? 0,
        monthly_burn: runway.avg_monthly_outflow ?? 0, net_monthly_burn: runway.net_monthly_burn ?? 0,
        runway_months: runway.runway_days_gross != null ? Math.min(36, parseFloat((runway.runway_days_gross / 30).toFixed(1))) : 0, /*runway-cap*/
        runway_days_net: runway.runway_days_net ?? null, cash_flow_positive: runway.cash_flow_positive ?? null,
        dso_days: wc.dso_days ?? null, dpo_days: wc.dpo_days ?? null, ar_overdue: wc.ar_overdue ?? 0,
        pipeline_weighted: parseFloat((pipeline.rows[0] as any)?.weighted || 0),
        overdue_compliance: comp.overdue_compliance_items ?? 0,
        active_projects: parseInt(p.active || 0),
        project_burn_pct: budget > 0 ? parseFloat(((parseFloat(p.total_spent || 0) / budget) * 100).toFixed(1)) : 0,
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/cfo/brief (now grounded in tools; optional custom prompt) ──
  router.post('/brief', requireAuth, async (req: Request, res: Response) => {
    try {
      const { prompt } = req.body || {};
      const q = prompt || 'Give a 120-word executive brief: overall financial health, the top 3 priorities today, and one action item. Check cash, runway, receivables aging, payments due this week, risks and compliance first.';
      const { answer, tools_used } = await agentLoop(pool, tid(req), [], q);
      res.json({ text: answer, tools_used });
    } catch (err) { console.error('[cfo/brief] /*cfo-brief-log*/', err); res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/cfo/twin-context — real baseline figures for the Digital Twin (null where the books have no data) ──
  router.get('/twin-context', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = tid(req);
      const [cash, runway, wc, pnl, emp]: any[] = await Promise.all([
        runMetric(pool, t, 'cash_position', {}), runMetric(pool, t, 'cash_runway', {}), runMetric(pool, t, 'working_capital', {}),
        runMetric(pool, t, 'pnl_trend', { months: 13 }),
        pool.query(`SELECT COUNT(*)::int AS n FROM employees WHERE tenant_id=$1 AND status='active'`, [t]).catch(() => null),
      ]);
      // completed months only (the last pnl month is month-to-date), starting from the first month with any activity
      const all: any[] = Array.isArray(pnl?.months) ? pnl.months.filter((m: any) => !m.partial_month) : [];
      const firstActive = all.findIndex((m: any) => (m.revenue || 0) > 0 || (m.vendor_costs || 0) + (m.payroll || 0) + (m.expense_claims || 0) > 0);
      const covered: any[] = firstActive >= 0 ? all.slice(firstActive) : [];
      const n = covered.length;
      const sum = (f: (m: any) => number) => covered.reduce((a, m) => a + (f(m) || 0), 0);
      const revenue = sum(m => m.revenue);
      const costs = sum(m => m.vendor_costs + m.payroll + m.expense_claims);
      const ebitda = sum(m => m.ebitda);
      const employees = emp?.rows?.[0]?.n > 0 ? emp.rows[0].n : null;
      res.json({
        as_of: new Date().toISOString(), currency: 'INR',
        months_covered: n,
        basis: n > 0 ? 'Average of the last ' + n + ' completed month(s) of invoices, payroll and approved claims, annualised for revenue. Not a general-ledger P&L.' : 'No invoices, payroll or claims found - nothing to prefill.',
        baseline: {
          annual_revenue: n > 0 && revenue > 0 ? Math.round((revenue / n) * 12) : null,
          monthly_opex: n > 0 && costs > 0 ? Math.round(costs / n) : null,
          employees,
        },
        position: {
          cash: cash?.total_cash ?? null,
          runway_months: runway?.runway_days_gross != null ? Math.min(36, parseFloat((runway.runway_days_gross / 30).toFixed(1))) : null,
          net_monthly_burn: runway?.net_monthly_burn ?? null,
          receivables: wc?.receivables ?? null, payables: wc?.payables ?? null, working_capital: wc?.working_capital ?? null,
          dso_days: wc?.dso_days ?? null, ar_overdue: wc?.ar_overdue ?? null,
          ebitda_margin_pct: n > 0 && revenue > 0 ? parseFloat(((ebitda / revenue) * 100).toFixed(1)) : null,
        },
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/cfo/metrics — list; GET /api/cfo/metrics/:name?param=… — run directly (dashboards, crons, debugging) ──
  router.get('/metrics', requireAuth, (_req: Request, res: Response) => {
    res.json({ metrics: Object.entries(METRICS).map(([name, m]) => ({ name, description: m.description, input: m.input_schema.properties })) });
  });

  router.get('/metrics/:name', requireAuth, async (req: Request, res: Response) => {
    if (!METRICS[req.params.name]) { res.status(404).json({ error: 'unknown metric' }); return; }
    const input: Record<string, any> = {};
    for (const [k, v] of Object.entries(req.query)) {
      const type = METRICS[req.params.name].input_schema.properties[k]?.type;
      input[k] = type === 'integer' || type === 'number' ? Number(v) : v;
    }
    res.json(await runMetric(pool, tid(req), req.params.name, input));
  });

  // ── POST /api/cfo/snapshot — record today's snapshot now (also runs automatically every 6h) ──
  router.post('/snapshot', requireAuth, async (req: Request, res: Response) => {
    try { res.json({ success: true, metrics: await recordSnapshot(pool, tid(req)) }); }
    catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
