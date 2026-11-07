// ============================================================
// Missing Documents Routes — All 10 document types
// File: src/routes/missingDocsRoutes.ts
// ============================================================

import { cashAsOf } from '../services/cashPosition';
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createMissingDocsRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user?.tenantId;

  // ── 1. DOCUMENT VAULT ─────────────────────────────────────
  router.get('/vault', requireAuth, async (req: Request, res: Response) => {
    try {
      const { type, status, search } = req.query;
      let q = 'SELECT * FROM document_vault WHERE tenant_id=$1';
      const params: any[] = [tid(req)];
      if (type) { params.push(type); q += ` AND document_type=$${params.length}`; }
      if (status) { params.push(status); q += ` AND status=$${params.length}`; }
      if (search) { params.push(`%${search}%`); q += ` AND (title ILIKE $${params.length} OR vendor_name ILIKE $${params.length} OR reference_number ILIKE $${params.length})`; }
      q += ' ORDER BY created_at DESC LIMIT 100';
      const result = await pool.query(q, params);
      const stats = await pool.query(
        "SELECT document_type, COUNT(*) as count, COALESCE(SUM(amount),0) as total FROM document_vault WHERE tenant_id=$1 GROUP BY document_type",
        [tid(req)]
      );
      res.json({ documents: result.rows, stats: stats.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/vault', requireAuth, async (req: Request, res: Response) => {
    try {
      const { title, document_type, file_name, file_url, vendor_name, amount, document_date, reference_number, tags, extracted_data } = req.body;
      const result = await pool.query(
        'INSERT INTO document_vault (tenant_id, title, document_type, file_name, file_url, vendor_name, amount, document_date, reference_number, tags, extracted_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [tid(req), title, document_type, file_name, file_url, vendor_name, amount, document_date, reference_number, tags, extracted_data]
      );
      res.json({ document: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/vault/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, extracted_data } = req.body;
      const result = await pool.query(
        'UPDATE document_vault SET status=$1, extracted_data=$2, updated_at=NOW() WHERE id=$3 AND tenant_id=$4 RETURNING *',
        [status, extracted_data, req.params.id, tid(req)]
      );
      res.json({ document: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.delete('/vault/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      await pool.query('DELETE FROM document_vault WHERE id=$1 AND tenant_id=$2', [req.params.id, tid(req)]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 2. LOAN AGREEMENTS ────────────────────────────────────
  router.get('/loans', requireAuth, async (req: Request, res: Response) => {
    try {
      const loans = await pool.query(
        'SELECT l.*, COALESCE(SUM(r.total_payment),0) as total_paid FROM loan_agreements l LEFT JOIN loan_repayments r ON r.loan_id=l.id WHERE l.tenant_id=$1 GROUP BY l.id ORDER BY l.created_at DESC',
        [tid(req)]
      );
      const summary = await pool.query(
        "SELECT COUNT(*) as total, COALESCE(SUM(principal_amount),0) as total_borrowed, COALESCE(SUM(outstanding_balance),0) as total_outstanding FROM loan_agreements WHERE tenant_id=$1 AND status='active'",
        [tid(req)]
      );
      res.json({ loans: loans.rows, summary: summary.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/loans', requireAuth, async (req: Request, res: Response) => {
    try {
      const { lender_name, lender_type, loan_type, principal_amount, interest_rate, interest_type, tenure_months, emi_amount, disbursement_date, first_emi_date, collateral, purpose } = req.body;
      const loanNum = 'LN-' + Date.now().toString().slice(-8);
      const maturityDate = first_emi_date ? new Date(new Date(first_emi_date).setMonth(new Date(first_emi_date).getMonth() + (tenure_months || 12))).toISOString().split('T')[0] : null;
      const result = await pool.query(
        'INSERT INTO loan_agreements (tenant_id, loan_number, lender_name, lender_type, loan_type, principal_amount, interest_rate, interest_type, tenure_months, emi_amount, disbursement_date, first_emi_date, maturity_date, outstanding_balance, collateral, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
        [tid(req), loanNum, lender_name, lender_type, loan_type, principal_amount, interest_rate, interest_type, tenure_months, emi_amount, disbursement_date, first_emi_date, maturityDate, principal_amount, collateral, purpose]
      );
      res.json({ loan: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/loans/:id/repayments', requireAuth, async (req: Request, res: Response) => {
    try {
      const { payment_date, principal_component, interest_component, payment_mode, reference } = req.body;
      const total = parseFloat(principal_component) + parseFloat(interest_component);
      const result = await pool.query(
        'INSERT INTO loan_repayments (loan_id, tenant_id, payment_date, principal_component, interest_component, total_payment, payment_mode, reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [req.params.id, tid(req), payment_date, principal_component, interest_component, total, payment_mode, reference]
      );
      // Update outstanding balance
      await pool.query(
        'UPDATE loan_agreements SET outstanding_balance=outstanding_balance-$1, updated_at=NOW() WHERE id=$2',
        [principal_component, req.params.id]
      );
      res.json({ repayment: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get('/loans/:id/repayments', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM loan_repayments WHERE loan_id=$1 ORDER BY payment_date DESC', [req.params.id]);
      res.json({ repayments: result.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 3. GRATUITY RECORDS ───────────────────────────────────
  router.get('/gratuity', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'SELECT * FROM gratuity_records WHERE tenant_id=$1 ORDER BY created_at DESC',
        [tid(req)]
      );
      const summary = await pool.query(
        "SELECT COUNT(*) as total, COALESCE(SUM(gratuity_amount),0) as total_liability, COUNT(*) FILTER (WHERE status='paid') as paid_count FROM gratuity_records WHERE tenant_id=$1",
        [tid(req)]
      );
      res.json({ records: result.rows, summary: summary.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/gratuity', requireAuth, async (req: Request, res: Response) => {
    try {
      const { employee_name, employee_id, date_of_joining, date_of_leaving, last_drawn_salary, remarks } = req.body;
      const doj = new Date(date_of_joining);
      const dol = new Date(date_of_leaving || Date.now());
      const years = (dol.getTime() - doj.getTime()) / (365.25 * 24 * 3600 * 1000);
      const salary = parseFloat(last_drawn_salary);
      // Gratuity = (15/26) * last salary * years of service
      const gratuity = Math.round((15 / 26) * salary * years);
      const result = await pool.query(
        'INSERT INTO gratuity_records (tenant_id, employee_id, employee_name, date_of_joining, date_of_leaving, years_of_service, last_drawn_salary, gratuity_amount, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [tid(req), employee_id, employee_name, date_of_joining, date_of_leaving, years.toFixed(2), salary, gratuity, remarks]
      );
      res.json({ record: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/gratuity/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, payment_date } = req.body;
      const result = await pool.query(
        'UPDATE gratuity_records SET status=$1, payment_date=$2, updated_at=NOW() WHERE id=$3 AND tenant_id=$4 RETURNING *',
        [status, payment_date, req.params.id, tid(req)]
      );
      res.json({ record: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 4. RISK ASSESSMENT ────────────────────────────────────
  router.get('/risks', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'SELECT * FROM risk_assessments WHERE tenant_id=$1 ORDER BY risk_score DESC',
        [tid(req)]
      );
      const heatmap = await pool.query(
        "SELECT risk_category, risk_level, COUNT(*) as count FROM risk_assessments WHERE tenant_id=$1 AND status='open' GROUP BY risk_category, risk_level",
        [tid(req)]
      );
      res.json({ risks: result.rows, heatmap: heatmap.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/risks', requireAuth, async (req: Request, res: Response) => {
    try {
      const { title, risk_category, risk_description, likelihood, impact, mitigation_plan, owner, review_date } = req.body;
      const score = likelihood * impact;
      const level = score >= 20 ? 'critical' : score >= 12 ? 'high' : score >= 6 ? 'medium' : 'low';
      const result = await pool.query(
        'INSERT INTO risk_assessments (tenant_id, title, risk_category, risk_description, likelihood, impact, risk_level, mitigation_plan, owner, review_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [tid(req), title, risk_category, risk_description, likelihood, impact, level, mitigation_plan, owner, review_date]
      );
      res.json({ risk: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/risks/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, mitigation_plan } = req.body;
      const result = await pool.query(
        'UPDATE risk_assessments SET status=$1, mitigation_plan=$2, updated_at=NOW() WHERE id=$3 AND tenant_id=$4 RETURNING *',
        [status, mitigation_plan, req.params.id, tid(req)]
      );
      res.json({ risk: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 5. COST SHEETS ────────────────────────────────────────
  router.get('/cost-sheets', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'SELECT cs.*, COALESCE(json_agg(csi.*) FILTER (WHERE csi.id IS NOT NULL),\'[]\') as items FROM cost_sheets cs LEFT JOIN cost_sheet_items csi ON csi.cost_sheet_id=cs.id WHERE cs.tenant_id=$1 GROUP BY cs.id ORDER BY cs.created_at DESC',
        [tid(req)]
      );
      res.json({ cost_sheets: result.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/cost-sheets', requireAuth, async (req: Request, res: Response) => {
    try {
      const { title, product_service, period, direct_material, direct_labour, manufacturing_overhead, admin_overhead, selling_overhead, selling_price, units_produced, notes, items } = req.body;
      const totalCost = parseFloat(direct_material||0) + parseFloat(direct_labour||0) + parseFloat(manufacturing_overhead||0) + parseFloat(admin_overhead||0) + parseFloat(selling_overhead||0);
      const costPerUnit = units_produced > 0 ? totalCost / units_produced : totalCost;
      const margin = selling_price > 0 ? ((selling_price - costPerUnit) / selling_price * 100).toFixed(2) : 0;
      const result = await pool.query(
        'INSERT INTO cost_sheets (tenant_id, title, product_service, period, direct_material, direct_labour, manufacturing_overhead, admin_overhead, selling_overhead, total_cost, selling_price, profit_margin, units_produced, cost_per_unit, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
        [tid(req), title, product_service, period, direct_material, direct_labour, manufacturing_overhead, admin_overhead, selling_overhead, totalCost, selling_price, margin, units_produced||1, costPerUnit, notes]
      );
      const cs = result.rows[0];
      if (items?.length) {
        for (const item of items) {
          await pool.query('INSERT INTO cost_sheet_items (cost_sheet_id, category, description, amount, quantity, unit) VALUES ($1,$2,$3,$4,$5,$6)', [cs.id, item.category, item.description, item.amount, item.quantity||1, item.unit]);
        }
      }
      res.json({ cost_sheet: cs });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 6. CONTINGENT LIABILITIES ─────────────────────────────
  router.get('/contingent-liabilities', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'SELECT * FROM contingent_liabilities WHERE tenant_id=$1 ORDER BY estimated_amount DESC',
        [tid(req)]
      );
      const summary = await pool.query(
        "SELECT probability, COUNT(*) as count, COALESCE(SUM(estimated_amount),0) as total FROM contingent_liabilities WHERE tenant_id=$1 AND status='open' GROUP BY probability",
        [tid(req)]
      );
      res.json({ liabilities: result.rows, summary: summary.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/contingent-liabilities', requireAuth, async (req: Request, res: Response) => {
    try {
      const { title, liability_type, description, estimated_amount, probability, expected_resolution_date, legal_case_number, court_jurisdiction, opposing_party, legal_counsel, notes } = req.body;
      const result = await pool.query(
        'INSERT INTO contingent_liabilities (tenant_id, title, liability_type, description, estimated_amount, probability, expected_resolution_date, legal_case_number, court_jurisdiction, opposing_party, legal_counsel, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
        [tid(req), title, liability_type, description, estimated_amount, probability, expected_resolution_date, legal_case_number, court_jurisdiction, opposing_party, legal_counsel, notes]
      );
      res.json({ liability: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/contingent-liabilities/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, notes } = req.body;
      const result = await pool.query(
        'UPDATE contingent_liabilities SET status=$1, notes=$2, updated_at=NOW() WHERE id=$3 AND tenant_id=$4 RETURNING *',
        [status, notes, req.params.id, tid(req)]
      );
      res.json({ liability: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 7. AGM MINUTES ────────────────────────────────────────
  router.get('/agm', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'SELECT * FROM agm_minutes WHERE tenant_id=$1 ORDER BY meeting_date DESC',
        [tid(req)]
      );
      res.json({ meetings: result.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/agm', requireAuth, async (req: Request, res: Response) => {
    try {
      const { meeting_type, meeting_date, venue, chairman, company_secretary, attendees, agenda_items, resolutions_passed, next_meeting_date, notes } = req.body;
      const result = await pool.query(
        'INSERT INTO agm_minutes (tenant_id, meeting_type, meeting_date, venue, chairman, company_secretary, attendees, agenda_items, resolutions_passed, next_meeting_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [tid(req), meeting_type||'AGM', meeting_date, venue, chairman, company_secretary, JSON.stringify(attendees||[]), JSON.stringify(agenda_items||[]), JSON.stringify(resolutions_passed||[]), next_meeting_date, notes]
      );
      res.json({ meeting: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/agm/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, minutes_approved_by, minutes_approved_date } = req.body;
      const result = await pool.query(
        'UPDATE agm_minutes SET status=$1, minutes_approved_by=$2, minutes_approved_date=$3, updated_at=NOW() WHERE id=$4 AND tenant_id=$5 RETURNING *',
        [status, minutes_approved_by, minutes_approved_date, req.params.id, tid(req)]
      );
      res.json({ meeting: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 8. BOARD MEETINGS ─────────────────────────────────────
  router.get('/board-meetings', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'SELECT * FROM board_meetings WHERE tenant_id=$1 ORDER BY meeting_date DESC',
        [tid(req)]
      );
      res.json({ meetings: result.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/board-meetings', requireAuth, async (req: Request, res: Response) => {
    try {
      const { meeting_date, venue, mode, chairman, directors_present, directors_absent, agenda_items, decisions_taken, action_items, next_meeting_date, minutes_text } = req.body;
      const count = await pool.query('SELECT COUNT(*)+1 as num FROM board_meetings WHERE tenant_id=$1', [tid(req)]);
      const meetingNum = 'BM-' + new Date().getFullYear() + '-' + String(count.rows[0].num).padStart(3,'0');
      const result = await pool.query(
        'INSERT INTO board_meetings (tenant_id, meeting_number, meeting_date, venue, mode, chairman, directors_present, directors_absent, agenda_items, decisions_taken, action_items, next_meeting_date, minutes_text, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',
        [tid(req), meetingNum, meeting_date, venue, mode||'physical', chairman, directors_present||[], directors_absent||[], JSON.stringify(agenda_items||[]), JSON.stringify(decisions_taken||[]), JSON.stringify(action_items||[]), next_meeting_date, minutes_text, 'completed']
      );
      res.json({ meeting: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 9. SHAREHOLDER REGISTER ───────────────────────────────
  router.get('/shareholders', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'SELECT * FROM shareholder_register WHERE tenant_id=$1 ORDER BY shares_held DESC',
        [tid(req)]
      );
      const summary = await pool.query(
        'SELECT COUNT(*) as total_shareholders, SUM(shares_held) as total_shares, SUM(shares_held * paid_up_value) as paid_up_capital FROM shareholder_register WHERE tenant_id=$1 AND status=$2',
        [tid(req), 'active']
      );
      res.json({ shareholders: result.rows, summary: summary.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/shareholders', requireAuth, async (req: Request, res: Response) => {
    try {
      const { shareholder_name, shareholder_type, pan_number, share_class, shares_held, face_value, paid_up_value, address, email, phone, date_of_acquisition } = req.body;
      const folioNum = 'FLO-' + Date.now().toString().slice(-6);
      // Calculate % holding
      const totalShares = await pool.query('SELECT COALESCE(SUM(shares_held),0) as total FROM shareholder_register WHERE tenant_id=$1', [tid(req)]);
      const total = parseFloat(totalShares.rows[0].total) + parseFloat(shares_held);
      const pct = total > 0 ? ((shares_held / total) * 100).toFixed(2) : 0;
      const result = await pool.query(
        'INSERT INTO shareholder_register (tenant_id, shareholder_name, shareholder_type, pan_number, folio_number, share_class, shares_held, face_value, paid_up_value, percentage_holding, address, email, phone, date_of_acquisition) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',
        [tid(req), shareholder_name, shareholder_type||'individual', pan_number, folioNum, share_class||'equity', shares_held, face_value||10, paid_up_value||face_value||10, pct, address, email, phone, date_of_acquisition||new Date().toISOString().split('T')[0]]
      );
      res.json({ shareholder: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 10. WORKING CAPITAL ───────────────────────────────────
  router.get('/working-capital', requireAuth, async (req: Request, res: Response) => {
    try {
      // Get current working capital from existing tables
      const [ar, ap, inventory, cash] = await Promise.all([
        pool.query("SELECT COALESCE(SUM(balance_due),0) as val FROM ar_invoices WHERE tenant_id=$1 AND status IN ('sent','overdue')", [tid(req)]).catch(() => ({ rows: [{ val: 0 }] })),
        pool.query("SELECT COALESCE(SUM(balance_due),0) as val FROM ap_invoices WHERE tenant_id=$1 AND status IN ('pending','approved')", [tid(req)]).catch(() => ({ rows: [{ val: 0 }] })),
        pool.query("SELECT COALESCE(SUM(quantity * unit_cost),0) as val FROM inventory_items WHERE tenant_id=$1", [tid(req)]).catch(() => ({ rows: [{ val: 0 }] })),
        cashAsOf(pool, tid(req)).then((c: any) => ({ rows: [{ val: c.amount }] })).catch(() => ({ rows: [{ val: 0 }] })),
      ]);

      const currentAssets = {
        cash: parseFloat(cash.rows[0].val),
        accounts_receivable: parseFloat(ar.rows[0].val),
        inventory: parseFloat(inventory.rows[0].val),
        prepaid: 0,
        other: 0,
      };
      const currentLiabilities = {
        accounts_payable: parseFloat(ap.rows[0].val),
        short_term_loans: 0,
        accruals: 0,
        other: 0,
      };
      const totalCA = Object.values(currentAssets).reduce((a, b) => a + b, 0);
      const totalCL = Object.values(currentLiabilities).reduce((a, b) => a + b, 0);
      const nwc = totalCA - totalCL;
      const currentRatio = totalCL > 0 ? (totalCA / totalCL).toFixed(2) : 'N/A';
      const quickRatio = totalCL > 0 ? ((totalCA - currentAssets.inventory) / totalCL).toFixed(2) : 'N/A';
      const cashRatio = totalCL > 0 ? (currentAssets.cash / totalCL).toFixed(2) : 'N/A';

      // Get historical snapshots
      const history = await pool.query(
        'SELECT * FROM working_capital_snapshots WHERE tenant_id=$1 ORDER BY snapshot_date DESC LIMIT 6',
        [tid(req)]
      );

      res.json({
        current: { currentAssets, currentLiabilities, totalCA, totalCL, nwc, currentRatio, quickRatio, cashRatio },
        history: history.rows,
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/working-capital/snapshot', requireAuth, async (req: Request, res: Response) => {
    try {
      // Auto-calculate and save snapshot from existing data
      const [ar, ap, inventory, cash] = await Promise.all([
        pool.query("SELECT COALESCE(SUM(balance_due),0) as val FROM ar_invoices WHERE tenant_id=$1 AND status IN ('sent','overdue')", [tid(req)]).catch(() => ({ rows: [{ val: 0 }] })),
        pool.query("SELECT COALESCE(SUM(balance_due),0) as val FROM ap_invoices WHERE tenant_id=$1 AND status IN ('pending','approved')", [tid(req)]).catch(() => ({ rows: [{ val: 0 }] })),
        pool.query("SELECT COALESCE(SUM(quantity * unit_cost),0) as val FROM inventory_items WHERE tenant_id=$1", [tid(req)]).catch(() => ({ rows: [{ val: 0 }] })),
        cashAsOf(pool, tid(req)).then((c: any) => ({ rows: [{ val: c.amount }] })).catch(() => ({ rows: [{ val: 0 }] })),
      ]);
      const ca = { cash: parseFloat(cash.rows[0].val), accounts_receivable: parseFloat(ar.rows[0].val), inventory: parseFloat(inventory.rows[0].val), prepaid: 0, other: 0 };
      const cl = { accounts_payable: parseFloat(ap.rows[0].val), short_term_loans: 0, accruals: 0, other: 0 };
      const tca = Object.values(ca).reduce((a, b) => a + b, 0);
      const tcl = Object.values(cl).reduce((a, b) => a + b, 0);
      const result = await pool.query(
        'INSERT INTO working_capital_snapshots (tenant_id, current_assets, current_liabilities, total_current_assets, total_current_liabilities, net_working_capital, current_ratio, quick_ratio, cash_ratio) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [tid(req), JSON.stringify(ca), JSON.stringify(cl), tca, tcl, tca-tcl, tcl>0?(tca/tcl).toFixed(2):0, tcl>0?((tca-ca.inventory)/tcl).toFixed(2):0, tcl>0?(ca.cash/tcl).toFixed(2):0]
      );
      res.json({ snapshot: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
