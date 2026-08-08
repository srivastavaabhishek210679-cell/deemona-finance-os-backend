import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function createForecastingRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/forecasting/cash-flow ────────────────────────
  router.get('/cash-flow', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const days = parseInt(req.query.days as string) || 90;

      // Get historical data
      const [banks, arPending, apPending, payroll, txnTrend] = await Promise.all([
        pool.query('SELECT COALESCE(SUM(current_balance),0) as total FROM bank_accounts WHERE tenant_id=$1 AND is_active=TRUE', [tenantId]),
        pool.query(`SELECT COALESCE(SUM(balance_due),0) as total, due_date FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled') GROUP BY due_date ORDER BY due_date`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(balance_due),0) as total, due_date FROM ap_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','rejected') GROUP BY due_date ORDER BY due_date`, [tenantId]),
        pool.query(`SELECT COALESCE(SUM(total_gross),0) as monthly FROM payroll_runs WHERE tenant_id=$1 AND status IN ('paid','approved') ORDER BY year DESC, month DESC LIMIT 1`, [tenantId]),
        pool.query(`SELECT type, AVG(amount) as avg_amount, COUNT(*) as count FROM bank_transactions WHERE tenant_id=$1 AND date >= CURRENT_DATE - INTERVAL '90 days' GROUP BY type`, [tenantId]),
      ]);

      const currentCash = parseFloat(banks.rows[0].total);
      const monthlyPayroll = parseFloat(payroll.rows[0].monthly) || 0;
      const avgMonthlyInflow = txnTrend.rows.find((r: any) => r.type === 'credit')?.avg_amount * 30 || 0;
      const avgMonthlyOutflow = txnTrend.rows.find((r: any) => r.type === 'debit')?.avg_amount * 30 || monthlyPayroll;

      // Build day-by-day forecast
      const forecast: any[] = [];
      let runningBalance = currentCash;
      const today = new Date();

      for (let d = 0; d < days; d++) {
        const date = new Date(today);
        date.setDate(today.getDate() + d);
        const dateStr = date.toISOString().split('T')[0];

        // Expected inflows on this date (from AR)
        const arInflow = arPending.rows
          .filter((r: any) => r.due_date?.toISOString?.().split('T')[0] === dateStr)
          .reduce((s: number, r: any) => s + parseFloat(r.total), 0);

        // Expected outflows on this date (from AP)
        const apOutflow = apPending.rows
          .filter((r: any) => r.due_date?.toISOString?.().split('T')[0] === dateStr)
          .reduce((s: number, r: any) => s + parseFloat(r.total), 0);

        // Daily operational costs (payroll + overhead spread daily)
        const dailyOps = avgMonthlyOutflow / 30;
        const dailyRevenue = avgMonthlyInflow / 30;

        const netChange = arInflow + dailyRevenue - apOutflow - dailyOps;
        runningBalance += netChange;

        if (d % 7 === 0 || arInflow > 0 || apOutflow > 0) { // Weekly + events
          forecast.push({
            date: dateStr,
            day: d + 1,
            opening: runningBalance - netChange,
            inflows: arInflow + dailyRevenue,
            outflows: apOutflow + dailyOps,
            net: netChange,
            closing: runningBalance,
            is_low: runningBalance < monthlyPayroll,
            is_negative: runningBalance < 0,
          });
        }
      }

      // Find critical dates
      const criticalDates = forecast.filter(f => f.is_low || f.is_negative);
      const lowestPoint = forecast.reduce((min, f) => f.closing < min.closing ? f : min, forecast[0]);
      const runway = monthlyPayroll > 0 ? currentCash / monthlyPayroll : 0;

      res.json({
        current_cash: currentCash,
        monthly_burn: avgMonthlyOutflow,
        monthly_revenue: avgMonthlyInflow,
        runway_months: parseFloat(runway.toFixed(1)),
        forecast_days: days,
        forecast,
        summary: {
          lowest_balance: lowestPoint?.closing || currentCash,
          lowest_date: lowestPoint?.date,
          critical_dates: criticalDates.length,
          ar_expected: arPending.rows.reduce((s: number, r: any) => s + parseFloat(r.total), 0),
          ap_expected: apPending.rows.reduce((s: number, r: any) => s + parseFloat(r.total), 0),
        },
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/forecasting/revenue ──────────────────────────
  router.get('/revenue', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const months = parseInt(req.query.months as string) || 6;

      // Historical AR invoices by month
      const historical = await pool.query(`
        SELECT
          EXTRACT(YEAR FROM date) as year,
          EXTRACT(MONTH FROM date) as month,
          COALESCE(SUM(total_amount),0) as invoiced,
          COALESCE(SUM(paid_amount),0) as collected,
          COUNT(*) as invoice_count
        FROM ar_invoices
        WHERE tenant_id=$1 AND status NOT IN ('draft','cancelled')
        AND date >= CURRENT_DATE - INTERVAL '12 months'
        GROUP BY year, month ORDER BY year, month
      `, [tenantId]);

      // Pipeline value weighted by probability
      const pipeline = await pool.query(`
        SELECT stage, COALESCE(SUM(value * probability / 100),0) as weighted_value
        FROM crm_leads WHERE tenant_id=$1 AND stage NOT IN ('won','lost')
        GROUP BY stage
      `, [tenantId]);

      // Calculate growth trend
      const hist = historical.rows;
      const avgMonthly = hist.length > 0
        ? hist.reduce((s: number, r: any) => s + parseFloat(r.invoiced), 0) / hist.length
        : 0;
      const lastMonth = hist[hist.length - 1];
      const prevMonth = hist[hist.length - 2];
      const growthRate = lastMonth && prevMonth && parseFloat(prevMonth.invoiced) > 0
        ? (parseFloat(lastMonth.invoiced) - parseFloat(prevMonth.invoiced)) / parseFloat(prevMonth.invoiced)
        : 0.05; // 5% default

      // Build forecast
      const forecastMonths: any[] = [];
      let baseRevenue = avgMonthly || 500000;
      const today = new Date();

      for (let m = 0; m < months; m++) {
        const forecastDate = new Date(today.getFullYear(), today.getMonth() + m + 1, 1);
        const predicted = baseRevenue * (1 + growthRate);
        baseRevenue = predicted;
        forecastMonths.push({
          year: forecastDate.getFullYear(),
          month: forecastDate.getMonth() + 1,
          month_name: forecastDate.toLocaleString('en-IN', { month: 'short', year: '2-digit' }),
          predicted_revenue: Math.round(predicted),
          conservative: Math.round(predicted * 0.8),
          optimistic: Math.round(predicted * 1.2),
          pipeline_contribution: parseFloat(pipeline.rows.reduce((s: number, r: any) => s + parseFloat(r.weighted_value), 0).toFixed(0)) / months,
        });
      }

      res.json({
        historical: hist,
        forecast: forecastMonths,
        growth_rate: parseFloat((growthRate * 100).toFixed(1)),
        avg_monthly_revenue: Math.round(avgMonthly),
        pipeline_value: parseFloat(pipeline.rows.reduce((s: number, r: any) => s + parseFloat(r.weighted_value), 0).toFixed(0)),
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/forecasting/expenses ─────────────────────────
  router.get('/expenses', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const months = parseInt(req.query.months as string) || 6;

      const historical = await pool.query(`
        SELECT
          EXTRACT(YEAR FROM date) as year,
          EXTRACT(MONTH FROM date) as month,
          COALESCE(SUM(total_amount),0) as total
        FROM ap_invoices
        WHERE tenant_id=$1 AND status NOT IN ('draft','rejected')
        AND date >= CURRENT_DATE - INTERVAL '12 months'
        GROUP BY year, month ORDER BY year, month
      `, [tenantId]);

      const payroll = await pool.query(`SELECT COALESCE(AVG(total_gross),0) as avg FROM payroll_runs WHERE tenant_id=$1 AND status='paid'`, [tenantId]);
      const avgPayroll = parseFloat(payroll.rows[0].avg) || 0;
      const hist = historical.rows;
      const avgMonthlyExp = hist.length > 0
        ? hist.reduce((s: number, r: any) => s + parseFloat(r.total), 0) / hist.length
        : 0;

      const forecast: any[] = [];
      const today = new Date();
      for (let m = 0; m < months; m++) {
        const forecastDate = new Date(today.getFullYear(), today.getMonth() + m + 1, 1);
        const inflation = 1 + (0.06 / 12); // 6% annual inflation
        const predicted = (avgMonthlyExp + avgPayroll) * Math.pow(inflation, m + 1);
        forecast.push({
          year: forecastDate.getFullYear(),
          month: forecastDate.getMonth() + 1,
          month_name: forecastDate.toLocaleString('en-IN', { month: 'short', year: '2-digit' }),
          predicted_expenses: Math.round(predicted),
          payroll: Math.round(avgPayroll),
          operations: Math.round(predicted - avgPayroll),
        });
      }

      res.json({ historical: hist, forecast, avg_monthly_expenses: Math.round(avgMonthlyExp + avgPayroll), avg_payroll: Math.round(avgPayroll) });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/forecasting/ai-insights ────────────────────
  router.post('/ai-insights', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { cash_forecast, revenue_forecast, expense_forecast } = req.body;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: 'You are a CFO-level financial analyst specializing in Indian SMEs. Analyze forecasts and provide actionable insights.',
        messages: [{
          role: 'user',
          content: `Analyze these financial forecasts and provide CFO-level insights:

Cash Flow: Current cash ${cash_forecast?.current_cash?.toLocaleString('en-IN')}, Runway ${cash_forecast?.runway_months} months, ${cash_forecast?.summary?.critical_dates} critical dates

Revenue: ${revenue_forecast?.growth_rate}% monthly growth, Avg monthly ${revenue_forecast?.avg_monthly_revenue?.toLocaleString('en-IN')}

Expenses: Avg monthly ${expense_forecast?.avg_monthly_expenses?.toLocaleString('en-IN')}, Payroll ${expense_forecast?.avg_payroll?.toLocaleString('en-IN')}

Provide:
1. TOP 3 RISKS (specific, with numbers)
2. TOP 3 OPPORTUNITIES 
3. RECOMMENDED ACTIONS (prioritized)
4. FINANCIAL HEALTH SCORE (0-100)

Be specific and reference actual numbers. Format clearly.`,
        }],
      });

      const insights = response.content[0].type === 'text' ? response.content[0].text : '';
      res.json({ insights });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
