import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import * as net from 'net';
import { promises as dnsp } from 'dns';
import { requireAuth } from '../middleware/auth';

const tid = (req: Request): string => (req as any).user?.tenantId;

// ── Safety rules for user-supplied connections ───────────────
// Tables a connection may write into. Add more with ALLOWED_POLLER_TABLES=table_a,table_b on Render.
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_TABLES = new Set<string>([
  'ar_invoices', 'ap_invoices', 'customers', 'vendors', 'employees', 'expenses', 'crm_leads',
  'journal_entries', 'purchase_orders', 'inventory_items', 'payments', /*bankoff*/
  ...String(process.env.ALLOWED_POLLER_TABLES || '').split(',').map(s => s.trim()).filter(s => IDENT.test(s)),
]);
const PROTECTED_COLUMNS = new Set(['tenant_id', 'id']);
const AUTH_TYPES = ['none', 'api_key', 'basic', 'bearer', 'oauth2'];

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) { const rest = v.slice(7); return net.isIPv4(rest) ? isPrivateIp(rest) : true; }
  return v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v);
}

/** Only public https addresses. Blocks localhost, private networks and cloud metadata addresses. */
async function assertSafeUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (process.env.ALLOW_PRIVATE_POLLER_URLS === 'true') return u;
  if (u.protocol !== 'https:') throw new Error('Only https:// addresses are allowed');
  if (u.username || u.password) throw new Error('Do not put a username or password in the URL');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('This address points to an internal network and is not allowed');
  }
  const addrs = net.isIP(host) ? [{ address: host }] : await dnsp.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) {
    throw new Error('This address points to an internal network and is not allowed');
  }
  return u;
}

async function validateConnection(b: any, isCreate: boolean): Promise<string | null> {
  if (!b || typeof b !== 'object') return 'Invalid request';
  if (isCreate || b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 255) return 'name is required (max 255 characters)';
  }
  if (isCreate || b.source_type !== undefined) {
    if (typeof b.source_type !== 'string' || !b.source_type.trim() || b.source_type.length > 100) return 'source_type is required';
  }
  if (isCreate || b.base_url !== undefined) {
    try { await assertSafeUrl(String(b.base_url)); } catch (e: any) { return 'base_url: ' + e.message; }
  }
  if (isCreate || b.target_table !== undefined) {
    if (!ALLOWED_TABLES.has(String(b.target_table))) return 'target_table must be one of: ' + Array.from(ALLOWED_TABLES).join(', ');
  }
  if (b.auth_type !== undefined && b.auth_type !== null && !AUTH_TYPES.includes(b.auth_type)) return 'auth_type must be one of: ' + AUTH_TYPES.join(', ');
  if (b.poll_interval_seconds !== undefined && b.poll_interval_seconds !== null) {
    const n = Number(b.poll_interval_seconds);
    if (!Number.isInteger(n) || n < 60 || n > 86400) return 'poll_interval_seconds must be a whole number from 60 to 86400';
  }
  if (b.endpoints !== undefined && b.endpoints !== null) {
    if (!Array.isArray(b.endpoints) || b.endpoints.length > 5) return 'endpoints must be a list of at most 5';
    for (const ep of b.endpoints) {
      if (!ep || typeof ep.path !== 'string' || !ep.path.startsWith('/')) return 'each endpoint needs a path starting with /';
      if (ep.target_table !== undefined && !ALLOWED_TABLES.has(String(ep.target_table))) return 'endpoint target_table is not allowed: ' + ep.target_table;
    }
  }
  if (b.field_mapping !== undefined && b.field_mapping !== null) {
    if (typeof b.field_mapping !== 'object' || Array.isArray(b.field_mapping)) return 'field_mapping must be an object keyed by table';
    for (const [table, map] of Object.entries<any>(b.field_mapping)) {
      if (!ALLOWED_TABLES.has(table)) return 'field_mapping table is not allowed: ' + table;
      if (!map || typeof map !== 'object' || Array.isArray(map)) return 'field_mapping.' + table + ' must be an object';
      for (const dest of Object.values<any>(map)) {
        if (typeof dest !== 'string' || !IDENT.test(dest)) return 'field_mapping.' + table + ' has an invalid column name';
        if (PROTECTED_COLUMNS.has(dest)) return 'field_mapping cannot write to ' + dest;
      }
    }
  }
  return null;
}

// ── Universal REST Poller Routes ─────────────────────────────
// Allows users to connect ANY REST API source and auto-sync data

export function createUniversalPollerRouter(pool: Pool): Router {
  const router = Router();
  const bad = (res: Response, msg: string, code = 400) => res.status(code).json({ error: msg });

  // ── Setup poller_connections table ──────────────────────────
  const initTable = pool.query(`
    CREATE TABLE IF NOT EXISTS poller_connections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      name VARCHAR(255) NOT NULL,
      source_type VARCHAR(100) NOT NULL,
      base_url TEXT NOT NULL,
      auth_type VARCHAR(50) DEFAULT 'none',
      auth_config JSONB DEFAULT '{}',
      headers JSONB DEFAULT '{}',
      endpoints JSONB DEFAULT '[]',
      field_mapping JSONB DEFAULT '{}',
      target_table VARCHAR(100) NOT NULL,
      poll_interval_seconds INT DEFAULT 60,
      is_active BOOLEAN DEFAULT true,
      last_polled_at TIMESTAMPTZ,
      last_status VARCHAR(50) DEFAULT 'pending',
      last_error TEXT,
      records_synced INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS poller_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      connection_id UUID NOT NULL,
      status VARCHAR(50) NOT NULL,
      records_fetched INT DEFAULT 0,
      records_inserted INT DEFAULT 0,
      duration_ms INT,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(() => {});

  // ── GET /connections — list all connections ──────────────────
  router.get('/connections', requireAuth, async (req: Request, res: Response) => {
    const r = await pool.query(
      `SELECT * FROM poller_connections WHERE tenant_id=$1 ORDER BY created_at DESC`,
      [tid(req)]
    ).catch(() => ({ rows: [] }));
    res.json({ connections: r.rows });
  });

  // ── POST /connections — create new connection ────────────────
  router.post('/connections', requireAuth, async (req: Request, res: Response) => {
    try {
      const problem = await validateConnection(req.body, true);
      if (problem) return bad(res, problem) as any;
      const {
        name, source_type, base_url, auth_type, auth_config,
        headers, endpoints, field_mapping, target_table, poll_interval_seconds
      } = req.body;

      const r = await pool.query(
        `INSERT INTO poller_connections
          (tenant_id, name, source_type, base_url, auth_type, auth_config, headers, endpoints, field_mapping, target_table, poll_interval_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [tid(req), name, source_type, base_url, auth_type||'none',
         JSON.stringify(auth_config||{}), JSON.stringify(headers||{}),
         JSON.stringify(endpoints||[]), JSON.stringify(field_mapping||{}),
         target_table, poll_interval_seconds||300]
      );
      res.json({ connection: r.rows[0] });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ── PUT /connections/:id — update connection ─────────────────
  router.put('/connections/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!UUID.test(req.params.id)) return bad(res, 'invalid id') as any;
      const problem = await validateConnection(req.body, false);
      if (problem) return bad(res, problem) as any;
      const { name, base_url, auth_type, auth_config, headers, endpoints,
              field_mapping, target_table, poll_interval_seconds, is_active } = req.body;
      const r = await pool.query(
        `UPDATE poller_connections SET
          name=COALESCE($1,name), base_url=COALESCE($2,base_url),
          auth_type=COALESCE($3,auth_type), auth_config=COALESCE($4,auth_config),
          headers=COALESCE($5,headers), endpoints=COALESCE($6,endpoints),
          field_mapping=COALESCE($7,field_mapping), target_table=COALESCE($8,target_table),
          poll_interval_seconds=COALESCE($9,poll_interval_seconds),
          is_active=COALESCE($10,is_active), updated_at=NOW()
         WHERE id=$11 AND tenant_id=$12 RETURNING *`,
        [name, base_url, auth_type, auth_config?JSON.stringify(auth_config):null,
         headers?JSON.stringify(headers):null, endpoints?JSON.stringify(endpoints):null,
         field_mapping?JSON.stringify(field_mapping):null, target_table,
         poll_interval_seconds, is_active, req.params.id, tid(req)]
      );
      if (!r.rows[0]) return bad(res, 'Not found', 404) as any;
      res.json({ connection: r.rows[0] });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ── DELETE /connections/:id ──────────────────────────────────
  router.delete('/connections/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!UUID.test(req.params.id)) return bad(res, 'invalid id') as any;
      await pool.query(`DELETE FROM poller_connections WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ── POST /connections/:id/test — test connection ─────────────
  router.post('/connections/:id/test', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!UUID.test(req.params.id)) return bad(res, 'invalid id') as any;
      const conn = await pool.query(
        `SELECT * FROM poller_connections WHERE id=$1 AND tenant_id=$2`,
        [req.params.id, tid(req)]
      );
      if (!conn.rows[0]) return res.status(404).json({ error: 'Connection not found' }) as any;
      const c = conn.rows[0];
      const result = await fetchFromSource(c, 1);
      res.json({ success: true, sample_records: result.slice(0,3), total_fetched: result.length });
    } catch(e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ── POST /connections/:id/sync — manual sync ─────────────────
  router.post('/connections/:id/sync', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!UUID.test(req.params.id)) return bad(res, 'invalid id') as any;
      const conn = await pool.query(
        `SELECT * FROM poller_connections WHERE id=$1 AND tenant_id=$2`,
        [req.params.id, tid(req)]
      );
      if (!conn.rows[0]) return res.status(404).json({ error: 'Not found' }) as any;
      const result = await syncConnection(pool, conn.rows[0]);
      res.json(result);
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ── GET /connections/:id/logs ────────────────────────────────
  router.get('/connections/:id/logs', requireAuth, async (req: Request, res: Response) => {
    if (!UUID.test(req.params.id)) return bad(res, 'invalid id') as any;
    const r = await pool.query(
      `SELECT * FROM poller_logs WHERE connection_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id, tid(req)]
    ).catch(() => ({ rows: [] }));
    res.json({ logs: r.rows });
  });

  // ── GET /templates — source templates ───────────────────────
  router.get('/templates', requireAuth, async (_req: Request, res: Response) => {
    res.json({ templates: SOURCE_TEMPLATES });
  });

  return router;
}

// ── Source Templates ─────────────────────────────────────────
const SOURCE_TEMPLATES = [
  {
    id: 'netsuite',
    name: 'Oracle NetSuite',
    source_type: 'erp',
    icon: 'oracle',
    auth_type: 'oauth2',
    base_url: 'https://{accountId}.suitetalk.api.netsuite.com/services/rest/record/v1',
    endpoints: [
      { path: '/invoice', target_table: 'ar_invoices', method: 'GET', params: { limit: 100 } },
      { path: '/vendorbill', target_table: 'ap_invoices', method: 'GET', params: { limit: 100 } },
      { path: '/customer', target_table: 'customers', method: 'GET', params: { limit: 100 } },
      { path: '/vendor', target_table: 'vendors', method: 'GET', params: { limit: 100 } },
    ],
    field_mapping: {
      ar_invoices: { tranId: 'invoice_number', tranDate: 'invoice_date', dueDate: 'due_date', total: 'total_amount', status: 'status' },
      customers: { companyName: 'name', email: 'email', phone: 'phone' },
    },
    poll_interval_seconds: 60,
  },
  {
    id: 'salesforce',
    name: 'Salesforce CRM',
    source_type: 'crm',
    icon: 'salesforce',
    auth_type: 'oauth2',
    base_url: 'https://{instanceUrl}/services/data/v58.0',
    endpoints: [
      { path: '/sobjects/Opportunity/describe', target_table: 'crm_leads', method: 'GET' },
      { path: '/query?q=SELECT+Id,Name,Amount,CloseDate,StageName+FROM+Opportunity', target_table: 'crm_leads', method: 'GET' },
      { path: '/query?q=SELECT+Id,Name,BillingCity,Phone,AnnualRevenue+FROM+Account', target_table: 'customers', method: 'GET' },
    ],
    field_mapping: {
      crm_leads: { Name: 'company_name', Amount: 'deal_value', CloseDate: 'expected_close', StageName: 'stage' },
    },
    poll_interval_seconds: 120,
  },
  {
    id: 'zoho_books',
    name: 'Zoho Books',
    source_type: 'accounting',
    icon: 'zoho',
    auth_type: 'oauth2',
    base_url: 'https://www.zohoapis.in/books/v3',
    endpoints: [
      { path: '/invoices', target_table: 'ar_invoices', method: 'GET', params: { organization_id: '{orgId}' } },
      { path: '/bills', target_table: 'ap_invoices', method: 'GET', params: { organization_id: '{orgId}' } },
      { path: '/contacts', target_table: 'customers', method: 'GET', params: { organization_id: '{orgId}' } },
      { path: '/expenses', target_table: 'expenses', method: 'GET', params: { organization_id: '{orgId}' } },
    ],
    field_mapping: {
      ar_invoices: { invoice_number: 'invoice_number', date: 'invoice_date', due_date: 'due_date', total: 'total_amount' },
    },
    poll_interval_seconds: 60,
  },
  {
    id: 'hubspot',
    name: 'HubSpot CRM',
    source_type: 'crm',
    icon: 'hubspot',
    auth_type: 'api_key',
    base_url: 'https://api.hubapi.com',
    endpoints: [
      { path: '/crm/v3/objects/deals', target_table: 'crm_leads', method: 'GET', params: { limit: 100 } },
      { path: '/crm/v3/objects/companies', target_table: 'customers', method: 'GET', params: { limit: 100 } },
      { path: '/crm/v3/objects/contacts', target_table: 'customers', method: 'GET', params: { limit: 100 } },
    ],
    field_mapping: {
      crm_leads: { dealname: 'company_name', amount: 'deal_value', closedate: 'expected_close', dealstage: 'stage' },
    },
    poll_interval_seconds: 120,
  },
  {
    id: 'sap',
    name: 'SAP S/4HANA',
    source_type: 'erp',
    icon: 'sap',
    auth_type: 'basic',
    base_url: 'https://{host}/sap/opu/odata/sap',
    endpoints: [
      { path: '/API_BILLING_DOCUMENT_SRV/A_BillingDocument', target_table: 'ar_invoices', method: 'GET' },
      { path: '/API_SUPPLIER_INVOICE_SRV/A_SupplierInvoice', target_table: 'ap_invoices', method: 'GET' },
      { path: '/API_BUSINESS_PARTNER/A_BusinessPartner', target_table: 'customers', method: 'GET' },
    ],
    field_mapping: {
      ar_invoices: { BillingDocument: 'invoice_number', BillingDocumentDate: 'invoice_date', TotalNetAmount: 'subtotal' },
    },
    poll_interval_seconds: 60,
  },
  {
    id: 'odoo',
    name: 'Odoo ERP',
    source_type: 'erp',
    icon: 'odoo',
    auth_type: 'api_key',
    base_url: 'https://{host}/api',
    endpoints: [
      { path: '/account.move', target_table: 'ar_invoices', method: 'GET', params: { move_type: 'out_invoice', limit: 100 } },
      { path: '/account.move', target_table: 'ap_invoices', method: 'GET', params: { move_type: 'in_invoice', limit: 100 } },
      { path: '/res.partner', target_table: 'customers', method: 'GET', params: { customer_rank: 1, limit: 100 } },
      { path: '/hr.employee', target_table: 'employees', method: 'GET', params: { limit: 100 } },
    ],
    field_mapping: {
      ar_invoices: { name: 'invoice_number', invoice_date: 'invoice_date', invoice_date_due: 'due_date', amount_total: 'total_amount' },
    },
    poll_interval_seconds: 60,
  },
  {
    id: 'generic_rest',
    name: 'Custom REST API',
    source_type: 'custom',
    icon: 'api',
    auth_type: 'api_key',
    base_url: 'https://your-api.com',
    endpoints: [
      { path: '/data', target_table: 'ar_invoices', method: 'GET', params: {} },
    ],
    field_mapping: {},
    poll_interval_seconds: 60,
  },
];

// ── Fetch data from a source ─────────────────────────────────
async function fetchFromSource(connection: any, maxPages = 10): Promise<any[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(connection.headers || {}) };

  // Apply auth
  if (connection.auth_type === 'api_key') {
    const cfg = connection.auth_config || {};
    if (cfg.header_name && cfg.api_key) headers[cfg.header_name] = cfg.api_key;
    else if (cfg.api_key) headers['Authorization'] = `Bearer ${cfg.api_key}`;
  } else if (connection.auth_type === 'basic') {
    const cfg = connection.auth_config || {};
    const b64 = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    headers['Authorization'] = `Basic ${b64}`;
  } else if (connection.auth_type === 'bearer') {
    const cfg = connection.auth_config || {};
    headers['Authorization'] = `Bearer ${cfg.token}`;
  }

  const allRecords: any[] = [];
  const endpoints: any[] = connection.endpoints || [];
  let firstError: string | null = null;

  for (const endpoint of endpoints.slice(0, 5)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const url = await assertSafeUrl(String(connection.base_url) + String(endpoint.path));
      if (endpoint.params && typeof endpoint.params === 'object') {
        Object.entries(endpoint.params).forEach(([k,v]) => url.searchParams.set(k, String(v)));
      }

      const method = endpoint.method === 'POST' ? 'POST' : 'GET';
      const resp = await fetch(url.toString(), { method, headers, redirect: 'manual', signal: ctl.signal });
      if (!resp.ok) { firstError = firstError || `${endpoint.path}: HTTP ${resp.status}`; continue; }

      const data = await resp.json() as any;
      const found = data.items || data.records || data.data || data.results ||
                    data.list || data.response || (Array.isArray(data) ? data : [data]);
      const records: any[] = Array.isArray(found) ? found : [found];

      allRecords.push(...records.map((r: any) => ({ ...r, _source_endpoint: endpoint.path, _target_table: endpoint.target_table })));
    } catch (e: any) { firstError = firstError || `${endpoint?.path}: ${e?.message || e}`; }
    finally { clearTimeout(timer); }
  }

  if (!allRecords.length && firstError) throw new Error(firstError);
  return allRecords;
}

// ── Which columns a table really has (cached 10 minutes) ─────
const columnCache = new Map<string, { at: number; cols: Set<string> }>();
async function tableColumns(pool: Pool, table: string): Promise<Set<string>> {
  const hit = columnCache.get(table);
  if (hit && Date.now() - hit.at < 600000) return hit.cols;
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = ANY(current_schemas(false)) AND table_name = $1`, [table]);
  const cols = new Set<string>(r.rows.map((x: any) => x.column_name));
  columnCache.set(table, { at: Date.now(), cols });
  return cols;
}

// ── Sync a connection to DB ──────────────────────────────────
async function syncConnection(pool: Pool, connection: any): Promise<any> {
  const start = Date.now();
  let recordsFetched = 0, recordsInserted = 0, recordsSkipped = 0;
  let error = null;

  try {
    const records = await fetchFromSource(connection);
    recordsFetched = records.length;

    for (const record of records) {
      const targetTable = String(record._target_table || connection.target_table);
      // Never trust stored names: only known tables and real columns are written.
      if (!ALLOWED_TABLES.has(targetTable)) { recordsSkipped++; continue; }
      const fieldMap = connection.field_mapping?.[targetTable] || {};
      const cols0 = await tableColumns(pool, targetTable);

      // Map fields
      const mapped: Record<string, any> = {};
      for (const [srcField, destField] of Object.entries(fieldMap)) {
        const dest = String(destField);
        if (!IDENT.test(dest) || PROTECTED_COLUMNS.has(dest) || !cols0.has(dest)) continue;
        if (record[srcField] !== undefined) mapped[dest] = record[srcField];
      }

      if (Object.keys(mapped).length === 0) continue; // nothing mapped
      mapped.tenant_id = connection.tenant_id;        // always the connection's own company

      const cols = Object.keys(mapped);
      const vals = Object.values(mapped);
      const placeholders = vals.map((_,i) => `$${i+1}`).join(',');

      try {
        await pool.query(
          `INSERT INTO "${targetTable}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${placeholders})
           ON CONFLICT DO NOTHING`,
          vals
        );
        recordsInserted++;
      } catch {}
    }

    // Update connection status
    await pool.query(
      `UPDATE poller_connections SET last_polled_at=NOW(), last_status='success', last_error=NULL, records_synced=records_synced+$1 WHERE id=$2`,
      [recordsInserted, connection.id]
    ).catch(() => {});

  } catch(e: any) {
    error = e.message;
    await pool.query(
      `UPDATE poller_connections SET last_polled_at=NOW(), last_status='error', last_error=$1 WHERE id=$2`,
      [error, connection.id]
    ).catch(() => {});
  }

  // Log
  await pool.query(
    `INSERT INTO poller_logs (tenant_id, connection_id, status, records_fetched, records_inserted, duration_ms, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [connection.tenant_id, connection.id, error?'error':'success', recordsFetched, recordsInserted, Date.now()-start, error]
  ).catch(() => {});

  return { success: !error, records_fetched: recordsFetched, records_inserted: recordsInserted, records_skipped: recordsSkipped, duration_ms: Date.now()-start, error };
}

// ── Background Poller — runs on server startup ───────────────
export function startUniversalPoller(pool: Pool) {
  const tickMs = Math.max(60000, Number(process.env.POLLER_TICK_MS) || 300000);
  console.log(`[UniversalPoller] Starting background poller (checks every ${Math.round(tickMs / 60000)} min)`);
  const running = new Set<string>();

  setInterval(async () => {
    try {
      const connections = await pool.query(
        `SELECT * FROM poller_connections WHERE is_active=true
         AND (last_polled_at IS NULL OR NOW() - last_polled_at > (poll_interval_seconds || ' seconds')::interval)`
      ).catch(() => ({ rows: [] }));

      for (const conn of connections.rows) {
        if (running.has(conn.id)) continue;
        running.add(conn.id);
        syncConnection(pool, conn).then(result => {
          if (result.records_inserted > 0) {
            console.log(`[UniversalPoller] ${conn.name}: ${result.records_inserted} records synced`);
          }
        }).catch(() => {}).finally(() => running.delete(conn.id));
      }
    } catch {}
  }, tickMs); // Check which connections are due
}
