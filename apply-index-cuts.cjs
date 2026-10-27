// Run from the backend folder:  node apply-index-cuts.cjs
// Cuts the two always-on timers in src/index.ts. Safe to run twice.
const fs = require('fs');
const file = require('path').join(process.cwd(), 'src', 'index.ts');
if (!fs.existsSync(file)) { console.log('MISSING src/index.ts (run from the backend folder)'); process.exit(1); }
const raw = fs.readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
let t = crlf ? raw.replace(/\r\n/g, '\n') : raw;
let changed = false;
function step(label, already, find, replace) {
  if (t.includes(already)) { console.log('already  ' + label); return; }
  const i = t.indexOf(find);
  if (i < 0) { console.log('NO MATCH ' + label); return; }
  t = t.slice(0, i) + replace + t.slice(i + find.length);
  changed = true; console.log('patched  ' + label);
}

step('embedding queue: every 5 minutes (was 30 seconds)', 'EMBED_PASSES',
  "cron.schedule('*/30 * * * * *', () => processEmbeddingQueue(pool));",
  "cron.schedule('*/5 * * * *', async () => {\n" +
  "    const EMBED_PASSES = 5; // drain a backlog in one visit instead of waking the database every 30 s\n" +
  "    try {\n" +
  "      for (let i = 0; i < EMBED_PASSES; i++) {\n" +
  "        const n: any = await processEmbeddingQueue(pool);\n" +
  "        const done = typeof n === 'number' ? n : n?.processed;\n" +
  "        if (!(done > 0)) break;\n" +
  "      }\n" +
  "    } catch (e) { console.error('[Memory] embedding queue error:', e); }\n" +
  "  });");

step('report scheduler: read schedules from memory, refresh from DB every 10 min', 'getReportSchedules',
  "// Auto Report Scheduler - runs every minute",
  "// Cost control: report schedules are read from the database at most every 10 minutes;\n" +
  "// the every-minute tick below then runs from memory and no longer wakes the database.\n" +
  "let _reportSchedCache: { at: number; rows: any[] } = { at: 0, rows: [] };\n" +
  "async function getReportSchedules(): Promise<{ rows: any[] }> {\n" +
  "  if (Date.now() - _reportSchedCache.at > 600000) {\n" +
  "    const r: any = await pool.query(\"SELECT tenant_id, setting_key, setting_value FROM monitor_settings WHERE setting_key LIKE 'report_schedule_%'\").catch(() => null);\n" +
  "    _reportSchedCache = { at: Date.now(), rows: r ? r.rows : _reportSchedCache.rows };\n" +
  "  }\n" +
  "  return { rows: _reportSchedCache.rows };\n" +
  "}\n\n" +
  "// Auto Report Scheduler - runs every minute");

step('report scheduler uses the cache', 'await getReportSchedules()',
  "const result = await pool.query(\"SELECT tenant_id, setting_key, setting_value FROM monitor_settings WHERE setting_key LIKE 'report_schedule_%'\").catch(() => ({ rows: [] }));",
  "const result = await getReportSchedules();");

if (changed) fs.writeFileSync(file, crlf ? t.replace(/\n/g, '\r\n') : t);
console.log('\nDone. Commit and push the backend repo.');
