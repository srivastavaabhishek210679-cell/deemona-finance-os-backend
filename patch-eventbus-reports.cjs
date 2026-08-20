const fs = require('fs');

// Patch eventBusRoutes.ts to use reportEngine
const f = 'C:/deemona-finance-os/backend/src/routes/eventBusRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

// Add reportEngine import after existing imports
if (!c.includes('reportEngine')) {
  c = c.replace(
    "import { Resend } from 'resend';",
    "import { Resend } from 'resend';\nimport { REPORT_REGISTRY, reportOverdueAlert, reportCreditBreach, reportImportSummary } from './reportEngine';"
  );
  console.log('Import added');
}

// Replace the send-report endpoint to use reportEngine
const oldEndpoint = `  // ── Phase 4: Send report now ──────────────────────────────
  router.post('/send-report', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { reportType, email } = req.body;

      if (!email) return res.status(400).json({ error: 'Email required' }) as any;

      let html = '';
      let subject = '';

      if (reportType === 'ar_aging') {
        html = await generateARAgingReport(pool, tenantId);
        subject = \`📊 AR Aging Report — \${new Date().toLocaleDateString('en-IN')} — Deemona Finance OS\`;
      } else if (reportType === 'weekly_pl') {
        html = await generateWeeklyPLReport(pool, tenantId);
        subject = \`📈 Weekly P&L Report — Deemona Finance OS\`;
      } else {
        return res.status(400).json({ error: 'Invalid report type' }) as any;
      }

      const sent = await sendEmail(email, subject, html);
      if (sent) {
        await pool.query(
          \`INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at)
           VALUES ($1, 'SCHEDULED_REPORT', 'success', $2, NOW())\`,
          [tenantId, \`\${reportType} sent to \${email}\`]
        ).catch(() => {});
        res.json({ success: true, message: \`Report sent to \${email}\` });
      } else {
        res.status(500).json({ error: 'Failed to send email. Check Gmail credentials in environment.' });
      }
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });`;

const newEndpoint = `  // ── Phase 4: Send report now (all 14 reports) ───────────
  router.post('/send-report', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { reportType, email, threshold } = req.body;
      if (!email) return res.status(400).json({ error: 'Email required' }) as any;
      const registry = REPORT_REGISTRY[reportType];
      if (!registry) return res.status(400).json({ error: \`Unknown report type: \${reportType}. Available: \${Object.keys(REPORT_REGISTRY).join(', ')}\` }) as any;
      const { subject, html } = await registry.fn(pool, tenantId, threshold);
      const sent = await sendEmail(email, subject, html);
      if (sent) {
        await pool.query(
          \`INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at) VALUES ($1, 'SCHEDULED_REPORT', 'success', $2, NOW())\`,
          [tenantId, \`\${registry.label} sent to \${email}\`]
        ).catch(() => {});
        res.json({ success: true, message: \`\${registry.label} sent to \${email}\` });
      } else {
        res.status(500).json({ error: 'Failed to send email. Check RESEND_API_KEY in Render environment.' });
      }
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });`;

if (c.includes('Phase 4: Send report now')) {
  c = c.replace(oldEndpoint, newEndpoint);
  console.log('Send-report endpoint replaced');
} else {
  console.log('Could not find old endpoint - manual fix needed');
}

fs.writeFileSync(f, c, 'utf8');
console.log('Done. Size:', fs.statSync(f).size);
