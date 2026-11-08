// Tenant isolation fixes. Run from the backend folder. Idempotent.
const fs=require('fs'),path=require('path');
const MARK='/*tenant-iso*/';
function edit(rel,pairs){
  const p=path.join('src','routes',rel);
  if(!fs.existsSync(p)){console.log('MISSING',p);process.exitCode=1;return;}
  let s=fs.readFileSync(p,'utf8');
  if(s.includes(MARK)){console.log('already patched',rel);return;}
  const crlf=s.includes('\r\n'); if(crlf) s=s.replace(/\r\n/g,'\n');
  for(const [a,b] of pairs){
    if(s.split(a).length!==2){console.log('ANCHOR NOT FOUND/UNIQUE in',rel,':',a.slice(0,70));process.exitCode=1;return;}
    s=s.replace(a,()=>b);
  }
  s=s.replace(/\n/,'\n'+MARK+'\n'); // marker after first line (keeps BOM on line 1)
  if(crlf) s=s.replace(/\n/g,'\r\n');
  fs.writeFileSync(p,s); console.log('patched',rel);
}
const own=(table,idExpr)=>`const own = await pool.query('SELECT 1 FROM ${table} WHERE id=$1 AND tenant_id=$2', [${idExpr}, tid(req)]);
      if (!own.rows.length) return res.status(404).json({ error: 'Not found' }) as any;
      `;

edit('crmRoutes.ts',[
[`      const result = await pool.query(
        \`SELECT * FROM crm_activities WHERE lead_id=$1 ORDER BY date DESC\``,
 `      ${own('crm_leads','req.params.id')}const result = await pool.query(
        \`SELECT * FROM crm_activities WHERE lead_id=$1 ORDER BY date DESC\``],
[`      const { type, date, notes, next_action } = req.body;
      const result = await pool.query(
        \`INSERT INTO crm_activities`,
 `      const { type, date, notes, next_action } = req.body;
      ${own('crm_leads','req.params.id')}const result = await pool.query(
        \`INSERT INTO crm_activities`],
]);

edit('missingDocsRoutes.ts',[
[`      const total = parseFloat(principal_component) + parseFloat(interest_component);
      const result`,
 `      const total = parseFloat(principal_component) + parseFloat(interest_component);
      ${own('loan_agreements','req.params.id')}const result`],
[`outstanding_balance=outstanding_balance-$1, updated_at=NOW() WHERE id=$2',
        [principal_component, req.params.id]`,
 `outstanding_balance=outstanding_balance-$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3',
        [principal_component, req.params.id, tid(req)]`],
[`      const result = await pool.query('SELECT * FROM loan_repayments WHERE loan_id=$1 ORDER BY payment_date DESC', [req.params.id]);`,
 `      const result = await pool.query('SELECT * FROM loan_repayments WHERE loan_id=$1 AND tenant_id=$2 ORDER BY payment_date DESC', [req.params.id, tid(req)]);`],
]);

edit('batch2DocsRoutes.ts',[
[`      const { recovery_date, principal_recovered, payslip_month } = req.body;
      await pool.query(`,
 `      const { recovery_date, principal_recovered, payslip_month } = req.body;
      ${own('employee_loans','req.params.id')}await pool.query(`],
[`total_recovered=total_recovered+$1, updated_at=NOW() WHERE id=$2',
        [principal_recovered, req.params.id]`,
 `total_recovered=total_recovered+$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3',
        [principal_recovered, req.params.id, tid(req)]`],
]);

edit('budgetingRoutes.ts',[
[`    try {
      const result = await pool.query('SELECT bl.*, a.name as account_name`,
 `    try {
      ${own('budgets','req.params.id')}const result = await pool.query('SELECT bl.*, a.name as account_name`],
]);

edit('billingRoutes.ts',[
[`      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;
      const crypto = require('crypto');
      const expectedSig = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET || '')
        .update(\`\${razorpay_order_id}|\${razorpay_payment_id}\`).digest('hex');

      if (expectedSig !== razorpay_signature && RAZORPAY_KEY_SECRET) {
        return res.status(400).json({ error: 'Invalid payment signature' }) as any;
      }
`,
 `      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
      const crypto = require('crypto');
      if (!RAZORPAY_KEY_SECRET) return res.status(503).json({ error: 'Payments are not configured' }) as any;
      const expectedSig = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
        .update(\`\${razorpay_order_id}|\${razorpay_payment_id}\`).digest('hex');
      const a = Buffer.from(expectedSig), b = Buffer.from(String(razorpay_signature || ''));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(400).json({ error: 'Invalid payment signature' }) as any;
      }
      // The order must belong to this tenant and not be already used; the plan comes from the order, not the request.
      const ord = await pool.query(
        "SELECT plan, status FROM billing_orders WHERE razorpay_order_id=$1 AND tenant_id=$2", [razorpay_order_id, tid(req)]);
      if (!ord.rows.length) return res.status(404).json({ error: 'Order not found' }) as any;
      if (String(ord.rows[0].status).toLowerCase() === 'paid') return res.status(409).json({ error: 'Order already processed' }) as any;
      const plan = ord.rows[0].plan;
`],
[`WHERE razorpay_order_id=$2\`,
        [razorpay_payment_id, razorpay_order_id]`,
 `WHERE razorpay_order_id=$2 AND tenant_id=$3\`,
        [razorpay_payment_id, razorpay_order_id, tid(req)]`],
]);

const AT="automation_logs WHERE automation_type=";
const del=t=>[`await pool.query("DELETE FROM ${AT}'${t}' AND created_at > NOW()-INTERVAL '24 hours'");`,
              `await pool.query("DELETE FROM ${AT}'${t}' AND tenant_id=$1 AND created_at > NOW()-INTERVAL '24 hours'", [tid(req)]);`];
edit('automationTestRoutes.ts',[
[`(req as any).user?.tenantId || 'af1845e2-39f3-4e9d-b1ed-91c2798a0f6f'`,`(req as any).user.tenantId`],
[`async (_req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT automation_type, status, COUNT(*) as count FROM automation_logs GROUP BY automation_type, status');`,
 `async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT automation_type, status, COUNT(*) as count FROM automation_logs WHERE tenant_id=$1 GROUP BY automation_type, status', [tid(req)]);`],
["'SELECT status FROM ap_invoices WHERE id=$1', [invoice.id]","'SELECT status FROM ap_invoices WHERE id=$1 AND tenant_id=$2', [invoice.id, tenantId]"],
["'SELECT status FROM expense_claims WHERE id=$1', [claim.id]","'SELECT status FROM expense_claims WHERE id=$1 AND tenant_id=$2', [claim.id, tenantId]"],
del('LOW_CASH_ALERT'),del('COMPLIANCE_ALERT'),del('PAYMENT_SCHEDULED'),del('STATUTORY_ALERT'),
]);
