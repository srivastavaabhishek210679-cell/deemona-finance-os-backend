const fs = require('fs');
const path = require('path');
const BACKEND = 'C:/deemona-finance-os/backend/src';

// ── Fix 1: WhatsApp Routes — ensure real Twilio wired ────────
const waFile = path.join(BACKEND.replace(/\//g,'\\'), 'routes', 'whatsappRoutes.ts');
const waContent = `import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

async function sendWA(to: string, message: string) {
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    return { success: false, error: 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN not set in environment variables' };
  }
  const toNum = to.startsWith('whatsapp:') ? to : \`whatsapp:+91\${to.replace(/\\D/g,'').slice(-10)}\`;
  try {
    const body = new URLSearchParams({ From: TWILIO_FROM, To: toNum, Body: message });
    const res = await fetch(\`https://api.twilio.com/2010-04-01/Accounts/\${TWILIO_SID}/Messages.json\`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(\`\${TWILIO_SID}:\${TWILIO_TOKEN}\`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const data = await res.json() as any;
    if (data.sid) return { success: true, sid: data.sid };
    return { success: false, error: data.message || JSON.stringify(data) };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

const TEMPLATES: Record<string, (d: any) => string> = {
  invoice_approval: d => \`*Deemona Finance* - Approval Required\\n\\nInvoice: \${d.invoice_number}\\nAmount: Rs \${parseFloat(d.amount||0).toLocaleString('en-IN')}\\nVendor: \${d.vendor}\\nDue: \${d.due_date}\\n\\nApprove at: https://deemona-finance-os-frontend.onrender.com/accounting\\n\\nReply APPROVE or REJECT\`,
  payment_received: d => \`Payment Received\\n\\nInvoice: \${d.invoice_number}\\nAmount: Rs \${parseFloat(d.amount||0).toLocaleString('en-IN')}\\nFrom: \${d.customer}\`,
  gst_reminder:     d => \`GST Filing Reminder\\n\\n\${d.filing_type} for \${d.period} due on \${d.due_date}\\nEstimated: Rs \${parseFloat(d.amount||0).toLocaleString('en-IN')}\`,
  payroll_approved: d => \`Payroll Approved\\n\\nMonth: \${d.month} \${d.year}\\nEmployees: \${d.count}\\nTotal: Rs \${parseFloat(d.amount||0).toLocaleString('en-IN')}\`,
  low_cash_alert:   d => \`Cash Alert\\n\\nCurrent position: Rs \${parseFloat(d.cash||0).toLocaleString('en-IN')}\\nRunway: \${d.runway} months\`,
  custom:           d => d.message || 'Message from Deemona Finance',
};

export function createWhatsAppRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.post('/send', requireAuth, async (req: Request, res: Response) => {
    try {
      const { to, template, data, message } = req.body;
      if (!to) return res.status(400).json({ error: 'Phone number required' }) as any;
      const fn = TEMPLATES[template] || TEMPLATES.custom;
      const body = message || fn({ ...data, message });
      const result = await sendWA(to, body);
      // Log
      await pool.query(
        \`INSERT INTO whatsapp_logs (tenant_id, to_number, template, message, status, twilio_sid, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT DO NOTHING\`,
        [tid(req), to, template||'custom', body, result.success?'sent':'failed', (result as any).sid||null]
      ).catch(()=>{});
      res.json(result);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/bulk', requireAuth, async (req: Request, res: Response) => {
    try {
      const { numbers, template, data } = req.body;
      if (!numbers?.length) return res.status(400).json({ error: 'Numbers array required' }) as any;
      const fn = TEMPLATES[template] || TEMPLATES.custom;
      const body = fn(data || {});
      const results = await Promise.allSettled(numbers.map((n: string) => sendWA(n, body)));
      const sent = results.filter(r => r.status === 'fulfilled' && (r.value as any).success).length;
      res.json({ sent, failed: results.length - sent, total: results.length });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get('/templates', requireAuth, async (_req, res) => {
    res.json({ templates: Object.keys(TEMPLATES).map(id => ({ id, name: id.replace(/_/g,' ') })) });
  });

  router.get('/logs', requireAuth, async (req: Request, res: Response) => {
    try {
      const r = await pool.query('SELECT * FROM whatsapp_logs WHERE tenant_id=$1 ORDER BY sent_at DESC LIMIT 50', [tid(req)]);
      res.json({ logs: r.rows });
    } catch { res.json({ logs: [] }); }
  });

  router.get('/status', requireAuth, async (_req, res) => {
    const configured = !!(TWILIO_SID && TWILIO_TOKEN);
    res.json({
      configured,
      from_number: TWILIO_FROM,
      message: configured ? 'WhatsApp ready to send' : 'Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to Render environment variables',
    });
  });

  router.post('/webhook', async (req: Request, res: Response) => {
    const { Body, From } = req.body;
    console.log('[WhatsApp webhook] From:', From, 'Body:', Body);
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Message>Thank you! Your response has been recorded in Deemona Finance.</Message></Response>');
  });

  return router;
}
`;
fs.writeFileSync(waFile, waContent, 'utf8');
console.log('✓ WhatsApp routes rewritten with real Twilio');

// ── Fix 2: Currency Routes with live exchange rates ───────────
const curFile = path.join(BACKEND.replace(/\//g,'\\'), 'routes', 'currencyRoutes.ts');
const curContent = `import { Router, Request, Response } from 'express';
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
    const res = await fetch(\`https://v6.exchangerate-api.com/v6/\${key}/latest/INR\`);
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
`;
fs.writeFileSync(curFile, curContent, 'utf8');
console.log('✓ Currency routes rewritten with live exchange rates + fallback');

console.log('\n✅ All backend fixes applied!');
console.log('\nNow add these env vars to Render backend service:');
console.log('  TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
console.log('  TWILIO_AUTH_TOKEN=your_auth_token');
console.log('  TWILIO_WHATSAPP_FROM=whatsapp:+14155238886');
console.log('  EXCHANGE_RATE_API_KEY=your_key (free at exchangerate-api.com)');
console.log('  SENDGRID_API_KEY=SG.xxxxxxx');
console.log('  FROM_EMAIL=noreply@yourdomain.com');
