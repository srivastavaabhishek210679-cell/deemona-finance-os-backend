const fs = require('fs');

// Add pg_notify listener and SSE broadcast to backend index.ts
const pgNotifyCode = `
// ── pg_notify CDC — Real-Time Change Detection ───────────────
// Listen for any DB changes and broadcast to connected SSE clients
import pg from 'pg';

const setupCDC = async () => {
  const cdcClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await cdcClient.connect();

  // Create notification triggers for key tables
  await cdcClient.query(\`
    CREATE OR REPLACE FUNCTION notify_data_change()
    RETURNS trigger AS $$
    DECLARE
      payload json;
    BEGIN
      payload = json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'tenant_id', COALESCE(NEW.tenant_id, OLD.tenant_id),
        'timestamp', NOW()
      );
      PERFORM pg_notify('data_change', payload::text);
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
  \`).catch(() => {});

  // Add triggers to key tables
  const tables = [
    'ar_invoices', 'ap_invoices', 'expenses', 'bank_transactions',
    'payments', 'employees', 'purchase_orders', 'inventory_items',
    'journal_entries', 'bank_accounts'
  ];

  for (const table of tables) {
    await cdcClient.query(\`
      DROP TRIGGER IF EXISTS \${table}_notify ON \${table};
      CREATE TRIGGER \${table}_notify
      AFTER INSERT OR UPDATE OR DELETE ON \${table}
      FOR EACH ROW EXECUTE FUNCTION notify_data_change();
    \`).catch(() => {});
  }

  // Listen for notifications
  await cdcClient.query('LISTEN data_change');
  
  cdcClient.on('notification', (msg) => {
    try {
      const payload = JSON.parse(msg.payload || '{}');
      const tenantId = payload.tenant_id;
      const event = {
        type: 'data_change',
        table: payload.table,
        action: payload.action,
        tenant_id: tenantId,
        timestamp: payload.timestamp,
      };
      
      // Broadcast to all SSE clients for this tenant
      broadcastToTenant(tenantId, event);
      console.log(\`[CDC] \${payload.action} on \${payload.table} for tenant \${tenantId?.substring(0,8)}\`);
    } catch(e) {}
  });

  cdcClient.on('error', (err) => {
    console.error('[CDC] Connection error:', err.message);
    // Reconnect after 5s
    setTimeout(setupCDC, 5000);
  });

  console.log('[CDC] pg_notify listeners active on', tables.length, 'tables');
};

// SSE broadcast helper - broadcast to all clients of a tenant
const sseClients = new Map<string, Set<any>>();

const broadcastToTenant = (tenantId: string, event: any) => {
  if (!tenantId) return;
  const clients = sseClients.get(tenantId);
  if (!clients || clients.size === 0) return;
  const data = \`data: \${JSON.stringify(event)}\n\n\`;
  clients.forEach(client => {
    try { client.write(data); } catch {}
  });
};

// SSE endpoint - clients connect here for real-time updates
app.get('/api/stream/live', (req: any, res: any) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).end();
  
  // Decode tenant from JWT
  let tenantId = '';
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as any;
    tenantId = decoded.tenantId;
  } catch { return res.status(401).end(); }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  // Register client
  if (!sseClients.has(tenantId)) sseClients.set(tenantId, new Set());
  sseClients.get(tenantId)!.add(res);
  console.log(\`[SSE] Client connected for tenant \${tenantId?.substring(0,8)}, total: \${sseClients.get(tenantId)!.size}\`);

  // Send initial connection confirmation
  res.write(\`data: \${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n\`);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(\`data: \${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n\`); }
    catch { clearInterval(heartbeat); }
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.get(tenantId)?.delete(res);
    console.log(\`[SSE] Client disconnected for tenant \${tenantId?.substring(0,8)}\`);
  });
});

// Start CDC after DB connection
setupCDC().catch(e => console.error('[CDC] Setup failed:', e.message));
`;

const f = 'C:/deemona-finance-os/backend/src/index.ts';
let c = fs.readFileSync(f, 'utf8');

if (!c.includes('pg_notify CDC')) {
  // Add pg import at top
  c = c.replace(
    "import express from 'express';",
    "import express from 'express';\nimport pg from 'pg';"
  );

  // Add CDC setup before the server listen
  c = c.replace(
    "app.listen(",
    pgNotifyCode + "\napp.listen("
  );

  fs.writeFileSync(f, c, 'utf8');
  console.log('pg_notify CDC added');
} else {
  console.log('Already exists');
}
