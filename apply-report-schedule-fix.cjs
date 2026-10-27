// Run from the backend folder:  node apply-report-schedule-fix.cjs
// Makes "Schedule a report" work: saved in its own table, sent by ONE scheduler, in India time.
const fs = require('fs'), path = require('path');
const root = path.join(process.cwd(), 'src');
function load(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { console.log('MISSING  src/' + rel + ' (run from the backend folder)'); return null; }
  const raw = fs.readFileSync(file, 'utf8'); const crlf = raw.includes('\r\n');
  return { file, crlf, t: crlf ? raw.replace(/\r\n/g, '\n') : raw, changed: false };
}
function save(f) { if (f.changed) fs.writeFileSync(f.file, f.crlf ? f.t.replace(/\n/g, '\r\n') : f.t); }
function step(f, name, label, already, find, replace) {
  if (f.t.includes(already)) { console.log('already  ' + name + ': ' + label); return; }
  const i = f.t.indexOf(find);
  if (i < 0) { console.log('NO MATCH ' + name + ': ' + label); return; }
  f.t = f.t.slice(0, i) + replace + f.t.slice(i + find.length); f.changed = true; console.log('patched  ' + name + ': ' + label);
}

// ── routes/eventBusRoutes.ts ────────────────────────────────────────────────
const eb = load(path.join('routes', 'eventBusRoutes.ts'));
if (eb) {
  const N = 'eventBusRoutes.ts';
  // 1. saving a schedule: validate, store in report_schedules, and report failures instead of hiding them
  if (eb.t.includes('INSERT INTO report_schedules')) console.log('already  ' + N + ': save schedule');
  else {
    const a = eb.t.indexOf('// Save to DB');
    const endMark = ').catch(() => {});';
    const b = a < 0 ? -1 : eb.t.indexOf(endMark, a);
    if (a < 0 || b < 0) console.log('NO MATCH ' + N + ': save schedule');
    else {
      const lineStart = eb.t.lastIndexOf('\n', a) + 1;
      const repl =
        "      // Save to DB (own table; a failure is reported, not hidden)\n" +
        "      const hhmm = String(time || '08:00').match(/^(\\d{1,2}):(\\d{2})$/);\n" +
        "      if (!hhmm || +hhmm[1] > 23 || +hhmm[2] > 59 || !/^[a-z0-9_]{1,60}$/.test(String(reportType)) ||\n" +
        "          !['daily', 'weekly', 'monthly'].includes(frequency) || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(String(email))) {\n" +
        "        return res.status(400).json({ error: 'Check the report type, frequency (daily/weekly/monthly), time (HH:MM) and email.' }) as any;\n" +
        "      }\n" +
        "      const timeNorm = hhmm[1].padStart(2, '0') + ':' + hhmm[2];\n" +
        "      await ensureReportSchedulesTable(pool);\n" +
        "      await pool.query(\n" +
        "        `INSERT INTO report_schedules (tenant_id, report_type, config, updated_at) VALUES ($1,$2,$3,NOW())\n" +
        "         ON CONFLICT (tenant_id, report_type) DO UPDATE SET config=EXCLUDED.config, updated_at=NOW()`,\n" +
        "        [tenantId, String(reportType), JSON.stringify({ email, frequency, time: timeNorm, dayOfWeek, enabled: true })]\n" +
        "      );\n" +
        "      reportScheduleListeners.forEach(f => { try { f(); } catch {} }); // tell the scheduler to reload now";
      eb.t = eb.t.slice(0, lineStart) + repl + eb.t.slice(b + endMark.length); eb.changed = true; console.log('patched  ' + N + ': save schedule');
    }
  }
  // 2. listing schedules reads the new table (setting_key = report_type, so the existing mapping still works)
  step(eb, N, 'list schedules from report_schedules', 'FROM report_schedules WHERE tenant_id=$1',
    "SELECT setting_key, setting_value FROM monitor_settings WHERE tenant_id=$1 AND setting_key LIKE 'report_schedule_%'",
    "SELECT report_type AS setting_key, config AS setting_value FROM report_schedules WHERE tenant_id=$1");
  // 3. the old in-memory sender is switched off (the built-in scheduler sends everything now: no double emails)
  step(eb, N, 'old /run-scheduled no longer sends', 'handledByBuiltInScheduler',
    "    for (const [tenantId, schedules] of reportSchedules.entries()) {",
    "    // Report schedules are now sent by the built-in scheduler in index.ts (table report_schedules).\n" +
    "    const handledByBuiltInScheduler = true as boolean;\n" +
    "    if (handledByBuiltInScheduler) { res.json({ success: true, sent: 0, note: 'handled by the built-in scheduler' }); return; }\n\n" +
    "    for (const [tenantId, schedules] of reportSchedules.entries()) {");
  // 4. helpers used by the scheduler
  step(eb, N, 'helpers for the scheduler', 'export async function runEventBusReport',
    "export { broadcastToTenant };",
    "export { broadcastToTenant };\n\n" +
    "export const reportScheduleListeners: Array<() => void> = [];\n\n" +
    "export async function ensureReportSchedulesTable(pool: Pool): Promise<void> {\n" +
    "  await pool.query(`CREATE TABLE IF NOT EXISTS report_schedules (\n" +
    "    tenant_id UUID NOT NULL, report_type TEXT NOT NULL, config TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(),\n" +
    "    PRIMARY KEY (tenant_id, report_type))`);\n" +
    "}\n\n" +
    "// The two reports that live in this file, for the built-in scheduler in index.ts.\n" +
    "export async function runEventBusReport(pool: Pool, tenantId: string, reportType: string): Promise<{ subject: string; html: string } | null> {\n" +
    "  const d = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });\n" +
    "  if (reportType === 'ar_aging') return { subject: `Daily AR Aging Report - ${d}`, html: await generateARAgingReport(pool, tenantId) };\n" +
    "  if (reportType === 'weekly_pl') return { subject: `Weekly P&L Report - ${d}`, html: await generateWeeklyPLReport(pool, tenantId) };\n" +
    "  return null;\n" +
    "}");
  save(eb);
}

// ── index.ts (the every-minute scheduler) ───────────────────────────────────
const ix = load('index.ts');
if (ix) {
  const N = 'index.ts';
  step(ix, N, 'read schedules from report_schedules', 'FROM report_schedules"',
    "SELECT tenant_id, setting_key, setting_value FROM monitor_settings WHERE setting_key LIKE 'report_schedule_%'",
    "SELECT tenant_id, 'report_schedule_' || report_type AS setting_key, config AS setting_value FROM report_schedules");
  step(ix, N, 'reload schedules as soon as one is saved', 'reportScheduleListeners',
    "// Auto Report Scheduler - runs every minute",
    "// A saved schedule is picked up straight away (no waiting for the 10-minute refresh).\n" +
    "import('./routes/eventBusRoutes').then(m => { m.reportScheduleListeners.push(() => { _reportSchedCache.at = 0; }); }).catch(() => {});\n\n" +
    "// Auto Report Scheduler - runs every minute");
  step(ix, N, 'India time: clock', 'const ist = new Date(Date.now() + 330 * 60000)',
    "const currentTime = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');",
    "const ist = new Date(Date.now() + 330 * 60000); // India time (the server clock is UTC)\n" +
    "    const currentTime = ist.getUTCHours().toString().padStart(2,'0') + ':' + ist.getUTCMinutes().toString().padStart(2,'0');");
  step(ix, N, 'India time: weekday', 'ist.getUTCDay()', "const currentDay = now.getDay();", "const currentDay = ist.getUTCDay();");
  step(ix, N, 'India time: day of month', 'ist.getUTCDate()', "const currentDate = now.getDate();", "const currentDate = ist.getUTCDate();");
  step(ix, N, 'also send the two reports from the old file', 'runEventBusReport',
    "        if (!registry) continue;",
    "        let rep: { subject: string; html: string; label: string } | null = null;\n" +
    "        if (registry) { const r0 = await registry.fn(pool, row.tenant_id, sched.threshold || 100000); rep = { subject: r0.subject, html: r0.html, label: registry.label }; }\n" +
    "        else {\n" +
    "          const { runEventBusReport } = await import('./routes/eventBusRoutes');\n" +
    "          const rtype = row.setting_key.replace('report_schedule_', '');\n" +
    "          const r1 = await runEventBusReport(pool, row.tenant_id, rtype);\n" +
    "          if (r1) rep = { subject: r1.subject, html: r1.html, label: rtype };\n" +
    "        }\n" +
    "        if (!rep) continue;");
  step(ix, N, 'use the prepared report', 'const { subject, html } = rep;',
    "        const { subject, html } = await registry.fn(pool, row.tenant_id, sched.threshold || 100000);",
    "        const { subject, html } = rep;");
  step(ix, N, 'log label (log table)', "rep.label + ' auto-sent to '", "registry.label + ' auto-sent to '", "rep.label + ' auto-sent to '");
  step(ix, N, 'log label (console)', "'[Cron] Sent:', rep.label", "'[Cron] Sent:', registry.label", "'[Cron] Sent:', rep.label");
  save(ix);
}
console.log('\nDone. Commit and push the backend repo.');
