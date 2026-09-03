import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import pg from 'pg';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';

import { pool, testConnection } from './db/pool';
import { createAuthRouter } from './routes/authRoutes';
import { createMemoryRouter } from './routes/memoryRoutes';
import { createAccountingRouter } from './routes/accountingRoutes';
import { createTreasuryRouter } from './routes/treasuryRoutes';
import { createProcurementRouter } from './routes/procurementRoutes';
import { createPayrollRouter } from './routes/payrollRoutes';
import { createTaxRouter } from './routes/taxRoutes';
import { createBudgetingRouter } from './routes/budgetingRoutes';
import { createExpensesRouter } from './routes/expensesRoutes';
import { createAssetsRouter } from './routes/assetsRoutes';
import { createInventoryRouter } from './routes/inventoryRoutes';
import { createProjectsRouter } from './routes/projectsRoutes';
import { createComplianceRouter } from './routes/complianceRoutes';
import { createCRMRouter } from './routes/crmRoutes';
import { createStatementsRouter } from './routes/statementsRoutes';
import { createCFOAgentRouter } from './routes/cfoAgentRoutes';
import { createDocumentAIRouter } from './routes/documentAIRoutes';
import { createAutomationRouter } from './routes/automationRoutes';
import { createTaxAgentRouter } from './routes/taxAgentRoutes';
import { createAuditAgentRouter } from './routes/auditAgentRoutes';
import { createMarketplaceRouter } from './routes/marketplaceRoutes';
import { createTallyRouter } from './routes/tallyRoutes';
import { createCurrencyRouter } from './routes/currencyRoutes';
import { createWhatsAppRouter } from './routes/whatsappRoutes';
import { createEmailAIRouter } from './routes/emailAIRoutes';
import { createForecastingRouter } from './routes/forecastingRoutes';
import { createSchedulerRouter } from './routes/schedulerRoutes';
import { createSDKRouter } from './routes/sdkRoutes';
import { createAIStudioRouter } from './routes/aiStudioRoutes';
import { createRBACRouter } from './middleware/rbac';
import { createDataIngestionRouter } from './routes/dataIngestionRoutes';
import { createAutoIngestRouter, runScheduledIngests, runEmailIngest } from './routes/autoIngestRoutes';
import { createBatch4DocsRouter } from './routes/batch4DocsRoutes';
import { createPhase1Router, runDailyAIJobs } from './routes/phase1Routes';
import { createEventBusRouter } from './routes/eventBusRoutes';
import { createDriveMonitorRouter, runDriveMonitor } from './routes/driveMonitorRoutes';
import { createDashboardRouter } from './routes/dashboardRoutes';
import { createBatch3DocsRouter } from './routes/batch3DocsRoutes';
import { createBatch2DocsRouter } from './routes/batch2DocsRoutes';
import { createMissingDocsRouter } from './routes/missingDocsRoutes';
import { createAutomationTestRouter } from './routes/automationTestRoutes';
import { createMonitorSettingsRouter } from './routes/monitorSettingsRoutes';
import { registerAutomationCrons, handleInvoiceAutoApproval, handleExpenseAutoApproval, handleNewLeadNurture, handleWhatsAppApprovalReply } from './services/automationEngine';
import { startMultiTenantMonitor } from './services/driveMonitorMultiTenant';
import { createNotificationRouter } from './routes/notificationRoutes';
import { createBillingRouter } from './routes/billingRoutes';
import { createAdminRouter } from './routes/adminRoutes';
import { createDataExportRouter } from './routes/dataExportRoutes';
import { createAgentRouter } from './routes/agentRoutes';
import {
  processEmbeddingQueue,
  refreshEntityProfiles,
  archiveOldMemories,
} from './jobs/memoryCron';

const app = express();
app.set('trust proxy', 1); // Required for Render/reverse proxy
const PORT = parseInt(process.env.PORT ?? '4000');

// â”€â”€ Security & parsing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    const allowed = ['http://localhost:5173','http://localhost:5174','https://deemona-finance-os-frontend.onrender.com',process.env.FRONTEND_URL].filter(Boolean);
    if (!origin || allowed.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','x-internal-tenant','x-cron-secret'],
  optionsSuccessStatus: 200,
}));
app.options("*", cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// â”€â”€ Rate limiting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  message: { error: 'Too many requests, please try again later.' },
}));

// â”€â”€ Health check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', app: 'Deemona AI Finance OS', timestamp: new Date().toISOString() });
});

// â”€â”€ API Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Auth
app.use('/api/auth', createAuthRouter(pool));

// Finance Memory (Phase 1 â€” active now)
app.use('/api/memory', createMemoryRouter(pool));

// Accounting module (Phase A)
app.use('/api/accounting', createAccountingRouter(pool));
app.use('/api/agents',     createAgentRouter(pool));
app.use('/api/treasury',   createTreasuryRouter(pool));
app.use('/api/procurement', createProcurementRouter(pool));
app.use('/api/payroll',     createPayrollRouter(pool));
app.use('/api/tax',        createTaxRouter(pool));
app.use('/api/budgeting',  createBudgetingRouter(pool));
app.use('/api/expenses',   createExpensesRouter(pool));
app.use('/api/assets',     createAssetsRouter(pool));
app.use('/api/inventory',  createInventoryRouter(pool));
app.use('/api/projects',   createProjectsRouter(pool));
app.use('/api/compliance', createComplianceRouter(pool));
app.use('/api/crm',        createCRMRouter(pool));
app.use('/api/statements',  createStatementsRouter(pool));
app.use('/api/cfo',         createCFOAgentRouter(pool));
app.use('/api/document-ai', createDocumentAIRouter(pool));
app.use('/api/automation',  createAutomationRouter(pool));
app.use('/api/tax-agent',   createTaxAgentRouter(pool));
app.use('/api/audit',       createAuditAgentRouter(pool));
app.use('/api/marketplace', createMarketplaceRouter(pool));
app.use('/api/tally',       createTallyRouter(pool));
app.use('/api/currency', createCurrencyRouter(pool));
app.use('/api/whatsapp',    createWhatsAppRouter(pool));
app.use('/api/email-ai',    createEmailAIRouter(pool));
app.use('/api/forecasting', createForecastingRouter(pool));
app.use('/api/scheduler',   createSchedulerRouter(pool));
app.use('/api/sdk',         createSDKRouter(pool));
app.use('/api/ai-studio',   createAIStudioRouter(pool));
app.use('/api/rbac',        createRBACRouter(pool));
app.use('/api/docs', createMissingDocsRouter(pool));
  app.use('/api/docs2', createBatch2DocsRouter(pool));
  app.use('/api/docs3', createBatch3DocsRouter(pool));
  app.use('/api/dashboard', createDashboardRouter(pool));
  app.use('/api/events', createEventBusRouter(pool));
  app.use('/api/auto-ingest', createAutoIngestRouter(pool));
  app.use('/api/ai', createPhase1Router(pool));
  app.use('/api/docs4', createBatch4DocsRouter(pool));
  app.use('/api/drive-monitor', createDriveMonitorRouter(pool));
  app.use('/api/ingest', createDataIngestionRouter(pool));
  app.use('/api/automation', createAutomationTestRouter(pool));
  app.use('/api/monitor', createMonitorSettingsRouter(pool));
app.use('/api/notifications', createNotificationRouter(pool));
app.use('/api/billing',     createBillingRouter(pool));
app.use('/api/admin',       createAdminRouter(pool));
app.use('/api/export',      createDataExportRouter(pool));

// Future routes â€” uncomment as each phase is built:
// app.use('/api/auth',        authRouter(pool));
// app.use('/api/accounting',  accountingRouter(pool));
// app.use('/api/treasury',    treasuryRouter(pool));
// app.use('/api/procurement', procurementRouter(pool));
// app.use('/api/payroll',     payrollRouter(pool));
// app.use('/api/tax',         taxRouter(pool));
// app.use('/api/compliance',  complianceRouter(pool));
// app.use('/api/crm',         crmRouter(pool));
// app.use('/api/inventory',   inventoryRouter(pool));
// app.use('/api/assets',      assetsRouter(pool));
// app.use('/api/projects',    projectsRouter(pool));
// app.use('/api/expenses',    expensesRouter(pool));
// app.use('/api/budgeting',   budgetingRouter(pool));
// app.use('/api/agents',      agentsRouter(pool));        // Phase 4
// app.use('/api/twin',        digitalTwinRouter(pool));   // Phase 5
// app.use('/api/automation',  automationRouter(pool));    // Phase 2

// â”€â”€ AI Brief endpoint (no auth â€” for Decision Center) â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/brief', async (req: express.Request, res: express.Response) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
      return;
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json() as any;
    console.log('[Brief] Response status:', response.status);
    if (!response.ok) {
      console.error('[Brief] API error:', data);
      res.status(500).json({ error: data?.error?.message ?? 'API error' });
      return;
    }
    const text = data?.content?.[0]?.text ?? '';
    res.json({ text });
  } catch (err) {
    console.error('[Brief] Error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// â”€â”€ 404 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// â”€â”€ Global error handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// â”€â”€ Cron jobs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function registerCronJobs() {
  // Every 30 seconds â€” generate embeddings for new memories
  cron.schedule('*/30 * * * * *', () => processEmbeddingQueue(pool));

  // Every 6 hours â€” refresh AI summaries for vendors/customers
  cron.schedule('0 */6 * * *', () => refreshEntityProfiles(pool));

  // Daily at 2am IST (8:30pm UTC) â€” archive old low-priority memories
  cron.schedule('30 20 * * *', () => archiveOldMemories(pool));

  console.log('[Cron] 3 Finance Memory jobs registered');
}

// â”€â”€ Start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function start() {
  await testConnection();
  registerCronJobs();
  
// ── pg_notify CDC — Real-Time Change Detection ───────────────
// Listen for any DB changes and broadcast to connected SSE clients

const setupCDC = async () => {
  const cdcClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await cdcClient.connect();

  // Create notification triggers for key tables
  await cdcClient.query(`
    CREATE OR REPLACE FUNCTION notify_data_change()
    RETURNS trigger AS $
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
    $ LANGUAGE plpgsql;
  `).catch(() => {});

  // Add triggers to key tables
  const tables = [
    'ar_invoices', 'ap_invoices', 'expenses', 'bank_transactions',
    'payments', 'employees', 'purchase_orders', 'inventory_items',
    'journal_entries', 'bank_accounts'
  ];

  for (const table of tables) {
    await cdcClient.query(`
      DROP TRIGGER IF EXISTS ${table}_notify ON ${table};
      CREATE TRIGGER ${table}_notify
      AFTER INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION notify_data_change();
    `).catch(() => {});
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
      console.log(`[CDC] ${payload.action} on ${payload.table} for tenant ${tenantId?.substring(0,8)}`);
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
  const data = `data: ${JSON.stringify(event)}

`;
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
    const jwtLib = require('jsonwebtoken');
    const decoded = jwtLib.verify(token, process.env.JWT_SECRET || 'deemona-secret-2024') as any;
    tenantId = decoded.tenantId;
  } catch { return res.status(401).end(); }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Register client
  if (!sseClients.has(tenantId)) sseClients.set(tenantId, new Set());
  sseClients.get(tenantId)!.add(res);
  console.log(`[SSE] Client connected for tenant ${tenantId?.substring(0,8)}, total: ${sseClients.get(tenantId)!.size}`);

  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}

`);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}

`); }
    catch { clearInterval(heartbeat); }
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.get(tenantId)?.delete(res);
    console.log(`[SSE] Client disconnected for tenant ${tenantId?.substring(0,8)}`);
  });
});

// Start CDC after DB connection
setupCDC().catch(e => console.error('[CDC] Setup failed:', e.message));

app.listen(PORT, () => {
    console.log(`[Server] Deemona AI Finance OS running on port ${PORT}`);
    console.log(`[Server] Health: http://localhost:${PORT}/health`);

  // Start autonomous Drive monitor if configured
  if (process.env.DRIVE_FOLDER_ID) {
    console.log('[Monitor] Starting autonomous Google Drive monitor...');
    registerAutomationCrons(pool);
    startMultiTenantMonitor(pool).catch(err => {
      console.error('[Monitor] Fatal error:', err);
      // Restart after 30s — never permanently stop
      setTimeout(() => startMultiTenantMonitor(pool), 30000);
    });
  } else {
    console.log('[Monitor] DRIVE_FOLDER_ID not set — monitor not started. Add to Render env vars to activate.');
  }
  });
}

start().catch(err => {
  console.error('[Server] Failed to start:', err.message);
  process.exit(1);
});


// Auto Report Scheduler - runs every minute
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const currentTime = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    const currentDay = now.getDay();
    const currentDate = now.getDate();
    const result = await pool.query("SELECT tenant_id, setting_key, setting_value FROM monitor_settings WHERE setting_key LIKE 'report_schedule_%'").catch(() => ({ rows: [] }));
    for (const row of result.rows) {
      try {
        const sched = JSON.parse(row.setting_value || '{}');
        if (!sched.enabled || !sched.email || !sched.time) continue;
        if (sched.time !== currentTime) continue;
        const freq = sched.frequency;
        const shouldRun = freq === 'daily' || (freq === 'weekly' && parseInt(sched.dayOfWeek ?? 1) === currentDay) || (freq === 'monthly' && currentDate === 1);
        if (!shouldRun) continue;
        const { REPORT_REGISTRY } = await import('./routes/reportEngine');
        const registry = REPORT_REGISTRY[row.setting_key.replace('report_schedule_', '')];
        if (!registry) continue;
        const { subject, html } = await registry.fn(pool, row.tenant_id, sched.threshold || 100000);
        const { Resend } = await import('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        const { error } = await resend.emails.send({ from: 'Deemona Finance OS <onboarding@resend.dev>', to: sched.email, subject, html });
        if (!error) {
          await pool.query("INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at) VALUES ($1, $2, $3, $4, NOW())", [row.tenant_id, 'SCHEDULED_REPORT', 'success', registry.label + ' auto-sent to ' + sched.email]).catch(() => {});
          console.log('[Cron] Sent:', registry.label, 'to', sched.email);
        }
      } catch(e) { console.error('[Cron] Error:', e); }
    }
  } catch(e) { console.error('[Cron] Fatal:', e); }
});
console.log('[Cron] Report scheduler started');

