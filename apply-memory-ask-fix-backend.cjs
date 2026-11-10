// Fixes Finance Memory "Ask Memory" failing with "could not determine data type of parameter $2".
// The recency fallback in MemoryService.search() used LIMIT $(n+1) but only passed n parameters. Idempotent. Run from the backend folder.
const fs = require('fs');
const f = 'src/services/memoryService.ts';
if (!fs.existsSync(f)) { console.error('Run this from the backend folder'); process.exit(1); }
const raw = fs.readFileSync(f, 'utf8'); const bom = raw.charCodeAt(0) === 0xFEFF; const crlf = raw.includes('\r\n');
let s = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
const bad = "           ORDER BY is_pinned DESC, importance DESC, created_at DESC\n           LIMIT $${pIdx + 1}`,\n          [...params, limit]";
const good = "           ORDER BY is_pinned DESC, importance DESC, created_at DESC\n           LIMIT $${pIdx}`,\n          [...params, limit]";
if (s.includes(good)) { console.log('no change', f); process.exit(0); }
if (!s.includes(bad)) { console.log('anchor not found in ' + f + ' (the fallback query looks different here)'); process.exit(1); }
s = s.replace(bad, () => good);   // function form: a string replacement would treat $$ as a single $
fs.writeFileSync(f, (bom ? '﻿' : '') + (crlf ? s.replace(/\n/g, '\r\n') : s)); console.log('patched', f);
