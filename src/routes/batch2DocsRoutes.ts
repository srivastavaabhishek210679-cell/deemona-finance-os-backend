// ============================================================
// Batch 2 Documents Routes
// File: src/routes/batch2DocsRoutes.ts
// ============================================================

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createBatch2DocsRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user?.tenantId;

  // ── 1. SOX COMPLIANCE ─────────────────────────────────────
  router.get('/sox', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM sox_compliance WHERE tenant_id=$1 ORDER BY control_category, control_id', [tid(req)]);
      const summary = await pool.query(
        "SELECT test_result, COUNT(*) as count FROM sox_compliance WHERE tenant_id=$1 GROUP BY test_result",
        [tid(req)]
      );
      res.json({ controls: result.rows, summary: summary.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/sox', requireAuth, async (req: Request, res: Response) => {
    try {
      const { control_id, control_name, control_category, control_type, control_frequency, control_owner, description, test_procedure, last_tested_date, test_result, deficiency_type, remediation_plan } = req.body;
      const result = await pool.query(
        'INSERT INTO sox_compliance (tenant_id, control_id, control_name, control_category, control_type, control_frequency, control_owner, description, test_procedure, last_tested_date, test_result, deficiency_type, remediation_plan) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
        [tid(req), control_id, control_name, control_category, control_type, control_frequency, control_owner, description, test_procedure, last_tested_date, test_result||'not_tested', deficiency_type||'none', remediation_plan]
      );
      res.json({ control: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/sox/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { test_result, deficiency_type, remediation_plan, last_tested_date } = req.body;
      const result = await pool.query(
        'UPDATE sox_compliance SET test_result=$1, deficiency_type=$2, remediation_plan=$3, last_tested_date=$4, updated_at=NOW() WHERE id=$5 AND tenant_id=$6 RETURNING *',
        [test_result, deficiency_type, remediation_plan, last_tested_date, req.params.id, tid(req)]
      );
      res.json({ control: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 2. TRANSFER PRICING ───────────────────────────────────
  router.get('/transfer-pricing', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM transfer_pricing WHERE tenant_id=$1 ORDER BY financial_year DESC, created_at DESC', [tid(req)]);
      const summary = await pool.query(
        'SELECT financial_year, COUNT(*) as transactions, COALESCE(SUM(transaction_amount),0) as total FROM transfer_pricing WHERE tenant_id=$1 GROUP BY financial_year ORDER BY financial_year DESC',
        [tid(req)]
      );
      res.json({ transactions: result.rows, summary: summary.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/transfer-pricing', requireAuth, async (req: Request, res: Response) => {
    try {
      const { related_party_name, related_party_country, relationship_type, transaction_type, transaction_description, transaction_amount, currency, pricing_method, arm_length_price, actual_price, financial_year, benchmarking_study, documentation_date } = req.body;
      const txnId = 'TP-' + Date.now().toString().slice(-8);
      const variation = arm_length_price && actual_price ? (((actual_price - arm_length_price) / arm_length_price) * 100).toFixed(2) : 0;
      const result = await pool.query(
        'INSERT INTO transfer_pricing (tenant_id, transaction_id, related_party_name, related_party_country, relationship_type, transaction_type, transaction_description, transaction_amount, currency, pricing_method, arm_length_price, actual_price, variation_pct, financial_year, benchmarking_study, documentation_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
        [tid(req), txnId, related_party_name, related_party_country, relationship_type, transaction_type, transaction_description, transaction_amount, currency||'INR', pricing_method, arm_length_price, actual_price, variation, financial_year, benchmarking_study, documentation_date]
      );
      res.json({ transaction: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 3. LEAVE ENCASHMENT ───────────────────────────────────
  router.get('/leave-encashment', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM leave_encashment WHERE tenant_id=$1 ORDER BY created_at DESC', [tid(req)]);
      const summary = await pool.query(
        "SELECT COUNT(*) as total, COALESCE(SUM(encashment_amount),0) as total_amount, COALESCE(SUM(tds_deducted),0) as total_tds FROM leave_encashment WHERE tenant_id=$1",
        [tid(req)]
      );
      res.json({ records: result.rows, summary: summary.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/leave-encashment', requireAuth, async (req: Request, res: Response) => {
    try {
      const { employee_name, employee_id, employee_code, encashment_type, leave_type, leaves_encashed, basic_salary, encashment_date, approved_by, remarks } = req.body;
      const perDay = parseFloat(basic_salary) / 26; // 26 working days
      const amount = perDay * parseFloat(leaves_encashed);
      // TDS exemption: up to 3 lakh for leave encashment
      const taxable = Math.max(0, amount - 300000);
      const tds = taxable * 0.30; // 30% on taxable portion
      const net = amount - tds;
      const result = await pool.query(
        'INSERT INTO leave_encashment (tenant_id, employee_id, employee_name, employee_code, encashment_type, leave_type, leaves_encashed, basic_salary, per_day_salary, encashment_amount, tds_deducted, net_amount, encashment_date, approved_by, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
        [tid(req), employee_id, employee_name, employee_code, encashment_type||'annual', leave_type||'earned_leave', leaves_encashed, basic_salary, perDay.toFixed(2), amount.toFixed(2), tds.toFixed(2), net.toFixed(2), encashment_date, approved_by, remarks]
      );
      res.json({ record: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/leave-encashment/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, payment_date } = req.body;
      const result = await pool.query(
        'UPDATE leave_encashment SET status=$1, payment_date=$2, updated_at=NOW() WHERE id=$3 AND tenant_id=$4 RETURNING *',
        [status, payment_date, req.params.id, tid(req)]
      );
      res.json({ record: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 4. EMPLOYEE LOANS ─────────────────────────────────────
  router.get('/employee-loans', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'SELECT el.*, COALESCE(SUM(r.total_recovered),0) as total_paid FROM employee_loans el LEFT JOIN employee_loan_recoveries r ON r.loan_id=el.id WHERE el.tenant_id=$1 GROUP BY el.id ORDER BY el.created_at DESC',
        [tid(req)]
      );
      const summary = await pool.query(
        "SELECT COUNT(*) as total, COALESCE(SUM(loan_amount),0) as disbursed, COALESCE(SUM(outstanding_balance),0) as outstanding FROM employee_loans WHERE tenant_id=$1 AND status='active'",
        [tid(req)]
      );
      res.json({ loans: result.rows, summary: summary.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/employee-loans', requireAuth, async (req: Request, res: Response) => {
    try {
      const { employee_name, employee_id, employee_code, loan_purpose, loan_amount, interest_rate, tenure_months, disbursement_date, approved_by, recovery_mode } = req.body;
      const emi = tenure_months > 0 ? (parseFloat(loan_amount) / parseInt(tenure_months)).toFixed(2) : loan_amount;
      const result = await pool.query(
        'INSERT INTO employee_loans (tenant_id, employee_id, employee_name, employee_code, loan_purpose, loan_amount, interest_rate, tenure_months, emi_amount, disbursement_date, outstanding_balance, approved_by, recovery_mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
        [tid(req), employee_id, employee_name, employee_code, loan_purpose, loan_amount, interest_rate||0, tenure_months, emi, disbursement_date, loan_amount, approved_by, recovery_mode||'salary_deduction']
      );
      res.json({ loan: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/employee-loans/:id/recover', requireAuth, async (req: Request, res: Response) => {
    try {
      const { recovery_date, principal_recovered, payslip_month } = req.body;
      await pool.query(
        'INSERT INTO employee_loan_recoveries (loan_id, tenant_id, recovery_date, principal_recovered, total_recovered, payslip_month) VALUES ($1,$2,$3,$4,$5,$6)',
        [req.params.id, tid(req), recovery_date, principal_recovered, principal_recovered, payslip_month]
      );
      await pool.query(
        'UPDATE employee_loans SET outstanding_balance=outstanding_balance-$1, total_recovered=total_recovered+$1, updated_at=NOW() WHERE id=$2',
        [principal_recovered, req.params.id]
      );
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 5. RETIREMENT BENEFITS ────────────────────────────────
  router.get('/retirement-benefits', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM retirement_benefits WHERE tenant_id=$1 ORDER BY expected_retirement_date ASC', [tid(req)]);
      const summary = await pool.query(
        'SELECT COUNT(*) as total_employees, COALESCE(SUM(total_retirement_corpus),0) as total_corpus, COALESCE(SUM(gratuity_earned),0) as total_gratuity, COALESCE(SUM(total_pf_corpus),0) as total_pf FROM retirement_benefits WHERE tenant_id=$1',
        [tid(req)]
      );
      res.json({ benefits: result.rows, summary: summary.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/retirement-benefits', requireAuth, async (req: Request, res: Response) => {
    try {
      const { employee_name, employee_id, employee_code, date_of_birth, date_of_joining, expected_retirement_date, current_basic_salary, pf_account_number, employee_pf_balance, employer_pf_balance, eps_balance, leave_balance } = req.body;
      const doj = new Date(date_of_joining);
      const retDate = expected_retirement_date ? new Date(expected_retirement_date) : new Date(new Date(date_of_birth).setFullYear(new Date(date_of_birth).getFullYear() + 58));
      const yearsService = (new Date().getTime() - doj.getTime()) / (365.25 * 24 * 3600 * 1000);
      const salary = parseFloat(current_basic_salary);
      const gratuity = Math.round((15/26) * salary * yearsService);
      const pfCorpus = parseFloat(employee_pf_balance||0) + parseFloat(employer_pf_balance||0);
      const leaveVal = Math.round((salary/26) * parseInt(leave_balance||0));
      const total = gratuity + pfCorpus + parseFloat(eps_balance||0) + leaveVal;

      const result = await pool.query(
        'INSERT INTO retirement_benefits (tenant_id, employee_id, employee_name, employee_code, date_of_birth, date_of_joining, expected_retirement_date, current_basic_salary, pf_account_number, employee_pf_balance, employer_pf_balance, total_pf_corpus, gratuity_earned, eps_balance, leave_balance, leave_encashment_value, total_retirement_corpus) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *',
        [tid(req), employee_id, employee_name, employee_code, date_of_birth, date_of_joining, retDate.toISOString().split('T')[0], salary, pf_account_number, employee_pf_balance||0, employer_pf_balance||0, pfCorpus, gratuity, eps_balance||0, leave_balance||0, leaveVal, total]
      );
      res.json({ benefit: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 6. WHISTLEBLOWER REPORTS ──────────────────────────────
  router.get('/whistleblower', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'SELECT id, report_number, complaint_category, incident_date, is_anonymous, assigned_to, investigation_status, priority, created_at FROM whistleblower_reports WHERE tenant_id=$1 ORDER BY created_at DESC',
        [tid(req)]
      );
      const summary = await pool.query(
        "SELECT investigation_status, COUNT(*) as count FROM whistleblower_reports WHERE tenant_id=$1 GROUP BY investigation_status",
        [tid(req)]
      );
      res.json({ reports: result.rows, summary: summary.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/whistleblower', requireAuth, async (req: Request, res: Response) => {
    try {
      const { complaint_category, complaint_description, reported_department, reported_person, incident_date, is_anonymous, reporter_name, reporter_email, evidence_description, priority } = req.body;
      const reportNum = 'WB-' + Date.now().toString().slice(-8);
      const result = await pool.query(
        'INSERT INTO whistleblower_reports (tenant_id, report_number, complaint_category, complaint_description, reported_department, reported_person, incident_date, is_anonymous, reporter_name, reporter_email, evidence_description, priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, report_number, investigation_status, priority, created_at',
        [tid(req), reportNum, complaint_category, complaint_description, reported_department, reported_person, incident_date, is_anonymous!==false, is_anonymous!==false?null:reporter_name, is_anonymous!==false?null:reporter_email, evidence_description, priority||'medium']
      );
      res.json({ report: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/whistleblower/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { investigation_status, investigation_findings, action_taken, resolution_date, assigned_to } = req.body;
      const result = await pool.query(
        'UPDATE whistleblower_reports SET investigation_status=$1, investigation_findings=$2, action_taken=$3, resolution_date=$4, assigned_to=$5, updated_at=NOW() WHERE id=$6 AND tenant_id=$7 RETURNING *',
        [investigation_status, investigation_findings, action_taken, resolution_date, assigned_to, req.params.id, tid(req)]
      );
      res.json({ report: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 7. DIVIDEND DECLARATION ───────────────────────────────
  router.get('/dividends', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM dividend_declarations WHERE tenant_id=$1 ORDER BY declaration_date DESC', [tid(req)]);
      const summary = await pool.query(
        "SELECT COUNT(*) as total, COALESCE(SUM(total_dividend_amount),0) as total_declared, COALESCE(SUM(net_dividend_paid),0) as total_paid FROM dividend_declarations WHERE tenant_id=$1",
        [tid(req)]
      );
      res.json({ dividends: result.rows, summary: summary.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/dividends', requireAuth, async (req: Request, res: Response) => {
    try {
      const { financial_year, dividend_type, declaration_date, record_date, payment_date, dividend_per_share, total_shares_eligible, tds_applicable, tds_rate, board_resolution_date, agm_approval_date, notes } = req.body;
      const divNum = 'DIV-' + new Date().getFullYear() + '-' + Date.now().toString().slice(-4);
      const totalAmount = parseFloat(dividend_per_share) * parseInt(total_shares_eligible);
      const tds = tds_applicable ? totalAmount * (parseFloat(tds_rate||0) / 100) : 0;
      const netPaid = totalAmount - tds;
      const result = await pool.query(
        'INSERT INTO dividend_declarations (tenant_id, dividend_number, financial_year, dividend_type, declaration_date, record_date, payment_date, dividend_per_share, total_shares_eligible, total_dividend_amount, tds_applicable, tds_rate, net_dividend_paid, board_resolution_date, agm_approval_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
        [tid(req), divNum, financial_year, dividend_type||'final', declaration_date, record_date, payment_date, dividend_per_share, total_shares_eligible, totalAmount, tds_applicable||false, tds_rate||0, netPaid, board_resolution_date, agm_approval_date, notes]
      );
      res.json({ dividend: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/dividends/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status } = req.body;
      const result = await pool.query('UPDATE dividend_declarations SET status=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3 RETURNING *', [status, req.params.id, tid(req)]);
      res.json({ dividend: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 8. CAPEX REGISTER ─────────────────────────────────────
  router.get('/capex', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM capex_register WHERE tenant_id=$1 ORDER BY purchase_date DESC', [tid(req)]);
      const summary = await pool.query(
        "SELECT asset_category, COUNT(*) as count, COALESCE(SUM(actual_cost),0) as total_cost, COALESCE(SUM(book_value),0) as book_value FROM capex_register WHERE tenant_id=$1 AND status='active' GROUP BY asset_category ORDER BY total_cost DESC",
        [tid(req)]
      );
      const totals = await pool.query(
        "SELECT COALESCE(SUM(actual_cost),0) as total_investment, COALESCE(SUM(accumulated_depreciation),0) as total_depreciation, COALESCE(SUM(book_value),0) as net_block FROM capex_register WHERE tenant_id=$1 AND status='active'",
        [tid(req)]
      );
      res.json({ assets: result.rows, by_category: summary.rows, totals: totals.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/capex', requireAuth, async (req: Request, res: Response) => {
    try {
      const { asset_name, asset_category, department, project_name, justification, budgeted_cost, actual_cost, vendor_name, purchase_order_number, invoice_number, purchase_date, commissioning_date, useful_life_years, depreciation_method, salvage_value, location, asset_tag, approved_by } = req.body;
      const capexId = 'CAP-' + Date.now().toString().slice(-8);
      const cost = parseFloat(actual_cost || budgeted_cost || 0);
      const salvage = parseFloat(salvage_value || 0);
      const life = parseInt(useful_life_years || 5);
      const annualDep = depreciation_method === 'WDV'
        ? cost * (1 - Math.pow(salvage/cost, 1/life)) // WDV rate approximation
        : (cost - salvage) / life; // SLM
      const variance = actual_cost && budgeted_cost ? parseFloat(actual_cost) - parseFloat(budgeted_cost) : 0;
      const result = await pool.query(
        'INSERT INTO capex_register (tenant_id, capex_id, asset_name, asset_category, department, project_name, justification, budgeted_cost, actual_cost, variance, vendor_name, purchase_order_number, invoice_number, purchase_date, commissioning_date, useful_life_years, depreciation_method, salvage_value, annual_depreciation, book_value, location, asset_tag, approval_status, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *',
        [tid(req), capexId, asset_name, asset_category, department, project_name, justification, budgeted_cost, actual_cost, variance, vendor_name, purchase_order_number, invoice_number, purchase_date, commissioning_date, life, depreciation_method||'SLM', salvage, annualDep.toFixed(2), cost, location, asset_tag, approved_by?'approved':'pending', approved_by]
      );
      res.json({ asset: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/capex/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { approval_status, status, accumulated_depreciation, book_value, disposal_date, disposal_value } = req.body;
      const result = await pool.query(
        'UPDATE capex_register SET approval_status=COALESCE($1,approval_status), status=COALESCE($2,status), accumulated_depreciation=COALESCE($3,accumulated_depreciation), book_value=COALESCE($4,book_value), disposal_date=$5, disposal_value=$6, updated_at=NOW() WHERE id=$7 AND tenant_id=$8 RETURNING *',
        [approval_status, status, accumulated_depreciation, book_value, disposal_date, disposal_value, req.params.id, tid(req)]
      );
      res.json({ asset: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
