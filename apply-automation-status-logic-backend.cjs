// Fixes overdue/status logic in automationEngine.ts. Idempotent. Run from the backend folder.
// Nothing in the app ever sets status='overdue', so "overdue" must be derived from due_date; partially paid invoices were also skipped.
const fs = require('fs');
const f = 'src/services/automationEngine.ts';
if (!fs.existsSync(f)) { console.error('Run from the backend folder'); process.exit(1); }
const raw = fs.readFileSync(f, 'utf8'); const crlf = raw.includes('\r\n'); let s = raw.replace(/\r\n/g, '\n');
if (s.includes('/*status-logic*/')) { console.log('Already applied'); process.exit(0); }
let n = 0;
const a = `FROM ar_invoices WHERE tenant_id=$1 AND status='overdue'"`;
if (!s.includes(a)) { console.error('Pattern not found: morning brief overdue count'); process.exit(1); }
s = s.replace(a, () => `FROM ar_invoices WHERE tenant_id=$1 AND status IN ('sent','partially_paid','overdue') AND due_date < CURRENT_DATE AND balance_due > 0" /*status-logic*/`); n++;
const b = `IN ('sent','overdue')`; const c1 = s.split(b).length - 1;
if (c1 < 1) { console.error('Pattern not found: sent/overdue lists'); process.exit(1); }
s = s.split(b).join(`IN ('sent','partially_paid','overdue')`); n += c1;
const d = `status IN ('paid','sent')`;
if (s.includes(d)) { s = s.split(d).join(`status IN ('paid','partially_paid','sent','overdue')`); n++; }
fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s); console.log('Done (' + n + ' changes)');
