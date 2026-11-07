// Fixes cross-tenant leaks in src/services/automationEngine.ts. Idempotent. Run from the backend folder.
const fs = require('fs');
const f = 'src/services/automationEngine.ts';
if (!fs.existsSync(f)) { console.error('Run from the backend folder'); process.exit(1); }
const raw = fs.readFileSync(f, 'utf8'); const crlf = raw.includes('\r\n'); let s = raw.replace(/\r\n/g, '\n');
if (s.includes('/*tenant-scope*/')) { console.log('Already applied'); process.exit(0); }
let n = 0;
function rep(a, b, label) { if (!s.includes(a)) { console.error('Pattern not found: ' + label); process.exit(1); } s = s.replace(a, () => b); n++; }
rep(`pool.query("SELECT phone FROM employees WHERE phone IS NOT NULL LIMIT 1")`,
    `pool.query("SELECT phone FROM employees WHERE tenant_id=$1 AND phone IS NOT NULL LIMIT 1", [tenantId]) /*tenant-scope*/`, 'getManagerPhone');
rep(`FROM expense_claims WHERE created_at > NOW()-INTERVAL '30 days'\`)`,
    `FROM expense_claims WHERE tenant_id=$1 AND created_at > NOW()-INTERVAL '30 days'\`, [tenantId])`, 'getMonthlyBurn');
rep(`"SELECT * FROM compliance_items WHERE status NOT IN ('Completed','Closed') AND due_date BETWEEN NOW() AND NOW() + INTERVAL '7 days' LIMIT 10"`,
    `"SELECT * FROM compliance_items WHERE tenant_id=$1 AND status NOT IN ('Completed','Closed') AND due_date BETWEEN NOW() AND NOW() + INTERVAL '7 days' LIMIT 10", [tenantId]`, 'compliance alerts');
rep(`WHERE po.status IN ('approved','Approved') AND`, `WHERE po.tenant_id=$1 AND po.status IN ('approved','Approved') AND`, 'po where');
rep(`INTERVAL '3 days' LIMIT 10"`, `INTERVAL '3 days' LIMIT 10", [tenantId]`, 'po args');
rep(`"SELECT title, due_date FROM compliance_items WHERE status NOT IN ('Completed','Closed') AND due_date <= NOW()+INTERVAL '7 days' ORDER BY due_date ASC LIMIT 5"`,
    `"SELECT title, due_date FROM compliance_items WHERE tenant_id=$1 AND status NOT IN ('Completed','Closed') AND due_date <= NOW()+INTERVAL '7 days' ORDER BY due_date ASC LIMIT 5", [tenantId]`, 'brief compliance');
// id-only updates -> add tenant
rep(`await pool.query('UPDATE ap_invoices SET status=$1, updated_at=NOW() WHERE id=$2', ['approved', invoiceId]);`,
    `await pool.query('UPDATE ap_invoices SET status=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3', ['approved', invoiceId, tenantId]);`, 'auto-approve update');
rep(`await pool.query('UPDATE expense_claims SET status=$1, updated_at=NOW() WHERE id=$2', ['approved', expenseId]);`,
    `await pool.query('UPDATE expense_claims SET status=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3', ['approved', expenseId, tenantId]);`, 'expense update');
// WhatsApp reply: only act for the tenant owning the sender's phone
rep(`const result = await pool.query("SELECT * FROM ap_invoices WHERE id::text LIKE $1 AND status='pending' LIMIT 1", [partialId + '%']);`,
    `const digits = String(from || '').replace(/\\D/g, '').slice(-10);
    if (digits.length < 10) return 'Sender not recognised.';
    const who = await pool.query("SELECT DISTINCT tenant_id FROM employees WHERE RIGHT(regexp_replace(COALESCE(phone,''),'\\\\D','','g'),10)=$1", [digits]);
    if (who.rows.length !== 1) return 'Sender not recognised.';
    const result = await pool.query("SELECT * FROM ap_invoices WHERE tenant_id=$2 AND id::text LIKE $1 AND status='pending' LIMIT 1", [partialId + '%', who.rows[0].tenant_id]);`, 'reply lookup');
rep(`await pool.query('UPDATE ap_invoices SET status=$1, updated_at=NOW() WHERE id=$2', [newStatus, invoice.id]);`,
    `await pool.query('UPDATE ap_invoices SET status=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3', [newStatus, invoice.id, invoice.tenant_id]);`, 'reply update');
fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s); console.log('Done (' + n + ' changes)');
