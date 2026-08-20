const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/index.ts';
let c = fs.readFileSync(f, 'utf8');

// Add cron import at top if not present
if (!c.includes('node-cron')) {
  c = c.replace(
    "import express from 'express';",
    "import express from 'express';\nimport cron from 'node-cron';"
  );
}

// Add scheduler after server start
const cronCode = `
// ── Automated Report Scheduler (runs every minute) ──────────
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const hh = now.getHours().toString().padStart(2,'0');
    const mm = now.getMinutes().toString().padStart(2,'0');
    const currentTime = hh + ':' + mm;
    const currentDay = now.getDay();
    const currentDate = now.getDate();

    // Fetch all schedules from DB
    const result = await pool.query(
      "SELECT tenant_id, setting_key, setting_value FROM monitor_settings WHERE setting_key LIKE 'report_schedule_%'"
    ).catch(() => ({ rows: [] }));

    for (const row of result.rows) {
      try {
        const sched = JSON.parse(row.setting_value || '{}');
        if (!sched.enabled || !sched.email || !sched.time) continue;
        if (sched.time !== currentTime) continue;

        const reportType = row.setting_key.replace('report_schedule_', '');
        const freq = sched.frequency;
        const shouldRun =
          freq === 'daily' ||
          (freq === 'weekly' && parseInt(sched.dayOfWeek ?? 1) === currentDay) ||
          (freq === 'monthly' && currentDate === 1);

        if (!shouldRun) continue;

        // Dynamically import reportEngine
        const { REPORT_REGISTRY } = await import('./routes/reportEngine');
        const registry = REPORT_REGISTRY[reportType];
        if (!registry) continue;

        const { subject, html } = await registry.fn(pool, row.tenant_id, sched.threshold || 100000);

        // Send via Resend
        const { Resend } = await import('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        const { error } = await resend.emails.send({
          from: 'Deemona Finance OS <onboarding@resend.dev>',
          to: sched.email,
          subject,
          html,
        });

        if (!error) {
          await pool.query(
            "INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at) VALUES ($1, $2, $3, $4, NOW())",
            [row.tenant_id, 'SCHEDULED_REPORT', 'success', registry.label + ' auto-sent to ' + sched.email]
          ).catch(() => {});
          console.log('[Cron] Sent:', registry.label, 'to', sched.email);
        } else {
          console.error('[Cron] Email error:', error);
        }
      } catch (e) {
        console.error('[Cron] Schedule error:', e);
      }
    }
  } catch (e) {
    console.error('[Cron] Fatal error:', e);
  }
});
console.log('[Cron] Report scheduler started - checks every minute');
`;

// Add before the last closing lines
c = c.replace(
  "}).catch(err => {\n  console.error('[Server] Failed to start:', err.message);\n  process.exit(1);\n});",
  "}).catch(err => {\n  console.error('[Server] Failed to start:', err.message);\n  process.exit(1);\n});\n" + cronCode
);

fs.writeFileSync(f, c, 'utf8');
console.log('Done. Has cron:', c.includes('node-cron'));
console.log('Has scheduler:', c.includes('report_schedule_'));
