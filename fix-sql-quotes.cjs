const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/services/automationEngine.ts';
let lines = fs.readFileSync(f, 'utf8').split('\n');

// Fix line 85 (index 84): SQL with unescaped single quotes
// Replace single-quoted SQL containing single quotes with backtick template
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('INTERVAL') && lines[i].includes("'30 days'") && lines[i].includes("pool.query('SELECT")) {
    lines[i] = "    const result = await pool.query(`SELECT COALESCE(SUM(total_amount),0) as burn FROM expense_claims WHERE created_at > NOW()-INTERVAL '30 days'`);";
    console.log('Fixed line', i+1, '- monthly burn query');
  }
  if (lines[i].includes('purchase_orders po LEFT JOIN') && lines[i].includes("pool.query(")) {
    // This might span multiple lines - fix the query line
    lines[i] = "      `SELECT po.*, v.name as vendor_name FROM purchase_orders po LEFT JOIN vendors v ON po.vendor_id=v.id WHERE po.status IN ('approved','Approved') AND po.expected_date BETWEEN NOW() AND NOW()+INTERVAL '3 days' LIMIT 10`";
    console.log('Fixed line', i+1, '- vendor payment query');
  }
  // Also fix compliance query with single quotes
  if (lines[i].includes("status NOT IN ('Completed','Closed')") && lines[i].includes("pool.query('SELECT")) {
    lines[i] = "    const result = await pool.query(`SELECT * FROM compliance_items WHERE status NOT IN ('Completed','Closed') AND due_date BETWEEN NOW() AND NOW() + INTERVAL '7 days' LIMIT 10`);";
    console.log('Fixed line', i+1, '- compliance query');
  }
  // Fix automation_logs query with single quotes
  if (lines[i].includes("'LOW_CASH_ALERT'") && lines[i].includes("pool.query('SELECT")) {
    lines[i] = "    const alertCheck = await pool.query(`SELECT id FROM automation_logs WHERE automation_type='LOW_CASH_ALERT' AND created_at > NOW()-INTERVAL '24 hours' LIMIT 1`);";
    console.log('Fixed line', i+1, '- alert check query');
  }
  // Fix ap_invoices status query
  if (lines[i].includes("status='pending'") && lines[i].includes("pool.query('SELECT * FROM ap_invoices")) {
    lines[i] = lines[i].replace("pool.query('SELECT * FROM ap_invoices WHERE id::text LIKE $1 AND status='pending' LIMIT 1'", "pool.query(`SELECT * FROM ap_invoices WHERE id::text LIKE $1 AND status='pending' LIMIT 1`");
    console.log('Fixed line', i+1, '- ap_invoices status query');
  }
}

fs.writeFileSync(f, lines.join('\n'), 'utf8');
console.log('Done. Checking for remaining single-quote SQL issues...');

const final = fs.readFileSync(f, 'utf8');
const problematic = final.split('\n').filter((l, i) => {
  if (!l.includes("pool.query('")) return false;
  const afterQuery = l.substring(l.indexOf("pool.query('") + 12);
  return afterQuery.includes("'") && !afterQuery.startsWith("SELECT 1");
});
if (problematic.length) {
  console.log('Still problematic lines:');
  problematic.forEach(l => console.log(' ', l.trim().substring(0, 80)));
} else {
  console.log('All SQL strings look clean!');
}
