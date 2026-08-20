const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/dataIngestionRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

// Fix 1: AR invoices - add tax_amount and net_value fallback
c = c.replace(
  `            await pool.query(
              \`INSERT INTO ar_invoices (tenant_id, invoice_number, customer_id, date, due_date, total_amount, status, notes)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (tenant_id, invoice_number) DO UPDATE SET
               total_amount=EXCLUDED.total_amount, status=EXCLUDED.status, updated_at=NOW()\`,
              [tenantId, invNum, custId, date, dueDate, amount, status.toLowerCase(), get(row, 'description')]
            );`,
  `            const taxAmt = parseAmt(get(row, 'tax_amount'));
            // Use net_value if amount is 0, fallback to gross
            const finalAmt = amount || parseAmt(get(row, 'net_value')) || parseAmt(get(row, 'total'));
            await pool.query(
              \`INSERT INTO ar_invoices (tenant_id, invoice_number, customer_id, date, due_date, total_amount, tax_amount, status, notes)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (tenant_id, invoice_number) DO UPDATE SET
               total_amount=EXCLUDED.total_amount, tax_amount=EXCLUDED.tax_amount, status=EXCLUDED.status, updated_at=NOW()\`,
              [tenantId, invNum, custId, date, dueDate, finalAmt, taxAmt, status.toLowerCase(), get(row, 'description')]
            );`
);

// Fix 2: Also handle net_value as total_amount alias in parseAmt calls
// Make sure SALES_INVOICES case reads all amount variants
c = c.replace(
  `const amount = parseAmt(get(row, 'total_amount'));
            const date = parseDate(get(row, 'date')) || new Date().toISOString().split('T')[0];
            const dueDate = parseDate(get(row, 'due_date')) || new Date(Date.now()+30*86400000).toISOString().split('T')[0];
            const status = get(row, 'status') || 'sent';`,
  `const amount = parseAmt(get(row, 'total_amount')) || parseAmt(get(row, 'net_value')) || parseAmt(get(row, 'gross'));
            const date = parseDate(get(row, 'date')) || new Date().toISOString().split('T')[0];
            const dueDate = parseDate(get(row, 'due_date')) || new Date(Date.now()+30*86400000).toISOString().split('T')[0];
            const status = get(row, 'status') || 'sent';`
);

fs.writeFileSync(f, c, 'utf8');
console.log('Done. Size:', fs.statSync(f).size);
