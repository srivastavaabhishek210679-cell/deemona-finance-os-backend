// ============================================================
// Deemona AI Finance OS — Proactive CFO routes (Step 3)
// Mounted at /api/cfo-proactive. Any signed-in user of the tenant can use
// these (no role gating, same as CFO Setup).
// ============================================================
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import {
  ensureProactiveTables, evaluateAlerts, getRuleSettings, setRuleSetting, RULES,
  getBriefSettings, setBriefSettings, generateBrief, buildBoardPack, CADENCES, Cadence,
} from '../services/cfoProactive';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALERT_STATUSES = ['open', 'acknowledged', 'dismissed', 'resolved'];

export function createCfoProactiveRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;
  const fail = (res: Response, e: unknown, code = 500) => { res.status(code).json({ error: e instanceof Error ? e.message : String(e) }); };
  router.use(requireAuth);

  // ── Alerts ("AI asks") ─────────────────────────────────────
  router.get('/alerts', async (req, res) => {
    try {
      await ensureProactiveTables(pool);
      const status = String(req.query.status || 'open');
      const wanted = status === 'all' ? ALERT_STATUSES : status.split(',').filter(s => ALERT_STATUSES.includes(s));
      if (!wanted.length) { res.status(400).json({ error: 'status must be open, acknowledged, dismissed, resolved or all' }); return; }
      const r = await pool.query(
        `SELECT id, rule_key, severity, title, detail, ask, evidence, status, note, first_raised_at, last_seen_at, resolved_at
         FROM cfo_alerts WHERE tenant_id=$1 AND status = ANY($2::text[])
         ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, first_raised_at DESC LIMIT 200`, [tid(req), wanted]);
      const counts = await pool.query(`SELECT status, COUNT(*)::int AS n FROM cfo_alerts WHERE tenant_id=$1 GROUP BY status`, [tid(req)]);
      res.json({ alerts: r.rows, counts: Object.fromEntries(counts.rows.map(c => [c.status, c.n])) });
    } catch (e) { fail(res, e); }
  });

  router.post('/alerts/run', async (req, res) => {
    try { res.json({ success: true, ...(await evaluateAlerts(pool, tid(req))) }); } catch (e) { fail(res, e); }
  });

  router.patch('/alerts/:id', async (req, res) => {
    try {
      const { status, note } = req.body || {};
      if (!UUID.test(req.params.id)) { res.status(400).json({ error: 'invalid id' }); return; }
      if (!['open', 'acknowledged', 'dismissed'].includes(status)) { res.status(400).json({ error: 'status must be open, acknowledged or dismissed' }); return; }
      const r = await pool.query(`UPDATE cfo_alerts SET status=$3, note=COALESCE($4, note) WHERE id=$1 AND tenant_id=$2 AND status <> 'resolved' RETURNING id, status`,
        [req.params.id, tid(req), status, typeof note === 'string' ? note.slice(0, 500) : null]);
      if (!r.rowCount) { res.status(404).json({ error: 'alert not found or already resolved' }); return; }
      res.json(r.rows[0]);
    } catch (e) { fail(res, e); }
  });

  // ── Rules ──────────────────────────────────────────────────
  router.get('/rules', async (req, res) => { try { res.json({ rules: await getRuleSettings(pool, tid(req)) }); } catch (e) { fail(res, e); } });

  router.put('/rules/:key', async (req, res) => {
    try {
      const rule = RULES.find(r => r.key === req.params.key);
      if (!rule) { res.status(404).json({ error: 'unknown rule' }); return; }
      const enabled = req.body?.enabled !== false;
      let threshold: number | null = rule.default_threshold;
      if (rule.default_threshold !== null && req.body?.threshold !== undefined && req.body.threshold !== null && req.body.threshold !== '') {
        threshold = Number(req.body.threshold);
        if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 100000) { res.status(400).json({ error: 'threshold must be a positive number' }); return; }
      }
      await setRuleSetting(pool, tid(req), rule.key, enabled, threshold);
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });

  // ── Briefs ─────────────────────────────────────────────────
  router.get('/settings', async (req, res) => { try { res.json(await getBriefSettings(pool, tid(req))); } catch (e) { fail(res, e); } });

  router.put('/settings', async (req, res) => {
    try {
      const b = req.body || {}; const hour = parseInt(b.brief_hour, 10);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) { res.status(400).json({ error: 'brief_hour must be 0-23 (India time)' }); return; }
      await setBriefSettings(pool, tid(req), { daily_brief: b.daily_brief !== false, weekly_brief: b.weekly_brief !== false, monthly_brief: b.monthly_brief !== false, brief_hour: hour });
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });

  router.get('/briefs', async (req, res) => {
    try {
      await ensureProactiveTables(pool);
      const c = String(req.query.cadence || 'all');
      if (c !== 'all' && ![...CADENCES, 'board'].includes(c)) { res.status(400).json({ error: 'invalid cadence' }); return; }
      const limit = Math.min(60, Math.max(1, parseInt(String(req.query.limit || '30'), 10) || 30));
      const r = await pool.query(
        `SELECT id, cadence, period_label, title, source, generated_at FROM cfo_briefs
         WHERE tenant_id=$1 AND ($2 = 'all' OR cadence = $2) ORDER BY generated_at DESC LIMIT $3`, [tid(req), c, limit]);
      res.json({ briefs: r.rows });
    } catch (e) { fail(res, e); }
  });

  router.get('/briefs/:id', async (req, res) => {
    try {
      if (!UUID.test(req.params.id)) { res.status(400).json({ error: 'invalid id' }); return; }
      const r = await pool.query(`SELECT id, cadence, period_label, title, content, data, tools_used, source, generated_at FROM cfo_briefs WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]);
      if (!r.rowCount) { res.status(404).json({ error: 'not found' }); return; }
      res.json(r.rows[0]);
    } catch (e) { fail(res, e); }
  });

  router.post('/briefs/generate', async (req, res) => {
    try {
      const cadence = req.body?.cadence as Cadence;
      if (!CADENCES.includes(cadence)) { res.status(400).json({ error: 'cadence must be daily, weekly or monthly' }); return; }
      res.json(await generateBrief(pool, tid(req), cadence, 'manual'));
    } catch (e) { fail(res, e); }
  });

  // ── Board pack ─────────────────────────────────────────────
  router.post('/board-pack', async (req, res) => {
    try { res.json(await buildBoardPack(pool, tid(req))); } catch (e) { fail(res, e); }
  });

  return router;
}
