import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function createTreasuryRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/summary', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const accounts = await pool.query(
        `SELECT COALESCE(SUM(current_balance), 0) as total_cash, COUNT(*) as account_count
         FROM bank_accounts WHERE tenant_id = $1 AND is_active = TRUE`,
        [tenantId]
      );
      const upcoming = await pool.query(
        `SELECT COALESCE(SUM(balance_due), 0) as amount, COUNT(*) as count
         FROM ap_invoices WHERE tenant_id = $1 AND status NOT IN ('paid','rejected')
         AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`,
        [tenantId]
      );
      const incoming = await pool.query(
        `SELECT COALESCE(SUM(balance_due), 0) as amount, COUNT(*) as count
         FROM ar_invoices WHERE tenant_id = $1 AND status NOT IN ('paid','cancelled')
         AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`,
        [tenantId]
      );
      const totalCash = parseFloat(accounts.rows[0].total_cash);
      const upcomingPayables = parseFloat(upcoming.rows[0].amount);
      const upcomingReceivables = parseFloat(incoming.rows[0].amount);
      res.json({
        total_cash: totalCash,
        account_count: parseInt(accounts.rows[0].account_count),
        upcoming_payables_30d: upcomingPayables,
        upcoming_payables_count: parseInt(upcoming.rows[0].count),
        upcoming_receivables_30d: upcomingReceivables,
        upcoming_receivables_count: parseInt(incoming.rows[0].count),
        net_cash_flow_30d: upcomingReceivables - upcomingPayables,
        projected_balance_30d: totalCash + upcomingReceivables - upcomingPayables,
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get('/bank-accounts', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT * FROM bank_accounts WHERE tenant_id = $1 AND is_active = TRUE ORDER BY is_primary DESC, name`,
        [tid(req)]
      );
      res.json({ accounts: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/bank-accounts', requireAuth, async (req: Request, res: Response) => {
    if (process.env.BANK_DATA_DISABLED !== 'false') { res.status(410).json({ error: 'Bank data storage is disabled' }); return; } /*bankoff*/
    try {
      const { name, account_number, ifsc, bank_name, branch, account_type, opening_balance, upi_id, notes, is_primary } = req.body;
      const result = await pool.query(
        `INSERT INTO bank_accounts (tenant_id, name, account_number, ifsc, bank_name, branch, account_type, opening_balance, current_balance, upi_id, notes, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11) RETURNING *`,
        [tid(req), name, account_number, ifsc, bank_name, branch, account_type || 'current', opening_balance || 0, upi_id, notes, is_primary || false]
      );
      res.json({ account: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/bank-accounts/:id', requireAuth, async (req: Request, res: Response) => {
    if (process.env.BANK_DATA_DISABLED !== 'false') { res.status(410).json({ error: 'Bank data storage is disabled' }); return; } /*bankoff*/
    try {
      const { current_balance, name, notes, is_primary } = req.body;
      const result = await pool.query(
        `UPDATE bank_accounts SET current_balance = COALESCE($1, current_balance), name = COALESCE($2, name), notes = COALESCE($3, notes), is_primary = COALESCE($4, is_primary), updated_at = NOW()
         WHERE id = $5 AND tenant_id = $6 RETURNING *`,
        [current_balance, name, notes, is_primary, req.params.id, tid(req)]
      );
      res.json({ account: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get('/transactions', requireAuth, async (req: Request, res: Response) => {
    try {
      const { account_id, limit = 50 } = req.query;
      let q = `SELECT bt.*, ba.name as account_name FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bank_account_id WHERE bt.tenant_id = $1`;
      const params: any[] = [tid(req)];
      if (account_id) { q += ` AND bt.bank_account_id = $2`; params.push(account_id); }
      q += ` ORDER BY bt.date DESC LIMIT $${params.length + 1}`;
      params.push(limit);
      const result = await pool.query(q, params);
      res.json({ transactions: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/transactions', requireAuth, async (req: Request, res: Response) => {
    if (process.env.BANK_DATA_DISABLED !== 'false') { res.status(410).json({ error: 'Bank data storage is disabled' }); return; } /*bankoff*/
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { bank_account_id, date, description, reference, type, amount, category, notes } = req.body;
      const bal = await client.query(`SELECT current_balance FROM bank_accounts WHERE id = $1 AND tenant_id = $2`, [bank_account_id, tid(req)]);
      if (!bal.rows.length) { res.status(404).json({ error: 'Bank account not found' }); return; }
      const currentBal = parseFloat(bal.rows[0].current_balance);
      const newBalance = type === 'credit' ? currentBal + parseFloat(amount) : currentBal - parseFloat(amount);
      const txn = await client.query(
        `INSERT INTO bank_transactions (tenant_id, bank_account_id, date, value_date, description, reference, type, amount, balance_after, category, notes)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [tid(req), bank_account_id, date, description, reference, type, amount, newBalance, category, notes]
      );
      await client.query(`UPDATE bank_accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2`, [newBalance, bank_account_id]);
      await client.query('COMMIT');
      res.json({ transaction: txn.rows[0], new_balance: newBalance });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  router.get('/cash-flow', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const days = req.query.days || 30;
      const apOutflows = await pool.query(
        `SELECT due_date as date, balance_due as amount, 'outflow' as category, 'AP: ' || v.name as description, 75 as probability
         FROM ap_invoices ap JOIN vendors v ON v.id = ap.vendor_id
         WHERE ap.tenant_id = $1 AND ap.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($2 || ' days')::INTERVAL AND ap.status NOT IN ('paid','rejected')`,
        [tenantId, days]
      );
      const arInflows = await pool.query(
        `SELECT due_date as date, balance_due as amount, 'inflow' as category, 'AR: ' || c.name as description, 60 as probability
         FROM ar_invoices ar JOIN customers c ON c.id = ar.customer_id
         WHERE ar.tenant_id = $1 AND ar.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($2 || ' days')::INTERVAL AND ar.status NOT IN ('paid','cancelled')`,
        [tenantId, days]
      );
      const balResult = await pool.query(`SELECT COALESCE(SUM(current_balance), 0) as total FROM bank_accounts WHERE tenant_id = $1 AND is_active = TRUE`, [tenantId]);
      let runningBalance = parseFloat(balResult.rows[0].total);
      const all = [...apOutflows.rows, ...arInflows.rows].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      const withBalance = all.map(item => {
        const amt = parseFloat(item.amount) * (parseFloat(item.probability) / 100);
        runningBalance += item.category === 'inflow' ? amt : -amt;
        return { ...item, running_balance: runningBalance };
      });
      res.json({ items: withBalance, opening_balance: parseFloat(balResult.rows[0].total), closing_balance: runningBalance, days });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/ai-analysis', requireAuth, async (req: Request, res: Response) => {
    try {
      const summary = await pool.query(`SELECT COALESCE(SUM(current_balance), 0) as total FROM bank_accounts WHERE tenant_id = $1 AND is_active = TRUE`, [tid(req)]);
      const prompt = 'You are the Treasury Agent. Cash position: INR ' + parseFloat(summary.rows[0].total).toLocaleString('en-IN') + '. Provide a brief liquidity assessment, key risks, and 2 recommended actions. Plain text, no markdown, under 120 words.';
      const response = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
      const analysis = response.content[0].type === 'text' ? response.content[0].text : '';
      res.json({ analysis });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
