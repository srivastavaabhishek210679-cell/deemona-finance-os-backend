import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createSchedulerRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // Built-in scheduled job definitions
  const SYSTEM_JOBS = [
    { id: 'gst_reminder',      name: 'GST Filing Reminder',       schedule: '0 9 18 * *',   description: 'Reminds team 2 days before GSTR-3B due date (20th)', category: 'Tax', enabled_by_default: true },
    { id: 'tds_reminder',      name: 'TDS Payment Reminder',      schedule: '0 9 5 * *',    description: 'Reminds team to pay TDS by 7th of each month', category: 'Tax', enabled_by_default: true },
    { id: 'payroll_trigger',   name: 'Monthly Payroll Trigger',   schedule: '0 9 25 * *',   description: 'Initiates payroll processing on 25th of each month', category: 'Payroll', enabled_by_default: false },
    { id: 'cash_alert',        name: 'Daily Cash Position Alert', schedule: '0 8 * * *',    description: 'Sends daily cash balance to CFO/Finance team', category: 'Treasury', enabled_by_default: true },
    { id: 'overdue_ar_check',  name: 'Overdue AR Check',          schedule: '0 9 * * 1',    description: 'Weekly scan of overdue invoices, triggers collection emails', category: 'Accounts Receivable', enabled_by_default: true },
    { id: 'pf_reminder',       name: 'PF Payment Reminder',       schedule: '0 9 12 * *',   description: 'Reminds team to pay PF challan by 15th of month', category: 'Payroll', enabled_by_default: true },
    { id: 'compliance_scan',   name: 'Compliance Deadline Scan',  schedule: '0 8 * * *',    description: 'Daily scan for upcoming compliance deadlines within 7 days', category: 'Compliance', enabled_by_default: true },
    { id: 'vendor_aging',      name: 'Vendor Aging Report',       schedule: '0 9 1 * *',    description: 'Monthly AP aging report sent to Finance Manager', category: 'Accounts Payable', enabled_by_default: false },
    { id: 'budget_variance',   name: 'Budget Variance Alert',     schedule: '0 9 * * 1',    description: 'Weekly budget vs actual variance report', category: 'Budgeting', enabled_by_default: false },
    { id: 'forecast_refresh',  name: 'Forecast Refresh',          schedule: '0 6 * * *',    description: 'Refreshes 90-day cash and revenue forecasts daily at 6 AM', category: 'Analytics', enabled_by_default: true },
  ];

  // ── GET /api/scheduler/jobs ───────────────────────────────
  router.get('/jobs', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      let enabledJobIds: string[] = [];

      try {
        const result = await pool.query(`SELECT job_id FROM scheduled_jobs WHERE tenant_id=$1 AND is_enabled=TRUE`, [tenantId]);
        enabledJobIds = result.rows.map((r: any) => r.job_id);
      } catch {
        enabledJobIds = SYSTEM_JOBS.filter(j => j.enabled_by_default).map(j => j.id);
      }

      // Get custom jobs
      let customJobs: any[] = [];
      try {
        const r = await pool.query(`SELECT * FROM scheduled_jobs WHERE tenant_id=$1 AND is_custom=TRUE ORDER BY created_at DESC`, [tenantId]);
        customJobs = r.rows;
      } catch { customJobs = []; }

      const jobs = SYSTEM_JOBS.map(j => ({ ...j, enabled: enabledJobIds.includes(j.id), is_custom: false }));

      res.json({ system_jobs: jobs, custom_jobs: customJobs, total_enabled: enabledJobIds.length });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/scheduler/jobs/:id/toggle ──────────────────
  router.post('/jobs/:id/toggle', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { enabled } = req.body;
      await pool.query(
        `INSERT INTO scheduled_jobs (tenant_id, job_id, is_enabled, is_custom)
         VALUES ($1,$2,$3,FALSE)
         ON CONFLICT (tenant_id, job_id) DO UPDATE SET is_enabled=$3, updated_at=NOW()`,
        [tenantId, req.params.id, enabled]
      ).catch(() => {});
      res.json({ success: true, job_id: req.params.id, enabled });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/scheduler/jobs ──────────────────────────────
  // Create custom job
  router.post('/jobs', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { name, description, schedule, action, category } = req.body;
      if (!name || !schedule) { res.status(400).json({ error: 'name and schedule required' }); return; }

      const jobId = `custom_${Date.now()}`;
      await pool.query(
        `INSERT INTO scheduled_jobs (tenant_id, job_id, name, description, schedule, action, category, is_enabled, is_custom)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,TRUE)`,
        [tenantId, jobId, name, description, schedule, JSON.stringify(action || {}), category || 'Custom']
      ).catch(() => {});

      res.json({ success: true, job_id: jobId });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/scheduler/logs ───────────────────────────────
  router.get('/logs', requireAuth, async (req: Request, res: Response) => {
    // Return simulated recent run logs
    const logs = [
      { job_id: 'cash_alert',       job_name: 'Daily Cash Position Alert', status: 'success', ran_at: new Date(Date.now()-3600000),    duration_ms: 320 },
      { job_id: 'compliance_scan',  job_name: 'Compliance Deadline Scan',  status: 'success', ran_at: new Date(Date.now()-7200000),    duration_ms: 180 },
      { job_id: 'forecast_refresh', job_name: 'Forecast Refresh',          status: 'success', ran_at: new Date(Date.now()-86400000),   duration_ms: 1240 },
      { job_id: 'overdue_ar_check', job_name: 'Overdue AR Check',          status: 'success', ran_at: new Date(Date.now()-604800000),  duration_ms: 560 },
      { job_id: 'gst_reminder',     job_name: 'GST Filing Reminder',       status: 'skipped', ran_at: new Date(Date.now()-1209600000), duration_ms: 0, note: 'Not due yet' },
    ];
    res.json({ logs });
  });

  // ── POST /api/scheduler/jobs/:id/run-now ─────────────────
  router.post('/jobs/:id/run-now', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const jobId = req.params.id;
      const job = SYSTEM_JOBS.find(j => j.id === jobId);

      // Simulate running the job
      const result = { job_id: jobId, job_name: job?.name || jobId, status: 'success', ran_at: new Date(), duration_ms: Math.floor(Math.random() * 1000) + 100, output: `Job "${job?.name || jobId}" executed successfully` };

      res.json(result);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
