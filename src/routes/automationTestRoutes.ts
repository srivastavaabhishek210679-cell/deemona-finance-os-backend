import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import {
  handleInvoiceAutoApproval,
  handleExpenseAutoApproval,
  handleNewLeadNurture,
  checkLowCashAlert,
  checkComplianceAlerts,
  runBankReconciliation,
  checkVendorPaymentSchedule,
  handleWhatsAppApprovalReply,
} from '../services/automationEngine';

export function createAutomationTestRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user?.tenantId || 'af1845e2-39f3-4e9d-b1ed-91c2798a0f6f';

  router.get('/logs', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'SELECT automation_type, status, detail, created_at FROM automation_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',
        [tid(req)]
      );
      res.json({ logs: result.rows });
    } catch { res.json({ logs: [] }); }
  });

  router.get('/stats', requireAuth, async (_req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT automation_type, status, COUNT(*) as count FROM automation_logs GROUP BY automation_type, status');
      res.json({ stats: result.rows });
    } catch { res.json({ stats: [] }); }
  });

  router.post('/test/invoice-approval', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      // Get a vendor
      const vendor = await pool.query('SELECT id FROM vendors WHERE tenant_id=$1 LIMIT 1', [tenantId]);
      if (!vendor.rows.length) return res.json({ error: 'No vendors found. Add a vendor first in Procurement.' }) as any;
      const vendorId = vendor.rows[0].id;
      const invoiceNum = 'TEST-' + Date.now().toString().slice(-8);
      const result = await pool.query(
        'INSERT INTO ap_invoices (tenant_id, vendor_id, invoice_number, date, due_date, total_amount, status) VALUES ($1,$2,$3,CURRENT_DATE,CURRENT_DATE+30,25000,$4) RETURNING id, invoice_number',
        [tenantId, vendorId, invoiceNum, 'draft']
      );
      const invoice = result.rows[0];
      await handleInvoiceAutoApproval(pool, tenantId, invoice.id);
      const check = await pool.query('SELECT status FROM ap_invoices WHERE id=$1', [invoice.id]);
      res.json({
        message: 'Invoice ' + invoice.invoice_number + ' processed - status: ' + check.rows[0].status,
        detail: 'Invoice: ' + invoice.invoice_number + ' | Amount: Rs 25,000',
        success: true,
      });
    } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/expense-approval', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const claimNum = 'EXP-TEST-' + Date.now().toString().slice(-6);
      const result = await pool.query(
        'INSERT INTO expense_claims (tenant_id, claim_number, title, employee_name, total_amount, status, date) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE) RETURNING id, claim_number',
        [tenantId, claimNum, 'Test Expense Claim', 'Test Employee', 8500, 'submitted']
      );
      const claim = result.rows[0];
      await handleExpenseAutoApproval(pool, tenantId, claim.id);
      const check = await pool.query('SELECT status FROM expense_claims WHERE id=$1', [claim.id]);
      res.json({
        message: 'Expense ' + claim.claim_number + ' processed - status: ' + check.rows[0].status,
        detail: 'Claim: ' + claim.claim_number + ' | Amount: Rs 8,500',
        success: true,
      });
    } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/low-cash', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      await pool.query("DELETE FROM automation_logs WHERE automation_type='LOW_CASH_ALERT' AND created_at > NOW()-INTERVAL '24 hours'");
      const result = await pool.query('SELECT COALESCE(SUM(total_amount),0) as total FROM expense_claims WHERE tenant_id=$1', [tenantId]);
      const cash = parseFloat(result.rows[0].total || 0);
      await checkLowCashAlert(pool, tenantId);
      res.json({ message: 'Low cash alert test triggered', detail: 'Monthly expenses: Rs ' + cash.toLocaleString('en-IN'), success: true });
    } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/compliance', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      await pool.query(
        "INSERT INTO compliance_items (tenant_id, title, due_date, status, category) VALUES ($1,'TEST: GSTR-3B Filing',NOW()+INTERVAL '5 days','Pending','GST') ON CONFLICT DO NOTHING",
        [tenantId]
      );
      await pool.query("DELETE FROM automation_logs WHERE automation_type='COMPLIANCE_ALERT' AND created_at > NOW()-INTERVAL '24 hours'");
      await checkComplianceAlerts(pool, tenantId);
      res.json({ message: 'Compliance alert test triggered', detail: 'Created test item due in 5 days and sent reminder', success: true });
    } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/lead-nurture', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@deemona.com';
      const result = await pool.query(
        'INSERT INTO crm_leads (tenant_id, name, email, company, stage) VALUES ($1,$2,$3,$4,$5) RETURNING id, name',
        [tenantId, 'Test Lead', adminEmail, 'Test Company Pvt Ltd', 'new']
      );
      const lead = result.rows[0];
      await handleNewLeadNurture(pool, tenantId, lead.id);
      res.json({
        message: 'Lead nurture email sent for ' + lead.name,
        detail: 'Welcome email sent to ' + adminEmail,
        success: true,
      });
    } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/bank-recon', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await runBankReconciliation(pool, tid(req));
      res.json({ message: 'Bank reconciliation complete: ' + result.matched + ' matched, ' + result.unmatched + ' unmatched', detail: 'Matched ' + result.matched + ' transactions to invoices automatically', success: true });
    } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/vendor-payment', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      await pool.query("DELETE FROM automation_logs WHERE automation_type='PAYMENT_SCHEDULED' AND created_at > NOW()-INTERVAL '24 hours'");
      await checkVendorPaymentSchedule(pool, tenantId);
      const count = await pool.query("SELECT COUNT(*) FROM purchase_orders WHERE tenant_id=$1 AND status IN ('approved','Approved') AND expected_date BETWEEN NOW() AND NOW()+INTERVAL '3 days'", [tenantId]);
      res.json({ message: 'Vendor payment scheduler triggered', detail: 'Found ' + count.rows[0].count + ' orders due in 3 days. Alerts sent.', success: true });
    } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/gst-reminder', requireAuth, async (req: Request, res: Response) => {
    try {
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@deemona.com';
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Deemona Finance OS <' + (process.env.FROM_EMAIL || 'onboarding@resend.dev') + '>',
          to: [adminEmail],
          subject: '[TEST] GST Filing Due in 5 Days',
          html: '<div style="font-family:Arial;padding:20px;background:#FEF2F2;border-left:4px solid #DC2626"><h2 style="color:#DC2626">[TEST] GSTR-3B Due in 5 Days</h2><p>This is a test of the GST filing reminder. In production, this triggers on the 13th of every month at 9AM IST.</p></div>',
        }),
      }).then(r => r.json()) as any;
      await pool.query("INSERT INTO automation_logs (tenant_id, automation_type, status, detail) VALUES ($1,'GST_REMINDER','sent','Test GST reminder sent')", [tid(req)]);
      res.json({ message: 'GST reminder test email sent to ' + adminEmail, detail: 'Email ID: ' + (emailRes.id || 'N/A'), success: true });
    } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/payroll-reminder', requireAuth, async (req: Request, res: Response) => {
    try {
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@deemona.com';
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Deemona Finance OS <' + (process.env.FROM_EMAIL || 'onboarding@resend.dev') + '>',
          to: [adminEmail],
          subject: '[TEST] Payroll Processing Reminder',
          html: '<div style="font-family:Arial;padding:20px;background:#EEF3FD;border-left:4px solid #1B4FD8"><h2 style="color:#1B4FD8">[TEST] Run Payroll Today</h2><p>This is a test of the payroll reminder. In production, this triggers on the 28th of every month at 9AM IST.</p><a href="' + process.env.FRONTEND_URL + '/payroll" style="background:#1B4FD8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Go to Payroll</a></div>',
        }),
      }).then(r => r.json()) as any;
      await pool.query("INSERT INTO automation_logs (tenant_id, automation_type, status, detail) VALUES ($1,'PAYROLL_REMINDER','sent','Test payroll reminder sent')", [tid(req)]);
      res.json({ message: 'Payroll reminder test email sent to ' + adminEmail, detail: 'Email ID: ' + (emailRes.id || 'N/A'), success: true });
    } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/whatsapp-approval', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const inv = await pool.query("SELECT id, invoice_number FROM ap_invoices WHERE tenant_id=$1 AND status='draft' LIMIT 1", [tenantId]);
      if (!inv.rows.length) return res.json({ message: 'No draft invoices to approve. Create an AP invoice first.', success: false }) as any;
      const invoice = inv.rows[0];
      const partialId = invoice.id.substring(0, 8).toUpperCase();
      const reply = await handleWhatsAppApprovalReply(pool, 'whatsapp:+919999999999', 'APPROVE ' + partialId);
      res.json({ message: 'WhatsApp approval simulation complete', detail: reply, success: true });
    } catch (e) { res.json({ error: String(e) }); }
  });

  return router;
}
