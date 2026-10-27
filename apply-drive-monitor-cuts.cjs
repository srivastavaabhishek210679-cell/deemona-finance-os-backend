// Run from the backend folder:  node apply-drive-monitor-cuts.cjs
// Quiets and slows src/services/driveMonitorMultiTenant.ts (the "[Monitor][...] Found 4 files" loop).
const fs = require('fs'), path = require('path');
let file = null;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (e.name === 'driveMonitorMultiTenant.ts') file = p; } })(path.join(process.cwd(), 'src'));
if (!file) { console.log('MISSING driveMonitorMultiTenant.ts (run from the backend folder)'); process.exit(1); }
const raw = fs.readFileSync(file, 'utf8'); const crlf = raw.includes('\r\n');
let t = crlf ? raw.replace(/\r\n/g, '\n') : raw; let changed = false;
function step(label, already, find, replace) {
  if (t.includes(already)) { console.log('already  ' + label); return; }
  const i = t.indexOf(find);
  if (i < 0) { console.log('NO MATCH ' + label); return; }
  t = t.slice(0, i) + replace + t.slice(i + find.length); changed = true; console.log('patched  ' + label);
}

step('remember what was last logged / written', 'const lastFound',
  "const FINANCIAL_EXTS = ['.xlsx'",
  "// Cost control: remember what was last logged/written so an idle folder costs almost no database work.\n" +
  "const lastFound = new Map<string, number>();\n" +
  "const lastTouch = new Map<string, number>();\n" +
  "let lastLogCleanup = 0;\n\n" +
  "const FINANCIAL_EXTS = ['.xlsx'");

step('log "Found N files" only when the count changes', 'lastFound.get(tid)',
  "    await logToDb(pool, tid, 'info', `Found ${files.length} files in Drive folder`);",
  "    if (lastFound.get(tid) !== files.length) {\n" +
  "      lastFound.set(tid, files.length);\n" +
  "      await logToDb(pool, tid, 'info', `Found ${files.length} files in Drive folder`);\n" +
  "    }");

step('"last checked" written at most every 30 minutes', 'lastTouch.get(tid)',
  "      await pool.query('UPDATE monitor_settings SET last_checked_at=NOW() WHERE tenant_id=$1', [tid]);",
  "      if (Date.now() - (lastTouch.get(tid) || 0) > 30 * 60 * 1000) {\n" +
  "        lastTouch.set(tid, Date.now());\n" +
  "        await pool.query('UPDATE monitor_settings SET last_checked_at=NOW() WHERE tenant_id=$1', [tid]);\n" +
  "      }");

step('check every 10 minutes (never faster than 2)', 'Math.max(120,',
  "    const interval = parseInt(process.env.MONITOR_SLEEP_SECONDS || '60');",
  "    // Cost control: default every 10 minutes, never faster than every 2 minutes.\n" +
  "    const interval = Math.max(120, parseInt(process.env.MONITOR_SLEEP_SECONDS || '600') || 600);");

step('delete monitor log rows older than 30 days (once a day)', 'lastLogCleanup > ',
  "    cycle++;",
  "    cycle++;\n" +
  "    if (Date.now() - lastLogCleanup > 24 * 3600 * 1000) {\n" +
  "      lastLogCleanup = Date.now();\n" +
  "      await pool.query(\"DELETE FROM monitor_logs WHERE created_at < NOW() - INTERVAL '30 days'\").catch(() => {});\n" +
  "    }");

if (changed) fs.writeFileSync(file, crlf ? t.replace(/\n/g, '\r\n') : t);
console.log('\nDone. Commit and push the backend repo.');
