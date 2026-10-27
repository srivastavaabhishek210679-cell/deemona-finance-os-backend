// Run from the backend folder:  node fix-anomaly.cjs
// Fixes "Cannot read properties of undefined (reading 'rows')" in POST /api/ai/anomaly/detect.
const fs = require('fs'), path = require('path');
let file = null;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (e.name === 'phase1Routes.ts') file = p; } })(path.join(process.cwd(), 'src'));
if (!file) { console.log('MISSING phase1Routes.ts (run from the backend folder)'); process.exit(1); }
const raw = fs.readFileSync(file, 'utf8'); const crlf = raw.includes('\r\n');
let t = crlf ? raw.replace(/\r\n/g, '\n') : raw;
if (t.includes('].map((p: Promise<any>) => p.catch(')) { console.log('already  anomaly fix'); process.exit(0); }
const closing = "]).catch(() => Array(3).fill({ rows: [{}] }));";
if (!t.includes(closing) || !t.includes('arHistory[0].rows[0]')) { console.log('NO MATCH anomaly fix'); process.exit(1); }
t = t.replace(closing, "].map((p: Promise<any>) => p.catch(() => ({ rows: [{}] }))));");
for (const n of ['arHistory', 'expHistory', 'payHistory']) t = t.split(n + '[0].rows[0]').join(n + '.rows[0]');
fs.writeFileSync(file, crlf ? t.replace(/\n/g, '\r\n') : t);
console.log('patched  ' + path.relative(process.cwd(), file) + ': anomaly detection reads query results correctly');
