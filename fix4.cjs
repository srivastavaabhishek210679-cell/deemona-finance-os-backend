const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/reportEngine.ts';
let c = fs.readFileSync(f, 'utf8');

// Fix budget query - use total_budgeted and total_spent directly from budgets table
c = c.replace(
  /pool\.query\(`SELECT b\.name, COALESCE\(b\.total_budget,0\) as budgeted, COALESCE\(SUM\(bt\.annual_total\),0\) as spent FROM budgets b LEFT JOIN budget_lines bt ON bt\.budget_id=b\.id WHERE b\.tenant_id=\$1 GROUP BY b\.id,b\.name,b\.amount ORDER BY budgeted DESC`/g,
  "pool.query(`SELECT name, total_budgeted as budgeted, total_spent as spent FROM budgets WHERE tenant_id=$1 ORDER BY total_budgeted DESC`"
);

// Also fix simpler version
c = c.replace(
  /SELECT b\.name, COALESCE\(b\.total_budget,0\) as budgeted, COALESCE\(SUM\(bt\.annual_total\),0\) as spent\s+FROM budgets b LEFT JOIN budget_lines bt ON bt\.budget_id=b\.id\s+WHERE b\.tenant_id=\$1 GROUP BY b\.id,b\.name,b\.amount ORDER BY budgeted DESC/g,
  'SELECT name, total_budgeted as budgeted, total_spent as spent FROM budgets WHERE tenant_id=$1 ORDER BY total_budgeted DESC'
);

// Fix budget totals query 
c = c.replace(
  /COALESCE\(SUM\(amount\),0\) as total_budget,\s+COALESCE\(SUM\(CASE WHEN status='active' THEN amount ELSE 0 END\),0\) as active_budget\s+FROM budgets WHERE tenant_id=\$1/g,
  "COALESCE(SUM(total_budgeted),0) as total_budget, COALESCE(SUM(total_spent),0) as active_budget FROM budgets WHERE tenant_id=$1"
);

fs.writeFileSync(f, c, 'utf8');
console.log('Done. budget_lines:', (c.match(/budget_lines/g)||[]).length);
console.log('total_budgeted:', (c.match(/total_budgeted/g)||[]).length);
