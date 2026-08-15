import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

const CURRENCIES: Record<string, { symbol: string; name: string; flag: string }> = {
  INR: { symbol: '₹', name: 'Indian Rupee',       flag: '🇮🇳' },
  USD: { symbol: '$', name: 'US Dollar',           flag: '🇺🇸' },
  EUR: { symbol: '€', name: 'Euro',                flag: '🇪🇺' },
  GBP: { symbol: '£', name: 'British Pound',       flag: '🇬🇧' },
  AED: { symbol: 'د.إ', name: 'UAE Dirham',       flag: '🇦🇪' },
  SGD: { symbol: 'S$', name: 'Singapore Dollar',   flag: '🇸🇬' },
  JPY: { symbol: '¥', name: 'Japanese Yen',        flag: '🇯🇵' },
  CAD: { symbol: 'C$', name: 'Canadian Dollar',    flag: '🇨🇦' },
  AUD: { symbol: 'A$', name: 'Australian Dollar',  flag: '🇦🇺' },
  CHF: { symbol: 'Fr', name: 'Swiss Franc',        flag: '🇨🇭' },
};

// Fallback rates (INR per 1 unit of foreign currency)
const FALLBACK: Record<string, number> = {
  USD: 83.5, EUR: 91.2, GBP: 105.8, AED: 22.7,
  SGD: 62.1, JPY: 0.55, CAD: 61.3, AUD: 54.8, CHF: 95.2,
};

let cache: { rates: Record<string, number>; ts: number } | null = null;

async function getRates(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.ts < 3600000) return cache.rates;
  const key = process.env.EXCHANGE_RATE_API_KEY;
  if (!key) {
    console.log('[Currency] No EXCHANGE_RATE_API_KEY — using fallback rates');
    return FALLBACK;
  }
  try {
    const res = await fetch(`https://v6.exchangerate-api.com/v6/${key}/latest/INR`);
    const data = await res.json() as any;
    if (data.result === 'success') {
      const rates: Record<string, number> = {};
      Object.keys(CURRENCIES).forEach(cur => {
        if (cur !== 'INR' && data.conversion_rates[cur]) {
          rates[cur] = parseFloat((1 / data.conversion_rates[cur]).toFixed(4));
        }
      });
      cache = { rates, ts: Date.now() };
      console.log('[Currency] Live rates fetched successfully');
      return rates;
    }
  } catch (err) {
    console.error('[Currency] API error:', err);
  }
  return FALLBACK;
}

export function createCurrencyRouter(pool: Pool): Router {
  const router = Router();

  router.get('/rates', requireAuth, async (_req, res: Response) => {
    try {
      const rates = await getRates();
      const apiKeySet = !!process.env.EXCHANGE_RATE_API_KEY;
      res.json({
        base: 'INR',
        rates,
        currencies: CURRENCIES,
        live: apiKeySet && cache !== null,
        fallback: !apiKeySet,
        message: apiKeySet ? 'Live rates from exchangerate-api.com' : 'Using fallback rates. Add EXCHANGE_RATE_API_KEY for live rates.',
        cached_at: cache ? new Date(cache.ts).toISOString() : null,
        timestamp: new Date().toISOString(),
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/convert', requireAuth, async (req: Request, res: Response) => {
    try {
      const { amount, from, to } = req.body;
      if (!amount || !from || !to) return res.status(400).json({ error: 'amount, from, to required' }) as any;
      const rates = await getRates();
      let converted: number;
      if (from === 'INR' && to !== 'INR') {
        converted = amount / (rates[to] || 1);
      } else if (to === 'INR' && from !== 'INR') {
        converted = amount * (rates[from] || 1);
      } else if (from === to) {
        converted = amount;
      } else {
        const inINR = amount * (rates[from] || 1);
        converted = inINR / (rates[to] || 1);
      }
      res.json({
        original: { amount: parseFloat(amount), currency: from, symbol: CURRENCIES[from]?.symbol || from },
        converted: { amount: parseFloat(converted.toFixed(2)), currency: to, symbol: CURRENCIES[to]?.symbol || to },
        rate: from === 'INR' ? 1/(rates[to]||1) : (rates[from]||1),
        timestamp: new Date().toISOString(),
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get('/list', requireAuth, async (_req, res) => {
    const rates = await getRates().catch(() => FALLBACK);
    res.json({
      currencies: Object.entries(CURRENCIES).map(([code, info]) => ({
        code, ...info, rate_to_inr: code === 'INR' ? 1 : (rates[code] || FALLBACK[code] || 0),
      })),
    });
  });

  return router;
}
