const fs = require('fs');

const batch3 = fs.readFileSync('C:/deemona-finance-os/backend/automationBatch3.ts', 'utf8');
const b3 = batch3.replace(/^\/\/.*\n.*\n.*\n.*\n.*\n.*\n/m, '');

const enginePath = 'C:/deemona-finance-os/backend/src/services/automationEngine.ts';
let engine = fs.readFileSync(enginePath, 'utf8');

if (!engine.includes('generateRecurringInvoices')) {
  engine = engine.replace('async function ensureAutomationLogs', b3 + '\n\nasync function ensureAutomationLogs');
  console.log('Batch 3 functions added');
} else {
  console.log('Already added');
}

// Add new crons
const newCrons = `
  // Every 6 hours - additional batch 3 functions
  setInterval(async () => {
    try {
      const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
      for (const t of tenants.rows) {
        await generateRecurringInvoices(pool, t.id).catch(() => {});
        await checkContractRenewals(pool, t.id).catch(() => {});
        await trackInsurancePremiums(pool, t.id).catch(() => {});
        await checkAppraisalTriggers(pool, t.id).catch(() => {});
        await analyzeCustomerPaymentPatterns(pool, t.id).catch(() => {});
      }
    } catch(e) { console.error('[Automation] Batch3 6hr cron:', e); }
  }, 6 * HOUR);

  // Monthly - revenue forecast, budget reallocation, PF ECR (on 1st)
  setInterval(async () => {
    const now = new Date();
    if (now.getDate() === 1 && now.getUTCHours() === 4) {
      try {
        const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
        for (const t of tenants.rows) {
          await generateRevenueForecast(pool, t.id).catch(() => {});
          await analyzeBudgetReallocation(pool, t.id).catch(() => {});
          await generatePFECRFile(pool, t.id).catch(() => {});
        }
      } catch(e) { console.error('[Automation] Monthly cron:', e); }
    }
  }, HOUR);
`;

engine = engine.replace(
  "console.log('[Automation] Cron jobs registered:",
  newCrons + "\n  console.log('[Automation] Cron jobs registered:"
);

fs.writeFileSync(enginePath, engine, { encoding: 'utf8', flag: 'w' });
console.log('Done. Engine size:', engine.length);
