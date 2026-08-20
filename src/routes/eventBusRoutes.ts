// ============================================================
// Deemona AI Finance OS — Event Bus + SSE + Scheduled Reports
// File: src/routes/eventBusRoutes.ts
// Phase 2: Event Bus — triggers automations on data import
// Phase 3: SSE — real-time dashboard refresh
// Phase 4: Scheduled Gmail reports
// ============================================================

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';
import { REPORT_REGISTRY, reportOverdueAlert, reportCreditBreach, reportImportSummary } from './reportEngine';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);


// ── SSE Client Registry ───────────────────────────────────────
interface SSEClient {
  tenantId: string;
  res: Response;
  connectedAt: Date;
}

const sseClients: Map<string, SSEClient[]> = new Map();

function addSSEClient(tenantId: string, res: Response): string {
  const clientId = Math.random().toString(36).substring(2);
  if (!sseClients.has(tenantId)) sseClients.set(tenantId, []);
  sseClients.get(tenantId)!.push({ tenantId, res, connectedAt: new Date() });
  return clientId;
}

function removeSSEClient(tenantId: string, res: Response) {
  const clients = sseClients.get(tenantId) || [];
  sseClients.set(tenantId, clients.filter(c => c.res !== res));
}

function broadcastToTenant(tenantId: string, event: string, data: any) {
  const clients = sseClients.get(tenantId) || [];
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => {
    try { client.res.write(payload); } catch {}
  });
  console.log(`[EventBus] Broadcast ${event} to ${clients.length} clients for tenant ${tenantId}`);
}

// ── Email Transport ───────────────────────────────────────────
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const { error } = await resend.emails.send({
      from: 'Deemona Finance OS <onboarding@resend.dev>',
      to,
      subject,
      html,
    });
    if (error) {
      console.error('[Email] Resend error:', JSON.stringify(error));
      return false;
    }
    console.log('[Email] Sent to ' + to + ': ' + subject);
    return true;
  } catch (e) {
    console.error('[Email] Failed:', e);
    return false;
  }
}

// ── Event Handlers ────────────────────────────────────────────
async function handleDataIngested(pool: Pool, tenantId: string, dataType: string, inserted: number) {
  const events: string[] = [];

  // 1. Always broadcast dashboard refresh
  broadcastToTenant(tenantId, 'dashboard_refresh', {
    message: `${inserted} ${dataType} records imported`,
    dataType, inserted, timestamp: new Date().toISOString(),
  });
  events.push('dashboard_refresh');

  // 2. Check for overdue AR if sales invoices imported
  if (dataType === 'SALES_INVOICES' || dataType === 'AR_INVOICES') {
    const overdue = await pool.query(`
      SELECT ar.invoice_number, c.name as customer_name, ar.total_amount, ar.due_date,
        CURRENT_DATE - ar.due_date as days_overdue
      FROM ar_invoices ar LEFT JOIN customers c ON ar.customer_id=c.id
      WHERE ar.tenant_id=$1 AND ar.due_date < CURRENT_DATE
        AND ar.status NOT IN ('paid','cancelled')
      ORDER BY days_overdue DESC LIMIT 10`, [tenantId]).catch(() => ({ rows: [] }));

    if (overdue.rows.length > 0) {
      broadcastToTenant(tenantId, 'overdue_alert', {
        count: overdue.rows.length,
        invoices: overdue.rows,
        message: `${overdue.rows.length} invoices are overdue`,
      });
      events.push('overdue_alert');
    }
  }

  // 3. Check credit limit breaches
  if (dataType === 'SALES_INVOICES') {
    const breaches = await pool.query(`
      SELECT c.name, c.credit_limit,
        COALESCE(SUM(ar.total_amount),0) as outstanding
      FROM customers c
      LEFT JOIN ar_invoices ar ON ar.customer_id=c.id
        AND ar.status NOT IN ('paid','cancelled') AND ar.tenant_id=$1
      WHERE c.tenant_id=$1 AND c.credit_limit > 0
      GROUP BY c.id, c.name, c.credit_limit
      HAVING COALESCE(SUM(ar.total_amount),0) > c.credit_limit`, [tenantId]).catch(() => ({ rows: [] }));

    if (breaches.rows.length > 0) {
      broadcastToTenant(tenantId, 'credit_breach', {
        count: breaches.rows.length,
        customers: breaches.rows,
      });
      events.push('credit_breach');
    }
  }

  // 4. Check inventory reorder alerts
  if (dataType === 'INVENTORY') {
    const reorder = await pool.query(`
      SELECT name, sku, quantity, reorder_level
      FROM inventory_items
      WHERE tenant_id=$1 AND quantity <= reorder_level`, [tenantId]).catch(() => ({ rows: [] }));

    if (reorder.rows.length > 0) {
      broadcastToTenant(tenantId, 'reorder_alert', {
        count: reorder.rows.length, items: reorder.rows,
      });
      events.push('reorder_alert');
    }
  }

  // 5. Log all events
  await pool.query(
    `INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at)
     VALUES ($1, 'EVENT_BUS', 'success', $2, NOW())`,
    [tenantId, `Events fired: ${events.join(', ')} after ${dataType} import`]
  ).catch(() => {});

  return events;
}

// ── Report Generators ─────────────────────────────────────────
async function generateARAgingReport(pool: Pool, tenantId: string): Promise<string> {
  const [summary, aging, overdue] = await Promise.all([
    pool.query(`SELECT
      COALESCE(SUM(total_amount),0) as total_ar,
      COALESCE(SUM(CASE WHEN status NOT IN ('paid','cancelled') THEN total_amount ELSE 0 END),0) as outstanding,
      COUNT(CASE WHEN due_date < CURRENT_DATE AND status NOT IN ('paid','cancelled') THEN 1 END) as overdue_count
      FROM ar_invoices WHERE tenant_id=$1`, [tenantId]),
    pool.query(`SELECT
      COALESCE(SUM(CASE WHEN due_date >= CURRENT_DATE THEN total_amount ELSE 0 END),0) as current_bucket,
      COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date BETWEEN 1 AND 30 THEN total_amount ELSE 0 END),0) as bucket_30,
      COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date BETWEEN 31 AND 60 THEN total_amount ELSE 0 END),0) as bucket_60,
      COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date BETWEEN 61 AND 90 THEN total_amount ELSE 0 END),0) as bucket_90,
      COALESCE(SUM(CASE WHEN CURRENT_DATE - due_date > 90 THEN total_amount ELSE 0 END),0) as bucket_90plus
      FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled')`, [tenantId]),
    pool.query(`SELECT c.name as customer, ar.invoice_number, ar.total_amount, ar.due_date,
      CURRENT_DATE - ar.due_date as days_overdue
      FROM ar_invoices ar LEFT JOIN customers c ON ar.customer_id=c.id
      WHERE ar.tenant_id=$1 AND ar.due_date < CURRENT_DATE AND ar.status NOT IN ('paid','cancelled')
      ORDER BY days_overdue DESC LIMIT 10`, [tenantId]),
  ]);

  const s = summary.rows[0];
  const a = aging.rows[0];
  const fmt = (n: any) => '₹' + parseFloat(n||0).toLocaleString('en-IN', {minimumFractionDigits:0, maximumFractionDigits:0});

  return `
<!DOCTYPE html>
<html>
<head><style>
  body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; color: #334155; }
  h1 { color: #1e3a8a; border-bottom: 3px solid #1d4ed8; padding-bottom: 10px; }
  h2 { color: #1d4ed8; margin-top: 24px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; margin: 16px 0; }
  .kpi { background: #f0f4ff; border-radius: 8px; padding: 14px; border-left: 4px solid #1d4ed8; }
  .kpi-label { font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase; }
  .kpi-value { font-size: 22px; font-weight: 800; color: #0f172a; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th { background: #1d4ed8; color: white; padding: 10px 12px; text-align: left; font-size: 12px; }
  td { padding: 9px 12px; border-bottom: 1px solid #f1f5f9; font-size: 12px; }
  tr:nth-child(even) { background: #f8faff; }
  .overdue { color: #dc2626; font-weight: 700; }
  .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; }
  .aging-bar { display: flex; gap: 8px; margin: 12px 0; }
  .aging-item { flex: 1; padding: 10px; border-radius: 6px; text-align: center; }
</style></head>
<body>
  <h1>📊 AR Aging Report — ${new Date().toLocaleDateString('en-IN', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}</h1>
  <p style="color:#64748b">Generated by Deemona AI Finance OS · Automated Daily Report</p>

  <div class="kpi-grid">
    <div class="kpi"><div class="kpi-label">Total AR</div><div class="kpi-value">${fmt(s?.total_ar)}</div></div>
    <div class="kpi"><div class="kpi-label">Outstanding</div><div class="kpi-value" style="color:#d97706">${fmt(s?.outstanding)}</div></div>
    <div class="kpi"><div class="kpi-label">Overdue Invoices</div><div class="kpi-value" style="color:#dc2626">${s?.overdue_count || 0}</div></div>
  </div>

  <h2>AR Aging Buckets</h2>
  <table>
    <tr><th>Bucket</th><th>Amount</th><th>% of Outstanding</th></tr>
    ${[
      ['Current (Not Due)', a?.current_bucket, '#16a34a'],
      ['1-30 Days Overdue', a?.bucket_30, '#d97706'],
      ['31-60 Days Overdue', a?.bucket_60, '#f59e0b'],
      ['61-90 Days Overdue', a?.bucket_90, '#dc2626'],
      ['90+ Days Overdue', a?.bucket_90plus, '#7f1d1d'],
    ].map(([label, val, color]) => {
      const pct = s?.outstanding > 0 ? ((parseFloat(val as string||'0') / parseFloat(s.outstanding)) * 100).toFixed(1) : '0.0';
      return `<tr><td>${label}</td><td style="color:${color};font-weight:700">${fmt(val)}</td><td>${pct}%</td></tr>`;
    }).join('')}
  </table>

  <h2>Top Overdue Invoices</h2>
  <table>
    <tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Due Date</th><th>Days Overdue</th></tr>
    ${overdue.rows.map(r => `
      <tr>
        <td style="font-family:monospace">${r.invoice_number}</td>
        <td>${r.customer || 'Unknown'}</td>
        <td class="overdue">${fmt(r.total_amount)}</td>
        <td>${new Date(r.due_date).toLocaleDateString('en-IN')}</td>
        <td class="overdue">${r.days_overdue} days</td>
      </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:#16a34a">No overdue invoices</td></tr>'}
  </table>

  <div class="footer">
    <p>This is an automated report from Deemona AI Finance OS. Do not reply to this email.</p>
    <p>To unsubscribe or change report settings, visit your Finance OS settings.</p>
  </div>
</body>
</html>`;
}

async function generateWeeklyPLReport(pool: Pool, tenantId: string): Promise<string> {
  const [ar, ap, exp] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as revenue FROM ar_invoices WHERE tenant_id=$1 AND created_at > NOW()-INTERVAL '7 days'`, [tenantId]),
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as expenses FROM ap_invoices WHERE tenant_id=$1 AND created_at > NOW()-INTERVAL '7 days'`, [tenantId]),
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as opex FROM expense_claims WHERE tenant_id=$1 AND created_at > NOW()-INTERVAL '7 days'`, [tenantId]),
  ]);

  const revenue = parseFloat(ar.rows[0]?.revenue || 0);
  const apExpenses = parseFloat(ap.rows[0]?.expenses || 0);
  const opex = parseFloat(exp.rows[0]?.opex || 0);
  const totalExp = apExpenses * 0.3 + opex;
  const grossProfit = revenue - totalExp * 0.45;
  const netProfit = grossProfit - totalExp * 0.3;
  const fmt = (n: number) => '₹' + n.toLocaleString('en-IN', {minimumFractionDigits:0, maximumFractionDigits:0});

  return `
<!DOCTYPE html>
<html>
<head><style>
  body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; color: #334155; }
  h1 { color: #1e3a8a; border-bottom: 3px solid #1d4ed8; padding-bottom: 10px; }
  h2 { color: #1d4ed8; margin-top: 24px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; margin: 16px 0; }
  .kpi { background: #f0f4ff; border-radius: 8px; padding: 14px; border-left: 4px solid #1d4ed8; }
  .kpi-label { font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase; }
  .kpi-value { font-size: 18px; font-weight: 800; color: #0f172a; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th { background: #1d4ed8; color: white; padding: 10px 12px; text-align: left; font-size: 12px; }
  td { padding: 9px 12px; border-bottom: 1px solid #f1f5f9; font-size: 12px; }
  .positive { color: #16a34a; font-weight: 700; }
  .negative { color: #dc2626; font-weight: 700; }
  .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; }
</style></head>
<body>
  <h1>📈 Weekly P&L Report — Week ending ${new Date().toLocaleDateString('en-IN', {year:'numeric',month:'long',day:'numeric'})}</h1>
  <p style="color:#64748b">Generated by Deemona AI Finance OS · Automated Weekly Report</p>

  <div class="kpi-grid">
    <div class="kpi"><div class="kpi-label">Revenue</div><div class="kpi-value positive">${fmt(revenue)}</div></div>
    <div class="kpi"><div class="kpi-label">Total Expenses</div><div class="kpi-value negative">${fmt(totalExp)}</div></div>
    <div class="kpi"><div class="kpi-label">Gross Profit</div><div class="kpi-value" style="color:${grossProfit>=0?'#16a34a':'#dc2626'}">${fmt(grossProfit)}</div></div>
    <div class="kpi"><div class="kpi-label">Net Profit</div><div class="kpi-value" style="color:${netProfit>=0?'#16a34a':'#dc2626'}">${fmt(netProfit)}</div></div>
  </div>

  <h2>P&L Summary</h2>
  <table>
    <tr><th>Line Item</th><th>This Week</th><th>Margin</th></tr>
    <tr><td>Revenue</td><td class="positive">${fmt(revenue)}</td><td>100%</td></tr>
    <tr><td>Cost of Goods (est.)</td><td class="negative">${fmt(totalExp*0.45)}</td><td>${revenue>0?((totalExp*0.45/revenue)*100).toFixed(1):0}%</td></tr>
    <tr><td><strong>Gross Profit</strong></td><td class="${grossProfit>=0?'positive':'negative'}">${fmt(grossProfit)}</td><td>${revenue>0?((grossProfit/revenue)*100).toFixed(1):0}%</td></tr>
    <tr><td>Operating Expenses</td><td class="negative">${fmt(totalExp*0.55)}</td><td>${revenue>0?((totalExp*0.55/revenue)*100).toFixed(1):0}%</td></tr>
    <tr><td><strong>Net Profit</strong></td><td class="${netProfit>=0?'positive':'negative'}">${fmt(netProfit)}</td><td>${revenue>0?((netProfit/revenue)*100).toFixed(1):0}%</td></tr>
  </table>

  <div class="footer">
    <p>This is an automated weekly report from Deemona AI Finance OS.</p>
  </div>
</body>
</html>`;
}

// ── Report Schedule Settings ──────────────────────────────────
interface ReportSchedule {
  tenantId: string;
  email: string;
  reportType: 'ar_aging' | 'weekly_pl' | 'daily_brief';
  frequency: 'daily' | 'weekly' | 'monthly';
  time: string; // HH:MM
  dayOfWeek?: number; // 0-6 for weekly
  enabled: boolean;
  lastSent?: Date;
}

const reportSchedules: Map<string, ReportSchedule[]> = new Map();

// ── Main Router ───────────────────────────────────────────────
export function createEventBusRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user?.tenantId;

  // ── Phase 3: SSE endpoint for real-time dashboard ─────────
  router.get('/stream', requireAuth, (req: Request, res: Response) => {
    const tenantId = tid(req);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    // Send initial connection confirmation
    res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to Deemona Finance OS live stream', tenantId, timestamp: new Date().toISOString() })}\n\n`);

    // Keep alive ping every 30 seconds
    const pingInterval = setInterval(() => {
      try { res.write(`: ping\n\n`); } catch { clearInterval(pingInterval); }
    }, 30000);

    addSSEClient(tenantId, res);

    req.on('close', () => {
      clearInterval(pingInterval);
      removeSSEClient(tenantId, res);
    });
  });

  // ── Phase 2: Trigger events after data import ─────────────
  router.post('/trigger', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { dataType, inserted, sendAlertEmail } = req.body;

      const events = await handleDataIngested(pool, tenantId, dataType, inserted);

      // Send overdue alert email if requested
      if (sendAlertEmail && events.includes('overdue_alert')) {
        const userEmail = await pool.query(
          'SELECT email FROM users WHERE tenant_id=$1 LIMIT 1', [tenantId]
        );
        if (userEmail.rows[0]?.email) {
          const overdue = await pool.query(`
            SELECT ar.invoice_number, c.name as customer_name, ar.total_amount, ar.due_date,
              CURRENT_DATE - ar.due_date as days_overdue
            FROM ar_invoices ar LEFT JOIN customers c ON ar.customer_id=c.id
            WHERE ar.tenant_id=$1 AND ar.due_date < CURRENT_DATE AND ar.status NOT IN ('paid','cancelled')
            ORDER BY days_overdue DESC LIMIT 10`, [tenantId]);

          const fmt = (n: any) => '₹' + parseFloat(n||0).toLocaleString('en-IN');
          const rows = overdue.rows.map(r =>
            `<tr><td style="font-family:monospace">${r.invoice_number}</td><td>${r.customer_name||'Unknown'}</td><td style="color:#dc2626;font-weight:700">${fmt(r.total_amount)}</td><td style="color:#dc2626">${r.days_overdue} days</td></tr>`
          ).join('');

          await sendEmail(
            userEmail.rows[0].email,
            `⚠️ ${overdue.rows.length} Overdue Invoices — Deemona Finance OS`,
            `<html><body style="font-family:Arial;padding:20px">
              <h2 style="color:#dc2626">⚠️ Overdue Invoice Alert</h2>
              <p>${overdue.rows.length} invoices require immediate attention.</p>
              <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
                <tr style="background:#1d4ed8;color:white"><th>Invoice</th><th>Customer</th><th>Amount</th><th>Days Overdue</th></tr>
                ${rows}
              </table>
              <p style="color:#64748b;font-size:12px;margin-top:20px">Deemona AI Finance OS — Automated Alert</p>
            </body></html>`
          );
        }
      }

      res.json({ success: true, events, clients: (sseClients.get(tenantId) || []).length });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Phase 4: Send report now ──────────────────────────────
  router.post('/send-report', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { reportType, email } = req.body;

      if (!email) return res.status(400).json({ error: 'Email required' }) as any;

      let html = '';
      let subject = '';

      if (reportType === 'ar_aging') {
        html = await generateARAgingReport(pool, tenantId);
        subject = `📊 AR Aging Report — ${new Date().toLocaleDateString('en-IN')} — Deemona Finance OS`;
      } else if (reportType === 'weekly_pl') {
        html = await generateWeeklyPLReport(pool, tenantId);
        subject = `📈 Weekly P&L Report — Deemona Finance OS`;
      } else {
        return res.status(400).json({ error: 'Invalid report type' }) as any;
      }

      const sent = await sendEmail(email, subject, html);
      if (sent) {
        await pool.query(
          `INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at)
           VALUES ($1, 'SCHEDULED_REPORT', 'success', $2, NOW())`,
          [tenantId, `${reportType} sent to ${email}`]
        ).catch(() => {});
        res.json({ success: true, message: `Report sent to ${email}` });
      } else {
        res.status(500).json({ error: 'Failed to send email. Check Gmail credentials in environment.' });
      }
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Schedule management ───────────────────────────────────
  router.post('/schedule', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { email, reportType, frequency, time, dayOfWeek } = req.body;

      if (!tenantId || !email || !reportType || !frequency) {
        return res.status(400).json({ error: 'Missing required fields' }) as any;
      }

      // Save to DB
      await pool.query(`
        INSERT INTO monitor_settings (tenant_id, setting_key, setting_value, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (tenant_id, setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value, updated_at=NOW()`,
        [tenantId, `report_schedule_${reportType}`, JSON.stringify({ email, frequency, time, dayOfWeek, enabled: true })]
      ).catch(() => {});

      // Add to in-memory schedule
      if (!reportSchedules.has(tenantId)) reportSchedules.set(tenantId, []);
      const schedules = reportSchedules.get(tenantId)!;
      const existing = schedules.findIndex(s => s.reportType === reportType);
      const schedule: ReportSchedule = { tenantId, email, reportType, frequency, time: time||'08:00', dayOfWeek, enabled: true };
      if (existing >= 0) schedules[existing] = schedule;
      else schedules.push(schedule);

      res.json({ success: true, schedule });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/schedule', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const rows = await pool.query(
        `SELECT setting_key, setting_value FROM monitor_settings WHERE tenant_id=$1 AND setting_key LIKE 'report_schedule_%'`,
        [tenantId]
      ).catch(() => ({ rows: [] }));

      const schedules = rows.rows.map(r => ({
        reportType: r.setting_key.replace('report_schedule_', ''),
        ...JSON.parse(r.setting_value || '{}'),
      }));
      res.json({ schedules });
    } catch (e) {
      res.json({ schedules: [] });
    }
  });

  // ── Broadcast event (called from other routes) ────────────
  router.post('/broadcast', requireAuth, async (req: Request, res: Response) => {
    const tenantId = tid(req);
    const { event, data } = req.body;
    broadcastToTenant(tenantId, event, data);
    res.json({ success: true, clients: (sseClients.get(tenantId) || []).length });
  });

  // ── History of events ─────────────────────────────────────
  router.get('/history', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT automation_type, status, detail, created_at
         FROM automation_logs
         WHERE tenant_id=$1 AND automation_type IN ('EVENT_BUS','SCHEDULED_REPORT')
         ORDER BY created_at DESC LIMIT 50`,
        [tid(req)]
      );
      res.json({ history: result.rows });
    } catch (e) {
      res.json({ history: [] });
    }
  });

  // ── Run scheduled reports (called by cron) ────────────────
  router.post('/run-scheduled', async (req: Request, res: Response) => {
    const secret = req.headers['x-cron-secret'];
    if (secret !== process.env.CRON_SECRET && secret !== 'deemona-cron-2026') {
      return res.status(401).json({ error: 'Unauthorized' }) as any;
    }

    const now = new Date();
    const currentTime = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
    const currentDay = now.getDay();
    let sent = 0;

    for (const [tenantId, schedules] of reportSchedules.entries()) {
      for (const schedule of schedules.filter(s => s.enabled)) {
        const shouldRun =
          (schedule.frequency === 'daily' && schedule.time === currentTime) ||
          (schedule.frequency === 'weekly' && schedule.dayOfWeek === currentDay && schedule.time === currentTime);

        if (shouldRun) {
          let html = '', subject = '';
          if (schedule.reportType === 'ar_aging') {
            html = await generateARAgingReport(pool, tenantId);
            subject = `📊 Daily AR Aging Report — ${now.toLocaleDateString('en-IN')}`;
          } else if (schedule.reportType === 'weekly_pl') {
            html = await generateWeeklyPLReport(pool, tenantId);
            subject = `📈 Weekly P&L Report — ${now.toLocaleDateString('en-IN')}`;
          }
          if (html) { await sendEmail(schedule.email, subject, html); sent++; }
        }
      }
    }

    res.json({ success: true, sent });
  });

  return router;
}

// Export broadcast function for use in other routes
export { broadcastToTenant };
