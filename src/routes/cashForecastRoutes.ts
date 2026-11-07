// GET    /api/cash-forecast?days=90&ar_delay_days=0&collection_pct=100&ap_delay_days=0&monthly_inflow=0&monthly_outflow=0
// POST   /api/cash-forecast/commentary   { ...same settings }  plain-language read of the forecast (AI explains numbers the code computed)
// GET    /api/cash-forecast/scenarios    saved scenarios
// POST   /api/cash-forecast/scenarios    { name, params }
// DELETE /api/cash-forecast/scenarios/:id
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../middleware/auth';
import { runForecast, loadForecastInputs, FcOpts } from '../services/cashForecast';

const MODEL = 'claude-sonnet-4-6';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let tableReady = false;
async function ensureScenarioTable(pool: Pool): Promise<void> {
  if (tableReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS cash_forecast_scenarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name TEXT NOT NULL,
    params JSONB NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cfs_tenant ON cash_forecast_scenarios (tenant_id, created_at DESC)`);
  tableReady = true;
}

const num = (v: any, d: number, lo: number, hi: number): number => {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? d : Math.max(lo, Math.min(hi, n));
};
const parseOpts = (q: any): FcOpts => ({
  days: num(q.days, 90, 7, 365),
  ar_delay_days: num(q.ar_delay_days, 0, 0, 180),
  collection_pct: num(q.collection_pct, 100, 0, 100),
  ap_delay_days: num(q.ap_delay_days, 0, 0, 180),
  monthly_inflow: num(q.monthly_inflow, 0, 0, 1e11),
  monthly_outflow: num(q.monthly_outflow, 0, 0, 1e11),
});
const same = (a: FcOpts, b: FcOpts) => a.ar_delay_days === b.ar_delay_days && a.collection_pct === b.collection_pct && a.ap_delay_days === b.ap_delay_days;

async function build(pool: Pool, tenantId: string, custom: FcOpts) {
  const base: FcOpts = { ...custom, ar_delay_days: 0, collection_pct: 100, ap_delay_days: 0 };
  const slow: FcOpts = { ...custom, ar_delay_days: 30, collection_pct: 100, ap_delay_days: 0 };
  const { opening, items, today } = await loadForecastInputs(pool, tenantId);
  const scenarios: any[] = [
    { key: 'base', label: 'As booked', ...runForecast(opening.amount, items, base, today) },
    { key: 'slow30', label: 'Customers pay 30 days late', ...runForecast(opening.amount, items, slow, today) },
  ];
  if (!same(custom, base) && !same(custom, slow)) scenarios.push({ key: 'custom', label: 'Your scenario', ...runForecast(opening.amount, items, custom, today) });
  return { opening, items, today, scenarios };
}

const SYSTEM = `You are a finance analyst explaining a cash forecast to the owner of a small Indian business.
Rules:
- Use ONLY the figures in the JSON you are given. Every amount and date is already written as finished text (for example "₹11.80 Cr" or "27 Dec"): copy those strings exactly as given. Never convert, re-spell, round, add up or recompute any amount, and never write amounts in words.
- 120 to 170 words, plain language, no jargon, no markdown headings. Use short paragraphs; at most 3 bullet points starting with "- ".
- Cover: (1) where cash is heading and the lowest point, (2) which receivable or bill matters most and whether one customer is a concentration risk, (3) what changes if customers pay late, (4) one or two practical next steps.
- If has_cash_entry is false, say the forecast starts from zero and the owner should enter a cash balance first.
- Say plainly what the forecast leaves out: salaries, taxes and unbilled sales unless monthly amounts were entered.
- Do not give investment, tax or legal advice.`;

const lastCall = new Map<string, number>();

// The model never formats numbers: every amount and date reaches it as finished text.
const inrText = (n: number): string => {
  const a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e7) return sign + '₹' + (a / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return sign + '₹' + (a / 1e5).toFixed(2) + ' lakh';
  return sign + '₹' + Math.round(a).toLocaleString('en-IN');
};
const dateText = (s: string | null): string | null => (s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : null);

export function createCashForecastRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const custom = parseOpts(req.query);
      const { opening, items, today, scenarios } = await build(pool, tid(req), custom);
      const upcoming = items.map(i => ({ ...i })).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 25);
      res.json({
        as_of: today, has_cash_entry: opening.has_entry, opening: opening.amount, scenarios, upcoming,
        counts: { receivables: items.filter(i => i.kind === 'in').length, payables: items.filter(i => i.kind === 'out').length },
        note: 'Built only from your open invoices and bills plus the assumptions you set. Salaries, taxes and new sales that are not yet recorded are not included unless you enter them as monthly amounts.',
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/commentary', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY) { res.status(503).json({ error: 'AI commentary is not configured on this server.' }); return; }
      const t = tid(req);
      const now = Date.now();
      if (now - (lastCall.get(t) || 0) < 8000) { res.status(429).json({ error: 'Please wait a few seconds before asking again.' }); return; }
      lastCall.set(t, now);
      const custom = parseOpts(req.body || {});
      const { opening, items, today, scenarios } = await build(pool, t, custom);
      const recv = items.filter(i => i.kind === 'in');
      const totalRecv = recv.reduce((a, i) => a + i.amount, 0);
      const facts = {
        today: dateText(today), has_cash_entry: opening.has_entry, cash_today: inrText(opening.amount),
        assumptions: {
          forecast_days: custom.days, customers_pay_late_by_days: custom.ar_delay_days, share_of_receivables_collected_pct: custom.collection_pct,
          suppliers_paid_late_by_days: custom.ap_delay_days, other_monthly_costs_entered: inrText(custom.monthly_outflow), new_monthly_sales_entered: inrText(custom.monthly_inflow),
        },
        scenarios: scenarios.map(s => ({
          name: s.label, closing_cash: inrText(s.closing), total_receipts: inrText(s.total_in), total_payments: inrText(s.total_out),
          lowest_cash: inrText(s.lowest.amount), lowest_cash_date: dateText(s.lowest.date),
          first_day_cash_negative: dateText(s.first_negative), cover_needed_if_negative: s.shortfall > 0 ? inrText(s.shortfall) : null,
        })),
        open_receivables: { count: recv.length, total: inrText(totalRecv), largest: recv.slice().sort((a, b) => b.amount - a.amount).slice(0, 5).map(i => ({ customer: i.party, invoice: i.ref, amount: inrText(i.amount), due: dateText(i.due), overdue: i.overdue, share_of_receivables_pct: totalRecv > 0 ? Math.round((i.amount / totalRecv) * 100) : 0 })) },
        open_payables: { count: items.length - recv.length, largest: items.filter(i => i.kind === 'out').sort((a, b) => b.amount - a.amount).slice(0, 5).map(i => ({ vendor: i.party, bill: i.ref, amount: inrText(i.amount), due: dateText(i.due), overdue: i.overdue })) },
      };
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp: any = await anthropic.messages.create({ model: MODEL, max_tokens: 700, system: SYSTEM, messages: [{ role: 'user', content: JSON.stringify(facts) }] });
      const text = (resp.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
      if (!text) { res.status(502).json({ error: 'The AI returned an empty answer. Please try again.' }); return; }
      res.json({ text, generated_at: new Date().toISOString() });
    } catch (err) { res.status(500).json({ error: 'Could not generate commentary: ' + String((err as any)?.message || err) }); }
  });

  router.get('/scenarios', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensureScenarioTable(pool);
      const r = await pool.query(`SELECT id, name, params, created_at FROM cash_forecast_scenarios WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50`, [tid(req)]);
      res.json({ scenarios: r.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/scenarios', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensureScenarioTable(pool);
      const name = String((req.body || {}).name || '').trim().slice(0, 80);
      if (!name) { res.status(400).json({ error: 'Give the scenario a name.' }); return; }
      const params = parseOpts((req.body || {}).params || {});
      const c = await pool.query(`SELECT COUNT(*)::int AS n FROM cash_forecast_scenarios WHERE tenant_id = $1`, [tid(req)]);
      if (c.rows[0].n >= 20) { res.status(409).json({ error: 'You can keep up to 20 saved scenarios. Delete one first.' }); return; }
      const r = await pool.query(
        `INSERT INTO cash_forecast_scenarios (tenant_id, name, params, created_by) VALUES ($1,$2,$3,$4) RETURNING id, name, params, created_at`,
        [tid(req), name, JSON.stringify(params), (req as any).user.email || (req as any).user.id || null]);
      res.json({ scenario: r.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.delete('/scenarios/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensureScenarioTable(pool);
      const id = String(req.params.id);
      if (!UUID.test(id)) { res.status(404).json({ error: 'Not found' }); return; }
      const r = await pool.query(`DELETE FROM cash_forecast_scenarios WHERE id = $1 AND tenant_id = $2`, [id, tid(req)]);
      if (!r.rowCount) { res.status(404).json({ error: 'Scenario not found' }); return; }
      res.json({ deleted: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
