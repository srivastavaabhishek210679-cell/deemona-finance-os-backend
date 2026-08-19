import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createBatch3DocsRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user?.tenantId;

  // ── 1. CORPORATE CHARTER ──────────────────────────────────
  router.get('/charter', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM corporate_charter WHERE tenant_id=$1 ORDER BY document_type, effective_date DESC', [tid(req)]);
      res.json({ documents: result.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/charter', requireAuth, async (req: Request, res: Response) => {
    try {
      const { document_type, document_title, document_number, issuing_authority, issue_date, effective_date, expiry_date, registered_address, authorized_capital, paid_up_capital, main_objects, file_name, version, notes } = req.body;
      const result = await pool.query(
        'INSERT INTO corporate_charter (tenant_id, document_type, document_title, document_number, issuing_authority, issue_date, effective_date, expiry_date, registered_address, authorized_capital, paid_up_capital, main_objects, file_name, version, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
        [tid(req), document_type, document_title, document_number, issuing_authority, issue_date, effective_date, expiry_date, registered_address, authorized_capital, paid_up_capital, main_objects, file_name, version||'1.0', notes]
      );
      res.json({ document: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/charter/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, last_amended_date, amendment_details, version } = req.body;
      const result = await pool.query(
        'UPDATE corporate_charter SET status=$1, last_amended_date=$2, amendment_details=$3, version=$4, updated_at=NOW() WHERE id=$5 AND tenant_id=$6 RETURNING *',
        [status, last_amended_date, amendment_details, version, req.params.id, tid(req)]
      );
      res.json({ document: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.delete('/charter/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      await pool.query('DELETE FROM corporate_charter WHERE id=$1 AND tenant_id=$2', [req.params.id, tid(req)]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 2. POLICY MANUALS ─────────────────────────────────────
  router.get('/policies', requireAuth, async (req: Request, res: Response) => {
    try {
      const { category, status } = req.query;
      let q = 'SELECT * FROM policy_manuals WHERE tenant_id=$1';
      const params: any[] = [tid(req)];
      if (category) { params.push(category); q += ` AND policy_category=$${params.length}`; }
      if (status) { params.push(status); q += ` AND status=$${params.length}`; }
      q += ' ORDER BY policy_category, policy_name';
      const result = await pool.query(q, params);
      const summary = await pool.query(
        "SELECT policy_category, COUNT(*) as count FROM policy_manuals WHERE tenant_id=$1 AND status='active' GROUP BY policy_category ORDER BY count DESC",
        [tid(req)]
      );
      res.json({ policies: result.rows, summary: summary.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/policies', requireAuth, async (req: Request, res: Response) => {
    try {
      const { policy_name, policy_category, policy_owner, approving_authority, effective_date, next_review_date, scope, objective, policy_content, key_points, applicability, acknowledgment_required } = req.body;
      const policyCode = (policy_category||'POL').toUpperCase().substring(0,3) + '-' + Date.now().toString().slice(-6);
      const result = await pool.query(
        'INSERT INTO policy_manuals (tenant_id, policy_code, policy_name, policy_category, policy_owner, approving_authority, effective_date, next_review_date, scope, objective, policy_content, key_points, applicability, acknowledgment_required) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',
        [tid(req), policyCode, policy_name, policy_category, policy_owner, approving_authority, effective_date, next_review_date, scope, objective, policy_content, key_points||[], applicability||'all_employees', acknowledgment_required||false]
      );
      res.json({ policy: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/policies/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { status, version, review_date, policy_content } = req.body;
      const result = await pool.query(
        'UPDATE policy_manuals SET status=$1, version=$2, review_date=$3, policy_content=COALESCE($4,policy_content), updated_at=NOW() WHERE id=$5 AND tenant_id=$6 RETURNING *',
        [status, version, review_date, policy_content, req.params.id, tid(req)]
      );
      res.json({ policy: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 3. AML/KYC RECORDS ────────────────────────────────────
  router.get('/kyc', requireAuth, async (req: Request, res: Response) => {
    try {
      const { entity_type, kyc_status, risk_category } = req.query;
      let q = 'SELECT * FROM aml_kyc_records WHERE tenant_id=$1';
      const params: any[] = [tid(req)];
      if (entity_type) { params.push(entity_type); q += ` AND entity_type=$${params.length}`; }
      if (kyc_status) { params.push(kyc_status); q += ` AND kyc_status=$${params.length}`; }
      if (risk_category) { params.push(risk_category); q += ` AND risk_category=$${params.length}`; }
      q += ' ORDER BY created_at DESC';
      const result = await pool.query(q, params);
      const summary = await pool.query(
        "SELECT entity_type, kyc_status, risk_category, COUNT(*) as count FROM aml_kyc_records WHERE tenant_id=$1 GROUP BY entity_type, kyc_status, risk_category",
        [tid(req)]
      );
      const stats = await pool.query(
        "SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE kyc_status='verified') as verified, COUNT(*) FILTER (WHERE kyc_status='pending') as pending, COUNT(*) FILTER (WHERE risk_category='high') as high_risk, COUNT(*) FILTER (WHERE suspicious_activity_reported=true) as sar_filed FROM aml_kyc_records WHERE tenant_id=$1",
        [tid(req)]
      );
      res.json({ records: result.rows, summary: summary.rows, stats: stats.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/kyc', requireAuth, async (req: Request, res: Response) => {
    try {
      const { entity_type, entity_name, pan_number, aadhaar_number, passport_number, registered_address, correspondence_address, business_type, cin_llpin, gstin, risk_category, pep_status, verification_date, verified_by, next_review_date, documents_collected, notes } = req.body;
      // Mask Aadhaar - show only last 4 digits
      const maskedAadhaar = aadhaar_number ? 'XXXX-XXXX-' + aadhaar_number.replace(/\D/g,'').slice(-4) : null;
      const result = await pool.query(
        'INSERT INTO aml_kyc_records (tenant_id, entity_type, entity_name, pan_number, aadhaar_number, passport_number, registered_address, correspondence_address, business_type, cin_llpin, gstin, risk_category, pep_status, verification_date, verified_by, next_review_date, documents_collected, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *',
        [tid(req), entity_type, entity_name, pan_number, maskedAadhaar, passport_number, registered_address, correspondence_address, business_type, cin_llpin, gstin, risk_category||'low', pep_status||false, verification_date, verified_by, next_review_date, documents_collected||[], notes]
      );
      res.json({ record: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/kyc/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { kyc_status, risk_category, rejection_reason, next_review_date, suspicious_activity_reported, sar_date } = req.body;
      const result = await pool.query(
        'UPDATE aml_kyc_records SET kyc_status=$1, risk_category=COALESCE($2,risk_category), rejection_reason=$3, next_review_date=COALESCE($4,next_review_date), suspicious_activity_reported=COALESCE($5,suspicious_activity_reported), sar_date=$6, updated_at=NOW() WHERE id=$7 AND tenant_id=$8 RETURNING *',
        [kyc_status, risk_category, rejection_reason, next_review_date, suspicious_activity_reported, sar_date, req.params.id, tid(req)]
      );
      res.json({ record: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── 4. REGULATORY FILINGS ─────────────────────────────────
  router.get('/filings', requireAuth, async (req: Request, res: Response) => {
    try {
      const { filing_type, filing_status, year } = req.query;
      let q = 'SELECT * FROM regulatory_filings WHERE tenant_id=$1';
      const params: any[] = [tid(req)];
      if (filing_type) { params.push(filing_type); q += ` AND filing_type=$${params.length}`; }
      if (filing_status) { params.push(filing_status); q += ` AND filing_status=$${params.length}`; }
      q += ' ORDER BY due_date DESC';
      const result = await pool.query(q, params);
      const summary = await pool.query(
        "SELECT filing_status, COUNT(*) as count, COALESCE(SUM(amount_paid),0) as total_paid, COALESCE(SUM(late_fee+penalty),0) as total_penalties FROM regulatory_filings WHERE tenant_id=$1 GROUP BY filing_status",
        [tid(req)]
      );
      const upcoming = await pool.query(
        "SELECT * FROM regulatory_filings WHERE tenant_id=$1 AND filing_status='pending' AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30 ORDER BY due_date ASC LIMIT 5",
        [tid(req)]
      );
      res.json({ filings: result.rows, summary: summary.rows, upcoming: upcoming.rows });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post('/filings', requireAuth, async (req: Request, res: Response) => {
    try {
      const { filing_type, filing_subtype, regulatory_body, filing_period, due_date, prepared_by, reviewed_by, filing_mode, remarks } = req.body;
      const result = await pool.query(
        'INSERT INTO regulatory_filings (tenant_id, filing_type, filing_subtype, regulatory_body, filing_period, due_date, prepared_by, reviewed_by, filing_mode, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [tid(req), filing_type, filing_subtype, regulatory_body, filing_period, due_date, prepared_by, reviewed_by, filing_mode||'online', remarks]
      );
      res.json({ filing: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch('/filings/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { filing_status, filing_date, acknowledgment_number, amount_paid, late_fee, interest_paid, penalty, filed_by, document_url } = req.body;
      const result = await pool.query(
        'UPDATE regulatory_filings SET filing_status=$1, filing_date=$2, acknowledgment_number=$3, amount_paid=$4, late_fee=$5, interest_paid=$6, penalty=$7, filed_by=$8, document_url=$9, updated_at=NOW() WHERE id=$10 AND tenant_id=$11 RETURNING *',
        [filing_status, filing_date, acknowledgment_number, amount_paid||0, late_fee||0, interest_paid||0, penalty||0, filed_by, document_url, req.params.id, tid(req)]
      );
      res.json({ filing: result.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // Seed common regulatory filings for new tenants
  router.post('/filings/seed', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const fy = req.body.financial_year || '2024-25';
      const filings = [
        // GST Returns
        { type: 'gst_return', sub: 'GSTR-1', body: 'GST', period: 'Monthly', due: '11th of next month', mode: 'online' },
        { type: 'gst_return', sub: 'GSTR-3B', body: 'GST', period: 'Monthly', due: '20th of next month', mode: 'online' },
        { type: 'gst_return', sub: 'GSTR-9', body: 'GST', period: `FY ${fy}`, due: `2024-12-31`, mode: 'online' },
        // TDS Returns
        { type: 'tds_return', sub: 'Form 24Q', body: 'IT_DEPT', period: 'Q1', due: `2024-07-31`, mode: 'online' },
        { type: 'tds_return', sub: 'Form 26Q', body: 'IT_DEPT', period: 'Q1', due: `2024-07-31`, mode: 'online' },
        // Income Tax
        { type: 'income_tax', sub: 'ITR-6', body: 'IT_DEPT', period: `FY ${fy}`, due: `2024-10-31`, mode: 'online' },
        // ROC/MCA
        { type: 'roc_filing', sub: 'MGT-7', body: 'MCA', period: `FY ${fy}`, due: `2024-11-29`, mode: 'online' },
        { type: 'roc_filing', sub: 'AOC-4', body: 'MCA', period: `FY ${fy}`, due: `2024-10-29`, mode: 'online' },
        // PF/ESIC
        { type: 'pf_return', sub: 'ECR', body: 'EPFO', period: 'Monthly', due: '15th of next month', mode: 'online' },
        { type: 'esic_return', sub: 'ESIC Return', body: 'ESIC', period: 'Half-yearly', due: `2024-11-11`, mode: 'online' },
      ];

      let seeded = 0;
      for (const f of filings) {
        const exists = await pool.query(
          'SELECT id FROM regulatory_filings WHERE tenant_id=$1 AND filing_subtype=$2 AND filing_period=$3 LIMIT 1',
          [tenantId, f.sub, f.period]
        );
        if (!exists.rows.length) {
          const dueDate = f.due.match(/^\d{4}-\d{2}-\d{2}$/) ? f.due : new Date(Date.now() + 30*86400000).toISOString().split('T')[0];
          await pool.query(
            'INSERT INTO regulatory_filings (tenant_id, filing_type, filing_subtype, regulatory_body, filing_period, due_date, filing_mode) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [tenantId, f.type, f.sub, f.body, f.period, dueDate, f.mode]
          );
          seeded++;
        }
      }
      res.json({ success: true, seeded, message: `Seeded ${seeded} regulatory filing templates` });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
