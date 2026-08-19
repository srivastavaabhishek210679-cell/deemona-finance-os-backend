import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
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
  origin: [process.env.FRONTEND_URL || 'http://localhost:5174', 'http://localhost:5174', 'http://localhost:5173', 'https://deemona-finance-os-frontend.onrender.com'],
  credentials: true,
}));
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







