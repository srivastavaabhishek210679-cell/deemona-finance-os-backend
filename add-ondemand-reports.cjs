const fs = require('fs');

const route = `
// ── On-Demand Report Triggers ─────────────────────────────────
// Trigger any scheduled report immediately with live data

router.post('/reports/trigger', requireAuth, async (req: Request, res: Response) => {
  try {
    const { report_id } = req.body;
    const tenantId = tid(req);
    const user = await pool.query('SELECT email, first_name FROM users WHERE tenant_id=$1 LIMIT 1', [tenantId]).catch(()=>({rows:[{}]}));
    const email = user.rows[0]?.email;
    if (!email) return res.status(400).json({ error: 'No email found for tenant' }) as any;

    const { Resend } = await import('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const now = new Date();
    const fmt = (n:any) => { const v=parseFloat(n||0); if(v>=10000000) return '₹'+(v/10000000).toFixed(2)+'Cr'; if(v>=100000) return '₹'+(v/100000).toFixed(2)+'L'; return '₹'+v.toFixed(2); };

    let subject = '';
    let html = '';

    // Fetch live data based on report type
    const snap = await Promise.all([
      pool.query(\`SELECT COALESCE(SUM(total_amount),0) as revenue, COALESCE(SUM(outstanding_amount),0) as outstanding, COUNT(*) as count FROM ar_invoices WHERE tenant_id=$1\`, [tenantId]).catch(()=>({rows:[{revenue:0,outstanding:0,count:0}]})),
      pool.query(\`SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM expenses WHERE tenant_id=$1 AND expense_date >= NOW()-INTERVAL '30 days'\`, [tenantId]).catch(()=>({rows:[{total:0,count:0}]})),
      pool.query(\`SELECT COALESCE(SUM(balance),0) as cash FROM bank_accounts WHERE tenant_id=$1\`, [tenantId]).catch(()=>({rows:[{cash:0}]})),
      pool.query(\`SELECT COUNT(*) as count, COALESCE(SUM(basic_salary),0) as payroll FROM employees WHERE tenant_id=$1 AND status='active'\`, [tenantId]).catch(()=>({rows:[{count:0,payroll:0}]})),
      pool.query(\`SELECT COALESCE(SUM(total_tax),0) as gst FROM ar_invoices WHERE tenant_id=$1 AND invoice_date >= DATE_TRUNC('month',NOW())\`, [tenantId]).catch(()=>({rows:[{gst:0}]})),
      pool.query(\`SELECT COUNT(*) as overdue FROM ar_invoices WHERE tenant_id=$1 AND due_date < NOW() AND status != 'paid'\`, [tenantId]).catch(()=>({rows:[{overdue:0}]})),
    ]);

    const [arData, expData, bankData, empData, gstData, overdueData] = snap.map(s=>s.rows[0]);
    const revenue = parseFloat(arData?.revenue||0);
    const outstanding = parseFloat(arData?.outstanding||0);
    const expenses = parseFloat(expData?.total||0);
    const cash = parseFloat(bankData?.cash||0);
    const payroll = parseFloat(empData?.payroll||0);
    const gst = parseFloat(gstData?.gst||0);
    const overdue = parseInt(overdueData?.overdue||0);
    const netProfit = revenue - expenses;

    const cardStyle = 'background:#f8faff;border-radius:8px;padding:12px;margin:8px 0;border-left:4px solid';
    const rowStyle = 'display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #e2e8f0;font-size:13px';

    const baseHtml = (title:string, content:string) => \`
      <html><body style="font-family:Arial,sans-serif;padding:20px;max-width:600px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#1e3a8a,#1d4ed8);padding:16px 20px;border-radius:10px 10px 0 0">
          <div style="color:#fff;font-size:18px;font-weight:900">Deemona AI Finance OS</div>
          <div style="color:rgba(255,255,255,0.7);font-size:12px">On-Demand Report — Generated: \${now.toLocaleString('en-IN')}</div>
        </div>
        <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:20px;border-radius:0 0 10px 10px">
          <h2 style="color:#1e3a8a;margin-bottom:4px">\${title}</h2>
          <p style="color:#64748b;font-size:12px;margin-bottom:16px">Live data as of \${now.toLocaleString('en-IN')} IST</p>
          \${content}
        </div>
        <p style="font-size:11px;color:#94a3b8;margin-top:12px;text-align:center">On-demand report from Deemona AI Finance OS &bull; Deemona Global Solutions</p>
      </body></html>
    \`;

    switch(report_id) {
      case 'ai_insights':
        subject = \`AI Smart Insights — On-Demand — \${now.toLocaleString('en-IN')}\`;
        const insights = await (async () => {
          try {
            const Anthropic = (await import('@anthropic-ai/sdk')).default;
            const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const resp = await client.messages.create({
              model: 'claude-sonnet-4-6', max_tokens: 800,
              messages: [{ role: 'user', content: \`Analyze this financial data for an Indian SME and provide 4-5 actionable AI insights in bullet points:
                Revenue: \${fmt(revenue)}, Outstanding AR: \${fmt(outstanding)}, Cash Balance: \${fmt(cash)},
                Monthly Expenses: \${fmt(expenses)}, Payroll: \${fmt(payroll)}, GST Payable: \${fmt(gst)},
                Overdue Invoices: \${overdue}. Focus on cash flow, profitability, and risk. Be specific and actionable.\` }]
            });
            return resp.content[0].type === 'text' ? resp.content[0].text : '';
          } catch { return 'AI insights temporarily unavailable.'; }
        })();
        html = baseHtml('AI Smart Insights',
          \`<div style="\${cardStyle} #1d4ed8">\${insights.split('\\n').map(l=>l?'<p style="margin:4px 0;font-size:12px;color:#334155">'+l+'</p>':'').join('')}</div>
          <div style="\${cardStyle} #059669">
            <div style="\${rowStyle}"><span>Revenue</span><strong>\${fmt(revenue)}</strong></div>
            <div style="\${rowStyle}"><span>Cash Balance</span><strong>\${fmt(cash)}</strong></div>
            <div style="\${rowStyle}"><span>Outstanding AR</span><strong style="color:#dc2626">\${fmt(outstanding)}</strong></div>
            <div style="\${rowStyle}"><span>Overdue Invoices</span><strong style="color:\${overdue>0?'#dc2626':'#16a34a'}">\${overdue}</strong></div>
          </div>\`
        );
        break;

      case 'anomaly_detection':
        subject = \`Anomaly Detection Report — On-Demand — \${now.toLocaleString('en-IN')}\`;
        const anomalies = [];
        if (overdue > 5) anomalies.push({sev:'HIGH', msg:\`\${overdue} overdue invoices totaling \${fmt(outstanding)}\`});
        if (expenses > revenue * 0.8) anomalies.push({sev:'HIGH', msg:\`Expense ratio critical: \${fmt(expenses)} vs revenue \${fmt(revenue)}\`});
        if (cash < payroll) anomalies.push({sev:'CRITICAL', msg:\`Cash \${fmt(cash)} below monthly payroll \${fmt(payroll)}\`});
        if (gst > revenue * 0.2) anomalies.push({sev:'MEDIUM', msg:\`GST liability \${fmt(gst)} is unusually high\`});
        if (!anomalies.length) anomalies.push({sev:'OK', msg:'No anomalies detected. All metrics within normal range.'});
        html = baseHtml('Anomaly Detection Report',
          anomalies.map(a=>\`<div style="\${cardStyle} \${a.sev==='CRITICAL'?'#dc2626':a.sev==='HIGH'?'#d97706':a.sev==='OK'?'#059669':'#1d4ed8'};margin:8px 0;padding:10px 14px">
            <strong style="color:\${a.sev==='CRITICAL'?'#dc2626':a.sev==='HIGH'?'#d97706':a.sev==='OK'?'#059669':'#1d4ed8'}">\${a.sev}</strong>
            <span style="font-size:12px;color:#334155;margin-left:8px">\${a.msg}</span>
          </div>\`).join('')
        );
        break;

      case 'balance_sheet':
        subject = \`Balance Sheet — On-Demand — \${now.toLocaleString('en-IN')}\`;
        html = baseHtml('Balance Sheet',
          \`<div style="\${cardStyle} #1d4ed8">
            <div style="\${rowStyle}"><span>Cash & Bank</span><strong>\${fmt(cash)}</strong></div>
            <div style="\${rowStyle}"><span>Accounts Receivable</span><strong>\${fmt(outstanding)}</strong></div>
            <div style="\${rowStyle}"><span>Total Revenue (YTD)</span><strong>\${fmt(revenue)}</strong></div>
          </div>
          <div style="\${cardStyle} #dc2626">
            <div style="\${rowStyle}"><span>Monthly Expenses</span><strong>\${fmt(expenses)}</strong></div>
            <div style="\${rowStyle}"><span>GST Payable</span><strong>\${fmt(gst)}</strong></div>
            <div style="\${rowStyle}"><span>Payroll (Monthly)</span><strong>\${fmt(payroll)}</strong></div>
          </div>
          <div style="\${cardStyle} #059669">
            <div style="\${rowStyle}"><span>Net Profit (Est.)</span><strong style="color:\${netProfit>=0?'#059669':'#dc2626'}">\${fmt(netProfit)}</strong></div>
          </div>\`
        );
        break;

      case 'filing_gstr3b':
        subject = \`GSTR-3B Filing Report — On-Demand — \${now.toLocaleDateString('en-IN',{month:'long',year:'numeric'})}\`;
        html = baseHtml('GSTR-3B Filing Report',
          \`<div style="\${cardStyle} #7c3aed">
            <div style="\${rowStyle}"><span>Period</span><strong>\${now.toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</strong></div>
            <div style="\${rowStyle}"><span>Total Taxable Turnover</span><strong>\${fmt(revenue)}</strong></div>
            <div style="\${rowStyle}"><span>Total Tax Collected</span><strong>\${fmt(gst)}</strong></div>
            <div style="\${rowStyle}"><span>CGST (Est.)</span><strong>\${fmt(gst*0.5)}</strong></div>
            <div style="\${rowStyle}"><span>SGST (Est.)</span><strong>\${fmt(gst*0.5)}</strong></div>
            <div style="\${rowStyle}"><span>Due Date</span><strong style="color:#dc2626">20th of next month</strong></div>
          </div>\`
        );
        break;

      default:
        // Generic financial summary for any other report
        subject = \`Financial Report (\${report_id}) — On-Demand — \${now.toLocaleString('en-IN')}\`;
        html = baseHtml('Financial Summary',
          \`<div style="\${cardStyle} #1d4ed8">
            <div style="\${rowStyle}"><span>Revenue</span><strong>\${fmt(revenue)}</strong></div>
            <div style="\${rowStyle}"><span>Expenses</span><strong>\${fmt(expenses)}</strong></div>
            <div style="\${rowStyle}"><span>Net Profit</span><strong style="color:\${netProfit>=0?'#059669':'#dc2626'}">\${fmt(netProfit)}</strong></div>
            <div style="\${rowStyle}"><span>Cash Balance</span><strong>\${fmt(cash)}</strong></div>
            <div style="\${rowStyle}"><span>Outstanding AR</span><strong>\${fmt(outstanding)}</strong></div>
            <div style="\${rowStyle}"><span>GST Payable</span><strong>\${fmt(gst)}</strong></div>
          </div>\`
        );
    }

    await resend.emails.send({ from: 'Deemona Finance OS <onboarding@resend.dev>', to: email, subject, html });
    await pool.query(
      \`INSERT INTO ingest_logs (tenant_id, channel, source_ref, status, record_count, message, created_at) VALUES ($1,'manual_report',$2,'sent',1,$3,NOW())\`,
      [tenantId, report_id, \`On-demand report sent to \${email}\`]
    ).catch(()=>{});

    res.json({ success: true, sent_to: email, report_id, generated_at: now.toISOString() });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/dashboard/reports/schedule — list all scheduled reports with last-sent time
router.get('/reports/schedule', requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = tid(req);
    const logs = await pool.query(
      \`SELECT source_ref as report_id, MAX(created_at) as last_sent FROM ingest_logs WHERE tenant_id=$1 AND channel IN ('manual_report','cron_report') GROUP BY source_ref\`,
      [tenantId]
    ).catch(()=>({rows:[]}));
    const lastSentMap:any = {};
    logs.rows.forEach((r:any) => { lastSentMap[r.report_id] = r.last_sent; });
    res.json({
      scheduled: [
        {id:'ai_insights', name:'AI Smart Insights', schedule:'Daily 8am IST', last_sent: lastSentMap['ai_insights']||null},
        {id:'anomaly_detection', name:'Anomaly Detection', schedule:'Daily 9am IST', last_sent: lastSentMap['anomaly_detection']||null},
        {id:'balance_sheet', name:'Balance Sheet Email', schedule:'Every Monday 9am IST', last_sent: lastSentMap['balance_sheet']||null},
        {id:'filing_gstr3b', name:'GSTR-3B Filing Report', schedule:'1st of month 10am IST', last_sent: lastSentMap['filing_gstr3b']||null},
        {id:'daily_ar', name:'Daily AR Aging', schedule:'Daily 7am IST', last_sent: lastSentMap['daily_ar']||null},
        {id:'daily_cash', name:'Daily Cash Position', schedule:'Daily 7am IST', last_sent: lastSentMap['daily_cash']||null},
        {id:'weekly_pl', name:'Weekly P&L', schedule:'Monday 7am IST', last_sent: lastSentMap['weekly_pl']||null},
        {id:'monthly_gst', name:'Monthly GST Summary', schedule:'1st of month', last_sent: lastSentMap['monthly_gst']||null},
        {id:'weekly_collections', name:'Weekly Collections', schedule:'Monday 7am IST', last_sent: lastSentMap['weekly_collections']||null},
        {id:'monthly_budget', name:'Budget vs Actual', schedule:'1st of month', last_sent: lastSentMap['monthly_budget']||null},
        {id:'monthly_financial', name:'Monthly Financial Report', schedule:'1st of month', last_sent: lastSentMap['monthly_financial']||null},
        {id:'weekly_ap', name:'Weekly AP Calendar', schedule:'Monday 7am IST', last_sent: lastSentMap['weekly_ap']||null},
        {id:'daily_compliance', name:'Compliance Alerts', schedule:'Daily 7am IST', last_sent: lastSentMap['daily_compliance']||null},
        {id:'monthly_inventory', name:'Inventory Report', schedule:'1st of month', last_sent: lastSentMap['monthly_inventory']||null},
      ],
      total: 14
    });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});
`;

const routeFile = 'C:/deemona-finance-os/backend/src/routes/dashboardRoutes.ts';
if (fs.existsSync(routeFile)) {
  let r = fs.readFileSync(routeFile, 'utf8');
  if (!r.includes('reports/trigger')) {
    r = r.replace('  return router;', route + '\n  return router;');
    fs.writeFileSync(routeFile, r, 'utf8');
    console.log('On-demand report triggers added');
  } else {
    console.log('Already exists');
  }
} else {
  console.log('File not found:', routeFile);
}
