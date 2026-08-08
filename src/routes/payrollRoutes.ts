import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createPayrollRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/summary', requireAuth, async (req: Request, res: Response) => {
    try {
      const [emp, lastRun] = await Promise.all([
        pool.query("SELECT COUNT(*) as total, SUM(CASE WHEN status = $2 THEN 1 ELSE 0 END) as active, COALESCE(SUM(CASE WHEN status = $2 THEN basic_salary + hra + special_allowance + other_allowances ELSE 0 END), 0) as monthly_payroll FROM employees WHERE tenant_id = $1", [tid(req), "active"]),
        pool.query(`SELECT * FROM payroll_runs WHERE tenant_id = $1 ORDER BY year DESC, month DESC LIMIT 1`, [tid(req)]),
      ]);
      res.json({ total_employees: parseInt(emp.rows[0].total), active_employees: parseInt(emp.rows[0].active), monthly_payroll: parseFloat(emp.rows[0].monthly_payroll), last_run: lastRun.rows[0] || null });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get('/employees', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(`SELECT * FROM employees WHERE tenant_id = $1 ORDER BY department, first_name`, [tid(req)]);
      res.json({ employees: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/employees', requireAuth, async (req: Request, res: Response) => {
    try {
      const { employee_code, first_name, last_name, email, phone, designation, department, date_of_joining, employment_type, pan, bank_account, bank_name, ifsc, basic_salary, hra, special_allowance, other_allowances, pf_applicable, esic_applicable } = req.body;
      const result = await pool.query(`INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, phone, designation, department, date_of_joining, employment_type, pan, bank_account, bank_name, ifsc, basic_salary, hra, special_allowance, other_allowances, pf_applicable, esic_applicable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
        [tid(req), employee_code, first_name, last_name, email, phone, designation, department, date_of_joining, employment_type || 'full_time', pan, bank_account, bank_name, ifsc, basic_salary || 0, hra || 0, special_allowance || 0, other_allowances || 0, pf_applicable !== false, esic_applicable || false]);
      res.json({ employee: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get('/runs', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(`SELECT * FROM payroll_runs WHERE tenant_id = $1 ORDER BY year DESC, month DESC`, [tid(req)]);
      res.json({ runs: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/runs/generate', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { month, year } = req.body;
      if (!month || !year) { res.status(400).json({ error: 'month and year required' }); return; }
      const existing = await client.query(`SELECT id FROM payroll_runs WHERE tenant_id = $1 AND month = $2 AND year = $3`, [tid(req), month, year]);
      if (existing.rows.length) { res.status(400).json({ error: 'Payroll for this month already exists' }); return; }
      const run = await client.query(`INSERT INTO payroll_runs (tenant_id, month, year, status) VALUES ($1,$2,$3,'draft') RETURNING *`, [tid(req), month, year]);
      const runId = run.rows[0].id;
      const employees = await client.query(`SELECT * FROM employees WHERE tenant_id = $1 AND status = 'active'`, [tid(req)]);
      let totalGross = 0, totalDeductions = 0, totalNet = 0, totalEmployerPF = 0, totalTDS = 0;
      for (const emp of employees.rows) {
        const basic = parseFloat(emp.basic_salary), hra = parseFloat(emp.hra), special = parseFloat(emp.special_allowance), other = parseFloat(emp.other_allowances);
        const gross = basic + hra + special + other;
        const pfBasic = Math.min(basic, 15000);
        const pfEmployee = emp.pf_applicable ? Math.round(pfBasic * 0.12) : 0;
        const pfEmployer = emp.pf_applicable ? Math.round(pfBasic * 0.12) : 0;
        const esicEmployee = emp.esic_applicable && gross <= 21000 ? Math.round(gross * 0.0075) : 0;
        const esicEmployer = emp.esic_applicable && gross <= 21000 ? Math.round(gross * 0.0325) : 0;
        const professionalTax = gross > 15000 ? 200 : gross > 10000 ? 175 : gross > 7500 ? 150 : 0;
        const annualGross = gross * 12;
        const taxableIncome = Math.max(0, annualGross - 250000);
        const annualTDS = taxableIncome <= 0 ? 0 : taxableIncome <= 250000 ? 0 : taxableIncome <= 500000 ? taxableIncome * 0.05 : taxableIncome <= 1000000 ? 12500 + (taxableIncome - 500000) * 0.2 : 112500 + (taxableIncome - 1000000) * 0.3;
        const monthlyTDS = emp.tds_applicable ? Math.round(annualTDS / 12) : 0;
        const totalDed = pfEmployee + esicEmployee + professionalTax + monthlyTDS;
        const net = gross - totalDed;
        await client.query(`INSERT INTO payslips (tenant_id, payroll_run_id, employee_id, month, year, basic_salary, hra, special_allowance, other_allowances, gross_salary, pf_employee, pf_employer, esic_employee, esic_employer, tds, professional_tax, total_deductions, net_salary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [tid(req), runId, emp.id, month, year, basic, hra, special, other, gross, pfEmployee, pfEmployer, esicEmployee, esicEmployer, monthlyTDS, professionalTax, totalDed, net]);
        totalGross += gross; totalDeductions += totalDed; totalNet += net; totalEmployerPF += pfEmployer; totalTDS += monthlyTDS;
      }
      await client.query(`UPDATE payroll_runs SET total_employees=$1, total_gross=$2, total_deductions=$3, total_net=$4, total_employer_pf=$5, total_tds=$6 WHERE id=$7`,
        [employees.rows.length, totalGross, totalDeductions, totalNet, totalEmployerPF, totalTDS, runId]);
      await client.query('COMMIT');
      res.json({ run: run.rows[0] });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: String(err) }); }
    finally { client.release(); }
  });

  router.get('/runs/:id/payslips', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(`SELECT p.*, e.first_name, e.last_name, e.employee_code, e.designation, e.department FROM payslips p JOIN employees e ON e.id = p.employee_id WHERE p.payroll_run_id = $1 AND p.tenant_id = $2 ORDER BY e.department, e.first_name`, [req.params.id, tid(req)]);
      res.json({ payslips: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/runs/:id/approve', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(`UPDATE payroll_runs SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW() WHERE id=$2 AND tenant_id=$3 AND status='draft' RETURNING *`, [(req as any).user.id, req.params.id, tid(req)]);
      if (!result.rows.length) { res.status(404).json({ error: 'Not found or not draft' }); return; }
      res.json({ run: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/runs/:id/pay', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query(`UPDATE payroll_runs SET status='paid', paid_at=NOW(), updated_at=NOW() WHERE id=$1 AND tenant_id=$2 AND status='approved' RETURNING *`, [req.params.id, tid(req)]);
      if (!run.rows.length) { res.status(404).json({ error: 'Not found or not approved' }); return; }
      await client.query(`UPDATE payslips SET payment_status='paid', payment_date=CURRENT_DATE WHERE payroll_run_id=$1`, [req.params.id]);
      await client.query('COMMIT');
      res.json({ run: run.rows[0] });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: String(err) }); }
    finally { client.release(); }
  });

  return router;
}

