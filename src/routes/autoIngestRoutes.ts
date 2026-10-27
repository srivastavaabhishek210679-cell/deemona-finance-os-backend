// ============================================================
// Deemona AI Finance OS — Auto-Ingest Engine
// File: src/routes/autoIngestRoutes.ts
// Channels:
//   1. Webhook API — external systems push data
//   2. Scheduled URL/Google Sheets sync
//   3. Email attachment monitoring (Gmail)
//   4. WhatsApp file ingest (via Twilio)
// ============================================================

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Shared: call internal ingest API ─────────────────────────
async function ingestData(pool: Pool, tenantId: string, data: string, format: string, sourceName: string, sourceType: string): Promise<{inserted:number,updated:number,errors:number,dataType:string}> {
  try {
    const backendUrl = process.env.BACKEND_URL || 'https://deemona-finance-os-api.onrender.com';
    const authToken = await pool.query('SELECT id FROM users WHERE tenant_id=$1 LIMIT 1', [tenantId]).then(r => r.rows[0]?.id).catch(()=>null);
    const resp = await fetch(backendUrl + '/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer internal-' + process.env.CRON_SECRET + '.' + tenantId },
      body: JSON.stringify({ data, format, tenantId }),
    });
    const result = await resp.json() as any;
    const outcome = { inserted: result.inserted||0, updated: result.updated||0, errors: result.errors||0, dataType: result.dataType||'UNKNOWN' };

    // Log the ingest
    await pool.query(
      `INSERT INTO ingest_logs (tenant_id, source_type, source_name, records_inserted, data_type, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [tenantId, sourceType, sourceName, outcome.inserted, outcome.dataType, outcome.errors===0?'success':'partial']
    ).catch(()=>{});

    return outcome;
  } catch(e) {
    await pool.query(
      `INSERT INTO ingest_logs (tenant_id, source_type, source_name, status, error_message, created_at)
       VALUES ($1, $2, $3, 'error', $4, NOW())`,
      [tenantId, sourceType, sourceName, String(e)]
    ).catch(()=>{});
    throw e;
  }
}

// ── Shared: send notification email ──────────────────────────
async function sendIngestNotification(tenantId: string, pool: Pool, result: any, source: string) {
  try {
    const user = await pool.query('SELECT email FROM users WHERE tenant_id=$1 LIMIT 1', [tenantId]);
    const email = user.rows[0]?.email;
    if (!email) return;
    await resend.emails.send({
      from: 'Deemona Auto-Ingest <onboarding@resend.dev>',
      to: email,
      subject: `✅ Auto-Import Complete: ${result.inserted} records from ${source}`,
      html: `<html><body style="font-family:Arial;padding:20px;max-width:600px">
        <h2 style="color:#1d4ed8">✅ Auto-Import Successful</h2>
        <p><strong>Source:</strong> ${source}</p>
        <p><strong>Data Type:</strong> ${result.dataType}</p>
        <p><strong>Records Imported:</strong> ${result.inserted}</p>
        <p><strong>Errors:</strong> ${result.errors}</p>
        <p><strong>Time:</strong> ${new Date().toLocaleString('en-IN')}</p>
        <p style="color:#64748b;font-size:12px">Deemona AI Finance OS — Automated Data Ingestion</p>
      </body></html>`
    });
  } catch(e) { console.error('[AutoIngest] Notification error:', e); }
}

// ── Run scheduled fetches (called by cron) ───────────────────
export async function runScheduledIngests(pool: Pool): Promise<{ran:number,success:number}> {
  let ran=0, success=0;
  try {
    const now = new Date();
    const currentTime = now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
    const currentDay = now.getDay();

    const schedules = await pool.query(
      `SELECT * FROM ingest_schedules WHERE enabled=true`
    ).catch(()=>({rows:[]}));

    for (const sched of schedules.rows) {
      try {
        const shouldRun =
          sched.frequency==='hourly' ||
          (sched.frequency==='daily' && sched.time===currentTime) ||
          (sched.frequency==='weekly' && parseInt(sched.day_of_week)===currentDay && sched.time===currentTime);

        if (!shouldRun) continue;
        ran++;

        let data='', format=sched.format||'csv';

        if (sched.source_type==='google_sheets' || sched.source_url?.includes('docs.google.com')) {
          // Fetch Google Sheet as CSV
          const idMatch = sched.source_url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
          const sheetId = idMatch?.[1] || sched.source_url;
          const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
          const resp = await fetch(csvUrl);
          if (!resp.ok) throw new Error(`Sheet fetch failed: ${resp.status}`);
          data = await resp.text();
          format = 'csv';
        } else if (sched.source_type==='url') {
          // Fetch any URL
          const resp = await fetch(sched.source_url);
          if (!resp.ok) throw new Error(`URL fetch failed: ${resp.status}`);
          const ct = resp.headers.get('content-type')||'';
          if (ct.includes('json')) format='json';
          else if (ct.includes('xml')) format='xml';
          else format='csv';
          data = await resp.text();
        }

        if (!data) continue;

        const result = await ingestData(pool, sched.tenant_id, data, format, sched.name, 'schedule');
        success++;

        // Update last run
        await pool.query(
          `UPDATE ingest_schedules SET last_run_at=NOW(), last_status='success', total_runs=total_runs+1 WHERE id=$1`,
          [sched.id]
        ).catch(()=>{});

        if (result.inserted > 0) await sendIngestNotification(sched.tenant_id, pool, result, sched.name);
        console.log(`[AutoIngest] Schedule "${sched.name}": ${result.inserted} records`);
      } catch(e) {
        console.error(`[AutoIngest] Schedule error for ${sched.name}:`, e);
        await pool.query(
          `UPDATE ingest_schedules SET last_run_at=NOW(), last_status='error', total_runs=total_runs+1 WHERE id=$1`,
          [sched.id]
        ).catch(()=>{});
      }
    }
  } catch(e) { console.error('[AutoIngest] Fatal schedule error:', e); }
  return { ran, success };
}

// ── Gmail Attachment Monitor ──────────────────────────────────
export async function runEmailIngest(pool: Pool): Promise<{checked:number,processed:number}> {
  // Gmail API requires OAuth - this polls Gmail via API
  // Falls back to checking Resend inbound if configured
  let checked=0, processed=0;
  try {
    const rules = await pool.query(`SELECT * FROM ingest_email_rules WHERE enabled=true`).catch(()=>({rows:[]}));
    checked = rules.rows.length;

    // For each rule, check Gmail API
    const gmailToken = process.env.GMAIL_ACCESS_TOKEN;
    if (!gmailToken) {
      console.log('[EmailIngest] No GMAIL_ACCESS_TOKEN - skipping email check');
      return { checked, processed };
    }

    for (const rule of rules.rows) {
      try {
        // Search Gmail for matching emails with attachments
        const q = encodeURIComponent(`has:attachment${rule.from_email?' from:'+rule.from_email:''}${rule.subject_contains?' subject:'+rule.subject_contains:''} is:unread`);
        const listResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=10`, {
          headers: { Authorization: `Bearer ${gmailToken}` }
        });
        if (!listResp.ok) continue;
        const list = await listResp.json() as any;
        const messages = list.messages || [];

        for (const msg of messages) {
          // Get message details
          const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
            headers: { Authorization: `Bearer ${gmailToken}` }
          });
          if (!msgResp.ok) continue;
          const msgData = await msgResp.json() as any;

          // Find attachments
          const parts = msgData.payload?.parts || [];
          for (const part of parts) {
            if (!part.filename || !part.body?.attachmentId) continue;
            const ext = part.filename.split('.').pop()?.toLowerCase();
            if (!['csv','xlsx','xls','xml','json','pdf'].includes(ext||'')) continue;

            // Download attachment
            const attResp = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}/attachments/${part.body.attachmentId}`,
              { headers: { Authorization: `Bearer ${gmailToken}` } }
            );
            if (!attResp.ok) continue;
            const attData = await attResp.json() as any;
            const base64Data = attData.data?.replace(/-/g,'+').replace(/_/g,'/') || '';

            const isBinary = ['xlsx','xls','pdf'].includes(ext||'');
            const data = isBinary ? base64Data : Buffer.from(base64Data,'base64').toString('utf8');
            const format = ext==='xlsx'||ext==='xls'?'excel':ext||'csv';

            const result = await ingestData(pool, rule.tenant_id, data, format, `Email: ${part.filename}`, 'email');
            processed++;

            // Update rule stats
            await pool.query(
              `UPDATE ingest_email_rules SET total_processed=total_processed+1, last_processed_at=NOW() WHERE id=$1`,
              [rule.id]
            ).catch(()=>{});

            // Mark email as read
            await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}/modify`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${gmailToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
            }).catch(()=>{});

            if (result.inserted>0) await sendIngestNotification(rule.tenant_id, pool, result, `Email attachment: ${part.filename}`);
          }
        }
      } catch(e) { console.error('[EmailIngest] Rule error:', e); }
    }
  } catch(e) { console.error('[EmailIngest] Fatal error:', e); }
  return { checked, processed };
}

// ── Router ────────────────────────────────────────────────────
export function createAutoIngestRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user?.tenantId;

  // ── WEBHOOK CHANNEL ───────────────────────────────────────

  // Create webhook endpoint
  router.post('/webhooks', requireAuth, async (req: Request, res: Response) => {
    try {
      const { name, data_type, description } = req.body;
      const result = await pool.query(
        `INSERT INTO ingest_webhooks (tenant_id, name, data_type, description)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [tid(req), name, data_type, description]
      );
      const webhook = result.rows[0];
      res.json({
        success: true, webhook,
        webhook_url: `${process.env.FRONTEND_URL?.replace('5173','4001')||'https://deemona-finance-os-api.onrender.com'}/api/auto-ingest/webhook/${webhook.webhook_key}`,
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  router.get('/webhooks', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(`SELECT * FROM ingest_webhooks WHERE tenant_id=$1 ORDER BY created_at DESC`, [tid(req)]).catch(()=>({rows:[]}));
    const baseUrl = `https://deemona-finance-os-api.onrender.com`;
    res.json({ webhooks: result.rows.map(w=>({...w, webhook_url:`${baseUrl}/api/auto-ingest/webhook/${w.webhook_key}`})) });
  });

  router.delete('/webhooks/:id', requireAuth, async (req: Request, res: Response) => {
    await pool.query(`DELETE FROM ingest_webhooks WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]).catch(()=>{});
    res.json({ success: true });
  });

  // Public webhook receiver (no auth - uses webhook_key)
  router.post('/webhook/:key', async (req: Request, res: Response) => {
    try {
      const { key } = req.params;
      const webhook = await pool.query(`SELECT * FROM ingest_webhooks WHERE webhook_key=$1 AND enabled=true`, [key]);
      if (!webhook.rows[0]) return res.status(404).json({ error: 'Webhook not found or disabled' }) as any;

      const w = webhook.rows[0];
      const body = req.body;

      // Detect format from content-type or body shape
      let data='', format='json';
      const ct = req.headers['content-type']||'';
      if (ct.includes('text/csv')) { data=String(body); format='csv'; }
      else if (ct.includes('application/xml')) { data=String(body); format='xml'; }
      else if (typeof body==='string') { data=body; format='csv'; }
      else { data=JSON.stringify(Array.isArray(body)?body:[body]); format='json'; }

      const result = await ingestData(pool, w.tenant_id, data, format, w.name, 'webhook');

      // Update call count
      await pool.query(`UPDATE ingest_webhooks SET total_calls=total_calls+1, last_called_at=NOW() WHERE id=$1`, [w.id]).catch(()=>{});

      if (result.inserted>0) await sendIngestNotification(w.tenant_id, pool, result, `Webhook: ${w.name}`);

      res.json({ success:true, inserted:result.inserted, dataType:result.dataType });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ── SCHEDULED URL CHANNEL ─────────────────────────────────

  router.get('/schedules', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(`SELECT * FROM ingest_schedules WHERE tenant_id=$1 ORDER BY created_at DESC`, [tid(req)]).catch(()=>({rows:[]}));
    res.json({ schedules: result.rows });
  });

  router.post('/schedules', requireAuth, async (req: Request, res: Response) => {
    try {
      const { name, source_type, source_url, format, data_type, frequency, time, day_of_week } = req.body;
      const result = await pool.query(
        `INSERT INTO ingest_schedules (tenant_id, name, source_type, source_url, format, data_type, frequency, time, day_of_week)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [tid(req), name, source_type||'url', source_url, format||'csv', data_type, frequency||'daily', time||'08:00', day_of_week]
      );
      res.json({ success: true, schedule: result.rows[0] });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  router.put('/schedules/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { name, source_url, format, frequency, time, day_of_week, enabled } = req.body;
      const result = await pool.query(
        `UPDATE ingest_schedules SET name=$1, source_url=$2, format=$3, frequency=$4, time=$5, day_of_week=$6, enabled=$7, updated_at=NOW()
         WHERE id=$8 AND tenant_id=$9 RETURNING *`,
        [name, source_url, format, frequency, time, day_of_week, enabled, req.params.id, tid(req)]
      );
      res.json({ success: true, schedule: result.rows[0] });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  router.delete('/schedules/:id', requireAuth, async (req: Request, res: Response) => {
    await pool.query(`DELETE FROM ingest_schedules WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]).catch(()=>{});
    res.json({ success: true });
  });

  // Run a schedule immediately
  router.post('/schedules/:id/run', requireAuth, async (req: Request, res: Response) => {
    try {
      const sched = await pool.query(`SELECT * FROM ingest_schedules WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]);
      if (!sched.rows[0]) return res.status(404).json({ error: 'Schedule not found' }) as any;
      const s = sched.rows[0];
      let data='', format=s.format||'csv';

      if (s.source_url?.includes('docs.google.com')) {
        const idMatch = s.source_url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
        const sheetId = idMatch?.[1] || s.source_url;
        const resp = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`);
        data = await resp.text(); format='csv';
      } else {
        const resp = await fetch(s.source_url);
        data = await resp.text();
      }

      const result = await ingestData(pool, s.tenant_id, data, format, s.name, 'schedule');
      await pool.query(`UPDATE ingest_schedules SET last_run_at=NOW(), last_status='success', total_runs=total_runs+1 WHERE id=$1`, [s.id]).catch(()=>{});
      res.json({ success: true, ...result });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ── EMAIL RULES CHANNEL ───────────────────────────────────

  router.get('/email-rules', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(`SELECT * FROM ingest_email_rules WHERE tenant_id=$1 ORDER BY created_at DESC`, [tid(req)]).catch(()=>({rows:[]}));
    res.json({ rules: result.rows });
  });

  router.post('/email-rules', requireAuth, async (req: Request, res: Response) => {
    try {
      const { name, from_email, subject_contains, data_type } = req.body;
      const result = await pool.query(
        `INSERT INTO ingest_email_rules (tenant_id, name, from_email, subject_contains, data_type) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [tid(req), name, from_email, subject_contains, data_type]
      );
      res.json({ success: true, rule: result.rows[0] });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  router.delete('/email-rules/:id', requireAuth, async (req: Request, res: Response) => {
    await pool.query(`DELETE FROM ingest_email_rules WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]).catch(()=>{});
    res.json({ success: true });
  });

  // ── ACTIVITY LOGS ─────────────────────────────────────────

  router.get('/logs', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(
      `SELECT * FROM ingest_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [tid(req)]
    ).catch(()=>({rows:[]}));
    res.json({ logs: result.rows });
  });

  // ── STATS ─────────────────────────────────────────────────

  router.get('/stats', requireAuth, async (req: Request, res: Response) => {
    const [webhooks, schedules, emailRules, logs] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, SUM(total_calls) as calls FROM ingest_webhooks WHERE tenant_id=$1`, [tid(req)]).catch(()=>({rows:[{total:0,calls:0}]})),
      pool.query(`SELECT COUNT(*) as total, SUM(total_runs) as runs FROM ingest_schedules WHERE tenant_id=$1`, [tid(req)]).catch(()=>({rows:[{total:0,runs:0}]})),
      pool.query(`SELECT COUNT(*) as total, SUM(total_processed) as processed FROM ingest_email_rules WHERE tenant_id=$1`, [tid(req)]).catch(()=>({rows:[{total:0,processed:0}]})),
      pool.query(`SELECT COUNT(*) as total, COALESCE(SUM(records_inserted),0) as records FROM ingest_logs WHERE tenant_id=$1 AND created_at>NOW()-INTERVAL '30 days'`, [tid(req)]).catch(()=>({rows:[{total:0,records:0}]})),
    ]);
    res.json({
      webhooks: { count: webhooks.rows[0]?.total||0, calls: webhooks.rows[0]?.calls||0 },
      schedules: { count: schedules.rows[0]?.total||0, runs: schedules.rows[0]?.runs||0 },
      emailRules: { count: emailRules.rows[0]?.total||0, processed: emailRules.rows[0]?.processed||0 },
      recentActivity: { logs: logs.rows[0]?.total||0, records: logs.rows[0]?.records||0 },
    });
  });

  // ── CRON trigger (internal) ───────────────────────────────
  router.post('/run-scheduled', async (req: Request, res: Response) => {
    const secret = req.headers['x-cron-secret'];
    if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' }) as any;
    }
    const [schedResult, emailResult] = await Promise.all([
      runScheduledIngests(pool),
      runEmailIngest(pool),
    ]);
    res.json({ success: true, schedules: schedResult, email: emailResult });
  });


// ── Slack & Teams Message Ingest ─────────────────────────────
// POST /api/auto-ingest/slack/webhook  — Slack Events API
// POST /api/auto-ingest/teams/webhook — MS Teams Outgoing Webhook

router.post('/slack/webhook', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    // Slack URL verification challenge
    if (body.type === 'url_verification') {
      return res.json({ challenge: body.challenge }) as any;
    }
    if (body.type === 'event_callback') {
      const event = body.event;
      const tenantId = req.headers['x-tenant-id'] as string || tid(req);
      if (event.type === 'message' && event.text && !event.bot_id) {
        // Parse financial keywords from Slack message
        const text = event.text.toLowerCase();
        const isFinancial = /invoice|payment|expense|budget|revenue|gst|tds|purchase|vendor|client|amount|rupee|rs\.?|inr|₹/.test(text);
        if (isFinancial) {
          await pool.query(
            `INSERT INTO ingest_logs (tenant_id, channel, source_ref, status, record_count, message, created_at)
             VALUES ($1, 'slack', $2, 'processed', 1, $3, NOW())`,
            [tenantId, event.channel, `Slack financial mention: ${event.text.substring(0,200)}`]
          ).catch(() => {});
          // Store as a note/alert
          await pool.query(
            `INSERT INTO ai_insights (tenant_id, insight_type, title, description, priority, created_at)
             VALUES ($1, 'slack_alert', 'Slack Financial Mention', $2, 'medium', NOW())`,
            [tenantId, `Channel: ${event.channel} | User: ${event.user} | Message: ${event.text.substring(0,300)}`]
          ).catch(() => {});
        }
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

router.post('/teams/webhook', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const tenantId = req.headers['x-tenant-id'] as string || tid(req);
    // MS Teams Outgoing Webhook format
    const text = body.text || body.value?.body?.content || '';
    if (text) {
      const isFinancial = /invoice|payment|expense|budget|revenue|gst|tds|purchase|vendor|amount|rupee|inr|₹/.test(text.toLowerCase());
      if (isFinancial) {
        await pool.query(
          `INSERT INTO ingest_logs (tenant_id, channel, source_ref, status, record_count, message, created_at)
           VALUES ($1, 'teams', $2, 'processed', 1, $3, NOW())`,
          [tenantId, body.channelId||'teams', `Teams financial mention: ${text.substring(0,200)}`]
        ).catch(() => {});
        await pool.query(
          `INSERT INTO ai_insights (tenant_id, insight_type, title, description, priority, created_at)
           VALUES ($1, 'teams_alert', 'Teams Financial Mention', $2, 'medium', NOW())`,
          [tenantId, `Channel: ${body.channelId} | From: ${body.from?.name||'Unknown'} | Message: ${text.substring(0,300)}`]
        ).catch(() => {});
      }
    }
    // Teams requires a specific response format
    res.json({ type: 'message', text: '👍 Received.' });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/auto-ingest/slack/config — setup instructions
router.get('/slack/config', requireAuth, async (req: Request, res: Response) => {
  res.json({
    webhook_url: `${process.env.BACKEND_URL}/api/auto-ingest/slack/webhook`,
    setup_steps: [
      '1. Go to api.slack.com/apps → Create New App',
      '2. Enable Event Subscriptions',
      '3. Set Request URL to the webhook_url above',
      '4. Subscribe to bot events: message.channels, message.groups',
      '5. Add header X-Tenant-ID: your-tenant-id to outgoing requests',
      '6. Install app to workspace',
    ],
    events_monitored: ['message.channels','message.groups'],
    keywords_detected: ['invoice','payment','expense','budget','revenue','gst','tds','purchase','vendor'],
  });
});

router.get('/teams/config', requireAuth, async (req: Request, res: Response) => {
  res.json({
    webhook_url: `${process.env.BACKEND_URL}/api/auto-ingest/teams/webhook`,
    setup_steps: [
      '1. Go to MS Teams → Apps → Manage your apps',
      '2. Create an Outgoing Webhook',
      '3. Set Callback URL to the webhook_url above',
      '4. Copy the security token provided',
      '5. Add the webhook to desired channels',
      '6. Messages with financial keywords will be auto-captured',
    ],
    events_monitored: ['channel_messages'],
    keywords_detected: ['invoice','payment','expense','budget','revenue','gst','tds','purchase','vendor'],
  });
});

  return router;
}
