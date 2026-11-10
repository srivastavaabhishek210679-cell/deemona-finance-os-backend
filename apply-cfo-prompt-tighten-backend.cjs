// Tell the Digital CFO to stay within the tool output for action plans (no invented legal figures or fallbacks). Idempotent. Run from the backend folder.
const fs = require('fs'); const p = 'src/routes/cfoAgentRoutes.ts';
let s = fs.readFileSync(p, 'utf8'); const bom = s.charCodeAt(0) === 0xFEFF; if (bom) s = s.slice(1); const crlf = s.includes('\r\n'); if (crlf) s = s.replace(/\r\n/g, '\n');
if (s.includes('/*plan-grounding*/')) { console.log('already patched'); process.exit(0); }
const a = 'Both are suggestions: say nothing has been executed.';
if (!s.includes(a)) { console.log('anchor not found'); process.exit(1); }
s = s.replace(a, a + ' For action plans, state only the steps, dates, amounts, cautions and before/after figures the tool returned. Do not add legal penalties, interest rates, fallback steps or other actions the tool did not return; if the tool says no action closes the gap, say so and name only the remaining gap. Use the tool\'s "assumptions" field for what is included or excluded. /*plan-grounding*/');
fs.writeFileSync(p, (bom ? '﻿' : '') + (crlf ? s.replace(/\n/g, '\r\n') : s)); console.log('patched', p);
