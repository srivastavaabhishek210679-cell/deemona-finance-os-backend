// ============================================================
// Automation Batch 2 — TDS, Budget, Expense Policy, Anomaly,
// Recurring Invoices, Contract Alerts, Credit Limit, HR
// ============================================================

// ── TDS Auto-Tracking ─────────────────────────────────────────
export async function trackTDS(pool, tenantId) {
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
export async function predictBudgetBurnout(pool, tenantId) {
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
export async function enforceExpensePolicy(pool, tenantId) {
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
export async function monitorContracts(pool, tenantId) {
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
export async function checkCreditLimits(pool, tenantId) {
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
export async function checkStatutoryDueDates(pool, tenantId) {
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
export async function sendInvoiceAgingReport(pool, tenantId) {
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
