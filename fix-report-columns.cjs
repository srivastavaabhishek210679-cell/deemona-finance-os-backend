const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/reportEngine.ts';
let c = fs.readFileSync(f, 'utf8');

// Fix 1: employees - salary -> basic_salary
c = c.replace(/COALESCE\(SUM\(salary\),0\) as total_salary/g, 'COALESCE(SUM(basic_salary),0) as total_salary');
c = c.replace(/COALESCE\(AVG\(salary\),0\) as avg_salary/g, 'COALESCE(AVG(basic_salary),0) as avg_salary');
c = c.replace(/COALESCE\(SUM\(salary\),0\) as payroll/g, 'COALESCE(SUM(basic_salary),0) as payroll');

// Fix 2: inventory - quantity -> current_stock, reorder_level -> reorder_qty
c = c.replace(/SUM\(quantity \* unit_cost\)/g, 'SUM(current_stock * unit_cost)');
c = c.replace(/quantity \* unit_cost as value/g, 'current_stock * unit_cost as value');
c = c.replace(/quantity<=reorder_level/g, 'current_stock<=reorder_qty');
c = c.replace(/quantity=0/g, 'current_stock=0');
c = c.replace(/COUNT\(CASE WHEN quantity <= reorder_level/g, 'COUNT(CASE WHEN current_stock <= reorder_qty');
c = c.replace(/\bquantity\b, reorder_level/g, 'current_stock, reorder_qty');
c = c.replace(/ORDER BY quantity ASC/g, 'ORDER BY current_stock ASC');

// Fix 3: budget - budget_transactions -> budget_lines, amount -> annual_total
c = c.replace(/FROM budget_transactions bt ON bt\.budget_id=b\.id/g, 'FROM budget_lines bt ON bt.budget_id=b.id');
c = c.replace(/COALESCE\(SUM\(bt\.amount\),0\) as spent/g, 'COALESCE(SUM(bt.annual_total),0) as spent');

fs.writeFileSync(f, c, 'utf8');
console.log('Fixed. Size:', fs.statSync(f).size);

// Verify
console.log('basic_salary:', (c.match(/basic_salary/g)||[]).length, 'occurrences');
console.log('current_stock:', (c.match(/current_stock/g)||[]).length, 'occurrences');
console.log('budget_lines:', (c.match(/budget_lines/g)||[]).length, 'occurrences');
