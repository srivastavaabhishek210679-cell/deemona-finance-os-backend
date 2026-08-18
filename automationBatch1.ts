// ============================================================
// Deemona AI Finance OS — Automation Batch 1
// Daily Morning Brief, Weekly Digest, Invoice Reminders,
// Payslip Distribution, Anomaly Detection, Aging Report
// Add to: src/services/automationEngine.ts
// ============================================================

// ── BATCH 1: Daily Morning Brief (8AM IST = 2:30 UTC) ────────
export async function sendDailyMorningBrief(pool, tenantId) {
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
export async function sendWeeklyDigest(pool, tenantId) {
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
export async function sendInvoicePaymentReminders(pool, tenantId) {
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
export async function distributePayslips(pool, tenantId) {
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
export async function runFraudDetection(pool, tenantId) {
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
export async function checkVendorGSTINCompliance(pool, tenantId) {
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
export async function predictCashFlow(pool, tenantId) {
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
