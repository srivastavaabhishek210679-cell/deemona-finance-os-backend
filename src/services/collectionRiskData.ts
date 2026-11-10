import { Pool } from 'pg';
import { ensurePaymentEventsTable } from '../routes/paymentEventsRoutes';
import { RiskEvent, OpenInv } from './collectionRisk';

export async function loadRiskInputs(pool: Pool, tenantId: string): Promise<{ events: RiskEvent[]; open: OpenInv[]; today: string }> {
  await ensurePaymentEventsTable(pool).catch(() => {});
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const ev = await pool.query(
    "SELECT i.customer_id::text AS customer_id, COALESCE(c.name,'Unknown') AS customer, i.id::text AS invoice_id, e.amount::float8 AS amount, e.payment_date::text AS payment_date, i.due_date::text AS due_date " +
    "FROM invoice_payment_events e JOIN ar_invoices i ON i.id = e.invoice_id AND i.tenant_id = e.tenant_id LEFT JOIN customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id " +
    "WHERE e.tenant_id = $1 AND e.invoice_type = 'ar' AND e.payment_date >= CURRENT_DATE - 365", [tenantId]).catch(() => ({ rows: [] as any[] }));
  const op = await pool.query(
    "SELECT i.customer_id::text AS customer_id, COALESCE(c.name,'Unknown') AS customer, i.id::text AS invoice_id, i.invoice_number, i.balance_due::float8 AS balance, i.due_date::text AS due_date " +
    "FROM ar_invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id " +
    "WHERE i.tenant_id = $1 AND i.status NOT IN ('paid','cancelled','draft') AND i.balance_due > 0", [tenantId]);
  return { events: ev.rows as RiskEvent[], open: op.rows as OpenInv[], today };
}
