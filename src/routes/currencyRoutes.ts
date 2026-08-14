import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

// ============================================================
// Multi-Currency Support
// Uses exchangerate-api.com for live rates
// Env: EXCHANGE_RATE_API_KEY (get free key from exchangerate-api.com)
// ============================================================

const CURRENCIES = {
  INR: { symbol: '₹', name: 'Indian Rupee', flag: '🇮🇳' },
  USD: { symbol: '$', name: 'US Dollar', flag: '🇺🇸' },
  EUR: { symbol: '€', name: 'Euro', flag: '🇪🇺' },
  GBP: { symbol: '£', name: 'British Pound', flag: '🇬🇧' },
  AED: { symbol: 'د.إ', name: 'UAE Dirham', flag: '🇦🇪' },
  SGD: { symbol: 'S$', name: 'Singapore Dollar', flag: '🇸🇬' },
  JPY: { symbol: '¥', name: 'Japanese Yen', flag: '🇯🇵' },
  CAD: { symbol: 'C$', name: 'Canadian Dollar', flag: '🇨🇦' },
  AUD: { symbol: 'A$', name: 'Australian Dollar', flag: '🇦🇺' },
  CHF: { symbol: 'Fr', name: 'Swiss Franc', flag: '🇨🇭' },
};

// Fallback rates (approximate as of Aug 2026)
const FALLBACK_RATES: Record<string, number> = {
  USD: 83.5, EUR: 91.2, GBP: 105.8, AED: 22.7,
  SGD: 62.1, JPY: 0.55, CAD: 61.3, AUD: 54.8, CHF: 95.2,
};

let rateCache: { rates: Record<string, number>; timestamp: number } | null = null;

async function getExchangeRates(): Promise<Record<string, number>> {
  // Return cache if fresh (< 1 hour)
  if (rateCache && Date.now() - rateCache.timestamp < 3600000) {
    return rateCache.rates;
  }

  const apiKey = process.env.EXCHANGE_RATE_API_KEY;
  if (!apiKey) return FALLBACK_RATES;

  try {
    const res = await fetch(`https://v6.exchangerate-api.com/v6/${apiKey}/latest/INR`);
    const data = await res.json() as any;
    if (data.result === 'success') {
      const rates: Record<string, number> = {};
      Object.keys(CURRENCIES).forEach(cur => {
        if (cur !== 'INR' && data.conversion_rates[cur]) {
          rates[cur] = 1 / data.conversion_rates[cur]; // INR per 1 foreign currency
        }
      });
      rateCache = { rates, timestamp: Date.now() };
      return rates;
    }
  } catch { }
  return FALLBACK_RATES;
}

export function createCurrencyRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/currency/rates — Get live rates ───────────────
  router.get('/rates', requireAuth, async (_req: Request, res: Response) => {
    try {
      const rates = await getExchangeRates();
      res.json({
        base: 'INR',
        rates,
        currencies: CURRENCIES,
        cached: !!(rateCache && Date.now() - rateCache.timestamp < 3600000),
        timestamp: new Date().toISOString(),
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/currency/convert — Convert amount ────────────
  router.post('/convert', requireAuth, async (req: Request, res: Response) => {
    try {
      const { amount, from, to } = req.body;
      const rates = await getExchangeRates();
      let converted: number;

      if (from === 'INR') {
        converted = amount / (rates[to] || 1);
      } else if (to === 'INR') {
        converted = amount * (rates[from] || 1);
      } else {
        const inINR = amount * (rates[from] || 1);
        converted = inINR / (rates[to] || 1);
      }

      res.json({
        original: { amount, currency: from },
        converted: { amount: Math.round(converted * 100) / 100, currency: to },
        rate: rates[from] || rates[to] || 1,
        timestamp: new Date().toISOString(),
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/currency/list — List supported currencies ─────
  router.get('/list', requireAuth, async (_req: Request, res: Response) => {
    res.json({ currencies: CURRENCIES });
  });

  // ── POST /api/currency/invoice — Create multi-currency invoice
  router.post('/invoice', requireAuth, async (req: Request, res: Response) => {
    try {
      const { currency, amount, customer_id, invoice_number, notes } = req.body;
      const rates = await getExchangeRates();
      const amountINR = currency === 'INR' ? amount : amount * (rates[currency] || 1);

      const result = await pool.query(
        `INSERT INTO ar_invoices (tenant_id, customer_id, invoice_number, date, subtotal, tax_amount, total_amount, paid_amount, status, notes, currency)
         VALUES ($1,$2,$3,NOW(),$4,0,$4,0,'draft',$5,$6) RETURNING *`,
        [tid(req), customer_id, invoice_number || `INV-${Date.now()}`,
         amountINR, `${currency} ${amount} invoice. Exchange rate: 1 ${currency} = Rs ${rates[currency] || 1}. ${notes || ''}`,
         currency]
      );
      res.json({ invoice: result.rows[0], exchange_rate: rates[currency], amount_inr: amountINR });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
