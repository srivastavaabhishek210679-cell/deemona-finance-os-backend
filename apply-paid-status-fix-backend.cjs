// Past-date balance sheet: an invoice marked 'paid' with no recorded payment dates (or paid_amount still 0)
// is now reported as "cannot be rebuilt" instead of being counted as outstanding.
// Run from the backend repo root AFTER apply-historical-twin-backend.cjs:  node apply-paid-status-fix-backend.cjs
const fs = require('fs'), path = require('path');
const p = path.join(process.cwd(), 'src', 'routes', 'statementsRoutes.ts');
if (!fs.existsSync(p)) { console.error('Not found: src/routes/statementsRoutes.ts - run from the backend repo root.'); process.exit(1); }
const raw = fs.readFileSync(p, 'utf8'); const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let s = raw.replace(/\r\n/g, '\n');
if (s.includes("i.status AS inv_status")) { console.log('Already applied - nothing to do.'); process.exit(0); }
if (!s.includes('data_quality')) { console.error('Run apply-historical-twin-backend.cjs first. No changes written.'); process.exit(1); }
function rep(a, b, label) { const i = s.indexOf(a); if (i < 0 || s.indexOf(a, i + 1) >= 0) { console.error('Could not place: ' + label + '. No changes written.'); process.exit(1); } s = s.slice(0, i) + b + s.slice(i + a.length); }
rep("SELECT i.total_amount, i.paid_amount,", "SELECT i.total_amount, i.paid_amount, i.status AS inv_status,", 'select');
const unk = "(paid_amount > 0 OR inv_status = 'paid') AND ev_total + 0.005 < GREATEST(paid_amount, CASE WHEN inv_status = 'paid' THEN total_amount ELSE 0 END)";
rep("SELECT COALESCE(SUM(CASE WHEN paid_amount = 0 OR ev_total + 0.005 >= paid_amount THEN total_amount - ev_by_date END), 0) AS known,",
    "SELECT COALESCE(SUM(CASE WHEN NOT (" + unk + ") THEN total_amount - ev_by_date END), 0) AS known,", 'known');
rep("COUNT(*) FILTER (WHERE paid_amount > 0 AND ev_total + 0.005 < paid_amount) AS unknown_count,", "COUNT(*) FILTER (WHERE " + unk + ") AS unknown_count,", 'count');
rep("COALESCE(SUM(CASE WHEN paid_amount > 0 AND ev_total + 0.005 < paid_amount THEN total_amount END), 0) AS unknown_total", "COALESCE(SUM(CASE WHEN " + unk + " THEN total_amount END), 0) AS unknown_total", 'total');
fs.writeFileSync(p, s.replace(/\n/g, eol), 'utf8');
console.log('Past-date balance sheet now treats paid invoices without payment dates as not rebuildable.');
