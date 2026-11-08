import { Router, Request, Response } from 'express';
/*tenant-iso*/
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function createBudgetingRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.get('/budgets', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM budgets WHERE tenant_id = $1 ORDER BY fiscal_year DESC', [tid(req)]);
      res.json({ budgets: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/budgets', requireAuth, async (req: Request, res: Response) => {
    try {
      const { name, fiscal_year, department, type, notes } = req.body;
      const result = await pool.query(
        "INSERT INTO budgets (tenant_id, name, fiscal_year, department, type, notes, status) VALUES ($1,$2,$3,$4,$5,$6,'draft') RETURNING *",
        [tid(req), name, fiscal_year, department, type || 'annual', notes]
      );
      res.json({ budget: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get('/budgets/:id/lines', requireAuth, async (req: Request, res: Response) => {
    try {
      const own = await pool.query('SELECT 1 FROM budgets WHERE id=$1 AND tenant_id=$2', [req.params.id, tid(req)]);
      if (!own.rows.length) return res.status(404).json({ error: 'Not found' }) as any;
      const result = await pool.query('SELECT bl.*, a.name as account_name FROM budget_lines bl LEFT JOIN accounts a ON a.id = bl.account_id WHERE bl.budget_id = $1', [req.params.id]);
      res.json({ lines: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/budgets/:id/ai-generate', requireAuth, async (req: Request, res: Response) => {
    try {
      const { growth, inflation, headcount } = req.body;
      const budget = await pool.query('SELECT * FROM budgets WHERE id = $1 AND tenant_id = $2', [req.params.id, tid(req)]);
      if (!budget.rows.length) { res.status(404).json({ error: 'Budget not found' }); return; }

      const prompt = 'Generate a monthly budget for an Indian SME for FY' + budget.rows[0].fiscal_year
        + '. Assumptions: ' + growth + '% revenue growth, ' + inflation + '% cost inflation, ' + headcount + ' new hires.'
        + ' Return ONLY a JSON array. Each element: { "category": string, "jan": number, "feb": number, "mar": number, "apr": number, "may": number, "jun": number, "jul": number, "aug": number, "sep": number, "oct": number, "nov": number, "dec": number }.'
        + ' Categories: Salaries, Rent, Marketing, Technology, Travel, Professional Fees, Utilities, Miscellaneous.'
        + ' Use realistic INR amounts. Return valid JSON array only, no markdown, no explanation.';

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '[]';
      const clean = text.replace(/```json|```/g, '').trim();
      const linesData = JSON.parse(clean);

      await pool.query('DELETE FROM budget_lines WHERE budget_id = $1', [req.params.id]);
      const lines = [];
      let total = 0;
      for (const line of linesData) {
        const result = await pool.query(
          'INSERT INTO budget_lines (budget_id, category, jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',
          [req.params.id, line.category, line.jan||0, line.feb||0, line.mar||0, line.apr||0, line.may||0, line.jun||0, line.jul||0, line.aug||0, line.sep||0, line.oct||0, line.nov||0, line.dec||0]
        );
        lines.push(result.rows[0]);
        total += parseFloat(result.rows[0].annual_total || 0);
      }
      await pool.query("UPDATE budgets SET total_budgeted = $1, ai_generated = TRUE, status = 'active', updated_at = NOW() WHERE id = $2", [total, req.params.id]);
      res.json({ lines });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
