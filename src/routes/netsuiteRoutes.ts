import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import crypto from 'crypto';

const tid = (req: Request): string => (req as any).user?.tenantId;

export function createNetSuiteRouter(pool: Pool): Router {
  const router = Router();

  // Init tables
  pool.query(`
    CREATE TABLE IF NOT EXISTS netsuite_connections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      account_id VARCHAR(100) NOT NULL,
      consumer_key TEXT NOT NULL,
      consumer_secret TEXT NOT NULL,
      token_id TEXT NOT NULL,
      token_secret TEXT NOT NULL,
      is_active BOOLEAN DEFAULT true,
      last_sync_at TIMESTAMPTZ,
      sync_status VARCHAR(50) DEFAULT 'pending',
      records_synced INT DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS netsuite_sync_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      connection_id UUID NOT NULL,
      entity_type VARCHAR(100),
      records_fetched INT DEFAULT 0,
      records_inserted INT DEFAULT 0,
      duration_ms INT,
      status VARCHAR(50),
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(() => {});

  // ── GET /config ──────────────────────────────────────────────
  router.get('/config', requireAuth, async (req: Request, res: Response) => {
    const r = await pool.query(
      `SELECT id, account_id, is_active, last_sync_at, sync_status, records_synced, last_error, created_at
       FROM netsuite_connections WHERE tenant_id=$1 LIMIT 1`,
      [tid(req)]
    ).catch(() => ({ rows: [] }));
    res.json({ connection: r.rows[0] || null });
  });

  // ── POST /config — save credentials ──────────────────────────
  router.post('/config', requireAuth, async (req: Request, res: Response) => {
    try {
      const { account_id, consumer_key, consumer_secret, token_id, token_secret } = req.body;
      if (!account_id || !consumer_key || !consumer_secret || !token_id || !token_secret) {
        return res.status(400).json({ error: 'All OAuth 1.0a credentials required' }) as any;
      }
      // Delete existing and insert new
      await pool.query(`DELETE FROM netsuite_connections WHERE tenant_id=$1`, [tid(req)]);
      const r = await pool.query(
        `INSERT INTO netsuite_connections (tenant_id, account_id, consumer_key, consumer_secret, token_id, token_secret)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, account_id, is_active, created_at`,
        [tid(req), account_id, consumer_key, consumer_secret, token_id, token_secret]
      );
      res.json({ connection: r.rows[0], success: true });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ── POST /test — test connection ─────────────────────────────
  router.post('/test', requireAuth, async (req: Request, res: Response) => {
    try {
      const conn = await getConnection(pool, tid(req));
      if (!conn) return res.status(404).json({ error: 'No NetSuite connection configured' }) as any;
      const result = await netsuiteRequest(conn, '/record/v1/currency?limit=5');
      if (result.error) return res.status(400).json({ error: result.error, details: result.details }) as any;
      res.json({ success: true, message: 'NetSuite connection successful', sample: result });
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /sync — full sync ────────────────────────────────────
  router.post('/sync', requireAuth, async (req: Request, res: Response) => {
    try {
      const conn = await getConnection(pool, tid(req));
      if (!conn) return res.status(404).json({ error: 'No connection configured' }) as any;
      const { entities = ['invoice', 'customer', 'vendor', 'vendorbill', 'employee'] } = req.body;
      const results: any[] = [];

      for (const entity of entities) {
        const r = await syncEntity(pool, conn, entity, tid(req));
        results.push(r);
      }

      const totalInserted = results.reduce((s,r) => s + (r.inserted||0), 0);
      await pool.query(
        `UPDATE netsuite_connections SET last_sync_at=NOW(), sync_status='success', records_synced=records_synced+$1 WHERE id=$2`,
        [totalInserted, conn.id]
      ).catch(() => {});

      res.json({ success: true, results, total_inserted: totalInserted });
    } catch(e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /sync-log ─────────────────────────────────────────────
  router.get('/sync-log', requireAuth, async (req: Request, res: Response) => {
    const r = await pool.query(
      `SELECT * FROM netsuite_sync_log WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [tid(req)]
    ).catch(() => ({ rows: [] }));
    res.json({ logs: r.rows });
  });

  // ── GET /entities — list available NetSuite entities ─────────
  router.get('/entities', requireAuth, async (_req: Request, res: Response) => {
    res.json({ entities: NETSUITE_ENTITIES });
  });

  // ── POST /sync/:entity — sync single entity ───────────────────
  router.post('/sync/:entity', requireAuth, async (req: Request, res: Response) => {
    try {
      const conn = await getConnection(pool, tid(req));
      if (!conn) return res.status(404).json({ error: 'No connection configured' }) as any;
      const result = await syncEntity(pool, conn, req.params.entity, tid(req));
      res.json(result);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

// ── NetSuite Entity Definitions ──────────────────────────────
const NETSUITE_ENTITIES = [
  {
    id: 'invoice',
    label: 'Sales Invoices (AR)',
    endpoint: '/record/v1/invoice',
    target_table: 'ar_invoices',
    field_map: {
      tranId: 'invoice_number',
      tranDate: 'invoice_date',
      dueDate: 'due_date',
      'entity.refName': 'customer_name',
      total: 'total_amount',
      subtotal: 'subtotal',
      taxTotal: 'tax_amount',
      status: 'status',
      memo: 'notes',
    },
    icon: '&#128196;',
    color: '#059669',
  },
  {
    id: 'vendorbill',
    label: 'Vendor Bills (AP)',
    endpoint: '/record/v1/vendorbill',
    target_table: 'ap_invoices',
    field_map: {
      tranId: 'invoice_number',
      tranDate: 'invoice_date',
      dueDate: 'due_date',
      'entity.refName': 'vendor_name',
      total: 'total_amount',
      status: 'status',
      memo: 'notes',
    },
    icon: '&#128203;',
    color: '#dc2626',
  },
  {
    id: 'customer',
    label: 'Customers',
    endpoint: '/record/v1/customer',
    target_table: 'customers',
    field_map: {
      companyName: 'name',
      email: 'email',
      phone: 'phone',
      'defaultAddress.addressee': 'address',
      creditLimit: 'credit_limit',
      balance: 'current_balance',
    },
    icon: '&#128100;',
    color: '#1d4ed8',
  },
  {
    id: 'vendor',
    label: 'Vendors / Suppliers',
    endpoint: '/record/v1/vendor',
    target_table: 'vendors',
    field_map: {
      companyName: 'name',
      email: 'email',
      phone: 'phone',
      'defaultAddress.addressee': 'address',
      terms: 'payment_terms',
    },
    icon: '&#127981;',
    color: '#7c3aed',
  },
  {
    id: 'employee',
    label: 'Employees',
    endpoint: '/record/v1/employee',
    target_table: 'employees',
    field_map: {
      entityId: 'employee_code',
      firstName: 'first_name',
      lastName: 'name',
      email: 'email',
      'department.refName': 'department',
      'subsidiary.refName': 'company',
      hireDate: 'joining_date',
      salary: 'basic_salary',
    },
    icon: '&#128101;',
    color: '#d97706',
  },
  {
    id: 'journalentry',
    label: 'Journal Entries (GL)',
    endpoint: '/record/v1/journalentry',
    target_table: 'journal_entries',
    field_map: {
      tranId: 'reference_number',
      tranDate: 'entry_date',
      memo: 'description',
      'subsidiary.refName': 'entity',
    },
    icon: '&#128218;',
    color: '#0891b2',
  },
  {
    id: 'purchaseorder',
    label: 'Purchase Orders',
    endpoint: '/record/v1/purchaseorder',
    target_table: 'purchase_orders',
    field_map: {
      tranId: 'po_number',
      tranDate: 'order_date',
      'entity.refName': 'vendor_name',
      total: 'total_amount',
      status: 'status',
    },
    icon: '&#128230;',
    color: '#16a34a',
  },
  {
    id: 'inventoryitem',
    label: 'Inventory Items',
    endpoint: '/record/v1/inventoryitem',
    target_table: 'inventory_items',
    field_map: {
      itemId: 'sku',
      displayName: 'name',
      description: 'description',
      quantityOnHand: 'quantity',
      cost: 'unit_cost',
      salesPrice: 'selling_price',
    },
    icon: '&#128230;',
    color: '#f59e0b',
  },
];

// ── Get connection from DB ────────────────────────────────────
async function getConnection(pool: Pool, tenantId: string) {
  const r = await pool.query(
    `SELECT * FROM netsuite_connections WHERE tenant_id=$1 AND is_active=true LIMIT 1`,
    [tenantId]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

// ── NetSuite OAuth 1.0a request ──────────────────────────────
function generateOAuth1Header(method: string, url: string, conn: any): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const realm = conn.account_id;

  const params: Record<string, string> = {
    oauth_consumer_key: conn.consumer_key,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: timestamp,
    oauth_token: conn.token_id,
    oauth_version: '1.0',
  };

  // Create signature base string
  const sortedParams = Object.keys(params).sort().map(k =>
    `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`
  ).join('&');

  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams),
  ].join('&');

  const signingKey = `${encodeURIComponent(conn.consumer_secret)}&${encodeURIComponent(conn.token_secret)}`;
  const signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

  params.oauth_signature = signature;

  const headerParams = Object.keys(params).map(k =>
    `${encodeURIComponent(k)}="${encodeURIComponent(params[k])}"`
  ).join(', ');

  return `OAuth realm="${realm}", ${headerParams}`;
}

async function netsuiteRequest(conn: any, path: string, method = 'GET'): Promise<any> {
  const baseUrl = `https://${conn.account_id}.suitetalk.api.netsuite.com/services/rest`;
  const url = baseUrl + path;
  const authHeader = generateOAuth1Header(method, url, conn);

  try {
    const resp = await fetch(url, {
      method,
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'transient',
      },
    });

    if (!resp.ok) {
      const err = await resp.text();
      return { error: `NetSuite API error ${resp.status}`, details: err };
    }

    return await resp.json();
  } catch(e: any) {
    return { error: e.message };
  }
}

// ── Sync single entity ────────────────────────────────────────
async function syncEntity(pool: Pool, conn: any, entityType: string, tenantId: string): Promise<any> {
  const start = Date.now();
  const entity = NETSUITE_ENTITIES.find(e => e.id === entityType);
  if (!entity) return { entity: entityType, error: 'Unknown entity type' };

  let fetched = 0, inserted = 0;
  let offset = 0;
  const limit = 100;

  try {
    while (true) {
      const data = await netsuiteRequest(conn, `${entity.endpoint}?limit=${limit}&offset=${offset}`);
      if (data.error) {
        await logSync(pool, tenantId, conn.id, entityType, fetched, inserted, Date.now()-start, 'error', data.error);
        return { entity: entityType, error: data.error, fetched, inserted };
      }

      const records = data.items || data.results || [];
      if (!records.length) break;
      fetched += records.length;

      for (const record of records) {
        const mapped: Record<string, any> = { tenant_id: tenantId };

        for (const [srcPath, destField] of Object.entries(entity.field_map)) {
          const val = getNestedValue(record, srcPath);
          if (val !== undefined && val !== null) mapped[destField as string] = val;
        }

        if (Object.keys(mapped).length <= 1) continue;

        const cols = Object.keys(mapped);
        const vals = Object.values(mapped);

        try {
          await pool.query(
            `INSERT INTO ${entity.target_table} (${cols.join(',')})
             VALUES (${vals.map((_,i) => `$${i+1}`).join(',')})
             ON CONFLICT DO NOTHING`,
            vals
          );
          inserted++;
        } catch {}
      }

      if (records.length < limit) break;
      offset += limit;
      if (offset > 1000) break; // Safety limit
    }

    await logSync(pool, tenantId, conn.id, entityType, fetched, inserted, Date.now()-start, 'success', null);
    return { entity: entityType, target_table: entity.target_table, fetched, inserted, duration_ms: Date.now()-start };
  } catch(e: any) {
    await logSync(pool, tenantId, conn.id, entityType, fetched, inserted, Date.now()-start, 'error', e.message);
    return { entity: entityType, error: e.message, fetched, inserted };
  }
}

async function logSync(pool: Pool, tenantId: string, connId: string, entity: string, fetched: number, inserted: number, ms: number, status: string, error: string | null) {
  await pool.query(
    `INSERT INTO netsuite_sync_log (tenant_id, connection_id, entity_type, records_fetched, records_inserted, duration_ms, status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tenantId, connId, entity, fetched, inserted, ms, status, error]
  ).catch(() => {});
}

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// ── Background auto-sync every 60 seconds ────────────────────
export function startNetSuitePoller(pool: Pool) {
  console.log('[NetSuite] Starting auto-sync poller (60s interval)');
  setInterval(async () => {
    try {
      const connections = await pool.query(
        `SELECT nc.*, nc.tenant_id FROM netsuite_connections nc
         WHERE nc.is_active=true
         AND (nc.last_sync_at IS NULL OR NOW() - nc.last_sync_at > INTERVAL '60 seconds')`
      ).catch(() => ({ rows: [] }));

      for (const conn of connections.rows) {
        const entities = ['invoice', 'vendorbill', 'customer', 'vendor'];
        for (const entity of entities) {
          await syncEntity(pool, conn, entity, conn.tenant_id).catch(() => {});
        }
        await pool.query(
          `UPDATE netsuite_connections SET last_sync_at=NOW(), sync_status='success' WHERE id=$1`,
          [conn.id]
        ).catch(() => {});
        console.log(`[NetSuite] Auto-synced tenant ${conn.tenant_id?.substring(0,8)}`);
      }
    } catch {}
  }, 60000);
}
