const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/services/automationEngine.ts';
let c = fs.readFileSync(f, 'utf8');

// Fix: use crm_leads not customers
c = c.split('FROM customers WHERE id=$1').join('FROM crm_leads WHERE id=$1');
c = c.split("INTO customers (tenant_id, name, email, industry, status, notes, created_at)").join(
  "INTO crm_leads (tenant_id, contact_name, contact_email, company_name, status, notes, created_at)"
);
c = c.split('deal.name').join('deal.contact_name || \' - \' || deal.company_name');

// Fix expense_claims columns - total_amount not amount
c = c.split('expense.amount').join('expense.total_amount');
c = c.split("status='Pending'").join("status='submitted'");
c = c.split("status='Approved'").join("status='approved'");

// Fix ap_invoices - ensure correct column names
// ap_invoices uses balance_due and total_amount
c = c.split('invoice.total_amount').join("COALESCE(invoice.total_amount, invoice.balance_due, 0)");

fs.writeFileSync(f, c, 'utf8');
console.log('Fixed crm_leads and expense column names');
console.log('crm_leads:', c.includes('crm_leads'));
console.log('total_amount:', c.includes('total_amount'));
