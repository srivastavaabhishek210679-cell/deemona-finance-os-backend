// ============================================================
// Automation Batch 3 — No External API Required
// Recurring Invoices, Revenue Forecast, Budget Reallocation,
// Customer Payment Patterns, Contract Renewal, Insurance,
// PF/ESI ECR, Increment/Appraisal
// ============================================================

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
