// Accounting Agent: gives it vendor-level payables and customer-level receivables (so "which vendor has the highest payable" is answerable)
// and stops it raising alarms, drafting journal entries or estimating GST/ITC unless asked. Idempotent. Run from the backend folder.
const fs = require('fs');
const f = 'src/services/accountingAgent.ts';
if (!fs.existsSync(f)) { console.error('Run this from the backend folder'); process.exit(1); }
const raw = fs.readFileSync(f, 'utf8'); const bom = raw.charCodeAt(0) === 0xFEFF; const crlf = raw.includes('\r\n');
let s = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
if (s.includes('OPEN PAYABLES BY VENDOR')) { console.log('no change', f); process.exit(0); }
const need = (a) => { if (!s.includes(a)) { console.error('anchor not found in ' + f + ': ' + a.slice(0, 70)); process.exit(1); } };
const sub = (a, b) => { need(a); s = s.replace(a, () => b); };

sub("const [accounts, recentEntries, apSummary, arSummary] = await Promise.all([",
    "const [accounts, recentEntries, apSummary, arSummary, apByVendor, arByCustomer] = await Promise.all([");

sub("    ),\n  ]);\n\n  const accountSummary", String.raw`    ),
    pool.query(
      "SELECT COALESCE(v.name,'Unknown') AS vendor, COUNT(*)::int AS bills, COALESCE(SUM(i.balance_due),0) AS outstanding, " +
      "COUNT(*) FILTER (WHERE i.due_date < CURRENT_DATE)::int AS overdue_bills " +
      "FROM ap_invoices i LEFT JOIN vendors v ON v.id = i.vendor_id AND v.tenant_id = i.tenant_id " +
      "WHERE i.tenant_id = $1 AND i.status NOT IN ('paid','rejected','draft') AND i.balance_due > 0 " +
      "GROUP BY v.name ORDER BY outstanding DESC LIMIT 10",
      [tenantId]
    ),
    pool.query(
      "SELECT COALESCE(c.name,'Unknown') AS customer, COUNT(*)::int AS invoices, COALESCE(SUM(i.balance_due),0) AS outstanding, " +
      "COUNT(*) FILTER (WHERE i.due_date < CURRENT_DATE)::int AS overdue_invoices " +
      "FROM ar_invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id " +
      "WHERE i.tenant_id = $1 AND i.status NOT IN ('paid','cancelled','draft') AND i.balance_due > 0 " +
      "GROUP BY c.name ORDER BY outstanding DESC LIMIT 10",
      [tenantId]
    ),
  ]);

  const accountSummary`);

sub("  const ap = apSummary.rows[0];\n  const ar = arSummary.rows[0];", String.raw`  const ap = apSummary.rows[0];
  const ar = arSummary.rows[0];
  const money = (n: any): string => 'INR ' + parseFloat(n).toLocaleString('en-IN');
  const apVendors = apByVendor.rows.map((r: any) => '  ' + r.vendor + ' | ' + r.bills + ' open bills | Outstanding: ' + money(r.outstanding) + ' | Overdue bills: ' + r.overdue_bills).join('\n');
  const arCustomers = arByCustomer.rows.map((r: any) => '  ' + r.customer + ' | ' + r.invoices + ' open invoices | Outstanding: ' + money(r.outstanding) + ' | Overdue invoices: ' + r.overdue_invoices).join('\n');
  const extra = '\n\nOPEN PAYABLES BY VENDOR (largest first):\n' + (apVendors || '  None') +
    '\n\nOPEN RECEIVABLES BY CUSTOMER (largest first):\n' + (arCustomers || '  None') +
    '\n\nNOTE: Account balances above come only from POSTED journal entries. The payables and receivables summaries and the vendor and customer lists come from the invoice sub-ledgers. The two can differ when invoices have not been journalised.';`);

sub("  Overdue: $" + "{ar.overdue}\n`.trim();", "  Overdue: $" + "{ar.overdue}\n`.trim() + extra;");

sub("You are NOT a replacement for a CA — always recommend professional review for significant decisions.`;",
    "Answer only from the data in the context. Use the vendor and customer lists to answer questions about who owes what. If the data does not contain the answer, say what is missing in one sentence and stop. " +
    "Account balances come only from posted journal entries while invoice totals come from the sub-ledgers, so a difference between them is an observation to mention calmly (the invoices may not be journalised yet), not a critical error. " +
    "Do not draft journal entries, estimate GST or input tax credit, or suggest corrective entries unless the user asks for them. Do not add a closing checklist of next steps. Quote amounts exactly as given.\n\n" +
    "You are NOT a replacement for a CA — always recommend professional review for significant decisions.`;");

fs.writeFileSync(f, (bom ? '﻿' : '') + (crlf ? s.replace(/\n/g, '\r\n') : s)); console.log('patched', f);
