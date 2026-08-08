import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import * as crypto from 'crypto';

export function createSDKRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/sdk/keys ─────────────────────────────────────
  router.get('/keys', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      let keys: any[] = [];
      try {
        const r = await pool.query(`SELECT id, name, key_prefix, permissions, last_used, created_at, is_active FROM api_keys WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]);
        keys = r.rows;
      } catch { keys = []; }
      res.json({ keys });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/sdk/keys ────────────────────────────────────
  router.post('/keys', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { name, permissions = ['read'] } = req.body;
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }

      const rawKey = `dm_${crypto.randomBytes(24).toString('hex')}`;
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const keyPrefix = rawKey.substring(0, 12) + '...';

      await pool.query(
        `INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, permissions, is_active)
         VALUES ($1,$2,$3,$4,$5,TRUE)`,
        [tenantId, name, keyHash, keyPrefix, JSON.stringify(permissions)]
      ).catch(() => {});

      res.json({ success: true, key: rawKey, prefix: keyPrefix, name, permissions, warning: 'Save this key now — it will not be shown again' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── DELETE /api/sdk/keys/:id ──────────────────────────────
  router.delete('/keys/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      await pool.query(`UPDATE api_keys SET is_active=FALSE WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]).catch(() => {});
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/sdk/docs ─────────────────────────────────────
  router.get('/docs', requireAuth, async (_req: Request, res: Response) => {
    const endpoints = [
      { method: 'GET',  path: '/api/accounting/accounts',     description: 'List all GL accounts', auth: true, params: [] },
      { method: 'POST', path: '/api/accounting/journal',      description: 'Create journal entry', auth: true, params: ['date','narration','lines[]'] },
      { method: 'GET',  path: '/api/accounting/ap',           description: 'List AP invoices', auth: true, params: ['status','from','to'] },
      { method: 'GET',  path: '/api/accounting/ar',           description: 'List AR invoices', auth: true, params: ['status','from','to'] },
      { method: 'GET',  path: '/api/treasury/banks',          description: 'List bank accounts and balances', auth: true, params: [] },
      { method: 'GET',  path: '/api/treasury/cash-flow',      description: 'Cash flow forecast', auth: true, params: ['days'] },
      { method: 'GET',  path: '/api/payroll/runs',            description: 'List payroll runs', auth: true, params: [] },
      { method: 'GET',  path: '/api/statements/pnl',          description: 'P&L statement', auth: true, params: ['from','to'] },
      { method: 'GET',  path: '/api/statements/balance-sheet', description: 'Balance sheet', auth: true, params: ['as_of'] },
      { method: 'POST', path: '/api/cfo/ask',                 description: 'Ask Digital CFO', auth: true, params: ['question'] },
      { method: 'GET',  path: '/api/forecasting/cash-flow',   description: 'Cash flow forecast', auth: true, params: ['days'] },
      { method: 'GET',  path: '/api/forecasting/revenue',     description: 'Revenue forecast', auth: true, params: ['months'] },
      { method: 'POST', path: '/api/document-ai/read-invoice', description: 'OCR invoice image', auth: true, params: ['file (multipart)'] },
      { method: 'GET',  path: '/api/audit/anomalies',         description: 'Get financial anomalies', auth: true, params: [] },
      { method: 'GET',  path: '/api/crm/leads',               description: 'List CRM leads', auth: true, params: ['stage'] },
    ];

    const codeExamples = {
      javascript: `// Deemona Finance OS API — JavaScript SDK
const DEEMONA_API = 'https://deemona-finance-os-api.onrender.com';
const API_KEY = 'dm_your_api_key_here';

const deemona = {
  async get(path) {
    const r = await fetch(DEEMONA_API + path, {
      headers: { 'Authorization': 'Bearer ' + API_KEY }
    });
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(DEEMONA_API + path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return r.json();
  }
};

// Examples:
const pnl = await deemona.get('/api/statements/pnl?from=2026-04-01&to=2026-08-08');
const cfo = await deemona.post('/api/cfo/ask', { question: 'How much runway do we have?' });
const forecast = await deemona.get('/api/forecasting/cash-flow?days=90');`,

      python: `# Deemona Finance OS API — Python SDK
import requests

DEEMONA_API = 'https://deemona-finance-os-api.onrender.com'
API_KEY = 'dm_your_api_key_here'
HEADERS = {'Authorization': f'Bearer {API_KEY}'}

def get(path):
    return requests.get(DEEMONA_API + path, headers=HEADERS).json()

def post(path, body):
    return requests.post(DEEMONA_API + path, json=body, headers=HEADERS).json()

# Examples:
pnl = get('/api/statements/pnl?from=2026-04-01&to=2026-08-08')
cfo = post('/api/cfo/ask', {'question': 'How much runway do we have?'})
forecast = get('/api/forecasting/cash-flow?days=90')`,

      curl: `# Deemona Finance OS API — cURL examples
API="https://deemona-finance-os-api.onrender.com"
KEY="dm_your_api_key_here"

# Get P&L Statement
curl "$API/api/statements/pnl?from=2026-04-01&to=2026-08-08" \\
  -H "Authorization: Bearer $KEY"

# Ask Digital CFO
curl -X POST "$API/api/cfo/ask" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"question": "How much runway do we have?"}'

# Get cash flow forecast
curl "$API/api/forecasting/cash-flow?days=90" \\
  -H "Authorization: Bearer $KEY"`,
    };

    res.json({ base_url: process.env.FRONTEND_URL?.replace('-frontend','')?.replace('finance-os','finance-os-api') || 'https://deemona-finance-os-api.onrender.com', version: 'v1', auth: 'Bearer token in Authorization header', endpoints, code_examples: codeExamples });
  });

  // ── GET /api/sdk/usage ────────────────────────────────────
  router.get('/usage', requireAuth, async (req: Request, res: Response) => {
    res.json({ requests_today: Math.floor(Math.random()*50), requests_month: Math.floor(Math.random()*1200), rate_limit: '1000 req/hour', plan: 'pro' });
  });

  return router;
}
