const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/automationTestRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

const newEndpoints = `
  // ── New batch test endpoints ──────────────────────────────

  router.post('/test/morning-brief', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).sendDailyMorningBrief(pool, tid(req)); res.json({ message: 'Daily morning brief sent', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/weekly-digest', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).sendWeeklyDigest(pool, tid(req)); res.json({ message: 'Weekly digest sent', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/payment-reminders', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).sendInvoicePaymentReminders(pool, tid(req)); res.json({ message: 'Payment reminders sent for overdue invoices', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/payslip-distribution', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).distributePayslips(pool, tid(req)); res.json({ message: 'Payslip distribution triggered', detail: 'Payslips emailed to all employees from latest payroll run', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/fraud-detection', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).runFraudDetection(pool, tid(req)); res.json({ message: 'Fraud detection scan complete', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/gstin-check', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).checkVendorGSTINCompliance(pool, tid(req)); res.json({ message: 'GSTIN compliance check complete', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/cashflow-prediction', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).predictCashFlow(pool, tid(req)); res.json({ message: 'Cash flow prediction complete', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/budget-burnout', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).predictBudgetBurnout(pool, tid(req)); res.json({ message: 'Budget burnout analysis complete', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/aging-report', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).sendInvoiceAgingReport(pool, tid(req)); res.json({ message: 'AR aging report sent', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/tds-tracking', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).trackTDS(pool, tid(req)); res.json({ message: 'TDS tracking summary sent', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/credit-limits', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).checkCreditLimits(pool, tid(req)); res.json({ message: 'Credit limit check complete', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/expense-policy', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).enforceExpensePolicy(pool, tid(req)); res.json({ message: 'Expense policy enforcement complete', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/statutory-dates', requireAuth, async (req: Request, res: Response) => {
    try {
      await pool.query("DELETE FROM automation_logs WHERE automation_type='STATUTORY_ALERT' AND created_at > NOW()-INTERVAL '24 hours'");
      await (await import('../services/automationEngine')).checkStatutoryDueDates(pool, tid(req));
      res.json({ message: 'Statutory dates check complete', success: true });
    } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/contract-monitor', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).monitorContracts(pool, tid(req)); res.json({ message: 'Contract/probation monitor complete', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/budget-reallocation', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).analyzeBudgetReallocation(pool, tid(req)); res.json({ message: 'Budget reallocation analysis complete', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/recurring-invoices', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).generateRecurringInvoices(pool, tid(req)); res.json({ message: 'Recurring invoice generation checked', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/revenue-forecast', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).generateRevenueForecast(pool, tid(req)); res.json({ message: 'Revenue forecast sent', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/payment-patterns', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).analyzeCustomerPaymentPatterns(pool, tid(req)); res.json({ message: 'Customer payment pattern analysis sent', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/contract-renewal', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).checkContractRenewals(pool, tid(req)); res.json({ message: 'Contract renewal check complete', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/insurance-track', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).trackInsurancePremiums(pool, tid(req)); res.json({ message: 'Insurance tracking check complete', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/pf-ecr', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).generatePFECRFile(pool, tid(req)); res.json({ message: 'PF/ESI ECR file generation triggered', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/appraisal-trigger', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).checkAppraisalTriggers(pool, tid(req)); res.json({ message: 'Appraisal trigger check complete', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });

  router.post('/test/budget-reallocation-monthly', requireAuth, async (req: Request, res: Response) => {
    try { await (await import('../services/automationEngine')).analyzeBudgetReallocation(pool, tid(req)); res.json({ message: 'Monthly budget reallocation analysis complete', success: true }); } catch (e) { res.json({ error: String(e) }); }
  });
`;

// Insert before return router
c = c.replace('  return router;\n}', newEndpoints + '\n  return router;\n}');
fs.writeFileSync(f, c, 'utf8');
console.log('Added', (newEndpoints.match(/router\.post/g)||[]).length, 'new test endpoints');
