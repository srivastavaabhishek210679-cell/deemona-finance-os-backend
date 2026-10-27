import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

const tid = (req: Request): string => (req as any).user?.tenantId;

// ── Universal REST Poller Routes ─────────────────────────────
// Allows users to connect ANY REST API source and auto-sync data

export function createUniversalPollerRouter(pool: Pool): Router {
  const router = Router();

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
         target_table, poll_interval_seconds||60]
      );
      res.json({ connection: r.rows[0] });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ── PUT /connections/:id — update connection ─────────────────
  router.put('/connections/:id', requireAuth, async (req: Request, res: Response) => {
    try {
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
      res.json({ connection: r.rows[0] });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ── DELETE /connections/:id ──────────────────────────────────
  router.delete('/connections/:id', requireAuth, async (req: Request, res: Response) => {
    await pool.query(`DELETE FROM poller_connections WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]);
    res.json({ success: true });
  });

  // ── POST /connections/:id/test — test connection ─────────────
  router.post('/connections/:id/test', requireAuth, async (req: Request, res: Response) => {
    try {
      const conn = await pool.query(
        `SELECT * FROM poller_connections WHERE id=$1 AND tenant_id=$2`,
        [req.params.id, tid(req)]
      );
      if (!conn.rows[0]) return res.status(404).json({ error: 'Connection not found' }) as any;
      const c = conn.rows[0];
      const result = await fetchFromSource(c, 1);
      res.json({ success: true, sample_records: result.slice(0,3), total_fetched: result.length });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ── POST /connections/:id/sync — manual sync ─────────────────
  router.post('/connections/:id/sync', requireAuth, async (req: Request, res: Response) => {
    try {
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

  for (const endpoint of endpoints.slice(0, 5)) {
    try {
      const url = new URL(connection.base_url + endpoint.path);
      if (endpoint.params) {
        Object.entries(endpoint.params).forEach(([k,v]) => url.searchParams.set(k, String(v)));
      }

      const resp = await fetch(url.toString(), { method: endpoint.method || 'GET', headers });
      if (!resp.ok) continue;

      const data = await resp.json() as any;
      const records = data.items || data.records || data.data || data.results ||
                      data.list || data.response || (Array.isArray(data) ? data : [data]);

      allRecords.push(...records.map((r: any) => ({ ...r, _source_endpoint: endpoint.path, _target_table: endpoint.target_table })));
    } catch {}
  }

  return allRecords;
}

// ── Sync a connection to DB ──────────────────────────────────
async function syncConnection(pool: Pool, connection: any): Promise<any> {
  const start = Date.now();
  let recordsFetched = 0, recordsInserted = 0;
  let error = null;

  try {
    const records = await fetchFromSource(connection);
    recordsFetched = records.length;

    for (const record of records) {
      const targetTable = record._target_table || connection.target_table;
      const fieldMap = connection.field_mapping?.[targetTable] || {};

      // Map fields
      const mapped: Record<string, any> = { tenant_id: connection.tenant_id };
      for (const [srcField, destField] of Object.entries(fieldMap)) {
        if (record[srcField] !== undefined) mapped[destField as string] = record[srcField];
      }

      if (Object.keys(mapped).length <= 1) continue; // only tenant_id

      // Upsert based on key fields
      const cols = Object.keys(mapped);
      const vals = Object.values(mapped);
      const placeholders = vals.map((_,i) => `$${i+1}`).join(',');
      const updates = cols.filter(c => c !== 'tenant_id').map((c,i) => `${c}=$${cols.indexOf(c)+1}`).join(',');

      try {
        await pool.query(
          `INSERT INTO ${targetTable} (${cols.join(',')}) VALUES (${placeholders})
           ON CONFLICT DO NOTHING`,
          vals
        );
        recordsInserted++;
      } catch {}
    }

    // Update connection status
    await pool.query(
      `UPDATE poller_connections SET last_polled_at=NOW(), last_status='success', records_synced=records_synced+$1 WHERE id=$2`,
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

  return { success: !error, records_fetched: recordsFetched, records_inserted: recordsInserted, duration_ms: Date.now()-start, error };
}

// ── Background Poller — runs on server startup ───────────────
export function startUniversalPoller(pool: Pool) {
  const tickMs = Math.max(60000, Number(process.env.POLLER_TICK_MS) || 300000);
  console.log(`[UniversalPoller] Starting background poller (checks every ${Math.round(tickMs / 60000)} min)`);

  setInterval(async () => {
    try {
      const connections = await pool.query(
        `SELECT * FROM poller_connections WHERE is_active=true
         AND (last_polled_at IS NULL OR NOW() - last_polled_at > (poll_interval_seconds || ' seconds')::interval)`
      ).catch(() => ({ rows: [] }));

      for (const conn of connections.rows) {
        syncConnection(pool, conn).then(result => {
          if (result.records_inserted > 0) {
            console.log(`[UniversalPoller] ${conn.name}: ${result.records_inserted} records synced`);
          }
        }).catch(() => {});
      }
    } catch {}
  }, tickMs); // Check which connections are due
}
