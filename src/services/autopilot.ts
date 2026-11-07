// ============================================================
// Level 5 (Autonomous, within limits): Autopilot for overdue-invoice reminders.
// Off by default. When on, it emails customers about overdue invoices inside limits the owner sets:
//   daily cap, minimum days overdue, and how often the same invoice may be chased.
// Every action, including skipped and failed ones, is recorded in autopilot_actions. No money is ever moved.
// ============================================================
import { Pool } from 'pg';

export interface AutopilotSettings { reminders_enabled: boolean; daily_cap: number; min_days_overdue: number; repeat_every_days: number; }
export const DEFAULTS: AutopilotSettings = { reminders_enabled: false, daily_cap: 10, min_days_overdue: 3, repeat_every_days: 7 };

export async function ensureAutopilotTables(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS autopilot_settings (
    tenant_id UUID PRIMARY KEY, reminders_enabled BOOLEAN NOT NULL DEFAULT false, daily_cap INT NOT NULL DEFAULT 10,
    min_days_overdue INT NOT NULL DEFAULT 3, repeat_every_days INT NOT NULL DEFAULT 7, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS autopilot_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, action_type TEXT NOT NULL, invoice_id TEXT,
    invoice_number TEXT, party TEXT, amount NUMERIC, status TEXT NOT NULL, detail TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_autopilot_actions_tenant ON autopilot_actions (tenant_id, created_at DESC)`);
}

export async function getSettings(pool: Pool, tenantId: string): Promise<AutopilotSettings> {
  await ensureAutopilotTables(pool);
  const r = await pool.query('SELECT reminders_enabled, daily_cap, min_days_overdue, repeat_every_days FROM autopilot_settings WHERE tenant_id=$1', [tenantId]);
  return r.rows[0] ? { ...DEFAULTS, ...r.rows[0] } : { ...DEFAULTS };
}

export interface Candidate { id: string; invoice_number: string; party: string; email: string | null; balance: number; due: string; days_overdue: number; }

// Overdue, unpaid invoices that the limits allow us to chase now, biggest first. Pure read; used by both the preview and the run.
export async function eligibleReminders(pool: Pool, tenantId: string, s: AutopilotSettings): Promise<{ list: Candidate[]; sent_today: number; room: number }> {
  await ensureAutopilotTables(pool);
  const sentToday = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM autopilot_actions WHERE tenant_id=$1 AND action_type='reminder' AND status='sent' AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`, [tenantId])).rows[0].n;
  const room = Math.max(0, s.daily_cap - sentToday);
  const r = await pool.query(
    `SELECT a.id::text AS id, a.invoice_number, c.name AS party, c.email, a.balance_due::float8 AS balance, a.due_date::text AS due,
            (CURRENT_DATE - a.due_date)::int AS days_overdue
       FROM ar_invoices a LEFT JOIN customers c ON c.id = a.customer_id
      WHERE a.tenant_id=$1 AND a.status IN ('sent','partially_paid','overdue') AND a.balance_due > 0
        AND (CURRENT_DATE - a.due_date) >= $2
        AND NOT EXISTS (SELECT 1 FROM autopilot_actions x WHERE x.tenant_id=a.tenant_id AND x.invoice_id=a.id::text AND x.action_type='reminder'
              AND ((x.status='sent' AND x.created_at > NOW() - make_interval(days => $3)) OR (x.status IN ('failed','skipped') AND x.created_at > NOW() - INTERVAL '1 day')))
      ORDER BY a.balance_due DESC`, [tenantId, s.min_days_overdue, s.repeat_every_days]);
  return { list: r.rows, sent_today: sentToday, room };
}

const esc = (t: any) => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
const rs = (n: number) => 'Rs ' + Math.round(n).toLocaleString('en-IN');

export async function runAutopilotReminders(pool: Pool, tenantId: string, deps: { sendEmail: (to: any, subject: string, html: string) => Promise<boolean>; getAdminEmail: (pool: any, tenantId: string) => Promise<any> }) {
  const s = await getSettings(pool, tenantId);
  if (!s.reminders_enabled) return { ran: false, reason: 'autopilot_off' };
  if (!process.env.RESEND_API_KEY) return { ran: false, reason: 'email_not_configured' };
  const { list, room } = await eligibleReminders(pool, tenantId, s);
  const log = (type: string, c: Candidate, status: string, detail: string) =>
    pool.query(`INSERT INTO autopilot_actions (tenant_id, action_type, invoice_id, invoice_number, party, amount, status, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, type, c.id, c.invoice_number, c.party, c.balance, status, detail]);
  let sent = 0;
  for (const c of list) {
    if (sent >= room) break;
    if (!c.email) { await log('reminder', c, 'skipped', 'Customer has no email address'); continue; }
    const ok = await deps.sendEmail(c.email, 'Payment reminder: invoice ' + c.invoice_number,
      '<div style="font-family:Arial;padding:20px"><p>Dear ' + esc(c.party || 'Customer') + ',</p>' +
      '<p>Invoice <strong>' + esc(c.invoice_number) + '</strong> had a payment of <strong>' + rs(c.balance) + '</strong> due on ' + esc(new Date(c.due + 'T00:00:00').toLocaleDateString('en-IN')) +
      ' (' + c.days_overdue + ' days ago) and is still outstanding. Please arrange payment at your earliest convenience. If you have already paid, please ignore this message.</p>' +
      '<p style="color:#64748B;font-size:12px">Sent automatically by Deemona Finance OS.</p></div>');
    await log('reminder', c, ok ? 'sent' : 'failed', ok ? 'Reminder emailed to ' + c.email : 'Email provider did not accept the message');
    if (ok) sent++;
  }
  // Internal heads-up for very late invoices (90+ days), once per reminder window; does not count toward the customer cap.
  const late = list.filter(c => c.days_overdue >= 90);
  if (late.length) {
    const admin = await deps.getAdminEmail(pool, tenantId);
    if (admin && (Array.isArray(admin) ? admin.length : true)) {
      await deps.sendEmail(admin, 'Autopilot: ' + late.length + ' invoice(s) overdue 90+ days',
        '<div style="font-family:Arial;padding:20px"><p>These invoices need a personal follow-up:</p><ul>' +
        late.map(c => '<li>' + esc(c.invoice_number) + ' - ' + esc(c.party) + ' - ' + rs(c.balance) + ' - ' + c.days_overdue + ' days overdue</li>').join('') + '</ul></div>').catch(() => false);
    }
  }
  return { ran: true, sent, eligible: list.length, room };
}
