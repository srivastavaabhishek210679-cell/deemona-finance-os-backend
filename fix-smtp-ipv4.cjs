// Run from the backend folder:  node fix-smtp-ipv4.cjs
// Forces IPv4 for SMTP (Render has no IPv6 route; Gmail resolves to IPv6 first). Safe to run twice.
const fs = require('fs'), path = require('path');
function find(name) {
  const st = [path.join(process.cwd(), 'src')];
  while (st.length) { const d = st.pop(); let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') st.push(p); } else if (e.name === name) return p; } }
  return null;
}
const file = find('authRoutes.ts');
if (!file) { console.log('MISSING authRoutes.ts (run from the backend folder)'); process.exit(1); }
let raw = fs.readFileSync(file, 'utf8');
const bom = raw.charCodeAt(0) === 0xFEFF; if (bom) raw = raw.slice(1);
const crlf = raw.includes('\r\n');
let t = crlf ? raw.replace(/\r\n/g, '\n') : raw;
if (t.includes('family: 4')) { console.log('already patched'); process.exit(0); }
const f = "      host: process.env.SMTP_HOST, port,\n";
const i = t.indexOf(f);
if (i < 0) { console.log('NO MATCH: transport host line (run apply-smtp.cjs first)'); process.exit(1); }
t = t.slice(0, i) + "      host: process.env.SMTP_HOST, port, family: 4,\n" + t.slice(i + f.length);
fs.writeFileSync(file, (bom ? '﻿' : '') + (crlf ? t.replace(/\n/g, '\r\n') : t));
console.log('patched: SMTP forced to IPv4\nDone: ' + file);
