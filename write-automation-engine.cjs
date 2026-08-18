const fs = require('fs');

const content = `import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Deemona Finance OS <' + (process.env.FROM_EMAIL || 'onboarding@resend.dev') + '>',
        to: Array.isArray(to) ? to : [to],
        subject, html,
      }),
    });
    const d = await res.json();
    return !!d.id;
  } catch { return false; }
}

async function sendWhatsApp(to, message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
  if (!sid || !token) return false;
  try {
    const toNum = to.startsWith('whatsapp:') ? to : ('whatsapp:+91' + to.replace(/\\D/g, '').slice(-10));
    const body = new URLSearchParams({ From: from, To: toNum, Body: message });
    const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const d = await res.json();
    return !!d.sid;
  } catch { return false; }
}

async function logAutomation(pool, tenantId, type, status, detail) {
  try {
    const isUUID = /^[0-9a-f-]{36}$/i.test(String(tenantId));
    await pool.query(
      'INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at) VALUES ($1, $2, $3, $4, NOW())',
      [isUUID ? tenantId : null, type, status, detail]
    );
  } catch {}
  console.log('[Automation][' + type + '] ' + status + ': ' + detail);
}

async function getTenantAdminEmail(pool, tenantId) {
  try {
    const monitor = await pool.query('SELECT recipients FROM monitor_settings WHERE tenant_id=$1 LIMIT 1', [tenantId]);
    if (monitor.rows[0] && monitor.rows[0].recipients && monitor.rows[0].recipients.length > 0) return monitor.rows[0].recipients[0];
    const admin = await pool.query("SELECT email FROM users WHERE role IN ('admin','owner') ORDER BY created_at ASC LIMIT 1");
    if (admin.rows[0] && admin.rows[0].email) return admin.rows[0].email;
  } catch {}
  return process.env.ADMIN_EMAIL || 'admin@deemona.com';
}

async function getTenantNotificationEmails(pool, tenantId) {
  try {
    const monitor = await pool.query('SELECT recipients FROM monitor_settings WHERE tenant_id=$1 LIMIT 1', [tenantId]);
    if (monitor.rows[0] && monitor.rows[0].recipients && monitor.rows[0].recipients.length > 0) return monitor.rows[0].recipients;
    const admin = await pool.query("SELECT email FROM users WHERE role IN ('admin','owner') ORDER BY created_at ASC LIMIT 3");
    if (admin.rows.length > 0) return admin.rows.map(r => r.email);
  } catch {}
  return [process.env.ADMIN_EMAIL || 'admin@deemona.com'];
}

async function getManagerPhone(pool, tenantId) {
  try {
    const result = await pool.query("SELECT phone FROM employees WHERE phone IS NOT NULL LIMIT 1");
    return result.rows[0] ? result.rows[0].phone : null;
  } catch { return null; }
}

async function getMonthlyBurn(pool, tenantId) {
  try {
    const result = await pool.query('SELECT COALESCE(SUM(total_amount),0) as burn FROM expense_claims WHERE created_at > NOW()-INTERVAL \'30 days\'');
    return parseFloat(result.rows[0] ? result.rows[0].burn : 0);
  } catch { return 0; }
}

export async function handleInvoiceAutoApproval(pool, tenantId, invoiceId) {
  try {
    const inv = await pool.query('SELECT * FROM ap_invoices WHERE id=$1 AND tenant_id=$2', [invoiceId, tenantId]);
    if (!inv.rows.length) return;
    const invoice = inv.rows[0];
    const amount = parseFloat(invoice.total_amount || invoice.balance_due || 0);
    const THRESHOLD = 50000;
    if (amount <= THRESHOLD && invoice.status === 'pending') {
      await pool.query('UPDATE ap_invoices SET status=$1, updated_at=NOW() WHERE id=$2', ['approved', invoiceId]);
      const adminEmail = await getTenantAdminEmail(pool, tenantId);
      await sendEmail(adminEmail, 'Auto-Approved: Invoice ' + invoice.invoice_number,
        '<div style="font-family:Arial;padding:20px"><h2 style="color:#1B4FD8">Invoice Auto-Approved</h2>' +
        '<p>Invoice <strong>' + invoice.invoice_number + '</strong> for <strong>Rs ' + amount.toLocaleString('en-IN') + '</strong> has been automatically approved.</p>' +
        '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS</p></div>');
      await logAutomation(pool, tenantId, 'INVOICE_AUTO_APPROVAL', 'success', 'Auto-approved ' + invoice.invoice_number + ' Rs ' + amount);
    } else if (amount > THRESHOLD) {
      const managerPhone = await getManagerPhone(pool, tenantId);
      if (managerPhone) {
        await sendWhatsApp(managerPhone, 'Deemona Finance - Approval Required\\n\\nInvoice: ' + invoice.invoice_number + '\\nAmount: Rs ' + amount.toLocaleString('en-IN') + '\\n\\nReply APPROVE ' + invoiceId.substring(0,8) + ' or REJECT ' + invoiceId.substring(0,8));
      }
      await logAutomation(pool, tenantId, 'INVOICE_APPROVAL_REQUEST', 'sent', 'Approval requested for ' + invoice.invoice_number);
    }
  } catch (e) { console.error('[Automation] Invoice approval error:', e); }
}

export async function handleWhatsAppApprovalReply(pool, from, body) {
  const upper = body.trim().toUpperCase();
  const approveMatch = upper.match(/^APPROVE\\s+([A-Z0-9]{8})/);
  const rejectMatch = upper.match(/^REJECT\\s+([A-Z0-9]{8})/);
  if (!approveMatch && !rejectMatch) return 'Reply APPROVE [ID] or REJECT [ID] to process an approval.';
  const isApprove = !!approveMatch;
  const partialId = (approveMatch || rejectMatch)[1].toLowerCase();
  try {
    const result = await pool.query("SELECT * FROM ap_invoices WHERE id::text LIKE $1 AND status='pending' LIMIT 1", [partialId + '%']);
    if (!result.rows.length) return 'Invoice not found or already processed.';
    const invoice = result.rows[0];
    const newStatus = isApprove ? 'approved' : 'rejected';
    await pool.query('UPDATE ap_invoices SET status=$1, updated_at=NOW() WHERE id=$2', [newStatus, invoice.id]);
    const amount = parseFloat(invoice.total_amount || 0);
    return 'Invoice ' + invoice.invoice_number + ' has been ' + newStatus.toUpperCase() + '. Amount: Rs ' + amount.toLocaleString('en-IN');
  } catch { return 'Error processing approval. Please try again.'; }
}

export async function handleExpenseAutoApproval(pool, tenantId, expenseId) {
  try {
    const result = await pool.query('SELECT * FROM expense_claims WHERE id=$1 AND tenant_id=$2', [expenseId, tenantId]);
    if (!result.rows.length) return;
    const expense = result.rows[0];
    const amount = parseFloat(expense.total_amount || 0);
    if (amount <= 15000 && expense.status === 'submitted') {
      await pool.query('UPDATE expense_claims SET status=$1, updated_at=NOW() WHERE id=$2', ['approved', expenseId]);
      const adminEmail = await getTenantAdminEmail(pool, tenantId);
      await sendEmail(adminEmail, 'Expense Auto-Approved',
        '<div style="font-family:Arial;padding:20px"><h2 style="color:#059669">Expense Approved</h2>' +
        '<p>Expense claim for Rs ' + amount.toLocaleString('en-IN') + ' auto-approved.</p>' +
        '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS</p></div>');
      await logAutomation(pool, tenantId, 'EXPENSE_AUTO_APPROVAL', 'success', 'Auto-approved expense Rs ' + amount);
    }
  } catch (e) { console.error('[Automation] Expense error:', e); }
}

export async function checkLowCashAlert(pool, tenantId) {
  try {
    const alertCheck = await pool.query("SELECT id FROM automation_logs WHERE automation_type='LOW_CASH_ALERT' AND created_at > NOW()-INTERVAL '24 hours' LIMIT 1");
    if (alertCheck.rows.length > 0) return;
    const burn = await getMonthlyBurn(pool, tenantId);
    const recipients = await getTenantNotificationEmails(pool, tenantId);
    const runway = burn > 0 ? (5000000 / burn).toFixed(1) : 'N/A';
    await sendEmail(recipients, 'Cash Flow Alert - Deemona Finance',
      '<div style="font-family:Arial;padding:20px;background:#FEF2F2;border-left:4px solid #DC2626">' +
      '<h2 style="color:#DC2626">Cash Flow Alert</h2>' +
      '<p>Monthly burn rate: <strong>Rs ' + burn.toLocaleString('en-IN') + '</strong></p>' +
      '<p>Estimated runway: <strong>' + runway + ' months</strong></p>' +
      '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS</p></div>');
    await logAutomation(pool, tenantId, 'LOW_CASH_ALERT', 'sent', 'Cash alert sent | Burn: Rs ' + burn);
  } catch (e) { console.error('[Automation] Low cash error:', e); }
}

export async function checkComplianceAlerts(pool, tenantId) {
  try {
    const result = await pool.query(
      "SELECT * FROM compliance_items WHERE status NOT IN ('Completed','Closed') AND due_date BETWEEN NOW() AND NOW() + INTERVAL '7 days' LIMIT 10"
    );
    if (!result.rows.length) return;
    const adminEmail = await getTenantAdminEmail(pool, tenantId);
    for (const item of result.rows) {
      const daysLeft = Math.ceil((new Date(item.due_date).getTime() - Date.now()) / 86400000);
      await sendEmail(adminEmail, 'Compliance Due in ' + daysLeft + ' days: ' + item.title,
        '<div style="font-family:Arial;padding:20px;background:#FFFBEB;border-left:4px solid #D97706">' +
        '<h2 style="color:#D97706">' + item.title + '</h2>' +
        '<p>Due in <strong>' + daysLeft + ' days</strong></p>' +
        '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS</p></div>');
      await logAutomation(pool, tenantId, 'COMPLIANCE_ALERT', 'sent', 'Compliance alert: ' + item.title + ' due in ' + daysLeft + ' days');
    }
  } catch (e) { console.error('[Automation] Compliance error:', e); }
}

export async function handleNewLeadNurture(pool, tenantId, leadId) {
  try {
    const result = await pool.query('SELECT * FROM crm_leads WHERE id=$1 AND tenant_id=$2', [leadId, tenantId]);
    if (!result.rows.length) return;
    const lead = result.rows[0];
    const adminEmail = await getTenantAdminEmail(pool, tenantId);
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 400,
      messages: [{ role: 'user', content: 'Write a 2-paragraph professional welcome email for a new sales lead named ' + (lead.contact_name || lead.name) + '. Be warm and professional.' }]
    });
    const emailBody = aiResponse.content[0].text || 'Thank you for your interest.';
    await sendEmail(lead.contact_email || adminEmail, 'Thank you for your interest',
      '<div style="font-family:Arial;padding:20px"><h2 style="color:#1B4FD8">Welcome!</h2>' +
      emailBody.split('\\n').map(p => p ? '<p>' + p + '</p>' : '').join('') +
      '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS</p></div>');
    await logAutomation(pool, tenantId, 'LEAD_NURTURE_EMAIL', 'sent', 'Lead nurture for ' + (lead.contact_name || lead.name));
  } catch (e) { console.error('[Automation] Lead nurture error:', e); }
}

export async function runBankReconciliation(pool, tenantId) {
  await logAutomation(pool, tenantId, 'BANK_RECONCILIATION', 'skipped', 'Bank transactions table not yet configured').catch(() => {});
  return { matched: 0, unmatched: 0 };
}

export async function checkVendorPaymentSchedule(pool, tenantId) {
  try {
    const result = await pool.query(
      'SELECT po.*, v.name as vendor_name FROM purchase_orders po LEFT JOIN vendors v ON po.vendor_id=v.id WHERE po.status IN (\'approved\',\'Approved\') AND po.expected_date BETWEEN NOW() AND NOW()+INTERVAL \'3 days\' LIMIT 10'
    );
    if (!result.rows.length) return;
    const adminEmail = await getTenantAdminEmail(pool, tenantId);
    for (const po of result.rows) {
      const amount = parseFloat(po.total_amount || 0);
      const daysLeft = Math.ceil((new Date(po.expected_date).getTime() - Date.now()) / 86400000);
      await sendEmail(adminEmail, 'PO Payment Due in ' + daysLeft + ' days: ' + po.po_number,
        '<div style="font-family:Arial;padding:20px;background:#FFFBEB;border-left:4px solid #D97706">' +
        '<h2 style="color:#D97706">Vendor Payment Due</h2>' +
        '<p>PO ' + po.po_number + ' from ' + (po.vendor_name || 'Vendor') + ' due in ' + daysLeft + ' days.</p>' +
        '<p>Amount: Rs ' + amount.toLocaleString('en-IN') + '</p>' +
        '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS</p></div>');
      await logAutomation(pool, tenantId, 'PAYMENT_SCHEDULED', 'notified', 'PO ' + po.po_number + ' due in ' + daysLeft + ' days');
    }
  } catch (e) { console.error('[Automation] Vendor payment error:', e); }
}

async function ensureAutomationLogs(pool) {
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS automation_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID, automation_type VARCHAR(100), status VARCHAR(50), detail TEXT, created_at TIMESTAMPTZ DEFAULT NOW())');
    await pool.query('ALTER TABLE automation_logs ADD COLUMN IF NOT EXISTS automation_type VARCHAR(100)').catch(()=>{});
    await pool.query('ALTER TABLE automation_logs ADD COLUMN IF NOT EXISTS status VARCHAR(50)').catch(()=>{});
    await pool.query('ALTER TABLE automation_logs ADD COLUMN IF NOT EXISTS detail TEXT').catch(()=>{});
    console.log('[Automation] automation_logs table ready');
  } catch(e) { console.error('[Automation] Migration error:', e); }
}

export async function registerAutomationCrons(pool) {
  await ensureAutomationLogs(pool);
  console.log('[Automation] Registering automation cron jobs...');
  const MINUTE = 60000;
  const HOUR = 3600000;

  setInterval(async () => {
    try {
      const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
      for (const tenant of tenants.rows) {
        await checkLowCashAlert(pool, tenant.id).catch(() => {});
        await checkComplianceAlerts(pool, tenant.id).catch(() => {});
        await checkVendorPaymentSchedule(pool, tenant.id).catch(() => {});
      }
    } catch (e) { console.error('[Automation Cron]', e); }
  }, 15 * MINUTE);

  setInterval(async () => {
    try {
      const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
      for (const tenant of tenants.rows) {
        await runBankReconciliation(pool, tenant.id).catch(() => {});
      }
    } catch (e) { console.error('[Automation Cron] Hourly:', e); }
  }, HOUR);

  setInterval(async () => {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const day = now.getUTCDate();
    try {
      const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
      for (const tenant of tenants.rows) {
        const adminEmail = await getTenantAdminEmail(pool, tenant.id);
        if (day === 13 && utcHour === 3) {
          await sendEmail(adminEmail, 'GST Filing Due in 5 Days',
            '<div style="font-family:Arial;padding:20px;background:#FEF2F2;border-left:4px solid #DC2626">' +
            '<h2 style="color:#DC2626">GSTR-3B Due in 5 Days</h2>' +
            '<p>File by the 20th to avoid late fees.</p>' +
            '<a href="' + process.env.FRONTEND_URL + '/gst-portal" style="background:#1B4FD8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">File Now</a>' +
            '</div>');
          await logAutomation(pool, tenant.id, 'GST_REMINDER', 'sent', 'GST reminder sent');
        }
        if (day === 28 && utcHour === 3) {
          await sendEmail(adminEmail, 'Payroll Processing Reminder',
            '<div style="font-family:Arial;padding:20px;background:#EEF3FD;border-left:4px solid #1B4FD8">' +
            '<h2 style="color:#1B4FD8">Run Payroll Today</h2>' +
            '<a href="' + process.env.FRONTEND_URL + '/payroll" style="background:#1B4FD8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Go to Payroll</a>' +
            '</div>');
          await logAutomation(pool, tenant.id, 'PAYROLL_REMINDER', 'sent', 'Payroll reminder sent');
        }
      }
    } catch (e) { console.error('[Automation Cron] Daily:', e); }
  }, HOUR);

  console.log('[Automation] Cron jobs registered: Cash alerts (15min), Bank recon (hourly), GST/Payroll (daily)');
}
`;

fs.writeFileSync(
  'C:/deemona-finance-os/backend/src/services/automationEngine.ts',
  content,
  { encoding: 'utf8', flag: 'w' }
);
console.log('Written successfully. Size:', content.length);
