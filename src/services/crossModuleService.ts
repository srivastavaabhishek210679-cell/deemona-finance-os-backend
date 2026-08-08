import { Pool } from 'pg';

export async function postPayrollToGL(pool: Pool, tenantId: string, payrollRunId: string, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query('SELECT * FROM payroll_runs WHERE id = $1 AND tenant_id = $2', [payrollRunId, tenantId]);
    if (!run.rows.length) return;
    const r = run.rows[0];
    const accounts = await client.query("SELECT code, id FROM accounts WHERE tenant_id = $1 AND code IN ('5100','2300','1010','2200')", [tenantId]);
    const accMap: Record<string,string> = {};
    for (const acc of accounts.rows) accMap[acc.code] = acc.id;
    if (!accMap['5100'] || !accMap['1010']) { console.log('[CrossModule] Missing GL accounts for payroll'); return; }
    const entNum = await client.query("SELECT next_accounting_number($1, 'journal_entry', 'JE') AS num", [tenantId]);
    const monthName = new Date(r.year, r.month - 1).toLocaleString('en-IN', { month: 'long' });
    const je = await client.query(
      "INSERT INTO journal_entries (tenant_id, entry_number, date, description, status, entry_type, posted_by, posted_at) VALUES ($1,$2,CURRENT_DATE,$3,'posted','system',$4,NOW()) RETURNING id",
      [tenantId, entNum.rows[0].num, 'Payroll - ' + monthName + ' ' + r.year, actorId]
    );
    const lines = [
      { account_id: accMap['5100'], description: 'Gross Salary - ' + monthName, debit: r.total_gross, credit: 0 },
      { account_id: accMap['1010'], description: 'Net Salary Paid - ' + monthName, debit: 0, credit: r.total_net },
    ];
    if (accMap['2200'] && parseFloat(r.total_tds) > 0) lines.push({ account_id: accMap['2200'], description: 'TDS Payable', debit: 0, credit: r.total_tds });
    if (accMap['2300'] && parseFloat(r.total_employer_pf) > 0) lines.push({ account_id: accMap['2300'], description: 'PF Employer', debit: 0, credit: r.total_employer_pf });
    for (const line of lines) {
      await client.query('INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit) VALUES ($1,$2,$3,$4,$5)',
        [je.rows[0].id, line.account_id, line.description, line.debit, line.credit]);
    }
    await client.query('COMMIT');
    console.log('[CrossModule] Payroll posted to GL:', entNum.rows[0].num);
  } catch (err) { await client.query('ROLLBACK'); console.error('[CrossModule] payroll GL error:', err); }
  finally { client.release(); }
}

export async function postAPPaymentToTreasury(pool: Pool, tenantId: string, apInvoiceId: string, bankAccountId: string, paymentRef: string, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = await client.query('SELECT ap.*, v.name as vendor_name FROM ap_invoices ap JOIN vendors v ON v.id = ap.vendor_id WHERE ap.id = $1 AND ap.tenant_id = $2', [apInvoiceId, tenantId]);
    if (!inv.rows.length) return;
    const ap = inv.rows[0];
    const bal = await client.query('SELECT current_balance FROM bank_accounts WHERE id = $1 AND tenant_id = $2', [bankAccountId, tenantId]);
    if (!bal.rows.length) return;
    const newBalance = parseFloat(bal.rows[0].current_balance) - parseFloat(ap.balance_due);
    await client.query('INSERT INTO bank_transactions (tenant_id, bank_account_id, date, value_date, description, reference, type, amount, balance_after, category, vendor_id, ap_invoice_id) VALUES ($1,$2,CURRENT_DATE,CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9,$10)',
      [tenantId, bankAccountId, 'Payment to ' + ap.vendor_name + ' - ' + ap.invoice_number, paymentRef, 'debit', ap.balance_due, newBalance, 'vendor_payment', ap.vendor_id, apInvoiceId]);
    await client.query('UPDATE bank_accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2', [newBalance, bankAccountId]);
    await client.query("UPDATE ap_invoices SET status='paid', paid_amount=total_amount, updated_at=NOW() WHERE id=$1", [apInvoiceId]);
    await client.query('COMMIT');
    console.log('[CrossModule] AP payment posted to Treasury');
  } catch (err) { await client.query('ROLLBACK'); console.error('[CrossModule] AP treasury error:', err); }
  finally { client.release(); }
}

export async function postARReceiptToTreasury(pool: Pool, tenantId: string, arInvoiceId: string, bankAccountId: string, paymentRef: string, amount: number, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = await client.query('SELECT ar.*, c.name as customer_name FROM ar_invoices ar JOIN customers c ON c.id = ar.customer_id WHERE ar.id = $1 AND ar.tenant_id = $2', [arInvoiceId, tenantId]);
    if (!inv.rows.length) return;
    const ar = inv.rows[0];
    const bal = await client.query('SELECT current_balance FROM bank_accounts WHERE id = $1 AND tenant_id = $2', [bankAccountId, tenantId]);
    if (!bal.rows.length) return;
    const newBalance = parseFloat(bal.rows[0].current_balance) + amount;
    const newPaid = parseFloat(ar.paid_amount || 0) + amount;
    const newStatus = newPaid >= parseFloat(ar.total_amount) ? 'paid' : 'partially_paid';
    await client.query('INSERT INTO bank_transactions (tenant_id, bank_account_id, date, value_date, description, reference, type, amount, balance_after, category, customer_id, ar_invoice_id) VALUES ($1,$2,CURRENT_DATE,CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9,$10)',
      [tenantId, bankAccountId, 'Receipt from ' + ar.customer_name + ' - ' + ar.invoice_number, paymentRef, 'credit', amount, newBalance, 'customer_receipt', ar.customer_id, arInvoiceId]);
    await client.query('UPDATE bank_accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2', [newBalance, bankAccountId]);
    await client.query('UPDATE ar_invoices SET status=$1, paid_amount=$2, updated_at=NOW() WHERE id=$3', [newStatus, newPaid, arInvoiceId]);
    await client.query('COMMIT');
    console.log('[CrossModule] AR receipt posted to Treasury');
  } catch (err) { await client.query('ROLLBACK'); console.error('[CrossModule] AR treasury error:', err); }
  finally { client.release(); }
}

export async function postExpenseToGL(pool: Pool, tenantId: string, claimId: string, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query('SELECT * FROM expense_claims WHERE id = $1 AND tenant_id = $2', [claimId, tenantId]);
    if (!claim.rows.length) return;
    const c = claim.rows[0];
    const accounts = await client.query("SELECT code, id FROM accounts WHERE tenant_id = $1 AND code IN ('5900','2000')", [tenantId]);
    const accMap: Record<string,string> = {};
    for (const acc of accounts.rows) accMap[acc.code] = acc.id;
    if (!accMap['5900']) return;
    const entNum = await client.query("SELECT next_accounting_number($1, 'journal_entry', 'JE') AS num", [tenantId]);
    const je = await client.query("INSERT INTO journal_entries (tenant_id, entry_number, date, description, status, entry_type, posted_by, posted_at) VALUES ($1,$2,CURRENT_DATE,$3,'posted','system',$4,NOW()) RETURNING id",
      [tenantId, entNum.rows[0].num, 'Expense Claim - ' + c.claim_number, actorId]);
    await client.query('INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit) VALUES ($1,$2,$3,$4,$5)',
      [je.rows[0].id, accMap['5900'], c.title, c.approved_amount, 0]);
    if (accMap['2000']) {
      await client.query('INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit) VALUES ($1,$2,$3,$4,$5)',
        [je.rows[0].id, accMap['2000'], 'Expense Payable - ' + c.employee_name, 0, c.approved_amount]);
    }
    await client.query('COMMIT');
    console.log('[CrossModule] Expense posted to GL:', entNum.rows[0].num);
  } catch (err) { await client.query('ROLLBACK'); console.error('[CrossModule] expense GL error:', err); }
  finally { client.release(); }
}
