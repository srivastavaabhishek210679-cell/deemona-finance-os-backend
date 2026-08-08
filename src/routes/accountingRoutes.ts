// ============================================================
// Deemona AI Finance OS — Accounting Routes
// File: src/routes/accountingRoutes.ts
// Mount: app.use('/api/accounting', accountingRouter(pool))
// ============================================================

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createAccountingRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── SETUP: Seed default chart of accounts ─────────────────
  router.post('/setup', requireAuth, async (req: Request, res: Response) => {
    const tenantId = tid(req);
    const defaultAccounts = [
      // Assets
      { code: '1000', name: 'Cash and Cash Equivalents', type: 'asset', sub_type: 'current_asset' },
      { code: '1010', name: 'Bank Account - Current',    type: 'asset', sub_type: 'current_asset' },
      { code: '1020', name: 'Bank Account - Savings',    type: 'asset', sub_type: 'current_asset' },
      { code: '1100', name: 'Accounts Receivable',       type: 'asset', sub_type: 'current_asset' },
      { code: '1200', name: 'Inventory',                 type: 'asset', sub_type: 'current_asset' },
      { code: '1300', name: 'Prepaid Expenses',          type: 'asset', sub_type: 'current_asset' },
      { code: '1400', name: 'GST Input Credit',          type: 'asset', sub_type: 'current_asset' },
      { code: '1500', name: 'Fixed Assets - Equipment',  type: 'asset', sub_type: 'fixed_asset' },
      { code: '1510', name: 'Fixed Assets - Furniture',  type: 'asset', sub_type: 'fixed_asset' },
      { code: '1600', name: 'Accumulated Depreciation',  type: 'asset', sub_type: 'fixed_asset' },
      // Liabilities
      { code: '2000', name: 'Accounts Payable',          type: 'liability', sub_type: 'current_liability' },
      { code: '2100', name: 'GST Payable - CGST',        type: 'liability', sub_type: 'current_liability' },
      { code: '2110', name: 'GST Payable - SGST',        type: 'liability', sub_type: 'current_liability' },
      { code: '2120', name: 'GST Payable - IGST',        type: 'liability', sub_type: 'current_liability' },
      { code: '2200', name: 'TDS Payable',               type: 'liability', sub_type: 'current_liability' },
      { code: '2300', name: 'Salary Payable',            type: 'liability', sub_type: 'current_liability' },
      { code: '2400', name: 'Short-term Loans',          type: 'liability', sub_type: 'current_liability' },
      { code: '2500', name: 'Long-term Loans',           type: 'liability', sub_type: 'long_term_liability' },
      // Equity
      { code: '3000', name: 'Share Capital',             type: 'equity', sub_type: 'equity' },
      { code: '3100', name: 'Retained Earnings',         type: 'equity', sub_type: 'equity' },
      { code: '3200', name: 'Current Year Profit/Loss',  type: 'equity', sub_type: 'equity' },
      // Income
      { code: '4000', name: 'Sales Revenue',             type: 'income', sub_type: 'operating_income' },
      { code: '4100', name: 'Service Revenue',           type: 'income', sub_type: 'operating_income' },
      { code: '4200', name: 'Other Income',              type: 'income', sub_type: 'other_income' },
      { code: '4300', name: 'Interest Income',           type: 'income', sub_type: 'other_income' },
      // Expenses
      { code: '5000', name: 'Cost of Goods Sold',        type: 'expense', sub_type: 'cogs' },
      { code: '5100', name: 'Salaries and Wages',        type: 'expense', sub_type: 'operating_expense' },
      { code: '5200', name: 'Rent Expense',              type: 'expense', sub_type: 'operating_expense' },
      { code: '5300', name: 'Utilities',                 type: 'expense', sub_type: 'operating_expense' },
      { code: '5400', name: 'Marketing and Advertising', type: 'expense', sub_type: 'operating_expense' },
      { code: '5500', name: 'Travel and Conveyance',     type: 'expense', sub_type: 'operating_expense' },
      { code: '5600', name: 'Professional Fees',         type: 'expense', sub_type: 'operating_expense' },
      { code: '5700', name: 'Depreciation',              type: 'expense', sub_type: 'operating_expense' },
      { code: '5800', name: 'Bank Charges',              type: 'expense', sub_type: 'operating_expense' },
      { code: '5900', name: 'Miscellaneous Expenses',    type: 'expense', sub_type: 'operating_expense' },
    ];

    try {
      let created = 0;
      for (const acc of defaultAccounts) {
        await pool.query(
          `INSERT INTO accounts (tenant_id, code, name, type, sub_type)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, code) DO NOTHING`,
          [tenantId, acc.code, acc.name, acc.type, acc.sub_type]
        );
        created++;
      }
      res.json({ success: true, created, message: `${created} default accounts ready` });
    } catch (err) {
      console.error('[Accounting] setup error:', err);
      res.status(500).json({ error: 'Setup failed' });
    }
  });

  // ══════════════════════════════════════════════════════════
  // CHART OF ACCOUNTS
  // ══════════════════════════════════════════════════════════

  router.get('/accounts', requireAuth, async (req: Request, res: Response) => {
    try {
      const { type } = req.query;
      let q = `SELECT * FROM accounts WHERE tenant_id = $1 AND is_active = TRUE`;
      const params: any[] = [tid(req)];
      if (type) { q += ` AND type = $2`; params.push(type); }
      q += ` ORDER BY code`;
      const result = await pool.query(q, params);
      res.json({ accounts: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/accounts', requireAuth, async (req: Request, res: Response) => {
    try {
      const { code, name, type, sub_type, description, opening_balance } = req.body;
      const result = await pool.query(
        `INSERT INTO accounts (tenant_id, code, name, type, sub_type, description, opening_balance)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [tid(req), code, name, type, sub_type, description, opening_balance ?? 0]
      );
      res.json({ account: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ══════════════════════════════════════════════════════════
  // JOURNAL ENTRIES
  // ══════════════════════════════════════════════════════════

  router.get('/journal-entries', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, from, to, limit = 50, offset = 0 } = req.query;
      let q = `SELECT je.*, 
               json_agg(json_build_object(
                 'id', jel.id, 'account_id', jel.account_id,
                 'account_name', a.name, 'account_code', a.code,
                 'description', jel.description,
                 'debit', jel.debit, 'credit', jel.credit
               )) as lines
               FROM journal_entries je
               LEFT JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
               LEFT JOIN accounts a ON a.id = jel.account_id
               WHERE je.tenant_id = $1`;
      const params: any[] = [tid(req)];
      let pIdx = 2;
      if (status) { q += ` AND je.status = $${pIdx++}`; params.push(status); }
      if (from)   { q += ` AND je.date >= $${pIdx++}`; params.push(from); }
      if (to)     { q += ` AND je.date <= $${pIdx++}`; params.push(to); }
      q += ` GROUP BY je.id ORDER BY je.date DESC, je.created_at DESC LIMIT $${pIdx++} OFFSET $${pIdx++}`;
      params.push(limit, offset);
      const result = await pool.query(q, params);
      const count = await pool.query(`SELECT COUNT(*) FROM journal_entries WHERE tenant_id = $1`, [tid(req)]);
      res.json({ entries: result.rows, total: parseInt(count.rows[0].count) });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/journal-entries', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { date, description, reference, lines, notes, entry_type } = req.body;

      // Validate double-entry balance
      const totalDebit  = lines.reduce((s: number, l: any) => s + parseFloat(l.debit  || 0), 0);
      const totalCredit = lines.reduce((s: number, l: any) => s + parseFloat(l.credit || 0), 0);
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        res.status(400).json({ error: `Debits (${totalDebit}) must equal Credits (${totalCredit})` });
        return;
      }

      const entryNumber = await client.query(
        `SELECT next_accounting_number($1, 'journal_entry', 'JE') AS num`,
        [tid(req)]
      );

      const je = await client.query(
        `INSERT INTO journal_entries (tenant_id, entry_number, date, description, reference, notes, entry_type, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'draft') RETURNING *`,
        [tid(req), entryNumber.rows[0].num, date, description, reference, notes, entry_type ?? 'manual']
      );

      for (const line of lines) {
        await client.query(
          `INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit)
           VALUES ($1,$2,$3,$4,$5)`,
          [je.rows[0].id, line.account_id, line.description, line.debit || 0, line.credit || 0]
        );
      }

      await client.query('COMMIT');
      res.json({ entry: je.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  router.patch('/journal-entries/:id/post', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `UPDATE journal_entries SET status='posted', posted_by=$1, posted_at=NOW()
         WHERE id=$2 AND tenant_id=$3 AND status='draft' RETURNING *`,
        [(req as any).user.id, req.params.id, tid(req)]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'Entry not found or already posted' }); return; }
      res.json({ entry: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ══════════════════════════════════════════════════════════
  // VENDORS
  // ══════════════════════════════════════════════════════════

  router.get('/vendors', requireAuth, async (req: Request, res: Response) => {
    try {
      const { search, active = 'true' } = req.query;
      let q = `SELECT v.*, 
               COALESCE(SUM(ap.balance_due), 0) as total_outstanding
               FROM vendors v
               LEFT JOIN ap_invoices ap ON ap.vendor_id = v.id AND ap.status NOT IN ('paid','rejected')
               WHERE v.tenant_id = $1`;
      const params: any[] = [tid(req)];
      let pIdx = 2;
      if (active === 'true') { q += ` AND v.is_active = TRUE`; }
      if (search) { q += ` AND v.name ILIKE $${pIdx++}`; params.push(`%${search}%`); }
      q += ` GROUP BY v.id ORDER BY v.name`;
      const result = await pool.query(q, params);
      res.json({ vendors: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/vendors', requireAuth, async (req: Request, res: Response) => {
    try {
      const { name, code, gstin, pan, email, phone, address, city, state, payment_terms, bank_account, ifsc, credit_limit, notes } = req.body;
      const result = await pool.query(
        `INSERT INTO vendors (tenant_id,name,code,gstin,pan,email,phone,address,city,state,payment_terms,bank_account,ifsc,credit_limit,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [tid(req), name, code, gstin, pan, email, phone, address, city, state, payment_terms ?? 30, bank_account, ifsc, credit_limit, notes]
      );
      res.json({ vendor: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/vendors/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const fields = req.body;
      const keys = Object.keys(fields).filter(k => !['id','tenant_id','created_at'].includes(k));
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const vals = keys.map(k => fields[k]);
      const result = await pool.query(
        `UPDATE vendors SET ${sets}, updated_at=NOW() WHERE id=$1 AND tenant_id=$${keys.length + 2} RETURNING *`,
        [req.params.id, ...vals, tid(req)]
      );
      res.json({ vendor: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ══════════════════════════════════════════════════════════
  // AP INVOICES (Bills)
  // ══════════════════════════════════════════════════════════

  router.get('/ap-invoices', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, vendor_id, overdue } = req.query;
      let q = `SELECT ap.*, v.name as vendor_name, v.gstin as vendor_gstin
               FROM ap_invoices ap
               JOIN vendors v ON v.id = ap.vendor_id
               WHERE ap.tenant_id = $1`;
      const params: any[] = [tid(req)];
      let pIdx = 2;
      if (status)    { q += ` AND ap.status = $${pIdx++}`; params.push(status); }
      if (vendor_id) { q += ` AND ap.vendor_id = $${pIdx++}`; params.push(vendor_id); }
      if (overdue === 'true') { q += ` AND ap.due_date < CURRENT_DATE AND ap.status NOT IN ('paid','rejected')`; }
      q += ` ORDER BY ap.due_date ASC`;
      const result = await pool.query(q, params);
      res.json({ invoices: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/ap-invoices', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { vendor_id, invoice_number, our_reference, date, due_date, lines, tax_type, gst_rate, notes } = req.body;

      const subtotal    = lines.reduce((s: number, l: any) => s + parseFloat(l.amount), 0);
      const tax_amount  = subtotal * (parseFloat(gst_rate ?? 0) / 100);
      const total_amount = subtotal + tax_amount;

      const inv = await client.query(
        `INSERT INTO ap_invoices (tenant_id,vendor_id,invoice_number,our_reference,date,due_date,subtotal,tax_amount,total_amount,tax_type,gst_rate,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [tid(req), vendor_id, invoice_number, our_reference, date, due_date, subtotal, tax_amount, total_amount, tax_type ?? 'GST', gst_rate ?? 0, notes]
      );

      for (const line of lines) {
        await client.query(
          `INSERT INTO ap_invoice_lines (ap_invoice_id, description, quantity, unit_price, amount, account_id, hsn_sac)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [inv.rows[0].id, line.description, line.quantity ?? 1, line.unit_price, line.amount, line.account_id, line.hsn_sac]
        );
      }

      await client.query('COMMIT');
      res.json({ invoice: inv.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  router.patch('/ap-invoices/:id/approve', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `UPDATE ap_invoices SET status='approved', approved_by=$1, approved_at=NOW()
         WHERE id=$2 AND tenant_id=$3 AND status='pending_approval' RETURNING *`,
        [(req as any).user.id, req.params.id, tid(req)]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'Invoice not found or not pending approval' }); return; }
      res.json({ invoice: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/ap-invoices/:id/reject', requireAuth, async (req: Request, res: Response) => {
    try {
      const { reason } = req.body;
      const result = await pool.query(
        `UPDATE ap_invoices SET status='rejected', rejected_by=$1, rejected_at=NOW(), rejection_reason=$2
         WHERE id=$3 AND tenant_id=$4 RETURNING *`,
        [(req as any).user.id, reason, req.params.id, tid(req)]
      );
      res.json({ invoice: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ══════════════════════════════════════════════════════════
  // CUSTOMERS
  // ══════════════════════════════════════════════════════════

  router.get('/customers', requireAuth, async (req: Request, res: Response) => {
    try {
      const { search } = req.query;
      let q = `SELECT c.*, COALESCE(SUM(ar.balance_due), 0) as total_outstanding
               FROM customers c
               LEFT JOIN ar_invoices ar ON ar.customer_id = c.id AND ar.status NOT IN ('paid','cancelled')
               WHERE c.tenant_id = $1 AND c.is_active = TRUE`;
      const params: any[] = [tid(req)];
      if (search) { q += ` AND c.name ILIKE $2`; params.push(`%${search}%`); }
      q += ` GROUP BY c.id ORDER BY c.name`;
      const result = await pool.query(q, params);
      res.json({ customers: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/customers', requireAuth, async (req: Request, res: Response) => {
    try {
      const { name, code, gstin, pan, email, phone, address, city, state, payment_terms, credit_limit, notes } = req.body;
      const result = await pool.query(
        `INSERT INTO customers (tenant_id,name,code,gstin,pan,email,phone,address,city,state,payment_terms,credit_limit,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [tid(req), name, code, gstin, pan, email, phone, address, city, state, payment_terms ?? 30, credit_limit, notes]
      );
      res.json({ customer: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ══════════════════════════════════════════════════════════
  // AR INVOICES (Sales)
  // ══════════════════════════════════════════════════════════

  router.get('/ar-invoices', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, customer_id, overdue } = req.query;
      let q = `SELECT ar.*, c.name as customer_name
               FROM ar_invoices ar
               JOIN customers c ON c.id = ar.customer_id
               WHERE ar.tenant_id = $1`;
      const params: any[] = [tid(req)];
      let pIdx = 2;
      if (status)      { q += ` AND ar.status = $${pIdx++}`; params.push(status); }
      if (customer_id) { q += ` AND ar.customer_id = $${pIdx++}`; params.push(customer_id); }
      if (overdue === 'true') { q += ` AND ar.due_date < CURRENT_DATE AND ar.status NOT IN ('paid','cancelled')`; }
      q += ` ORDER BY ar.due_date ASC`;
      const result = await pool.query(q, params);
      res.json({ invoices: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/ar-invoices', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { customer_id, date, due_date, lines, tax_type, gst_rate, notes } = req.body;

      const subtotal     = lines.reduce((s: number, l: any) => s + parseFloat(l.amount), 0);
      const tax_amount   = subtotal * (parseFloat(gst_rate ?? 0) / 100);
      const total_amount = subtotal + tax_amount;

      const invNum = await client.query(
        `SELECT next_accounting_number($1, 'ar_invoice', 'INV') AS num`,
        [tid(req)]
      );

      const inv = await client.query(
        `INSERT INTO ar_invoices (tenant_id,customer_id,invoice_number,date,due_date,subtotal,tax_amount,total_amount,tax_type,gst_rate,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [tid(req), customer_id, invNum.rows[0].num, date, due_date, subtotal, tax_amount, total_amount, tax_type ?? 'GST', gst_rate ?? 18, notes]
      );

      for (const line of lines) {
        await client.query(
          `INSERT INTO ar_invoice_lines (ar_invoice_id, description, quantity, unit_price, amount, account_id, hsn_sac)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [inv.rows[0].id, line.description, line.quantity ?? 1, line.unit_price, line.amount, line.account_id, line.hsn_sac]
        );
      }

      await client.query('COMMIT');
      res.json({ invoice: inv.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  // ══════════════════════════════════════════════════════════
  // GL SUMMARY (for Decision Center KPIs)
  // ══════════════════════════════════════════════════════════

  router.get('/gl-summary', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const [revenue, expenses, apOutstanding, arOutstanding, overdueAP, overdueAR] = await Promise.all([
        pool.query(`SELECT COALESCE(SUM(jel.credit - jel.debit), 0) as total
                    FROM journal_entry_lines jel
                    JOIN journal_entries je ON je.id = jel.journal_entry_id
                    JOIN accounts a ON a.id = jel.account_id
                    WHERE je.tenant_id = $1 AND je.status = 'posted'
                    AND a.type = 'income'
                    AND DATE_TRUNC('month', je.date) = DATE_TRUNC('month', NOW())`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(jel.debit - jel.credit), 0) as total
                    FROM journal_entry_lines jel
                    JOIN journal_entries je ON je.id = jel.journal_entry_id
                    JOIN accounts a ON a.id = jel.account_id
                    WHERE je.tenant_id = $1 AND je.status = 'posted'
                    AND a.type = 'expense'
                    AND DATE_TRUNC('month', je.date) = DATE_TRUNC('month', NOW())`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(balance_due), 0) as total, COUNT(*) as count
                    FROM ap_invoices WHERE tenant_id = $1 AND status NOT IN ('paid','rejected')`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(balance_due), 0) as total, COUNT(*) as count
                    FROM ar_invoices WHERE tenant_id = $1 AND status NOT IN ('paid','cancelled')`, [tenantId]),
        pool.query(`SELECT COUNT(*) as count FROM ap_invoices
                    WHERE tenant_id = $1 AND due_date < CURRENT_DATE AND status NOT IN ('paid','rejected')`, [tenantId]),
        pool.query(`SELECT COUNT(*) as count FROM ar_invoices
                    WHERE tenant_id = $1 AND due_date < CURRENT_DATE AND status NOT IN ('paid','cancelled')`, [tenantId]),
      ]);

      res.json({
        monthly_revenue:    parseFloat(revenue.rows[0].total),
        monthly_expenses:   parseFloat(expenses.rows[0].total),
        ap_outstanding:     parseFloat(apOutstanding.rows[0].total),
        ap_count:           parseInt(apOutstanding.rows[0].count),
        ar_outstanding:     parseFloat(arOutstanding.rows[0].total),
        ar_count:           parseInt(arOutstanding.rows[0].count),
        overdue_ap:         parseInt(overdueAP.rows[0].count),
        overdue_ar:         parseInt(overdueAR.rows[0].count),
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
