import { Pool } from 'pg';
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
    return !!(d as any).id;
  } catch { return false; }
}

async function sendWhatsApp(to, message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
  if (!sid || !token) return false;
  try {
    const toNum = to.startsWith('whatsapp:') ? to : ('whatsapp:+91' + to.replace(/\D/g, '').slice(-10));
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
    return !!(d as any).sid;
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
    const result = await pool.query(`SELECT COALESCE(SUM(total_amount),0) as burn FROM expense_claims WHERE created_at > NOW()-INTERVAL '30 days'`);
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
        await sendWhatsApp(managerPhone, 'Deemona Finance - Approval Required\n\nInvoice: ' + invoice.invoice_number + '\nAmount: Rs ' + amount.toLocaleString('en-IN') + '\n\nReply APPROVE ' + invoiceId.substring(0,8) + ' or REJECT ' + invoiceId.substring(0,8));
      }
      await logAutomation(pool, tenantId, 'INVOICE_APPROVAL_REQUEST', 'sent', 'Approval requested for ' + invoice.invoice_number);
    }
  } catch (e) { console.error('[Automation] Invoice approval error:', e); }
}

export async function handleWhatsAppApprovalReply(pool, from, body) {
  const upper = body.trim().toUpperCase();
  const approveMatch = upper.match(/^APPROVE\s+([A-Z0-9]{8})/);
  const rejectMatch = upper.match(/^REJECT\s+([A-Z0-9]{8})/);
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
    const emailBody = (aiResponse.content[0] as any).text || 'Thank you for your interest.';
    await sendEmail(lead.contact_email || adminEmail, 'Thank you for your interest',
      '<div style="font-family:Arial;padding:20px"><h2 style="color:#1B4FD8">Welcome!</h2>' +
      emailBody.split('\n').map(p => p ? '<p>' + p + '</p>' : '').join('') +
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
      "SELECT po.*, v.name as vendor_name FROM purchase_orders po LEFT JOIN vendors v ON po.vendor_id=v.id WHERE po.status IN ('approved','Approved') AND po.expected_date BETWEEN NOW() AND NOW()+INTERVAL '3 days' LIMIT 10"
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

// ============================================================

// ── BATCH 1: Daily Morning Brief (8AM IST = 2:30 UTC) ────────
async function sendDailyMorningBrief(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    // Gather KPIs
    const [overdue, pending, cashResult, expenseResult] = await Promise.all([
      pool.query("SELECT COUNT(*) as cnt, COALESCE(SUM(balance_due),0) as amt FROM ar_invoices WHERE tenant_id=$1 AND status='overdue'", [tenantId]).catch(() => ({ rows: [{ cnt: 0, amt: 0 }] })),
      pool.query("SELECT COUNT(*) as cnt FROM ap_invoices WHERE tenant_id=$1 AND status='pending'", [tenantId]).catch(() => ({ rows: [{ cnt: 0 }] })),
      pool.query("SELECT COALESCE(SUM(current_balance),0) as cash FROM bank_accounts WHERE tenant_id=$1", [tenantId]).catch(() => ({ rows: [{ cash: 0 }] })),
      pool.query("SELECT COALESCE(SUM(total_amount),0) as amt FROM expense_claims WHERE tenant_id=$1 AND status='submitted'", [tenantId]).catch(() => ({ rows: [{ amt: 0 }] })),
    ]);

    const overdueCount = parseInt(overdue.rows[0].cnt);
    const overdueAmt = parseFloat(overdue.rows[0].amt);
    const pendingApprovals = parseInt(pending.rows[0].cnt);
    const cash = parseFloat(cashResult.rows[0].cash);
    const pendingExpenses = parseFloat(expenseResult.rows[0].amt);

    // Get compliance alerts due today
    const compliance = await pool.query(
      "SELECT title, due_date FROM compliance_items WHERE status NOT IN ('Completed','Closed') AND due_date <= NOW()+INTERVAL '7 days' ORDER BY due_date ASC LIMIT 5"
    ).catch(() => ({ rows: [] }));

    const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const html = '<div style="font-family:Arial;padding:24px;background:#EEF3FD;max-width:700px">' +
      '<div style="background:linear-gradient(135deg,#1B4FD8,#3B82F6);padding:24px;border-radius:12px;color:#fff;margin-bottom:20px">' +
      '<h1 style="margin:0;font-size:20px">Good Morning! Daily Finance Brief</h1>' +
      '<p style="margin:6px 0 0;opacity:.8;font-size:13px">' + today + ' | Deemona AI Finance OS</p></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px">' +
      '<div style="background:#fff;padding:16px;border-radius:10px;border:1px solid #C7D9F8">' +
      '<div style="font-size:11px;color:#64748B;font-weight:600">CASH POSITION</div>' +
      '<div style="font-size:22px;font-weight:800;color:#1B4FD8">Rs ' + cash.toLocaleString('en-IN') + '</div></div>' +
      '<div style="background:#fff;padding:16px;border-radius:10px;border:1px solid #C7D9F8">' +
      '<div style="font-size:11px;color:#64748B;font-weight:600">OVERDUE AR</div>' +
      '<div style="font-size:22px;font-weight:800;color:#DC2626">' + overdueCount + ' invoices | Rs ' + overdueAmt.toLocaleString('en-IN') + '</div></div>' +
      '<div style="background:#fff;padding:16px;border-radius:10px;border:1px solid #C7D9F8">' +
      '<div style="font-size:11px;color:#64748B;font-weight:600">PENDING APPROVALS</div>' +
      '<div style="font-size:22px;font-weight:800;color:#D97706">' + pendingApprovals + ' invoices</div></div>' +
      '<div style="background:#fff;padding:16px;border-radius:10px;border:1px solid #C7D9F8">' +
      '<div style="font-size:11px;color:#64748B;font-weight:600">PENDING EXPENSES</div>' +
      '<div style="font-size:22px;font-weight:800;color:#7C3AED">Rs ' + pendingExpenses.toLocaleString('en-IN') + '</div></div></div>' +
      (compliance.rows.length > 0 ? '<div style="background:#FFFBEB;padding:16px;border-radius:10px;border:1px solid #FDE68A;margin-bottom:20px">' +
      '<div style="font-size:13px;font-weight:700;color:#D97706;margin-bottom:10px">Upcoming Compliance Deadlines</div>' +
      compliance.rows.map(c => '<div style="font-size:12px;color:#92400E;padding:4px 0">' + c.title + ' — Due: ' + new Date(c.due_date).toLocaleDateString('en-IN') + '</div>').join('') +
      '</div>' : '') +
      '<div style="text-align:center">' +
      '<a href="' + process.env.FRONTEND_URL + '/dashboard" style="background:#1B4FD8;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Open Finance Dashboard</a></div>' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center;margin-top:16px">Deemona AI Finance OS | Daily Morning Brief | Automated Report</p></div>';

    await sendEmail(adminEmail, 'Good Morning! Daily Finance Brief — ' + today, html);
    await logAutomation(pool, tenantId, 'DAILY_MORNING_BRIEF', 'sent', 'Morning brief sent for ' + today);
  } catch (e) { console.error('[Automation] Morning brief error:', e); }
}

// ── BATCH 1: Weekly Finance Digest (Monday 9AM IST) ──────────
async function sendWeeklyDigest(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    const [revenue, expenses, topExpenses, topVendors] = await Promise.all([
      pool.query("SELECT COALESCE(SUM(total_amount),0) as amt FROM ar_invoices WHERE tenant_id=$1 AND created_at > NOW()-INTERVAL '7 days'", [tenantId]).catch(() => ({ rows: [{ amt: 0 }] })),
      pool.query("SELECT COALESCE(SUM(total_amount),0) as amt FROM expense_claims WHERE tenant_id=$1 AND created_at > NOW()-INTERVAL '7 days'", [tenantId]).catch(() => ({ rows: [{ amt: 0 }] })),
      pool.query("SELECT category, SUM(total_amount) as amt FROM expense_claims WHERE tenant_id=$1 AND created_at > NOW()-INTERVAL '7 days' GROUP BY category ORDER BY amt DESC LIMIT 5", [tenantId]).catch(() => ({ rows: [] })),
      pool.query("SELECT v.name, SUM(ap.total_amount) as amt FROM ap_invoices ap JOIN vendors v ON ap.vendor_id=v.id WHERE ap.tenant_id=$1 AND ap.created_at > NOW()-INTERVAL '7 days' GROUP BY v.name ORDER BY amt DESC LIMIT 5", [tenantId]).catch(() => ({ rows: [] })),
    ]);

    const weekRevenue = parseFloat(revenue.rows[0].amt);
    const weekExpenses = parseFloat(expenses.rows[0].amt);
    const weekProfit = weekRevenue - weekExpenses;
    const weekStart = new Date(Date.now() - 7 * 86400000).toLocaleDateString('en-IN');
    const weekEnd = new Date().toLocaleDateString('en-IN');

    const html = '<div style="font-family:Arial;padding:24px;max-width:700px">' +
      '<div style="background:linear-gradient(135deg,#7C3AED,#A78BFA);padding:24px;border-radius:12px;color:#fff;margin-bottom:20px">' +
      '<h1 style="margin:0;font-size:20px">Weekly Finance Digest</h1>' +
      '<p style="margin:6px 0 0;opacity:.8">' + weekStart + ' to ' + weekEnd + '</p></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px">' +
      '<div style="background:#ECFDF5;padding:14px;border-radius:10px;border:1px solid #A7F3D0"><div style="font-size:10px;color:#059669;font-weight:700">WEEK REVENUE</div><div style="font-size:20px;font-weight:800;color:#059669">Rs ' + weekRevenue.toLocaleString('en-IN') + '</div></div>' +
      '<div style="background:#FEF2F2;padding:14px;border-radius:10px;border:1px solid #FECACA"><div style="font-size:10px;color:#DC2626;font-weight:700">WEEK EXPENSES</div><div style="font-size:20px;font-weight:800;color:#DC2626">Rs ' + weekExpenses.toLocaleString('en-IN') + '</div></div>' +
      '<div style="background:' + (weekProfit >= 0 ? '#ECFDF5' : '#FEF2F2') + ';padding:14px;border-radius:10px"><div style="font-size:10px;font-weight:700">NET PROFIT</div><div style="font-size:20px;font-weight:800;color:' + (weekProfit >= 0 ? '#059669' : '#DC2626') + '">Rs ' + weekProfit.toLocaleString('en-IN') + '</div></div></div>' +
      (topExpenses.rows.length > 0 ? '<div style="background:#fff;padding:16px;border-radius:10px;border:1px solid #C7D9F8;margin-bottom:14px"><div style="font-size:13px;font-weight:700;color:#0A1628;margin-bottom:10px">Top Expense Categories</div>' +
      topExpenses.rows.map((e, i) => '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #F8FAFC"><span style="font-size:12px;color:#334155">' + (i+1) + '. ' + (e.category || 'Other') + '</span><span style="font-size:12px;font-weight:600;color:#DC2626">Rs ' + parseFloat(e.amt).toLocaleString('en-IN') + '</span></div>').join('') + '</div>' : '') +
      '<p style="color:#94A3B8;font-size:11px;text-align:center">Deemona AI Finance OS | Weekly Digest | Automated</p></div>';

    await sendEmail(adminEmail, 'Weekly Finance Digest — ' + weekStart + ' to ' + weekEnd, html);
    await logAutomation(pool, tenantId, 'WEEKLY_DIGEST', 'sent', 'Weekly digest sent');
  } catch (e) { console.error('[Automation] Weekly digest error:', e); }
}

// ── BATCH 1: Invoice Payment Reminders ───────────────────────
async function sendInvoicePaymentReminders(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    // Get overdue AR invoices
    const overdue = await pool.query(
      "SELECT ar.*, c.name as customer_name, c.email as customer_email FROM ar_invoices ar LEFT JOIN customers c ON ar.customer_id=c.id WHERE ar.tenant_id=$1 AND ar.status IN ('sent','overdue') AND ar.due_date < CURRENT_DATE ORDER BY ar.due_date ASC LIMIT 20",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    for (const inv of overdue.rows) {
      const daysOverdue = Math.ceil((Date.now() - new Date(inv.due_date).getTime()) / 86400000);
      const amount = parseFloat(inv.total_amount || inv.balance_due || 0);
      const customerEmail = inv.customer_email;

      // Check if reminder already sent today
      const alreadySent = await pool.query(
        "SELECT id FROM automation_logs WHERE automation_type='PAYMENT_REMINDER' AND detail LIKE $1 AND created_at > NOW()-INTERVAL '24 hours'",
        ['%' + inv.id + '%']
      ).catch(() => ({ rows: [] }));
      if (alreadySent.rows.length > 0) continue;

      if (customerEmail) {
        const isEscalation = daysOverdue >= 90;
        const subject = isEscalation
          ? 'URGENT: Invoice ' + inv.invoice_number + ' overdue by ' + daysOverdue + ' days'
          : 'Payment Reminder: Invoice ' + inv.invoice_number + ' due ' + daysOverdue + ' days ago';

        await sendEmail(customerEmail, subject,
          '<div style="font-family:Arial;padding:20px;background:' + (isEscalation ? '#FEF2F2' : '#FFFBEB') + ';border-left:4px solid ' + (isEscalation ? '#DC2626' : '#D97706') + '">' +
          '<h2 style="color:' + (isEscalation ? '#DC2626' : '#D97706') + '">' + (isEscalation ? 'URGENT: ' : '') + 'Payment Reminder</h2>' +
          '<p>Dear ' + (inv.customer_name || 'Customer') + ',</p>' +
          '<p>This is a reminder that Invoice <strong>' + inv.invoice_number + '</strong> for <strong>Rs ' + amount.toLocaleString('en-IN') + '</strong> was due on ' + new Date(inv.due_date).toLocaleDateString('en-IN') + ' (' + daysOverdue + ' days ago).</p>' +
          (isEscalation ? '<p style="color:#DC2626;font-weight:bold">This invoice is significantly overdue. Please make payment immediately to avoid further action.</p>' : '') +
          '<p>Please process payment at your earliest convenience.</p>' +
          '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Automated Reminder</p></div>'
        );
      }

      // Also alert CFO if 90+ days
      if (daysOverdue >= 90) {
        await sendEmail(adminEmail, 'ESCALATION: Invoice ' + inv.invoice_number + ' overdue ' + daysOverdue + ' days',
          '<div style="font-family:Arial;padding:20px;background:#FEF2F2;border-left:4px solid #DC2626">' +
          '<h2 style="color:#DC2626">Invoice Escalation Alert</h2>' +
          '<p>Invoice <strong>' + inv.invoice_number + '</strong> from <strong>' + (inv.customer_name || 'Customer') + '</strong> is <strong>' + daysOverdue + ' days overdue</strong>.</p>' +
          '<p>Amount: <strong>Rs ' + amount.toLocaleString('en-IN') + '</strong></p>' +
          '<p>Immediate follow-up required.</p></div>'
        );
      }

      await logAutomation(pool, tenantId, 'PAYMENT_REMINDER', 'sent', 'Reminder for invoice ' + inv.invoice_number + ' | ' + inv.id);
    }
  } catch (e) { console.error('[Automation] Payment reminders error:', e); }
}

// ── BATCH 1: Payslip Auto-Distribution ───────────────────────
async function distributePayslips(pool, tenantId) {
  try {
    // Get latest payroll run
    const payrollRun = await pool.query(
      "SELECT * FROM payroll_runs WHERE tenant_id=$1 AND status='completed' AND created_at > NOW()-INTERVAL '48 hours' ORDER BY created_at DESC LIMIT 1",
      [tenantId]
    ).catch(() => ({ rows: [] }));
    if (!payrollRun.rows.length) return;

    const run = payrollRun.rows[0];

    // Get payslips for this run
    const payslips = await pool.query(
      "SELECT ps.*, e.first_name, e.last_name, e.email, e.phone FROM payslips ps JOIN employees e ON ps.employee_id=e.id WHERE ps.payroll_run_id=$1",
      [run.id]
    ).catch(() => ({ rows: [] }));

    for (const slip of payslips.rows) {
      if (!slip.email) continue;

      const netPay = parseFloat(slip.net_pay || 0);
      await sendEmail(slip.email,
        'Your Salary Slip — ' + new Date(run.month || run.created_at).toLocaleString('en-IN', { month: 'long', year: 'numeric' }),
        '<div style="font-family:Arial;padding:24px;max-width:600px">' +
        '<div style="background:linear-gradient(135deg,#1B4FD8,#3B82F6);padding:20px;border-radius:10px;color:#fff;margin-bottom:20px">' +
        '<h2 style="margin:0">Salary Slip</h2>' +
        '<p style="margin:4px 0 0;opacity:.8">' + (slip.first_name || '') + ' ' + (slip.last_name || '') + '</p></div>' +
        '<div style="background:#ECFDF5;padding:16px;border-radius:10px;border:1px solid #A7F3D0;text-align:center;margin-bottom:16px">' +
        '<div style="font-size:12px;color:#059669;font-weight:600">NET PAY CREDITED</div>' +
        '<div style="font-size:28px;font-weight:800;color:#059669">Rs ' + netPay.toLocaleString('en-IN') + '</div></div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<tr style="background:#F0F5FF"><td style="padding:8px;font-weight:700">Gross Pay</td><td style="padding:8px;text-align:right">Rs ' + parseFloat(slip.gross_pay || 0).toLocaleString('en-IN') + '</td></tr>' +
        '<tr><td style="padding:8px">PF Deduction</td><td style="padding:8px;text-align:right">- Rs ' + parseFloat(slip.pf_employee || 0).toLocaleString('en-IN') + '</td></tr>' +
        '<tr style="background:#F0F5FF"><td style="padding:8px">TDS</td><td style="padding:8px;text-align:right">- Rs ' + parseFloat(slip.tds || 0).toLocaleString('en-IN') + '</td></tr>' +
        '<tr style="font-weight:700"><td style="padding:8px">Net Pay</td><td style="padding:8px;text-align:right;color:#059669">Rs ' + netPay.toLocaleString('en-IN') + '</td></tr>' +
        '</table>' +
        '<p style="color:#64748B;font-size:11px;margin-top:16px;text-align:center">Deemona AI Finance OS | Automated Payslip</p></div>'
      );

      // WhatsApp notification
      if (slip.phone) {
        await sendWhatsApp(slip.phone, 'Hi ' + (slip.first_name || '') + ', your salary of Rs ' + netPay.toLocaleString('en-IN') + ' has been processed. Check your email for the payslip. - Deemona Finance');
      }

      await logAutomation(pool, tenantId, 'PAYSLIP_DISTRIBUTED', 'sent', 'Payslip sent to ' + slip.email);
    }
  } catch (e) { console.error('[Automation] Payslip distribution error:', e); }
}

// ── BATCH 1: Fraud Detection ──────────────────────────────────
async function runFraudDetection(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);
    const alerts = [];

    // Check 1: Duplicate invoices (same vendor + same amount within 30 days)
    const duplicates = await pool.query(
      "SELECT vendor_id, total_amount, COUNT(*) as cnt FROM ap_invoices WHERE tenant_id=$1 AND created_at > NOW()-INTERVAL '30 days' GROUP BY vendor_id, total_amount HAVING COUNT(*) > 1",
      [tenantId]
    ).catch(() => ({ rows: [] }));
    if (duplicates.rows.length > 0) {
      alerts.push('DUPLICATE INVOICES: ' + duplicates.rows.length + ' vendor-amount combinations with multiple invoices');
    }

    // Check 2: Round number transactions (suspicious)
    const roundNumbers = await pool.query(
      "SELECT COUNT(*) as cnt FROM ap_invoices WHERE tenant_id=$1 AND total_amount % 10000 = 0 AND total_amount > 50000 AND created_at > NOW()-INTERVAL '7 days'",
      [tenantId]
    ).catch(() => ({ rows: [{ cnt: 0 }] }));
    if (parseInt(roundNumbers.rows[0].cnt) > 2) {
      alerts.push('ROUND NUMBER ALERT: ' + roundNumbers.rows[0].cnt + ' large round-number invoices this week');
    }

    // Check 3: Weekend/off-hours entries
    const offHours = await pool.query(
      "SELECT COUNT(*) as cnt FROM ap_invoices WHERE tenant_id=$1 AND EXTRACT(DOW FROM created_at) IN (0,6) AND created_at > NOW()-INTERVAL '7 days'",
      [tenantId]
    ).catch(() => ({ rows: [{ cnt: 0 }] }));
    if (parseInt(offHours.rows[0].cnt) > 0) {
      alerts.push('WEEKEND ENTRIES: ' + offHours.rows[0].cnt + ' invoices created on weekends');
    }

    if (alerts.length > 0) {
      await sendEmail(adminEmail, 'FRAUD ALERT: ' + alerts.length + ' suspicious patterns detected',
        '<div style="font-family:Arial;padding:20px;background:#FEF2F2;border-left:4px solid #DC2626">' +
        '<h2 style="color:#DC2626">Fraud Detection Alert</h2>' +
        '<p>The following suspicious patterns have been detected:</p>' +
        alerts.map(a => '<div style="padding:8px;background:#fff;border-radius:6px;margin:6px 0;font-size:13px;border-left:3px solid #DC2626">' + a + '</div>').join('') +
        '<p style="margin-top:16px"><a href="' + process.env.FRONTEND_URL + '/accounting" style="background:#DC2626;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Review Invoices</a></p>' +
        '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Fraud Detection</p></div>'
      );
      await logAutomation(pool, tenantId, 'FRAUD_DETECTION', 'alert', alerts.join(' | '));
    }
  } catch (e) { console.error('[Automation] Fraud detection error:', e); }
}

// ── BATCH 1: Vendor GSTIN Compliance Check ───────────────────
async function checkVendorGSTINCompliance(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    // Get vendors with GSTIN
    const vendors = await pool.query(
      "SELECT id, name, gstin FROM vendors WHERE tenant_id=$1 AND gstin IS NOT NULL AND gstin != ''",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    const invalid = [];
    for (const vendor of vendors.rows) {
      // Basic GSTIN format validation: 15 chars, starts with 2 digits
      const gstin = vendor.gstin.trim().toUpperCase();
      const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
      if (!gstinRegex.test(gstin)) {
        invalid.push({ name: vendor.name, gstin: vendor.gstin });
      }
    }

    if (invalid.length > 0) {
      await sendEmail(adminEmail, 'GSTIN Compliance Alert: ' + invalid.length + ' vendors with invalid GSTIN',
        '<div style="font-family:Arial;padding:20px;background:#FFFBEB;border-left:4px solid #D97706">' +
        '<h2 style="color:#D97706">GSTIN Compliance Alert</h2>' +
        '<p>The following vendors have invalid or non-compliant GSTIN numbers:</p>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:12px">' +
        '<tr style="background:#F0F5FF"><th style="padding:8px;text-align:left">Vendor</th><th style="padding:8px;text-align:left">GSTIN</th><th style="padding:8px">Status</th></tr>' +
        invalid.map(v => '<tr><td style="padding:8px">' + v.name + '</td><td style="padding:8px;font-family:monospace">' + v.gstin + '</td><td style="padding:8px;color:#DC2626;text-align:center">Invalid Format</td></tr>').join('') +
        '</table>' +
        '<p style="color:#64748B;font-size:12px;margin-top:16px">Deemona AI Finance OS | GSTIN Compliance Monitor</p></div>'
      );
      await logAutomation(pool, tenantId, 'GSTIN_COMPLIANCE', 'alert', invalid.length + ' vendors with invalid GSTIN');
    } else {
      await logAutomation(pool, tenantId, 'GSTIN_COMPLIANCE', 'passed', 'All ' + vendors.rows.length + ' vendor GSTINs valid');
    }
  } catch (e) { console.error('[Automation] GSTIN check error:', e); }
}

// ── BATCH 1: Cash Flow Prediction ────────────────────────────
async function predictCashFlow(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    // Get current cash
    const cashResult = await pool.query(
      "SELECT COALESCE(SUM(current_balance),0) as cash FROM bank_accounts WHERE tenant_id=$1",
      [tenantId]
    ).catch(() => ({ rows: [{ cash: 0 }] }));
    const currentCash = parseFloat(cashResult.rows[0].cash);

    // Get expected inflows (AR due in 30 days)
    const inflows = await pool.query(
      "SELECT COALESCE(SUM(balance_due),0) as amt FROM ar_invoices WHERE tenant_id=$1 AND status IN ('sent','overdue') AND due_date <= NOW()+INTERVAL '30 days'",
      [tenantId]
    ).catch(() => ({ rows: [{ amt: 0 }] }));

    // Get expected outflows (AP due in 30 days)
    const outflows = await pool.query(
      "SELECT COALESCE(SUM(balance_due),0) as amt FROM ap_invoices WHERE tenant_id=$1 AND status='approved' AND due_date <= NOW()+INTERVAL '30 days'",
      [tenantId]
    ).catch(() => ({ rows: [{ amt: 0 }] }));

    // Monthly burn rate
    const burnRate = await getMonthlyBurn(pool, tenantId);

    const expectedInflows = parseFloat(inflows.rows[0].amt);
    const expectedOutflows = parseFloat(outflows.rows[0].amt);
    const projected30 = currentCash + expectedInflows - expectedOutflows - burnRate;
    const projected60 = projected30 - burnRate;
    const projected90 = projected60 - burnRate;

    const ALERT_THRESHOLD = 2000000; // Rs 20L
    const needsAlert = projected30 < ALERT_THRESHOLD || projected60 < 0;

    if (needsAlert) {
      await sendEmail(adminEmail, 'Cash Flow Prediction Alert — Potential Shortfall',
        '<div style="font-family:Arial;padding:20px;background:#FEF2F2;border-left:4px solid #DC2626">' +
        '<h2 style="color:#DC2626">Cash Flow Prediction Alert</h2>' +
        '<p>Based on current receivables, payables and burn rate, a cash shortfall is predicted:</p>' +
        '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">' +
        '<tr><td style="padding:8px;color:#64748B">Current Cash</td><td style="padding:8px;font-weight:700;text-align:right">Rs ' + currentCash.toLocaleString('en-IN') + '</td></tr>' +
        '<tr style="background:#F8FAFC"><td style="padding:8px;color:#64748B">Expected Inflows (30d)</td><td style="padding:8px;color:#059669;font-weight:600;text-align:right">+ Rs ' + expectedInflows.toLocaleString('en-IN') + '</td></tr>' +
        '<tr><td style="padding:8px;color:#64748B">Expected Outflows (30d)</td><td style="padding:8px;color:#DC2626;font-weight:600;text-align:right">- Rs ' + expectedOutflows.toLocaleString('en-IN') + '</td></tr>' +
        '<tr><td style="padding:8px;color:#64748B">Monthly Burn</td><td style="padding:8px;color:#DC2626;text-align:right">- Rs ' + burnRate.toLocaleString('en-IN') + '</td></tr>' +
        '<tr style="background:#EEF3FD"><td style="padding:8px;font-weight:700">Projected 30-day Cash</td><td style="padding:8px;font-weight:800;color:' + (projected30 > 0 ? '#059669' : '#DC2626') + ';text-align:right">Rs ' + projected30.toLocaleString('en-IN') + '</td></tr>' +
        '<tr><td style="padding:8px;font-weight:700">Projected 60-day Cash</td><td style="padding:8px;font-weight:800;color:' + (projected60 > 0 ? '#059669' : '#DC2626') + ';text-align:right">Rs ' + projected60.toLocaleString('en-IN') + '</td></tr>' +
        '<tr style="background:#EEF3FD"><td style="padding:8px;font-weight:700">Projected 90-day Cash</td><td style="padding:8px;font-weight:800;color:' + (projected90 > 0 ? '#059669' : '#DC2626') + ';text-align:right">Rs ' + projected90.toLocaleString('en-IN') + '</td></tr>' +
        '</table>' +
        '<p style="color:#64748B;font-size:12px;margin-top:16px">Deemona AI Finance OS | Cash Flow Prediction</p></div>'
      );
      await logAutomation(pool, tenantId, 'CASHFLOW_PREDICTION', 'alert', 'Projected 30d: Rs ' + projected30);
    }
  } catch (e) { console.error('[Automation] Cash flow prediction error:', e); }
}


// ============================================================

// ── TDS Auto-Tracking ─────────────────────────────────────────
async function trackTDS(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    // Payments above TDS threshold this month
    const payments = await pool.query(
      "SELECT ap.*, v.name as vendor_name, v.pan FROM ap_invoices ap LEFT JOIN vendors v ON ap.vendor_id=v.id WHERE ap.tenant_id=$1 AND ap.status='paid' AND ap.total_amount >= 30000 AND DATE_TRUNC('month', ap.updated_at) = DATE_TRUNC('month', NOW())",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    let totalTDS = 0;
    const tdsEntries = [];
    for (const payment of payments.rows) {
      const amount = parseFloat(payment.total_amount || 0);
      // Standard TDS rate 10% for professional services
      const tdsRate = 0.10;
      const tdsAmount = amount * tdsRate;
      totalTDS += tdsAmount;
      tdsEntries.push({ vendor: payment.vendor_name, pan: payment.pan, amount, tds: tdsAmount });
    }

    if (tdsEntries.length > 0) {
      const month = new Date().toLocaleString('en-IN', { month: 'long', year: 'numeric' });
      await sendEmail(adminEmail, 'TDS Summary — ' + month + ' | Rs ' + totalTDS.toLocaleString('en-IN') + ' payable',
        '<div style="font-family:Arial;padding:20px">' +
        '<h2 style="color:#1B4FD8">TDS Summary — ' + month + '</h2>' +
        '<p>Total TDS Payable (due 7th of next month): <strong>Rs ' + totalTDS.toLocaleString('en-IN') + '</strong></p>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:12px">' +
        '<tr style="background:#F0F5FF"><th style="padding:8px;text-align:left">Vendor</th><th style="padding:8px">PAN</th><th style="padding:8px;text-align:right">Payment</th><th style="padding:8px;text-align:right">TDS (10%)</th></tr>' +
        tdsEntries.map(e => '<tr><td style="padding:8px">' + (e.vendor || 'N/A') + '</td><td style="padding:8px;font-family:monospace">' + (e.pan || 'Not set') + '</td><td style="padding:8px;text-align:right">Rs ' + e.amount.toLocaleString('en-IN') + '</td><td style="padding:8px;text-align:right;color:#DC2626">Rs ' + e.tds.toLocaleString('en-IN') + '</td></tr>').join('') +
        '<tr style="font-weight:700;background:#EEF3FD"><td colspan="3" style="padding:8px">TOTAL TDS PAYABLE</td><td style="padding:8px;text-align:right;color:#DC2626">Rs ' + totalTDS.toLocaleString('en-IN') + '</td></tr>' +
        '</table><p style="color:#64748B;font-size:12px">Deemona AI Finance OS | TDS Auto-Tracking</p></div>'
      );
      await logAutomation(pool, tenantId, 'TDS_TRACKING', 'sent', 'TDS summary: Rs ' + totalTDS + ' payable');
    }
  } catch (e) { console.error('[Automation] TDS tracking error:', e); }
}

// ── Budget Burnout Predictor ───────────────────────────────────
async function predictBudgetBurnout(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    // Get active budgets
    const budgets = await pool.query(
      "SELECT b.*, COALESCE(SUM(bt.amount),0) as spent FROM budgets b LEFT JOIN budget_transactions bt ON bt.budget_id=b.id WHERE b.tenant_id=$1 AND b.status='active' AND b.end_date >= CURRENT_DATE GROUP BY b.id",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    const alerts = [];
    for (const budget of budgets.rows) {
      const allocated = parseFloat(budget.amount || budget.total_amount || 0);
      const spent = parseFloat(budget.spent || 0);
      const remaining = allocated - spent;
      const pctUsed = allocated > 0 ? (spent / allocated) * 100 : 0;

      // Calculate days into budget period
      const start = new Date(budget.start_date || budget.created_at);
      const end = new Date(budget.end_date);
      const totalDays = Math.ceil((end.getTime() - start.getTime()) / 86400000);
      const daysElapsed = Math.ceil((Date.now() - start.getTime()) / 86400000);
      const burnRate = daysElapsed > 0 ? spent / daysElapsed : 0;
      const daysUntilExhausted = burnRate > 0 ? remaining / burnRate : 999;

      if (pctUsed > 80 || daysUntilExhausted < 15) {
        alerts.push({
          name: budget.name || budget.department || 'Budget',
          pctUsed: pctUsed.toFixed(1),
          remaining,
          daysLeft: Math.ceil(daysUntilExhausted),
        });
      }
    }

    if (alerts.length > 0) {
      await sendEmail(adminEmail, 'Budget Burnout Alert: ' + alerts.length + ' budgets at risk',
        '<div style="font-family:Arial;padding:20px;background:#FFFBEB;border-left:4px solid #D97706">' +
        '<h2 style="color:#D97706">Budget Burnout Prediction</h2>' +
        alerts.map(a => '<div style="background:#fff;padding:12px;border-radius:8px;margin:8px 0;border:1px solid #FDE68A">' +
          '<div style="font-weight:700;color:#0A1628">' + a.name + '</div>' +
          '<div style="font-size:12px;color:#92400E">' + a.pctUsed + '% used | Rs ' + parseFloat(a.remaining).toLocaleString('en-IN') + ' remaining | ' + (a.daysLeft < 999 ? 'Exhausts in ~' + a.daysLeft + ' days' : 'On track') + '</div>' +
          '</div>').join('') +
        '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Budget Predictor</p></div>'
      );
      await logAutomation(pool, tenantId, 'BUDGET_BURNOUT', 'alert', alerts.length + ' budgets at risk');
    }
  } catch (e) { console.error('[Automation] Budget burnout error:', e); }
}

// ── Expense Policy Enforcement ────────────────────────────────
async function enforceExpensePolicy(pool, tenantId) {
  try {
    // Get policy limits from tenant settings
    const policyResult = await pool.query(
      "SELECT settings FROM tenant_settings WHERE tenant_id=$1",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    const policy = policyResult.rows[0]?.settings?.expense_policy || {
      hotel_per_night: 8000,
      meals_per_day: 1500,
      travel_per_trip: 20000,
      misc_limit: 5000,
    };

    // Check submitted expense claims against policy
    const claims = await pool.query(
      "SELECT * FROM expense_claims WHERE tenant_id=$1 AND status='submitted' AND created_at > NOW()-INTERVAL '1 hour'",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    for (const claim of claims.rows) {
      const amount = parseFloat(claim.total_amount || 0);
      const category = (claim.category || '').toLowerCase();
      let limit = policy.misc_limit;
      let reason = '';

      if (category.includes('hotel') || category.includes('accommodation')) { limit = policy.hotel_per_night; reason = 'hotel policy limit'; }
      else if (category.includes('meal') || category.includes('food')) { limit = policy.meals_per_day; reason = 'meals policy limit'; }
      else if (category.includes('travel') || category.includes('flight') || category.includes('train')) { limit = policy.travel_per_trip; reason = 'travel policy limit'; }

      if (amount > limit) {
        // Auto-reject
        await pool.query(
          "UPDATE expense_claims SET status='rejected', rejection_reason=$1, updated_at=NOW() WHERE id=$2",
          ['Exceeds ' + reason + ' of Rs ' + limit.toLocaleString('en-IN') + '. Amount claimed: Rs ' + amount.toLocaleString('en-IN'), claim.id]
        ).catch(() => {});

        // Notify employee
        if (claim.employee_email) {
          await sendEmail(claim.employee_email, 'Expense Claim Rejected: ' + claim.claim_number,
            '<div style="font-family:Arial;padding:20px;background:#FEF2F2;border-left:4px solid #DC2626">' +
            '<h2 style="color:#DC2626">Expense Claim Rejected</h2>' +
            '<p>Your expense claim <strong>' + claim.claim_number + '</strong> for Rs ' + amount.toLocaleString('en-IN') + ' has been automatically rejected.</p>' +
            '<p><strong>Reason:</strong> Exceeds ' + reason + ' of Rs ' + limit.toLocaleString('en-IN') + '</p>' +
            '<p>Please resubmit with a compliant amount or get prior approval for exceptions.</p>' +
            '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Expense Policy Engine</p></div>'
          );
        }
        await logAutomation(pool, tenantId, 'EXPENSE_POLICY', 'rejected', 'Claim ' + claim.claim_number + ' rejected: exceeds ' + reason);
      }
    }
  } catch (e) { console.error('[Automation] Expense policy error:', e); }
}

// ── Contract/Probation Auto-Monitor ──────────────────────────
async function monitorContracts(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    // Check employees on probation ending within 30 days
    const probation = await pool.query(
      "SELECT e.*, e.first_name || ' ' || e.last_name as full_name FROM employees e WHERE e.tenant_id=$1 AND e.probation_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    for (const emp of probation.rows) {
      const daysLeft = Math.ceil((new Date(emp.probation_end_date).getTime() - Date.now()) / 86400000);
      const alreadySent = await pool.query(
        "SELECT id FROM automation_logs WHERE automation_type='PROBATION_ALERT' AND detail LIKE $1 AND created_at > NOW()-INTERVAL '7 days'",
        ['%' + emp.id + '%']
      ).catch(() => ({ rows: [] }));
      if (alreadySent.rows.length > 0) continue;

      await sendEmail(adminEmail, 'Probation Ending: ' + emp.full_name + ' in ' + daysLeft + ' days',
        '<div style="font-family:Arial;padding:20px;background:#EEF3FD;border-left:4px solid #1B4FD8">' +
        '<h2 style="color:#1B4FD8">Probation Period Ending</h2>' +
        '<p><strong>' + emp.full_name + '</strong> probation ends on ' + new Date(emp.probation_end_date).toLocaleDateString('en-IN') + ' (' + daysLeft + ' days).</p>' +
        '<p>Please initiate the confirmation process or extend probation as required.</p>' +
        '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS | HR Monitor</p></div>'
      );
      await logAutomation(pool, tenantId, 'PROBATION_ALERT', 'sent', 'Probation alert for ' + emp.full_name + ' | ' + emp.id);
    }

    // Check contracts expiring
    const contracts = await pool.query(
      "SELECT * FROM contracts WHERE tenant_id=$1 AND end_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30 AND status='active'",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    for (const contract of contracts.rows) {
      const daysLeft = Math.ceil((new Date(contract.end_date).getTime() - Date.now()) / 86400000);
      await sendEmail(adminEmail, 'Contract Expiring: ' + (contract.title || contract.name) + ' in ' + daysLeft + ' days',
        '<div style="font-family:Arial;padding:20px;background:#FFFBEB;border-left:4px solid #D97706">' +
        '<h2 style="color:#D97706">Contract Expiry Alert</h2>' +
        '<p>Contract <strong>' + (contract.title || contract.name) + '</strong> expires on ' + new Date(contract.end_date).toLocaleDateString('en-IN') + ' (' + daysLeft + ' days).</p>' +
        '<p>Please review and initiate renewal if required.</p>' +
        '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Contract Monitor</p></div>'
      );
      await logAutomation(pool, tenantId, 'CONTRACT_ALERT', 'sent', 'Contract expiry alert: ' + (contract.title || contract.name));
    }
  } catch (e) { console.error('[Automation] Contract monitor error:', e); }
}

// ── Credit Limit Auto-Monitor ─────────────────────────────────
async function checkCreditLimits(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    // Get customers with credit limits
    const customers = await pool.query(
      "SELECT c.*, COALESCE(SUM(ar.balance_due),0) as outstanding FROM customers c LEFT JOIN ar_invoices ar ON ar.customer_id=c.id AND ar.status IN ('sent','overdue') WHERE c.tenant_id=$1 AND c.credit_limit > 0 GROUP BY c.id HAVING COALESCE(SUM(ar.balance_due),0) > c.credit_limit * 0.8",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    for (const customer of customers.rows) {
      const limit = parseFloat(customer.credit_limit);
      const outstanding = parseFloat(customer.outstanding);
      const pct = ((outstanding / limit) * 100).toFixed(1);

      await sendEmail(adminEmail, 'Credit Limit Alert: ' + customer.name + ' at ' + pct + '% of limit',
        '<div style="font-family:Arial;padding:20px;background:#FFFBEB;border-left:4px solid #D97706">' +
        '<h2 style="color:#D97706">Credit Limit Alert</h2>' +
        '<p>Customer <strong>' + customer.name + '</strong> has reached ' + pct + '% of their credit limit.</p>' +
        '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">' +
        '<tr><td style="padding:8px;color:#64748B">Credit Limit</td><td style="padding:8px;font-weight:700">Rs ' + limit.toLocaleString('en-IN') + '</td></tr>' +
        '<tr><td style="padding:8px;color:#64748B">Outstanding</td><td style="padding:8px;color:#DC2626;font-weight:700">Rs ' + outstanding.toLocaleString('en-IN') + '</td></tr>' +
        '<tr><td style="padding:8px;color:#64748B">Available</td><td style="padding:8px;color:#059669;font-weight:700">Rs ' + (limit - outstanding).toLocaleString('en-IN') + '</td></tr>' +
        '</table><p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Credit Monitor</p></div>'
      );
      await logAutomation(pool, tenantId, 'CREDIT_LIMIT_ALERT', 'sent', customer.name + ' at ' + pct + '% of credit limit');
    }
  } catch (e) { console.error('[Automation] Credit limit error:', e); }
}

// ── Statutory Due Date Monitor ────────────────────────────────
async function checkStatutoryDueDates(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);
    const now = new Date();
    const day = now.getDate();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const alerts = [];

    // GST due dates: GSTR-1 on 11th, GSTR-3B on 20th
    if (day <= 7 && day >= 1) alerts.push({ title: 'TDS Payment Due', due: '7th of this month', urgent: day >= 5 });
    if (day <= 11 && day >= 4) alerts.push({ title: 'GSTR-1 Filing Due', due: '11th of this month', urgent: day >= 9 });
    if (day <= 15 && day >= 8) alerts.push({ title: 'PF/ESI Payment Due', due: '15th of this month', urgent: day >= 13 });
    if (day <= 20 && day >= 13) alerts.push({ title: 'GSTR-3B Filing Due', due: '20th of this month', urgent: day >= 18 });

    // Advance tax quarters: 15 Jun, 15 Sep, 15 Dec, 15 Mar
    const advanceTaxMonths = [6, 9, 12, 3];
    if (advanceTaxMonths.includes(month) && day >= 8 && day <= 15) {
      alerts.push({ title: 'Advance Tax Payment Due', due: '15th ' + now.toLocaleString('en-IN', { month: 'long' }), urgent: day >= 13 });
    }

    if (alerts.length > 0) {
      const alreadySent = await pool.query(
        "SELECT id FROM automation_logs WHERE automation_type='STATUTORY_ALERT' AND created_at > NOW()-INTERVAL '24 hours' LIMIT 1"
      ).catch(() => ({ rows: [] }));
      if (alreadySent.rows.length > 0) return;

      await sendEmail(adminEmail, 'Statutory Compliance Reminders — ' + now.toLocaleDateString('en-IN'),
        '<div style="font-family:Arial;padding:20px">' +
        '<h2 style="color:#1B4FD8">Statutory Due Date Reminders</h2>' +
        alerts.map(a => '<div style="padding:12px;background:' + (a.urgent ? '#FEF2F2' : '#FFFBEB') + ';border-left:3px solid ' + (a.urgent ? '#DC2626' : '#D97706') + ';border-radius:6px;margin:8px 0">' +
          '<div style="font-weight:700;color:' + (a.urgent ? '#DC2626' : '#D97706') + '">' + (a.urgent ? 'URGENT: ' : '') + a.title + '</div>' +
          '<div style="font-size:12px;color:#64748B">Due: ' + a.due + '</div></div>').join('') +
        '<p style="color:#64748B;font-size:12px;margin-top:16px">Deemona AI Finance OS | Statutory Monitor</p></div>'
      );
      await logAutomation(pool, tenantId, 'STATUTORY_ALERT', 'sent', alerts.map(a => a.title).join(', '));
    }
  } catch (e) { console.error('[Automation] Statutory dates error:', e); }
}

// ── Invoice Auto-Aging Report (Daily 6AM) ─────────────────────
async function sendInvoiceAgingReport(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    const aging = await pool.query(
      "SELECT ar.*, c.name as customer_name, c.email as customer_email, CURRENT_DATE - ar.due_date as days_overdue FROM ar_invoices ar LEFT JOIN customers c ON ar.customer_id=c.id WHERE ar.tenant_id=$1 AND ar.status IN ('sent','overdue') AND ar.due_date < CURRENT_DATE ORDER BY days_overdue DESC LIMIT 20",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    if (!aging.rows.length) return;

    const bucket30 = aging.rows.filter(r => r.days_overdue <= 30);
    const bucket60 = aging.rows.filter(r => r.days_overdue > 30 && r.days_overdue <= 60);
    const bucket90 = aging.rows.filter(r => r.days_overdue > 60 && r.days_overdue <= 90);
    const bucket90plus = aging.rows.filter(r => r.days_overdue > 90);

    const sumAmt = (arr) => arr.reduce((s, r) => s + parseFloat(r.total_amount || r.balance_due || 0), 0);

    await sendEmail(adminEmail, 'Daily AR Aging Report — ' + new Date().toLocaleDateString('en-IN'),
      '<div style="font-family:Arial;padding:20px">' +
      '<h2 style="color:#1B4FD8">AR Aging Report</h2>' +
      '<p>' + new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + '</p>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:20px">' +
      '<div style="background:#FEF2F2;padding:12px;border-radius:8px;text-align:center"><div style="font-size:10px;color:#DC2626;font-weight:700">90+ DAYS</div><div style="font-size:18px;font-weight:800;color:#DC2626">' + bucket90plus.length + '</div><div style="font-size:11px;color:#DC2626">Rs ' + sumAmt(bucket90plus).toLocaleString('en-IN') + '</div></div>' +
      '<div style="background:#FEF9EC;padding:12px;border-radius:8px;text-align:center"><div style="font-size:10px;color:#D97706;font-weight:700">61-90 DAYS</div><div style="font-size:18px;font-weight:800;color:#D97706">' + bucket90.length + '</div><div style="font-size:11px;color:#D97706">Rs ' + sumAmt(bucket90).toLocaleString('en-IN') + '</div></div>' +
      '<div style="background:#FFFBEB;padding:12px;border-radius:8px;text-align:center"><div style="font-size:10px;color:#92400E;font-weight:700">31-60 DAYS</div><div style="font-size:18px;font-weight:800;color:#92400E">' + bucket60.length + '</div><div style="font-size:11px;color:#92400E">Rs ' + sumAmt(bucket60).toLocaleString('en-IN') + '</div></div>' +
      '<div style="background:#ECFDF5;padding:12px;border-radius:8px;text-align:center"><div style="font-size:10px;color:#059669;font-weight:700">1-30 DAYS</div><div style="font-size:18px;font-weight:800;color:#059669">' + bucket30.length + '</div><div style="font-size:11px;color:#059669">Rs ' + sumAmt(bucket30).toLocaleString('en-IN') + '</div></div>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      '<tr style="background:#F0F5FF"><th style="padding:8px;text-align:left">Customer</th><th style="padding:8px;text-align:left">Invoice</th><th style="padding:8px;text-align:right">Amount</th><th style="padding:8px;text-align:right">Days Overdue</th></tr>' +
      aging.rows.slice(0, 10).map(r => '<tr style="border-top:1px solid #F1F5F9"><td style="padding:8px">' + (r.customer_name || 'N/A') + '</td><td style="padding:8px">' + r.invoice_number + '</td><td style="padding:8px;text-align:right">Rs ' + parseFloat(r.total_amount || 0).toLocaleString('en-IN') + '</td><td style="padding:8px;text-align:right;color:' + (r.days_overdue > 60 ? '#DC2626' : r.days_overdue > 30 ? '#D97706' : '#059669') + ';font-weight:700">' + r.days_overdue + ' days</td></tr>').join('') +
      '</table><p style="color:#64748B;font-size:12px;margin-top:16px">Deemona AI Finance OS | AR Aging Report</p></div>'
    );
    await logAutomation(pool, tenantId, 'AGING_REPORT', 'sent', 'AR aging: ' + aging.rows.length + ' overdue invoices');
  } catch (e) { console.error('[Automation] Aging report error:', e); }
}



// ── 1. Recurring Invoice Auto-Generation ─────────────────────
async function generateRecurringInvoices(pool, tenantId) {
  try {
    // Check for recurring invoice schedules
    const schedules = await pool.query(
      "SELECT rs.*, c.name as customer_name, c.email as customer_email FROM recurring_invoice_schedules rs LEFT JOIN customers c ON rs.customer_id=c.id WHERE rs.tenant_id=$1 AND rs.is_active=true AND rs.next_invoice_date <= CURRENT_DATE",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    if (!schedules.rows.length) return;

    for (const schedule of schedules.rows) {
      // Generate new invoice
      const invoiceNum = 'REC-' + Date.now().toString().slice(-8);
      const result = await pool.query(
        "INSERT INTO ar_invoices (tenant_id, customer_id, invoice_number, date, due_date, total_amount, status, notes) VALUES ($1,$2,$3,CURRENT_DATE,CURRENT_DATE+$4,$5,'draft',$6) RETURNING id, invoice_number",
        [tenantId, schedule.customer_id, invoiceNum, schedule.payment_terms || 30, schedule.amount, 'Auto-generated recurring invoice']
      ).catch(() => ({ rows: [] }));

      if (!result.rows.length) continue;

      const invoice = result.rows[0];

      // Update next invoice date
      const freq = schedule.frequency || 'monthly';
      const interval = freq === 'weekly' ? '7 days' : freq === 'quarterly' ? '3 months' : '1 month';
      await pool.query(
        "UPDATE recurring_invoice_schedules SET next_invoice_date=next_invoice_date+INTERVAL '" + interval + "', total_generated=total_generated+1, updated_at=NOW() WHERE id=$1",
        [schedule.id]
      ).catch(() => {});

      // Email customer
      if (schedule.customer_email) {
        await sendEmail(schedule.customer_email,
          'Invoice ' + invoice.invoice_number + ' — Rs ' + parseFloat(schedule.amount).toLocaleString('en-IN'),
          '<div style="font-family:Arial;padding:20px"><h2 style="color:#1B4FD8">Invoice from Deemona Technologies</h2>' +
          '<p>Dear ' + (schedule.customer_name || 'Customer') + ',</p>' +
          '<p>Please find your invoice <strong>' + invoice.invoice_number + '</strong> for <strong>Rs ' + parseFloat(schedule.amount).toLocaleString('en-IN') + '</strong>.</p>' +
          '<p>Due date: ' + new Date(Date.now() + (schedule.payment_terms || 30) * 86400000).toLocaleDateString('en-IN') + '</p>' +
          '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Auto-generated Invoice</p></div>'
        );
      }

      await logAutomation(pool, tenantId, 'RECURRING_INVOICE', 'generated', 'Invoice ' + invoice.invoice_number + ' generated for ' + (schedule.customer_name || 'customer'));
    }
  } catch (e) { console.error('[Automation] Recurring invoices error:', e); }
}

// ── 2. Revenue Forecasting AI ────────────────────────────────
async function generateRevenueForecast(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    // Get last 6 months revenue
    const monthly = await pool.query(
      "SELECT DATE_TRUNC('month', date) as month, SUM(total_amount) as revenue FROM ar_invoices WHERE tenant_id=$1 AND status IN ('paid','sent') AND date > NOW()-INTERVAL '6 months' GROUP BY DATE_TRUNC('month', date) ORDER BY month",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    if (monthly.rows.length < 2) return; // Not enough data

    // Simple linear trend forecast
    const revenues = monthly.rows.map(r => parseFloat(r.revenue));
    const n = revenues.length;
    const avg = revenues.reduce((a, b) => a + b, 0) / n;
    const trend = n > 1 ? (revenues[n-1] - revenues[0]) / (n - 1) : 0;

    const forecast30 = Math.max(0, revenues[n-1] + trend);
    const forecast60 = Math.max(0, revenues[n-1] + trend * 2);
    const forecast90 = Math.max(0, revenues[n-1] + trend * 3);

    // Get pipeline value from CRM
    const pipeline = await pool.query(
      "SELECT COALESCE(SUM(value * probability / 100),0) as weighted FROM crm_leads WHERE tenant_id=$1 AND stage NOT IN ('lost','converted')",
      [tenantId]
    ).catch(() => ({ rows: [{ weighted: 0 }] }));

    const pipelineValue = parseFloat(pipeline.rows[0].weighted);
    const direction = trend >= 0 ? 'Growing' : 'Declining';
    const trendPct = avg > 0 ? ((trend / avg) * 100).toFixed(1) : '0';

    await sendEmail(adminEmail, 'Revenue Forecast Report — ' + new Date().toLocaleDateString('en-IN'),
      '<div style="font-family:Arial;padding:20px">' +
      '<h2 style="color:#1B4FD8">AI Revenue Forecast</h2>' +
      '<p>Based on last ' + n + ' months of data. Trend: <strong style="color:' + (trend >= 0 ? '#059669' : '#DC2626') + '">' + direction + ' (' + (trend >= 0 ? '+' : '') + trendPct + '% MoM)</strong></p>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:16px 0">' +
      '<div style="background:#ECFDF5;padding:14px;border-radius:10px;text-align:center"><div style="font-size:10px;color:#059669;font-weight:700">30-DAY FORECAST</div><div style="font-size:18px;font-weight:800;color:#059669">Rs ' + forecast30.toLocaleString('en-IN') + '</div></div>' +
      '<div style="background:#EEF3FD;padding:14px;border-radius:10px;text-align:center"><div style="font-size:10px;color:#1B4FD8;font-weight:700">60-DAY FORECAST</div><div style="font-size:18px;font-weight:800;color:#1B4FD8">Rs ' + forecast60.toLocaleString('en-IN') + '</div></div>' +
      '<div style="background:#F5F3FF;padding:14px;border-radius:10px;text-align:center"><div style="font-size:10px;color:#7C3AED;font-weight:700">90-DAY FORECAST</div><div style="font-size:18px;font-weight:800;color:#7C3AED">Rs ' + forecast90.toLocaleString('en-IN') + '</div></div></div>' +
      '<div style="background:#fff;padding:14px;border-radius:10px;border:1px solid #C7D9F8;margin-top:12px">' +
      '<div style="font-size:12px;font-weight:700;color:#0A1628;margin-bottom:8px">CRM Pipeline (Weighted)</div>' +
      '<div style="font-size:20px;font-weight:800;color:#7C3AED">Rs ' + pipelineValue.toLocaleString('en-IN') + '</div>' +
      '<div style="font-size:11px;color:#64748B">Probability-weighted open deals</div></div>' +
      '<p style="color:#64748B;font-size:11px;margin-top:16px">Deemona AI Finance OS | Revenue Forecasting | Based on historical trend analysis</p></div>'
    );
    await logAutomation(pool, tenantId, 'REVENUE_FORECAST', 'sent', 'Forecast 30d: Rs ' + forecast30 + ' | 60d: Rs ' + forecast60);
  } catch (e) { console.error('[Automation] Revenue forecast error:', e); }
}

// ── 3. Smart Budget Reallocation ──────────────────────────────
async function analyzeBudgetReallocation(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    const budgets = await pool.query(
      "SELECT b.*, COALESCE(SUM(bt.amount),0) as spent FROM budgets b LEFT JOIN budget_transactions bt ON bt.budget_id=b.id WHERE b.tenant_id=$1 AND b.status='active' AND b.end_date >= CURRENT_DATE GROUP BY b.id",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    if (budgets.rows.length < 2) return;

    const underspent = [];
    const overspent = [];

    for (const b of budgets.rows) {
      const allocated = parseFloat(b.amount || b.total_amount || 0);
      const spent = parseFloat(b.spent || 0);
      const pct = allocated > 0 ? (spent / allocated) * 100 : 0;
      const remaining = allocated - spent;

      // Days into budget period
      const start = new Date(b.start_date || b.created_at);
      const end = new Date(b.end_date);
      const totalDays = Math.max(1, Math.ceil((end - start) / 86400000));
      const elapsed = Math.ceil((Date.now() - start) / 86400000);
      const expectedPct = (elapsed / totalDays) * 100;

      if (pct < expectedPct - 20 && remaining > 50000) {
        underspent.push({ name: b.name || b.department || 'Budget', allocated, spent, remaining, pct: pct.toFixed(1) });
      } else if (pct > Math.min(expectedPct + 20, 90)) {
        overspent.push({ name: b.name || b.department || 'Budget', allocated, spent, remaining, pct: pct.toFixed(1) });
      }
    }

    if (underspent.length > 0 && overspent.length > 0) {
      const totalUnderspent = underspent.reduce((s, b) => s + b.remaining, 0);

      await sendEmail(adminEmail, 'Smart Budget Reallocation Recommendation',
        '<div style="font-family:Arial;padding:20px;background:#EEF3FD;border-left:4px solid #1B4FD8">' +
        '<h2 style="color:#1B4FD8">Budget Reallocation Opportunity</h2>' +
        '<p>AI analysis detected budget imbalances. Recommended reallocation:</p>' +
        '<div style="margin:16px 0">' +
        '<div style="font-size:12px;font-weight:700;color:#059669;margin-bottom:8px">AVAILABLE (Underspent)</div>' +
        underspent.map(b => '<div style="background:#ECFDF5;padding:10px;border-radius:8px;margin:6px 0"><div style="font-weight:600">' + b.name + '</div><div style="font-size:12px;color:#059669">Rs ' + b.remaining.toLocaleString('en-IN') + ' available (' + b.pct + '% used)</div></div>').join('') +
        '</div><div style="margin:16px 0">' +
        '<div style="font-size:12px;font-weight:700;color:#DC2626;margin-bottom:8px">NEEDS FUNDING (Overspent)</div>' +
        overspent.map(b => '<div style="background:#FEF2F2;padding:10px;border-radius:8px;margin:6px 0"><div style="font-weight:600">' + b.name + '</div><div style="font-size:12px;color:#DC2626">' + b.pct + '% used — needs additional Rs ' + Math.abs(b.remaining).toLocaleString('en-IN') + '</div></div>').join('') +
        '</div><div style="background:#fff;padding:12px;border-radius:8px;border:1px solid #C7D9F8">' +
        '<div style="font-weight:700;color:#0A1628">Recommendation: Reallocate Rs ' + Math.min(totalUnderspent, Math.abs(overspent[0].remaining)).toLocaleString('en-IN') + ' from ' + underspent[0].name + ' to ' + overspent[0].name + '</div></div>' +
        '<p style="color:#64748B;font-size:12px;margin-top:16px">Deemona AI Finance OS | Smart Budget Reallocation</p></div>'
      );
      await logAutomation(pool, tenantId, 'BUDGET_REALLOCATION', 'recommended', 'Reallocation from ' + underspent[0].name + ' to ' + overspent[0].name);
    }
  } catch (e) { console.error('[Automation] Budget reallocation error:', e); }
}

// ── 4. Customer Payment Pattern Analysis ──────────────────────
async function analyzeCustomerPaymentPatterns(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    // Analyze payment patterns per customer
    const patterns = await pool.query(
      "SELECT ar.customer_id, c.name as customer_name, AVG(ar.paid_date - ar.due_date) as avg_days_late, COUNT(*) as invoice_count, SUM(ar.total_amount) as total_value FROM ar_invoices ar LEFT JOIN customers c ON ar.customer_id=c.id WHERE ar.tenant_id=$1 AND ar.status='paid' AND ar.paid_date IS NOT NULL AND ar.created_at > NOW()-INTERVAL '6 months' GROUP BY ar.customer_id, c.name HAVING COUNT(*) >= 2 ORDER BY avg_days_late DESC LIMIT 10",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    if (!patterns.rows.length) return;

    const latePayors = patterns.rows.filter(p => parseFloat(p.avg_days_late) > 5);
    const earlyPayors = patterns.rows.filter(p => parseFloat(p.avg_days_late) <= 0);

    if (latePayors.length === 0) return;

    await sendEmail(adminEmail, 'Customer Payment Pattern Analysis — Action Required',
      '<div style="font-family:Arial;padding:20px">' +
      '<h2 style="color:#1B4FD8">Customer Payment Pattern Report</h2>' +
      '<p>Based on last 6 months of payment data:</p>' +
      (latePayors.length > 0 ? '<div style="margin:16px 0"><div style="font-size:12px;font-weight:700;color:#DC2626;margin-bottom:8px">CONSISTENTLY LATE PAYORS — Follow up proactively</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px"><tr style="background:#FEF2F2"><th style="padding:8px;text-align:left">Customer</th><th style="padding:8px;text-align:right">Avg Days Late</th><th style="padding:8px;text-align:right">Invoices</th><th style="padding:8px;text-align:right">Total Value</th></tr>' +
      latePayors.map(p => '<tr style="border-top:1px solid #FECACA"><td style="padding:8px">' + (p.customer_name || 'N/A') + '</td><td style="padding:8px;text-align:right;color:#DC2626;font-weight:700">+' + Math.round(parseFloat(p.avg_days_late)) + ' days</td><td style="padding:8px;text-align:right">' + p.invoice_count + '</td><td style="padding:8px;text-align:right">Rs ' + parseFloat(p.total_value).toLocaleString('en-IN') + '</td></tr>').join('') +
      '</table></div>' : '') +
      (earlyPayors.length > 0 ? '<div style="margin:16px 0"><div style="font-size:12px;font-weight:700;color:#059669;margin-bottom:8px">PROMPT PAYORS — Consider early payment discounts</div>' +
      earlyPayors.map(p => '<div style="background:#ECFDF5;padding:8px;border-radius:6px;margin:4px 0;font-size:12px">' + (p.customer_name || 'N/A') + ' — pays ' + Math.abs(Math.round(parseFloat(p.avg_days_late))) + ' days early on average</div>').join('') +
      '</div>' : '') +
      '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Customer Payment Analytics</p></div>'
    );
    await logAutomation(pool, tenantId, 'PAYMENT_PATTERN', 'sent', latePayors.length + ' late payors identified');
  } catch (e) { console.error('[Automation] Payment pattern error:', e); }
}

// ── 5. Contract Auto-Renewal Alert ───────────────────────────
async function checkContractRenewals(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    const contracts = await pool.query(
      "SELECT * FROM contracts WHERE tenant_id=$1 AND status='active' AND end_date BETWEEN CURRENT_DATE AND CURRENT_DATE+60 ORDER BY end_date ASC",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    if (!contracts.rows.length) return;

    for (const contract of contracts.rows) {
      const daysLeft = Math.ceil((new Date(contract.end_date) - Date.now()) / 86400000);
      const alreadySent = await pool.query(
        "SELECT id FROM automation_logs WHERE automation_type='CONTRACT_RENEWAL' AND detail LIKE $1 AND created_at > NOW()-INTERVAL '7 days'",
        ['%' + contract.id + '%']
      ).catch(() => ({ rows: [] }));
      if (alreadySent.rows.length > 0) continue;

      const isUrgent = daysLeft <= 14;
      await sendEmail(adminEmail,
        (isUrgent ? 'URGENT: ' : '') + 'Contract Renewal Required: ' + (contract.title || contract.name || 'Contract') + ' — ' + daysLeft + ' days left',
        '<div style="font-family:Arial;padding:20px;background:' + (isUrgent ? '#FEF2F2' : '#FFFBEB') + ';border-left:4px solid ' + (isUrgent ? '#DC2626' : '#D97706') + '">' +
        '<h2 style="color:' + (isUrgent ? '#DC2626' : '#D97706') + '">' + (isUrgent ? 'URGENT: ' : '') + 'Contract Renewal Required</h2>' +
        '<p>Contract <strong>' + (contract.title || contract.name || 'Contract') + '</strong> expires in <strong>' + daysLeft + ' days</strong> on ' + new Date(contract.end_date).toLocaleDateString('en-IN') + '.</p>' +
        '<p>Contract Value: Rs ' + parseFloat(contract.value || contract.amount || 0).toLocaleString('en-IN') + '</p>' +
        '<p>Please initiate renewal negotiations or let expire as required.</p>' +
        (isUrgent ? '<p style="color:#DC2626;font-weight:bold">ACTION REQUIRED IMMEDIATELY — Less than 14 days remaining.</p>' : '') +
        '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Contract Monitor</p></div>'
      );
      await logAutomation(pool, tenantId, 'CONTRACT_RENEWAL', 'sent', 'Contract renewal alert: ' + (contract.title || contract.name) + ' | ' + contract.id);
    }
  } catch (e) { console.error('[Automation] Contract renewal error:', e); }
}

// ── 6. Insurance Premium Auto-Track ──────────────────────────
async function trackInsurancePremiums(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    // Check documents table for insurance policies
    const policies = await pool.query(
      "SELECT * FROM documents WHERE tenant_id=$1 AND document_type='insurance' AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+60 ORDER BY expiry_date ASC",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    if (!policies.rows.length) return;

    for (const policy of policies.rows) {
      const daysLeft = Math.ceil((new Date(policy.expiry_date) - Date.now()) / 86400000);
      const alreadySent = await pool.query(
        "SELECT id FROM automation_logs WHERE automation_type='INSURANCE_ALERT' AND detail LIKE $1 AND created_at > NOW()-INTERVAL '7 days'",
        ['%' + policy.id + '%']
      ).catch(() => ({ rows: [] }));
      if (alreadySent.rows.length > 0) continue;

      await sendEmail(adminEmail,
        'Insurance Renewal Alert: ' + (policy.title || policy.name || 'Policy') + ' — ' + daysLeft + ' days left',
        '<div style="font-family:Arial;padding:20px;background:#F5F3FF;border-left:4px solid #7C3AED">' +
        '<h2 style="color:#7C3AED">Insurance Policy Renewal</h2>' +
        '<p>Insurance policy <strong>' + (policy.title || policy.name || 'Policy') + '</strong> expires on ' + new Date(policy.expiry_date).toLocaleDateString('en-IN') + ' (' + daysLeft + ' days).</p>' +
        '<p>Please initiate renewal to ensure continuous coverage.</p>' +
        '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS | Insurance Tracker</p></div>'
      );
      await logAutomation(pool, tenantId, 'INSURANCE_ALERT', 'sent', 'Insurance alert: ' + (policy.title || policy.name) + ' | ' + policy.id);
    }
  } catch (e) { console.error('[Automation] Insurance tracking error:', e); }
}

// ── 7. PF/ESI ECR File Generation ────────────────────────────
async function generatePFECRFile(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    // Get latest payroll run this month
    const payrollRun = await pool.query(
      "SELECT pr.*, COUNT(ps.id) as employee_count FROM payroll_runs pr LEFT JOIN payslips ps ON ps.payroll_run_id=pr.id WHERE pr.tenant_id=$1 AND DATE_TRUNC('month', pr.created_at) = DATE_TRUNC('month', NOW()) AND pr.status='completed' GROUP BY pr.id ORDER BY pr.created_at DESC LIMIT 1",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    if (!payrollRun.rows.length) return;

    const run = payrollRun.rows[0];

    // Get payslip details
    const payslips = await pool.query(
      "SELECT ps.*, e.uan_number, e.esic_number, e.first_name, e.last_name FROM payslips ps JOIN employees e ON ps.employee_id=e.id WHERE ps.payroll_run_id=$1",
      [run.id]
    ).catch(() => ({ rows: [] }));

    if (!payslips.rows.length) return;

    // Generate ECR format (simplified)
    let ecrData = '#~#\n';
    ecrData += '# UAN~MEMBER_NAME~GROSS_WAGES~EPF_WAGES~EPS_WAGES~EDLI_WAGES~EPF_CONTRI_REMITTED~EPS_CONTRI_REMITTED~EPF_EPS_DIFF_REMITTED~NCP_DAYS~REFUND_OF_ADVANCES\n';

    let totalPF = 0;
    for (const slip of payslips.rows) {
      const grossPay = parseFloat(slip.gross_pay || 0);
      const pfWages = Math.min(grossPay, 15000); // PF ceiling
      const epfContri = Math.round(pfWages * 0.12);
      const epsContri = Math.round(pfWages * 0.0833);
      totalPF += epfContri;

      ecrData += (slip.uan_number || 'PENDING') + '~' +
        (slip.first_name || '') + ' ' + (slip.last_name || '') + '~' +
        Math.round(grossPay) + '~' + Math.round(pfWages) + '~' + Math.round(pfWages) + '~' +
        Math.round(pfWages) + '~' + epfContri + '~' + epsContri + '~' +
        (epfContri - epsContri) + '~0~0\n';
    }

    const month = new Date().toLocaleString('en-IN', { month: 'long', year: 'numeric' });

    await sendEmail(adminEmail, 'PF/ESI ECR File Ready — ' + month,
      '<div style="font-family:Arial;padding:20px">' +
      '<h2 style="color:#1B4FD8">PF/ESI ECR File Generated</h2>' +
      '<p>Monthly ECR file for <strong>' + month + '</strong> is ready for upload to EPFO portal.</p>' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px;margin:12px 0">' +
      '<tr><td style="padding:8px;color:#64748B">Employees</td><td style="padding:8px;font-weight:700">' + payslips.rows.length + '</td></tr>' +
      '<tr style="background:#F8FAFC"><td style="padding:8px;color:#64748B">Total PF Contribution</td><td style="padding:8px;font-weight:700;color:#1B4FD8">Rs ' + totalPF.toLocaleString('en-IN') + '</td></tr>' +
      '<tr><td style="padding:8px;color:#64748B">Due Date</td><td style="padding:8px;font-weight:700;color:#DC2626">15th of this month</td></tr>' +
      '</table>' +
      '<div style="background:#F0F5FF;padding:14px;border-radius:8px;margin:12px 0">' +
      '<div style="font-size:11px;font-weight:700;color:#1B4FD8;margin-bottom:8px">ECR DATA PREVIEW</div>' +
      '<pre style="font-size:10px;color:#334155;overflow:auto;max-height:200px">' + ecrData.substring(0, 500) + '...</pre></div>' +
      '<p><strong>Next Steps:</strong> Upload this ECR file to <a href="https://unifiedportal-emp.epfindia.gov.in" style="color:#1B4FD8">EPFO Unified Portal</a></p>' +
      '<p style="color:#64748B;font-size:12px">Deemona AI Finance OS | PF/ESI Auto-Calculation</p></div>'
    );
    await logAutomation(pool, tenantId, 'PF_ECR_GENERATED', 'sent', 'ECR file generated for ' + payslips.rows.length + ' employees, Total PF: Rs ' + totalPF);
  } catch (e) { console.error('[Automation] PF ECR error:', e); }
}

// ── 8. Increment/Appraisal Auto-Trigger ──────────────────────
async function checkAppraisalTriggers(pool, tenantId) {
  try {
    const adminEmail = await getTenantAdminEmail(pool, tenantId);

    // Find employees completing 1 year (within next 30 days)
    const employees = await pool.query(
      "SELECT e.*, e.first_name || ' ' || e.last_name as full_name FROM employees e WHERE e.tenant_id=$1 AND e.join_date IS NOT NULL AND (CURRENT_DATE - e.join_date) BETWEEN 335 AND 365",
      [tenantId]
    ).catch(() => ({ rows: [] }));

    if (!employees.rows.length) return;

    for (const emp of employees.rows) {
      const alreadySent = await pool.query(
        "SELECT id FROM automation_logs WHERE automation_type='APPRAISAL_TRIGGER' AND detail LIKE $1 AND created_at > NOW()-INTERVAL '30 days'",
        ['%' + emp.id + '%']
      ).catch(() => ({ rows: [] }));
      if (alreadySent.rows.length > 0) continue;

      const daysToAnniversary = 365 - Math.ceil((Date.now() - new Date(emp.join_date)) / 86400000);
      const joinDate = new Date(emp.join_date).toLocaleDateString('en-IN');
      const anniversary = new Date(new Date(emp.join_date).setFullYear(new Date().getFullYear())).toLocaleDateString('en-IN');

      await sendEmail(adminEmail,
        'Appraisal Due: ' + emp.full_name + ' — ' + daysToAnniversary + ' days to anniversary',
        '<div style="font-family:Arial;padding:20px;background:#EEF3FD;border-left:4px solid #1B4FD8">' +
        '<h2 style="color:#1B4FD8">Annual Appraisal Trigger</h2>' +
        '<p><strong>' + emp.full_name + '</strong> completes 1 year on <strong>' + anniversary + '</strong> (' + daysToAnniversary + ' days from now).</p>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px;margin:12px 0">' +
        '<tr><td style="padding:8px;color:#64748B">Employee</td><td style="padding:8px;font-weight:700">' + emp.full_name + '</td></tr>' +
        '<tr style="background:#F8FAFC"><td style="padding:8px;color:#64748B">Designation</td><td style="padding:8px">' + (emp.designation || emp.job_title || 'N/A') + '</td></tr>' +
        '<tr><td style="padding:8px;color:#64748B">Join Date</td><td style="padding:8px">' + joinDate + '</td></tr>' +
        '<tr style="background:#F8FAFC"><td style="padding:8px;color:#64748B">Current Salary</td><td style="padding:8px;font-weight:700">Rs ' + parseFloat(emp.salary || emp.basic_salary || 0).toLocaleString('en-IN') + '</td></tr>' +
        '</table>' +
        '<p><strong>Action Required:</strong> Initiate performance review and salary revision process.</p>' +
        '<a href="' + process.env.FRONTEND_URL + '/payroll" style="background:#1B4FD8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">Go to Payroll</a>' +
        '<p style="color:#64748B;font-size:12px;margin-top:16px">Deemona AI Finance OS | HR Appraisal Trigger</p></div>'
      );
      await logAutomation(pool, tenantId, 'APPRAISAL_TRIGGER', 'sent', 'Appraisal trigger for ' + emp.full_name + ' | ' + emp.id);
    }
  } catch (e) { console.error('[Automation] Appraisal trigger error:', e); }
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

  
  // Daily at 8AM IST (2:30 UTC) - Morning Brief
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() === 2 && now.getUTCMinutes() < 16) {
      try {
        const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
        for (const t of tenants.rows) {
          await sendDailyMorningBrief(pool, t.id).catch(() => {});
          await sendInvoicePaymentReminders(pool, t.id).catch(() => {});
          await sendInvoiceAgingReport(pool, t.id).catch(() => {});
          await checkStatutoryDueDates(pool, t.id).catch(() => {});
        }
      } catch(e) { console.error('[Automation] Daily 8AM cron:', e); }
    }
    // Monday 9AM IST (3:30 UTC) - Weekly Digest
    if (now.getUTCDay() === 1 && now.getUTCHours() === 3 && now.getUTCMinutes() < 16) {
      try {
        const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
        for (const t of tenants.rows) {
          await sendWeeklyDigest(pool, t.id).catch(() => {});
        }
      } catch(e) { console.error('[Automation] Weekly cron:', e); }
    }
  }, 15 * MINUTE);

  // Every 30 minutes - Fraud, Credit, Expense Policy
  setInterval(async () => {
    try {
      const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
      for (const t of tenants.rows) {
        await runFraudDetection(pool, t.id).catch(() => {});
        await checkCreditLimits(pool, t.id).catch(() => {});
        await enforceExpensePolicy(pool, t.id).catch(() => {});
        await checkVendorGSTINCompliance(pool, t.id).catch(() => {});
      }
    } catch(e) { console.error('[Automation] 30min cron:', e); }
  }, 30 * MINUTE);

  // Every 6 hours - TDS, Budget, Cash Flow Prediction, Contracts
  setInterval(async () => {
    try {
      const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
      for (const t of tenants.rows) {
        await trackTDS(pool, t.id).catch(() => {});
        await predictBudgetBurnout(pool, t.id).catch(() => {});
        await predictCashFlow(pool, t.id).catch(() => {});
        await monitorContracts(pool, t.id).catch(() => {});
      }
    } catch(e) { console.error('[Automation] 6hr cron:', e); }
  }, 6 * HOUR);

  // Payslip distribution - after payroll (check every hour)
  setInterval(async () => {
    try {
      const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
      for (const t of tenants.rows) {
        await distributePayslips(pool, t.id).catch(() => {});
      }
    } catch(e) { console.error('[Automation] Payslip cron:', e); }
  }, HOUR);

  
  // Every 6 hours - additional batch 3 functions
  setInterval(async () => {
    try {
      const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
      for (const t of tenants.rows) {
        await generateRecurringInvoices(pool, t.id).catch(() => {});
        await checkContractRenewals(pool, t.id).catch(() => {});
        await trackInsurancePremiums(pool, t.id).catch(() => {});
        await checkAppraisalTriggers(pool, t.id).catch(() => {});
        await analyzeCustomerPaymentPatterns(pool, t.id).catch(() => {});
      }
    } catch(e) { console.error('[Automation] Batch3 6hr cron:', e); }
  }, 6 * HOUR);

  // Monthly - revenue forecast, budget reallocation, PF ECR (on 1st)
  setInterval(async () => {
    const now = new Date();
    if (now.getDate() === 1 && now.getUTCHours() === 4) {
      try {
        const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
        for (const t of tenants.rows) {
          await generateRevenueForecast(pool, t.id).catch(() => {});
          await analyzeBudgetReallocation(pool, t.id).catch(() => {});
          await generatePFECRFile(pool, t.id).catch(() => {});
        }
      } catch(e) { console.error('[Automation] Monthly cron:', e); }
    }
  }, HOUR);

  console.log('[Automation] Cron jobs registered: Cash alerts (15min), Bank recon (hourly), GST/Payroll (daily)');
}
