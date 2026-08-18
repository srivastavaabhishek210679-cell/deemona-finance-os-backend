// v2 - dynamic tenant email
// ============================================================
// Deemona AI Finance OS â€” Complete Automation Engine
// File: src/services/automationEngine.ts
// Handles all 10 automation workflows
// ============================================================

import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// â”€â”€ Email helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ WhatsApp helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendWhatsApp(to: string, message: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
  if (!sid || !token) return false;
  try {
    const toNum = to.startsWith('whatsapp:') ? to : `whatsapp:+91${to.replace(/\D/g,'').slice(-10)}`;
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

// â”€â”€ Log automation event â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function logAutomation(pool: Pool, tenantId: string, type: string, status: string, detail: string) {
  try {
    await pool.query(
      `INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT DO NOTHING`,
      [tenantId, type, status, detail]
    );
  } catch {}
  console.log(`[Automation][${type}] ${status}: ${detail}`);
}

// ============================================================
// 1. INVOICE AUTO-APPROVAL
// Triggered when AP invoice created â€” auto-approves if under threshold
// ============================================================
export async function handleInvoiceAutoApproval(pool: Pool, tenantId: string, invoiceId: string): Promise<void> {
  try {
    const inv = await pool.query(
      `SELECT i.*, v.name as vendor_name, v.phone as vendor_phone
       FROM ap_invoices i LEFT JOIN vendors v ON i.vendor_id=v.id
       WHERE i.id=$1 AND i.tenant_id=$2`,
      [invoiceId, tenantId]
    );
    if (!inv.rows.length) return;
    const invoice = inv.rows[0];
    const amount = parseFloat(invoice.total_amount || 0);

    // Auto-approval threshold: Rs 50,000
    const AUTO_APPROVE_THRESHOLD = 50000;

    if (amount <= AUTO_APPROVE_THRESHOLD && invoice.status === 'pending') {
      await pool.query(
        `UPDATE ap_invoices SET status='approved', approved_at=NOW(), approved_by='Auto-Approval Engine', updated_at=NOW() WHERE id=$1`,
        [invoiceId]
      );

      // Send WhatsApp to vendor if phone available
      if (invoice.vendor_phone) {
        await sendWhatsApp(invoice.vendor_phone,
          `*Deemona Finance* - Invoice Approved\n\nInvoice: ${invoice.invoice_number}\nAmount: Rs ${amount.toLocaleString('en-IN')}\nVendor: ${invoice.vendor_name}\n\nYour invoice has been auto-approved. Payment will be processed as per payment terms.`
        );
      }

      // Send email notification
      const adminEmail = await getTenantAdminEmail(pool, tenantId);
      await sendEmail(adminEmail,
        `Auto-Approved: Invoice ${invoice.invoice_number}`,
        `<div style="font-family:Arial;padding:20px"><h2 style="color:#1B4FD8">Invoice Auto-Approved</h2>
        <p>Invoice <strong>${invoice.invoice_number}</strong> from <strong>${invoice.vendor_name}</strong> has been automatically approved.</p>
        <p>Amount: <strong>Rs ${amount.toLocaleString('en-IN')}</strong></p>
        <p>Reason: Amount below auto-approval threshold of Rs ${AUTO_APPROVE_THRESHOLD.toLocaleString('en-IN')}</p>
        <p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Auto-Approval Engine</p></div>`
      );

      await logAutomation(pool, tenantId, 'INVOICE_AUTO_APPROVAL', 'success',
        `Auto-approved invoice ${invoice.invoice_number} for Rs ${amount}`);
    } else if (amount > AUTO_APPROVE_THRESHOLD) {
      // Send WhatsApp approval request to manager
      const managerPhone = await getManagerPhone(pool, tenantId);
      if (managerPhone) {
        await sendWhatsApp(managerPhone,
          `*Deemona Finance* - Approval Required\n\nInvoice: ${invoice.invoice_number}\nAmount: Rs ${amount.toLocaleString('en-IN')}\nVendor: ${invoice.vendor_name}\nDue: ${invoice.due_date ? new Date(invoice.due_date).toLocaleDateString('en-IN') : 'On receipt'}\n\nReply *APPROVE ${invoiceId.substring(0,8)}* or *REJECT ${invoiceId.substring(0,8)}*`
        );
      }
      await logAutomation(pool, tenantId, 'INVOICE_APPROVAL_REQUEST', 'sent',
        `Approval request sent for invoice ${invoice.invoice_number} Rs ${amount}`);
    }
  } catch (e) {
    console.error('[Automation] Invoice auto-approval error:', e);
  }
}

// ============================================================
// 2. WHATSAPP APPROVAL FLOW
// Process APPROVE/REJECT replies from WhatsApp
// ============================================================
export async function handleWhatsAppApprovalReply(pool: Pool, from: string, body: string): Promise<string> {
  const upper = body.trim().toUpperCase();

  // Extract invoice ID from message: "APPROVE abc12345" or "REJECT abc12345"
  const approveMatch = upper.match(/^APPROVE\s+([A-Z0-9]{8})/);
  const rejectMatch = upper.match(/^REJECT\s+([A-Z0-9]{8})/);

  if (!approveMatch && !rejectMatch) {
    return 'Thank you for your response. Reply APPROVE [ID] or REJECT [ID] to process an approval request.';
  }

  const isApprove = !!approveMatch;
  const partialId = (approveMatch || rejectMatch)![1].toLowerCase();

  try {
    // Find invoice by partial ID
    const result = await pool.query(
      `SELECT i.*, t.id as tenant_id FROM ap_invoices i 
       JOIN tenants t ON i.tenant_id=t.id
       WHERE i.id::text LIKE $1 AND i.status='pending'
       LIMIT 1`,
      [`${partialId}%`]
    );

    if (!result.rows.length) {
      return `Invoice not found or already processed. Please check the invoice ID and try again.`;
    }

    const invoice = result.rows[0];
    const newStatus = isApprove ? 'approved' : 'rejected';

    await pool.query(
      `UPDATE ap_invoices SET status=$1, approved_at=NOW(), approved_by='WhatsApp Approval', updated_at=NOW() WHERE id=$2`,
      [newStatus, invoice.id]
    );

    await logAutomation(pool, invoice.tenant_id, 'WHATSAPP_APPROVAL', 'success',
      `Invoice ${invoice.invoice_number} ${newStatus} via WhatsApp from ${from}`);

    const amount = parseFloat(invoice.total_amount || 0);
    return `âœ… Invoice ${invoice.invoice_number} has been *${newStatus.toUpperCase()}*.\nAmount: Rs ${amount.toLocaleString('en-IN')}\nProcessed via WhatsApp approval.`;
  } catch (e) {
    return 'Error processing approval. Please try again or use the Deemona Finance app.';
  }
}

// ============================================================
// 3. EXPENSE AUTO-APPROVAL
// Auto-approve expenses under threshold
// ============================================================
export async function handleExpenseAutoApproval(pool: Pool, tenantId: string, claimId: string): Promise<void> {
  try {
    const claim = await pool.query(
      `SELECT ec.*, e.first_name, e.last_name, e.email
       FROM expense_claims ec LEFT JOIN employees e ON ec.employee_id=e.id
       WHERE ec.id=$1 AND ec.tenant_id=$2`,
      [claimId, tenantId]
    );
    if (!claim.rows.length) return;
    const expense = claim.rows[0];
    const amount = parseFloat(expense.total_amount || 0);
    const AUTO_APPROVE_LIMIT = 15000; // Rs 15,000

    if (amount <= AUTO_APPROVE_LIMIT && expense.status === 'submitted') {
      await pool.query(
        `UPDATE expense_claims SET status='approved', approved_at=NOW(), approved_by='Auto-Approval', updated_at=NOW() WHERE id=$1`,
        [claimId]
      );

      if (expense.email) {
        await sendEmail(expense.email,
          `Expense Claim Auto-Approved: ${expense.claim_number}`,
          `<div style="font-family:Arial;padding:20px">
          <h2 style="color:#059669">Expense Claim Approved</h2>
          <p>Hi ${expense.first_name},</p>
          <p>Your expense claim <strong>${expense.claim_number}</strong> for <strong>Rs ${amount.toLocaleString('en-IN')}</strong> has been automatically approved.</p>
          <p>Reimbursement will be processed in the next payroll cycle.</p>
          <p style="color:#64748B;font-size:12px">Deemona AI Finance OS</p></div>`
        );
      }
      await logAutomation(pool, tenantId, 'EXPENSE_AUTO_APPROVAL', 'success',
        `Auto-approved expense ${expense.claim_number} Rs ${amount}`);
    }
  } catch (e) {
    console.error('[Automation] Expense auto-approval error:', e);
  }
}

// ============================================================
// 4. LOW CASH ALERT
// Send alert when cash drops below threshold
// ============================================================
export async function checkLowCashAlert(pool: Pool, tenantId: string): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT SUM(current_balance) as total_cash FROM bank_accounts WHERE tenant_id=$1 AND is_active=true`,
      [tenantId]
    );
    const totalCash = parseFloat(result.rows[0]?.total_cash || 0);
    const ALERT_THRESHOLD = 2000000; // Rs 20 lakhs

    // Check if alert already sent today
    const alertCheck = await pool.query(
      `SELECT id FROM automation_logs WHERE tenant_id=$1 AND automation_type='LOW_CASH_ALERT' AND created_at > NOW()-INTERVAL '24 hours'`,
      [tenantId]
    );
    if (alertCheck.rows.length > 0) return; // Already alerted today

    if (totalCash < ALERT_THRESHOLD) {
      const monthlyBurn = await getMonthlyBurn(pool, tenantId);
      const runway = monthlyBurn > 0 ? (totalCash / monthlyBurn).toFixed(1) : 'N/A';

      const recipients = await getTenantNotificationEmails(pool, tenantId);
      const adminEmail = recipients[0];
      const managerPhone = await getManagerPhone(pool, tenantId);

      const message = `*Deemona Finance - CASH ALERT*\n\nCurrent Cash Position: Rs ${totalCash.toLocaleString('en-IN')}\nMonthly Burn: Rs ${monthlyBurn.toLocaleString('en-IN')}\nRunway: ${runway} months\n\nâš ï¸ Cash below Rs 20L threshold. Immediate action required.`;

      if (managerPhone) await sendWhatsApp(managerPhone, message);

      await sendEmail(adminEmail,
        'âš ï¸ URGENT: Low Cash Alert â€” Deemona Finance',
        `<div style="font-family:Arial;padding:20px;background:#FEF2F2;border-left:4px solid #DC2626">
        <h2 style="color:#DC2626">Low Cash Alert</h2>
        <p>Cash position has fallen below the alert threshold.</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px;color:#64748B">Current Cash</td><td style="padding:8px;font-weight:bold">Rs ${totalCash.toLocaleString('en-IN')}</td></tr>
          <tr><td style="padding:8px;color:#64748B">Monthly Burn</td><td style="padding:8px">Rs ${monthlyBurn.toLocaleString('en-IN')}</td></tr>
          <tr><td style="padding:8px;color:#64748B">Runway</td><td style="padding:8px;color:#DC2626;font-weight:bold">${runway} months</td></tr>
        </table>
        <p style="color:#64748B;font-size:12px;margin-top:16px">Deemona AI Finance OS | Automated Alert</p></div>`
      );

      await logAutomation(pool, tenantId, 'LOW_CASH_ALERT', 'sent',
        `Cash alert: Rs ${totalCash} | Runway: ${runway} months`);
    }
  } catch (e) {
    console.error('[Automation] Low cash alert error:', e);
  }
}

// ============================================================
// 5. COMPLIANCE DEADLINE ALERTS
// Send reminders 7 days before due dates
// ============================================================
export async function checkComplianceAlerts(pool: Pool, tenantId: string): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT * FROM compliance_items 
       WHERE tenant_id=$1 AND status='pending' 
       AND due_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'
       AND id NOT IN (
         SELECT detail::text FROM automation_logs 
         WHERE tenant_id=$1 AND automation_type='COMPLIANCE_ALERT' 
         AND created_at > NOW()-INTERVAL '24 hours'
       )`,
      [tenantId]
    );

    if (!result.rows.length) return;

    const adminEmail = await getTenantAdminEmail(pool, tenantId);
    const managerPhone = await getManagerPhone(pool, tenantId);

    for (const item of result.rows) {
      const daysLeft = Math.ceil((new Date(item.due_date).getTime() - Date.now()) / 86400000);
      const isUrgent = daysLeft <= 2;

      const message = `${isUrgent ? 'ðŸš¨ URGENT' : 'âš ï¸'} *Compliance Deadline*\n\n${item.title}\nDue: ${new Date(item.due_date).toLocaleDateString('en-IN')} (${daysLeft} days)\n${item.penalty_amount ? `Penalty: Rs ${parseFloat(item.penalty_amount).toLocaleString('en-IN')}` : ''}\n\nFile on time to avoid penalties.`;

      if (managerPhone) await sendWhatsApp(managerPhone, message);

      await sendEmail(adminEmail,
        `${isUrgent ? 'ðŸš¨ URGENT: ' : 'âš ï¸ '}Compliance Due in ${daysLeft} days: ${item.title}`,
        `<div style="font-family:Arial;padding:20px;background:${isUrgent?'#FEF2F2':'#FFFBEB'};border-left:4px solid ${isUrgent?'#DC2626':'#D97706'}">
        <h2 style="color:${isUrgent?'#DC2626':'#D97706'}">${item.title}</h2>
        <p>Due in <strong>${daysLeft} days</strong> â€” ${new Date(item.due_date).toLocaleDateString('en-IN')}</p>
        ${item.penalty_amount ? `<p>Penalty for late filing: <strong>Rs ${parseFloat(item.penalty_amount).toLocaleString('en-IN')}</strong></p>` : ''}
        <p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Compliance Monitor</p></div>`
      );

      await logAutomation(pool, tenantId, 'COMPLIANCE_ALERT', 'sent', item.id);
    }
  } catch (e) {
    console.error('[Automation] Compliance alerts error:', e);
  }
}

// ============================================================
// 6. NEW LEAD AUTO-NURTURE
// Send welcome email when CRM lead is created
// ============================================================
export async function handleNewLeadNurture(pool: Pool, tenantId: string, leadId: string): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT * FROM crm_leads WHERE id=$1 AND tenant_id=$2`,
      [leadId, tenantId]
    );
    if (!result.rows.length) return;
    const lead = result.rows[0];
    if (!lead.contact_email) return;

    // Get tenant name
    const tenant = await pool.query('SELECT name FROM tenants WHERE id=$1', [tenantId]);
    const tenantName = tenant.rows[0]?.name || 'Deemona Technologies';

    // Generate personalized intro email using Claude
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Write a brief, professional welcome email for a new business lead.
Company: ${tenantName}
Lead Name: ${lead.contact_name}
Lead Company: ${lead.company_name || 'their organization'}
Deal Value: Rs ${parseFloat(lead.deal_value || 0).toLocaleString('en-IN')}
Keep it warm, professional, 3 short paragraphs. No placeholders.`
      }]
    });
    const emailBody = (aiResponse.content[0] as any).text || 'Thank you for your interest.';

    await sendEmail(lead.contact_email,
      `Thank you for your interest â€” ${tenantName}`,
      `<div style="font-family:Arial;padding:24px;max-width:600px">
      <h2 style="color:#1B4FD8">Welcome, ${lead.contact_name}!</h2>
      ${emailBody.split('\n').map(p => p ? `<p>${p}</p>` : '').join('')}
      <p style="color:#64748B;font-size:12px;margin-top:24px">This is an automated message from ${tenantName} | Powered by Deemona AI Finance OS</p>
      </div>`
    );

    // Schedule follow-up (log for 3-day follow-up)
    await pool.query(
      `INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at)
       VALUES ($1,'LEAD_FOLLOWUP_SCHEDULED','pending',$2,NOW()+INTERVAL '3 days')`,
      [tenantId, JSON.stringify({ leadId, email: lead.contact_email, name: lead.contact_name })]
    ).catch(() => {});

    await logAutomation(pool, tenantId, 'LEAD_NURTURE_EMAIL', 'sent',
      `Welcome email sent to ${lead.contact_name} at ${lead.contact_email}`);
  } catch (e) {
    console.error('[Automation] Lead nurture error:', e);
  }
}

// ============================================================
// 7. BANK RECONCILIATION AUTO-MATCH
// Match bank transactions to invoices automatically
// ============================================================
export async function runBankReconciliation(pool: Pool, tenantId: string): Promise<{ matched: number; unmatched: number }> {
  let matched = 0;
  let unmatched = 0;
  try {
    // Get unreconciled bank transactions
    const transactions = await pool.query(
      `SELECT * FROM bank_transactions WHERE tenant_id=$1 AND reconciled=false AND credit_amount > 0 ORDER BY transaction_date DESC LIMIT 100`,
      [tenantId]
    );

    for (const txn of transactions.rows) {
      const amount = parseFloat(txn.credit_amount);

      // Try to find matching AR invoice by amount (Â±1% tolerance)
      const invoice = await pool.query(
        `SELECT * FROM ar_invoices 
         WHERE tenant_id=$1 AND status IN ('sent','overdue')
         AND ABS(total_amount::numeric - $2) < $2 * 0.01
         ORDER BY due_date ASC LIMIT 1`,
        [tenantId, amount]
      );

      if (invoice.rows.length) {
        const inv = invoice.rows[0];
        // Mark transaction as reconciled
        await pool.query(
          `UPDATE bank_transactions SET reconciled=true, reconciled_invoice_id=$1, updated_at=NOW() WHERE id=$2`,
          [inv.id, txn.id]
        );
        // Mark invoice as paid
        await pool.query(
          `UPDATE ar_invoices SET status='paid', paid_date=NOW(), updated_at=NOW() WHERE id=$1`,
          [inv.id]
        );
        matched++;
        await logAutomation(pool, tenantId, 'BANK_RECONCILIATION', 'matched',
          `Txn Rs ${amount} matched to invoice ${inv.invoice_number}`);
      } else {
        unmatched++;
      }
    }
    return { matched, unmatched };
  } catch (e) {
    console.error('[Automation] Bank reconciliation error:', e);
    return { matched, unmatched };
  }
}

// ============================================================
// 8. VENDOR PAYMENT SCHEDULER
// Auto-schedule payments for invoices due in 3 days
// ============================================================
export async function checkVendorPaymentSchedule(pool: Pool, tenantId: string): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT ap.*, v.name as vendor_name, v.email as vendor_email, v.phone as vendor_phone
       FROM ap_invoices ap LEFT JOIN vendors v ON ap.vendor_id=v.id
       WHERE ap.tenant_id=$1 AND ap.status='approved'
       AND ap.due_date BETWEEN NOW() AND NOW()+INTERVAL '3 days'
       AND ap.id NOT IN (
         SELECT detail FROM automation_logs 
         WHERE tenant_id=$1 AND automation_type='PAYMENT_SCHEDULED'
         AND created_at > NOW()-INTERVAL '24 hours'
       )`,
      [tenantId]
    );

    if (!result.rows.length) return;

    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    for (const inv of result.rows) {
      const amount = parseFloat(inv.total_amount);
      const daysLeft = Math.ceil((new Date(inv.due_date).getTime() - Date.now()) / 86400000);

      // Notify admin to process payment
      await sendEmail(adminEmail,
        `Payment Due in ${daysLeft} days: ${inv.invoice_number} â€” Rs ${amount.toLocaleString('en-IN')}`,
        `<div style="font-family:Arial;padding:20px;background:#FFFBEB;border-left:4px solid #D97706">
        <h2 style="color:#D97706">Vendor Payment Due Soon</h2>
        <p>Invoice <strong>${inv.invoice_number}</strong> from <strong>${inv.vendor_name}</strong> is due in <strong>${daysLeft} days</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin-top:12px">
          <tr><td style="padding:6px;color:#64748B">Amount</td><td style="padding:6px;font-weight:bold">Rs ${amount.toLocaleString('en-IN')}</td></tr>
          <tr><td style="padding:6px;color:#64748B">Due Date</td><td style="padding:6px">${new Date(inv.due_date).toLocaleDateString('en-IN')}</td></tr>
          <tr><td style="padding:6px;color:#64748B">Vendor</td><td style="padding:6px">${inv.vendor_name}</td></tr>
        </table>
        <p style="margin-top:16px"><a href="${process.env.FRONTEND_URL}/accounting" style="background:#1B4FD8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Process Payment</a></p>
        <p style="color:#64748B;font-size:12px;margin-top:16px">Deemona AI Finance OS | Payment Scheduler</p></div>`
      );

      // WhatsApp alert to manager
      const managerPhone = await getManagerPhone(pool, tenantId);
      if (managerPhone) {
        await sendWhatsApp(managerPhone,
          `*Payment Due in ${daysLeft} days*\n\nInvoice: ${inv.invoice_number}\nVendor: ${inv.vendor_name}\nAmount: Rs ${amount.toLocaleString('en-IN')}\nDue: ${new Date(inv.due_date).toLocaleDateString('en-IN')}\n\nProcess at: ${process.env.FRONTEND_URL}/accounting`
        );
      }

      await logAutomation(pool, tenantId, 'PAYMENT_SCHEDULED', 'notified', inv.id);
    }
  } catch (e) {
    console.error('[Automation] Vendor payment scheduler error:', e);
  }
}

// ============================================================
// CRON JOBS â€” Register all scheduled automations
// ============================================================
export function registerAutomationCrons(pool: Pool): void {
  const HOUR = 3600000;
  const MINUTE = 60000;
  const DAY = 86400000;

  console.log('[Automation] Registering automation cron jobs...');

  // Every 15 minutes â€” check all active tenants
  setInterval(async () => {
    try {
      const tenants = await pool.query(`SELECT id FROM tenants WHERE is_active=true LIMIT 100`);
      for (const tenant of tenants.rows) {
        const tid = tenant.id;
        // Low cash alert check
        await checkLowCashAlert(pool, tid);
        // Compliance deadline alerts
        await checkComplianceAlerts(pool, tid);
        // Vendor payment schedule
        await checkVendorPaymentSchedule(pool, tid);
      }
    } catch (e) { console.error('[Automation Cron] Error:', e); }
  }, 15 * MINUTE);

  // Every hour â€” bank reconciliation
  setInterval(async () => {
    try {
      const tenants = await pool.query(`SELECT id FROM tenants WHERE is_active=true LIMIT 100`);
      for (const tenant of tenants.rows) {
        const result = await runBankReconciliation(pool, tenant.id);
        if (result.matched > 0) {
          console.log(`[Automation] Bank reconciliation: ${result.matched} matched, ${result.unmatched} unmatched for tenant ${tenant.id}`);
        }
      }
    } catch (e) { console.error('[Automation Cron] Bank recon error:', e); }
  }, HOUR);

  // Daily at 9 AM IST (3:30 AM UTC) â€” GST filing reminder on 13th
  setInterval(async () => {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const day = now.getUTCDate();

    // GST reminder on 13th (5 days before 18th due date) at 9AM IST
    if (day === 13 && utcHour === 3) {
      const tenants = await pool.query(`SELECT id FROM tenants WHERE is_active=true`);
      for (const tenant of tenants.rows) {
        const adminEmail = await getTenantAdminEmail(pool, tenant.id);
        await sendEmail(adminEmail,
          'ðŸš¨ GST Filing Due in 5 Days â€” File GSTR-3B Now',
          `<div style="font-family:Arial;padding:20px;background:#FEF2F2;border-left:4px solid #DC2626">
          <h2 style="color:#DC2626">GSTR-3B Due in 5 Days</h2>
          <p>GSTR-3B for ${now.toLocaleString('en-IN', {month:'long'})} ${now.getFullYear()} is due on the 20th.</p>
          <p>Please complete filing to avoid late fees of Rs 50/day.</p>
          <a href="${process.env.FRONTEND_URL}/gst-portal" style="background:#1B4FD8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px">File Now</a>
          </div>`
        );
        await logAutomation(pool, tenant.id, 'GST_REMINDER', 'sent', `GST reminder sent for ${now.getMonth()+1}/${now.getFullYear()}`);
      }
    }

    // Payroll reminder on last working day (28th) at 9AM IST
    if (day === 28 && utcHour === 3) {
      const tenants = await pool.query(`SELECT id FROM tenants WHERE is_active=true`);
      for (const tenant of tenants.rows) {
        const adminEmail = await getTenantAdminEmail(pool, tenant.id);
        await sendEmail(adminEmail,
          'ðŸ’° Payroll Processing Reminder',
          `<div style="font-family:Arial;padding:20px;background:#EEF3FD;border-left:4px solid #1B4FD8">
          <h2 style="color:#1B4FD8">Payroll Due</h2>
          <p>Monthly payroll for ${now.toLocaleString('en-IN', {month:'long'})} ${now.getFullYear()} should be processed today.</p>
          <a href="${process.env.FRONTEND_URL}/payroll" style="background:#1B4FD8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px">Run Payroll</a>
          </div>`
        );
        await logAutomation(pool, tenant.id, 'PAYROLL_REMINDER', 'sent', `Payroll reminder for ${now.getMonth()+1}/${now.getFullYear()}`);
      }
    }
  }, HOUR); // Check every hour

  console.log('[Automation] âœ“ Cron jobs registered: Cash alerts (15min), Bank recon (hourly), GST/Payroll reminders (daily)');
}


// â”€â”€ Get tenant admin email dynamically â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getTenantAdminEmail(pool: Pool, tenantId: string): Promise<string> {
  try {
    // 1. Check monitor settings recipients first
    const monitor = await pool.query(
      'SELECT recipients FROM monitor_settings WHERE tenant_id=$1 AND enabled=true LIMIT 1',
      [tenantId]
    );
    if (monitor.rows[0]?.recipients?.length > 0) return monitor.rows[0].recipients[0];
    
    // 2. Check tenant admin user email
    const admin = await pool.query(
      "SELECT email FROM users WHERE tenant_id=$1 AND role IN ('admin','owner') ORDER BY created_at ASC LIMIT 1",
      [tenantId]
    );
    if (admin.rows[0]?.email) return admin.rows[0].email;
    
    // 3. Fall back to env var
    return process.env.ADMIN_EMAIL || 'admin@deemona.com';
  } catch {
    return process.env.ADMIN_EMAIL || 'admin@deemona.com';
  }
}

// â”€â”€ Get all tenant notification emails â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getTenantNotificationEmails(pool: Pool, tenantId: string): Promise<string[]> {
  try {
    const monitor = await pool.query(
      'SELECT recipients FROM monitor_settings WHERE tenant_id=$1 LIMIT 1',
      [tenantId]
    );
    if (monitor.rows[0]?.recipients?.length > 0) return monitor.rows[0].recipients;
    const admin = await pool.query(
      "SELECT email FROM users WHERE tenant_id=$1 AND role IN ('admin','owner') ORDER BY created_at ASC LIMIT 3",
      [tenantId]
    );
    if (admin.rows.length > 0) return admin.rows.map((r: any) => r.email);
    return [process.env.ADMIN_EMAIL || 'admin@deemona.com'];
  } catch {
    return [process.env.ADMIN_EMAIL || 'admin@deemona.com'];
  }
}

// â”€â”€ Helper functions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getManagerPhone(pool: Pool, tenantId: string): Promise<string | null> {
  try {
    const result = await pool.query(
      `SELECT phone FROM employees WHERE tenant_id=$1 AND role IN ('manager','admin','owner') AND phone IS NOT NULL LIMIT 1`,
      [tenantId]
    );
    return result.rows[0]?.phone || null;
  } catch { return null; }
}

async function getMonthlyBurn(pool: Pool, tenantId: string): Promise<number> {
  try {
    const result = await pool.query(
      `SELECT COALESCE(SUM(total_amount),0) as burn FROM ap_invoices 
       WHERE tenant_id=$1 AND status IN ('approved','paid') 
       AND created_at > NOW()-INTERVAL '30 days'`,
      [tenantId]
    );
    return parseFloat(result.rows[0]?.burn || 0);
  } catch { return 0; }
}
