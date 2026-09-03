import { Router, Request, Response } from 'express';
import { Pool } from 'pg';

const sseClients = new Map();

export const broadcastToTenant = (tenantId, event) => {
  const clients = sseClients.get(tenantId);
  if (!clients || clients.size === 0) return;
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  clients.forEach(res => { try { res.write(msg); } catch {} });
};

export const setupCDC = async (pool) => {
  console.log('[CDC] Starting polling-based change detection (2s interval)');
  const lastSeen = {};
  const tables = ['ar_invoices','ap_invoices','expenses','bank_transactions','payments','employees','purchase_orders','inventory_items'];
  for (const table of tables) {
    try {
      const r = await pool.query(`SELECT COALESCE(MAX(updated_at), NOW())::text as ts FROM ${table}`).catch(() => ({ rows: [{ ts: new Date().toISOString() }] }));
      lastSeen[table] = r.rows[0]?.ts || new Date().toISOString();
    } catch { lastSeen[table] = new Date().toISOString(); }
  }
  setInterval(async () => {
    for (const table of tables) {
      try {
        const r = await pool.query(`SELECT tenant_id::text, MAX(updated_at)::text as ts FROM ${table} WHERE updated_at > $1::timestamptz GROUP BY tenant_id`, [lastSeen[table]]).catch(() => ({ rows: [] }));
        for (const row of r.rows) {
          if (row.tenant_id) {
            broadcastToTenant(row.tenant_id, { type: 'data_change', table, action: 'UPDATE', timestamp: new Date().toISOString() });
            console.log(`[CDC] Change in ${table} for tenant ${row.tenant_id?.substring(0,8)}`);
          }
          if (row.ts && row.ts > lastSeen[table]) lastSeen[table] = row.ts;
        }
      } catch {}
    }
  }, 2000);
};

export function createSSERouter(pool) {
  const router = Router();
  router.get('/live', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(401).json({ error: 'No token' });
    let tenantId = '';
    try {
      const jwt = require('jsonwebtoken');
      const d = jwt.verify(token, process.env.JWT_SECRET);
      tenantId = d.tenantId;
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
    console.log('[SSE] Connected tenant:', tenantId?.substring(0,8));
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (!sseClients.has(tenantId)) sseClients.set(tenantId, new Set());
    sseClients.get(tenantId).add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected', ts: new Date().toISOString() })}\n\n`);
    const hb = setInterval(() => { try { res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`); } catch { clearInterval(hb); } }, 30000);
    req.on('close', () => { clearInterval(hb); sseClients.get(tenantId)?.delete(res); console.log('[SSE] Disconnected:', tenantId?.substring(0,8)); });
  });
  return router;
}
