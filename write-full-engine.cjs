const fs = require('fs');

// Read batch files
const batch1 = fs.readFileSync('C:/deemona-finance-os/backend/automationBatch1.ts', 'utf8');
const batch2 = fs.readFileSync('C:/deemona-finance-os/backend/automationBatch2.ts', 'utf8');

// Strip export keywords from batch files (they'll be in same file)
const b1 = batch1.replace(/^\/\/ =+.*\n.*\n.*\n.*\n.*\n/m, '').replace(/export async function/g, 'async function');
const b2 = batch2.replace(/^\/\/ =+.*\n.*\n.*\n/m, '').replace(/export async function/g, 'async function');

// Read existing engine
const enginePath = 'C:/deemona-finance-os/backend/src/services/automationEngine.ts';
let engine = fs.readFileSync(enginePath, 'utf8');

// Add batch functions before registerAutomationCrons
const insertPoint = 'async function ensureAutomationLogs';
if (!engine.includes('sendDailyMorningBrief')) {
  engine = engine.replace(insertPoint, b1 + '\n\n' + b2 + '\n\n' + insertPoint);
  console.log('Batch functions added');
} else {
  console.log('Already added');
}

// Update registerAutomationCrons to call new functions
const newCrons = `
  // Daily at 8AM IST (2:30 UTC) - Morning Brief
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() === 2 && now.getUTCMinutes() < 16) {
      try {
        const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
        for (const t of tenants.rows) {
          await sendDailyMorningBrief(pool, t.id).catch(() => {});
          await sendInvoicePaymentReminders(pool, t.id).catch(() => {});
          await sendInvoiceAgingReport(pool, t.id).catch(() => {});
          await checkStatutoryDueDates(pool, t.id).catch(() => {});
        }
      } catch(e) { console.error('[Automation] Daily 8AM cron:', e); }
    }
    // Monday 9AM IST (3:30 UTC) - Weekly Digest
    if (now.getUTCDay() === 1 && now.getUTCHours() === 3 && now.getUTCMinutes() < 16) {
      try {
        const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
        for (const t of tenants.rows) {
          await sendWeeklyDigest(pool, t.id).catch(() => {});
        }
      } catch(e) { console.error('[Automation] Weekly cron:', e); }
    }
  }, 15 * MINUTE);

  // Every 30 minutes - Fraud, Credit, Expense Policy
  setInterval(async () => {
    try {
      const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
      for (const t of tenants.rows) {
        await runFraudDetection(pool, t.id).catch(() => {});
        await checkCreditLimits(pool, t.id).catch(() => {});
        await enforceExpensePolicy(pool, t.id).catch(() => {});
        await checkVendorGSTINCompliance(pool, t.id).catch(() => {});
      }
    } catch(e) { console.error('[Automation] 30min cron:', e); }
  }, 30 * MINUTE);

  // Every 6 hours - TDS, Budget, Cash Flow Prediction, Contracts
  setInterval(async () => {
    try {
      const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
      for (const t of tenants.rows) {
        await trackTDS(pool, t.id).catch(() => {});
        await predictBudgetBurnout(pool, t.id).catch(() => {});
        await predictCashFlow(pool, t.id).catch(() => {});
        await monitorContracts(pool, t.id).catch(() => {});
      }
    } catch(e) { console.error('[Automation] 6hr cron:', e); }
  }, 6 * HOUR);

  // Payslip distribution - after payroll (check every hour)
  setInterval(async () => {
    try {
      const tenants = await pool.query('SELECT id FROM tenants LIMIT 20');
      for (const t of tenants.rows) {
        await distributePayslips(pool, t.id).catch(() => {});
      }
    } catch(e) { console.error('[Automation] Payslip cron:', e); }
  }, HOUR);
`;

// Add new crons before the final console.log
engine = engine.replace(
  "console.log('[Automation] Cron jobs registered:",
  newCrons + "\n  console.log('[Automation] Cron jobs registered:"
);

fs.writeFileSync(enginePath, engine, { encoding: 'utf8', flag: 'w' });
console.log('Full engine written. Size:', engine.length);
