// ============================================================
// /api/cfo-setup — manage the data the CFO agent needs for
// targets, business-unit / region / product views and forecasts.
// ============================================================
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import {
  ensureCfoSetupTables, DIM_KINDS, DimKind, DIM_COLUMN, TARGET_METRICS, FORECAST_METRICS, PERIOD_TYPES, PeriodType,
  isAlignedStart, isYmd, periodEnd,
} from '../services/cfoSetup';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: any): boolean => typeof v === 'string' && UUID.test(v);
const bad = (res: Response, msg: string): void => { res.status(400).json({ error: msg }); };

export function createCfoSetupRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => String((req as any).user.tenantId);

  // make sure tables exist before any handler runs
  router.use(requireAuth, async (_req, res, next) => {
    try { await ensureCfoSetupTables(pool); next(); } catch (e) { res.status(500).json({ error: 'setup tables unavailable: ' + String(e) }); }
  });

  // ── meta: what can be configured ───────────────────────────
  router.get('/meta', (_req, res) => {
    res.json({ dimension_kinds: DIM_KINDS, target_metrics: TARGET_METRICS, forecast_metrics: FORECAST_METRICS, period_types: PERIOD_TYPES, fiscal_year: 'April–March' });
  });

  // ── dimensions: business units / regions / products ────────
  router.get('/dimensions', async (req, res) => {
    try {
      const r = await pool.query(`SELECT id, kind, name, code, is_active FROM cfo_dimensions WHERE tenant_id=$1 ORDER BY kind, name`, [tid(req)]);
      const out: Record<string, any[]> = { business_unit: [], region: [], product: [] };
      r.rows.forEach(x => out[x.kind].push(x));
      res.json(out);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/dimensions', async (req, res) => {
    try {
      const { kind, name, code } = req.body || {};
      if (!DIM_KINDS.includes(kind)) return bad(res, 'kind must be business_unit, region or product');
      if (!name || !String(name).trim()) return bad(res, 'name is required');
      const r = await pool.query(
        `INSERT INTO cfo_dimensions (tenant_id, kind, name, code) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, kind, name) DO UPDATE SET is_active = TRUE, code = COALESCE(EXCLUDED.code, cfo_dimensions.code) RETURNING *`,
        [tid(req), kind, String(name).trim(), code || null]);
      res.json({ dimension: r.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/dimensions/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return bad(res, 'invalid id');
      const { name, code, is_active } = req.body || {};
      const r = await pool.query(
        `UPDATE cfo_dimensions SET name = COALESCE($1,name), code = COALESCE($2,code), is_active = COALESCE($3,is_active)
         WHERE id=$4 AND tenant_id=$5 RETURNING *`, [name ? String(name).trim() : null, code ?? null, typeof is_active === 'boolean' ? is_active : null, req.params.id, tid(req)]);
      if (!r.rows.length) { res.status(404).json({ error: 'not found' }); return; }
      res.json({ dimension: r.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // Deactivate (history keeps its name; it just disappears from pickers)
  router.delete('/dimensions/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return bad(res, 'invalid id');
      await pool.query(`UPDATE cfo_dimensions SET is_active = FALSE WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── default tags for customers / vendors ───────────────────
  // Every invoice of a customer (or vendor) inherits its default business unit / region / product,
  // unless the invoice itself has an explicit tag. No change to your invoicing screens is needed.
  router.get('/defaults', async (req, res) => {
    try {
      const type = req.query.entity_type === 'vendor' ? 'vendor' : 'customer';
      const table = type === 'vendor' ? 'vendors' : 'customers';
      const r = await pool.query(
        `SELECT e.id::text AS entity_id, e.name, d.business_unit_id, d.region_id, d.product_id
         FROM ${table} e LEFT JOIN cfo_entity_defaults d ON d.tenant_id = e.tenant_id::text AND d.entity_type = $2 AND d.entity_id = e.id::text
         WHERE e.tenant_id = $1 ORDER BY e.name LIMIT 2000`, [tid(req), type]);
      res.json({ entity_type: type, entities: r.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.put('/defaults', async (req, res) => {
    try {
      const { entity_type, entity_ids, entity_id } = req.body || {};
      if (!['customer', 'vendor'].includes(entity_type)) return bad(res, 'entity_type must be customer or vendor');
      const ids: string[] = (Array.isArray(entity_ids) ? entity_ids : [entity_id]).filter(Boolean).map(String);
      if (!ids.length) return bad(res, 'entity_id or entity_ids required');
      if (ids.length > 500) return bad(res, 'max 500 at a time');
      const f: Record<string, any> = {};
      for (const k of DIM_KINDS) {
        const col = DIM_COLUMN[k]; const v = (req.body || {})[col];
        if (v === undefined) continue;
        if (v !== null && !isUuid(v)) return bad(res, `${col} must be a uuid or null`);
        f[col] = v;
      }
      if (!Object.keys(f).length) return bad(res, 'provide at least one of business_unit_id, region_id, product_id (null clears it)');
      // validate that each tag belongs to this tenant and the right kind
      for (const k of DIM_KINDS) {
        const v = f[DIM_COLUMN[k]]; if (!v) continue;
        const ok = await pool.query(`SELECT 1 FROM cfo_dimensions WHERE id=$1 AND tenant_id=$2 AND kind=$3`, [v, tid(req), k]);
        if (!ok.rows.length) return bad(res, `${DIM_COLUMN[k]} does not exist`);
      }
      let n = 0;
      for (const id of ids) {
        // only fields supplied are changed; others keep their value
        await pool.query(
          `INSERT INTO cfo_entity_defaults (tenant_id, entity_type, entity_id, business_unit_id, region_id, product_id)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, entity_type, entity_id) DO UPDATE SET
             business_unit_id = CASE WHEN $7 THEN EXCLUDED.business_unit_id ELSE cfo_entity_defaults.business_unit_id END,
             region_id        = CASE WHEN $8 THEN EXCLUDED.region_id        ELSE cfo_entity_defaults.region_id END,
             product_id       = CASE WHEN $9 THEN EXCLUDED.product_id       ELSE cfo_entity_defaults.product_id END,
             updated_at = NOW()`,
          [tid(req), entity_type, id, f.business_unit_id ?? null, f.region_id ?? null, f.product_id ?? null,
           'business_unit_id' in f, 'region_id' in f, 'product_id' in f]);
        n++;
      }
      res.json({ success: true, updated: n });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── explicit tags on individual invoices (overrides the customer/vendor default) ──
  router.post('/tag', async (req, res) => {
    try {
      const { table, ids } = req.body || {};
      if (!['ar_invoices', 'ap_invoices'].includes(table)) return bad(res, 'table must be ar_invoices or ap_invoices');
      if (!Array.isArray(ids) || !ids.length || ids.length > 1000) return bad(res, 'ids: 1-1000 invoice ids required');
      const sets: string[] = []; const params: any[] = [tid(req), ids.map(String)];
      for (const k of DIM_KINDS) {
        const col = DIM_COLUMN[k]; const v = (req.body || {})[col];
        if (v === undefined) continue;
        if (v !== null && !isUuid(v)) return bad(res, `${col} must be a uuid or null`);
        params.push(v); sets.push(`${col} = $${params.length}`);
      }
      if (!sets.length) return bad(res, 'provide a tag to set');
      const r = await pool.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE tenant_id=$1 AND id::text = ANY($2::text[])`, params);
      res.json({ success: true, updated: r.rowCount });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── tagging coverage (data quality: what share of revenue / cost can be broken down) ──
  router.get('/coverage', async (req, res) => {
    try {
      const t = tid(req);
      const out: Record<string, any> = {};
      for (const k of DIM_KINDS) {
        const col = DIM_COLUMN[k];
        const rev = await pool.query(
          `SELECT COALESCE(SUM(ar.subtotal),0) AS total, COALESCE(SUM(ar.subtotal) FILTER (WHERE COALESCE(ar.${col}, cd.${col}) IS NOT NULL),0) AS tagged
           FROM ar_invoices ar LEFT JOIN cfo_entity_defaults cd ON cd.tenant_id=ar.tenant_id::text AND cd.entity_type='customer' AND cd.entity_id=ar.customer_id::text
           WHERE ar.tenant_id=$1 AND ar.status NOT IN ('draft','cancelled') AND ar.date::date >= CURRENT_DATE - 90`, [t]);
        const cost = await pool.query(
          `SELECT COALESCE(SUM(ap.subtotal),0) AS total, COALESCE(SUM(ap.subtotal) FILTER (WHERE COALESCE(ap.${col}, vd.${col}) IS NOT NULL),0) AS tagged
           FROM ap_invoices ap LEFT JOIN cfo_entity_defaults vd ON vd.tenant_id=ap.tenant_id::text AND vd.entity_type='vendor' AND vd.entity_id=ap.vendor_id::text
           WHERE ap.tenant_id=$1 AND ap.status NOT IN ('draft','rejected') AND ap.date::date >= CURRENT_DATE - 90`, [t]);
        const p = (x: any): number => { const total = parseFloat(x.total); return total > 0 ? Math.round((parseFloat(x.tagged) / total) * 1000) / 10 : 0; };
        out[k] = { revenue_tagged_pct: p(rev.rows[0]), cost_tagged_pct: p(cost.rows[0]) };
      }
      res.json({ window: 'last 90 days', coverage: out });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── targets (the plan) ─────────────────────────────────────
  async function upsertTarget(t: string, b: any): Promise<{ error?: string; target?: any }> {
    const { metric, period_type, period_start, dimension_kind, dimension_id, target_value, notes } = b || {};
    if (!TARGET_METRICS[metric]) return { error: `metric must be one of ${Object.keys(TARGET_METRICS).join(', ')}` };
    if (!PERIOD_TYPES.includes(period_type)) return { error: 'period_type must be month, quarter or year' };
    if (!isAlignedStart(period_type as PeriodType, period_start)) return { error: `period_start ${period_start} is not a valid ${period_type} start (fiscal year is April–March; quarters start Apr/Jul/Oct/Jan)` };
    const v = Number(target_value);
    if (!Number.isFinite(v) || v < 0) return { error: 'target_value must be a non-negative number' };
    let dk: string | null = null, did: string | null = null;
    if (dimension_id || dimension_kind) {
      if (!DIM_KINDS.includes(dimension_kind) || !isUuid(dimension_id)) return { error: 'dimension_kind and dimension_id (uuid) must be given together' };
      if (!TARGET_METRICS[metric].dims) return { error: `${metric} targets cannot be set per ${dimension_kind} (only revenue and vendor_costs can be split)` };
      const ok = await pool.query(`SELECT 1 FROM cfo_dimensions WHERE id=$1 AND tenant_id=$2 AND kind=$3`, [dimension_id, t, dimension_kind]);
      if (!ok.rows.length) return { error: 'dimension does not exist' };
      dk = dimension_kind; did = dimension_id;
    }
    const upd = await pool.query(
      `UPDATE cfo_targets SET target_value=$1, notes=$2, dimension_kind=$3, updated_at=NOW()
       WHERE tenant_id=$4 AND metric=$5 AND period_type=$6 AND period_start=$7
         AND COALESCE(dimension_id,'00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($8::uuid,'00000000-0000-0000-0000-000000000000'::uuid) RETURNING *`,
      [v, notes || null, dk, t, metric, period_type, period_start, did]);
    if (upd.rows.length) return { target: upd.rows[0] };
    const ins = await pool.query(
      `INSERT INTO cfo_targets (tenant_id, metric, period_type, period_start, dimension_kind, dimension_id, target_value, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [t, metric, period_type, period_start, dk, did, v, notes || null]);
    return { target: ins.rows[0] };
  }

  router.get('/targets', async (req, res) => {
    try {
      const params: any[] = [tid(req)]; let where = '';
      if (PERIOD_TYPES.includes(req.query.period_type as any)) { params.push(req.query.period_type); where += ` AND t.period_type=$${params.length}`; }
      if (req.query.metric) { params.push(String(req.query.metric)); where += ` AND t.metric=$${params.length}`; }
      if (isYmd(req.query.from as string)) { params.push(req.query.from); where += ` AND t.period_start >= $${params.length}`; }
      const r = await pool.query(
        `SELECT t.id, t.metric, t.period_type, t.period_start::text AS period_start, t.dimension_kind, t.dimension_id, d.name AS dimension_name, t.target_value, t.notes
         FROM cfo_targets t LEFT JOIN cfo_dimensions d ON d.id = t.dimension_id
         WHERE t.tenant_id=$1${where} ORDER BY t.period_start DESC, t.metric LIMIT 1000`, params);
      res.json({ targets: r.rows.map(x => ({ ...x, period_end: periodEnd(x.period_type, x.period_start), target_value: parseFloat(x.target_value) })) });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.put('/targets', async (req, res) => {
    try {
      const r = await upsertTarget(tid(req), req.body);
      if (r.error) return bad(res, r.error);
      res.json({ target: r.target });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // many at once: { targets: [ {...}, {...} ] }  (e.g. 12 monthly revenue targets)
  router.post('/targets/bulk', async (req, res) => {
    try {
      const list = Array.isArray(req.body?.targets) ? req.body.targets : [];
      if (!list.length || list.length > 200) return bad(res, 'targets: 1-200 items required');
      const errors: any[] = []; let saved = 0;
      for (let i = 0; i < list.length; i++) {
        const r = await upsertTarget(tid(req), list[i]);
        if (r.error) errors.push({ index: i, error: r.error }); else saved++;
      }
      res.json({ saved, errors });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.delete('/targets/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return bad(res, 'invalid id');
      await pool.query(`DELETE FROM cfo_targets WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── forecasts ───────────────────────────────────────────────
  // The system saves a baseline forecast automatically (see cfoMetrics.recordForecasts).
  // The CFO can overwrite it with a manual forecast; forecast_vs_actual prefers the manual one.
  router.get('/forecasts', async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT metric, period_start::text AS period_start, forecast_value, source, method, made_on::text AS made_on
         FROM cfo_forecasts WHERE tenant_id=$1 ORDER BY period_start DESC, metric, source LIMIT 500`, [tid(req)]);
      res.json({ forecasts: r.rows.map(x => ({ ...x, forecast_value: parseFloat(x.forecast_value) })) });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.put('/forecasts', async (req, res) => {
    try {
      const { metric, period_start, forecast_value, method } = req.body || {};
      if (!(FORECAST_METRICS as readonly string[]).includes(metric)) return bad(res, `metric must be one of ${FORECAST_METRICS.join(', ')}`);
      if (!isAlignedStart('month', period_start)) return bad(res, 'period_start must be the first day of a month (YYYY-MM-01)');
      const v = Number(forecast_value);
      if (!Number.isFinite(v) || v < 0) return bad(res, 'forecast_value must be a non-negative number');
      const r = await pool.query(
        `INSERT INTO cfo_forecasts (tenant_id, metric, period_start, forecast_value, source, method) VALUES ($1,$2,$3,$4,'manual',$5)
         ON CONFLICT (tenant_id, metric, period_start, source) DO UPDATE SET forecast_value=EXCLUDED.forecast_value, method=EXCLUDED.method, made_on=CURRENT_DATE
         RETURNING *`, [tid(req), metric, period_start, v, method || 'manual']);
      res.json({ forecast: r.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
