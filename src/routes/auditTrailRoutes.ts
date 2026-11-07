// ============================================================
// Audit trail: a record of every change request made through the API.
// Who (user, role, company), what (method + route, record id), when, from where (IP), and the outcome (status code).
// Request bodies are NEVER stored, so passwords, tokens and bank details cannot leak into the log.
// Viewing is limited to admins: GET /api/audit-trail
// ============================================================
import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

let ready: Promise<void> | null = null;
export function ensureAuditTrail(pool: Pool): Promise<void> {
  if (!ready) ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS audit_trail (
      id BIGSERIAL PRIMARY KEY, tenant_id UUID, user_id TEXT, user_email TEXT, user_role TEXT,
      method TEXT NOT NULL, route TEXT NOT NULL, module TEXT, record_id TEXT, status INT, ip TEXT, user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_trail_tenant_time ON audit_trail (tenant_id, created_at DESC)`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
// Requests that change nothing or are machine traffic: not worth a row each.
const SKIP = /(\/ask|\/commentary|\/webhook|\/health|\/refresh|\/heartbeat|\/ping)(\/|$)/i;

export function auditTrailMiddleware(pool: Pool) {
  return (req: Request, res: Response, next: NextFunction) => {
    const m = req.method;
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') { next(); return; }
    const url = (req.originalUrl || req.url || '').split('?')[0];
    if (!url.startsWith('/api/') || SKIP.test(url)) { next(); return; }
    res.on('finish', () => {
      try {
        const u: any = (req as any).user;
        const isLogin = /^\/api\/auth\/login\/?$/i.test(url);
        if (!u && !isLogin) return; // unauthenticated noise is not an audit event
        const ids = url.match(UUID);
        const route = url.replace(UUID, ':id').slice(0, 200);
        const module = url.split('/')[2] || null;
        const email = u ? (u.email || null) : String((req.body && req.body.email) || '').slice(0, 120) || null;
        const ip = String(req.ip || '').slice(0, 64), ua = String(req.headers['user-agent'] || '').slice(0, 160), status = res.statusCode;
        ensureAuditTrail(pool).then(async () => {
          let tenant: any = u && /^[0-9a-f-]{36}$/i.test(String(u.tenantId)) ? u.tenantId : null;
          // A login attempt has no session yet: file it under the company that owns the email address, so its admins can see failed logins.
          if (!tenant && isLogin && email) { const r = await pool.query('SELECT tenant_id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1', [email]).catch(() => ({ rows: [] as any[] })); tenant = r.rows[0] ? r.rows[0].tenant_id : null; }
          await pool.query(
            `INSERT INTO audit_trail (tenant_id, user_id, user_email, user_role, method, route, module, record_id, status, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [tenant, u ? String(u.id || '') : null, email, u ? (u.role || null) : null, m, route, module, ids ? ids[0] : null, status, ip, ua]);
        }).catch(() => {});
      } catch { /* never affect the request */ }
    });
    next();
  };
}

const isAdmin = (role: any) => /admin|owner|cfo/i.test(String(role || ''));

export function createAuditTrailRouter(pool: Pool): Router {
  const router = Router();
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const u: any = (req as any).user;
      if (!isAdmin(u.role)) { res.status(403).json({ error: 'Only an admin can view the audit trail.' }); return; }
      await ensureAuditTrail(pool);
      const q = req.query;
      const where: string[] = ['tenant_id = $1']; const p: any[] = [u.tenantId];
      if (q.module) { p.push(String(q.module)); where.push('module = $' + p.length); }
      if (q.user) { p.push('%' + String(q.user).toLowerCase() + '%'); where.push('LOWER(user_email) LIKE $' + p.length); }
      if (q.method) { p.push(String(q.method).toUpperCase()); where.push('method = $' + p.length); }
      if (q.failed === '1') where.push('status >= 400');
      if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(String(q.from))) { p.push(String(q.from)); where.push('created_at >= $' + p.length + '::date'); }
      if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(String(q.to))) { p.push(String(q.to)); where.push("created_at < ($" + p.length + "::date + 1)"); }
      const limit = Math.max(1, Math.min(200, parseInt(String(q.limit || '100'), 10) || 100));
      const offset = Math.max(0, parseInt(String(q.offset || '0'), 10) || 0);
      const rows = await pool.query(
        `SELECT id::text, created_at, user_email, user_role, method, route, module, record_id, status, ip FROM audit_trail WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, p);
      const mods = await pool.query(`SELECT module, COUNT(*)::int AS n FROM audit_trail WHERE tenant_id=$1 AND module IS NOT NULL GROUP BY module ORDER BY n DESC LIMIT 40`, [u.tenantId]);
      const day = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status >= 400)::int AS failed, COUNT(DISTINCT user_email)::int AS users FROM audit_trail WHERE tenant_id=$1 AND created_at > NOW() - INTERVAL '24 hours'`, [u.tenantId]);
      res.json({ rows: rows.rows, modules: mods.rows, last_24h: day.rows[0], has_more: rows.rows.length === limit,
        note: 'Records every change request (create, update, delete, approve). Request contents are not stored.' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  return router;
}
