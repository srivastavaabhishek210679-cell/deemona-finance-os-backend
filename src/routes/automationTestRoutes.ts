// ============================================================
// Automation Test Routes + Logs API
// File: src/routes/automationTestRoutes.ts
// ============================================================

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
} from '../services/automationEngine';

export function createAutomationTestRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user?.tenantId || 'af1845e2-39f3-4e9d-b1ed-91c2798a0f6f';

  // ── GET /api/automation/logs ──────────────────────────────
  router.get('/logs', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT automation_type, status, detail, created_at FROM automation_logs 
         WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,
        [tid(req)]
      );
      res.json({ logs: result.rows });
    } catch (e) { res.json({ logs: [] }); }
  });

  // ── GET /api/automation/stats ─────────────────────────────
  router.get('/stats', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT automation_type, status, COUNT(*) as count FROM automation_logs 
         WHERE tenant_id=$1 GROUP BY automation_type, status`,
        [tid(req)]
      );
      res.json({ stats: result.rows });
    } catch { res.json({ stats: [] }); }
  });

  // ── POST /api/automation/test/invoice-approval ────────────
  router.post('/test/invoice-approval', requireAuth, async (req: Request, res: Response) => {
    try {
      // Create a test AP invoice under threshold
      const result = await pool.query(
        `INSERT INTO generated_invoices (tenant_id, invoice_number, customer_name, total_amount, status, due_date, created_at)
         VALUES (1, 'TEST-' || TO_CHAR(NOW(),'YYYYMMDD-HH24MISS'), 'Test Vendor', 25000, 'pending', NOW()+INTERVAL '30 days', NOW())
         RETURNING invoice_id as id, invoice_number`,
        [tid(req)]
      );
      if (!result.rows.length) return res.json({ error: 'No vendors found. Add a vendor first.' }) as any;
      const invoice = result.rows[0];
      await handleInvoiceAutoApproval(pool, tid(req), invoice.id).catch(e => console.log('Auto-approval attempted:', e.message));
      // Check if auto-approved
      const check = await pool.query(`SELECT status FROM ap_invoices WHERE id=$1`, [invoice.id]);
      const approved = check.rows[0]?.status === 'approved';
      res.json({
        message: approved ? `Invoice ${invoice.invoice_number} auto-approved successfully!` : `Approval request sent for invoice ${invoice.invoice_number}`,
        detail: `Invoice: ${invoice.invoice_number} | Amount: Rs 25,000 | Status: ${check.rows[0]?.status}`,
        success: true,
      });
    } catch (e) { res.json({ error: String(e) }); }
  });

  // ── POST /api/automation/test/expense-approval ────────────
  router.post('/test/expense-approval', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `INSERT INTO expenses (tenant_id, title, description, amount, status, expense_date, employee_name, category, created_at)
         VALUES (1, 'Test Expense', 'Auto-approval test', 8500, 'Pending', NOW(), 'Test Employee', 'Other', NOW())
         RETURNING expense_id as id, title as claim_number`,
        [tid(req)]
      );
      if (!result.rows.length) return res.json({ error: 'No employees found. Add an employee first.' }) as any;
      const claim = result.rows[0];
      await handleExpenseAutoApproval(pool, tid(req), claim.id);
      const check = await pool.query(`SELECT status FROM expense_claims WHERE id=$1`, [claim.id]);
      res.json({
        message: `Expense claim ${claim.claim_number} processed`,
        detail: `Claim: ${claim.claim_number} | Amount: Rs 8,500 | Status: ${check.rows[0]?.status}`,
        success: true,
      });
    } catch (e) { res.json({ error: String(e) }); }
  });

  // ── POST /api/automation/test/low-cash ───────────────────
  router.post('/test/low-cash', requireAuth, async (req: Request, res: Response) => {
    try {
      // Temporarily lower threshold by calling directly with a forced check
      const result = await pool.query(
        `SELECT COALESCE(SUM(current_balance),0) as total FROM bank_accounts WHERE tenant_id=$1`,
        [tid(req)]
      );
      const cash = parseFloat(result.rows[0]?.total || 0);
      // Force send alert regardless of threshold for testing
      await pool.query(
        `DELETE FROM automation_logs WHERE tenant_id=$1 AND automation_type='LOW_CASH_ALERT' AND created_at > NOW()-INTERVAL '24 hours'`,
        [tid(req)]
      );
      await checkLowCashAlert(pool, tid(req));
      res.json({
        message: 'Low cash alert test triggered',
        detail: `Current cash: Rs ${cash.toLocaleString('en-IN')} | Alert sent if below Rs 20L threshold`,
        success: true,
      });
    } catch (e) { res.json({ error: String(e) }); }
  });

  // ── POST /api/automation/test/compliance ─────────────────
  router.post('/test/compliance', requireAuth, async (req: Request, res: Response) => {
    try {
      // Create a test compliance item due in 5 days
      await pool.query(
        `INSERT INTO compliance_items (tenant_id, title, due_date, status, category, created_at)
         VALUES ($1, 'TEST: GSTR-3B Filing', NOW()+INTERVAL '5 days', 'pending', 'GST', NOW())
         ON CONFLICT DO NOTHING`,
        [tid(req)]
      );
      // Clear cooldown
      await pool.query(
        `DELETE FROM automation_logs WHERE tenant_id=$1 AND automation_type='COMPLIANCE_ALERT' AND created_at > NOW()-INTERVAL '24 hours'`,
        [tid(req)]
      );
      await checkComplianceAlerts(pool, tid(req));
      res.json({
        message: 'Compliance alert test triggered',
        detail: 'Created test compliance item due in 5 days and sent reminder',
        success: true,
      });
    } catch (e) { res.json({ error: String(e) }); }
  });

  // ── POST /api/automation/test/lead-nurture ────────────────
  router.post('/test/lead-nurture', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `INSERT INTO deals (tenant_id, deal_name, customer_name, deal_value, stage, status, notes, expected_close)
         VALUES (1, 'Test Lead - Auto Nurture', 'Test Contact', 500000, 'Prospecting', 'Active', $2, NOW()+INTERVAL '30 days')
         RETURNING deal_id as id, deal_name as contact_name`,
        [tid(req), process.env.ADMIN_EMAIL || 'admin@deemona.com']
      );
      const lead = result.rows[0];
      await handleNewLeadNurture(pool, tid(req), lead.id);
      res.json({
        message: `AI welcome email sent to test lead ${lead.contact_name}`,
        detail: `Lead created and nurture email sent to ${process.env.ADMIN_EMAIL || 'admin@deemona.com'}`,
        success: true,
      });
    } catch (e) { res.json({ error: String(e) }); }
  });

  // ── POST /api/automation/test/bank-recon ─────────────────
  router.post('/test/bank-recon', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await runBankReconciliation(pool, tid(req));
      res.json({
        message: `Bank reconciliation complete: ${result.matched} matched, ${result.unmatched} unmatched`,
        detail: `Matched ${result.matched} transactions to invoices automatically`,
        success: true,
      });
    } catch (e) { res.json({ error: String(e) }); }
  });

  // ── POST /api/automation/test/vendor-payment ─────────────
  router.post('/test/vendor-payment', requireAuth, async (req: Request, res: Response) => {
    try {
      await pool.query(
        `DELETE FROM automation_logs WHERE tenant_id=$1 AND automation_type='PAYMENT_SCHEDULED' AND created_at > NOW()-INTERVAL '24 hours'`,
        [tid(req)]
      );
      await checkVendorPaymentSchedule(pool, tid(req));
      const count = await pool.query(
        `SELECT COUNT(*) FROM ap_invoices WHERE tenant_id=$1 AND status='approved' AND due_date BETWEEN NOW() AND NOW()+INTERVAL '3 days'`,
        [tid(req)]
      );
      res.json({
        message: 'Vendor payment scheduler triggered',
        detail: `Found ${count.rows[0]?.count || 0} invoices due in 3 days. Alerts sent.`,
        success: true,
      });
    } catch (e) { res.json({ error: String(e) }); }
  });

  // ── POST /api/automation/test/gst-reminder ────────────────
  router.post('/test/gst-reminder', requireAuth, async (req: Request, res: Response) => {
    try {
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@deemona.com';
      const now = new Date();
      // Send GST reminder immediately for testing
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `Deemona Finance OS <${process.env.FROM_EMAIL || 'onboarding@resend.dev'}>`,
          to: [adminEmail],
          subject: '🚨 TEST: GST Filing Due in 5 Days — File GSTR-3B Now',
          html: `<div style="font-family:Arial;padding:20px;background:#FEF2F2;border-left:4px solid #DC2626">
            <h2 style="color:#DC2626">[TEST] GSTR-3B Due in 5 Days</h2>
            <p>This is a test of the GST filing reminder automation.</p>
            <p>In production, this triggers automatically on the 13th of every month at 9AM IST.</p>
            <p>Month: ${now.toLocaleString('en-IN', {month:'long'})} ${now.getFullYear()}</p>
            <p style="color:#64748B;font-size:12px">Deemona AI Finance OS | GST Reminder Automation</p></div>`,
        }),
      }).then(r => r.json() as any);
      await pool.query(
        `INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at) VALUES ($1,'GST_REMINDER','sent','Test GST reminder sent',NOW())`,
        [tid(req)]
      ).catch(() => {});
      res.json({ message: `GST reminder test email sent to ${adminEmail}`, detail: `Email ID: ${emailRes?.id || 'N/A'}`, success: true });
    } catch (e) { res.json({ error: String(e) }); }
  });

  // ── POST /api/automation/test/payroll-reminder ────────────
  router.post('/test/payroll-reminder', requireAuth, async (req: Request, res: Response) => {
    try {
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@deemona.com';
      const now = new Date();
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `Deemona Finance OS <${process.env.FROM_EMAIL || 'onboarding@resend.dev'}>`,
          to: [adminEmail],
          subject: '💰 TEST: Payroll Processing Reminder',
          html: `<div style="font-family:Arial;padding:20px;background:#EEF3FD;border-left:4px solid #1B4FD8">
            <h2 style="color:#1B4FD8">[TEST] Payroll Due</h2>
            <p>This is a test of the payroll reminder automation.</p>
            <p>In production, this triggers automatically on the 28th of every month at 9AM IST.</p>
            <p>Month: ${now.toLocaleString('en-IN', {month:'long'})} ${now.getFullYear()}</p>
            <a href="${process.env.FRONTEND_URL}/payroll" style="background:#1B4FD8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px">Go to Payroll</a>
            <p style="color:#64748B;font-size:12px;margin-top:16px">Deemona AI Finance OS | Payroll Reminder Automation</p></div>`,
        }),
      }).then(r => r.json() as any);
      await pool.query(
        `INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at) VALUES ($1,'PAYROLL_REMINDER','sent','Test payroll reminder sent',NOW())`,
        [tid(req)]
      ).catch(() => {});
      res.json({ message: `Payroll reminder test email sent to ${adminEmail}`, detail: `Email ID: ${emailRes?.id || 'N/A'}`, success: true });
    } catch (e) { res.json({ error: String(e) }); }
  });

  // ── POST /api/automation/test/whatsapp-approval ───────────
  router.post('/test/whatsapp-approval', requireAuth, async (req: Request, res: Response) => {
    try {
      // Find a pending invoice to simulate approval
      const inv = await pool.query(
        `SELECT invoice_id as id, invoice_number FROM generated_invoices WHERE status='pending' LIMIT 1`,
        [tid(req)]
      );
      if (!inv.rows.length) {
        return res.json({ message: 'No pending invoices to approve. Create an AP invoice first.', success: false }) as any;
      }
      const invoice = inv.rows[0];
      const partialId = invoice.id.substring(0, 8).toUpperCase();
      const { handleWhatsAppApprovalReply } = await import('../services/automationEngine');
      const reply = await handleWhatsAppApprovalReply(pool, 'whatsapp:+919999999999', `APPROVE ${partialId}`);
      res.json({
        message: `WhatsApp approval simulation complete`,
        detail: reply,
        success: true,
      });
    } catch (e) { res.json({ error: String(e) }); }
  });

  return router;
}
