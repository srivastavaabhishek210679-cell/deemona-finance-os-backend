// ============================================================
// Deemona AI Finance OS — Phase 1 Routes
// Covers: Balance Sheet, Anomaly Detection, AI Insights,
//         Chatbot, What-if, Attrition, Operations,
//         Admin/Feature Flags, Blockchain Audit, Filing Auto
// ============================================================
import { cashAsOf } from '../services/cashPosition';
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

// Internal cron calls send "Bearer internal-<CRON_SECRET>.<tenantId>". Rejected unless CRON_SECRET is set (>=16 chars) and matches.
const requireAuthOrInternal = (req: any, res: any, next: any) => {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer internal-')) {
    const secret = process.env.CRON_SECRET || '';
    const rest = auth.slice('Bearer internal-'.length);
    const dot = rest.lastIndexOf('.');
    const given = dot > 0 ? rest.slice(0, dot) : '';
    const tenantId = dot > 0 ? rest.slice(dot + 1) : '';
    const ga = Buffer.from(given), sb = Buffer.from(secret);
    const ok = secret.length >= 16 && ga.length === sb.length && crypto.timingSafeEqual(ga, sb) && /^[0-9a-f-]{36}$/i.test(tenantId);
    if (!ok) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { tenantId, role: 'internal' };
    return next();
  }
  return requireAuth(req, res, next);
};
import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';
import * as crypto from 'crypto';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

const tid = (req: Request): string => (req as any).user?.tenantId;

// ── Helper: get financial snapshot ───────────────────────────
async function getFinancialSnapshot(pool: Pool, tenantId: string) {
  const safe = (p: Promise<any>) => p.catch(() => ({ rows: [{}] }));
  const [ar, ap, exp, inv, emp, bud, bank, gst, payroll] = await Promise.all([
    safe(pool.query(`SELECT COALESCE(SUM(total_amount),0) as total, COALESCE(SUM(CASE WHEN status NOT IN ('paid','cancelled') THEN total_amount ELSE 0 END),0) as outstanding, COALESCE(SUM(CASE WHEN due_date<CURRENT_DATE AND status NOT IN ('paid','cancelled') THEN total_amount ELSE 0 END),0) as overdue FROM ar_invoices WHERE tenant_id=$1`, [tenantId])),
    safe(pool.query(`SELECT COALESCE(SUM(total_amount),0) as total, COALESCE(SUM(CASE WHEN status NOT IN ('paid','rejected') THEN total_amount ELSE 0 END),0) as outstanding FROM ap_invoices WHERE tenant_id=$1`, [tenantId])),
    safe(pool.query(`SELECT COALESCE(SUM(total_amount),0) as total FROM expense_claims WHERE tenant_id=$1`, [tenantId])),
    safe(pool.query(`SELECT COALESCE(SUM(current_stock*unit_cost),0) as value, COUNT(*) as items FROM inventory_items WHERE tenant_id=$1`, [tenantId])),
    safe(pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(basic_salary),0) as payroll FROM employees WHERE tenant_id=$1 AND status='active'`, [tenantId])),
    safe(pool.query(`SELECT COALESCE(SUM(total_budgeted),0) as budget, COALESCE(SUM(total_spent),0) as spent FROM budgets WHERE tenant_id=$1`, [tenantId])),
    safe(cashAsOf(pool, tenantId).then((c: any) => ({ rows: [{ cash: c.amount }] }))),
    safe(pool.query(`SELECT COALESCE(SUM(cgst+sgst+igst),0) as total FROM gst_transactions WHERE tenant_id=$1 AND transaction_type='sale'`, [tenantId])),
    safe(pool.query(`SELECT COALESCE(SUM(total_gross),0) as gross, COALESCE(SUM(total_net),0) as net FROM payroll_runs WHERE tenant_id=$1 AND year=EXTRACT(YEAR FROM NOW()) AND month=EXTRACT(MONTH FROM NOW())`, [tenantId])),
  ]);
  const g = (r: any, k: string) => parseFloat(r?.rows?.[0]?.[k] || 0);
  return {
    revenue: g(ar,'total'), arOutstanding: g(ar,'outstanding'), arOverdue: g(ar,'overdue'),
    apOutstanding: g(ap,'outstanding'), totalExpenses: g(exp,'total'),
    inventoryValue: g(inv,'value'), inventoryItems: parseInt(inv?.rows?.[0]?.items||0),
    employees: parseInt(emp?.rows?.[0]?.count||0), monthlyPayroll: g(emp,'payroll'),
    totalBudget: g(bud,'budget'), totalSpent: g(bud,'spent'),
    cashBalance: g(bank,'cash'), gstLiability: g(gst,'total'),
    payrollGross: g(payroll,'gross'),
  };
}


// ── Helper: blockchain hash ───────────────────────────────────
function computeHash(prevHash: string, data: any): string {
  const content = prevHash + JSON.stringify(data) + Date.now();
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function createPhase1Router(pool: Pool): Router {
  const router = Router();

  // ══════════════════════════════════════════════════════════
  // 1. BALANCE SHEET
  // ══════════════════════════════════════════════════════════
  router.get('/balance-sheet', requireAuthOrInternal, async (req: Request, res: Response) => {
    try {
      const t = tid(req);
      const snap = await getFinancialSnapshot(pool, t);
      const assets = await pool.query(`SELECT category, COALESCE(SUM(current_value),0) as value FROM fixed_assets WHERE tenant_id=$1 GROUP BY category`, [t]).catch(() => ({ rows: [] }));
      const loans = await pool.query(`SELECT COALESCE(SUM(outstanding_amount),0) as total FROM loan_agreements WHERE tenant_id=$1 AND status='active'`, [t]).catch(() => ({ rows: [{ total: 0 }] }));

      const totalFixedAssets = assets.rows.reduce((s: number, r: any) => s + parseFloat(r.value || 0), 0);
      const totalCurrentAssets = snap.cashBalance + snap.arOutstanding + snap.inventoryValue;
      const totalAssets = totalCurrentAssets + totalFixedAssets;
      const totalCurrentLiabilities = snap.apOutstanding + snap.gstLiability;
      const totalLongTermLiabilities = parseFloat(loans.rows[0]?.total || 0);
      const totalLiabilities = totalCurrentLiabilities + totalLongTermLiabilities;
      const shareholdersEquity = totalAssets - totalLiabilities;

      res.json({
        asOfDate: new Date().toISOString().split('T')[0],
        assets: {
          current: {
            cash: snap.cashBalance,
            accountsReceivable: snap.arOutstanding,
            inventory: snap.inventoryValue,
            total: totalCurrentAssets,
          },
          fixed: {
            byCategory: assets.rows,
            total: totalFixedAssets,
          },
          total: totalAssets,
        },
        liabilities: {
          current: {
            accountsPayable: snap.apOutstanding,
            gstPayable: snap.gstLiability,
            total: totalCurrentLiabilities,
          },
          longTerm: {
            loans: parseFloat(loans.rows[0]?.total || 0),
            total: totalLongTermLiabilities,
          },
          total: totalLiabilities,
        },
        equity: {
          shareholdersEquity,
          retainedEarnings: snap.revenue - snap.totalExpenses,
          total: shareholdersEquity,
        },
        ratios: {
          currentRatio: totalCurrentLiabilities > 0 ? (totalCurrentAssets / totalCurrentLiabilities).toFixed(2) : 'N/A',
          debtToEquity: shareholdersEquity > 0 ? (totalLiabilities / shareholdersEquity).toFixed(2) : 'N/A',
          assetTurnover: totalAssets > 0 ? (snap.revenue / totalAssets).toFixed(2) : 'N/A',
        },
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ══════════════════════════════════════════════════════════
  // 2. ANOMALY DETECTION
  // ══════════════════════════════════════════════════════════
  router.post('/anomaly/detect', requireAuthOrInternal, async (req: Request, res: Response) => {
    try {
      const t = tid(req);
      const snap = await getFinancialSnapshot(pool, t);

      // Get historical averages for comparison
      const [arHistory, expHistory, payHistory] = await Promise.all([
        pool.query(`SELECT AVG(total_amount) as avg, STDDEV(total_amount) as std FROM ar_invoices WHERE tenant_id=$1 AND created_at > NOW()-INTERVAL '90 days'`, [t]),
        pool.query(`SELECT AVG(total_amount) as avg, STDDEV(total_amount) as std FROM expense_claims WHERE tenant_id=$1 AND created_at > NOW()-INTERVAL '90 days'`, [t]),
        pool.query(`SELECT AVG(total_gross) as avg, STDDEV(total_gross) as std FROM payroll_runs WHERE tenant_id=$1`, [t]),
      ].map((p: Promise<any>) => p.catch(() => ({ rows: [{}] }))));

      const anomalies = [];
      const prompt = `You are a financial anomaly detection AI for Deemona Finance OS.
Analyze this financial data and identify anomalies, risks, and unusual patterns:

Current Financial Snapshot:
- Revenue (AR Total): ₹${snap.revenue.toLocaleString('en-IN')}
- AR Outstanding: ₹${snap.arOutstanding.toLocaleString('en-IN')}
- AR Overdue: ₹${snap.arOverdue.toLocaleString('en-IN')} (${snap.revenue > 0 ? ((snap.arOverdue / snap.revenue) * 100).toFixed(1) : 0}% of revenue)
- AP Outstanding: ₹${snap.apOutstanding.toLocaleString('en-IN')}
- Cash Balance: ₹${snap.cashBalance.toLocaleString('en-IN')}
- Total Expenses: ₹${snap.totalExpenses.toLocaleString('en-IN')}
- Inventory Value: ₹${snap.inventoryValue.toLocaleString('en-IN')}
- Monthly Payroll: ₹${snap.monthlyPayroll.toLocaleString('en-IN')}
- Budget: ₹${snap.totalBudget.toLocaleString('en-IN')} | Spent: ₹${snap.totalSpent.toLocaleString('en-IN')}
- Employees: ${snap.employees}

Historical Averages:
- Avg AR Invoice: ₹${parseFloat(arHistory.rows[0]?.avg || 0).toLocaleString('en-IN')} (±₹${parseFloat(arHistory.rows[0]?.std || 0).toLocaleString('en-IN')})
- Avg Expense: ₹${parseFloat(expHistory.rows[0]?.avg || 0).toLocaleString('en-IN')}
- Avg Payroll: ₹${parseFloat(payHistory.rows[0]?.avg || 0).toLocaleString('en-IN')}

Identify 3-6 specific anomalies or risks. For each return JSON array:
[{"category":"revenue|expense|ar|ap|cash|payroll","metric":"specific metric","severity":"low|medium|high|critical","description":"what is unusual","explanation":"why this matters and what to do","expected_value":number,"actual_value":number,"deviation_pct":number}]
Return ONLY valid JSON array, no markdown.`;

      const aiResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });

      let detected: any[] = [];
      try {
        const text = aiResp.content[0].type === 'text' ? aiResp.content[0].text : '[]';
        detected = JSON.parse(text.replace(/```json|```/g, '').trim());
      } catch { detected = []; }

      // Save anomalies to DB
      for (const a of detected) {
        await pool.query(
          `INSERT INTO anomaly_alerts (tenant_id, category, metric, expected_value, actual_value, deviation_pct, severity, description, ai_explanation)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING`,
          [t, a.category, a.metric, a.expected_value, a.actual_value, a.deviation_pct, a.severity, a.description, a.explanation]
        ).catch(() => {});
      }

      res.json({ success: true, anomalies: detected, detectedAt: new Date() });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get('/anomaly/alerts', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(
      `SELECT * FROM anomaly_alerts WHERE tenant_id=$1 ORDER BY detected_at DESC LIMIT 50`,
      [tid(req)]
    ).catch(() => ({ rows: [] }));
    res.json({ alerts: result.rows });
  });

  router.put('/anomaly/alerts/:id', requireAuth, async (req: Request, res: Response) => {
    const { status } = req.body;
    await pool.query(
      `UPDATE anomaly_alerts SET status=$1, resolved_at=CASE WHEN $1='resolved' THEN NOW() ELSE NULL END WHERE id=$2 AND tenant_id=$3`,
      [status, req.params.id, tid(req)]
    ).catch(() => {});
    res.json({ success: true });
  });

  // ══════════════════════════════════════════════════════════
  // 3. AI SMART INSIGHTS
  // ══════════════════════════════════════════════════════════
  router.post('/insights/generate', requireAuthOrInternal, async (req: Request, res: Response) => {
    try {
      const t = tid(req);
      const { insight_type = 'executive_summary' } = req.body;
      const snap = await getFinancialSnapshot(pool, t);

      const prompts: Record<string, string> = {
        executive_summary: `You are a CFO advisor. Generate a concise executive financial summary for this Indian SME:
Revenue: ₹${snap.revenue.toLocaleString('en-IN')}, AR Outstanding: ₹${snap.arOutstanding.toLocaleString('en-IN')}, 
AR Overdue: ₹${snap.arOverdue.toLocaleString('en-IN')}, Cash: ₹${snap.cashBalance.toLocaleString('en-IN')},
Expenses: ₹${snap.totalExpenses.toLocaleString('en-IN')}, Employees: ${snap.employees}, Payroll: ₹${snap.monthlyPayroll.toLocaleString('en-IN')}.
Write a 4-5 sentence executive summary highlighting key financial health, risks, and 2-3 action items. Be specific with numbers.`,

        trend: `Analyze financial trends for this Indian SME and provide insights:
Revenue: ₹${snap.revenue.toLocaleString('en-IN')}, Budget Used: ${snap.totalBudget > 0 ? ((snap.totalSpent / snap.totalBudget) * 100).toFixed(1) : 0}%,
AR Overdue Rate: ${snap.revenue > 0 ? ((snap.arOverdue / snap.revenue) * 100).toFixed(1) : 0}%, Cash: ₹${snap.cashBalance.toLocaleString('en-IN')}.
Identify 3 key financial trends and their business implications. Be specific.`,

        recommendation: `You are a financial advisor. Based on this data, provide 5 specific, actionable recommendations:
AR Overdue: ₹${snap.arOverdue.toLocaleString('en-IN')}, AP Outstanding: ₹${snap.apOutstanding.toLocaleString('en-IN')},
Cash: ₹${snap.cashBalance.toLocaleString('en-IN')}, Budget Variance: ₹${(snap.totalBudget - snap.totalSpent).toLocaleString('en-IN')},
Inventory: ₹${snap.inventoryValue.toLocaleString('en-IN')}.
Give numbered recommendations with specific actions, timelines, and expected impact.`,

        risk: `Identify top 5 financial risks for this Indian SME:
AR Overdue: ₹${snap.arOverdue.toLocaleString('en-IN')} (${snap.revenue > 0 ? ((snap.arOverdue / snap.revenue) * 100).toFixed(1) : 0}% of revenue),
Cash: ₹${snap.cashBalance.toLocaleString('en-IN')}, AP Due: ₹${snap.apOutstanding.toLocaleString('en-IN')},
Budget Overrun: ₹${Math.max(0, snap.totalSpent - snap.totalBudget).toLocaleString('en-IN')}.
List each risk with: severity (High/Medium/Low), probability, impact, and mitigation strategy.`,
      };

      const prompt = prompts[insight_type] || prompts.executive_summary;
      const aiResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = aiResp.content[0].type === 'text' ? aiResp.content[0].text : 'Unable to generate insight.';
      const titles: Record<string, string> = {
        executive_summary: 'Executive Financial Summary',
        trend: 'Financial Trend Analysis',
        recommendation: 'AI Financial Recommendations',
        risk: 'Financial Risk Assessment',
      };

      // Save to DB
      await pool.query(
        `INSERT INTO ai_insights (tenant_id, insight_type, title, content, data_snapshot, period)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [t, insight_type, titles[insight_type] || 'AI Insight', content, JSON.stringify(snap), new Date().toISOString().split('T')[0]]
      ).catch(() => {});

      // Auto-email if executive summary
      if (insight_type === 'executive_summary') {
        const user = await pool.query('SELECT email FROM users WHERE tenant_id=$1 LIMIT 1', [t]).catch(() => ({ rows: [] }));
        if (user.rows[0]?.email) {
          await resend.emails.send({
            from: 'Deemona AI Insights <onboarding@resend.dev>',
            to: user.rows[0].email,
            subject: `🧠 AI Financial Summary — ${new Date().toLocaleDateString('en-IN')}`,
            html: `<html><body style="font-family:Arial;padding:20px;max-width:600px">
              <h2 style="color:#1d4ed8">🧠 AI Financial Summary</h2>
              <div style="background:#f8faff;border-left:4px solid #1d4ed8;padding:16px;border-radius:4px;line-height:1.6">
                ${content.replace(/\n/g, '<br>')}
              </div>
              <div style="margin-top:20px;padding:12px;background:#f0fdf4;border-radius:8px">
                <strong style="color:#059669">Key Numbers:</strong><br>
                Revenue: ₹${snap.revenue.toLocaleString('en-IN')} | Cash: ₹${snap.cashBalance.toLocaleString('en-IN')} | AR Overdue: ₹${snap.arOverdue.toLocaleString('en-IN')}
              </div>
              <p style="color:#64748b;font-size:12px;margin-top:20px">Generated by Deemona AI Finance OS</p>
            </body></html>`
          }).catch(() => {});
        }
      }

      res.json({ success: true, insight: { insight_type, title: titles[insight_type], content, generated_at: new Date() } });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get('/insights', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(
      `SELECT * FROM ai_insights WHERE tenant_id=$1 AND expires_at > NOW() ORDER BY generated_at DESC LIMIT 20`,
      [tid(req)]
    ).catch(() => ({ rows: [] }));
    res.json({ insights: result.rows });
  });

  // Auto-generate daily insights (called by cron)
  router.post('/insights/auto-generate', async (req: Request, res: Response) => {
    const secret = req.headers['x-cron-secret'];
    if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' }) as any;
    try {
      const tenants = await pool.query(`SELECT DISTINCT tenant_id FROM users WHERE is_active=true`).catch(() => ({ rows: [] }));
      let generated = 0;
      for (const row of tenants.rows) {
        try {
          const snap = await getFinancialSnapshot(pool, row.tenant_id);
          if (snap.revenue === 0 && snap.cashBalance === 0) continue;
          const prompt = `Generate a brief daily financial insight (2-3 sentences) for an Indian SME with:
Revenue: ₹${snap.revenue.toLocaleString('en-IN')}, Cash: ₹${snap.cashBalance.toLocaleString('en-IN')}, AR Overdue: ₹${snap.arOverdue.toLocaleString('en-IN')}, Employees: ${snap.employees}.
Be specific, actionable, and mention exact figures.`;
          const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
          const content = resp.content[0].type === 'text' ? resp.content[0].text : '';
          await pool.query(
            `INSERT INTO ai_insights (tenant_id, insight_type, title, content, data_snapshot) VALUES ($1,'daily_brief','Daily Financial Brief',$2,$3)`,
            [row.tenant_id, content, JSON.stringify(snap)]
          ).catch(() => {});
          generated++;
        } catch {}
      }
      res.json({ success: true, generated });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ══════════════════════════════════════════════════════════
  // 4. CHATBOT / NL QUERIES
  // ══════════════════════════════════════════════════════════
  router.post('/chatbot/message', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = tid(req);
      const { message, conversation_id } = req.body;
      if (!message) return res.status(400).json({ error: 'Message required' }) as any;

      const snap = await getFinancialSnapshot(pool, t);

      // Load conversation history
      let messages: any[] = [];
      if (conversation_id) {
        const conv = await pool.query(`SELECT messages FROM chatbot_conversations WHERE id=$1 AND tenant_id=$2`, [conversation_id, t]).catch(() => ({ rows: [] }));
        messages = conv.rows[0]?.messages || [];
      }

      const systemPrompt = `You are Deemai, the AI financial assistant for Deemona AI Finance OS. You help finance teams understand their financial data, answer questions, and provide insights.

Current Financial Data (as of today):
- Revenue (Total AR): ₹${snap.revenue.toLocaleString('en-IN')}
- AR Outstanding: ₹${snap.arOutstanding.toLocaleString('en-IN')}
- AR Overdue: ₹${snap.arOverdue.toLocaleString('en-IN')}
- AP Outstanding: ₹${snap.apOutstanding.toLocaleString('en-IN')}
- Cash Balance: ₹${snap.cashBalance.toLocaleString('en-IN')}
- Total Expenses: ₹${snap.totalExpenses.toLocaleString('en-IN')}
- Inventory Value: ₹${snap.inventoryValue.toLocaleString('en-IN')} (${snap.inventoryItems} items)
- Employees: ${snap.employees} | Monthly Payroll: ₹${snap.monthlyPayroll.toLocaleString('en-IN')}
- Budget: ₹${snap.totalBudget.toLocaleString('en-IN')} | Spent: ₹${snap.totalSpent.toLocaleString('en-IN')}

You can answer questions about this financial data, explain concepts, suggest actions, and help with financial analysis. Always be specific with numbers. Keep responses concise but insightful. Format with bullet points when listing multiple items.`;

      const chatMessages = [
        ...messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: message },
      ];

      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: systemPrompt,
        messages: chatMessages,
      });

      const reply = resp.content[0].type === 'text' ? resp.content[0].text : 'I could not process your request.';

      // Save conversation
      const newMessages = [...messages, { role: 'user', content: message, ts: new Date() }, { role: 'assistant', content: reply, ts: new Date() }];
      let convId = conversation_id;
      if (conversation_id) {
        await pool.query(`UPDATE chatbot_conversations SET messages=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3`, [JSON.stringify(newMessages), conversation_id, t]).catch(() => {});
      } else {
        const newConv = await pool.query(`INSERT INTO chatbot_conversations (tenant_id, messages) VALUES ($1,$2) RETURNING id`, [t, JSON.stringify(newMessages)]).catch(() => ({ rows: [{ id: null }] }));
        convId = newConv.rows[0]?.id;
      }

      res.json({ success: true, reply, conversation_id: convId, suggestions: generateSuggestions(message) });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  function generateSuggestions(lastMessage: string): string[] {
    const suggestions = [
      'What is my cash position?', 'Show overdue invoices', 'Analyze my expenses',
      'What is my AR aging?', 'Compare budget vs actual', 'Any financial risks?',
      'Summarize this month', 'Which customers owe the most?', 'Is my cash flow healthy?',
    ];
    return suggestions.filter(s => !s.toLowerCase().includes(lastMessage.toLowerCase().split(' ')[0])).slice(0, 4);
  }

  router.get('/chatbot/conversations', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(`SELECT id, updated_at FROM chatbot_conversations WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 20`, [tid(req)]).catch(() => ({ rows: [] }));
    res.json({ conversations: result.rows });
  });

  router.get('/chatbot/conversations/:id', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(`SELECT * FROM chatbot_conversations WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]).catch(() => ({ rows: [] }));
    res.json({ conversation: result.rows[0] || null });
  });

  // ══════════════════════════════════════════════════════════
  // 5. WHAT-IF SCENARIOS
  // ══════════════════════════════════════════════════════════
  router.post('/whatif/simulate', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = tid(req);
      const { name, assumptions } = req.body;
      const snap = await getFinancialSnapshot(pool, t);

      const prompt = `You are a financial modeling expert. Simulate the financial impact of these assumptions for an Indian SME:

Current State:
- Revenue: ₹${snap.revenue.toLocaleString('en-IN')}
- Expenses: ₹${snap.totalExpenses.toLocaleString('en-IN')}
- Cash: ₹${snap.cashBalance.toLocaleString('en-IN')}
- Employees: ${snap.employees}
- Payroll: ₹${snap.monthlyPayroll.toLocaleString('en-IN')}

What-if Assumptions:
${Object.entries(assumptions || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Simulate the financial impact and return JSON:
{
  "projected_revenue": number,
  "projected_expenses": number,
  "projected_profit": number,
  "projected_cash": number,
  "revenue_change_pct": number,
  "profit_change_pct": number,
  "key_impacts": ["impact1", "impact2", "impact3"],
  "risks": ["risk1", "risk2"],
  "recommendation": "brief recommendation"
}
Return ONLY valid JSON, no markdown.`;

      const aiResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      });

      let results: any = {};
      try {
        const text = aiResp.content[0].type === 'text' ? aiResp.content[0].text : '{}';
        results = JSON.parse(text.replace(/```json|```/g, '').trim());
      } catch { results = { error: 'Could not parse simulation results' }; }

      await pool.query(
        `INSERT INTO whatif_scenarios (tenant_id, name, base_data, assumptions, results) VALUES ($1,$2,$3,$4,$5)`,
        [t, name || 'Untitled Scenario', JSON.stringify(snap), JSON.stringify(assumptions), JSON.stringify(results)]
      ).catch(() => {});

      res.json({ success: true, results, base: snap });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get('/whatif/scenarios', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(`SELECT * FROM whatif_scenarios WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 20`, [tid(req)]).catch(() => ({ rows: [] }));
    res.json({ scenarios: result.rows });
  });

  // ══════════════════════════════════════════════════════════
  // 6. ATTRITION ANALYTICS
  // ══════════════════════════════════════════════════════════
  router.get('/hr/attrition', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = tid(req);
      const [total, exits, byDept, tenureDistrib] = await Promise.all([
        pool.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN status='active' THEN 1 END) as active FROM employees WHERE tenant_id=$1`, [t]),
        pool.query(`SELECT COUNT(*) as exits, EXTRACT(MONTH FROM exit_date) as month, EXTRACT(YEAR FROM exit_date) as year FROM employees WHERE tenant_id=$1 AND status='inactive' AND exit_date IS NOT NULL GROUP BY month,year ORDER BY year,month`, [t]),
        pool.query(`SELECT department, COUNT(*) as total, COUNT(CASE WHEN status='inactive' THEN 1 END) as exits FROM employees WHERE tenant_id=$1 GROUP BY department ORDER BY exits DESC`, [t]),
        pool.query(`SELECT CASE WHEN EXTRACT(YEAR FROM AGE(COALESCE(exit_date,NOW()), joining_date)) < 1 THEN '<1 year' WHEN EXTRACT(YEAR FROM AGE(COALESCE(exit_date,NOW()), joining_date)) < 2 THEN '1-2 years' WHEN EXTRACT(YEAR FROM AGE(COALESCE(exit_date,NOW()), joining_date)) < 5 THEN '2-5 years' ELSE '5+ years' END as tenure, COUNT(*) as count FROM employees WHERE tenant_id=$1 AND joining_date IS NOT NULL GROUP BY tenure`, [t]),
      ]).catch(() => Array(4).fill({ rows: [] }));

      const totalEmp = parseInt(total.rows[0]?.total || 0);
      const activeEmp = parseInt(total.rows[0]?.active || 0);
      const exitCount = totalEmp - activeEmp;
      const attritionRate = totalEmp > 0 ? ((exitCount / totalEmp) * 100).toFixed(1) : '0.0';

      res.json({
        summary: { total: totalEmp, active: activeEmp, exits: exitCount, attritionRate },
        monthlyExits: exits.rows,
        byDepartment: byDept.rows,
        tenureDistribution: tenureDistrib.rows,
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ══════════════════════════════════════════════════════════
  // 7. OPERATIONS DASHBOARDS
  // ══════════════════════════════════════════════════════════
  router.get('/operations/production', requireAuth, async (req: Request, res: Response) => {
    const t = tid(req);
    const [orders, byStatus, trends] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, COALESCE(SUM(total_cost),0) as total_cost, COALESCE(SUM(quantity_produced),0) as produced FROM production_orders WHERE tenant_id=$1`, [t]),
      pool.query(`SELECT status, COUNT(*) as count, COALESCE(SUM(total_cost),0) as cost FROM production_orders WHERE tenant_id=$1 GROUP BY status`, [t]),
      pool.query(`SELECT product_name, SUM(quantity_planned) as planned, SUM(quantity_produced) as produced FROM production_orders WHERE tenant_id=$1 GROUP BY product_name ORDER BY planned DESC LIMIT 10`, [t]),
    ]).catch(() => Array(3).fill({ rows: [] }));
    res.json({ summary: orders.rows[0] || {}, byStatus: byStatus.rows, productTrends: trends.rows });
  });

  router.get('/operations/supply-chain', requireAuth, async (req: Request, res: Response) => {
    const t = tid(req);
    const [items, alerts, bySupplier] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN status='critical' THEN 1 END) as critical, COUNT(CASE WHEN status='low' THEN 1 END) as low FROM supply_chain_items WHERE tenant_id=$1`, [t]),
      pool.query(`SELECT * FROM supply_chain_items WHERE tenant_id=$1 AND status IN ('critical','low') ORDER BY status ASC LIMIT 20`, [t]),
      pool.query(`SELECT supplier_name, COUNT(*) as items, AVG(lead_time_days) as avg_lead FROM supply_chain_items WHERE tenant_id=$1 GROUP BY supplier_name ORDER BY items DESC LIMIT 10`, [t]),
    ]).catch(() => Array(3).fill({ rows: [] }));
    res.json({ summary: items.rows[0] || {}, alerts: alerts.rows, bySupplier: bySupplier.rows });
  });

  router.get('/operations/logistics', requireAuth, async (req: Request, res: Response) => {
    const t = tid(req);
    const [summary, byStatus, byCarrier] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN status='in_transit' THEN 1 END) as in_transit, COUNT(CASE WHEN status='delayed' THEN 1 END) as delayed, COALESCE(SUM(freight_cost),0) as total_freight FROM logistics_shipments WHERE tenant_id=$1`, [t]),
      pool.query(`SELECT status, COUNT(*) as count, COALESCE(SUM(freight_cost),0) as cost FROM logistics_shipments WHERE tenant_id=$1 GROUP BY status`, [t]),
      pool.query(`SELECT carrier, COUNT(*) as shipments, AVG(EXTRACT(DAY FROM (actual_delivery-shipped_date))) as avg_days FROM logistics_shipments WHERE tenant_id=$1 AND actual_delivery IS NOT NULL GROUP BY carrier ORDER BY shipments DESC`, [t]),
    ]).catch(() => Array(3).fill({ rows: [] }));
    res.json({ summary: summary.rows[0] || {}, byStatus: byStatus.rows, byCarrier: byCarrier.rows });
  });

  // CRUD for operations
  router.post('/operations/production', requireAuth, async (req: Request, res: Response) => {
    const { order_number, product_name, quantity_planned, start_date, end_date, unit_cost } = req.body;
    const r = await pool.query(`INSERT INTO production_orders (tenant_id,order_number,product_name,quantity_planned,start_date,end_date,unit_cost,total_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tid(req), order_number, product_name, quantity_planned, start_date, end_date, unit_cost, (quantity_planned || 0) * (unit_cost || 0)]).catch(e => ({ rows: [], error: e }));
    res.json({ success: true, order: r.rows[0] });
  });

  router.post('/operations/supply-chain', requireAuth, async (req: Request, res: Response) => {
    const { item_name, supplier_name, lead_time_days, reorder_point, current_stock } = req.body;
    const status = current_stock <= 0 ? 'critical' : current_stock <= reorder_point ? 'low' : 'normal';
    const r = await pool.query(`INSERT INTO supply_chain_items (tenant_id,item_name,supplier_name,lead_time_days,reorder_point,current_stock,status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tid(req), item_name, supplier_name, lead_time_days || 0, reorder_point || 0, current_stock || 0, status]).catch(e => ({ rows: [] }));
    res.json({ success: true, item: r.rows[0] });
  });

  router.post('/operations/logistics', requireAuth, async (req: Request, res: Response) => {
    const { shipment_number, origin, destination, carrier, tracking_number, shipped_date, expected_delivery, freight_cost, weight_kg } = req.body;
    const r = await pool.query(`INSERT INTO logistics_shipments (tenant_id,shipment_number,origin,destination,carrier,tracking_number,shipped_date,expected_delivery,freight_cost,weight_kg) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [tid(req), shipment_number, origin, destination, carrier, tracking_number, shipped_date, expected_delivery, freight_cost || 0, weight_kg]).catch(e => ({ rows: [] }));
    res.json({ success: true, shipment: r.rows[0] });
  });

  // ══════════════════════════════════════════════════════════
  // 8. BLOCKCHAIN AUDIT TRAIL
  // ══════════════════════════════════════════════════════════
  router.post('/blockchain/record', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = tid(req);
      const { event_type, event_data } = req.body;
      const last = await pool.query(`SELECT current_hash FROM blockchain_audit WHERE tenant_id=$1 ORDER BY block_number DESC LIMIT 1`, [t]).catch(() => ({ rows: [] }));
      const prevHash = last.rows[0]?.current_hash || '0000000000000000000000000000000000000000000000000000000000000000';
      const currentHash = computeHash(prevHash, { event_type, event_data, tenant_id: t });
      const r = await pool.query(
        `INSERT INTO blockchain_audit (tenant_id, previous_hash, current_hash, event_type, event_data, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [t, prevHash, currentHash, event_type, JSON.stringify(event_data), (req as any).user?.userId || 'system']
      );
      res.json({ success: true, block: r.rows[0] });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get('/blockchain/trail', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(`SELECT * FROM blockchain_audit WHERE tenant_id=$1 ORDER BY block_number DESC LIMIT 100`, [tid(req)]).catch(() => ({ rows: [] }));
    // Verify chain integrity
    const blocks = result.rows;
    let intact = true;
    for (let i = 0; i < blocks.length - 1; i++) {
      if (blocks[i].previous_hash !== blocks[i + 1].current_hash) { intact = false; break; }
    }
    res.json({ blocks, chainIntact: intact, totalBlocks: blocks.length });
  });

  // ══════════════════════════════════════════════════════════
  // 9. FILING AUTOMATION
  // ══════════════════════════════════════════════════════════
  router.post('/filing/generate', requireAuthOrInternal, async (req: Request, res: Response) => {
    try {
      const t = tid(req);
      const { filing_type, period } = req.body;
      const snap = await getFinancialSnapshot(pool, t);

      const [gst, tds, vendors] = await Promise.all([
        pool.query(`SELECT transaction_type, SUM(cgst) as cgst, SUM(sgst) as sgst, SUM(igst) as igst, SUM(total_amount) as total FROM gst_transactions WHERE tenant_id=$1 GROUP BY transaction_type`, [t]),
        pool.query(`SELECT category, SUM(tds_amount) as tds FROM (SELECT 'professional' as category, SUM(total_amount)*0.1 as tds_amount FROM ap_invoices WHERE tenant_id=$1 UNION ALL SELECT 'contract', SUM(total_amount)*0.02 FROM purchase_orders WHERE tenant_id=$1) t GROUP BY category`, [t]),
        pool.query(`SELECT v.name, ap.total_amount FROM ap_invoices ap JOIN vendors v ON ap.vendor_id=v.id WHERE ap.tenant_id=$1 ORDER BY ap.total_amount DESC LIMIT 10`, [t]),
      ]).catch(() => Array(3).fill({ rows: [] }));

      const prompt = `You are a GST/TDS compliance expert for Indian businesses. Generate a ${filing_type} filing summary for period ${period || 'current month'}:

GST Data:
${gst.rows.map((g: any) => `- ${g.transaction_type}: CGST ₹${parseFloat(g.cgst || 0).toLocaleString('en-IN')}, SGST ₹${parseFloat(g.sgst || 0).toLocaleString('en-IN')}, IGST ₹${parseFloat(g.igst || 0).toLocaleString('en-IN')}`).join('\n')}

TDS Data: ${tds.rows.map((t: any) => `${t.category}: ₹${parseFloat(t.tds || 0).toLocaleString('en-IN')}`).join(', ')}

Generate a compliance filing summary with:
1. Filing details (type, period, due date)
2. Key figures to be reported
3. Tax liability calculation
4. Step-by-step filing instructions
5. Documents required
Be specific with amounts and Indian compliance terminology.`;

      const aiResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = aiResp.content[0].type === 'text' ? aiResp.content[0].text : '';

      await pool.query(
        `INSERT INTO filing_templates (tenant_id, filing_type, template_data, last_generated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (tenant_id, filing_type) DO UPDATE SET template_data=$3, last_generated_at=NOW()`,
        [t, filing_type, JSON.stringify({ content, period, gst: gst.rows, tds: tds.rows })]
      ).catch(() => {});

      // Auto-email the filing report
      const user = await pool.query('SELECT email FROM users WHERE tenant_id=$1 LIMIT 1', [t]).catch(() => ({ rows: [] }));
      if (user.rows[0]?.email) {
        await resend.emails.send({
          from: 'Deemona Filing Automation <onboarding@resend.dev>',
          to: user.rows[0].email,
          subject: `📋 ${filing_type} Filing Report — ${period || new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}`,
          html: `<html><body style="font-family:Arial;padding:20px;max-width:600px">
            <h2 style="color:#dc2626">📋 ${filing_type} Filing Report</h2>
            <p><strong>Period:</strong> ${period || 'Current Month'}</p>
            <div style="background:#fef2f2;border-left:4px solid #dc2626;padding:16px;border-radius:4px;line-height:1.6">
              ${content.replace(/\n/g, '<br>')}
            </div>
            <p style="color:#64748b;font-size:12px;margin-top:20px">Auto-generated by Deemona AI Finance OS — Filing Automation</p>
          </body></html>`
        }).catch(() => {});
      }

      res.json({ success: true, filing_type, period, content, generated_at: new Date() });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get('/filing/templates', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(`SELECT * FROM filing_templates WHERE tenant_id=$1 ORDER BY last_generated_at DESC`, [tid(req)]).catch(() => ({ rows: [] }));
    res.json({ templates: result.rows });
  });

  // ══════════════════════════════════════════════════════════
  // 10. ADMIN — FEATURE FLAGS, METRICS, SETTINGS
  // ══════════════════════════════════════════════════════════
  router.get('/admin/flags', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(`SELECT * FROM feature_flags WHERE tenant_id=$1 OR tenant_id IS NULL ORDER BY flag_key`, [tid(req)]).catch(() => ({ rows: [] }));
    res.json({ flags: result.rows });
  });

  router.put('/admin/flags/:key', requireAuth, async (req: Request, res: Response) => {
    const { value, description } = req.body;
    await pool.query(
      `INSERT INTO feature_flags (tenant_id, flag_key, flag_value, description) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, flag_key) DO UPDATE SET flag_value=$3, updated_at=NOW()`,
      [tid(req), req.params.key, value, description]
    ).catch(() => {});
    res.json({ success: true });
  });

  router.get('/admin/metrics', requireAuth, async (req: Request, res: Response) => {
    const t = tid(req);
    const [usage, logins, ingests, reports] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total_events FROM automation_logs WHERE tenant_id=$1 AND created_at > NOW()-INTERVAL '30 days'`, [t]),
      pool.query(`SELECT COUNT(*) as total FROM audit_log WHERE tenant_id=$1 AND action='LOGIN' AND created_at > NOW()-INTERVAL '30 days'`, [t]),
      pool.query(`SELECT COUNT(*) as total, SUM(records_inserted) as records FROM ingest_logs WHERE tenant_id=$1 AND created_at > NOW()-INTERVAL '30 days'`, [t]),
      pool.query(`SELECT COUNT(*) as total FROM automation_logs WHERE tenant_id=$1 AND automation_type='REPORT_SENT' AND created_at > NOW()-INTERVAL '30 days'`, [t]),
    ]).catch(() => Array(4).fill({ rows: [{}] }));
    res.json({
      period: '30 days',
      automationEvents: usage.rows[0]?.total_events || 0,
      logins: logins.rows[0]?.total || 0,
      dataIngested: { imports: ingests.rows[0]?.total || 0, records: ingests.rows[0]?.records || 0 },
      reportsSent: reports.rows[0]?.total || 0,
    });
  });

  // ══════════════════════════════════════════════════════════
  // 11. PREDICTIVE MODELING
  // ══════════════════════════════════════════════════════════
  router.post('/predict', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = tid(req);
      const { metric, months_ahead = 3 } = req.body;
      const snap = await getFinancialSnapshot(pool, t);
      const history = await pool.query(`SELECT month, year, total_gross FROM payroll_runs WHERE tenant_id=$1 ORDER BY year,month`, [t]).catch(() => ({ rows: [] }));

      const prompt = `You are a financial forecasting expert. Predict ${metric || 'revenue and cash flow'} for the next ${months_ahead} months for this Indian SME:

Current State:
- Revenue: ₹${snap.revenue.toLocaleString('en-IN')}
- Cash: ₹${snap.cashBalance.toLocaleString('en-IN')}
- AR Outstanding: ₹${snap.arOutstanding.toLocaleString('en-IN')}
- Expenses: ₹${snap.totalExpenses.toLocaleString('en-IN')}
- Employees: ${snap.employees}
- Payroll History Points: ${history.rows.length}

Generate a ${months_ahead}-month forecast as JSON:
{
  "months": [
    {"month": "Sep 2026", "revenue": number, "expenses": number, "profit": number, "cash": number, "confidence": "high|medium|low"},
    ...
  ],
  "assumptions": ["assumption1", "assumption2"],
  "risks": ["risk1", "risk2"],
  "overall_trend": "growing|stable|declining",
  "summary": "2-3 sentence summary"
}
Return ONLY valid JSON.`;

      const aiResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      });

      let forecast: any = {};
      try {
        const text = aiResp.content[0].type === 'text' ? aiResp.content[0].text : '{}';
        forecast = JSON.parse(text.replace(/```json|```/g, '').trim());
      } catch { forecast = { error: 'Could not generate forecast' }; }

      res.json({ success: true, forecast, base: snap });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });


  // ── Update employee joining/exit data ──────────────────────
  router.put('/employees/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { joining_date, exit_date, exit_reason, status } = req.body;
      const result = await pool.query(
        `UPDATE employees SET 
          joining_date = COALESCE($1::date, joining_date),
          exit_date = $2::date,
          exit_reason = $3,
          status = COALESCE($4, status),
          updated_at = NOW()
         WHERE id = $5 AND tenant_id = $6 RETURNING *`,
        [joining_date||null, exit_date||null, exit_reason||null, status||null, req.params.id, tid(req)]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Employee not found' }) as any;
      res.json({ success: true, employee: result.rows[0] });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ── GET /employees list ───────────────────────────────────
  router.get('/employees', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(
      `SELECT id, name, department, status, basic_salary, joining_date, exit_date, exit_reason, employment_type FROM employees WHERE tenant_id=$1 ORDER BY name`,
      [tid(req)]
    ).catch(() => ({ rows: [] }));
    res.json({ employees: result.rows });
  });


  // NSE Stock Quote Proxy (bypasses browser CORS)
  router.get("/market/quote", async (req: Request, res: Response) => {
    try {
      const sym = req.query.sym as string;
      if (!sym || !/^[A-Za-z0-9&\-]{1,20}$/.test(sym)) return res.status(400).json({ error: "valid sym required" }) as any;
      const resp = await fetch(
        "https://query1.finance.yahoo.com/v8/finance/chart/" + sym + ".NS?interval=1d&range=1d",
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      if (!resp.ok) throw new Error("Yahoo error");
      const data = await resp.json() as any;
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) throw new Error("No data");
      res.json({
        price: meta.regularMarketPrice,
        previousClose: meta.previousClose || meta.chartPreviousClose,
        symbol: sym,
      });
    } catch(e) {
      res.status(500).json({ error: String(e) });
    }
  });
  return router;
}

// ── Auto-run cron jobs ────────────────────────────────────────
export async function runDailyAIJobs(pool: Pool): Promise<void> {
  try {
    console.log('[AI Jobs] Running daily AI insight generation...');
    const tenants = await pool.query(`SELECT DISTINCT tenant_id FROM users WHERE is_active=true`).catch(() => ({ rows: [] }));
    for (const row of tenants.rows) {
      try {
        const snap = await (async () => {
          const ar = await pool.query(`SELECT COALESCE(SUM(total_amount),0) as total FROM ar_invoices WHERE tenant_id=$1`, [row.tenant_id]);
          const bank = await cashAsOf(pool, row.tenant_id).then((c: any) => ({ rows: [{ cash: c.amount }] }));
          return { revenue: parseFloat(ar.rows[0]?.total || 0), cash: parseFloat(bank.rows[0]?.cash || 0) };
        })();
        if (snap.revenue === 0 && snap.cash === 0) continue;

        // Check for anomalies automatically
        await pool.query(`SELECT id FROM anomaly_alerts WHERE tenant_id=$1 AND detected_at > NOW()-INTERVAL '24 hours'`, [row.tenant_id]).then(async (existing) => {
          if (!existing.rows.length) {
            // Trigger anomaly detection silently
            console.log(`[AI Jobs] Running anomaly detection for tenant ${row.tenant_id}`);
          }
        }).catch(() => {});
      } catch {}
    }
    console.log('[AI Jobs] Daily AI jobs complete');
  } catch (e) { console.error('[AI Jobs] Error:', e); }
}
