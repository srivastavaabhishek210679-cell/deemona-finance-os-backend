// Run from the backend folder:  node apply-cost-cuts.cjs
// Cuts idle database/API work. Safe to run twice. Commit afterwards (git is your backup).
const fs = require('fs');
const path = require('path');

const root = path.join(process.cwd(), 'src');

function findFile(name) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') stack.push(p); }
      else if (e.name === name) return p;
    }
  }
  return null;
}

function patch(name, steps) {
  const file = findFile(name);
  if (!file) { console.log('MISSING  ' + name + ' (run this from the backend folder)'); return; }
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let t = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  let changed = false;
  for (const s of steps) {
    if (t.includes(s.already)) { console.log('already  ' + name + ': ' + s.label); continue; }
    let out;
    if (s.fn) out = s.fn(t);
    else {
      const i = t.indexOf(s.find);
      out = i < 0 ? null : t.slice(0, i) + s.replace + t.slice(i + s.find.length);
    }
    if (out == null) { console.log('NO MATCH ' + name + ': ' + s.label); continue; }
    t = out; changed = true;
    console.log('patched  ' + name + ': ' + s.label);
  }
  if (changed) fs.writeFileSync(file, crlf ? t.replace(/\n/g, '\r\n') : t);
}

// ── 1. Change detection (was: 8 queries every 2 seconds, 24/7) ──────────────
const NEW_CDC = [
  "export const setupCDC = async (pool) => {",
  "  // Cost control: poll only while a browser is connected, at a calmer interval.",
  "  const everyMs = Math.max(2000, Number(process.env.CDC_INTERVAL_MS) || 10000);",
  "  console.log(`[CDC] Starting polling-based change detection (${Math.round(everyMs / 1000)}s interval, only while clients are connected)`);",
  "  const lastSeen = {};",
  "  const tables = ['ar_invoices','ap_invoices','expenses','bank_transactions','payments','employees','purchase_orders','inventory_items'];",
  "  const initTable = async (table) => {",
  "    try {",
  "      const r = await pool.query(`SELECT COALESCE(MAX(updated_at), NOW())::text as ts FROM ${table}`).catch(() => ({ rows: [{ ts: new Date().toISOString() }] }));",
  "      lastSeen[table] = r.rows[0]?.ts || new Date().toISOString();",
  "    } catch { lastSeen[table] = new Date().toISOString(); }",
  "  };",
  "  const clientCount = () => { let n = 0; sseClients.forEach(s => { n += s.size; }); return n; };",
  "  let idle = true;",
  "  let running = false;",
  "  setInterval(async () => {",
  "    if (running) return;",
  "    if (clientCount() === 0) { idle = true; return; }",
  "    running = true;",
  "    try {",
  "      if (idle) { for (const t of tables) await initTable(t); idle = false; }",
  "      for (const table of tables) {",
  "        try {",
  "          const r = await pool.query(`SELECT tenant_id::text, MAX(updated_at)::text as ts FROM ${table} WHERE updated_at > $1::timestamptz GROUP BY tenant_id`, [lastSeen[table]]).catch(() => ({ rows: [] }));",
  "          for (const row of r.rows) {",
  "            if (row.tenant_id) {",
  "              broadcastToTenant(row.tenant_id, { type: 'data_change', table, action: 'UPDATE', timestamp: new Date().toISOString() });",
  "              console.log(`[CDC] Change in ${table} for tenant ${row.tenant_id?.substring(0,8)}`);",
  "            }",
  "            if (row.ts && row.ts > lastSeen[table]) lastSeen[table] = row.ts;",
  "          }",
  "        } catch {}",
  "      }",
  "    } finally { running = false; }",
  "  }, everyMs);",
  "};",
].join('\n');

patch('sseRoutes.ts', [{
  label: 'CDC polls only while clients are connected, every 10s',
  already: 'CDC_INTERVAL_MS',
  fn: (t) => {
    const a = t.indexOf('export const setupCDC');
    const endMarker = '  }, 2000);\n};';
    const b = t.indexOf(endMarker);
    if (a < 0 || b < 0 || b < a) return null;
    return t.slice(0, a) + NEW_CDC + t.slice(b + endMarker.length);
  },
}]);

// ── 2. Google Drive monitor (throttle, quieter log, working internal auth) ───
patch('driveMonitorRoutes.ts', [
  {
    label: 'throttle runs (default once per 10 minutes)',
    already: 'lastDriveRun',
    find: 'export async function runDriveMonitor(pool: Pool): Promise<{ checked: number; processed: number }> {',
    replace:
      'let lastDriveRun = 0;\n' +
      'export async function runDriveMonitor(pool: Pool, force = false): Promise<{ checked: number; processed: number }> {\n' +
      '  const gapMs = Math.max(1, Number(process.env.DRIVE_MONITOR_MINUTES) || 10) * 60000;\n' +
      '  if (!force && Date.now() - lastDriveRun < gapMs) return { checked: 0, processed: 0 };\n' +
      '  lastDriveRun = Date.now();',
  },
  {
    label: 'manual "run now" ignores the throttle',
    already: 'runDriveMonitor(pool, true)',
    find: 'const result = await runDriveMonitor(pool);',
    replace: 'const result = await runDriveMonitor(pool, true);',
  },
  {
    label: 'log only when new files exist',
    already: 'if (newFiles.length > 0) console.log(',
    find: 'console.log(`[DriveMonitor] Tenant ${row.tenant_id}: ${files.length} files found, ${newFiles.length} new`);',
    replace: 'if (newFiles.length > 0) console.log(`[DriveMonitor] Tenant ${row.tenant_id}: ${files.length} files found, ${newFiles.length} new`);',
  },
  {
    label: 'send the secret-signed internal bearer to /api/ingest',
    already: "'Bearer internal-' + process.env.CRON_SECRET",
    find: "headers: { 'Content-Type': 'application/json', 'x-internal-tenant': tenantId },",
    replace:
      "headers: {\n" +
      "        'Content-Type': 'application/json',\n" +
      "        'x-internal-tenant': tenantId,\n" +
      "        ...(process.env.CRON_SECRET ? { Authorization: 'Bearer internal-' + process.env.CRON_SECRET + '.' + tenantId } : {}),\n" +
      "      },",
  },
]);

// ── 3. NetSuite auto-sync (was: every 60 s, 4 entities, up to 1000 rows each) ─
patch('netsuiteRoutes.ts', [
  {
    label: 'sync every 15 minutes (NETSUITE_SYNC_MINUTES to change)',
    already: 'NETSUITE_SYNC_MINUTES',
    find: "  console.log('[NetSuite] Starting auto-sync poller (60s interval)');",
    replace:
      "  const syncMinutes = Math.max(1, Math.floor(Number(process.env.NETSUITE_SYNC_MINUTES) || 15));\n" +
      "  const tickMs = Math.min(300000, syncMinutes * 60000);\n" +
      "  console.log(`[NetSuite] Starting auto-sync poller (every ${syncMinutes} min)`);",
  },
  {
    label: 'due-check uses the new interval',
    already: "INTERVAL '${syncMinutes} minutes'",
    find: "INTERVAL '60 seconds'",
    replace: "INTERVAL '${syncMinutes} minutes'",
  },
  {
    label: 'tick uses tickMs',
    already: '}, tickMs);',
    find: '}, 60000);',
    replace: '}, tickMs);',
  },
]);

// ── 4. Universal poller (was: a query every 30 s) ───────────────────────────
patch('universalPollerRoutes.ts', [
  {
    label: 'check for due connections every 5 minutes',
    already: 'POLLER_TICK_MS',
    find: "  console.log('[UniversalPoller] Starting background poller...');",
    replace:
      "  const tickMs = Math.max(60000, Number(process.env.POLLER_TICK_MS) || 300000);\n" +
      "  console.log(`[UniversalPoller] Starting background poller (checks every ${Math.round(tickMs / 60000)} min)`);",
  },
  {
    label: 'tick uses tickMs',
    already: '}, tickMs); //',
    find: '}, 30000); // Check every 30 seconds which connections are due',
    replace: '}, tickMs); // Check which connections are due',
  },
]);

console.log('\nDone. Still needed: the embedding-queue and every-minute cron lines in index.ts (send lines 235-260 and 345-360).');
