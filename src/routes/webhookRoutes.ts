// ============================================================
// Level 2 (Real-Time Twin): inbound webhooks + sync health.
//
// Admin (login required), mounted at /api/webhooks
//   GET    /endpoints            list receiving endpoints
//   POST   /endpoints            create one { name, source } -> returns the secret ONCE
//   POST   /endpoints/:id/rotate new secret (shown once)
//   PATCH  /endpoints/:id        { is_active }
//   DELETE /endpoints/:id
//   GET    /events               recent received events
//   GET    /health               freshness of every data source
//
// Inbound (secret in header, no login), mounted at /api/webhook-in
//   POST   /:endpointId          Authorization: Bearer <secret>
//   body: { "entity": "ar_invoice", "event_id": "optional-unique", "data": { ... } }
//      or { "events": [ {entity, event_id, data}, ... ] }   (max 100)
// Entities: customer, vendor, ar_invoice, ap_invoice, payment
// The company is taken from the endpoint, never from the payload.
// ============================================================
import { Router, Request, Response } from 'express';
import { Pool, PoolClient } from 'pg';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { ensurePaymentEventsTable } from './paymentEventsRoutes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const newSecret = () => 'whsec_' + crypto.randomBytes(32).toString('hex');
const todayStr = () => new Date().toISOString().split('T')[0];

let ready = false;
async function ensureTables(pool: Pool): Promise<void> {
  if (ready) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name TEXT NOT NULL,
    source TEXT,
    secret_hash TEXT NOT NULL,
    secret_hint TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    last_received_at TIMESTAMPTZ,
    events_ok INT DEFAULT 0,
    events_failed INT DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    endpoint_id UUID NOT NULL,
    event_id TEXT,
    entity TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_event_once ON webhook_events (endpoint_id, event_id) WHERE status = 'ok' AND event_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_webhook_events_tenant ON webhook_events (tenant_id, created_at DESC)`);
  await ensurePaymentEventsTable(pool);
  ready = true;
}

// ── small validators ─────────────────────────────────────────
class Bad extends Error {}
const str = (v: any, max = 200): string => (v === undefined || v === null) ? '' : String(v).trim().slice(0, max);
const need = (v: any, label: string, max = 200): string => { const s = str(v, max); if (!s) throw new Bad(label + ' is required'); return s; };
const num = (v: any, label: string, opts: { min?: number; required?: boolean } = {}): number | null => {
  if (v === undefined || v === null || v === '') { if (opts.required) throw new Bad(label + ' is required'); return null; }
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > 1e13) throw new Bad(label + ' must be a number');
  if (opts.min !== undefined && n < opts.min) throw new Bad(label + ' must be at least ' + opts.min);
  return n;
};
const dateOf = (v: any, label: string, required = false): string | null => {
  if (v === undefined || v === null || v === '') { if (required) throw new Bad(label + ' is required'); return null; }
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw new Bad(label + ' must be a date like 2026-11-07');
  return s;
};
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().split('T')[0];

// ── entity handlers (run inside a transaction) ───────────────
async function findOrCreateParty(c: PoolClient, tenant: string, table: 'customers' | 'vendors', name: string, extra: any): Promise<string> {
  const found = await c.query(`SELECT id FROM ${table} WHERE tenant_id = $1 AND lower(name) = lower($2) LIMIT 1`, [tenant, name]);
  const gstin = str(extra?.gstin, 20) || null, email = str(extra?.email, 120) || null, phone = str(extra?.phone, 30) || null;
  if (found.rows.length) {
    if (gstin || email || phone) {
      await c.query(`UPDATE ${table} SET gstin = COALESCE($1, gstin), email = COALESCE($2, email), phone = COALESCE($3, phone), updated_at = NOW() WHERE id = $4`, [gstin, email, phone, found.rows[0].id]);
    }
    return found.rows[0].id;
  }
  const ins = await c.query(`INSERT INTO ${table} (tenant_id, name, gstin, email, phone) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [tenant, name, gstin, email, phone]);
  return ins.rows[0].id;
}

async function upsertInvoice(c: PoolClient, tenant: string, kind: 'ar' | 'ap', d: any): Promise<string> {
  const isAr = kind === 'ar';
  const table = isAr ? 'ar_invoices' : 'ap_invoices';
  const partyTable = isAr ? 'customers' : 'vendors';
  const number = need(d.invoice_number, 'invoice_number', 80);
  const partyName = need(isAr ? d.customer_name : d.vendor_name, isAr ? 'customer_name' : 'vendor_name');
  const date = dateOf(d.date, 'date', true) as string;
  const due = dateOf(d.due_date, 'due_date') || addDays(date, 30);
  const subtotal = num(d.amount, 'amount', { min: 0, required: true }) as number;
  const gst = num(d.gst_rate, 'gst_rate', { min: 0 }) ?? (isAr ? 18 : 0);
  if (gst > 100) throw new Bad('gst_rate must be 0 to 100');
  const tax = Math.round(subtotal * gst) / 100;
  const total = subtotal + tax;
  const allowed = isAr ? ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'cancelled'] : ['draft', 'pending_approval', 'approved', 'paid', 'overdue', 'rejected'];
  const status = str(d.status, 30).toLowerCase() || (isAr ? 'sent' : 'approved');
  if (!allowed.includes(status)) throw new Bad('status must be one of: ' + allowed.join(', '));
  const paidIn = num(d.paid_amount, 'paid_amount', { min: 0 });
  const partyId = await findOrCreateParty(c, tenant, partyTable, partyName, d);
  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [tenant + ':' + kind + ':' + number]);
  const ex = await c.query(`SELECT id, paid_amount FROM ${table} WHERE tenant_id = $1 AND invoice_number = $2 ORDER BY created_at LIMIT 1`, [tenant, number]);
  let paid = paidIn;
  if (paid === null) paid = ex.rows.length ? Number(ex.rows[0].paid_amount) : (status === 'paid' ? total : 0);
  if (paid > total + 0.005) throw new Bad('paid_amount cannot exceed the invoice total');
  if (ex.rows.length) {
    await c.query(
      `UPDATE ${table} SET ${isAr ? 'customer_id' : 'vendor_id'} = $1, date = $2, due_date = $3, subtotal = $4, tax_amount = $5, total_amount = $6,
         paid_amount = $7, status = $8, gst_rate = $9, updated_at = NOW() WHERE id = $10 AND tenant_id = $11`,
      [partyId, date, due, subtotal, tax, total, paid, status, gst, ex.rows[0].id, tenant]);
    return 'updated ' + number;
  }
  await c.query(
    `INSERT INTO ${table} (tenant_id, ${isAr ? 'customer_id' : 'vendor_id'}, invoice_number, date, due_date, status, subtotal, tax_amount, total_amount, paid_amount, tax_type, gst_rate, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'GST',$11,$12)`,
    [tenant, partyId, number, date, due, status, subtotal, tax, total, paid, gst, 'Received by webhook']);
  return 'created ' + number;
}

async function recordPayment(c: PoolClient, tenant: string, d: any): Promise<string> {
  const type = str(d.invoice_type, 4).toLowerCase();
  if (type !== 'ar' && type !== 'ap') throw new Bad("invoice_type must be 'ar' or 'ap'");
  const table = type === 'ar' ? 'ar_invoices' : 'ap_invoices';
  const number = need(d.invoice_number, 'invoice_number', 80);
  const amt = num(d.amount, 'amount', { required: true }) as number;
  if (!(amt > 0)) throw new Bad('amount must be greater than zero');
  const payDate = dateOf(d.payment_date, 'payment_date') || todayStr();
  if (payDate > todayStr()) throw new Bad('payment_date cannot be in the future');
  const inv = await c.query(`SELECT id, status, date, total_amount, paid_amount FROM ${table} WHERE tenant_id = $1 AND invoice_number = $2 ORDER BY created_at LIMIT 1 FOR UPDATE`, [tenant, number]);
  if (!inv.rows.length) throw new Bad('invoice ' + number + ' not found');
  const row = inv.rows[0];
  if (['draft', 'cancelled', 'rejected'].includes(row.status)) throw new Bad('invoice is ' + row.status + ' and cannot take a payment');
  if (payDate < new Date(row.date).toLocaleDateString('en-CA')) throw new Bad('payment_date cannot be before the invoice date');
  const total = Number(row.total_amount), paid = Number(row.paid_amount || 0);
  if (amt > total - paid + 0.005) throw new Bad('amount is more than the outstanding balance');
  await c.query(
    `INSERT INTO invoice_payment_events (tenant_id, invoice_type, invoice_id, payment_date, amount, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6,'webhook')`,
    [tenant, type, row.id, payDate, amt, str(d.reference, 80) || null]);
  const newPaid = paid + amt;
  const full = newPaid >= total - 0.005;
  const newStatus = full ? 'paid' : (type === 'ar' ? 'partially_paid' : row.status);
  await c.query(`UPDATE ${table} SET paid_amount = $1, status = $2, updated_at = NOW() WHERE id = $3 AND tenant_id = $4`, [newPaid, newStatus, row.id, tenant]);
  return 'payment recorded on ' + number;
}

async function handleEvent(pool: Pool, tenant: string, ev: any): Promise<string> {
  const entity = str(ev?.entity, 30).toLowerCase();
  const d = ev?.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Bad('data must be an object');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let msg: string;
    if (entity === 'customer' || entity === 'vendor') {
      await findOrCreateParty(c, tenant, entity === 'customer' ? 'customers' : 'vendors', need(d.name, 'name'), d);
      msg = entity + ' saved';
    } else if (entity === 'ar_invoice') msg = await upsertInvoice(c, tenant, 'ar', d);
    else if (entity === 'ap_invoice') msg = await upsertInvoice(c, tenant, 'ap', d);
    else if (entity === 'payment') msg = await recordPayment(c, tenant, d);
    else throw new Bad('entity must be one of: customer, vendor, ar_invoice, ap_invoice, payment');
    await c.query('COMMIT');
    return msg;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

// ── in-memory throttle (per endpoint) ────────────────────────
const hits = new Map<string, { n: number; t: number }>();
function throttled(key: string, limit: number): boolean {
  const now = Date.now(), h = hits.get(key);
  if (!h || now - h.t > 60000) { hits.set(key, { n: 1, t: now }); return false; }
  h.n++; return h.n > limit;
}
setInterval(() => { const now = Date.now(); hits.forEach((v, k) => { if (now - v.t > 120000) hits.delete(k); }); }, 120000).unref();

// ── inbound (public) ─────────────────────────────────────────
export function createWebhookInboundRouter(pool: Pool): Router {
  const router = Router();
  router.post('/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const deny = () => { res.status(401).json({ error: 'Unauthorized' }); };
    try {
      if (!UUID.test(id)) { deny(); return; }
      const ip = String(req.ip || '');
      if (throttled('bad:' + id + ':' + ip, 30)) { res.status(429).json({ error: 'Too many requests' }); return; }
      await ensureTables(pool);
      const ep = await pool.query(`SELECT id, tenant_id, secret_hash, is_active FROM webhook_endpoints WHERE id = $1`, [id]);
      const auth = String(req.headers.authorization || '');
      const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-webhook-secret'] || '').trim();
      let ok = false;
      if (ep.rows.length && ep.rows[0].is_active && given) {
        const a = Buffer.from(sha256(given), 'hex'), b = Buffer.from(ep.rows[0].secret_hash, 'hex');
        ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      }
      if (!ok) { deny(); return; }
      if (throttled('ok:' + id, 600)) { res.status(429).json({ error: 'Rate limit exceeded: 600 requests per minute' }); return; }
      const tenant: string = ep.rows[0].tenant_id;
      const body = req.body || {};
      const events: any[] = Array.isArray(body.events) ? body.events : [body];
      if (events.length === 0 || events.length > 100) { res.status(400).json({ error: 'Send between 1 and 100 events' }); return; }
      const results: any[] = [];
      let okN = 0, failN = 0, lastErr: string | null = null;
      for (const ev of events) {
        const eventId = str(ev?.event_id, 120) || null;
        const entity = str(ev?.entity, 30).toLowerCase() || null;
        try {
          if (eventId) {
            const dup = await pool.query(`SELECT 1 FROM webhook_events WHERE endpoint_id = $1 AND event_id = $2 AND status = 'ok'`, [id, eventId]);
            if (dup.rows.length) { results.push({ event_id: eventId, status: 'duplicate' }); continue; }
          }
          const msg = await handleEvent(pool, tenant, ev);
          await pool.query(`INSERT INTO webhook_events (tenant_id, endpoint_id, event_id, entity, status, detail) VALUES ($1,$2,$3,$4,'ok',$5) ON CONFLICT DO NOTHING`, [tenant, id, eventId, entity, msg]);
          okN++; results.push({ event_id: eventId, status: 'ok', detail: msg });
        } catch (e: any) {
          const msg = e instanceof Bad ? e.message : 'Could not process this event';
          if (!(e instanceof Bad)) console.error('[webhook-in] event failed:', e);
          failN++; lastErr = msg;
          await pool.query(`INSERT INTO webhook_events (tenant_id, endpoint_id, event_id, entity, status, detail) VALUES ($1,$2,$3,$4,'failed',$5)`, [tenant, id, eventId, entity, msg]).catch(() => {});
          results.push({ event_id: eventId, status: 'failed', error: msg });
        }
      }
      await pool.query(`UPDATE webhook_endpoints SET last_received_at = NOW(), events_ok = events_ok + $1, events_failed = events_failed + $2, last_error = CASE WHEN $2 > 0 THEN $3 ELSE last_error END WHERE id = $4`, [okN, failN, lastErr, id]);
      res.status(failN && !okN ? 422 : 200).json({ received: events.length, ok: okN, failed: failN, results });
    } catch (err) { console.error('[webhook-in]', err); res.status(500).json({ error: 'Server error' }); }
  });
  return router;
}

// ── admin (login) ────────────────────────────────────────────
export function createWebhookAdminRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;
  const fail = (res: Response, err: any) => { console.error('[webhooks]', err); res.status(500).json({ error: 'Server error' }); };

  router.get('/endpoints', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensureTables(pool);
      const r = await pool.query(`SELECT id, name, source, secret_hint, is_active, last_received_at, events_ok, events_failed, last_error, created_at FROM webhook_endpoints WHERE tenant_id = $1 ORDER BY created_at DESC`, [tid(req)]);
      res.json({ endpoints: r.rows });
    } catch (e) { fail(res, e); }
  });

  router.post('/endpoints', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensureTables(pool);
      const name = str(req.body?.name, 80);
      if (!name) { res.status(400).json({ error: 'Give the endpoint a name' }); return; }
      const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM webhook_endpoints WHERE tenant_id = $1`, [tid(req)]);
      if (cnt.rows[0].n >= 20) { res.status(400).json({ error: 'You can have up to 20 endpoints' }); return; }
      const secret = newSecret();
      const r = await pool.query(`INSERT INTO webhook_endpoints (tenant_id, name, source, secret_hash, secret_hint) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, source, is_active, created_at`,
        [tid(req), name, str(req.body?.source, 60) || null, sha256(secret), secret.slice(0, 10) + '…' + secret.slice(-4)]);
      res.json({ endpoint: r.rows[0], secret, note: 'Copy the secret now. It is shown only once.' });
    } catch (e) { fail(res, e); }
  });

  router.post('/endpoints/:id/rotate', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensureTables(pool);
      if (!UUID.test(String(req.params.id))) { res.status(404).json({ error: 'Not found' }); return; }
      const secret = newSecret();
      const r = await pool.query(`UPDATE webhook_endpoints SET secret_hash = $1, secret_hint = $2 WHERE id = $3 AND tenant_id = $4 RETURNING id`, [sha256(secret), secret.slice(0, 10) + '…' + secret.slice(-4), req.params.id, tid(req)]);
      if (!r.rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      res.json({ id: r.rows[0].id, secret, note: 'The old secret no longer works. Copy the new one now.' });
    } catch (e) { fail(res, e); }
  });

  router.patch('/endpoints/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensureTables(pool);
      if (!UUID.test(String(req.params.id))) { res.status(404).json({ error: 'Not found' }); return; }
      const r = await pool.query(`UPDATE webhook_endpoints SET is_active = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id, is_active`, [!!req.body?.is_active, req.params.id, tid(req)]);
      if (!r.rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      res.json({ endpoint: r.rows[0] });
    } catch (e) { fail(res, e); }
  });

  router.delete('/endpoints/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensureTables(pool);
      if (!UUID.test(String(req.params.id))) { res.status(404).json({ error: 'Not found' }); return; }
      const r = await pool.query(`DELETE FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2`, [req.params.id, tid(req)]);
      res.json({ deleted: r.rowCount });
    } catch (e) { fail(res, e); }
  });

  router.get('/events', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensureTables(pool);
      const r = await pool.query(
        `SELECT e.id, e.event_id, e.entity, e.status, e.detail, e.created_at, p.name AS endpoint_name
         FROM webhook_events e LEFT JOIN webhook_endpoints p ON p.id = e.endpoint_id
         WHERE e.tenant_id = $1 ORDER BY e.created_at DESC LIMIT 50`, [tid(req)]);
      res.json({ events: r.rows });
    } catch (e) { fail(res, e); }
  });

  // Freshness of every data source for this company
  router.get('/health', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensureTables(pool);
      const t = tid(req);
      const now = Date.now();
      const sources: any[] = [];
      const safe = async (sql: string, params: any[]) => { try { return (await pool.query(sql, params)).rows; } catch { return []; } };
      const age = (v: any) => v ? now - new Date(v).getTime() : null;

      for (const w of await safe(`SELECT name, source, is_active, last_received_at, events_ok, events_failed, last_error FROM webhook_endpoints WHERE tenant_id = $1`, [t])) {
        let status = 'ok';
        if (!w.is_active) status = 'paused'; else if (!w.last_received_at) status = 'waiting'; else if (w.last_error && Number(w.events_failed) > 0 && Number(w.events_failed) >= Number(w.events_ok)) status = 'error';
        sources.push({ kind: 'Webhook', name: w.name, detail: w.source, status, last_at: w.last_received_at, records: Number(w.events_ok), failed: Number(w.events_failed), error: w.last_error });
      }
      for (const p of await safe(`SELECT name, source_type, is_active, poll_interval_seconds, last_polled_at, last_status, last_error, records_synced FROM poller_connections WHERE tenant_id = $1`, [t])) {
        let status = 'ok';
        const a = age(p.last_polled_at);
        if (!p.is_active) status = 'paused'; else if (a === null) status = 'waiting';
        else if (String(p.last_status).toLowerCase().includes('fail') || String(p.last_status).toLowerCase() === 'error') status = 'error';
        else if (a > 3 * 1000 * (p.poll_interval_seconds || 300)) status = 'stale';
        sources.push({ kind: 'Connector', name: p.name, detail: p.source_type + ', every ' + Math.round((p.poll_interval_seconds || 300) / 60) + ' min', status, last_at: p.last_polled_at, records: Number(p.records_synced || 0), error: p.last_error });
      }
      for (const n of await safe(`SELECT account_id, is_active, last_sync_at, sync_status, records_synced, last_error FROM netsuite_connections WHERE tenant_id = $1`, [t])) {
        let status = 'ok';
        const a = age(n.last_sync_at);
        if (!n.is_active) status = 'paused'; else if (a === null) status = 'waiting';
        else if (String(n.sync_status).toLowerCase().includes('fail') || String(n.sync_status).toLowerCase() === 'error') status = 'error';
        else if (a > 24 * 3600 * 1000) status = 'stale';
        sources.push({ kind: 'NetSuite', name: 'Oracle NetSuite ' + n.account_id, detail: null, status, last_at: n.last_sync_at, records: Number(n.records_synced || 0), error: n.last_error });
      }
      const books = await safe(`SELECT GREATEST((SELECT MAX(updated_at) FROM ar_invoices WHERE tenant_id = $1), (SELECT MAX(updated_at) FROM ap_invoices WHERE tenant_id = $1)) AS last_change,
                                       (SELECT COUNT(*)::int FROM ar_invoices WHERE tenant_id = $1) AS ar, (SELECT COUNT(*)::int FROM ap_invoices WHERE tenant_id = $1) AS ap`, [t]);
      const bad = sources.filter(s => s.status === 'error' || s.status === 'stale').length;
      res.json({ now: new Date().toISOString(), books: books[0] || {}, sources, summary: { total: sources.length, healthy: sources.filter(s => s.status === 'ok').length, attention: bad } });
    } catch (e) { fail(res, e); }
  });

  return router;
}
