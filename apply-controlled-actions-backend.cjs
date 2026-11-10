// Controlled autonomy (backend): the system PROPOSES actions, an admin APPROVES (app or WhatsApp), the action runs, an audit entry is written.
// Actions: customer payment reminders (email / WhatsApp), board report, compliance task. Idempotent. Run from the backend folder.
// Needs: apply-smtp-backend, apply-decision-tools-backend and apply-collection-risk-backend applied first.
const fs = require('fs');

const SVC = String.raw`// Controlled autonomy: propose -> admin approves -> execute -> audit. Nothing runs without an approval.
import { Pool } from 'pg';
import cron from 'node-cron';
import { Resend } from './mailer';
import { loadRiskInputs } from './collectionRiskData';
import { scoreCollectionRisk, inrRisk } from './collectionRisk';

export type ActionType = 'payment_reminder_email' | 'payment_reminder_whatsapp' | 'board_report' | 'compliance_task';
export interface Actor { id: string; email: string; name?: string; role: string; }
export interface Deps { runMetric: (pool: Pool, tenantId: string, name: string, input: any) => Promise<any>; }

const clamp = (v: any, d: number, lo: number, hi: number): number => { const n = parseInt(String(v), 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const esc = (s: any): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const todayIST = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const dayNum = (s: string): number => Math.floor(new Date(String(s).slice(0, 10) + 'T00:00:00Z').getTime() / 86400000);
export const actionCode = (id: string): string => String(id).replace(/-/g, '').slice(0, 6).toUpperCase();
const dailyCap = (): number => clamp(process.env.ACTIONS_DAILY_CAP, 25, 1, 500);

let ready = false;
export async function ensureActionTables(pool: Pool): Promise<void> {
  if (ready) return;
  await pool.query('CREATE TABLE IF NOT EXISTS cfo_action_queue (' +
    'id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'proposed\', ' +
    'title TEXT NOT NULL, summary TEXT, priority INT DEFAULT 5, payload JSONB NOT NULL DEFAULT \'{}\', dedupe_key TEXT, proposed_by TEXT, ' +
    'proposed_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ, decided_by TEXT, decided_by_email TEXT, decided_at TIMESTAMPTZ, ' +
    'executed_at TIMESTAMPTZ, result JSONB, error TEXT)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_caq_tenant_status ON cfo_action_queue (tenant_id, status, proposed_at DESC)');
  await pool.query('CREATE TABLE IF NOT EXISTS cfo_action_audit (' +
    'id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, action_id UUID, event TEXT NOT NULL, actor TEXT, detail JSONB, at TIMESTAMPTZ DEFAULT NOW())');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_caa_tenant_at ON cfo_action_audit (tenant_id, at DESC)');
  ready = true;
}

async function audit(pool: Pool, tenantId: string, actionId: string | null, event: string, actor: string, detail: any): Promise<void> {
  await pool.query('INSERT INTO cfo_action_audit (tenant_id, action_id, event, actor, detail) VALUES ($1,$2,$3,$4,$5)', [tenantId, actionId, event, actor, JSON.stringify(detail || {})]).catch(() => {});
}
async function tenantName(pool: Pool, tenantId: string): Promise<string> {
  const r = await pool.query('SELECT name FROM tenants WHERE id=$1', [tenantId]).catch(() => ({ rows: [] as any[] }));
  return (r.rows[0] && r.rows[0].name) || 'Our company';
}
async function adminEmail(pool: Pool, tenantId: string): Promise<string | null> {
  const r = await pool.query("SELECT email FROM users WHERE tenant_id=$1 AND role IN ('owner','admin') AND email IS NOT NULL ORDER BY (role='owner') DESC LIMIT 1", [tenantId]).catch(() => ({ rows: [] as any[] }));
  return r.rows[0] ? r.rows[0].email : null;
}
async function insertAction(pool: Pool, tenantId: string, a: { type: ActionType; title: string; summary: string; priority: number; payload: any; dedupe: string; by: string }): Promise<string | null> {
  const open = await pool.query("SELECT 1 FROM cfo_action_queue WHERE tenant_id=$1 AND dedupe_key=$2 AND status='proposed' LIMIT 1", [tenantId, a.dedupe]);
  if (open.rows.length) return null;
  const recent = await pool.query("SELECT 1 FROM cfo_action_queue WHERE tenant_id=$1 AND dedupe_key=$2 AND status='executed' AND executed_at > NOW() - INTERVAL '7 days' LIMIT 1", [tenantId, a.dedupe]);
  if (recent.rows.length) return null;
  const r = await pool.query('INSERT INTO cfo_action_queue (tenant_id, type, title, summary, priority, payload, dedupe_key, proposed_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + INTERVAL \'7 days\') RETURNING id',
    [tenantId, a.type, a.title, a.summary, a.priority, JSON.stringify(a.payload), a.dedupe, a.by]);
  await audit(pool, tenantId, r.rows[0].id, 'proposed', a.by, { type: a.type, title: a.title });
  return r.rows[0].id;
}

// ── Proposals ──────────────────────────────────────────────────
function reminderText(company: string, customer: string, invs: any[], total: number, maxDays: number): string {
  const lines = invs.slice(0, 10).map(i => '- Invoice ' + i.number + ': ' + inrRisk(i.balance) + ', due ' + i.due_date + ' (' + i.days_overdue + ' days overdue)');
  const more = invs.length > 10 ? '\n...and ' + (invs.length - 10) + ' more' : '';
  return 'Dear ' + customer + ',\n\nThis is a reminder from ' + company + '. Our records show the following ' + (invs.length === 1 ? 'invoice is' : 'invoices are') + ' overdue:\n\n' + lines.join('\n') + more +
    '\n\nTotal overdue: ' + inrRisk(total) + '.\n\n' +
    (maxDays > 60 ? 'Please arrange payment at the earliest, or let us know the date by which we can expect it, so that we can avoid further follow-up.' : 'Please arrange payment, or let us know when we can expect it.') +
    '\n\nIf you have already paid, please ignore this message and share the payment details so that we can match it.\n\nRegards,\n' + company;
}

export async function proposeCollectionActions(pool: Pool, tenantId: string, opts: { channels?: string[]; min_days_overdue?: number; limit?: number }, by: string) {
  await ensureActionTables(pool);
  const channels = (opts.channels && opts.channels.length ? opts.channels : ['email']).filter(c => c === 'email' || c === 'whatsapp');
  const minDays = clamp(opts.min_days_overdue, 7, 1, 365), limit = clamp(opts.limit, 10, 1, 50);
  const { events, open, today } = await loadRiskInputs(pool, tenantId);
  const risk: any = scoreCollectionRisk(events, open, today, 1000);
  const company = await tenantName(pool, tenantId);
  const t0 = dayNum(today);
  const overdueBy = new Map<string, any[]>();
  for (const o of open) {
    const d = t0 - dayNum(o.due_date);
    if (d < 1) continue;
    if (!overdueBy.has(o.customer_id)) overdueBy.set(o.customer_id, []);
    overdueBy.get(o.customer_id)!.push({ number: o.invoice_number, balance: o.balance, due_date: String(o.due_date).slice(0, 10), days_overdue: d });
  }
  const ids = Array.from(overdueBy.keys());
  const contacts = ids.length ? (await pool.query('SELECT id::text AS id, name, email, phone FROM customers WHERE tenant_id=$1 AND id = ANY($2::uuid[])', [tenantId, ids])).rows : [];
  const cmap = new Map<string, any>(contacts.map((c: any) => [c.id, c]));
  const proposed: any[] = [], skipped: any[] = [];
  const candidates = (risk.customers as any[]).filter(c => overdueBy.has(c.customer_id) && Math.max(...overdueBy.get(c.customer_id)!.map(i => i.days_overdue)) >= minDays).slice(0, limit);
  for (const c of candidates) {
    const invs = overdueBy.get(c.customer_id)!.sort((a, b) => b.days_overdue - a.days_overdue);
    const total = invs.reduce((s, i) => s + i.balance, 0), maxDays = invs[0].days_overdue;
    const contact = cmap.get(c.customer_id) || {};
    const text = reminderText(company, c.customer, invs, total, maxDays);
    for (const ch of channels) {
      const to = ch === 'email' ? contact.email : contact.phone;
      if (!to) { skipped.push({ customer: c.customer, channel: ch, reason: 'no ' + (ch === 'email' ? 'email address' : 'phone number') + ' saved for this customer' }); continue; }
      const id = await insertAction(pool, tenantId, {
        type: ch === 'email' ? 'payment_reminder_email' : 'payment_reminder_whatsapp',
        title: 'Send payment reminder to ' + c.customer + ' (' + ch + ')',
        summary: inrRisk(total) + ' overdue across ' + invs.length + (invs.length === 1 ? ' invoice' : ' invoices') + ', oldest ' + maxDays + ' days. Risk: ' + c.risk_band + ' (' + c.risk_score + '/100).',
        priority: c.risk_band === 'High' ? 1 : c.risk_band === 'Medium' ? 2 : 3,
        payload: { customer_id: c.customer_id, customer: c.customer, channel: ch, to, subject: 'Payment reminder from ' + company + ' - ' + inrRisk(total) + ' overdue', message: text, invoices: invs, total_overdue: Math.round(total), max_days_overdue: maxDays, risk_score: c.risk_score, risk_band: c.risk_band },
        dedupe: 'reminder:' + ch + ':' + c.customer_id, by,
      });
      if (id) proposed.push({ id, code: actionCode(id), customer: c.customer, channel: ch, total_overdue: Math.round(total) });
      else skipped.push({ customer: c.customer, channel: ch, reason: 'already proposed, or a reminder was sent in the last 7 days' });
    }
  }
  return { proposed, skipped, customers_considered: candidates.length };
}

export async function proposeBoardReport(pool: Pool, tenantId: string, toEmail: string | null, by: string) {
  await ensureActionTables(pool);
  const to = toEmail || await adminEmail(pool, tenantId);
  if (!to) return { proposed: [], skipped: [{ reason: 'no admin email found to send the board report to' }] };
  const ym = todayIST().slice(0, 7);
  const id = await insertAction(pool, tenantId, { type: 'board_report', title: 'Generate and email the board summary for ' + ym, summary: 'One-page summary of cash, receivables, collection risk and compliance, emailed to ' + to + '.',
    priority: 4, payload: { to, month: ym }, dedupe: 'board:' + ym, by });
  return id ? { proposed: [{ id, code: actionCode(id), title: 'Board summary ' + ym }], skipped: [] } : { proposed: [], skipped: [{ reason: 'a board summary for ' + ym + ' is already proposed or was created in the last 7 days' }] };
}

const STATUTORY: { key: string; title: string; day?: number; month?: number; category: string; note: string }[] = [
  { key: 'gstr1', title: 'GSTR-1 filing', day: 11, category: 'tax', note: 'Monthly filers; quarterly (QRMP) filers file by the 13th after the quarter.' },
  { key: 'gstr3b', title: 'GSTR-3B filing and GST payment', day: 20, category: 'tax', note: 'Due date can differ by turnover and state; confirm for your registration.' },
  { key: 'tds', title: 'TDS / TCS deposit', day: 7, category: 'tax', note: 'Deposit of tax deducted in the previous month.' },
  { key: 'pfesi', title: 'PF and ESI contribution', day: 15, category: 'statutory', note: 'Employer and employee contribution for the previous month.' },
  { key: 'advtax-jun', title: 'Advance tax instalment', day: 15, month: 6, category: 'tax', note: 'Quarterly advance tax; confirm the percentage due with your CA.' },
  { key: 'advtax-sep', title: 'Advance tax instalment', day: 15, month: 9, category: 'tax', note: 'Quarterly advance tax; confirm the percentage due with your CA.' },
  { key: 'advtax-dec', title: 'Advance tax instalment', day: 15, month: 12, category: 'tax', note: 'Quarterly advance tax; confirm the percentage due with your CA.' },
  { key: 'advtax-mar', title: 'Advance tax instalment', day: 15, month: 3, category: 'tax', note: 'Quarterly advance tax; confirm the percentage due with your CA.' },
];
export async function proposeComplianceTasks(pool: Pool, tenantId: string, by: string) {
  await ensureActionTables(pool);
  const today = todayIST(); const t0 = dayNum(today);
  const [y, m, d] = today.split('-').map(Number);
  const proposed: any[] = [], skipped: any[] = [];
  for (const s of STATUTORY) {
    let due: string;
    if (s.month) { let yy = y; if (m > s.month || (m === s.month && d > (s.day as number))) yy = y + 1; due = yy + '-' + String(s.month).padStart(2, '0') + '-' + String(s.day).padStart(2, '0'); }
    else { let yy = y, mm = m; if (d > (s.day as number)) { mm = m + 1; if (mm > 12) { mm = 1; yy = y + 1; } } due = yy + '-' + String(mm).padStart(2, '0') + '-' + String(s.day).padStart(2, '0'); }
    if (dayNum(due) - t0 > 35) continue;
    const exists = await pool.query("SELECT 1 FROM compliance_items WHERE tenant_id=$1 AND title ILIKE $2 AND due_date::date = $3::date LIMIT 1", [tenantId, s.title, due]).catch(() => ({ rows: [] as any[] }));
    if (exists.rows.length) { skipped.push({ title: s.title, due_date: due, reason: 'already in your compliance list' }); continue; }
    const id = await insertAction(pool, tenantId, { type: 'compliance_task', title: 'Add compliance task: ' + s.title + ' (due ' + due + ')', summary: 'Creates a compliance item due ' + due + '. Standard statutory date; confirm it for your registration.',
      priority: 3, payload: { category: s.category, title: s.title, description: s.note, frequency: s.month ? 'quarterly' : 'monthly', due_date: due, notes: 'Added from an approved proposal. Standard due date; late fee and interest may apply if missed. Confirm for your registration.' },
      dedupe: 'compliance:' + s.key + ':' + due, by });
    if (id) proposed.push({ id, code: actionCode(id), title: s.title, due_date: due }); else skipped.push({ title: s.title, due_date: due, reason: 'already proposed' });
  }
  return { proposed, skipped };
}

// ── Queue ──────────────────────────────────────────────────────
async function expireOld(pool: Pool, tenantId: string): Promise<void> {
  const r = await pool.query("UPDATE cfo_action_queue SET status='expired' WHERE tenant_id=$1 AND status='proposed' AND expires_at < NOW() RETURNING id", [tenantId]);
  for (const x of r.rows) await audit(pool, tenantId, x.id, 'expired', 'system', {});
}
export async function listActions(pool: Pool, tenantId: string, scope: string, limit = 50) {
  await ensureActionTables(pool); await expireOld(pool, tenantId);
  const where = scope === 'open' ? "status='proposed'" : scope === 'history' ? "status <> 'proposed'" : 'TRUE';
  const r = await pool.query('SELECT id, type, status, title, summary, priority, payload, proposed_by, proposed_at, expires_at, decided_by_email, decided_at, executed_at, result, error FROM cfo_action_queue WHERE tenant_id=$1 AND ' + where +
    ' ORDER BY (status=\'proposed\') DESC, priority ASC, proposed_at DESC LIMIT $2', [tenantId, clamp(limit, 50, 1, 200)]);
  return r.rows.map((x: any) => ({ ...x, code: actionCode(x.id) }));
}
export async function listAudit(pool: Pool, tenantId: string, limit = 100) {
  await ensureActionTables(pool);
  const r = await pool.query('SELECT a.id, a.action_id, a.event, a.actor, a.detail, a.at, q.title FROM cfo_action_audit a LEFT JOIN cfo_action_queue q ON q.id = a.action_id WHERE a.tenant_id=$1 ORDER BY a.at DESC LIMIT $2', [tenantId, clamp(limit, 100, 1, 500)]);
  return r.rows;
}
export async function findByCode(pool: Pool, tenantId: string, code: string): Promise<{ id?: string; error?: string }> {
  await ensureActionTables(pool);
  const r = await pool.query("SELECT id FROM cfo_action_queue WHERE tenant_id=$1 AND status='proposed' AND UPPER(SUBSTR(REPLACE(id::text,'-',''),1,6))=$2", [tenantId, String(code).toUpperCase()]);
  if (r.rows.length === 1) return { id: r.rows[0].id };
  return { error: r.rows.length ? 'More than one action matches that code.' : 'No action waiting for approval has that code.' };
}

// ── Execution ──────────────────────────────────────────────────
async function sendEmail(to: string, subject: string, text: string, replyTo: string): Promise<string> {
  const from = (process.env.FROM_NAME || 'Deemona Finance OS') + ' <' + (process.env.FROM_EMAIL || 'onboarding@resend.dev') + '>';
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#111">' + esc(text).replace(/\n/g, '<br>') + '</div>';
  const r: any = await new Resend(process.env.RESEND_API_KEY).emails.send({ from, to, subject, html, text, replyTo });
  if (r && r.error) throw new Error((r.error.message || JSON.stringify(r.error)));
  return String((r && r.data && r.data.id) || 'sent');
}
async function sendWhatsApp(to: string, text: string): Promise<string> {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
  if (!sid || !tok) throw new Error('WhatsApp is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)');
  const num = to.startsWith('whatsapp:') ? to : 'whatsapp:+91' + to.replace(/\D/g, '').slice(-10);
  const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', { method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: from, To: num, Body: text.slice(0, 1500) }).toString() });
  const d: any = await res.json().catch(() => ({}));
  if (!d.sid) throw new Error(d.message || 'Twilio did not accept the message');
  return String(d.sid);
}
const numOrNull = (v: any): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
const fmt = (v: any): string => { const n = numOrNull(v); return n === null ? '-' : inrRisk(n); };
async function buildBoardReport(pool: Pool, tenantId: string, deps: Deps, company: string, month: string): Promise<{ subject: string; html: string; text: string }> {
  const names = ['cash_position', 'cash_runway', 'working_capital', 'compliance_alerts', 'open_alerts'];
  const [cash, run, wc, comp, alerts] = await Promise.all(names.map(n => deps.runMetric(pool, tenantId, n, {}).catch(() => ({}))));
  const { events, open, today } = await loadRiskInputs(pool, tenantId);
  const risk: any = scoreCollectionRisk(events, open, today, 3);
  const days = numOrNull(run.runway_days_net) ?? numOrNull(run.runway_days_gross);
  const rows: [string, string][] = [
    ['Cash today', fmt(cash.total_cash)], ['Runway', days === null ? 'No net cash burn recorded yet' : (days >= 1080 ? '36+ months' : (days / 30).toFixed(1) + ' months')],
    ['Receivables outstanding', fmt(wc.receivables)], ['Receivables overdue', fmt(wc.ar_overdue)], ['Payables outstanding', fmt(wc.payables)], ['Payables overdue', fmt(wc.ap_overdue)],
    ['DSO / DPO', (numOrNull(wc.dso_days) ?? '-') + ' / ' + (numOrNull(wc.dpo_days) ?? '-') + ' days'],
    ['Expected bad debt next quarter (estimate)', inrRisk(risk.expected_bad_debt_total) + ' (' + risk.expected_bad_debt_pct_of_ar + '% of open receivables)'],
    ['High-risk customers', String(risk.high_risk_customers) + ' (' + inrRisk(risk.high_risk_exposure_total) + ' open)'],
    ['Overdue compliance items', String(comp.overdue_compliance_items ?? '-')], ['Open alerts', String(alerts.open_count ?? 'not scanned yet')],
  ];
  const top = (risk.customers as any[]).slice(0, 3).map(c => c.customer + ' - score ' + c.risk_score + ' (' + c.risk_band + '), open ' + inrRisk(c.open_balance));
  const text = company + ' - board summary ' + month + '\n\n' + rows.map(r => r[0] + ': ' + r[1]).join('\n') + (top.length ? '\n\nHighest collection risk:\n' + top.join('\n') : '') + '\n\nGenerated by Deemona Finance OS from live company data. Figures are as recorded in the app; estimates are marked.';
  const html = '<div style="font-family:Arial,sans-serif;color:#111"><h2>' + esc(company) + ' - board summary ' + esc(month) + '</h2><table style="border-collapse:collapse;font-size:14px">' +
    rows.map(r => '<tr><td style="padding:6px 14px 6px 0;color:#555">' + esc(r[0]) + '</td><td style="padding:6px 0"><b>' + esc(r[1]) + '</b></td></tr>').join('') + '</table>' +
    (top.length ? '<h3>Highest collection risk</h3><ul>' + top.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul>' : '') +
    '<p style="color:#777;font-size:12px">Generated by Deemona Finance OS from live company data. Estimates are marked.</p></div>';
  return { subject: company + ' - board summary ' + month, html, text };
}

async function execute(pool: Pool, row: any, actor: Actor, deps: Deps, message?: string): Promise<any> {
  const p = row.payload || {}; const tenantId = row.tenant_id;
  if (row.type === 'payment_reminder_email') {
    const text = message || p.message;
    const id = await sendEmail(p.to, p.subject, text, actor.email);
    return { sent_to: p.to, provider_id: id, message_sent: text, reply_to: actor.email };
  }
  if (row.type === 'payment_reminder_whatsapp') {
    const text = message || p.message;
    const sid = await sendWhatsApp(p.to, text);
    return { sent_to: p.to, provider_id: sid, message_sent: text.slice(0, 1500) };
  }
  if (row.type === 'board_report') {
    const company = await tenantName(pool, tenantId);
    const rep = await buildBoardReport(pool, tenantId, deps, company, p.month);
    const r: any = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: (process.env.FROM_NAME || 'Deemona Finance OS') + ' <' + (process.env.FROM_EMAIL || 'onboarding@resend.dev') + '>', to: p.to, subject: rep.subject, html: rep.html, text: rep.text });
    if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
    return { sent_to: p.to, provider_id: String((r && r.data && r.data.id) || 'sent') };
  }
  if (row.type === 'compliance_task') {
    const r = await pool.query('INSERT INTO compliance_items (tenant_id, category, title, description, frequency, due_date, penalty_if_missed, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [tenantId, p.category || 'other', p.title, p.description || '', p.frequency || 'monthly', p.due_date, null, p.notes || null]);
    return { compliance_item_id: r.rows[0].id, due_date: p.due_date };
  }
  throw new Error('Unknown action type ' + row.type);
}

export async function approveAction(pool: Pool, tenantId: string, id: string, actor: Actor, deps: Deps, overrides: { message?: string } = {}): Promise<{ ok: boolean; status: number; error?: string; action?: any }> {
  await ensureActionTables(pool); await expireOld(pool, tenantId);
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return { ok: false, status: 400, error: 'Invalid action id.' };
  const cur = await pool.query('SELECT * FROM cfo_action_queue WHERE id=$1 AND tenant_id=$2', [id, tenantId]);
  if (!cur.rows.length) return { ok: false, status: 404, error: 'Action not found.' };
  const row = cur.rows[0];
  if (row.status !== 'proposed') return { ok: false, status: 409, error: 'This action is already ' + row.status + '.' };
  if (String(row.type).startsWith('payment_reminder')) {
    const c = await pool.query("SELECT COUNT(*)::int AS n FROM cfo_action_queue WHERE tenant_id=$1 AND type LIKE 'payment_reminder%' AND status='executed' AND executed_at >= (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')", [tenantId]);
    if (c.rows[0].n >= dailyCap()) return { ok: false, status: 429, error: 'The daily limit of ' + dailyCap() + ' customer messages has been reached. Try again tomorrow.' };
  }
  const message = overrides.message && String(row.type).startsWith('payment_reminder') ? String(overrides.message).slice(0, 2000) : undefined;
  const lock = await pool.query("UPDATE cfo_action_queue SET status='approved', decided_by=$3, decided_by_email=$4, decided_at=NOW() WHERE id=$1 AND tenant_id=$2 AND status='proposed' RETURNING *", [id, tenantId, actor.id, actor.email]);
  if (!lock.rows.length) return { ok: false, status: 409, error: 'This action was just handled by someone else.' };
  await audit(pool, tenantId, id, 'approved', actor.email, { role: actor.role, edited_message: !!message });
  try {
    const result = await execute(pool, lock.rows[0], actor, deps, message);
    const up = await pool.query("UPDATE cfo_action_queue SET status='executed', executed_at=NOW(), result=$3 WHERE id=$1 AND tenant_id=$2 RETURNING *", [id, tenantId, JSON.stringify(result)]);
    await audit(pool, tenantId, id, 'executed', actor.email, result);
    return { ok: true, status: 200, action: { ...up.rows[0], code: actionCode(id) } };
  } catch (e: any) {
    const msg = String((e && e.message) || e);
    const up = await pool.query("UPDATE cfo_action_queue SET status='failed', error=$3 WHERE id=$1 AND tenant_id=$2 RETURNING *", [id, tenantId, msg]);
    await audit(pool, tenantId, id, 'failed', actor.email, { error: msg });
    return { ok: false, status: 502, error: 'The action was approved but could not be completed: ' + msg, action: { ...up.rows[0], code: actionCode(id) } };
  }
}
export async function rejectAction(pool: Pool, tenantId: string, id: string, actor: Actor, reason?: string): Promise<{ ok: boolean; status: number; error?: string; action?: any }> {
  await ensureActionTables(pool);
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return { ok: false, status: 400, error: 'Invalid action id.' };
  const r = await pool.query("UPDATE cfo_action_queue SET status='rejected', decided_by=$3, decided_by_email=$4, decided_at=NOW() WHERE id=$1 AND tenant_id=$2 AND status='proposed' RETURNING *", [id, tenantId, actor.id, actor.email]);
  if (!r.rows.length) return { ok: false, status: 409, error: 'This action is not waiting for approval.' };
  await audit(pool, tenantId, id, 'rejected', actor.email, { reason: reason ? String(reason).slice(0, 300) : undefined });
  return { ok: true, status: 200, action: { ...r.rows[0], code: actionCode(id) } };
}

// Optional daily job: propose actions on its own and email the admins. Off unless ACTIONS_AUTOPROPOSE=1.
export function startActionProposalJob(pool: Pool): void {
  if (process.env.ACTIONS_AUTOPROPOSE !== '1') return;
  cron.schedule('30 9 * * *', async () => {
    try {
      const t = await pool.query('SELECT id FROM tenants LIMIT 1000');
      for (const row of t.rows) {
        try {
          const a = await proposeCollectionActions(pool, row.id, { channels: ['email'] }, 'system');
          const c = await proposeComplianceTasks(pool, row.id, 'system');
          const n = a.proposed.length + c.proposed.length;
          const to = n ? await adminEmail(pool, row.id) : null;
          if (to) await new Resend(process.env.RESEND_API_KEY).emails.send({ from: (process.env.FROM_NAME || 'Deemona Finance OS') + ' <' + (process.env.FROM_EMAIL || 'onboarding@resend.dev') + '>', to, subject: n + ' action' + (n === 1 ? '' : 's') + ' waiting for your approval',
            html: '<p>Your Digital CFO has proposed ' + n + ' action' + (n === 1 ? '' : 's') + '. Nothing is sent until you approve it.</p><p>Open Deemona Finance OS and go to Actions to review.</p>' }).catch(() => {});
        } catch (e) { console.error('[actions] auto-propose failed for a tenant', e); }
      }
    } catch (e) { console.error('[actions] auto-propose job failed', e); }
  }, { timezone: 'Asia/Kolkata' });
  console.log('[Actions] daily auto-propose job scheduled (09:30 IST)');
}
`;

const ROUTES = String.raw`// /api/actions: proposed actions, approval, audit. Admins and owners only.
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { runMetric } from '../services/cfoMetrics';
import { listActions, listAudit, approveAction, rejectAction, proposeCollectionActions, proposeBoardReport, proposeComplianceTasks } from '../services/controlledActions';

export function createActionsRouter(pool: Pool): Router {
  const router = Router();
  const admin = requireRole('admin', 'owner');
  const t = (req: Request): string => (req as any).user.tenantId;
  const actor = (req: Request) => { const u = (req as any).user; return { id: String(u.id), email: String(u.email || ''), name: u.name, role: String(u.role || '') }; };
  const wrap = (fn: (req: Request, res: Response) => Promise<any>) => async (req: Request, res: Response) => { try { await fn(req, res); } catch (e) { console.error('[actions]', e); res.status(500).json({ error: 'Something went wrong. Please try again.' }); } };

  router.get('/', requireAuth, admin, wrap(async (req, res) => { res.json({ actions: await listActions(pool, t(req), String(req.query.scope || 'open'), parseInt(String(req.query.limit || '50'), 10)) }); }));
  router.get('/audit', requireAuth, admin, wrap(async (req, res) => { res.json({ audit: await listAudit(pool, t(req), parseInt(String(req.query.limit || '100'), 10)) }); }));
  router.post('/propose/reminders', requireAuth, admin, wrap(async (req, res) => {
    const b = req.body || {};
    res.json(await proposeCollectionActions(pool, t(req), { channels: Array.isArray(b.channels) ? b.channels : undefined, min_days_overdue: b.min_days_overdue, limit: b.limit }, actor(req).email));
  }));
  router.post('/propose/board-report', requireAuth, admin, wrap(async (req, res) => { res.json(await proposeBoardReport(pool, t(req), actor(req).email || null, actor(req).email)); }));
  router.post('/propose/compliance', requireAuth, admin, wrap(async (req, res) => { res.json(await proposeComplianceTasks(pool, t(req), actor(req).email)); }));
  router.post('/:id/approve', requireAuth, admin, wrap(async (req, res) => {
    const r = await approveAction(pool, t(req), String(req.params.id), actor(req), { runMetric }, { message: typeof req.body?.message === 'string' ? req.body.message : undefined });
    res.status(r.status).json(r.ok ? { action: r.action } : { error: r.error, action: r.action });
  }));
  router.post('/:id/reject', requireAuth, admin, wrap(async (req, res) => {
    const r = await rejectAction(pool, t(req), String(req.params.id), actor(req), typeof req.body?.reason === 'string' ? req.body.reason : undefined);
    res.status(r.status).json(r.ok ? { action: r.action } : { error: r.error });
  }));
  return router;
}
`;

const METRIC = String.raw`
  /*propose-actions*/
  propose_actions: {
    description: 'Queues PROPOSED actions for a company admin to approve; it never sends or changes anything itself. kind payment_reminders proposes reminders to customers with overdue invoices (ranked by collection risk, email and/or WhatsApp); board_report proposes the monthly board summary email; compliance_tasks proposes the next statutory due dates (GST, TDS, PF/ESI, advance tax) as compliance items. Use for "remind the customers who owe us", "chase overdue invoices", "send the board report", "schedule compliance tasks". After calling, tell the user the proposals now wait in the Actions page (or can be approved on WhatsApp with OK <code> / NO <code>) and that nothing has been sent yet.',
    input_schema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['payment_reminders', 'board_report', 'compliance_tasks'] },
      channels: { type: 'array', items: { type: 'string', enum: ['email', 'whatsapp'] }, description: 'For payment_reminders. Default email.' },
      min_days_overdue: { type: 'integer', description: 'For payment_reminders: only customers with an invoice at least this many days overdue. Default 7.' },
      limit: { type: 'integer', description: 'For payment_reminders: max customers. Default 10.' },
    }, required: ['kind'] },
    async run(pool, t, input) {
      const by = 'digital-cfo';
      let r: any;
      if (input?.kind === 'payment_reminders') r = await proposeCollectionActions(pool, t, { channels: Array.isArray(input.channels) ? input.channels : undefined, min_days_overdue: input.min_days_overdue, limit: input.limit }, by);
      else if (input?.kind === 'board_report') r = await proposeBoardReport(pool, t, null, by);
      else if (input?.kind === 'compliance_tasks') r = await proposeComplianceTasks(pool, t, by);
      else return { error: 'kind must be payment_reminders, board_report or compliance_tasks' };
      return { kind: input.kind, proposals_created_count: r.proposed.length, proposed: r.proposed, skipped: r.skipped,
        status_note: 'These are PROPOSALS. Nothing has been sent or changed. A company admin must approve each one in the Actions page, or on WhatsApp with OK <code> or NO <code>.' };
    },
  },
`;

function rd(p) { let s = fs.readFileSync(p, 'utf8'); const bom = s.charCodeAt(0) === 0xFEFF; if (bom) s = s.slice(1); const crlf = s.includes('\r\n'); if (crlf) s = s.replace(/\r\n/g, '\n'); return { s, bom, crlf }; }
function put(p, c) { if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== c) { fs.writeFileSync(p, c); console.log('wrote', p); } else console.log('up to date', p); }
function patch(p, fn) { if (!fs.existsSync(p)) { console.log('MISSING', p); process.exitCode = 1; return; } const o = rd(p); const t = fn(o.s); if (t !== o.s) { fs.writeFileSync(p, (o.bom ? '﻿' : '') + (o.crlf ? t.replace(/\n/g, '\r\n') : t)); console.log('patched', p); } else console.log('no change', p); }
function need(s, a, where) { if (!s.includes(a)) { console.log('anchor not found in ' + where + ': ' + a.slice(0, 70)); process.exit(1); } }

put('src/services/controlledActions.ts', SVC);
put('src/routes/actionsRoutes.ts', ROUTES);

// Reply-To support in the mailer, so customers reply to the approver and not to the no-reply mailbox
patch('src/services/mailer.ts', s => {
  if (s.includes('replyTo?: string')) return s;
  const a1 = 'subject: string; html?: string; text?: string }): Promise<{ ok: boolean; id?: string; error?: string }> {';
  const a2 = "const info = await getTransport().sendMail({ from: { name, address }, to: m.to, subject: m.subject, html: m.html, text: m.text || (m.html ? undefined : '') });";
  const a3 = 'const r = await sendMail({ from: p.from, to: p.to, subject: p.subject, html: p.html, text: p.text });';
  [a1, a2, a3].forEach(a => need(s, a, 'mailer.ts (apply apply-smtp-backend.cjs first)'));
  s = s.replace(a1, 'subject: string; html?: string; text?: string; replyTo?: string }): Promise<{ ok: boolean; id?: string; error?: string }> {');
  s = s.replace(a2, "const info = await getTransport().sendMail({ from: { name, address }, to: m.to, subject: m.subject, html: m.html, text: m.text || (m.html ? undefined : ''), replyTo: m.replyTo });");
  return s.replace(a3, 'const r = await sendMail({ from: p.from, to: p.to, subject: p.subject, html: p.html, text: p.text, replyTo: p.replyTo || p.reply_to });');
});

// customer id in the risk output
patch('src/services/collectionRisk.ts', s => {
  if (s.includes('customer_id: cid')) return s;
  const a = 'byCust.forEach((c) => {', b = 'customer: c.name, risk_score: score,';
  need(s, a, 'collectionRisk.ts (apply apply-collection-risk-backend.cjs first)'); need(s, b, 'collectionRisk.ts');
  return s.replace(a, 'byCust.forEach((c, cid) => {').replace(b, 'customer_id: cid, customer: c.name, risk_score: score,');
});

patch('src/services/cfoMetrics.ts', s => {
  if (s.includes('/*propose-actions*/')) return s;
  const a = '\n  revenue_root_cause: {';
  need(s, a, 'cfoMetrics.ts (apply apply-decision-tools-backend.cjs first)');
  s = s.replace(a, METRIC + a);
  const imp = "import { buildActionPlan } from './actionPlan';";
  need(s, imp, 'cfoMetrics.ts');
  return s.replace(imp, imp + "\nimport { proposeCollectionActions, proposeBoardReport, proposeComplianceTasks } from './controlledActions';");
});

patch('src/index.ts', s => {
  if (s.includes('createActionsRouter')) return s;
  const use = "app.use('/api/collection-risk', createCollectionRiskRouter(pool));";
  const imp = "import { createCollectionRiskRouter } from './routes/collectionRiskRoutes';";
  const snap = '  startCfoSnapshotJob(pool);';
  need(s, use, 'index.ts (apply apply-collection-risk-backend.cjs first)'); need(s, imp, 'index.ts'); need(s, snap, 'index.ts');
  s = s.replace(imp, imp + "\nimport { createActionsRouter } from './routes/actionsRoutes';\nimport { startActionProposalJob } from './services/controlledActions';");
  s = s.replace(use, use + "\napp.use('/api/actions', createActionsRouter(pool));");
  return s.replace(snap, snap + '\n  startActionProposalJob(pool);');
});

patch('src/routes/cfoAgentRoutes.ts', s => {
  if (s.includes('propose_actions')) return s;
  const a = '- Get every figure from the tools. Never estimate or recall numbers.';
  need(s, a, 'cfoAgentRoutes.ts');
  return s.replace(a, '- For "remind / chase the customers who owe us", "send the board report", "schedule compliance tasks" use propose_actions. It only QUEUES proposals; nothing is sent. Say clearly that nothing has been sent, list what was proposed (customer, amount, channel, code), and that a company admin must approve each one in the Actions page or on WhatsApp with OK <code> or NO <code>. Mention anything skipped and why (for example no email saved). Never claim a reminder was sent.\n' + a);
});

// WhatsApp: ACTIONS, OK <code>, NO <code> for company admins
patch('src/services/whatsappCommands.ts', s => {
  if (s.includes('ACTIONS|OK|NO')) return s;
  const re = "const m = /^(HELP|MENU|DUE|PENDING|INVOICE|INV)\\b\\s*(.*)$/i.exec(text);";
  need(s, re, 'whatsappCommands.ts (apply apply-whatsapp-commands-backend.cjs first)');
  s = s.replace(re, "const m = /^(HELP|MENU|DUE|PENDING|INVOICE|INV|ACTIONS|OK|NO)\\b\\s*(.*)$/i.exec(text);");
  const gate = "const cmd = m[1].toUpperCase();\n  const arg = m[2].trim();";
  need(s, gate, 'whatsappCommands.ts');
  s = s.replace(gate, gate + "\n  if ((cmd === 'OK' || cmd === 'NO') && !/^[A-F0-9]{6}$/i.test(arg)) return null;   // a plain OK / No is just chat");
  const helpAnchor = "'APPROVE <ID> / REJECT <ID> - act on a pending invoice',";
  need(s, helpAnchor, 'whatsappCommands.ts');
  s = s.replace(helpAnchor, helpAnchor + "\n  'ACTIONS - actions proposed by your Digital CFO (admins)',\n  'OK <code> / NO <code> - approve or reject a proposed action (admins)',");
  const branch = "    if (cmd === 'HELP' || cmd === 'MENU') return HELP;";
  need(s, branch, 'whatsappCommands.ts');
  return s.replace(branch, branch + String.raw`

    if (cmd === 'ACTIONS' || cmd === 'OK' || cmd === 'NO') {
      const emp = await pool.query("SELECT LOWER(email) AS email FROM employees WHERE tenant_id=$1 AND status='active' AND email IS NOT NULL AND RIGHT(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$2 LIMIT 1", [t, digits]);
      const usr = emp.rows.length ? await pool.query("SELECT id::text AS id, email, role, first_name FROM users WHERE tenant_id=$1 AND LOWER(email)=$2 AND role IN ('admin','owner') LIMIT 1", [t, emp.rows[0].email]) : { rows: [] as any[] };
      if (!usr.rows.length) return 'Only company admins can see or approve actions. Your WhatsApp number must be saved on your employee record with the same email as your admin login.';
      const who2 = { id: usr.rows[0].id, email: usr.rows[0].email, name: usr.rows[0].first_name, role: usr.rows[0].role };
      if (cmd === 'ACTIONS') {
        const list = await listActions(pool, t, 'open', 5);
        if (!list.length) return 'No actions are waiting for your approval.';
        return cut(['Waiting for your approval:'].concat(list.map((x: any) => '\n' + x.code + ' - ' + x.title + '\n' + (x.summary || ''))).concat(['\nReply OK <code> to approve or NO <code> to reject.']).join('\n'));
      }
      const found = await findByCode(pool, t, arg);
      if (!found.id) return found.error || 'Not found.';
      if (cmd === 'NO') { const r = await rejectAction(pool, t, found.id, who2); return r.ok ? 'Rejected. Nothing was sent.' : (r.error || 'Could not reject.'); }
      const r = await approveAction(pool, t, found.id, who2, { runMetric });
      return r.ok ? 'Approved and done: ' + (r.action && r.action.title ? r.action.title : 'action') + '.' : (r.error || 'Could not approve.');
    }`);
});
patch('src/services/whatsappCommands.ts', s => {
  if (s.includes("from './controlledActions'")) return s;
  need(s, "export async function handleWhatsAppCommand", 'whatsappCommands.ts');
  return "import { listActions, findByCode, approveAction, rejectAction } from './controlledActions';\nimport { runMetric } from './cfoMetrics';\n" + s;
});
