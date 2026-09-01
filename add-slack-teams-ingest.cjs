const fs = require('fs');
const path = require('path');

// Backend route for Slack & Teams message ingest
const slackTeamsRoute = `
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
        const isFinancial = /invoice|payment|expense|budget|revenue|gst|tds|purchase|vendor|client|amount|rupee|rs\\.?|inr|₹/.test(text);
        if (isFinancial) {
          await pool.query(
            \`INSERT INTO ingest_logs (tenant_id, channel, source_ref, status, record_count, message, created_at)
             VALUES ($1, 'slack', $2, 'processed', 1, $3, NOW())\`,
            [tenantId, event.channel, \`Slack financial mention: \${event.text.substring(0,200)}\`]
          ).catch(() => {});
          // Store as a note/alert
          await pool.query(
            \`INSERT INTO ai_insights (tenant_id, insight_type, title, description, priority, created_at)
             VALUES ($1, 'slack_alert', 'Slack Financial Mention', $2, 'medium', NOW())\`,
            [tenantId, \`Channel: \${event.channel} | User: \${event.user} | Message: \${event.text.substring(0,300)}\`]
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
          \`INSERT INTO ingest_logs (tenant_id, channel, source_ref, status, record_count, message, created_at)
           VALUES ($1, 'teams', $2, 'processed', 1, $3, NOW())\`,
          [tenantId, body.channelId||'teams', \`Teams financial mention: \${text.substring(0,200)}\`]
        ).catch(() => {});
        await pool.query(
          \`INSERT INTO ai_insights (tenant_id, insight_type, title, description, priority, created_at)
           VALUES ($1, 'teams_alert', 'Teams Financial Mention', $2, 'medium', NOW())\`,
          [tenantId, \`Channel: \${body.channelId} | From: \${body.from?.name||'Unknown'} | Message: \${text.substring(0,300)}\`]
        ).catch(() => {});
      }
    }
    // Teams requires a specific response format
    res.json({ type: 'message', text: isFinancial ? '✅ Financial data captured.' : '👍 Received.' });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/auto-ingest/slack/config — setup instructions
router.get('/slack/config', requireAuth, async (req: Request, res: Response) => {
  res.json({
    webhook_url: \`\${process.env.BACKEND_URL}/api/auto-ingest/slack/webhook\`,
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
    webhook_url: \`\${process.env.BACKEND_URL}/api/auto-ingest/teams/webhook\`,
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
`;

// Add to autoIngestRoutes.ts
const routeFile = 'C:/deemona-finance-os/backend/src/routes/autoIngestRoutes.ts';
let r = fs.readFileSync(routeFile, 'utf8');
if (!r.includes('slack/webhook')) {
  // Add before the return router line
  r = r.replace('  return router;', slackTeamsRoute + '\n  return router;');
  fs.writeFileSync(routeFile, r, 'utf8');
  console.log('Slack & Teams routes added to autoIngestRoutes.ts');
} else {
  console.log('Already exists');
}
