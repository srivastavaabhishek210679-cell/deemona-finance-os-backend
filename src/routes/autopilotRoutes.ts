// /api/autopilot: settings, preview of what would be sent now, and the action log.
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { getSettings, ensureAutopilotTables, eligibleReminders, DEFAULTS } from '../services/autopilot';

const inrText = (n: number): string => {
  const a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e7) return sign + '₹' + (a / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return sign + '₹' + (a / 1e5).toFixed(2) + ' lakh';
  return sign + '₹' + Math.round(a).toLocaleString('en-IN');
};
const clampInt = (v: any, lo: number, hi: number, d: number) => { const n = parseInt(String(v), 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

export function createAutopilotRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = tid(req);
      const s = await getSettings(pool, t);
      const { list, sent_today, room } = await eligibleReminders(pool, t, s);
      const actions = await pool.query(
        `SELECT id, action_type, invoice_number, party, amount::float8 AS amount, status, detail, created_at FROM autopilot_actions WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50`, [t]);
      res.json({
        settings: s, defaults: DEFAULTS, email_configured: !!process.env.RESEND_API_KEY, sent_today, room_today: room,
        would_send: list.slice(0, room).map(c => ({ invoice_number: c.invoice_number, party: c.party, email: c.email, amount_inr: inrText(c.balance), days_overdue: c.days_overdue, has_email: !!c.email })),
        actions: actions.rows.map((a: any) => ({ ...a, amount_inr: inrText(a.amount || 0) })),
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.put('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const u = (req as any).user;
      if (u.role && !/admin|owner|cfo/i.test(String(u.role))) { res.status(403).json({ error: 'Only an admin can change Autopilot settings.' }); return; }
      await ensureAutopilotTables(pool);
      const b = req.body || {};
      const cur = await getSettings(pool, tid(req));
      const next = {
        reminders_enabled: typeof b.reminders_enabled === 'boolean' ? b.reminders_enabled : cur.reminders_enabled,
        daily_cap: clampInt(b.daily_cap, 1, 50, cur.daily_cap),
        min_days_overdue: clampInt(b.min_days_overdue, 1, 90, cur.min_days_overdue),
        repeat_every_days: clampInt(b.repeat_every_days, 3, 30, cur.repeat_every_days),
      };
      await pool.query(
        `INSERT INTO autopilot_settings (tenant_id, reminders_enabled, daily_cap, min_days_overdue, repeat_every_days, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET reminders_enabled=$2, daily_cap=$3, min_days_overdue=$4, repeat_every_days=$5, updated_by=$6, updated_at=NOW()`,
        [tid(req), next.reminders_enabled, next.daily_cap, next.min_days_overdue, next.repeat_every_days, u.email || u.id || null]);
      console.log('[autopilot] settings changed by ' + (u.email || u.id) + ': ' + JSON.stringify(next));
      res.json({ settings: next });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  return router;
}
