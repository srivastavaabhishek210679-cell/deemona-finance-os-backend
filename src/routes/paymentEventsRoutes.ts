// ============================================================
// Payment events: the dated record of every receipt (AR) and payment (AP).
// Without it, receivables and payables cannot be rebuilt for a past date.
// POST   /api/payment-events   record a receipt or payment against an invoice
// GET    /api/payment-events   list events (?invoice_type=ar|ap&invoice_id=...)
// ============================================================
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

let tableReady = false;
export async function ensurePaymentEventsTable(pool: Pool): Promise<void> {
  if (tableReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS invoice_payment_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    invoice_type TEXT NOT NULL CHECK (invoice_type IN ('ar','ap')),
    invoice_id UUID NOT NULL,
    payment_date DATE NOT NULL,
    amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
    bank_account_id UUID,
    reference TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ipe_tenant_invoice ON invoice_payment_events (tenant_id, invoice_type, invoice_id, payment_date)`);
  tableReady = true;
}

export function createPaymentEventsRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.post('/', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    let began = false;
    const fail = async (code: number, error: string) => {
      if (began) { await client.query('ROLLBACK').catch(() => {}); began = false; }
      res.status(code).json({ error });
    };
    try {
      await ensurePaymentEventsTable(pool);
      const { invoice_type, invoice_id, amount, payment_date, bank_account_id, reference } = req.body || {};
      const t = tid(req);
      if (invoice_type !== 'ar' && invoice_type !== 'ap') { await fail(400, "invoice_type must be 'ar' or 'ap'"); return; }
      if (!invoice_id) { await fail(400, 'invoice_id is required'); return; }
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) { await fail(400, 'amount must be a positive number'); return; }
      const date = payment_date ? String(payment_date).slice(0, 10) : null;
      if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { await fail(400, 'payment_date must be YYYY-MM-DD'); return; }

      await client.query('BEGIN'); began = true;
      const isAr = invoice_type === 'ar';
      const table = isAr ? 'ar_invoices' : 'ap_invoices';
      const partyCol = isAr ? 'customer_id' : 'vendor_id';
      const inv = await client.query(
        `SELECT id, invoice_number, status, date, total_amount, paid_amount, ${partyCol} AS party_id FROM ${table} WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [invoice_id, t]);
      if (!inv.rows.length) { await fail(404, 'Invoice not found'); return; }
      const row = inv.rows[0];
      if (['draft', 'cancelled', 'rejected'].includes(row.status)) { await fail(409, 'Invoice is ' + row.status + ' and cannot take a payment'); return; }
      const dres = await client.query(`SELECT COALESCE($1::date, CURRENT_DATE) AS d, CURRENT_DATE AS today`, [date]);
      const payDate: string = new Date(dres.rows[0].d).toLocaleDateString('en-CA');
      const todayStr: string = new Date(dres.rows[0].today).toLocaleDateString('en-CA');
      if (payDate > todayStr) { await fail(400, 'payment_date cannot be in the future'); return; }
      if (payDate < new Date(row.date).toLocaleDateString('en-CA')) { await fail(400, 'payment_date cannot be before the invoice date'); return; }
      const total = Number(row.total_amount), paid = Number(row.paid_amount || 0);
      if (amt > total - paid + 0.005) { await fail(400, 'amount exceeds the outstanding balance of ' + (total - paid).toFixed(2)); return; }

      const ev = await client.query(
        `INSERT INTO invoice_payment_events (tenant_id, invoice_type, invoice_id, payment_date, amount, bank_account_id, reference, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [t, invoice_type, invoice_id, payDate, amt, bank_account_id || null, reference || null, (req as any).user.email || (req as any).user.id || null]);
      const newPaid = paid + amt;
      const full = newPaid >= total - 0.005;
      const newStatus = full ? 'paid' : (isAr ? 'partially_paid' : row.status);
      await client.query(`UPDATE ${table} SET paid_amount = $1, status = $2, updated_at = NOW() WHERE id = $3 AND tenant_id = $4`, [newPaid, newStatus, invoice_id, t]);

      let bank: any = null;
      if (bank_account_id && process.env.BANK_DATA_DISABLED === 'false') { /*bankoff*/
        const ba = await client.query(`SELECT current_balance FROM bank_accounts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [bank_account_id, t]);
        if (!ba.rows.length) { await fail(404, 'Bank account not found'); return; }
        const newBal = Number(ba.rows[0].current_balance) + (isAr ? amt : -amt);
        await client.query(
          `INSERT INTO bank_transactions (tenant_id, bank_account_id, date, value_date, description, reference, type, amount, balance_after, category, ${partyCol})
           VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [t, bank_account_id, payDate, (isAr ? 'Receipt - ' : 'Payment - ') + row.invoice_number, reference || null, isAr ? 'credit' : 'debit', amt, newBal, isAr ? 'customer_receipt' : 'vendor_payment', row.party_id]);
        await client.query(`UPDATE bank_accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2`, [newBal, bank_account_id]);
        bank = { bank_account_id, new_balance: newBal };
      }
      await client.query('COMMIT'); began = false;
      res.json({ event: ev.rows[0], invoice: { id: invoice_id, paid_amount: newPaid, balance_due: total - newPaid, status: newStatus }, bank });
    } catch (err) {
      if (began) await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      await ensurePaymentEventsTable(pool);
      const { invoice_type, invoice_id } = req.query as any;
      const params: any[] = [tid(req)];
      let q = `SELECT * FROM invoice_payment_events WHERE tenant_id = $1`;
      if (invoice_type === 'ar' || invoice_type === 'ap') { params.push(invoice_type); q += ` AND invoice_type = $${params.length}`; }
      if (invoice_id) { params.push(String(invoice_id)); q += ` AND invoice_id = $${params.length}::uuid`; }
      q += ` ORDER BY payment_date DESC, created_at DESC LIMIT 200`;
      res.json({ events: (await pool.query(q, params)).rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
