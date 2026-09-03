import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

const tid = (req: Request): string => (req as any).user?.tenantId;

export function createMessageStreamRouter(pool: Pool): Router {
  const router = Router();

  // Init tables
  pool.query(`
    CREATE TABLE IF NOT EXISTS stream_connections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      name VARCHAR(255) NOT NULL,
      stream_type VARCHAR(50) NOT NULL,
      config JSONB DEFAULT '{}',
      topic_mappings JSONB DEFAULT '[]',
      is_active BOOLEAN DEFAULT true,
      status VARCHAR(50) DEFAULT 'disconnected',
      messages_processed INT DEFAULT 0,
      last_message_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS stream_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      connection_id UUID NOT NULL,
      topic VARCHAR(255),
      payload JSONB,
      target_table VARCHAR(100),
      status VARCHAR(50) DEFAULT 'received',
      processed_at TIMESTAMPTZ,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(() => {});

  // GET /connections
  router.get('/connections', requireAuth, async (req: Request, res: Response) => {
    const r = await pool.query(`SELECT * FROM stream_connections WHERE tenant_id=$1 ORDER BY created_at DESC`, [tid(req)]).catch(()=>({rows:[]}));
    res.json({ connections: r.rows });
  });

  // POST /connections
  router.post('/connections', requireAuth, async (req: Request, res: Response) => {
    try {
      const { name, stream_type, config, topic_mappings } = req.body;
      const r = await pool.query(
        `INSERT INTO stream_connections (tenant_id, name, stream_type, config, topic_mappings) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [tid(req), name, stream_type, JSON.stringify(config||{}), JSON.stringify(topic_mappings||[])]
      );
      res.json({ connection: r.rows[0] });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // PUT /connections/:id
  router.put('/connections/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { name, config, topic_mappings, is_active } = req.body;
      const r = await pool.query(
        `UPDATE stream_connections SET name=COALESCE($1,name), config=COALESCE($2,config), topic_mappings=COALESCE($3,topic_mappings), is_active=COALESCE($4,is_active) WHERE id=$5 AND tenant_id=$6 RETURNING *`,
        [name, config?JSON.stringify(config):null, topic_mappings?JSON.stringify(topic_mappings):null, is_active, req.params.id, tid(req)]
      );
      res.json({ connection: r.rows[0] });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // DELETE /connections/:id
  router.delete('/connections/:id', requireAuth, async (req: Request, res: Response) => {
    await pool.query(`DELETE FROM stream_connections WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]);
    res.json({ success: true });
  });

  // POST /connections/:id/test
  router.post('/connections/:id/test', requireAuth, async (req: Request, res: Response) => {
    try {
      const conn = await pool.query(`SELECT * FROM stream_connections WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)]);
      if (!conn.rows[0]) return res.status(404).json({ error: 'Not found' }) as any;
      const c = conn.rows[0];
      const result = await testStreamConnection(c);
      res.json(result);
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // GET /connections/:id/messages
  router.get('/connections/:id/messages', requireAuth, async (req: Request, res: Response) => {
    const r = await pool.query(
      `SELECT * FROM stream_messages WHERE connection_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id, tid(req)]
    ).catch(()=>({rows:[]}));
    res.json({ messages: r.rows });
  });

  // POST /webhook/:id — receive messages via HTTP (for systems that push)
  // This is the universal inbound webhook for any streaming source
  router.post('/webhook/:connectionId', async (req: Request, res: Response) => {
    try {
      const { connectionId } = req.params;
      const conn = await pool.query(`SELECT * FROM stream_connections WHERE id=$1`, [connectionId]).catch(()=>({rows:[]}));
      if (!conn.rows[0]) return res.status(404).json({ error: 'Connection not found' }) as any;

      const c = conn.rows[0];
      const payload = req.body;
      const topicMappings: any[] = c.topic_mappings || [];

      // Detect topic from payload
      const topic = payload.topic || payload.subject || payload.eventType ||
                    payload.MessageAttributes?.topic?.StringValue || 'default';

      // Find matching topic mapping
      const mapping = topicMappings.find((m:any) =>
        m.topic === topic || m.topic === '*' || topic.includes(m.topic)
      ) || topicMappings[0];

      const targetTable = mapping?.target_table || 'ar_invoices';

      // Store raw message
      await pool.query(
        `INSERT INTO stream_messages (tenant_id, connection_id, topic, payload, target_table, status, processed_at)
         VALUES ($1,$2,$3,$4,$5,'received',NOW())`,
        [c.tenant_id, connectionId, topic, JSON.stringify(payload), targetTable]
      ).catch(()=>{});

      // Map and insert into target table
      if (mapping?.field_mapping) {
        const mapped: Record<string,any> = { tenant_id: c.tenant_id };
        for (const [src, dest] of Object.entries(mapping.field_mapping)) {
          const val = getNestedValue(payload, src as string);
          if (val !== undefined) mapped[dest as string] = val;
        }
        if (Object.keys(mapped).length > 1) {
          const cols = Object.keys(mapped);
          const vals = Object.values(mapped);
          await pool.query(
            `INSERT INTO ${targetTable} (${cols.join(',')}) VALUES (${vals.map((_,i)=>`$${i+1}`).join(',')}) ON CONFLICT DO NOTHING`,
            vals
          ).catch(()=>{});
        }
      }

      // Update connection stats
      await pool.query(
        `UPDATE stream_connections SET messages_processed=messages_processed+1, last_message_at=NOW(), status='connected' WHERE id=$1`,
        [connectionId]
      ).catch(()=>{});

      res.json({ success: true, topic, target_table: targetTable });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // GET /templates
  router.get('/templates', requireAuth, async (_req: Request, res: Response) => {
    res.json({ templates: STREAM_TEMPLATES });
  });

  // GET /stats
  router.get('/stats', requireAuth, async (req: Request, res: Response) => {
    const r = await pool.query(
      `SELECT stream_type, COUNT(*) as connections, SUM(messages_processed) as total_messages
       FROM stream_connections WHERE tenant_id=$1 GROUP BY stream_type`,
      [tid(req)]
    ).catch(()=>({rows:[]}));
    const recent = await pool.query(
      `SELECT * FROM stream_messages WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 10`,
      [tid(req)]
    ).catch(()=>({rows:[]}));
    res.json({ by_type: r.rows, recent_messages: recent.rows });
  });

  return router;
}

// ── Stream Templates ─────────────────────────────────────────
const STREAM_TEMPLATES = [
  {
    id: 'kafka',
    name: 'Apache Kafka',
    stream_type: 'kafka',
    description: 'High-throughput distributed message streaming',
    icon: 'K',
    color: '#000000',
    config_fields: [
      { key: 'brokers', label: 'Broker URLs', placeholder: 'localhost:9092,broker2:9092', type: 'text' },
      { key: 'group_id', label: 'Consumer Group ID', placeholder: 'deemona-finance-consumer', type: 'text' },
      { key: 'sasl_username', label: 'SASL Username (optional)', placeholder: 'username', type: 'text' },
      { key: 'sasl_password', label: 'SASL Password (optional)', placeholder: 'password', type: 'password' },
      { key: 'ssl', label: 'Use SSL', type: 'boolean' },
    ],
    topic_mappings: [
      { topic: 'finance.invoices', target_table: 'ar_invoices', field_mapping: { 'invoiceId': 'invoice_number', 'customerId': 'customer_id', 'amount': 'total_amount', 'date': 'invoice_date' } },
      { topic: 'finance.payments', target_table: 'payments', field_mapping: { 'paymentId': 'payment_reference', 'amount': 'amount', 'date': 'payment_date' } },
      { topic: 'finance.expenses', target_table: 'expenses', field_mapping: { 'description': 'description', 'amount': 'amount', 'date': 'expense_date' } },
      { topic: 'hr.employees', target_table: 'employees', field_mapping: { 'employeeId': 'employee_code', 'name': 'name', 'department': 'department', 'salary': 'basic_salary' } },
    ],
    webhook_note: 'Use Kafka Connect HTTP Sink connector to push messages to the webhook URL below.',
  },
  {
    id: 'rabbitmq',
    name: 'RabbitMQ',
    stream_type: 'rabbitmq',
    description: 'AMQP message broker for reliable messaging',
    icon: 'R',
    color: '#FF6600',
    config_fields: [
      { key: 'host', label: 'Host', placeholder: 'rabbitmq.example.com', type: 'text' },
      { key: 'port', label: 'Port', placeholder: '5672', type: 'number' },
      { key: 'username', label: 'Username', placeholder: 'guest', type: 'text' },
      { key: 'password', label: 'Password', placeholder: 'password', type: 'password' },
      { key: 'vhost', label: 'Virtual Host', placeholder: '/', type: 'text' },
      { key: 'exchange', label: 'Exchange', placeholder: 'finance.events', type: 'text' },
    ],
    topic_mappings: [
      { topic: 'invoice.created', target_table: 'ar_invoices', field_mapping: { 'invoice_number': 'invoice_number', 'total_amount': 'total_amount', 'date': 'invoice_date' } },
      { topic: 'payment.received', target_table: 'payments', field_mapping: { 'amount': 'amount', 'reference': 'payment_reference' } },
      { topic: 'expense.submitted', target_table: 'expenses', field_mapping: { 'amount': 'amount', 'description': 'description', 'category': 'category' } },
    ],
    webhook_note: 'Configure RabbitMQ HTTP forward plugin to push messages to the webhook URL below.',
  },
  {
    id: 'azure_service_bus',
    name: 'Azure Service Bus',
    stream_type: 'azure_service_bus',
    description: 'Microsoft Azure enterprise messaging service',
    icon: 'A',
    color: '#0078D4',
    config_fields: [
      { key: 'connection_string', label: 'Connection String', placeholder: 'Endpoint=sb://...', type: 'password' },
      { key: 'queue_name', label: 'Queue / Topic Name', placeholder: 'finance-events', type: 'text' },
      { key: 'subscription', label: 'Subscription (for Topics)', placeholder: 'deemona-sub', type: 'text' },
    ],
    topic_mappings: [
      { topic: 'FinanceInvoice', target_table: 'ar_invoices', field_mapping: { 'InvoiceNumber': 'invoice_number', 'TotalAmount': 'total_amount', 'InvoiceDate': 'invoice_date' } },
      { topic: 'FinancePayment', target_table: 'payments', field_mapping: { 'Amount': 'amount', 'Reference': 'payment_reference' } },
    ],
    webhook_note: 'Use Azure Service Bus HTTP forward or Logic Apps to push to the webhook URL below.',
  },
  {
    id: 'aws_sqs',
    name: 'AWS SQS',
    stream_type: 'aws_sqs',
    description: 'Amazon Simple Queue Service',
    icon: 'S',
    color: '#FF9900',
    config_fields: [
      { key: 'queue_url', label: 'SQS Queue URL', placeholder: 'https://sqs.ap-south-1.amazonaws.com/...', type: 'text' },
      { key: 'access_key', label: 'AWS Access Key ID', placeholder: 'AKIAXXXXXXXX', type: 'text' },
      { key: 'secret_key', label: 'AWS Secret Access Key', placeholder: 'secret', type: 'password' },
      { key: 'region', label: 'AWS Region', placeholder: 'ap-south-1', type: 'text' },
    ],
    topic_mappings: [
      { topic: '*', target_table: 'ar_invoices', field_mapping: { 'invoice_no': 'invoice_number', 'amount': 'total_amount', 'date': 'invoice_date' } },
    ],
    webhook_note: 'Use AWS EventBridge or Lambda to forward SQS messages to the webhook URL below.',
  },
  {
    id: 'webhook',
    name: 'Generic Webhook',
    stream_type: 'webhook',
    description: 'Any system that can POST JSON to an HTTP endpoint',
    icon: 'W',
    color: '#059669',
    config_fields: [
      { key: 'secret', label: 'Webhook Secret (optional)', placeholder: 'for signature verification', type: 'password' },
    ],
    topic_mappings: [
      { topic: '*', target_table: 'ar_invoices', field_mapping: {} },
    ],
    webhook_note: 'Configure your source system to POST JSON payloads to the webhook URL below.',
  },
  {
    id: 'google_pubsub',
    name: 'Google Pub/Sub',
    stream_type: 'google_pubsub',
    description: 'Google Cloud messaging and streaming',
    icon: 'G',
    color: '#4285F4',
    config_fields: [
      { key: 'project_id', label: 'GCP Project ID', placeholder: 'my-project-123', type: 'text' },
      { key: 'subscription', label: 'Subscription Name', placeholder: 'finance-sub', type: 'text' },
      { key: 'service_account_key', label: 'Service Account JSON Key', placeholder: '{"type":"service_account"...}', type: 'textarea' },
    ],
    topic_mappings: [
      { topic: 'finance-events', target_table: 'ar_invoices', field_mapping: { 'invoiceId': 'invoice_number', 'amount': 'total_amount' } },
    ],
    webhook_note: 'Configure Pub/Sub push subscription to deliver to the webhook URL below.',
  },
];

// ── Helper: get nested value from object ─────────────────────
function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// ── Test connection ──────────────────────────────────────────
async function testStreamConnection(conn: any): Promise<any> {
  // For webhook-based connections, just verify config is set
  const cfg = conn.config || {};
  const checks = [];

  if (conn.stream_type === 'kafka') {
    checks.push({ check: 'Broker config', pass: !!cfg.brokers, note: cfg.brokers || 'Not configured' });
    checks.push({ check: 'Group ID', pass: !!cfg.group_id, note: cfg.group_id || 'Not configured' });
  } else if (conn.stream_type === 'rabbitmq') {
    checks.push({ check: 'Host', pass: !!cfg.host, note: cfg.host || 'Not configured' });
    checks.push({ check: 'Exchange', pass: !!cfg.exchange, note: cfg.exchange || 'Not configured' });
  } else if (conn.stream_type === 'azure_service_bus') {
    checks.push({ check: 'Connection string', pass: !!cfg.connection_string, note: cfg.connection_string ? 'Set' : 'Not configured' });
    checks.push({ check: 'Queue/Topic', pass: !!cfg.queue_name, note: cfg.queue_name || 'Not configured' });
  } else if (conn.stream_type === 'aws_sqs') {
    checks.push({ check: 'Queue URL', pass: !!cfg.queue_url, note: cfg.queue_url || 'Not configured' });
    checks.push({ check: 'AWS credentials', pass: !!cfg.access_key && !!cfg.secret_key, note: cfg.access_key ? 'Set' : 'Not configured' });
  } else {
    checks.push({ check: 'Webhook endpoint', pass: true, note: 'Ready to receive messages' });
  }

  const allPass = checks.every(c => c.pass);
  return { success: allPass, checks, stream_type: conn.stream_type, topic_mappings: conn.topic_mappings?.length || 0 };
}
