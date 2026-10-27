// Run from the backend folder:  node apply-brief-guard.cjs
// Scheduled CFO briefs are skipped for companies that have no financial data yet (saves AI cost).
const fs = require('fs'), path = require('path');
let file = null;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (e.name === 'cfoProactive.ts') file = p; } })(path.join(process.cwd(), 'src'));
if (!file) { console.log('MISSING cfoProactive.ts (run from the backend folder)'); process.exit(1); }
const raw = fs.readFileSync(file, 'utf8'); const crlf = raw.includes('\r\n');
let t = crlf ? raw.replace(/\r\n/g, '\n') : raw;
if (t.includes('tenantHasFinancialData')) { console.log('already  brief guard'); process.exit(0); }
const a = "/** Generates whichever scheduled briefs are due";
const b = "    try { await generateBrief(pool, t, c, 'schedule'); made.push(c); }";
if (!t.includes(a) || !t.includes(b)) { console.log('NO MATCH brief guard'); process.exit(1); }
t = t.replace(a, [
  "/** A company with no invoices, bills, bank lines or expenses has nothing to brief on: skip it (no AI cost). Re-checked every 6 hours. */",
  "const noDataSince = new Map<string, number>();",
  "async function tenantHasFinancialData(pool: Pool, t: string): Promise<boolean> {",
  "  const skipped = noDataSince.get(t);",
  "  if (skipped && Date.now() - skipped < 6 * 3600_000) return false;",
  "  for (const table of ['ar_invoices', 'ap_invoices', 'bank_transactions', 'expenses']) {",
  "    const r = await pool.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 LIMIT 1`, [t]).catch(() => null);",
  "    if (r && r.rowCount) { noDataSince.delete(t); return true; }",
  "  }",
  "  noDataSince.set(t, Date.now());",
  "  return false;",
  "}",
  "",
  a].join('\n'));
t = t.replace(b, "    if (!(await tenantHasFinancialData(pool, t))) break;   // nothing to brief on yet\n" + b);
fs.writeFileSync(file, crlf ? t.replace(/\n/g, '\r\n') : t);
console.log('patched  ' + path.relative(process.cwd(), file) + ': briefs skip companies with no data');
