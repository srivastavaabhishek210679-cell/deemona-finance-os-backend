// Run from the backend folder:  node fix-smtp-match-rasoi.cjs   then:  npm install nodemailer@6.10.1 @types/nodemailer@^6.4.15
// Makes the SMTP transport match the working Rasoi app (nodemailer 6, no forced IPv4, moderate timeouts). Safe to run twice.
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
let changed = false;
if (t.includes('port, family: 4,')) { t = t.replace('port, family: 4,', 'port,'); changed = true; console.log('patched: removed forced IPv4 option'); }
const old = 'connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,';
if (t.includes(old)) { t = t.replace(old, 'connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 60000,'); changed = true; console.log('patched: timeouts 30s/30s/60s'); }
if (!changed) { console.log('already patched (or SMTP block not found)'); process.exit(0); }
fs.writeFileSync(file, (bom ? '﻿' : '') + (crlf ? t.replace(/\n/g, '\r\n') : t));
console.log('Done: ' + file);
