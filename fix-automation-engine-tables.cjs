const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/services/automationEngine.ts';
let c = fs.readFileSync(f, 'utf8');

// Fix automation_logs insert - cast tenant_id to UUID safely
c = c.split(
  `await pool.query(
      \`INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT DO NOTHING\`,`
).join(
  `await pool.query(
      \`INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at)
       VALUES ($1::uuid,$2,$3,$4,NOW())\`,`
);

// Fix ap_invoices -> generated_invoices
c = c.split('FROM ap_invoices').join('FROM generated_invoices');
c = c.split('INTO ap_invoices').join('INTO generated_invoices');
c = c.split('UPDATE ap_invoices').join('UPDATE generated_invoices');
c = c.split('i.id=$1').join('i.invoice_id=$1');
c = c.split('id=$1').join('invoice_id=$1');

// Fix expense_claims -> expenses  
c = c.split('FROM expense_claims').join('FROM expenses');
c = c.split('INTO expense_claims').join('INTO expenses');
c = c.split('UPDATE expense_claims').join('UPDATE expenses');

// Fix crm_leads -> deals
c = c.split('FROM crm_leads').join('FROM deals');
c = c.split('INTO crm_leads').join('INTO deals');

// Fix ar_invoices -> generated_invoices (for bank recon)
c = c.split('FROM ar_invoices').join('FROM generated_invoices');
c = c.split('UPDATE ar_invoices').join('UPDATE generated_invoices');

// Fix bank_transactions -> vendor_payments (closest equivalent)
c = c.split('FROM bank_transactions').join('FROM vendor_payments');
c = c.split('UPDATE bank_transactions').join('UPDATE vendor_payments');

// Fix compliance_items columns - check actual table
c = c.split("WHERE tenant_id=$1 AND status='pending'").join("WHERE tenant_id::text=$1::text AND status='pending'");

// Add v3 marker
c = c.replace('// v2 - dynamic tenant email', '// v3 - correct table names');

fs.writeFileSync(f, c, 'utf8');
console.log('Fixed automationEngine.ts table names');
console.log('generated_invoices:', c.includes('generated_invoices'));
console.log('expenses:', c.includes('FROM expenses'));
console.log('deals:', c.includes('FROM deals'));
