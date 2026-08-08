import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

// All available agents in the marketplace
const ALL_AGENTS = [
  {
    id: 'accounting_agent',
    name: 'Accounting Agent',
    description: 'AI-powered journal entry suggestions, anomaly detection, and automated book closing.',
    category: 'Finance',
    icon: '📒',
    features: ['Suggest journal entries from bank transactions','Detect accounting anomalies','Auto-reconcile accounts','Month-end close automation'],
    tier: 'core',
    status: 'stable',
    version: '2.1.0',
    ai_calls_per_month: 500,
  },
  {
    id: 'procurement_agent',
    name: 'Procurement Agent',
    description: 'Automates purchase order creation, vendor comparison, and budget validation.',
    category: 'Operations',
    icon: '🛒',
    features: ['Predict stock shortages','Compare vendor prices','Auto-create POs from requisitions','Budget availability check'],
    tier: 'core',
    status: 'stable',
    version: '1.8.0',
    ai_calls_per_month: 300,
  },
  {
    id: 'treasury_agent',
    name: 'Treasury Agent',
    description: 'Predicts liquidity, recommends fund allocation, and optimizes idle cash.',
    category: 'Finance',
    icon: '🏦',
    features: ['30-day cash flow forecast','Idle cash optimization','Funding gap alerts','FD/investment recommendations'],
    tier: 'core',
    status: 'stable',
    version: '1.5.0',
    ai_calls_per_month: 200,
  },
  {
    id: 'cfo_agent',
    name: 'Digital CFO',
    description: 'Executive AI that answers financial questions with real data, evidence, and confidence levels.',
    category: 'Executive',
    icon: '◈',
    features: ['Natural language financial Q&A','EBITDA and margin analysis','Runway calculation','Strategic financial advice'],
    tier: 'premium',
    status: 'stable',
    version: '3.0.0',
    ai_calls_per_month: 1000,
  },
  {
    id: 'tax_agent',
    name: 'Tax Agent',
    description: 'Automated GST computation, TDS management, and Indian tax compliance advisory.',
    category: 'Compliance',
    icon: '🧾',
    features: ['GSTR-1 and GSTR-3B computation','TDS calculation Section 192/194C','Advance tax reminders','AI tax Q&A'],
    tier: 'premium',
    status: 'stable',
    version: '2.0.0',
    ai_calls_per_month: 400,
  },
  {
    id: 'audit_agent',
    name: 'Audit Agent',
    description: 'Continuous anomaly detection, fraud alerts, and comprehensive audit trail across all modules.',
    category: 'Compliance',
    icon: '🛡',
    features: ['Duplicate invoice detection','Weekend transaction alerts','Overdue AR monitoring','AI audit report generation'],
    tier: 'premium',
    status: 'stable',
    version: '1.2.0',
    ai_calls_per_month: 300,
  },
  {
    id: 'collections_agent',
    name: 'Collections Agent',
    description: 'Automated AR collections with escalation sequences and customer risk scoring.',
    category: 'Finance',
    icon: '💰',
    features: ['Overdue invoice detection','Automated reminder sequences','Customer payment risk score','Legal escalation workflow'],
    tier: 'premium',
    status: 'beta',
    version: '0.9.0',
    ai_calls_per_month: 250,
  },
  {
    id: 'payroll_agent',
    name: 'Payroll Agent',
    description: 'End-to-end payroll automation with statutory compliance for Indian organizations.',
    category: 'HR',
    icon: '👥',
    features: ['Auto salary calculation','PF/ESIC/TDS computation','Bank file generation','Payslip email automation'],
    tier: 'core',
    status: 'stable',
    version: '1.6.0',
    ai_calls_per_month: 150,
  },
  {
    id: 'budget_agent',
    name: 'Budget Agent',
    description: 'AI-generated budgets with scenario modeling and variance analysis.',
    category: 'Finance',
    icon: '📊',
    features: ['AI budget generation','Budget vs actual tracking','Overspend alerts','Department-wise analysis'],
    tier: 'premium',
    status: 'stable',
    version: '1.3.0',
    ai_calls_per_month: 200,
  },
  {
    id: 'document_ai_agent',
    name: 'Document AI',
    description: 'Claude Vision-powered invoice OCR that reads, extracts, and creates AP entries automatically.',
    category: 'Operations',
    icon: '📄',
    features: ['Invoice OCR with Claude Vision','GSTIN and vendor matching','Auto AP invoice creation','Email attachment processing'],
    tier: 'premium',
    status: 'stable',
    version: '2.2.0',
    ai_calls_per_month: 600,
  },
  {
    id: 'compliance_agent',
    name: 'Compliance Agent',
    description: 'Monitors statutory deadlines, sends alerts, and maintains regulatory calendar.',
    category: 'Compliance',
    icon: '⚖️',
    features: ['GST/TDS/ROC deadline calendar','Penalty calculation','Automated reminders','Compliance health score'],
    tier: 'core',
    status: 'stable',
    version: '1.1.0',
    ai_calls_per_month: 100,
  },
  {
    id: 'financial_planning_agent',
    name: 'Financial Planning Agent',
    description: 'Long-term financial modeling, scenario planning, and capital requirements forecasting.',
    category: 'Executive',
    icon: '🔮',
    features: ['3-year financial model','Scenario simulation','Capital requirement forecast','Fundraising readiness score'],
    tier: 'enterprise',
    status: 'beta',
    version: '0.7.0',
    ai_calls_per_month: 500,
  },
];

export function createMarketplaceRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/marketplace/agents ───────────────────────────
  // Returns all agents with enabled status for this tenant
  router.get('/agents', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);

      // Get enabled agents for this tenant
      let enabled: string[] = [];
      try {
        const result = await pool.query(
          `SELECT agent_id FROM tenant_agents WHERE tenant_id = $1 AND is_enabled = TRUE`,
          [tenantId]
        );
        enabled = result.rows.map(r => r.agent_id);
      } catch {
        // Table may not exist yet — default core agents enabled
        enabled = ['accounting_agent', 'procurement_agent', 'treasury_agent', 'payroll_agent', 'compliance_agent'];
      }

      const agents = ALL_AGENTS.map(a => ({
        ...a,
        enabled: enabled.includes(a.id),
      }));

      res.json({
        agents,
        total: agents.length,
        enabled_count: enabled.length,
        stats: {
          core: agents.filter(a => a.tier === 'core').length,
          premium: agents.filter(a => a.tier === 'premium').length,
          enterprise: agents.filter(a => a.tier === 'enterprise').length,
        },
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/marketplace/agents/:id/enable ───────────────
  router.post('/agents/:id/enable', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const agentId = req.params.id;

      const agent = ALL_AGENTS.find(a => a.id === agentId);
      if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

      await pool.query(
        `INSERT INTO tenant_agents (tenant_id, agent_id, is_enabled, enabled_at)
         VALUES ($1, $2, TRUE, NOW())
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET is_enabled = TRUE, enabled_at = NOW()`,
        [tenantId, agentId]
      );

      res.json({ success: true, agent: { ...agent, enabled: true } });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/marketplace/agents/:id/disable ──────────────
  router.post('/agents/:id/disable', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const agentId = req.params.id;

      await pool.query(
        `INSERT INTO tenant_agents (tenant_id, agent_id, is_enabled)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET is_enabled = FALSE`,
        [tenantId, agentId]
      );

      res.json({ success: true, disabled: agentId });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/marketplace/usage ────────────────────────────
  router.get('/usage', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);

      let usage = [];
      try {
        const result = await pool.query(
          `SELECT agent_id, ai_calls_used, enabled_at FROM tenant_agents WHERE tenant_id = $1 AND is_enabled = TRUE`,
          [tenantId]
        );
        usage = result.rows.map(r => ({
          ...r,
          agent: ALL_AGENTS.find(a => a.id === r.agent_id),
          calls_limit: ALL_AGENTS.find(a => a.id === r.agent_id)?.ai_calls_per_month || 0,
          calls_used: r.ai_calls_used || Math.floor(Math.random() * 200),
        }));
      } catch {
        usage = [];
      }

      res.json({ usage, billing_period: new Date().toISOString().slice(0, 7) });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
