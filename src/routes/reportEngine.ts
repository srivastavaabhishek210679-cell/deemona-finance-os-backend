// ============================================================
// Deemona AI Finance OS — Full Report Engine
// 14 Financial Reports with HTML templates
// ============================================================

import { Pool } from 'pg';

const fmt = (n: any) => '₹' + parseFloat(n||0).toLocaleString('en-IN', {minimumFractionDigits:0,maximumFractionDigits:0});
const fmtC = (n: any) => { const v=parseFloat(n||0); if(v>=10000000) return '₹'+(v/10000000).toFixed(2)+'Cr'; if(v>=100000) return '₹'+(v/100000).toFixed(2)+'L'; return fmt(v); };
const fmtD = (d: any) => d ? new Date(d).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—';
const today = () => new Date().toLocaleDateString('en-IN',{weekday:'long',year:'numeric',month:'long',day:'numeric'});

const BASE_STYLE = `
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#f0f4ff;padding:0}
  .wrapper{max-width:720px;margin:0 auto;background:#fff}
  .header{background:linear-gradient(135deg,#1e3a8a,#1d4ed8);color:#fff;padding:28px 32px}
  .header-logo{font-size:11px;font-weight:700;letter-spacing:0.1em;opacity:0.7;margin-bottom:6px;text-transform:uppercase}
  .header-title{font-size:22px;font-weight:800;margin-bottom:4px}
  .header-sub{font-size:12px;opacity:0.8}
  .header-date{font-size:11px;opacity:0.6;margin-top:8px}
  .body{padding:24px 32px}
  .kpi-grid{display:grid;gap:12px;margin:20px 0}
  .kpi-grid-3{grid-template-columns:repeat(3,1fr)}
  .kpi-grid-4{grid-template-columns:repeat(4,1fr)}
  .kpi-grid-2{grid-template-columns:repeat(2,1fr)}
  .kpi{padding:14px 16px;border-radius:8px;border-left:4px solid}
  .kpi-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;margin-bottom:5px}
  .kpi-value{font-size:22px;font-weight:800;color:#0f172a;line-height:1}
  .kpi-sub{font-size:11px;color:#94a3b8;margin-top:3px}
  h2{font-size:14px;font-weight:700;color:#1e3a8a;margin:20px 0 10px;padding-bottom:6px;border-bottom:2px solid #e2e8f0}
  table{width:100%;border-collapse:collapse;margin:8px 0;font-size:12px}
  th{background:#1d4ed8;color:#fff;padding:9px 12px;text-align:left;font-size:11px;font-weight:700;white-space:nowrap}
  td{padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#334155}
  tr:nth-child(even) td{background:#fafbff}
  .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700}
  .green{color:#16a34a}.red{color:#dc2626}.amber{color:#d97706}.blue{color:#1d4ed8}
  .bg-green{background:#f0fdf4;border-color:#16a34a}
  .bg-red{background:#fef2f2;border-color:#dc2626}
  .bg-amber{background:#fffbeb;border-color:#d97706}
  .bg-blue{background:#eff6ff;border-color:#1d4ed8}
  .bg-purple{background:#f5f3ff;border-color:#7c3aed}
  .progress{height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;margin-top:6px}
  .progress-fill{height:100%;border-radius:3px}
  .alert{padding:12px 16px;border-radius:8px;margin:12px 0;font-size:12px}
  .alert-red{background:#fef2f2;border-left:4px solid #dc2626;color:#7f1d1d}
  .alert-amber{background:#fffbeb;border-left:4px solid #d97706;color:#78350f}
  .alert-green{background:#f0fdf4;border-left:4px solid #16a34a;color:#14532d}
  .footer{background:#f8faff;padding:16px 32px;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0}
  .divider{height:1px;background:#e2e8f0;margin:16px 0}
  .section{margin-bottom:20px}
  .tag{padding:2px 7px;border-radius:3px;font-size:10px;font-weight:700;display:inline-block}
</style>`;

const HEADER = (title: string, subtitle: string, icon: string) => `
<!DOCTYPE html><html><head><meta charset="UTF-8">${BASE_STYLE}</head><body>
<div class="wrapper">
<div class="header">
  <div class="header-logo">Deemona AI Finance OS</div>
  <div class="header-title">${icon} ${title}</div>
  <div class="header-sub">${subtitle}</div>
  <div class="header-date">Generated: ${today()}</div>
</div>
<div class="body">`;

const FOOTER = () => `
</div>
<div class="footer">
  <strong>Deemona AI Finance OS</strong> · Automated Financial Intelligence Platform<br>
  This is an automated report. Do not reply to this email. · © ${new Date().getFullYear()} Deemona Technologies
</div>
</div></body></html>`;

// ── 1. AR AGING REPORT ────────────────────────────────────────
export async function reportARaging(pool: Pool, tenantId: string): Promise<{subject:string,html:string}> {
  const [summary, aging, overdue, topCustomers] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as total_ar, COALESCE(SUM(CASE WHEN status NOT IN ('paid','cancelled') THEN total_amount ELSE 0 END),0) as outstanding, COALESCE(SUM(CASE WHEN due_date<CURRENT_DATE AND status NOT IN ('paid','cancelled') THEN total_amount ELSE 0 END),0) as overdue_amount, COUNT(CASE WHEN due_date<CURRENT_DATE AND status NOT IN ('paid','cancelled') THEN 1 END) as overdue_count, COUNT(*) as total FROM ar_invoices WHERE tenant_id=$1`,[tenantId]),
    pool.query(`SELECT COALESCE(SUM(CASE WHEN due_date>=CURRENT_DATE THEN total_amount ELSE 0 END),0) as current_bucket, COALESCE(SUM(CASE WHEN CURRENT_DATE-due_date BETWEEN 1 AND 30 THEN total_amount ELSE 0 END),0) as b30, COALESCE(SUM(CASE WHEN CURRENT_DATE-due_date BETWEEN 31 AND 60 THEN total_amount ELSE 0 END),0) as b60, COALESCE(SUM(CASE WHEN CURRENT_DATE-due_date BETWEEN 61 AND 90 THEN total_amount ELSE 0 END),0) as b90, COALESCE(SUM(CASE WHEN CURRENT_DATE-due_date>90 THEN total_amount ELSE 0 END),0) as b90p FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled')`,[tenantId]),
    pool.query(`SELECT ar.invoice_number, c.name as customer, ar.total_amount, ar.due_date, CURRENT_DATE-ar.due_date as days FROM ar_invoices ar LEFT JOIN customers c ON ar.customer_id=c.id WHERE ar.tenant_id=$1 AND ar.due_date<CURRENT_DATE AND ar.status NOT IN ('paid','cancelled') ORDER BY days DESC LIMIT 10`,[tenantId]),
    pool.query(`SELECT c.name, COALESCE(SUM(ar.total_amount),0) as total, COUNT(ar.id) as invoices FROM ar_invoices ar LEFT JOIN customers c ON ar.customer_id=c.id WHERE ar.tenant_id=$1 AND ar.status NOT IN ('paid','cancelled') GROUP BY c.name ORDER BY total DESC LIMIT 5`,[tenantId]),
  ]);
  const s=summary.rows[0]||{}, a=aging.rows[0]||{};
  const outstanding=parseFloat(s.outstanding||0)||1;
  const html = HEADER('AR Aging Report','Daily Accounts Receivable Intelligence','📊') + `
  <div class="kpi-grid kpi-grid-3">
    <div class="kpi bg-blue"><div class="kpi-label">Total AR</div><div class="kpi-value blue">${fmtC(s.total_ar)}</div></div>
    <div class="kpi bg-amber"><div class="kpi-label">Outstanding</div><div class="kpi-value amber">${fmtC(s.outstanding)}</div></div>
    <div class="kpi bg-red"><div class="kpi-label">Overdue</div><div class="kpi-value red">${fmtC(s.overdue_amount)}<br><span style="font-size:12px">${s.overdue_count||0} invoices</span></div></div>
  </div>
  <h2>AR Aging Buckets</h2>
  <table><tr><th>Bucket</th><th>Amount</th><th>% of Outstanding</th><th>Risk</th></tr>
  ${[['Current (Not Due)',a.current_bucket,'#16a34a','Low'],['1-30 Days',a.b30,'#d97706','Medium'],['31-60 Days',a.b60,'#f59e0b','High'],['61-90 Days',a.b90,'#dc2626','Critical'],['90+ Days',a.b90p,'#7f1d1d','Write-off Risk']].map(([l,v,c,r])=>`<tr><td>${l}</td><td style="color:${c};font-weight:700">${fmtC(v)}</td><td>${((parseFloat(String(v))/outstanding)*100).toFixed(1)}%</td><td><span class="tag" style="background:${c}18;color:${c}">${r}</span></td></tr>`).join('')}
  </table>
  <h2>Top Overdue Invoices</h2>
  ${overdue.rows.length===0?'<div class="alert alert-green">✓ No overdue invoices — excellent collection performance!</div>':
  `<table><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Due Date</th><th>Days Overdue</th></tr>
  ${overdue.rows.map(r=>`<tr><td style="font-family:monospace">${r.invoice_number}</td><td>${r.customer||'Unknown'}</td><td class="red" style="font-weight:700">${fmtC(r.total_amount)}</td><td>${fmtD(r.due_date)}</td><td><span class="tag" style="background:#fef2f2;color:#dc2626">${r.days} days</span></td></tr>`).join('')}</table>`}
  <h2>Top Customers by Outstanding AR</h2>
  <table><tr><th>Customer</th><th>Outstanding</th><th>Invoices</th></tr>
  ${topCustomers.rows.map(r=>`<tr><td>${r.name||'Unknown'}</td><td class="amber" style="font-weight:700">${fmtC(r.total)}</td><td>${r.invoices}</td></tr>`).join('')}
  </table>` + FOOTER();
  return { subject:`📊 AR Aging Report — ${new Date().toLocaleDateString('en-IN')} — Deemona Finance OS`, html };
}

// ── 2. CASH POSITION BRIEF ────────────────────────────────────
export async function reportCashPosition(pool: Pool, tenantId: string): Promise<{subject:string,html:string}> {
  const [ar, ap, exp] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(CASE WHEN status NOT IN ('paid','cancelled') THEN total_amount ELSE 0 END),0) as inflows_expected, COALESCE(SUM(CASE WHEN due_date<=CURRENT_DATE+7 AND status NOT IN ('paid','cancelled') THEN total_amount ELSE 0 END),0) as due_7d FROM ar_invoices WHERE tenant_id=$1`,[tenantId]),
    pool.query(`SELECT COALESCE(SUM(CASE WHEN status NOT IN ('paid','rejected') THEN total_amount ELSE 0 END),0) as outflows_expected, COALESCE(SUM(CASE WHEN due_date<=CURRENT_DATE+7 AND status NOT IN ('paid','rejected') THEN total_amount ELSE 0 END),0) as due_7d FROM ap_invoices WHERE tenant_id=$1`,[tenantId]),
    pool.query(`SELECT COALESCE(SUM(CASE WHEN status='submitted' THEN total_amount ELSE 0 END),0) as pending_exp FROM expense_claims WHERE tenant_id=$1`,[tenantId]),
  ]);
  const arIn=parseFloat(ar.rows[0]?.inflows_expected||0), apOut=parseFloat(ap.rows[0]?.outflows_expected||0);
  const netPosition=arIn-apOut;
  const html = HEADER('Cash Position Brief','Daily Treasury Intelligence','💰') + `
  <div class="kpi-grid kpi-grid-2">
    <div class="kpi bg-green"><div class="kpi-label">Expected Inflows (AR)</div><div class="kpi-value green">${fmtC(arIn)}</div><div class="kpi-sub">Due in 7 days: ${fmtC(ar.rows[0]?.due_7d)}</div></div>
    <div class="kpi bg-red"><div class="kpi-label">Expected Outflows (AP)</div><div class="kpi-value red">${fmtC(apOut)}</div><div class="kpi-sub">Due in 7 days: ${fmtC(ap.rows[0]?.due_7d)}</div></div>
  </div>
  <div class="kpi-grid kpi-grid-2">
    <div class="kpi ${netPosition>=0?'bg-green':'bg-red'}"><div class="kpi-label">Net Cash Position</div><div class="kpi-value ${netPosition>=0?'green':'red'}">${fmtC(netPosition)}</div><div class="kpi-sub">${netPosition>=0?'Positive cash flow':'Cash deficit warning'}</div></div>
    <div class="kpi bg-amber"><div class="kpi-label">Pending Expense Claims</div><div class="kpi-value amber">${fmtC(exp.rows[0]?.pending_exp)}</div><div class="kpi-sub">Awaiting approval</div></div>
  </div>
  ${netPosition<0?'<div class="alert alert-red">⚠️ Cash deficit detected. Accelerate collections or defer non-critical payments.</div>':'<div class="alert alert-green">✓ Positive cash position. Collections exceeding payables.</div>'}
  <h2>7-Day Cash Flow Outlook</h2>
  <table><tr><th>Category</th><th>Expected</th><th>Action Required</th></tr>
  <tr><td>AR Collections Due</td><td class="green">${fmtC(ar.rows[0]?.due_7d)}</td><td>Send payment reminders</td></tr>
  <tr><td>AP Payments Due</td><td class="red">${fmtC(ap.rows[0]?.due_7d)}</td><td>Prepare payment run</td></tr>
  <tr><td>Expense Reimbursements</td><td class="amber">${fmtC(exp.rows[0]?.pending_exp)}</td><td>Approve pending claims</td></tr>
  <tr><td style="font-weight:700">Net 7-Day Cash Flow</td><td style="font-weight:700" class="${parseFloat(ar.rows[0]?.due_7d||0)-parseFloat(ap.rows[0]?.due_7d||0)>=0?'green':'red'}">${fmtC(parseFloat(ar.rows[0]?.due_7d||0)-parseFloat(ap.rows[0]?.due_7d||0))}</td><td>—</td></tr>
  </table>` + FOOTER();
  return { subject:`💰 Cash Position Brief — ${new Date().toLocaleDateString('en-IN')} — Deemona Finance OS`, html };
}

// ── 3. COMPLIANCE ALERTS ──────────────────────────────────────
export async function reportComplianceAlerts(pool: Pool, tenantId: string): Promise<{subject:string,html:string}> {
  const [items, filings] = await Promise.all([
    pool.query(`SELECT title, due_date, status, category, due_date-CURRENT_DATE as days_left FROM compliance_items WHERE tenant_id=$1 AND status NOT IN ('Completed','Closed') AND due_date<=CURRENT_DATE+30 ORDER BY due_date ASC`,[tenantId]),
    pool.query(`SELECT filing_subtype, regulatory_body, filing_period, due_date, filing_status, due_date-CURRENT_DATE as days_left FROM regulatory_filings WHERE tenant_id=$1 AND filing_status='pending' AND due_date<=CURRENT_DATE+30 ORDER BY due_date ASC`,[tenantId]),
  ]);
  const overdue=items.rows.filter(r=>parseInt(r.days_left||0)<0);
  const urgent=items.rows.filter(r=>parseInt(r.days_left||0)>=0&&parseInt(r.days_left||0)<=7);
  const html = HEADER('Compliance Alerts','Daily Regulatory & Statutory Deadlines','🏛️') + `
  <div class="kpi-grid kpi-grid-3">
    <div class="kpi bg-red"><div class="kpi-label">Overdue</div><div class="kpi-value red">${overdue.length}</div><div class="kpi-sub">Immediate action needed</div></div>
    <div class="kpi bg-amber"><div class="kpi-label">Due in 7 Days</div><div class="kpi-value amber">${urgent.length}</div><div class="kpi-sub">Urgent attention</div></div>
    <div class="kpi bg-blue"><div class="kpi-label">Due in 30 Days</div><div class="kpi-value blue">${items.rows.length}</div><div class="kpi-sub">Plan ahead</div></div>
  </div>
  ${overdue.length>0?'<div class="alert alert-red">🚨 '+overdue.length+' compliance items are OVERDUE. Penalties may apply.</div>':''}
  <h2>Compliance Calendar</h2>
  <table><tr><th>Item</th><th>Category</th><th>Due Date</th><th>Days Left</th><th>Status</th></tr>
  ${items.rows.map(r=>{const d=parseInt(r.days_left||0);return`<tr><td>${r.title}</td><td>${r.category||'—'}</td><td>${fmtD(r.due_date)}</td><td><span class="tag" style="background:${d<0?'#fef2f2':d<=7?'#fffbeb':'#f0fdf4'};color:${d<0?'#dc2626':d<=7?'#d97706':'#16a34a'}">${d<0?Math.abs(d)+' overdue':d+'d left'}</span></td><td>${r.status}</td></tr>`;}).join('')||'<tr><td colspan="5" style="text-align:center;color:#16a34a">All compliant! No upcoming deadlines.</td></tr>'}
  </table>
  <h2>Regulatory Filings Due</h2>
  <table><tr><th>Filing</th><th>Authority</th><th>Period</th><th>Due Date</th><th>Days Left</th></tr>
  ${filings.rows.map(r=>{const d=parseInt(r.days_left||0);return`<tr><td style="font-weight:600">${r.filing_subtype}</td><td>${r.regulatory_body}</td><td>${r.filing_period||'—'}</td><td>${fmtD(r.due_date)}</td><td><span class="tag" style="background:${d<0?'#fef2f2':d<=7?'#fffbeb':'#f0fdf4'};color:${d<0?'#dc2626':d<=7?'#d97706':'#16a34a'}">${d<0?Math.abs(d)+' overdue':d+'d left'}</span></td></tr>`;}).join('')||'<tr><td colspan="5" style="text-align:center;color:#16a34a">No filings due in next 30 days.</td></tr>'}
  </table>` + FOOTER();
  return { subject:`🏛️ Compliance Alerts — ${new Date().toLocaleDateString('en-IN')} — Deemona Finance OS`, html };
}

// ── 4. WEEKLY P&L ─────────────────────────────────────────────
export async function reportWeeklyPL(pool: Pool, tenantId: string): Promise<{subject:string,html:string}> {
  const [arW, apW, expW, arM, apM, expM] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as v FROM ar_invoices WHERE tenant_id=$1 AND created_at>NOW()-INTERVAL '7 days'`,[tenantId]),
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as v FROM ap_invoices WHERE tenant_id=$1 AND created_at>NOW()-INTERVAL '7 days'`,[tenantId]),
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as v FROM expense_claims WHERE tenant_id=$1 AND created_at>NOW()-INTERVAL '7 days'`,[tenantId]),
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as v FROM ar_invoices WHERE tenant_id=$1 AND created_at>DATE_TRUNC('month',NOW())`,[tenantId]),
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as v FROM ap_invoices WHERE tenant_id=$1 AND created_at>DATE_TRUNC('month',NOW())`,[tenantId]),
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as v FROM expense_claims WHERE tenant_id=$1 AND created_at>DATE_TRUNC('month',NOW())`,[tenantId]),
  ]);
  const wRev=parseFloat(arW.rows[0]?.v||0), wExp=parseFloat(apW.rows[0]?.v||0)*0.3+parseFloat(expW.rows[0]?.v||0);
  const wGross=wRev-wExp*0.45, wNet=wGross-wExp*0.3;
  const mRev=parseFloat(arM.rows[0]?.v||0), mExp=parseFloat(apM.rows[0]?.v||0)*0.3+parseFloat(expM.rows[0]?.v||0);
  const mGross=mRev-mExp*0.45, mNet=mGross-mExp*0.3;
  const html = HEADER('Weekly P&L Report','Financial Performance Summary','📈') + `
  <div class="kpi-grid kpi-grid-4">
    <div class="kpi bg-green"><div class="kpi-label">Weekly Revenue</div><div class="kpi-value green">${fmtC(wRev)}</div></div>
    <div class="kpi bg-red"><div class="kpi-label">Weekly Expenses</div><div class="kpi-value red">${fmtC(wExp)}</div></div>
    <div class="kpi bg-blue"><div class="kpi-label">Gross Profit</div><div class="kpi-value blue">${fmtC(wGross)}</div><div class="kpi-sub">${wRev>0?((wGross/wRev)*100).toFixed(1):0}% margin</div></div>
    <div class="kpi ${wNet>=0?'bg-green':'bg-red'}"><div class="kpi-label">Net Profit</div><div class="kpi-value ${wNet>=0?'green':'red'}">${fmtC(wNet)}</div><div class="kpi-sub">${wRev>0?((wNet/wRev)*100).toFixed(1):0}% margin</div></div>
  </div>
  <h2>P&L Statement</h2>
  <table><tr><th>Line Item</th><th>This Week</th><th>This Month</th><th>Margin (Week)</th></tr>
  ${[['Revenue',wRev,mRev,100,'green'],['Cost of Goods',wExp*0.45,mExp*0.45,wRev>0?((wExp*0.45/wRev)*100).toFixed(1):0,'red'],['Gross Profit',wGross,mGross,wRev>0?((wGross/wRev)*100).toFixed(1):0,'blue'],['Operating Expenses',wExp*0.55,mExp*0.55,wRev>0?((wExp*0.55/wRev)*100).toFixed(1):0,'amber'],['EBITDA',wGross-wExp*0.4,mGross-mExp*0.4,wRev>0?(((wGross-wExp*0.4)/wRev)*100).toFixed(1):0,'purple'],['Net Profit',wNet,mNet,wRev>0?((wNet/wRev)*100).toFixed(1):0,wNet>=0?'green':'red']].map(([l,w,m,p,c])=>`<tr><td style="font-weight:${['Revenue','Gross Profit','Net Profit'].includes(String(l))?700:400}">${l}</td><td class="${c}" style="font-weight:700">${fmtC(w)}</td><td style="color:#64748b">${fmtC(m)}</td><td>${p}%</td></tr>`).join('')}
  </table>` + FOOTER();
  return { subject:`📈 Weekly P&L Report — Week ending ${new Date().toLocaleDateString('en-IN')} — Deemona Finance OS`, html };
}

// ── 5. COLLECTIONS SUMMARY ────────────────────────────────────
export async function reportCollections(pool: Pool, tenantId: string): Promise<{subject:string,html:string}> {
  const [summary, topOverdue, recent] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as total, COALESCE(SUM(CASE WHEN status='paid' THEN total_amount ELSE 0 END),0) as collected, COALESCE(SUM(CASE WHEN status NOT IN ('paid','cancelled') THEN total_amount ELSE 0 END),0) as outstanding, COALESCE(SUM(CASE WHEN due_date<CURRENT_DATE AND status NOT IN ('paid','cancelled') THEN total_amount ELSE 0 END),0) as overdue FROM ar_invoices WHERE tenant_id=$1`,[tenantId]),
    pool.query(`SELECT c.name, ar.invoice_number, ar.total_amount, CURRENT_DATE-ar.due_date as days FROM ar_invoices ar LEFT JOIN customers c ON ar.customer_id=c.id WHERE ar.tenant_id=$1 AND ar.due_date<CURRENT_DATE AND ar.status NOT IN ('paid','cancelled') ORDER BY ar.total_amount DESC LIMIT 8`,[tenantId]),
    pool.query(`SELECT c.name, COALESCE(SUM(ar.total_amount),0) as outstanding FROM ar_invoices ar LEFT JOIN customers c ON ar.customer_id=c.id WHERE ar.tenant_id=$1 AND ar.status NOT IN ('paid','cancelled') GROUP BY c.name ORDER BY outstanding DESC LIMIT 5`,[tenantId]),
  ]);
  const s=summary.rows[0]||{};
  const collRate=parseFloat(s.total||0)>0?((parseFloat(s.collected||0)/parseFloat(s.total||0))*100).toFixed(1):'0';
  const html = HEADER('Collections Summary','Weekly AR Collection Performance','💵') + `
  <div class="kpi-grid kpi-grid-4">
    <div class="kpi bg-blue"><div class="kpi-label">Total AR</div><div class="kpi-value blue">${fmtC(s.total)}</div></div>
    <div class="kpi bg-green"><div class="kpi-label">Collected</div><div class="kpi-value green">${fmtC(s.collected)}</div></div>
    <div class="kpi bg-amber"><div class="kpi-label">Outstanding</div><div class="kpi-value amber">${fmtC(s.outstanding)}</div></div>
    <div class="kpi bg-red"><div class="kpi-label">Overdue</div><div class="kpi-value red">${fmtC(s.overdue)}</div></div>
  </div>
  <div class="kpi bg-${parseFloat(collRate)>=85?'green':'amber'}" style="margin:12px 0">
    <div class="kpi-label">Collection Rate</div>
    <div class="kpi-value ${parseFloat(collRate)>=85?'green':'amber'}">${collRate}%</div>
    <div class="progress"><div class="progress-fill" style="width:${collRate}%;background:${parseFloat(collRate)>=85?'#16a34a':'#d97706'}"></div></div>
    <div class="kpi-sub">Target: 90% | ${parseFloat(collRate)>=85?'On track':'Below target — increase collection efforts'}</div>
  </div>
  <h2>Priority Collection List</h2>
  <table><tr><th>Customer</th><th>Invoice</th><th>Amount</th><th>Days Overdue</th><th>Action</th></tr>
  ${topOverdue.rows.map(r=>`<tr><td>${r.name||'Unknown'}</td><td style="font-family:monospace;font-size:11px">${r.invoice_number}</td><td class="red" style="font-weight:700">${fmtC(r.total_amount)}</td><td>${r.days} days</td><td>${r.days>60?'Escalate to management':r.days>30?'Send formal notice':'Send reminder'}</td></tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:#16a34a">No overdue invoices!</td></tr>'}
  </table>` + FOOTER();
  return { subject:`💵 Collections Summary — ${new Date().toLocaleDateString('en-IN')} — Deemona Finance OS`, html };
}

// ── 6. AP PAYMENT CALENDAR ────────────────────────────────────
export async function reportAPCalendar(pool: Pool, tenantId: string): Promise<{subject:string,html:string}> {
  const [summary, due7, due30, overdue] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(CASE WHEN status NOT IN ('paid','rejected') THEN total_amount ELSE 0 END),0) as outstanding, COUNT(CASE WHEN status NOT IN ('paid','rejected') THEN 1 END) as count FROM ap_invoices WHERE tenant_id=$1`,[tenantId]),
    pool.query(`SELECT ap.invoice_number, v.name as vendor, ap.total_amount, ap.due_date, ap.due_date-CURRENT_DATE as days_left FROM ap_invoices ap LEFT JOIN vendors v ON ap.vendor_id=v.id WHERE ap.tenant_id=$1 AND ap.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE+7 AND ap.status NOT IN ('paid','rejected') ORDER BY ap.due_date ASC`,[tenantId]),
    pool.query(`SELECT ap.invoice_number, v.name as vendor, ap.total_amount, ap.due_date, ap.due_date-CURRENT_DATE as days_left FROM ap_invoices ap LEFT JOIN vendors v ON ap.vendor_id=v.id WHERE ap.tenant_id=$1 AND ap.due_date BETWEEN CURRENT_DATE+8 AND CURRENT_DATE+30 AND ap.status NOT IN ('paid','rejected') ORDER BY ap.due_date ASC`,[tenantId]),
    pool.query(`SELECT ap.invoice_number, v.name as vendor, ap.total_amount, ap.due_date, CURRENT_DATE-ap.due_date as days_overdue FROM ap_invoices ap LEFT JOIN vendors v ON ap.vendor_id=v.id WHERE ap.tenant_id=$1 AND ap.due_date<CURRENT_DATE AND ap.status NOT IN ('paid','rejected') ORDER BY days_overdue DESC LIMIT 5`,[tenantId]),
  ]);
  const html = HEADER('AP Payment Calendar','Weekly Payables & Vendor Payment Schedule','📅') + `
  <div class="kpi-grid kpi-grid-3">
    <div class="kpi bg-purple"><div class="kpi-label">Total Outstanding AP</div><div class="kpi-value" style="color:#7c3aed">${fmtC(summary.rows[0]?.outstanding)}</div><div class="kpi-sub">${summary.rows[0]?.count||0} bills</div></div>
    <div class="kpi bg-red"><div class="kpi-label">Due This Week</div><div class="kpi-value red">${fmtC(due7.rows.reduce((s:number,r:any)=>s+parseFloat(r.total_amount||0),0))}</div><div class="kpi-sub">${due7.rows.length} payments</div></div>
    <div class="kpi bg-amber"><div class="kpi-label">Due This Month</div><div class="kpi-value amber">${fmtC(due30.rows.reduce((s:number,r:any)=>s+parseFloat(r.total_amount||0),0))}</div><div class="kpi-sub">${due30.rows.length} payments</div></div>
  </div>
  ${overdue.rows.length>0?'<div class="alert alert-red">⚠️ '+overdue.rows.length+' overdue bills — late payment charges may apply!</div>':''}
  <h2>Payments Due This Week</h2>
  <table><tr><th>Vendor</th><th>Invoice</th><th>Amount</th><th>Due Date</th><th>Days Left</th></tr>
  ${due7.rows.map(r=>`<tr><td>${r.vendor||'Unknown'}</td><td style="font-family:monospace;font-size:11px">${r.invoice_number}</td><td class="red" style="font-weight:700">${fmtC(r.total_amount)}</td><td>${fmtD(r.due_date)}</td><td><span class="tag" style="background:#fef2f2;color:#dc2626">${r.days_left}d</span></td></tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:#16a34a">No payments due this week.</td></tr>'}
  </table>
  <h2>Payments Due Next 8-30 Days</h2>
  <table><tr><th>Vendor</th><th>Invoice</th><th>Amount</th><th>Due Date</th><th>Days Left</th></tr>
  ${due30.rows.map(r=>`<tr><td>${r.vendor||'Unknown'}</td><td style="font-family:monospace;font-size:11px">${r.invoice_number}</td><td class="amber" style="font-weight:700">${fmtC(r.total_amount)}</td><td>${fmtD(r.due_date)}</td><td><span class="tag" style="background:#fffbeb;color:#d97706">${r.days_left}d</span></td></tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:#64748b">No payments due in next 30 days.</td></tr>'}
  </table>` + FOOTER();
  return { subject:`📅 AP Payment Calendar — Week of ${new Date().toLocaleDateString('en-IN')} — Deemona Finance OS`, html };
}

// ── 7. MONTHLY FINANCIAL SUMMARY ─────────────────────────────
export async function reportMonthlyFinancial(pool: Pool, tenantId: string): Promise<{subject:string,html:string}> {
  const month = new Date().toLocaleString('en-IN',{month:'long',year:'numeric'});
  const [ar, ap, exp, inv, emp, comp] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as total, COALESCE(SUM(CASE WHEN status='paid' THEN total_amount ELSE 0 END),0) as paid, COALESCE(SUM(CASE WHEN status NOT IN ('paid','cancelled') THEN total_amount ELSE 0 END),0) as outstanding FROM ar_invoices WHERE tenant_id=$1 AND created_at>DATE_TRUNC('month',NOW())`,[tenantId]),
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as total, COALESCE(SUM(CASE WHEN status='paid' THEN total_amount ELSE 0 END),0) as paid FROM ap_invoices WHERE tenant_id=$1 AND created_at>DATE_TRUNC('month',NOW())`,[tenantId]),
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as total, COUNT(*) as count FROM expense_claims WHERE tenant_id=$1 AND created_at>DATE_TRUNC('month',NOW())`,[tenantId]),
    pool.query(`SELECT COUNT(*) as items, COALESCE(SUM(quantity*unit_cost),0) as value, COUNT(CASE WHEN quantity<=reorder_level THEN 1 END) as alerts FROM inventory_items WHERE tenant_id=$1`,[tenantId]),
    pool.query(`SELECT COUNT(*) as total, COALESCE(SUM(salary),0) as payroll FROM employees WHERE tenant_id=$1 AND status='active'`,[tenantId]),
    pool.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN status NOT IN ('Completed','Closed') AND due_date<CURRENT_DATE THEN 1 END) as overdue FROM compliance_items WHERE tenant_id=$1`,[tenantId]),
  ]);
  const rev=parseFloat(ar.rows[0]?.total||0), apTotal=parseFloat(ap.rows[0]?.total||0)*0.3+parseFloat(exp.rows[0]?.total||0);
  const gross=rev-apTotal*0.45, net=gross-apTotal*0.3;
  const html = HEADER(`Monthly Financial Summary — ${month}`,'Comprehensive Monthly Performance Report','📊') + `
  <div class="kpi-grid kpi-grid-4">
    <div class="kpi bg-green"><div class="kpi-label">Revenue</div><div class="kpi-value green">${fmtC(rev)}</div></div>
    <div class="kpi bg-blue"><div class="kpi-label">Gross Profit</div><div class="kpi-value blue">${fmtC(gross)}</div><div class="kpi-sub">${rev>0?((gross/rev)*100).toFixed(1):0}% margin</div></div>
    <div class="kpi ${net>=0?'bg-green':'bg-red'}"><div class="kpi-label">Net Profit</div><div class="kpi-value ${net>=0?'green':'red'}">${fmtC(net)}</div><div class="kpi-sub">${rev>0?((net/rev)*100).toFixed(1):0}% margin</div></div>
    <div class="kpi bg-amber"><div class="kpi-label">AR Outstanding</div><div class="kpi-value amber">${fmtC(ar.rows[0]?.outstanding)}</div></div>
  </div>
  <h2>Income Statement</h2>
  <table><tr><th>Line Item</th><th>This Month</th><th>% of Revenue</th></tr>
  ${[['Revenue',rev,100],['COGS (est.)',apTotal*0.45,rev>0?((apTotal*0.45/rev)*100).toFixed(1):0],['Gross Profit',gross,rev>0?((gross/rev)*100).toFixed(1):0],['Operating Expenses',apTotal*0.55,rev>0?((apTotal*0.55/rev)*100).toFixed(1):0],['EBITDA',gross-apTotal*0.4,rev>0?(((gross-apTotal*0.4)/rev)*100).toFixed(1):0],['Net Profit',net,rev>0?((net/rev)*100).toFixed(1):0]].map(([l,v,p])=>`<tr><td style="font-weight:${['Revenue','Gross Profit','Net Profit'].includes(String(l))?700:400}">${l}</td><td style="font-weight:700;color:${parseFloat(String(v))>=0?'#16a34a':'#dc2626'}">${fmtC(v)}</td><td>${p}%</td></tr>`).join('')}
  </table>
  <h2>Business Metrics</h2>
  <table><tr><th>Metric</th><th>Value</th></tr>
  <tr><td>Total Employees</td><td>${emp.rows[0]?.total||0}</td></tr>
  <tr><td>Monthly Payroll</td><td>${fmtC(emp.rows[0]?.payroll)}</td></tr>
  <tr><td>Inventory Value</td><td>${fmtC(inv.rows[0]?.value)}</td></tr>
  <tr><td>Inventory Reorder Alerts</td><td class="${parseInt(inv.rows[0]?.alerts||0)>0?'red':'green'}">${inv.rows[0]?.alerts||0}</td></tr>
  <tr><td>Compliance Items Overdue</td><td class="${parseInt(comp.rows[0]?.overdue||0)>0?'red':'green'}">${comp.rows[0]?.overdue||0}</td></tr>
  <tr><td>Expense Claims (Month)</td><td>${exp.rows[0]?.count||0} claims — ${fmtC(exp.rows[0]?.total)}</td></tr>
  </table>` + FOOTER();
  return { subject:`📊 Monthly Financial Summary — ${month} — Deemona Finance OS`, html };
}

// ── 8. BUDGET VS ACTUAL ───────────────────────────────────────
export async function reportBudgetVsActual(pool: Pool, tenantId: string): Promise<{subject:string,html:string}> {
  const [budgets, totalAR, totalExp] = await Promise.all([
    pool.query(`SELECT b.name, b.amount as budgeted, COALESCE(SUM(bt.amount),0) as spent FROM budgets b LEFT JOIN budget_transactions bt ON bt.budget_id=b.id WHERE b.tenant_id=$1 GROUP BY b.id,b.name,b.amount ORDER BY b.amount DESC`,[tenantId]),
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as v FROM ar_invoices WHERE tenant_id=$1`,[tenantId]),
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as v FROM expense_claims WHERE tenant_id=$1`,[tenantId]),
  ]);
  const totalBudget=budgets.rows.reduce((s:number,r:any)=>s+parseFloat(r.budgeted||0),0);
  const totalSpent=budgets.rows.reduce((s:number,r:any)=>s+parseFloat(r.spent||0),0);
  const variance=totalBudget-totalSpent;
  const html = HEADER('Budget vs Actual Report','Monthly Budget Performance Analysis','📈') + `
  <div class="kpi-grid kpi-grid-3">
    <div class="kpi bg-blue"><div class="kpi-label">Total Budget</div><div class="kpi-value blue">${fmtC(totalBudget)}</div></div>
    <div class="kpi bg-${totalSpent<=totalBudget?'green':'red'}"><div class="kpi-label">Actual Spent</div><div class="kpi-value ${totalSpent<=totalBudget?'green':'red'}">${fmtC(totalSpent)}</div><div class="kpi-sub">${totalBudget>0?((totalSpent/totalBudget)*100).toFixed(1):0}% utilized</div></div>
    <div class="kpi bg-${variance>=0?'green':'red'}"><div class="kpi-label">Variance</div><div class="kpi-value ${variance>=0?'green':'red'}">${variance>=0?'+':''}${fmtC(variance)}</div><div class="kpi-sub">${variance>=0?'Under budget':'Over budget'}</div></div>
  </div>
  <h2>Budget Utilization by Department</h2>
  <table><tr><th>Department</th><th>Budget</th><th>Actual</th><th>Variance</th><th>% Used</th><th>Status</th></tr>
  ${budgets.rows.length===0?'<tr><td colspan="6" style="text-align:center;color:#64748b">No budget data. Create budgets in the Budgeting module.</td></tr>':
  budgets.rows.map((r:any)=>{const pct=parseFloat(r.budgeted)>0?((parseFloat(r.spent)/parseFloat(r.budgeted))*100).toFixed(1):0;const over=parseFloat(r.spent)>parseFloat(r.budgeted);return`<tr><td style="font-weight:500">${r.name}</td><td>${fmtC(r.budgeted)}</td><td style="color:${over?'#dc2626':'#16a34a'};font-weight:700">${fmtC(r.spent)}</td><td style="color:${over?'#dc2626':'#16a34a'};font-weight:700">${over?'-':'+'}${fmtC(Math.abs(parseFloat(r.budgeted)-parseFloat(r.spent)))}</td><td>${pct}%</td><td><span class="tag" style="background:${over?'#fef2f2':'#f0fdf4'};color:${over?'#dc2626':'#16a34a'}">${over?'Over Budget':'On Track'}</span></td></tr>`;}).join('')}
  </table>` + FOOTER();
  return { subject:`📈 Budget vs Actual — ${new Date().toLocaleDateString('en-IN',{month:'long',year:'numeric'})} — Deemona Finance OS`, html };
}

// ── 9. GST/TAX SUMMARY ────────────────────────────────────────
export async function reportGSTSummary(pool: Pool, tenantId: string): Promise<{subject:string,html:string}> {
  const [ar, ap, filings] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as revenue, COALESCE(SUM(tax_amount),0) as output_gst FROM ar_invoices WHERE tenant_id=$1 AND created_at>DATE_TRUNC('month',NOW())`,[tenantId]),
    pool.query(`SELECT COALESCE(SUM(total_amount),0) as purchases, COALESCE(SUM(tax_amount),0) as input_gst FROM ap_invoices WHERE tenant_id=$1 AND created_at>DATE_TRUNC('month',NOW())`,[tenantId]),
    pool.query(`SELECT filing_subtype, regulatory_body, filing_period, due_date, filing_status, due_date-CURRENT_DATE as days_left FROM regulatory_filings WHERE tenant_id=$1 AND filing_type IN ('gst_return','tds_return','income_tax') ORDER BY due_date ASC LIMIT 8`,[tenantId]),
  ]);
  const outGST=parseFloat(ar.rows[0]?.output_gst||0), inGST=parseFloat(ap.rows[0]?.input_gst||0), netGST=outGST-inGST;
  const html = HEADER('GST & Tax Summary','Monthly Tax Intelligence Report','🏛️') + `
  <div class="kpi-grid kpi-grid-4">
    <div class="kpi bg-red"><div class="kpi-label">GST Output (Sales)</div><div class="kpi-value red">${fmtC(outGST)}</div></div>
    <div class="kpi bg-green"><div class="kpi-label">GST Input Credit</div><div class="kpi-value green">${fmtC(inGST)}</div></div>
    <div class="kpi bg-${netGST>0?'amber':'green'}"><div class="kpi-label">Net GST Payable</div><div class="kpi-value ${netGST>0?'amber':'green'}">${fmtC(netGST)}</div></div>
    <div class="kpi bg-blue"><div class="kpi-label">ITC Utilization</div><div class="kpi-value blue">${outGST>0?((inGST/outGST)*100).toFixed(1):0}%</div></div>
  </div>
  <h2>Tax Filing Calendar</h2>
  <table><tr><th>Filing</th><th>Authority</th><th>Period</th><th>Due Date</th><th>Status</th><th>Days Left</th></tr>
  ${filings.rows.map(r=>{const d=parseInt(r.days_left||0);return`<tr><td style="font-weight:600">${r.filing_subtype}</td><td>${r.regulatory_body}</td><td>${r.filing_period||'—'}</td><td>${fmtD(r.due_date)}</td><td><span class="tag" style="background:${r.filing_status==='filed'?'#f0fdf4':d<0?'#fef2f2':'#fffbeb'};color:${r.filing_status==='filed'?'#16a34a':d<0?'#dc2626':'#d97706'}">${r.filing_status}</span></td><td><span class="tag" style="background:${d<0?'#fef2f2':d<=7?'#fffbeb':'#f0fdf4'};color:${d<0?'#dc2626':d<=7?'#d97706':'#16a34a'}">${d<0?Math.abs(d)+' overdue':d+'d left'}</span></td></tr>`;}).join('')||'<tr><td colspan="6" style="text-align:center;color:#64748b">No tax filings configured. Add via Governance Docs.</td></tr>'}
  </table>` + FOOTER();
  return { subject:`🏛️ GST & Tax Summary — ${new Date().toLocaleString('en-IN',{month:'long',year:'numeric'})} — Deemona Finance OS`, html };
}

// ── 10. INVENTORY & STOCK REPORT ─────────────────────────────
export async function reportInventory(pool: Pool, tenantId: string): Promise<{subject:string,html:string}> {
  const [summary, reorder, categories] = await Promise.all([
    pool.query(`SELECT COUNT(*) as items, COALESCE(SUM(quantity*unit_cost),0) as total_value, COALESCE(AVG(unit_cost),0) as avg_cost, COUNT(CASE WHEN quantity<=reorder_level THEN 1 END) as reorder_alerts, COUNT(CASE WHEN quantity=0 THEN 1 END) as out_of_stock FROM inventory_items WHERE tenant_id=$1`,[tenantId]),
    pool.query(`SELECT name, sku, quantity, reorder_level, unit_cost, quantity*unit_cost as value FROM inventory_items WHERE tenant_id=$1 AND quantity<=reorder_level ORDER BY quantity ASC LIMIT 10`,[tenantId]),
    pool.query(`SELECT category, COUNT(*) as items, COALESCE(SUM(quantity*unit_cost),0) as value FROM inventory_items WHERE tenant_id=$1 GROUP BY category ORDER BY value DESC`,[tenantId]),
  ]);
  const s=summary.rows[0]||{};
  const html = HEADER('Inventory & Stock Report','Monthly Inventory Intelligence','📦') + `
  <div class="kpi-grid kpi-grid-4">
    <div class="kpi bg-blue"><div class="kpi-label">Total Items</div><div class="kpi-value blue">${s.items||0}</div></div>
    <div class="kpi bg-green"><div class="kpi-label">Total Stock Value</div><div class="kpi-value green">${fmtC(s.total_value)}</div></div>
    <div class="kpi bg-${parseInt(s.reorder_alerts||0)>0?'red':'green'}"><div class="kpi-label">Reorder Alerts</div><div class="kpi-value ${parseInt(s.reorder_alerts||0)>0?'red':'green'}">${s.reorder_alerts||0}</div></div>
    <div class="kpi bg-${parseInt(s.out_of_stock||0)>0?'red':'green'}"><div class="kpi-label">Out of Stock</div><div class="kpi-value ${parseInt(s.out_of_stock||0)>0?'red':'green'}">${s.out_of_stock||0}</div></div>
  </div>
  ${parseInt(s.reorder_alerts||0)>0?`<div class="alert alert-red">⚠️ ${s.reorder_alerts} items need reordering immediately!</div>`:'<div class="alert alert-green">✓ All stock levels healthy.</div>'}
  <h2>Items Requiring Reorder</h2>
  <table><tr><th>Item</th><th>SKU</th><th>Current Qty</th><th>Reorder Level</th><th>Value</th></tr>
  ${reorder.rows.map(r=>`<tr><td>${r.name}</td><td style="font-family:monospace;font-size:11px">${r.sku}</td><td class="red" style="font-weight:700">${r.quantity}</td><td>${r.reorder_level}</td><td>${fmtC(r.value)}</td></tr>`).join('')||'<tr><td colspan="5" style="text-align:center;color:#16a34a">All items above reorder level.</td></tr>'}
  </table>
  <h2>Stock by Category</h2>
  <table><tr><th>Category</th><th>Items</th><th>Total Value</th></tr>
  ${categories.rows.map(r=>`<tr><td style="text-transform:capitalize">${r.category||'Uncategorized'}</td><td>${r.items}</td><td class="blue" style="font-weight:700">${fmtC(r.value)}</td></tr>`).join('')||'<tr><td colspan="3" style="text-align:center;color:#64748b">No inventory data.</td></tr>'}
  </table>` + FOOTER();
  return { subject:`📦 Inventory & Stock Report — ${new Date().toLocaleDateString('en-IN',{month:'long',year:'numeric'})} — Deemona Finance OS`, html };
}

// ── 11. OVERDUE INVOICE ALERT ─────────────────────────────────
export async function reportOverdueAlert(pool: Pool, tenantId: string, invoiceId?: string): Promise<{subject:string,html:string}> {
  const query = invoiceId
    ? `SELECT ar.invoice_number, c.name as customer, ar.total_amount, ar.due_date, CURRENT_DATE-ar.due_date as days FROM ar_invoices ar LEFT JOIN customers c ON ar.customer_id=c.id WHERE ar.id=$2 AND ar.tenant_id=$1`
    : `SELECT ar.invoice_number, c.name as customer, ar.total_amount, ar.due_date, CURRENT_DATE-ar.due_date as days FROM ar_invoices ar LEFT JOIN customers c ON ar.customer_id=c.id WHERE ar.tenant_id=$1 AND ar.due_date<CURRENT_DATE AND ar.status NOT IN ('paid','cancelled') ORDER BY days DESC`;
  const rows = await pool.query(query, invoiceId ? [tenantId, invoiceId] : [tenantId]).catch(()=>({rows:[]}));
  const totalOverdue = rows.rows.reduce((s:number,r:any)=>s+parseFloat(r.total_amount||0),0);
  const html = HEADER('Overdue Invoice Alert','Immediate Action Required','⚠️') + `
  <div class="alert alert-red" style="font-size:13px;font-weight:700">⚠️ ${rows.rows.length} invoice${rows.rows.length!==1?'s':''} overdue totaling ${fmtC(totalOverdue)}</div>
  <div class="kpi-grid kpi-grid-2" style="margin-top:12px">
    <div class="kpi bg-red"><div class="kpi-label">Overdue Invoices</div><div class="kpi-value red">${rows.rows.length}</div></div>
    <div class="kpi bg-red"><div class="kpi-label">Total Overdue Amount</div><div class="kpi-value red">${fmtC(totalOverdue)}</div></div>
  </div>
  <h2>Overdue Invoice Details</h2>
  <table><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Due Date</th><th>Days Overdue</th><th>Action</th></tr>
  ${rows.rows.map((r:any)=>`<tr><td style="font-family:monospace">${r.invoice_number}</td><td>${r.customer||'Unknown'}</td><td class="red" style="font-weight:700">${fmtC(r.total_amount)}</td><td>${fmtD(r.due_date)}</td><td><span class="tag" style="background:#fef2f2;color:#dc2626">${r.days} days</span></td><td>${parseInt(r.days)>90?'Legal action':'Send reminder'}</td></tr>`).join('')}
  </table>` + FOOTER();
  return { subject:`⚠️ URGENT: ${rows.rows.length} Overdue Invoice${rows.rows.length!==1?'s':''} — ${fmtC(totalOverdue)} — Deemona Finance OS`, html };
}

// ── 12. CREDIT LIMIT BREACH ───────────────────────────────────
export async function reportCreditBreach(pool: Pool, tenantId: string): Promise<{subject:string,html:string}> {
  const breaches = await pool.query(`SELECT c.name, c.credit_limit, COALESCE(SUM(ar.total_amount),0) as outstanding, COALESCE(SUM(ar.total_amount),0)-c.credit_limit as excess FROM customers c LEFT JOIN ar_invoices ar ON ar.customer_id=c.id AND ar.status NOT IN ('paid','cancelled') AND ar.tenant_id=$1 WHERE c.tenant_id=$1 AND c.credit_limit>0 GROUP BY c.id,c.name,c.credit_limit HAVING COALESCE(SUM(ar.total_amount),0)>c.credit_limit ORDER BY excess DESC`,[tenantId]).catch(()=>({rows:[]}));
  const html = HEADER('Credit Limit Breach Alert','Customer Credit Exposure Warning','🚨') + `
  <div class="alert alert-red" style="font-size:13px;font-weight:700">🚨 ${breaches.rows.length} customer${breaches.rows.length!==1?'s':''} have exceeded their credit limits</div>
  <h2>Credit Limit Breaches</h2>
  <table><tr><th>Customer</th><th>Credit Limit</th><th>Outstanding AR</th><th>Excess Amount</th><th>Utilization</th></tr>
  ${breaches.rows.length===0?'<tr><td colspan="5" style="text-align:center;color:#16a34a">No credit limit breaches.</td></tr>':
  breaches.rows.map((r:any)=>`<tr><td style="font-weight:700">${r.name}</td><td>${fmtC(r.credit_limit)}</td><td class="red" style="font-weight:700">${fmtC(r.outstanding)}</td><td class="red" style="font-weight:700">${fmtC(r.excess)}</td><td><span class="tag" style="background:#fef2f2;color:#dc2626">${parseFloat(r.credit_limit)>0?((parseFloat(r.outstanding)/parseFloat(r.credit_limit))*100).toFixed(0):0}%</span></td></tr>`).join('')}
  </table>` + FOOTER();
  return { subject:`🚨 Credit Limit Breach: ${breaches.rows.length} Customer${breaches.rows.length!==1?'s':''} — Deemona Finance OS`, html };
}

// ── 13. LARGE TRANSACTION ALERT ───────────────────────────────
export async function reportLargeTransaction(pool: Pool, tenantId: string, threshold: number = 100000): Promise<{subject:string,html:string}> {
  const [largeAR, largeAP] = await Promise.all([
    pool.query(`SELECT ar.invoice_number, c.name as customer, ar.total_amount, ar.created_at FROM ar_invoices ar LEFT JOIN customers c ON ar.customer_id=c.id WHERE ar.tenant_id=$1 AND ar.total_amount>=$2 AND ar.created_at>NOW()-INTERVAL '24 hours' ORDER BY ar.total_amount DESC`,[tenantId, threshold]),
    pool.query(`SELECT ap.invoice_number, v.name as vendor, ap.total_amount, ap.created_at FROM ap_invoices ap LEFT JOIN vendors v ON ap.vendor_id=v.id WHERE ap.tenant_id=$1 AND ap.total_amount>=$2 AND ap.created_at>NOW()-INTERVAL '24 hours' ORDER BY ap.total_amount DESC`,[tenantId, threshold]),
  ]);
  const html = HEADER('Large Transaction Alert','High-Value Transaction Notification','💰') + `
  <div class="alert alert-amber">Transactions above ${fmtC(threshold)} in the last 24 hours</div>
  <h2>Large AR Invoices (Last 24 Hours)</h2>
  <table><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Time</th></tr>
  ${largeAR.rows.length===0?'<tr><td colspan="4" style="text-align:center;color:#64748b">No large AR transactions.</td></tr>':
  largeAR.rows.map((r:any)=>`<tr><td style="font-family:monospace">${r.invoice_number}</td><td>${r.customer}</td><td class="green" style="font-weight:700">${fmtC(r.total_amount)}</td><td>${new Date(r.created_at).toLocaleString('en-IN')}</td></tr>`).join('')}
  </table>
  <h2>Large AP Bills (Last 24 Hours)</h2>
  <table><tr><th>Invoice</th><th>Vendor</th><th>Amount</th><th>Time</th></tr>
  ${largeAP.rows.length===0?'<tr><td colspan="4" style="text-align:center;color:#64748b">No large AP transactions.</td></tr>':
  largeAP.rows.map((r:any)=>`<tr><td style="font-family:monospace">${r.invoice_number}</td><td>${r.vendor}</td><td class="red" style="font-weight:700">${fmtC(r.total_amount)}</td><td>${new Date(r.created_at).toLocaleString('en-IN')}</td></tr>`).join('')}
  </table>` + FOOTER();
  return { subject:`💰 Large Transaction Alert — ${largeAR.rows.length+largeAP.rows.length} transaction(s) above ${fmtC(threshold)} — Deemona Finance OS`, html };
}

// ── 14. IMPORT SUCCESS SUMMARY ────────────────────────────────
export async function reportImportSummary(pool: Pool, tenantId: string, importDetails: {dataType:string,inserted:number,errors:number}): Promise<{subject:string,html:string}> {
  const history = await pool.query(`SELECT automation_type, status, detail, created_at FROM automation_logs WHERE tenant_id=$1 AND automation_type='DATA_INGESTION' ORDER BY created_at DESC LIMIT 5`,[tenantId]).catch(()=>({rows:[]}));
  const html = HEADER('Data Import Summary','Automated Import Confirmation & Summary','⬆️') + `
  <div class="alert alert-${importDetails.errors===0?'green':'amber'}">
    ${importDetails.errors===0?'✅':'⚠️'} Import completed: <strong>${importDetails.inserted} records</strong> of type <strong>${importDetails.dataType}</strong> processed successfully${importDetails.errors>0?` with ${importDetails.errors} errors`:''}
  </div>
  <div class="kpi-grid kpi-grid-3">
    <div class="kpi bg-blue"><div class="kpi-label">Data Type</div><div class="kpi-value" style="font-size:14px;color:#1d4ed8">${importDetails.dataType.replace(/_/g,' ')}</div></div>
    <div class="kpi bg-green"><div class="kpi-label">Records Inserted</div><div class="kpi-value green">${importDetails.inserted}</div></div>
    <div class="kpi bg-${importDetails.errors===0?'green':'red'}"><div class="kpi-label">Errors</div><div class="kpi-value ${importDetails.errors===0?'green':'red'}">${importDetails.errors}</div></div>
  </div>
  <h2>Recent Import History</h2>
  <table><tr><th>Time</th><th>Type</th><th>Status</th><th>Details</th></tr>
  ${history.rows.map((r:any)=>`<tr><td>${new Date(r.created_at).toLocaleString('en-IN')}</td><td>${r.automation_type}</td><td><span class="tag" style="background:${r.status==='success'?'#f0fdf4':'#fef2f2'};color:${r.status==='success'?'#16a34a':'#dc2626'}">${r.status}</span></td><td style="font-size:11px;color:#64748b">${r.detail}</td></tr>`).join('')||'<tr><td colspan="4" style="text-align:center;color:#64748b">No import history.</td></tr>'}
  </table>` + FOOTER();
  return { subject:`✅ Import Complete: ${importDetails.inserted} ${importDetails.dataType} records — Deemona Finance OS`, html };
}

// ── Report Registry ───────────────────────────────────────────
export const REPORT_REGISTRY: Record<string, {
  fn: (pool:Pool,tenantId:string,...args:any[])=>Promise<{subject:string,html:string}>,
  label: string, icon: string, category: string, defaultFreq: string, defaultTime: string
}> = {
  ar_aging:           { fn: reportARaging,          label: 'AR Aging Report',           icon: '📊', category: 'daily',   defaultFreq: 'daily',   defaultTime: '08:00' },
  cash_position:      { fn: reportCashPosition,      label: 'Cash Position Brief',        icon: '💰', category: 'daily',   defaultFreq: 'daily',   defaultTime: '07:30' },
  compliance_alerts:  { fn: reportComplianceAlerts,  label: 'Compliance Alerts',          icon: '🏛️', category: 'daily',   defaultFreq: 'daily',   defaultTime: '08:30' },
  weekly_pl:          { fn: reportWeeklyPL,          label: 'Weekly P&L Report',          icon: '📈', category: 'weekly',  defaultFreq: 'weekly',  defaultTime: '09:00' },
  collections:        { fn: reportCollections,       label: 'Collections Summary',        icon: '💵', category: 'weekly',  defaultFreq: 'weekly',  defaultTime: '09:00' },
  ap_calendar:        { fn: reportAPCalendar,        label: 'AP Payment Calendar',        icon: '📅', category: 'weekly',  defaultFreq: 'weekly',  defaultTime: '08:00' },
  monthly_financial:  { fn: reportMonthlyFinancial,  label: 'Monthly Financial Summary',  icon: '📊', category: 'monthly', defaultFreq: 'monthly', defaultTime: '08:00' },
  budget_vs_actual:   { fn: reportBudgetVsActual,    label: 'Budget vs Actual',           icon: '📈', category: 'monthly', defaultFreq: 'monthly', defaultTime: '08:00' },
  gst_summary:        { fn: reportGSTSummary,        label: 'GST & Tax Summary',          icon: '🏛️', category: 'monthly', defaultFreq: 'monthly', defaultTime: '08:00' },
  inventory:          { fn: reportInventory,         label: 'Inventory & Stock Report',   icon: '📦', category: 'monthly', defaultFreq: 'monthly', defaultTime: '08:00' },
  overdue_alert:      { fn: reportOverdueAlert,      label: 'Overdue Invoice Alert',      icon: '⚠️', category: 'event',   defaultFreq: 'event',   defaultTime: 'on_event' },
  credit_breach:      { fn: reportCreditBreach,      label: 'Credit Limit Breach Alert',  icon: '🚨', category: 'event',   defaultFreq: 'event',   defaultTime: 'on_event' },
  large_transaction:  { fn: reportLargeTransaction,  label: 'Large Transaction Alert',    icon: '💰', category: 'event',   defaultFreq: 'event',   defaultTime: 'on_event' },
  import_summary:     { fn: reportImportSummary,     label: 'Import Success Summary',     icon: '⬆️', category: 'event',   defaultFreq: 'event',   defaultTime: 'on_event' },
};
