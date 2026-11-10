// WhatsApp: bills awaiting approval have status 'pending_approval' in this app (older code only looked for 'pending'). Idempotent. Run from the backend folder.
const fs = require('fs');
function patch(p, pairs) {
  if (!fs.existsSync(p)) { console.log('MISSING', p); process.exitCode = 1; return; }
  let s = fs.readFileSync(p, 'utf8'); const bom = s.charCodeAt(0) === 0xFEFF; if (bom) s = s.slice(1); const crlf = s.includes('\r\n'); if (crlf) s = s.replace(/\r\n/g, '\n');
  let changed = false;
  for (const [a, b] of pairs) { if (s.includes(b)) continue; if (!s.includes(a)) { console.log('anchor not found in', p, ':', a.slice(0, 60)); process.exitCode = 1; continue; } s = s.replace(a, b); changed = true; }
  if (changed) { fs.writeFileSync(p, (bom ? '﻿' : '') + (crlf ? s.replace(/\n/g, '\r\n') : s)); console.log('patched', p); } else console.log('no change', p);
}
patch('src/services/whatsappCommands.ts', [["AND a.status='pending' ORDER BY a.due_date LIMIT 5", "AND a.status IN ('pending','pending_approval') ORDER BY a.due_date LIMIT 5"]]);
patch('src/services/automationEngine.ts', [["AND id::text LIKE $1 AND status='pending' LIMIT 1", "AND id::text LIKE $1 AND status IN ('pending','pending_approval') LIMIT 1"]]);
