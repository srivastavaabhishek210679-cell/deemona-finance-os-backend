// Fixes the Accounting Agent failing with: column "je.entry_number" must appear in the GROUP BY clause.
// The recent-journal-entries query used json_agg() without GROUP BY. Idempotent. Run from the backend folder.
const fs = require('fs');
const f = 'src/services/accountingAgent.ts';
if (!fs.existsSync(f)) { console.error('Run this from the backend folder'); process.exit(1); }
const raw = fs.readFileSync(f, 'utf8'); const bom = raw.charCodeAt(0) === 0xFEFF; const crlf = raw.includes('\r\n');
let s = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
const bad = "       WHERE je.tenant_id = $1\n       ORDER BY je.date DESC LIMIT 10`,";
const good = "       WHERE je.tenant_id = $1\n       GROUP BY je.id\n       ORDER BY je.date DESC LIMIT 10`,";
if (s.includes(good)) { console.log('no change', f); process.exit(0); }
if (!s.includes(bad)) { console.error('anchor not found in ' + f + ' (the query looks different here)'); process.exit(1); }
s = s.replace(bad, () => good);
fs.writeFileSync(f, (bom ? '﻿' : '') + (crlf ? s.replace(/\n/g, '\r\n') : s)); console.log('patched', f);
