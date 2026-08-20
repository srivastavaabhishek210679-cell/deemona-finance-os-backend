const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/reportEngine.ts';
let c = fs.readFileSync(f, 'utf8');

// Replace ALL remaining quantity/budget_transactions references
c = c.replace(/quantity \* unit_cost/g, 'current_stock * unit_cost');
c = c.replace(/quantity<=reorder_level/g, 'current_stock<=reorder_qty');
c = c.replace(/quantity=0/g, 'current_stock=0');
c = c.replace(/\bquantity\b, reorder_level/g, 'current_stock, reorder_qty');
c = c.replace(/ORDER BY quantity/g, 'ORDER BY current_stock');
c = c.replace(/COUNT\(CASE WHEN quantity/g, 'COUNT(CASE WHEN current_stock');
c = c.replace(/budget_transactions bt ON bt\.budget_id/g, 'budget_lines bt ON bt.budget_id');
c = c.replace(/SUM\(bt\.amount\)/g, 'SUM(bt.annual_total)');

fs.writeFileSync(f, c, 'utf8');

// Verify no more bad references
const qty = (c.match(/\bquantity\b/g)||[]).length;
const bt = (c.match(/budget_transactions/g)||[]).length;
console.log('Remaining quantity:', qty);
console.log('Remaining budget_transactions:', bt);
console.log('current_stock occurrences:', (c.match(/current_stock/g)||[]).length);
console.log('budget_lines occurrences:', (c.match(/budget_lines/g)||[]).length);
