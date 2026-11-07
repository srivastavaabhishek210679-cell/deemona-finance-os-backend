// Live-update stream: send a heartbeat every 15s (was 30s) so browsers/proxies don't drop it as idle.
// Run from the backend repo root:  node apply-sse-heartbeat-backend.cjs   (idempotent, CRLF-aware)
const fs = require('fs'), path = require('path');
const file = path.join(process.cwd(), 'src', 'routes', 'sseRoutes.ts');
if (!fs.existsSync(file)) { console.error('Not found: ' + file + ' - run this from the backend repo root.'); process.exit(1); }
const raw = fs.readFileSync(file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let s = raw.replace(/\r\n/g, '\n');
const from = "catch { clearInterval(hb); } }, 30000);";
const i = s.indexOf(from);
if (i < 0) { console.log(s.includes('}, 15000);') ? 'Already applied - nothing to do.' : 'Heartbeat line not found. No changes made.'); process.exit(0); }
if (s.indexOf(from, i + 1) >= 0) { console.error('More than one match. No changes made.'); process.exit(1); }
s = s.slice(0, i) + "catch { clearInterval(hb); } }, 15000);" + s.slice(i + from.length);
fs.writeFileSync(file, s.replace(/\n/g, eol), 'utf8');
console.log('Heartbeat interval set to 15s in src/routes/sseRoutes.ts');
