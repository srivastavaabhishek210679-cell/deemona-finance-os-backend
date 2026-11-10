import { Pool } from 'pg';
import { ensurePaymentEventsTable } from '../routes/paymentEventsRoutes';
import { SpendBill, SpendBudget } from './spendOptimization';

export async function loadSpendInputs(pool: Pool, tenantId: string): Promise<{ bills: SpendBill[]; budgets: SpendBudget[]; today: string }> {
  await ensurePaymentEventsTable(pool).catch(() => {});
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const b = await pool.query(
    "SELECT i.vendor_id::text AS vendor_id, COALESCE(v.name,'Unknown') AS vendor, i.invoice_number AS number, i.date::text AS date, i.due_date::text AS due_date, i.status, " +
    "i.total_amount::float8 AS total, i.paid_amount::float8 AS paid, " +
    "(SELECT MAX(e.payment_date)::text FROM invoice_payment_events e WHERE e.tenant_id = i.tenant_id AND e.invoice_type = 'ap' AND e.invoice_id = i.id) AS last_paid " +
    "FROM ap_invoices i LEFT JOIN vendors v ON v.id = i.vendor_id AND v.tenant_id = i.tenant_id " +
    "WHERE i.tenant_id = $1 AND i.date >= CURRENT_DATE - 400 ORDER BY i.date", [tenantId]);
  const bu = await pool.query('SELECT name, department, fiscal_year, total_budgeted::float8 AS budgeted, total_spent::float8 AS spent FROM budgets WHERE tenant_id = $1', [tenantId]).catch(() => ({ rows: [] as any[] }));
  return { bills: b.rows as SpendBill[], budgets: bu.rows as SpendBudget[], today };
}
