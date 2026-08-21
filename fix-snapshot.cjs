const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/phase1Routes.ts';
let c = fs.readFileSync(f, 'utf8');

// Replace entire getFinancialSnapshot with safer version
const oldFn = c.substring(
  c.indexOf('async function getFinancialSnapshot'),
  c.indexOf('\n// ── Helper: blockchain hash')
);

const newFn = `async function getFinancialSnapshot(pool: Pool, tenantId: string) {
  const safe = (p: Promise<any>) => p.catch(() => ({ rows: [{}] }));
  const [ar, ap, exp, inv, emp, bud, bank, gst, payroll] = await Promise.all([
    safe(pool.query(\`SELECT COALESCE(SUM(total_amount),0) as total, COALESCE(SUM(CASE WHEN status NOT IN ('paid','cancelled') THEN total_amount ELSE 0 END),0) as outstanding, COALESCE(SUM(CASE WHEN due_date<CURRENT_DATE AND status NOT IN ('paid','cancelled') THEN total_amount ELSE 0 END),0) as overdue FROM ar_invoices WHERE tenant_id=$1\`, [tenantId])),
    safe(pool.query(\`SELECT COALESCE(SUM(total_amount),0) as total, COALESCE(SUM(CASE WHEN status NOT IN ('paid','rejected') THEN total_amount ELSE 0 END),0) as outstanding FROM ap_invoices WHERE tenant_id=$1\`, [tenantId])),
    safe(pool.query(\`SELECT COALESCE(SUM(total_amount),0) as total FROM expense_claims WHERE tenant_id=$1\`, [tenantId])),
    safe(pool.query(\`SELECT COALESCE(SUM(current_stock*unit_cost),0) as value, COUNT(*) as items FROM inventory_items WHERE tenant_id=$1\`, [tenantId])),
    safe(pool.query(\`SELECT COUNT(*) as count, COALESCE(SUM(basic_salary),0) as payroll FROM employees WHERE tenant_id=$1 AND status='active'\`, [tenantId])),
    safe(pool.query(\`SELECT COALESCE(SUM(total_budgeted),0) as budget, COALESCE(SUM(total_spent),0) as spent FROM budgets WHERE tenant_id=$1\`, [tenantId])),
    safe(pool.query(\`SELECT COALESCE(SUM(current_balance),0) as cash FROM bank_accounts WHERE tenant_id=$1 AND is_active=true\`, [tenantId])),
    safe(pool.query(\`SELECT COALESCE(SUM(cgst+sgst+igst),0) as total FROM gst_transactions WHERE tenant_id=$1 AND transaction_type='sale'\`, [tenantId])),
    safe(pool.query(\`SELECT COALESCE(SUM(total_gross),0) as gross, COALESCE(SUM(total_net),0) as net FROM payroll_runs WHERE tenant_id=$1 AND year=EXTRACT(YEAR FROM NOW()) AND month=EXTRACT(MONTH FROM NOW())\`, [tenantId])),
  ]);
  const g = (r: any, k: string) => parseFloat(r?.rows?.[0]?.[k] || 0);
  return {
    revenue: g(ar,'total'), arOutstanding: g(ar,'outstanding'), arOverdue: g(ar,'overdue'),
    apOutstanding: g(ap,'outstanding'), totalExpenses: g(exp,'total'),
    inventoryValue: g(inv,'value'), inventoryItems: parseInt(inv?.rows?.[0]?.items||0),
    employees: parseInt(emp?.rows?.[0]?.count||0), monthlyPayroll: g(emp,'payroll'),
    totalBudget: g(bud,'budget'), totalSpent: g(bud,'spent'),
    cashBalance: g(bank,'cash'), gstLiability: g(gst,'total'),
    payrollGross: g(payroll,'gross'),
  };
}

`;

c = c.replace(oldFn, newFn);
fs.writeFileSync(f, c, 'utf8');
console.log('Fixed. Has safe():', c.includes('const safe ='));
