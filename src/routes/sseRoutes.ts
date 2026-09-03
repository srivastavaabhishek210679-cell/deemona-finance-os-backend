import { Router, Request, Response } from 'express';
import { Pool } from 'pg';

const sseClients = new Map<string, Set<Response>>();

export const broadcastToTenant = (tenantId: string, event: any) => {
  const clients = sseClients.get(tenantId);
  if (!clients || clients.size === 0) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  clients.forEach(client => {
    try { client.write(data); } catch {}
  });
};

export const setupCDC = async (pool: Pool) => {
  try {
    const pg = await import('pg');
    const cdcClient = new pg.default.Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await cdcClient.connect();

    await cdcClient.query(`
      CREATE OR REPLACE FUNCTION notify_data_change()
      RETURNS trigger AS $$
      DECLARE payload json;
      BEGIN
        payload = json_build_object(
          'table', TG_TABLE_NAME,
          'action', TG_OP,
          'tenant_id', COALESCE(NEW.tenant_id::text, OLD.tenant_id::text),
          'ts', extract(epoch from now())
        );
        PERFORM pg_notify('data_change', payload::text);
        RETURN COALESCE(NEW, OLD);
      END;
      $$ LANGUAGE plpgsql;
    `).catch(() => {});

    const tables = [
      'ar_invoices','ap_invoices','expenses','bank_transactions',
      'payments','employees','purchase_orders','inventory_items',
      'journal_entries','bank_accounts'
    ];

    for (const table of tables) {
      await cdcClient.query(`
        DROP TRIGGER IF EXISTS ${table}_notify ON ${table};
        CREATE TRIGGER ${table}_notify
        AFTER INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION notify_data_change();
      `).catch(() => {});
    }

    await cdcClient.query('LISTEN data_change');

    cdcClient.on('notification', (msg) => {
      try {
        const payload = JSON.parse(msg.payload || '{}');
        broadcastToTenant(payload.tenant_id, {
          type: 'data_change',
          table: payload.table,
          action: payload.action,
          timestamp: new Date().toISOString(),
        });
        console.log(`[CDC] ${payload.action} on ${payload.table}`);
      } catch {}
    });

    cdcClient.on('error', () => {
      setTimeout(() => setupCDC(pool), 5000);
    });

    console.log('[CDC] pg_notify active on', tables.length, 'tables');
  } catch(e: any) {
    console.error('[CDC] Setup failed:', e.message);
    setTimeout(() => setupCDC(pool), 10000);
  }
};

export function createSSERouter(pool: Pool): Router {
  const router = Router();

  router.get('/live', (req: Request, res: Response) => {
    const token = (req.headers.authorization?.replace('Bearer ', '') || req.query.token) as string;
    if (!token) return res.status(401).json({ error: 'No token' }) as any;

    let tenantId = '';
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      tenantId = decoded.tenantId;
    } catch {
      return res.status(401).json({ error: 'Invalid token' }) as any;
    }

    console.log('[SSE] Client connected, tenant:', tenantId?.substring(0, 8));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    if (!sseClients.has(tenantId)) sseClients.set(tenantId, new Set());
    sseClients.get(tenantId)!.add(res as any);

    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

    const heartbeat = setInterval(() => {
      try { res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`); }
      catch { clearInterval(heartbeat); }
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.get(tenantId)?.delete(res as any);
      console.log('[SSE] Client disconnected, tenant:', tenantId?.substring(0, 8));
    });
  });

  return router;
}
