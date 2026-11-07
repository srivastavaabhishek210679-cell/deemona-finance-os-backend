// ============================================================
// Manual cash & bank balance. The user types the balance as of a date; nothing is imported from
// bank statements. Cash on any later date = latest entry on or before it + dated receipts - payments
// recorded after that entry (invoice_payment_events).
// ============================================================
import { Pool } from 'pg';
import { ensurePaymentEventsTable } from '../routes/paymentEventsRoutes';

let ready = false;
export async function ensureCashTable(pool: Pool): Promise<void> {
  if (ready) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS cash_balance_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    as_of DATE NOT NULL,
    amount NUMERIC(18,2) NOT NULL,
    note TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cbe_tenant_date ON cash_balance_entries (tenant_id, as_of DESC)`);
  ready = true;
}

export interface CashAsOf { has_entry: boolean; amount: number; entry_date: string | null; entry_amount: number; movement: number; note: string | null; }

export async function cashAsOf(pool: Pool, tenantId: string, asOf?: string): Promise<CashAsOf> {
  await ensureCashTable(pool);
  await ensurePaymentEventsTable(pool);
  const d = asOf || new Date().toISOString().split('T')[0];
  const e = await pool.query(
    `SELECT as_of::text AS as_of, amount, note FROM cash_balance_entries
     WHERE tenant_id = $1 AND as_of <= $2 ORDER BY as_of DESC, created_at DESC LIMIT 1`, [tenantId, d]);
  if (!e.rows.length) return { has_entry: false, amount: 0, entry_date: null, entry_amount: 0, movement: 0, note: null };
  const m = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN invoice_type = 'ar' THEN amount ELSE -amount END), 0) AS net
     FROM invoice_payment_events WHERE tenant_id = $1 AND payment_date > $2 AND payment_date <= $3`,
    [tenantId, e.rows[0].as_of, d]);
  const entryAmount = parseFloat(e.rows[0].amount);
  const movement = parseFloat(m.rows[0].net);
  return { has_entry: true, amount: entryAmount + movement, entry_date: e.rows[0].as_of, entry_amount: entryAmount, movement, note: e.rows[0].note };
}
