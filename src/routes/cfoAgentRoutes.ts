import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function createCFOAgentRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── CFO Agent Q&A ─────────────────────────────────────────
  router.post('/ask', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { question, conversation_history = [] } = req.body;

      if (!question) { res.status(400).json({ error: 'question is required' }); return; }

      // Gather comprehensive financial context
      const [
        bankBals, arSummary, apSummary, recentTxns,
        payrollRuns, employees, projects, leads,
        arInvoices, apInvoices, assets, cashFlow,
        taxFilings, compliance, expenses,
      ] = await Promise.all([
        pool.query('SELECT name, current_balance, account_type FROM bank_accounts WHERE tenant_id=$1 AND is_active=TRUE ORDER BY is_primary DESC', [tenantId]),
        pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(balance_due),0) as outstanding, COALESCE(SUM(total_amount),0) as total FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled')`, [tenantId]),
        pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(balance_due),0) as outstanding FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','rejected')`, [tenantId]),
        pool.query(`SELECT description, type, amount, date, category FROM bank_transactions WHERE tenant_id=$1 ORDER BY date DESC LIMIT 10`, [tenantId]),
        pool.query(`SELECT month, year, total_gross, total_net, total_tds, total_employer_pf, status, total_employees FROM payroll_runs WHERE tenant_id=$1 ORDER BY year DESC, month DESC LIMIT 3`, [tenantId]),
        pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='active') as active, COALESCE(SUM(basic_salary+hra+special_allowance+other_allowances) FILTER (WHERE status='active'),0) as monthly_cost FROM employees WHERE tenant_id=$1`, [tenantId]),
        pool.query(`SELECT name, status, budget, spent, billed, client_name FROM projects WHERE tenant_id=$1 ORDER BY budget DESC`, [tenantId]),
        pool.query(`SELECT stage, COUNT(*) as count, COALESCE(SUM(value),0) as value FROM crm_leads WHERE tenant_id=$1 GROUP BY stage`, [tenantId]),
        pool.query(`SELECT status, COUNT(*) as count, COALESCE(SUM(total_amount),0) as amount FROM ar_invoices WHERE tenant_id=$1 GROUP BY status`, [tenantId]),
        pool.query(`SELECT status, COUNT(*) as count, COALESCE(SUM(total_amount),0) as amount FROM ap_invoices WHERE tenant_id=$1 GROUP BY status`, [tenantId]),
        pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(current_value),0) as book_value FROM fixed_assets WHERE tenant_id=$1 AND status='active'`, [tenantId]),
        pool.query(`SELECT type, SUM(amount) as total FROM bank_transactions WHERE tenant_id=$1 AND date >= CURRENT_DATE - INTERVAL '30 days' GROUP BY type`, [tenantId]),
        pool.query(`SELECT filing_type, period_month, period_year, status, tax_liability FROM tax_filings WHERE tenant_id=$1 ORDER BY due_date DESC LIMIT 5`, [tenantId]),
        pool.query(`SELECT COUNT(*) FILTER (WHERE status='pending' AND due_date < CURRENT_DATE) as overdue FROM compliance_items WHERE tenant_id=$1`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(total_amount) FILTER (WHERE status='approved'),0) as approved FROM expense_claims WHERE tenant_id=$1 AND date >= CURRENT_DATE - INTERVAL '30 days'`, [tenantId]),
      ]);

      // Build financial context
      const totalCash = bankBals.rows.reduce((s: number, b: any) => s + parseFloat(b.current_balance), 0);
      const monthlyPayroll = parseFloat(employees.rows[0].monthly_cost);
      const runway = monthlyPayroll > 0 ? totalCash / monthlyPayroll : 0;
      const arOutstanding = parseFloat(arSummary.rows[0].outstanding);
      const apOutstanding = parseFloat(apSummary.rows[0].outstanding);

      const last30InFlow  = cashFlow.rows.find((r: any) => r.type === 'credit')?.total || 0;
      const last30OutFlow = cashFlow.rows.find((r: any) => r.type === 'debit')?.total || 0;

      const pipelineValue = leads.rows
        .filter((l: any) => !['won','lost'].includes(l.stage))
        .reduce((s: number, l: any) => s + parseFloat(l.value), 0);

      const wonRevenue = leads.rows
        .filter((l: any) => l.stage === 'won')
        .reduce((s: number, l: any) => s + parseFloat(l.value), 0);

      const context = `
FINANCIAL SNAPSHOT — as of today:

CASH POSITION:
${bankBals.rows.map((b: any) => `- ${b.name} (${b.account_type}): INR ${parseFloat(b.current_balance).toLocaleString('en-IN')}`).join('\n')}
Total Cash: INR ${totalCash.toLocaleString('en-IN')}

REVENUE & RECEIVABLES:
- AR Outstanding: INR ${arOutstanding.toLocaleString('en-IN')} (${arSummary.rows[0].count} invoices)
- AR by status: ${arInvoices.rows.map((r: any) => `${r.status}: ${parseInt(r.count)} invoices = INR ${parseFloat(r.amount).toLocaleString('en-IN')}`).join(', ')}
- Last 30 days cash inflow: INR ${parseFloat(last30InFlow).toLocaleString('en-IN')}

EXPENSES & PAYABLES:
- AP Outstanding: INR ${apOutstanding.toLocaleString('en-IN')} (${apSummary.rows[0].count} invoices)
- Last 30 days cash outflow: INR ${parseFloat(last30OutFlow).toLocaleString('en-IN')}
- Monthly expense approvals: INR ${parseFloat(expenses.rows[0].approved).toLocaleString('en-IN')}

PAYROLL:
- Total employees: ${employees.rows[0].total} (${employees.rows[0].active} active)
- Monthly payroll cost: INR ${monthlyPayroll.toLocaleString('en-IN')}
- Recent runs: ${payrollRuns.rows.map((r: any) => `${r.month}/${r.year}: Gross INR ${parseFloat(r.total_gross).toLocaleString('en-IN')}, Net INR ${parseFloat(r.total_net).toLocaleString('en-IN')}, Status: ${r.status}`).join(' | ')}

RUNWAY: ${runway.toFixed(1)} months at current burn rate

PROJECTS:
${projects.rows.map((p: any) => {
  const burnPct = p.budget > 0 ? ((parseFloat(p.spent)/parseFloat(p.budget))*100).toFixed(0) : 0;
  return `- ${p.name} (${p.client_name}): Budget INR ${parseFloat(p.budget).toLocaleString('en-IN')}, Spent INR ${parseFloat(p.spent).toLocaleString('en-IN')} (${burnPct}%), Status: ${p.status}`;
}).join('\n')}

SALES PIPELINE:
${leads.rows.map((l: any) => `- ${l.stage}: ${l.count} leads = INR ${parseFloat(l.value).toLocaleString('en-IN')}`).join('\n')}
- Pipeline value (active): INR ${pipelineValue.toLocaleString('en-IN')}
- Won revenue: INR ${wonRevenue.toLocaleString('en-IN')}

ASSETS:
- Fixed assets: ${assets.rows[0].count} items, Book value: INR ${parseFloat(assets.rows[0].book_value).toLocaleString('en-IN')}

TAX & COMPLIANCE:
- Recent filings: ${taxFilings.rows.map((t: any) => `${t.filing_type} ${t.period_month}/${t.period_year}: ${t.status}, Liability INR ${parseFloat(t.tax_liability).toLocaleString('en-IN')}`).join(' | ')}
- Overdue compliance items: ${compliance.rows[0].overdue}

RECENT BANK TRANSACTIONS (last 10):
${recentTxns.rows.map((t: any) => `- ${t.date}: ${t.description} | ${t.type === 'credit' ? '+' : '-'}INR ${parseFloat(t.amount).toLocaleString('en-IN')} (${t.category})`).join('\n')}
`;

      const systemPrompt = `You are the Digital CFO of this company, powered by Deemona AI Finance OS.
You have access to real-time financial data shown below. Answer executive-level finance questions with:

1. DIRECT ANSWER — clear, confident response to the question
2. SUPPORTING EVIDENCE — cite specific numbers from the data
3. ASSUMPTIONS — state what you're assuming if data is incomplete  
4. CONFIDENCE LEVEL — High/Medium/Low based on data quality
5. RECOMMENDED ACTION — one concrete next step

Rules:
- Use INR and Indian financial context
- Be specific with numbers — don't be vague
- If data is missing, say so and explain what would help
- Speak like a seasoned CFO, not like a chatbot
- Keep responses under 300 words unless the question needs detail
- Format key numbers in bold using markdown

${context}`;

      const messages = [
        ...conversation_history,
        { role: 'user', content: question }
      ];

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      });

      const answer = response.content[0].type === 'text' ? response.content[0].text : '';

      res.json({
        answer,
        context_snapshot: {
          total_cash: totalCash,
          ar_outstanding: arOutstanding,
          ap_outstanding: apOutstanding,
          runway_months: parseFloat(runway.toFixed(1)),
          monthly_burn: monthlyPayroll,
          pipeline_value: pipelineValue,
        },
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── CFO Dashboard Summary ─────────────────────────────────
  router.get('/dashboard', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);

      const [banks, ar, ap, payroll, pipeline, overdue, projects] = await Promise.all([
        pool.query('SELECT COALESCE(SUM(current_balance),0) as total FROM bank_accounts WHERE tenant_id=$1 AND is_active=TRUE', [tenantId]),
        pool.query(`SELECT COALESCE(SUM(balance_due),0) as total FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled')`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(balance_due),0) as total FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','rejected')`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(total_gross),0) as monthly FROM payroll_runs WHERE tenant_id=$1 AND status IN ('paid','approved') ORDER BY year DESC, month DESC LIMIT 1`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(value*probability/100),0) as weighted FROM crm_leads WHERE tenant_id=$1 AND stage NOT IN ('won','lost')`, [tenantId]),
        pool.query(`SELECT COUNT(*) as count FROM compliance_items WHERE tenant_id=$1 AND status='pending' AND due_date < CURRENT_DATE`, [tenantId]),
        pool.query(`SELECT COUNT(*) FILTER (WHERE status='active') as active, COALESCE(SUM(budget) FILTER (WHERE status='active'),0) as total_budget, COALESCE(SUM(spent) FILTER (WHERE status='active'),0) as total_spent FROM projects WHERE tenant_id=$1`, [tenantId]),
      ]);

      const cash = parseFloat(banks.rows[0].total);
      const burn = parseFloat(payroll.rows[0].monthly) || 0;
      const runway = burn > 0 ? cash / burn : 0;

      res.json({
        cash: cash,
        ar: parseFloat(ar.rows[0].total),
        ap: parseFloat(ap.rows[0].total),
        working_capital: cash + parseFloat(ar.rows[0].total) - parseFloat(ap.rows[0].total),
        monthly_burn: burn,
        runway_months: parseFloat(runway.toFixed(1)),
        pipeline_weighted: parseFloat(pipeline.rows[0].weighted),
        overdue_compliance: parseInt(overdue.rows[0].count),
        active_projects: parseInt(projects.rows[0].active),
        project_burn_pct: projects.rows[0].total_budget > 0
          ? parseFloat((projects.rows[0].total_spent / projects.rows[0].total_budget * 100).toFixed(1))
          : 0,
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/cfo/brief ─────────────────────────────────
  router.post('/brief', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { prompt } = req.body;

      const [banks, ar, ap, payroll] = await Promise.all([
        pool.query('SELECT COALESCE(SUM(current_balance),0) as total FROM bank_accounts WHERE tenant_id=$1', [tenantId]),
        pool.query('SELECT COUNT(*) as count, COALESCE(SUM(balance_due),0) as outstanding FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ($2,$3)', [tenantId,'paid','cancelled']),
        pool.query('SELECT COUNT(*) as count, COALESCE(SUM(balance_due),0) as outstanding FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ($2,$3)', [tenantId,'paid','rejected']),
        pool.query('SELECT COALESCE(SUM(total_gross),0) as monthly FROM payroll_runs WHERE tenant_id=$1 AND status=$2 ORDER BY year DESC, month DESC LIMIT 1', [tenantId,'paid']),
      ]);

      const context = 'Financial snapshot: Cash Rs ' + parseFloat(banks.rows[0].total).toLocaleString('en-IN')
        + ', AR outstanding Rs ' + parseFloat(ar.rows[0].outstanding).toLocaleString('en-IN')
        + ', AP outstanding Rs ' + parseFloat(ap.rows[0].outstanding).toLocaleString('en-IN')
        + ', Monthly payroll Rs ' + parseFloat(payroll.rows[0].monthly).toLocaleString('en-IN') + '.';

      const finalPrompt = prompt || ('You are CFO of an Indian company. ' + context + ' Give a 100-word executive brief covering financial health, top 3 priorities, and one action item. Plain text only.');

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: finalPrompt }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      res.json({ text });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}


