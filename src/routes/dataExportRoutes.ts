import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createDataExportRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/export/summary ───────────────────────────────
  router.get('/summary', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const [accounts, vendors, customers, ar, ap, employees, payroll, projects, txns, assets, inventory, leads, expenses, filings, compliance, memory] = await Promise.all([
        pool.query('SELECT COUNT(*) as count FROM accounts WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count FROM vendors WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count FROM customers WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as total FROM ar_invoices WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as total FROM ap_invoices WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count FROM employees WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count FROM payroll_runs WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count FROM projects WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count FROM bank_transactions WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count FROM fixed_assets WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count FROM inventory_items WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count FROM crm_leads WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count FROM expense_claims WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count FROM tax_filings WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count FROM compliance_items WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count FROM finance_memory WHERE tenant_id=$1', [tenantId]),
      ]);

      res.json({
        modules: [
          { name:'Chart of Accounts', count:accounts.rows[0].count, table:'accounts' },
          { name:'Vendors',           count:vendors.rows[0].count,   table:'vendors' },
          { name:'Customers',         count:customers.rows[0].count, table:'customers' },
          { name:'AR Invoices',       count:ar.rows[0].count,        table:'ar_invoices',  value:ar.rows[0].total },
          { name:'AP Invoices',       count:ap.rows[0].count,        table:'ap_invoices',  value:ap.rows[0].total },
          { name:'Employees',         count:employees.rows[0].count, table:'employees' },
          { name:'Payroll Runs',      count:payroll.rows[0].count,   table:'payroll_runs' },
          { name:'Projects',          count:projects.rows[0].count,  table:'projects' },
          { name:'Bank Transactions', count:txns.rows[0].count,      table:'bank_transactions' },
          { name:'Fixed Assets',      count:assets.rows[0].count,    table:'fixed_assets' },
          { name:'Inventory Items',   count:inventory.rows[0].count, table:'inventory_items' },
          { name:'CRM Leads',         count:leads.rows[0].count,     table:'crm_leads' },
          { name:'Expense Claims',    count:expenses.rows[0].count,  table:'expense_claims' },
          { name:'Tax Filings',       count:filings.rows[0].count,   table:'tax_filings' },
          { name:'Compliance Items',  count:compliance.rows[0].count,table:'compliance_items' },
          { name:'Finance Memory',    count:memory.rows[0].count,    table:'finance_memory' },
        ],
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/export/json/:table ───────────────────────────
  router.get('/json/:table', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const ALLOWED = ['accounts','vendors','customers','ar_invoices','ap_invoices','employees','projects','bank_accounts','bank_transactions','fixed_assets','inventory_items','crm_leads','crm_activities','expense_claims','tax_filings','compliance_items','finance_memory','payroll_runs','payslips','purchase_orders','budgets','budget_lines'];
      const table = req.params.table;
      if (!ALLOWED.includes(table)) { res.status(400).json({ error: 'Table not allowed for export' }); return; }

      const result = await pool.query(`SELECT * FROM ${table} WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="deemona-${table}-${new Date().toISOString().split('T')[0]}.json"`);
      res.json({ table, exported_at: new Date().toISOString(), count: result.rows.length, data: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/export/csv/:table ────────────────────────────
  router.get('/csv/:table', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const ALLOWED = ['accounts','vendors','customers','ar_invoices','ap_invoices','employees','projects','bank_transactions','fixed_assets','inventory_items','crm_leads','expense_claims','tax_filings'];
      const table = req.params.table;
      if (!ALLOWED.includes(table)) { res.status(400).json({ error: 'Table not allowed' }); return; }

      const result = await pool.query(`SELECT * FROM ${table} WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]);
      if (!result.rows.length) { res.status(404).json({ error: 'No data to export' }); return; }

      const cols = Object.keys(result.rows[0]).filter(c => c !== 'tenant_id');
      const esc = (v: any) => v === null || v === undefined ? '' : typeof v === 'object' ? `"${JSON.stringify(v).replace(/"/g,'""')}"` : `"${String(v).replace(/"/g,'""')}"`;
      const csv = [cols.join(','), ...result.rows.map(row => cols.map(c => esc(row[c])).join(','))].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="deemona-${table}-${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(csv);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/export/full-backup ───────────────────────────
  router.get('/full-backup', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const TABLES = ['accounts','vendors','customers','ar_invoices','ap_invoices','employees','payroll_runs','payslips','projects','bank_accounts','bank_transactions','fixed_assets','inventory_items','crm_leads','expense_claims','tax_filings','compliance_items','finance_memory','budgets'];

      const backup: Record<string, any[]> = {};
      const tenant = await pool.query('SELECT * FROM tenants WHERE id=$1', [tenantId]);
      backup._tenant = tenant.rows;

      for (const table of TABLES) {
        try {
          const r = await pool.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [tenantId]);
          backup[table] = r.rows;
        } catch { backup[table] = []; }
      }

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="deemona-full-backup-${new Date().toISOString().split('T')[0]}.json"`);
      res.json({ exported_at: new Date().toISOString(), tenant_id: tenantId, version: '1.0', tables: TABLES, data: backup });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
