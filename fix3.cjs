const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/reportEngine.ts';
let c = fs.readFileSync(f, 'utf8');

// Fix all quantity*unit_cost -> current_stock*unit_cost
c = c.replace(/quantity\*unit_cost/g, 'current_stock*unit_cost');

// Fix display in HTML template - r.quantity -> r.current_stock, r.reorder_level -> r.reorder_qty
c = c.replace(/\$\{r\.quantity\}/g, '${r.current_stock}');
c = c.replace(/\$\{r\.reorder_level\}/g, '${r.reorder_qty}');

// Fix budgets - b.amount -> b.annual_budget or total column
// Check what columns budgets has
c = c.replace(/b\.amount as budgeted/g, 'COALESCE(b.total_budget,0) as budgeted');
c = c.replace(/ORDER BY b\.amount DESC/g, 'ORDER BY budgeted DESC');

fs.writeFileSync(f, c, 'utf8');
console.log('quantity remaining:', (c.match(/\bquantity\b/g)||[]).length);
console.log('current_stock:', (c.match(/current_stock/g)||[]).length);
