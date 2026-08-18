// v4 - correct table names
// ============================================================
// Deemona AI Finance OS — Automation Engine V2
// File: src/services/automationEngine.ts
// Correct table names matching actual Neon DB schema
// ============================================================

import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Email helper ──────────────────────────────────────────────
async function sendEmail(to: string | string[], subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Deemona Finance OS <${process.env.FROM_EMAIL || 'onboarding@resend.dev'}>`,
        to: Array.isArray(to) ? to : [to],
        subject, html,
      }),
    });
    const d = await res.json() as any;
    return !!d.id;
  } catch { return false; }
}

// ── WhatsApp helper ───────────────────────────────────────────
async function sendWhatsApp(to: string, message: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
  if (!sid || !token) return false;
  try {
    const toNum = to.startsWith('whatsapp:') ? to : `whatsapp:+91${to.replace(/\D/g, '').slice(-10)}`;
    const body = new URLSearchParams({ From: from, To: toNum, Body: message });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const d = await res.json() as any;
    return !!d.sid;
  } catch { return false; }
}

// ── Log automation event ──────────────────────────────────────
async function logAutomation(pool: Pool, tenantId: string, type: string, status: string, detail: string) {
  try {
    const isUUID = /^[0-9a-f-]{36}$/i.test(tenantId);
    await pool.query(
      `INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [isUUID ? tenantId : null, type, status, detail]
    );
  } catch {}
  console.log(`[Automation][${type}] ${status}: ${detail}`);
}

// ── Get tenant notification email ─────────────────────────────
async function getTenantAdminEmail(pool: Pool, tenantId: string): Promise<string> {
  try {
    const monitor = await pool.query(
      'SELECT recipients FROM monitor_settings WHERE tenant_id=$1 LIMIT 1',
      [tenantId]
    );
    if (monitor.rows[0]?.recipients?.length > 0) return monitor.rows[0].recipients[0];
    const admin = await pool.query(
      "SELECT email FROM users WHERE role IN ('admin','owner') ORDER BY created_at ASC LIMIT 1"
    );
    if (admin.rows[0]?.email) return admin.rows[0].email;
  } catch {}
  return process.env.ADMIN_EMAIL || 'admin@deemona.com';
}

async function getTenantNotificationEmails(pool: Pool, tenantId: string): Promise<string[]> {
  try {
    const monitor = await pool.query(
      'SELECT recipients FROM monitor_settings WHERE tenant_id=$1 LIMIT 1',
      [tenantId]
    );
    if (monitor.rows[0]?.recipients?.length > 0) return monitor.rows[0].recipients;
    const admin = await pool.query(
      "SELECT email FROM users WHERE role IN ('admin','owner') ORDER BY created_at ASC LIMIT 3"
    );
    if (admin.rows.length > 0) return admin.rows.map((r: any) => r.email);
  } catch {}
  return [process.env.ADMIN_EMAIL || 'admin@deemona.com'];
}

async function getManagerPhone(pool: Pool, tenantId: string): Promise<string | null> {
  try {
    const result = await pool.query(
      `SELECT phone FROM employees WHERE role IN ('manager','admin','owner') AND phone IS NOT NULL LIMIT 1`
    );
    return result.rows[0]?.phone || null;
  } catch { return null; }
}

async function getMonthlyBurn(pool: Pool, tenantId: string): Promise<number> {
  try {
    const result = await pool.query(
      `SELECT COALESCE(SUM(amount),0) as burn FROM expenses WHERE created_at > NOW()-INTERVAL '30 days'`
    );
    return parseFloat(result.rows[0]?.burn || 0);
  } catch { return 0; }
}

// ============================================================
// 1. INVOICE AUTO-APPROVAL (uses ap_invoices table)
// ============================================================
export async function handleInvoiceAutoApproval(pool: Pool, tenantId: string, invoiceId: string): Promise<void> {
  try {
    const inv = await pool.query(
      `SELECT * FROM ap_invoices WHERE id=$1`,
      [invoiceId]
    );
    if (!inv.rows.length) return;
    const invoice = inv.rows[0];
    const amount = parseFloat(COALESCE(invoice.total_amount, invoice.balance_due, 0) || 0);
    const AUTO_APPROVE_THRESHOLD = 50000;

    if (amount <= AUTO_APPROVE_THRESHOLD && invoice.status === 'pending') {
      await pool.query(
        `UPDATE ap_invoices SET status='approved' WHERE id=$1`,
        [invoiceId]
      );
      const adminEmail = await getTenantAdminEmail(pool, tenantId);
      await sendEmail(adminEmail,
        `Auto-Approved: Invoice ${invoice.invoice_number}`,
        `<div style="font-family:Arial;padding:20px"><h2 style="color:#1B4FD8">Invoice Auto-Approved</h2>
        <p>Invoice <strong>${invoice.invoice_number}</strong> for <strong>${invoice.customer_name}</strong> auto-approved.</p>
        <p>Amount: <strong>Rs ${amount.toLocaleString('en-IN')}</strong></p>
        <p style="color:#64748B;font-size:12px">Deemona AI Finance OS</p></div>`
      );
      await logAutomation(pool, tenantId, 'INVOICE_AUTO_APPROVAL', 'success',
        `Auto-approved ${invoice.invoice_number} Rs ${amount}`);
    } else if (amount > AUTO_APPROVE_THRESHOLD) {
      const managerPhone = await getManagerPhone(pool, tenantId);
      if (managerPhone) {
        await sendWhatsApp(managerPhone,
          `*Deemona Finance* - Approval Required\n\nInvoice: ${invoice.invoice_number}\nAmount: Rs ${amount.toLocaleString('en-IN')}\nCustomer: ${invoice.customer_name}\n\nReply *APPROVE ${invoiceId.substring(0,8)}* or *REJECT ${invoiceId.substring(0,8)}*`
        );
      }
      await logAutomation(pool, tenantId, 'INVOICE_APPROVAL_REQUEST', 'sent',
        `Approval requested for ${invoice.invoice_number} Rs ${amount}`);
    }
  } catch (e) {
    console.error('[Automation] Invoice approval error:', e);
  }
}

// ============================================================
// 2. WHATSAPP APPROVAL FLOW
// ============================================================
export async function handleWhatsAppApprovalReply(pool: Pool, from: string, body: string): Promise<string> {
  const upper = body.trim().toUpperCase();
  const approveMatch = upper.match(/^APPROVE\s+([A-Z0-9]{8})/);
  const rejectMatch = upper.match(/^REJECT\s+([A-Z0-9]{8})/);
  if (!approveMatch && !rejectMatch) {
    return 'Reply APPROVE [ID] or REJECT [ID] to process an approval.';
  }
  const isApprove = !!approveMatch;
  const partialId = (approveMatch || rejectMatch)![1].toLowerCase();
  try {
    const result = await pool.query(
      `SELECT * FROM ap_invoices WHERE id::text LIKE $1 AND status='pending' LIMIT 1`,
      [`${partialId}%`]
    );
    if (!result.rows.length) return `Invoice not found or already processed.`;
    const invoice = result.rows[0];
    const newStatus = isApprove ? 'approved' : 'rejected';
    await pool.query(`UPDATE ap_invoices SET status=$1, updated_at=NOW() WHERE id=$2`, [newStatus, invoice.invoice_id]);
    const amount = parseFloat(COALESCE(invoice.total_amount, invoice.balance_due, 0) || 0);
    return `Invoice ${invoice.invoice_number} has been *${newStatus.toUpperCase()}*. Amount: Rs ${amount.toLocaleString('en-IN')}`;
  } catch {
    return 'Error processing approval. Please try again.';
  }
}

// ============================================================
// 3. EXPENSE AUTO-APPROVAL (uses expenses table)
// ============================================================
export async function handleExpenseAutoApproval(pool: Pool, tenantId: string, expenseId: string): Promise<void> {
  try {
    const result = await pool.query(`SELECT * FROM expense_claims WHERE id=$1`, [expenseId]);
    if (!result.rows.length) return;
    const expense = result.rows[0];
    const amount = parseFloat(expense.total_amount || 0);
    const AUTO_APPROVE_LIMIT = 15000;
    if (amount <= AUTO_APPROVE_LIMIT && expense.status === 'Pending') {
      await pool.query(`UPDATE expenses SET status='approved', updated_at=NOW() WHERE id=$1`, [expenseId]);
      const adminEmail = await getTenantAdminEmail(pool, tenantId);
      await sendEmail(adminEmail,
        `Expense Auto-Approved: ${expense.title}`,
        `<div style="font-family:Arial;padding:20px">
        <h2 style="color:#059669">Expense Auto-Approved</h2>
        <p>Expense <strong>${expense.title}</strong> by <strong>${expense.employee_name}</strong> for <strong>Rs ${amount.toLocaleString('en-IN')}</strong> has been automatically approved.</p>
        <p style="color:#64748B;font-size:12px">Deemona AI Finance OS</p></div>`
      );
      await logAutomation(pool, tenantId, 'EXPENSE_AUTO_APPROVAL', 'success',
        `Auto-approved expense ${expense.title} Rs ${amount}`);
    }
  } catch (e) { console.error('[Automation] Expense approval error:', e); }
}

// ============================================================
// 4. LOW CASH ALERT
// ============================================================
export async function checkLowCashAlert(pool: Pool, tenantId: string): Promise<void> {
  try {
    const alertCheck = await pool.query(
      `SELECT id FROM automation_logs WHERE automation_type='LOW_CASH_ALERT' AND created_at > NOW()-INTERVAL '24 hours' LIMIT 1`
    );
    if (alertCheck.rows.length > 0) return;

    // Use expenses as proxy for burn rate
    const burn = await getMonthlyBurn(pool, tenantId);
    const ALERT_THRESHOLD = 2000000;

    // Simulate cash check - in real app would query bank accounts
    const cashResult = await pool.query(
      `SELECT COALESCE(SUM(amount),0) as paid FROM vendor_payments WHERE payment_date > NOW()-INTERVAL '30 days'`
    ).catch(() => ({ rows: [{ paid: 0 }] }));

    const totalCash = 5000000; // Default simulation - replace with real bank balance query
    if (totalCash < ALERT_THRESHOLD || true) { // Always run for testing
      const recipients = await getTenantNotificationEmails(pool, tenantId);
      const runway = burn > 0 ? (totalCash / burn).toFixed(1) : 'N/A';
      await sendEmail(recipients,
        'Cash Position Alert — Deemona Finance',
        `<div style="font-family:Arial;padding:20px;background:#FEF2F2;border-left:4px solid #DC2626">
        <h2 style="color:#DC2626">Cash Flow Alert</h2>
        <p>Monthly burn rate: <strong>Rs ${burn.toLocaleString('en-IN')}</strong></p>
        <p>Estimated runway: <strong>${runway} months</strong></p>
        <p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Cash Monitor</p></div>`
      );
      await logAutomation(pool, tenantId, 'LOW_CASH_ALERT', 'sent', `Cash alert sent | Burn: Rs ${burn}`);
    }
  } catch (e) { console.error('[Automation] Low cash error:', e); }
}

// ============================================================
// 5. COMPLIANCE ALERTS (uses compliance_items table)
// ============================================================
export async function checkComplianceAlerts(pool: Pool, tenantId: string): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT * FROM compliance_items 
       WHERE status NOT IN ('Completed','Closed') 
       AND due_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'
       LIMIT 10`
    );
    if (!result.rows.length) return;
    const adminEmail = await getTenantAdminEmail(pool, tenantId);
    for (const item of result.rows) {
      const daysLeft = Math.ceil((new Date(item.due_date).getTime() - Date.now()) / 86400000);
      const isUrgent = daysLeft <= 2;
      await sendEmail(adminEmail,
        `${isUrgent ? 'URGENT: ' : ''}Compliance Due in ${daysLeft} days: ${item.title}`,
        `<div style="font-family:Arial;padding:20px;background:${isUrgent ? '#FEF2F2' : '#FFFBEB'};border-left:4px solid ${isUrgent ? '#DC2626' : '#D97706'}">
        <h2 style="color:${isUrgent ? '#DC2626' : '#D97706'}">${item.title}</h2>
        <p>Due in <strong>${daysLeft} days</strong> — ${new Date(item.due_date).toLocaleDateString('en-IN')}</p>
        <p>Category: ${item.category || 'General'}</p>
        <p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Compliance Monitor</p></div>`
      );
      await logAutomation(pool, tenantId, 'COMPLIANCE_ALERT', 'sent',
        `Compliance alert: ${item.title} due in ${daysLeft} days`);
    }
  } catch (e) { console.error('[Automation] Compliance error:', e); }
}

// ============================================================
// 6. NEW LEAD AUTO-NURTURE (uses deals table)
// ============================================================
export async function handleNewLeadNurture(pool: Pool, tenantId: string, dealId: string): Promise<void> {
  try {
    const result = await pool.query(`SELECT * FROM crm_leads WHERE id=$1`, [dealId]);
    if (!result.rows.length) return;
    const deal = result.rows[0];
    const adminEmail = await getTenantAdminEmail(pool, tenantId);
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 400,
      messages: [{ role: 'user', content: `Write a 2-paragraph professional welcome email for a new sales lead named ${deal.contact_name || ' - ' || deal.company_name} with deal value Rs ${0}. Be warm and professional.` }]
    });
    const emailBody = (aiResponse.content[0] as any).text || 'Thank you for your interest.';
    await sendEmail(adminEmail,
      `New Lead Alert: ${deal.contact_name || ' - ' || deal.company_name} — Rs ${parseFloat(0||0).toLocaleString('en-IN')}`,
      `<div style="font-family:Arial;padding:20px">
      <h2 style="color:#1B4FD8">New Lead: ${deal.contact_name || ' - ' || deal.company_name}</h2>
      <p>Customer: ${deal.contact_name || ' - ' || deal.company_name} | Value: Rs ${parseFloat(0||0).toLocaleString('en-IN')}</p>
      ${emailBody.split('\n').map((p: string) => p ? `<p>${p}</p>` : '').join('')}
      <p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Lead Nurture</p></div>`
    );
    await logAutomation(pool, tenantId, 'LEAD_NURTURE_EMAIL', 'sent', `Lead nurture email for ${deal.contact_name || ' - ' || deal.company_name}`);
  } catch (e) { console.error('[Automation] Lead nurture error:', e); }
}

// ============================================================
// 7. BANK RECONCILIATION (graceful skip - no bank_transactions table)
// ============================================================
export async function runBankReconciliation(pool: Pool, tenantId: string): Promise<{ matched: number; unmatched: number }> {
  // Bank transactions table not available in current schema
  // This will be enabled when bank sync is integrated
  await logAutomation(pool, tenantId, 'BANK_RECONCILIATION', 'skipped',
    'Bank transactions table not yet configured').catch(() => {});
  return { matched: 0, unmatched: 0 };
}

// ============================================================
// 8. VENDOR PAYMENT SCHEDULER (uses purchase_orders table)
// ============================================================
export async function checkVendorPaymentSchedule(pool: Pool, tenantId: string): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT po.*, COALESCE(s.name, po.vendor_name) as vendor_name 
       FROM purchase_orders po 
       LEFT JOIN suppliers s ON po.vendor_id=s.id
       WHERE po.status IN ('approved','Approved') 
       AND po.expected_delivery_date BETWEEN NOW() AND NOW()+INTERVAL '3 days'
       LIMIT 10`
    );
    if (!result.rows.length) return;
    const adminEmail = await getTenantAdminEmail(pool, tenantId);
    for (const po of result.rows) {
      const amount = parseFloat(po.total_amount || 0);
      const daysLeft = Math.ceil((new Date(po.expected_delivery_date).getTime() - Date.now()) / 86400000);
      await sendEmail(adminEmail,
        `PO Payment Due in ${daysLeft} days: ${po.po_number}`,
        `<div style="font-family:Arial;padding:20px;background:#FFFBEB;border-left:4px solid #D97706">
        <h2 style="color:#D97706">Purchase Order Due Soon</h2>
        <p>PO <strong>${po.po_number}</strong> from <strong>${po.vendor_name || 'Vendor'}</strong> due in ${daysLeft} days.</p>
        <p>Amount: Rs ${amount.toLocaleString('en-IN')}</p>
        <p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Payment Scheduler</p></div>`
      );
      await logAutomation(pool, tenantId, 'PAYMENT_SCHEDULED', 'notified', `PO ${po.po_number} due in ${daysLeft} days`);
    }
  } catch (e) { console.error('[Automation] Vendor payment error:', e); }
}

// ============================================================
// CRON JOBS
// ============================================================

// ── Ensure automation_logs table exists with correct schema ──
async function ensureAutomationLogs(pool: Pool): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS automation_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID,
        automation_type VARCHAR(100),
        status VARCHAR(50),
        detail TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Add missing columns if table exists without them
    await pool.query(`ALTER TABLE automation_logs ADD COLUMN IF NOT EXISTS automation_type VARCHAR(100)`).catch(() => {});
    await pool.query(`ALTER TABLE automation_logs ADD COLUMN IF NOT EXISTS status VARCHAR(50)`).catch(() => {});
    await pool.query(`ALTER TABLE automation_logs ADD COLUMN IF NOT EXISTS detail TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE automation_logs ADD COLUMN IF NOT EXISTS tenant_id UUID`).catch(() => {});
  } catch (e) {
    console.error('[Automation] Migration error:', e);
  }
}

export function registerAutomationCrons(pool: Pool): void {
  const MINUTE = 60000;
  const HOUR = 3600000;
  ensureAutomationLogs(pool).catch(() => {});
  console.log('[Automation] Registering automation cron jobs...');

  // Every 15 minutes
  setInterval(async () => {
    try {
      const tenants = await pool.query(`SELECT id FROM tenants LIMIT 20`);
      for (const tenant of tenants.rows) {
        const tid = tenant.id;
        await checkLowCashAlert(pool, tid).catch(() => {});
        await checkComplianceAlerts(pool, tid).catch(() => {});
        await checkVendorPaymentSchedule(pool, tid).catch(() => {});
      }
    } catch (e) { console.error('[Automation Cron]', e); }
  }, 15 * MINUTE);

  // Every hour
  setInterval(async () => {
    try {
      const tenants = await pool.query(`SELECT id FROM tenants LIMIT 20`);
      for (const tenant of tenants.rows) {
        await runBankReconciliation(pool, tenant.id).catch(() => {});
      }
    } catch (e) { console.error('[Automation Cron] Hourly:', e); }
  }, HOUR);

  // Hourly check for daily cron triggers
  setInterval(async () => {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const day = now.getUTCDate();
    try {
      const tenants = await pool.query(`SELECT id FROM tenants LIMIT 20`);
      for (const tenant of tenants.rows) {
        const adminEmail = await getTenantAdminEmail(pool, tenant.id);
        // GST reminder on 13th at 9AM IST (3:30 UTC)
        if (day === 13 && utcHour === 3) {
          await sendEmail(adminEmail, 'GST Filing Due in 5 Days',
            `<div style="font-family:Arial;padding:20px;background:#FEF2F2;border-left:4px solid #DC2626">
            <h2 style="color:#DC2626">GSTR-3B Due in 5 Days</h2>
            <p>File by the 20th to avoid late fees.</p>
            <a href="${process.env.FRONTEND_URL}/gst-portal" style="background:#1B4FD8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">File Now</a>
            </div>`);
          await logAutomation(pool, tenant.id, 'GST_REMINDER', 'sent', 'GST reminder sent');
        }
        // Payroll reminder on 28th at 9AM IST
        if (day === 28 && utcHour === 3) {
          await sendEmail(adminEmail, 'Payroll Processing Reminder',
            `<div style="font-family:Arial;padding:20px;background:#EEF3FD;border-left:4px solid #1B4FD8">
            <h2 style="color:#1B4FD8">Run Payroll Today</h2>
            <a href="${process.env.FRONTEND_URL}/payroll" style="background:#1B4FD8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Go to Payroll</a>
            </div>`);
          await logAutomation(pool, tenant.id, 'PAYROLL_REMINDER', 'sent', 'Payroll reminder sent');
        }
      }
    } catch (e) { console.error('[Automation Cron] Daily:', e); }
  }, HOUR);

  console.log('[Automation] Cron jobs registered: Cash alerts (15min), Bank recon (hourly), GST/Payroll (daily)');
}
