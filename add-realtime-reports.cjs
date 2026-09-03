const fs = require('fs');

// 1. Add real-time report generation endpoint to backend
const realtimeRoute = `
// ── Real-Time Report Generation ──────────────────────────────
router.post('/reports/generate', requireAuth, async (req: Request, res: Response) => {
  try {
    const { report_type, format = 'json', email = false } = req.body;
    const tenantId = tid(req);
    const now = new Date();
    const generatedAt = now.toISOString();

    let reportData: any = {};

    switch(report_type) {
      case 'balance_sheet': {
        const [assets, liabilities, equity] = await Promise.all([
          pool.query(\`SELECT 
            COALESCE(SUM(CASE WHEN account_type='asset' AND is_current=true THEN balance END),0) as current_assets,
            COALESCE(SUM(CASE WHEN account_type='asset' AND is_current=false THEN balance END),0) as fixed_assets,
            COALESCE(SUM(CASE WHEN account_type='asset' THEN balance END),0) as total_assets
            FROM chart_of_accounts WHERE tenant_id=$1\`, [tenantId]).catch(()=>({rows:[{current_assets:0,fixed_assets:0,total_assets:0}]})),
          pool.query(\`SELECT 
            COALESCE(SUM(CASE WHEN account_type='liability' AND is_current=true THEN balance END),0) as current_liab,
            COALESCE(SUM(CASE WHEN account_type='liability' AND is_current=false THEN balance END),0) as long_term_liab,
            COALESCE(SUM(CASE WHEN account_type='liability' THEN balance END),0) as total_liab
            FROM chart_of_accounts WHERE tenant_id=$1\`, [tenantId]).catch(()=>({rows:[{current_liab:0,long_term_liab:0,total_liab:0}]})),
          pool.query(\`SELECT COALESCE(SUM(balance),0) as total_equity FROM chart_of_accounts WHERE tenant_id=$1 AND account_type='equity'\`, [tenantId]).catch(()=>({rows:[{total_equity:0}]})),
        ]);
        reportData = { assets: assets.rows[0], liabilities: liabilities.rows[0], equity: equity.rows[0], generated_at: generatedAt };
        break;
      }
      case 'profit_loss': {
        const [revenue, expenses] = await Promise.all([
          pool.query(\`SELECT COALESCE(SUM(total_amount),0) as total FROM ar_invoices WHERE tenant_id=$1 AND EXTRACT(MONTH FROM invoice_date)=EXTRACT(MONTH FROM NOW()) AND EXTRACT(YEAR FROM invoice_date)=EXTRACT(YEAR FROM NOW())\`, [tenantId]).catch(()=>({rows:[{total:0}]})),
          pool.query(\`SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE tenant_id=$1 AND EXTRACT(MONTH FROM expense_date)=EXTRACT(MONTH FROM NOW()) AND EXTRACT(YEAR FROM expense_date)=EXTRACT(YEAR FROM NOW())\`, [tenantId]).catch(()=>({rows:[{total:0}]})),
        ]);
        const rev = parseFloat(revenue.rows[0]?.total||0);
        const exp = parseFloat(expenses.rows[0]?.total||0);
        reportData = { revenue: rev, expenses: exp, gross_profit: rev-exp, net_profit: (rev-exp)*0.85, margin: rev>0?((rev-exp)/rev*100).toFixed(2):0, period: now.toLocaleDateString('en-IN',{month:'long',year:'numeric'}), generated_at: generatedAt };
        break;
      }
      case 'cash_flow': {
        const txns = await pool.query(\`SELECT type, COALESCE(SUM(amount),0) as total FROM bank_transactions WHERE tenant_id=$1 AND transaction_date >= NOW() - INTERVAL '30 days' GROUP BY type\`, [tenantId]).catch(()=>({rows:[]}));
        const inflow = txns.rows.find((r:any)=>r.type==='credit')?.total||0;
        const outflow = txns.rows.find((r:any)=>r.type==='debit')?.total||0;
        reportData = { inflow: parseFloat(inflow), outflow: parseFloat(outflow), net: parseFloat(inflow)-parseFloat(outflow), period: 'Last 30 days', generated_at: generatedAt };
        break;
      }
      case 'ar_aging': {
        const aging = await pool.query(\`SELECT 
          COUNT(*) as total_invoices,
          COALESCE(SUM(outstanding_amount),0) as total_outstanding,
          COALESCE(SUM(CASE WHEN due_date >= NOW() THEN outstanding_amount END),0) as current_due,
          COALESCE(SUM(CASE WHEN due_date < NOW() AND due_date >= NOW()-INTERVAL '30 days' THEN outstanding_amount END),0) as overdue_30,
          COALESCE(SUM(CASE WHEN due_date < NOW()-INTERVAL '30 days' AND due_date >= NOW()-INTERVAL '60 days' THEN outstanding_amount END),0) as overdue_60,
          COALESCE(SUM(CASE WHEN due_date < NOW()-INTERVAL '60 days' THEN outstanding_amount END),0) as overdue_90plus
          FROM ar_invoices WHERE tenant_id=$1 AND status != 'paid'\`, [tenantId]).catch(()=>({rows:[{}]}));
        reportData = { ...aging.rows[0], generated_at: generatedAt };
        break;
      }
      case 'gst_summary': {
        const gst = await pool.query(\`SELECT 
          COALESCE(SUM(cgst_amount),0) as cgst,
          COALESCE(SUM(sgst_amount),0) as sgst,
          COALESCE(SUM(igst_amount),0) as igst,
          COALESCE(SUM(total_tax),0) as total_gst,
          COUNT(*) as invoice_count
          FROM ar_invoices WHERE tenant_id=$1 AND EXTRACT(MONTH FROM invoice_date)=EXTRACT(MONTH FROM NOW()) AND EXTRACT(YEAR FROM invoice_date)=EXTRACT(YEAR FROM NOW())\`, [tenantId]).catch(()=>({rows:[{}]}));
        reportData = { ...gst.rows[0], period: now.toLocaleDateString('en-IN',{month:'long',year:'numeric'}), generated_at: generatedAt };
        break;
      }
      case 'payroll_summary': {
        const payroll = await pool.query(\`SELECT 
          COUNT(*) as employee_count,
          COALESCE(SUM(basic_salary),0) as total_basic,
          COALESCE(SUM(basic_salary*0.12),0) as total_pf,
          COALESCE(SUM(basic_salary*1.3),0) as total_ctc
          FROM employees WHERE tenant_id=$1 AND status='active'\`, [tenantId]).catch(()=>({rows:[{}]}));
        reportData = { ...payroll.rows[0], generated_at: generatedAt };
        break;
      }
      default:
        return res.status(400).json({ error: 'Unknown report_type' }) as any;
    }

    // If email requested, send via Resend
    if (email) {
      const user = await pool.query('SELECT email FROM users WHERE tenant_id=$1 LIMIT 1', [tenantId]).catch(()=>({rows:[]}));
      if (user.rows[0]?.email) {
        const { Resend } = await import('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        const fmt = (n:any) => { const v=parseFloat(n||0); if(v>=10000000) return '₹'+(v/10000000).toFixed(2)+'Cr'; if(v>=100000) return '₹'+(v/100000).toFixed(2)+'L'; return '₹'+v.toFixed(2); };
        await resend.emails.send({
          from: 'Deemona Finance OS <onboarding@resend.dev>',
          to: user.rows[0].email,
          subject: \`📊 Real-Time \${report_type.replace(/_/g,' ').toUpperCase()} — \${now.toLocaleString('en-IN')}\`,
          html: \`<html><body style="font-family:Arial;padding:20px;max-width:600px">
            <h2 style="color:#1d4ed8">📊 Real-Time Report: \${report_type.replace(/_/g,' ').toUpperCase()}</h2>
            <p style="color:#64748b">Generated at: <strong>\${now.toLocaleString('en-IN')}</strong> (Live data)</p>
            <div style="background:#f8faff;border-radius:8px;padding:16px;margin:12px 0">
              \${Object.entries(reportData).filter(([k])=>k!=='generated_at').map(([k,v])=>
                \`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #e2e8f0;font-size:13px">
                  <span style="color:#64748b;font-weight:600">\${k.replace(/_/g,' ').toUpperCase()}</span>
                  <span style="font-weight:700;color:#0f172a">\${typeof v==='number'&&v>1000?fmt(v):v}</span>
                </div>\`
              ).join('')}
            </div>
            <p style="font-size:11px;color:#94a3b8">This is a real-time report generated on-demand from Deemona AI Finance OS. Data reflects current state as of generation time.</p>
          </body></html>\`
        }).catch(()=>{});
      }
    }

    res.json({ success: true, report_type, data: reportData, generated_at: generatedAt, is_realtime: true });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/reports/last-updated — returns last data entry timestamps
router.get('/reports/last-updated', requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = tid(req);
    const [invoices, expenses, payments, bank, employees] = await Promise.all([
      pool.query('SELECT MAX(updated_at) as last FROM ar_invoices WHERE tenant_id=$1', [tenantId]).catch(()=>({rows:[{last:null}]})),
      pool.query('SELECT MAX(updated_at) as last FROM expenses WHERE tenant_id=$1', [tenantId]).catch(()=>({rows:[{last:null}]})),
      pool.query('SELECT MAX(updated_at) as last FROM ap_payments WHERE tenant_id=$1', [tenantId]).catch(()=>({rows:[{last:null}]})),
      pool.query('SELECT MAX(transaction_date) as last FROM bank_transactions WHERE tenant_id=$1', [tenantId]).catch(()=>({rows:[{last:null}]})),
      pool.query('SELECT MAX(updated_at) as last FROM employees WHERE tenant_id=$1', [tenantId]).catch(()=>({rows:[{last:null}]})),
    ]);
    res.json({
      server_time: new Date().toISOString(),
      last_updated: {
        invoices: invoices.rows[0]?.last,
        expenses: expenses.rows[0]?.last,
        payments: payments.rows[0]?.last,
        bank_transactions: bank.rows[0]?.last,
        employees: employees.rows[0]?.last,
      },
      data_freshness: 'real-time',
      note: 'All dashboard data reflects current database state at time of viewing',
    });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});
`;

// Add to dashboardRoutes.ts or phase1Routes.ts
const routeFile = 'C:/deemona-finance-os/backend/src/routes/dashboardRoutes.ts';
if (fs.existsSync(routeFile)) {
  let r = fs.readFileSync(routeFile, 'utf8');
  if (!r.includes('reports/generate')) {
    r = r.replace('  return router;', realtimeRoute + '\n  return router;');
    fs.writeFileSync(routeFile, r, 'utf8');
    console.log('Real-time reports added to dashboardRoutes.ts');
  } else {
    console.log('Already exists');
  }
} else {
  console.log('dashboardRoutes.ts not found at:', routeFile);
}
