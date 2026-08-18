const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/services/automationEngine.ts';
let c = fs.readFileSync(f, 'utf8');

// Fix table names to match actual backend DB
c = c.split('generated_invoices').join('ap_invoices');
c = c.split('invoice_id=$1').join('id=$1');
c = c.split('invoice_id::text').join('id::text');
c = c.split('invoice_id,').join('id,');
c = c.split("SET status='approved' WHERE invoice_id").join("SET status='approved', updated_at=NOW() WHERE id");
c = c.split('SET status=$1 WHERE invoice_id').join('SET status=$1, updated_at=NOW() WHERE id');
c = c.split('invoice_id as id').join('id');

// Fix expenses table
c = c.split("INTO expenses (tenant_id, title, description, amount, status, expense_date, employee_name, category, created_at)").join(
  "INTO expense_claims (tenant_id, title, description, amount, status, expense_date, employee_name, category, created_at)"
);
c = c.split('FROM expenses WHERE expense_id=$1').join('FROM expense_claims WHERE id=$1');
c = c.split("SET status='Approved' WHERE expense_id=$1").join("SET status='approved', updated_at=NOW() WHERE id=$1");
c = c.split('expense_id as id').join('id');

// Fix deals table -> crm_leads or customers
c = c.split('FROM deals WHERE deal_id=$1').join('FROM customers WHERE id=$1');
c = c.split('INTO deals (tenant_id, deal_name, customer_name, deal_value, stage, status, notes, expected_close)').join(
  'INTO customers (tenant_id, name, email, industry, status, notes, created_at)'
);
c = c.split('deal_id as id, deal_name as contact_name').join('id, name as contact_name');
c = c.split('deal.deal_name').join('deal.name');
c = c.split('deal.customer_name').join('deal.name');
c = c.split('deal.deal_value').join('0');

// Fix purchase_orders table
c = c.split('FROM purchase_orders po').join('FROM purchase_orders po');
c = c.split('po.supplier_id=s.supplier_id').join('po.vendor_id=s.id');
c = c.split('s.name as vendor_name').join('COALESCE(s.name, po.vendor_name) as vendor_name');
c = c.split('po.expected_delivery').join('po.expected_delivery_date');

// Add v4 marker
c = c.replace('// ============================================================', '// v4 - correct table names\n// ============================================================');

fs.writeFileSync(f, c, 'utf8');
console.log('Fixed table names');
console.log('Uses ap_invoices:', c.includes('ap_invoices'));
console.log('Uses expense_claims:', c.includes('expense_claims'));
console.log('Uses customers:', c.includes('FROM customers'));
