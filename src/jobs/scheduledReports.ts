// ============================================================
// Deemona AI Finance OS — Scheduled report automations
//  1. AI Smart Insights     daily   08:00 IST   (emails the executive summary)
//  2. Anomaly Detection     daily   09:00 IST   (emails high/critical anomalies only)
//  3. Balance Sheet         Monday  09:00 IST   (emails the summary)
//  4. Filing reports        1st     10:00 IST   (GST GSTR-3B and TDS 26Q for the month just ended)
// Design: a 10-minute tick checks what is due and not yet done, so a server that was
// asleep or redeploying at 8am still runs the job when it wakes. Each (tenant, job, period)
// is claimed in the database first, so a job never runs twice for the same period.
// Calls the app's own endpoints with "Bearer internal-<CRON_SECRET>.<tenantId>".
// ============================================================
import { Pool } from 'pg';
import { Resend } from '../services/mailer';

type Json = Record<string, any>;
type Ctx = { period: string };
interface Job {
  key: string; label: string; hour: number; every: 'day' | 'week' | 'month';
  run: (pool: Pool, tenantId: string, ctx: Ctx) => Promise<boolean>;   // true = done (don't retry this period)
}

// ── time (India) ─────────────────────────────────────────────
const istNow = (): Date => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function periodOf(every: Job['every'], now: Date): { key: string; start: string } {
  if (every === 'day') return { key: ymd(now), start: ymd(now) };
  if (every === 'week') { const m = new Date(now); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return { key: ymd(m), start: ymd(m) }; }
  const f = new Date(now.getFullYear(), now.getMonth(), 1);
  return { key: ymd(f).slice(0, 7), start: ymd(f) };
}
/** Due once the scheduled hour has passed on the first day of the period, and any time after that day. */
const isDue = (job: Job, now: Date): boolean => ymd(now) > periodOf(job.every, now).start || now.getHours() >= job.hour;
const prevMonthLabel = (now: Date): string =>
  new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const todayLabel = (now: Date): string => now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

// ── helpers ──────────────────────────────────────────────────
const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inrShort = (n: unknown): string => {
  const v = parseFloat(String(n ?? 0)) || 0;
  if (Math.abs(v) >= 1e7) return '₹' + (v / 1e7).toFixed(2) + ' Cr';
  if (Math.abs(v) >= 1e5) return '₹' + (v / 1e5).toFixed(2) + ' L';
  return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
};
const secretOk = (): boolean => (process.env.CRON_SECRET || '').length >= 16;
const baseUrl = (): string => (process.env.BACKEND_URL || '').replace(/\/+$/, '') || `http://127.0.0.1:${process.env.PORT || 4001}`;

async function api(tenantId: string, method: 'GET' | 'POST', path: string, body?: Json): Promise<{ ok: boolean; status: number; json: Json }> {
  const r = await fetch(baseUrl() + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer internal-${process.env.CRON_SECRET}.${tenantId}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180_000),
  });
  const json = (await r.json().catch(() => ({}))) as Json;
  return { ok: r.ok, status: r.status, json };
}

async function recipient(pool: Pool, tenantId: string): Promise<string | null> {
  const q = async (sql: string) => (await pool.query(sql, [tenantId])).rows[0]?.email as string | undefined;
  try { return (await q(`SELECT email FROM users WHERE tenant_id=$1 AND is_active=true ORDER BY (role='owner') DESC, email LIMIT 1`)) || null; }
  catch { try { return (await q(`SELECT email FROM users WHERE tenant_id=$1 AND is_active=true LIMIT 1`)) || null; } catch { return null; } }
}
async function emailTenant(pool: Pool, tenantId: string, subject: string, html: string): Promise<void> {
  if (!process.env.RESEND_API_KEY) { console.log('[Reports] RESEND_API_KEY not set — email skipped:', subject); return; }
  const to = await recipient(pool, tenantId);
  if (!to) { console.log('[Reports] no recipient for tenant', tenantId); return; }
  try {
    await new Resend(process.env.RESEND_API_KEY).emails.send({ from: 'Deemona Finance OS <onboarding@resend.dev>', to, subject, html });
    console.log('[Reports] emailed', subject, '→', to);
  } catch (e) { console.error('[Reports] email failed:', String(e)); }
}
/** Turns the model's markdown (headings, bold, bullets, numbered lists, tables, rules) into safe email HTML. Everything is escaped first. */
export function mdToHtml(src: string): string {
  const lines = String(src ?? '').split('\n'); const out: string[] = []; let list: 'ul' | 'ol' | null = null;
  const inl = (s: string): string => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const close = (): void => { if (list) { out.push(`</${list}>`); list = null; } };
  const cells = (l: string): string[] => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trimEnd();
    if (/^\s*\|.*\|\s*$/.test(l)) {
      close(); const block: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { block.push(lines[i]); i++; }
      i--;
      const rows = block.filter(r => !cells(r).every(c => /^:?-{2,}:?$/.test(c))).map(cells);
      out.push('<table style="border-collapse:collapse;margin:8px 0;font-size:13px">' + rows.map((r, ri) =>
        '<tr>' + r.map(c => `<${ri === 0 ? 'th' : 'td'} style="border:1px solid #e2e8f0;padding:5px 9px;text-align:left${ri === 0 ? ';background:#f8fafc' : ''}">${inl(c)}</${ri === 0 ? 'th' : 'td'}>`).join('') + '</tr>').join('') + '</table>');
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/), ul = l.match(/^\s*[-*•]\s+(.*)$/), ol = l.match(/^\s*\d+[.)]\s+(.*)$/);
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { close(); out.push('<hr style="border:0;border-top:1px solid #e2e8f0;margin:12px 0">'); }
    else if (h) { close(); out.push(`<h3 style="margin:14px 0 4px;font-size:${h[1].length <= 2 ? '16' : '14'}px;color:#0f172a">${inl(h[2])}</h3>`); }
    else if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { close(); out.push(`<${kind} style="margin:4px 0 8px;padding-left:20px">`); list = kind; }
      out.push(`<li style="margin-bottom:3px">${inl((ul || ol)![1])}</li>`);
    }
    else if (!l.trim()) close();
    else { close(); out.push(`<p style="margin:4px 0 8px">${inl(l)}</p>`); }
  }
  close(); return out.join('');
}

const wrap = (title: string, color: string, inner: string): string =>
  `<html><body style="font-family:Arial;padding:20px;max-width:640px"><h2 style="color:${color}">${esc(title)}</h2>${inner}` +
  `<p style="color:#64748b;font-size:12px;margin-top:20px">Automatic report from Deemona AI Finance OS</p></body></html>`;

// ── the four jobs ────────────────────────────────────────────
export const JOBS: Job[] = [
  {
    key: 'ai_insights', label: 'AI Smart Insights', hour: 8, every: 'day',
    async run(pool, t) {
      const r = await api(t, 'POST', '/api/ai/insights/generate', { insight_type: 'executive_summary' });
      const content = r.json?.insight?.content;
      if (!r.ok || !content) { console.error('[Reports] insights failed', r.status, JSON.stringify(r.json).slice(0, 200)); return false; }
      await emailTenant(pool, t, `📊 Daily AI Financial Summary — ${todayLabel(istNow())}`,
        wrap('Daily AI Financial Summary', '#1d4ed8', `<div style="background:#f8faff;border-left:4px solid #1d4ed8;padding:12px 16px;border-radius:4px;line-height:1.55">${mdToHtml(content)}</div>`));
      return true;
    },
  },
  {
    key: 'anomaly_detection', label: 'Anomaly Detection', hour: 9, every: 'day',
    async run(pool, t) {
      const r = await api(t, 'POST', '/api/ai/anomaly/detect');
      if (!r.ok) { console.error('[Reports] anomaly failed', r.status, JSON.stringify(r.json).slice(0, 200)); return false; }
      const critical = ((r.json.anomalies as Json[]) || []).filter(a => ['high', 'critical'].includes(String(a.severity)));
      if (critical.length) {
        await emailTenant(pool, t, `⚠️ ${critical.length} financial anomalies detected — ${todayLabel(istNow())}`,
          wrap('Financial Anomaly Alert', '#dc2626', `<p><strong>${critical.length} high/critical anomalies</strong> were found in your financial data.</p>` +
            critical.map(a => `<div style="background:#fef2f2;border-left:4px solid #dc2626;padding:12px;margin:10px 0;border-radius:4px"><strong style="color:#dc2626">${esc(String(a.severity).toUpperCase())}: ${esc(a.metric)}</strong><br>${esc(a.description)}<br><span style="color:#64748b;font-size:12px">${esc(a.ai_explanation || '')}</span></div>`).join('')));
      }
      return true;
    },
  },
  {
    key: 'balance_sheet', label: 'Balance Sheet', hour: 9, every: 'week',
    async run(pool, t) {
      const r = await api(t, 'GET', '/api/ai/balance-sheet');
      const bs = r.json;
      if (!r.ok || !bs.assets) { console.error('[Reports] balance sheet failed', r.status, JSON.stringify(bs).slice(0, 200)); return false; }
      const row = (label: string, v: unknown, bold = false) => `<tr><td style="padding:7px 10px;color:#64748b${bold ? ';font-weight:700' : ''}">${esc(label)}</td><td style="padding:7px 10px;text-align:right${bold ? ';font-weight:700' : ''}">${inrShort(v)}</td></tr>`;
      await emailTenant(pool, t, `⚖️ Weekly Balance Sheet — ${todayLabel(istNow())}`,
        wrap('Weekly Balance Sheet Summary', '#1d4ed8',
          `<p>As of ${esc(bs.asOfDate)}</p><table style="width:100%;border-collapse:collapse;font-size:13px">` +
          row('Cash & bank', bs.assets.current.cash) + row('Accounts receivable', bs.assets.current.accountsReceivable) + row('Inventory', bs.assets.current.inventory) +
          row('Fixed assets', bs.assets.fixed.total) + row('TOTAL ASSETS', bs.assets.total, true) +
          row('Accounts payable', bs.liabilities.current.accountsPayable) + row('GST payable', bs.liabilities.current.gstPayable) + row('Long-term loans', bs.liabilities.longTerm.loans) +
          row('TOTAL LIABILITIES', bs.liabilities.total, true) + row('SHAREHOLDERS’ EQUITY', bs.equity.shareholdersEquity, true) + `</table>` +
          `<p style="font-size:12px;color:#475569">Current ratio ${esc(bs.ratios.currentRatio)}x · Debt/equity ${esc(bs.ratios.debtToEquity)}x · Asset turnover ${esc(bs.ratios.assetTurnover)}x</p>`));
      return true;
    },
  },
  ...(['GST_GSTR3B', 'TDS_26Q'] as const).map((filingType): Job => ({
    key: 'filing_' + filingType, label: 'Filing report ' + filingType, hour: 10, every: 'month',
    async run(_pool, t) {
      // the endpoint saves the report and emails it itself
      const r = await api(t, 'POST', '/api/ai/filing/generate', { filing_type: filingType, period: prevMonthLabel(istNow()) });
      if (!r.ok) console.error('[Reports] filing failed', filingType, r.status, JSON.stringify(r.json).slice(0, 200));
      return r.ok;
    },
  })),
];

// ── scheduler ────────────────────────────────────────────────
let tableReady = false, busy = false, warned = false;
const failedAt = new Map<string, number>();

async function ensureTable(pool: Pool): Promise<void> {
  if (tableReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_report_runs (
    tenant_id TEXT NOT NULL, job TEXT NOT NULL, period_key TEXT NOT NULL, ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, job, period_key))`);
  tableReady = true;
}

/** Tenants with an active user and at least some financial data (empty accounts would only burn AI calls). */
async function activeTenants(pool: Pool): Promise<string[]> {
  const r = await pool.query(
    `SELECT DISTINCT u.tenant_id::text AS t FROM users u WHERE u.is_active=true AND (
       EXISTS (SELECT 1 FROM ar_invoices a WHERE a.tenant_id::text = u.tenant_id::text) OR
       EXISTS (SELECT 1 FROM bank_transactions b WHERE b.tenant_id::text = u.tenant_id::text))`).catch(() => ({ rows: [] as Json[] }));
  return r.rows.map(x => String(x.t));
}

/** One pass: runs every job that is due and not yet done for its period. Also exported for manual testing. */
export async function runScheduledReportsNow(pool: Pool): Promise<string[]> {
  const done: string[] = [];
  if (busy) return done;
  busy = true;
  try {
    if (!secretOk()) { if (!warned) { console.warn('[Reports] CRON_SECRET missing or shorter than 16 characters — scheduled reports are paused'); warned = true; } return done; }
    await ensureTable(pool);
    const now = istNow();
    for (const t of await activeTenants(pool)) {
      for (const job of JOBS) {
        if (!isDue(job, now)) continue;
        const key = periodOf(job.every, now).key, id = `${t}|${job.key}|${key}`;
        const lastFail = failedAt.get(id);
        if (lastFail && Date.now() - lastFail < 60 * 60 * 1000) continue;                        // retry a failed job after an hour
        const claim = await pool.query(`INSERT INTO scheduled_report_runs (tenant_id, job, period_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`, [t, job.key, key]);
        if (!claim.rowCount) continue;                                                            // already done (or another instance has it)
        let ok = false;
        try { ok = await job.run(pool, t, { period: key }); } catch (e) { console.error('[Reports]', job.label, 'crashed:', String(e)); }
        if (ok) { console.log(`[Reports] ${job.label} done for ${t} (${key})`); done.push(`${job.key}:${t}`); failedAt.delete(id); }
        else { failedAt.set(id, Date.now()); await pool.query(`DELETE FROM scheduled_report_runs WHERE tenant_id=$1 AND job=$2 AND period_key=$3`, [t, job.key, key]).catch(() => {}); }
      }
    }
  } finally { busy = false; }
  return done;
}

/** Call once at startup. */
export function startScheduledReports(pool: Pool): void {
  const tick = () => runScheduledReportsNow(pool).catch(e => console.error('[Reports] tick failed:', String(e)));
  setTimeout(tick, 120_000);
  setInterval(tick, 10 * 60 * 1000);
  console.log('[Reports] Scheduled reports registered: AI Insights 08:00, Anomaly 09:00, Balance Sheet Mon 09:00, Filing 1st 10:00 (IST)');
}
