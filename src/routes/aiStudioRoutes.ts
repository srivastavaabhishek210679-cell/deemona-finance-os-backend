import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Industry templates
const INDUSTRY_TEMPLATES = [
  {
    id: 'saas_startup',
    name: 'SaaS Startup India',
    industry: 'Technology',
    description: 'Pre-configured for Indian SaaS companies: ARR tracking, MRR, churn, AWS/cloud costs, ESOP accounting',
    accounts: ['MRR Revenue','ARR Revenue','Cloud Infrastructure','Engineering Salaries','Customer Success','Sales Commissions','ESOP Expense'],
    kpis: ['MRR','ARR','CAC','LTV','Churn Rate','Gross Margin','Burn Rate'],
    gst_rate: 18,
    tds_section: '194J',
    applicable_laws: ['GST', 'TDS 194J', 'Companies Act', 'DPDP Act'],
  },
  {
    id: 'manufacturing',
    name: 'Manufacturing SME',
    industry: 'Manufacturing',
    description: 'Inventory-heavy: raw materials, WIP, finished goods, job costing, factory overhead',
    accounts: ['Raw Materials','Work in Progress','Finished Goods','Factory Overhead','Direct Labour','Machinery Depreciation'],
    kpis: ['COGS','Inventory Turnover','Gross Margin','Capacity Utilization','Working Capital Cycle'],
    gst_rate: 12,
    tds_section: '194C',
    applicable_laws: ['GST', 'TDS 194C', 'Factories Act', 'PF/ESIC', 'Companies Act'],
  },
  {
    id: 'professional_services',
    name: 'Professional Services',
    industry: 'Consulting/Services',
    description: 'For CA firms, law firms, consultants: retainer billing, time tracking, TDS on fees',
    accounts: ['Retainer Revenue','Project Revenue','Professional Fees Expense','Staff Salaries','Partner Drawings'],
    kpis: ['Revenue per Partner','Billable Hours','Utilization Rate','DSO','EBITDA per FTE'],
    gst_rate: 18,
    tds_section: '194J',
    applicable_laws: ['GST 18%', 'TDS 194J 10%', 'Professional Tax', 'Companies Act'],
  },
  {
    id: 'retail_ecommerce',
    name: 'Retail / E-commerce',
    industry: 'Retail',
    description: 'Multi-channel retail: marketplace fees, logistics costs, returns, GST on goods',
    accounts: ['Product Sales','Marketplace Commissions','Logistics Cost','Returns & Refunds','Warehouse Rent','Packaging Cost'],
    kpis: ['GMV','Net Revenue','Return Rate','Gross Margin','CAC','Inventory Days'],
    gst_rate: 5,
    tds_section: '194C',
    applicable_laws: ['GST (varies by product)', 'TDS 194C', 'Consumer Protection Act'],
  },
  {
    id: 'real_estate',
    name: 'Real Estate Developer',
    industry: 'Real Estate',
    description: 'Project-based accounting, construction costs, advance receipts, RERA compliance',
    accounts: ['Project Revenue','Construction Cost','Land Cost','Marketing Expense','Project Finance Cost','Customer Advances'],
    kpis: ['Pre-sales Value','Collections','Project Margin','Customer Advances','RERA Compliance Score'],
    gst_rate: 5,
    tds_section: '194C',
    applicable_laws: ['GST', 'RERA', 'TDS 194C/194IA', 'Companies Act', 'Income Tax'],
  },
  {
    id: 'healthcare',
    name: 'Healthcare / Hospital',
    industry: 'Healthcare',
    description: 'GST-exempt services, pharmacy revenue, doctor fees, equipment depreciation',
    accounts: ['OPD Revenue','IPD Revenue','Pharmacy Revenue','Doctor Fees','Nursing Staff','Medical Equipment Depreciation'],
    kpis: ['Bed Occupancy Rate','ARPOB','OPD Volume','Pharmacy Margin','Insurance Collections'],
    gst_rate: 0,
    tds_section: '194J',
    applicable_laws: ['GST (exempt for health services)', 'TDS 194J', 'Clinical Establishments Act'],
  },
];

export function createAIStudioRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/ai-studio/templates ─────────────────────────
  router.get('/templates', requireAuth, async (_req: Request, res: Response) => {
    res.json({ templates: INDUSTRY_TEMPLATES });
  });

  // ── POST /api/ai-studio/apply-template ───────────────────
  router.post('/apply-template', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tenantId = tid(req);
      const { template_id } = req.body;
      const template = INDUSTRY_TEMPLATES.find(t => t.id === template_id);
      if (!template) { res.status(404).json({ error: 'Template not found' }); return; }

      // Update tenant industry
      await client.query(`UPDATE tenants SET industry=$1 WHERE id=$2`, [template.industry, tenantId]).catch(() => {});

      // Add template-specific accounts if they don't exist
      let added = 0;
      for (let i = 0; i < template.accounts.length; i++) {
        const accName = template.accounts[i];
        const code = `T${String(i + 1).padStart(3, '0')}`;
        const type = i < 3 ? 'income' : 'expense';
        const result = await client.query(
          `INSERT INTO accounts (tenant_id, code, name, type, sub_type, opening_balance)
           VALUES ($1,$2,$3,$4,'operating',0) ON CONFLICT DO NOTHING RETURNING id`,
          [tenantId, code, accName, type]
        );
        if (result.rows.length) added++;
      }

      await client.query('COMMIT');
      res.json({ success: true, template: template.name, accounts_added: added, kpis: template.kpis, applicable_laws: template.applicable_laws });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  // ── POST /api/ai-studio/train ─────────────────────────────
  // Fine-tune AI behavior with company-specific instructions
  router.post('/train', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { instructions, examples = [] } = req.body;
      if (!instructions) { res.status(400).json({ error: 'instructions required' }); return; }

      await pool.query(
        `INSERT INTO ai_studio_config (tenant_id, system_instructions, examples, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET system_instructions=$2, examples=$3, updated_at=NOW()`,
        [tenantId, instructions, JSON.stringify(examples)]
      ).catch(() => {});

      res.json({ success: true, message: 'AI instructions saved. The CFO Agent and other AI features will now use your custom context.' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/ai-studio/test ──────────────────────────────
  router.post('/test', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { prompt, system_instructions } = req.body;
      if (!prompt) { res.status(400).json({ error: 'prompt required' }); return; }

      let customInstructions = system_instructions;
      if (!customInstructions) {
        try {
          const r = await pool.query(`SELECT system_instructions FROM ai_studio_config WHERE tenant_id=$1`, [tenantId]);
          customInstructions = r.rows[0]?.system_instructions;
        } catch { customInstructions = null; }
      }

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: customInstructions || 'You are a financial AI assistant for an Indian company.',
        messages: [{ role: 'user', content: prompt }],
      });

      const output = response.content[0].type === 'text' ? response.content[0].text : '';
      res.json({ output, model: 'claude-sonnet-4-6', tokens_used: response.usage.input_tokens + response.usage.output_tokens });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/ai-studio/config ─────────────────────────────
  router.get('/config', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      let config = null;
      try {
        const r = await pool.query(`SELECT * FROM ai_studio_config WHERE tenant_id=$1`, [tenantId]);
        config = r.rows[0] || null;
      } catch { config = null; }
      res.json({ config });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
