// GET /api/cash-forecast?days=90&ar_delay_days=0&collection_pct=100&ap_delay_days=0&monthly_inflow=0&monthly_outflow=0
// Returns the base case, a "customers pay 30 days late" case and (when different) your custom case.
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { runForecast, loadForecastInputs, FcOpts } from '../services/cashForecast';

export function createCashForecastRouter(pool: Pool): Router {
  const router = Router();
  const num = (v: any, d: number, lo: number, hi: number): number => {
    const n = Number(v);
    return v === undefined || v === '' || !Number.isFinite(n) ? d : Math.max(lo, Math.min(hi, n));
  };
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const q = req.query as any;
      const custom: FcOpts = {
        days: num(q.days, 90, 7, 365),
        ar_delay_days: num(q.ar_delay_days, 0, 0, 180),
        collection_pct: num(q.collection_pct, 100, 0, 100),
        ap_delay_days: num(q.ap_delay_days, 0, 0, 180),
        monthly_inflow: num(q.monthly_inflow, 0, 0, 1e11),
        monthly_outflow: num(q.monthly_outflow, 0, 0, 1e11),
      };
      const base: FcOpts = { ...custom, ar_delay_days: 0, collection_pct: 100, ap_delay_days: 0 };
      const slow: FcOpts = { ...custom, ar_delay_days: 30, collection_pct: 100, ap_delay_days: 0 };
      const { opening, items, today } = await loadForecastInputs(pool, (req as any).user.tenantId);
      const same = (a: FcOpts, b: FcOpts) => a.ar_delay_days === b.ar_delay_days && a.collection_pct === b.collection_pct && a.ap_delay_days === b.ap_delay_days;
      const scenarios: any[] = [
        { key: 'base', label: 'As booked', ...runForecast(opening.amount, items, base, today) },
        { key: 'slow30', label: 'Customers pay 30 days late', ...runForecast(opening.amount, items, slow, today) },
      ];
      if (!same(custom, base) && !same(custom, slow)) scenarios.push({ key: 'custom', label: 'Your scenario', ...runForecast(opening.amount, items, custom, today) });
      const upcoming = items.map(i => ({ ...i })).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 25);
      res.json({
        as_of: today, has_cash_entry: opening.has_entry, opening: opening.amount, scenarios, upcoming,
        counts: { receivables: items.filter(i => i.kind === 'in').length, payables: items.filter(i => i.kind === 'out').length },
        note: 'Built only from your open invoices and bills plus the assumptions you set. Salaries, taxes and new sales that are not yet recorded are not included unless you enter them as monthly amounts.',
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  return router;
}
