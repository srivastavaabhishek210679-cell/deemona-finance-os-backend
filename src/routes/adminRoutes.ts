import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

// Platform admin check — only platform owner email
const isPlatformAdmin = (req: Request): boolean => {
  const user = (req as any).user;
  return user?.email === process.env.PLATFORM_ADMIN_EMAIL || user?.role_name === 'platform_admin';
};

const requirePlatformAdmin = (req: Request, res: Response, next: any) => {
  if (!isPlatformAdmin(req)) { res.status(403).json({ error: 'Platform admin access required' }); return; }
  next();
};

export function createAdminRouter(pool: Pool): Router {
  const router = Router();

  // ── GET /api/admin/tenants ────────────────────────────────
  router.get('/tenants', requireAuth, requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      const { search, plan, status } = req.query;
      let q = `SELECT t.*, p.name as plan_name, p.price_monthly,
                 (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id) as user_count,
                 (SELECT COUNT(*) FROM ar_invoices ar WHERE ar.tenant_id=t.id) as invoice_count,
                 (SELECT COUNT(*) FROM employees e WHERE e.tenant_id=t.id) as employee_count,
                 s.status as sub_status, s.current_period_end
               FROM tenants t
               LEFT JOIN plans p ON p.id=COALESCE(t.plan_id,'free')
               LEFT JOIN subscriptions s ON s.tenant_id=t.id
               WHERE 1=1`;
      const params: any[] = [];

      if (search) { params.push(`%${search}%`); q += ` AND (t.name ILIKE $${params.length} OR t.slug ILIKE $${params.length})`; }
      if (plan)   { params.push(plan); q += ` AND t.plan_id=$${params.length}`; }

      q += ' ORDER BY t.created_at DESC LIMIT 100';
      const result = await pool.query(q, params);
      res.json({ tenants: result.rows, total: result.rows.length });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/admin/stats ──────────────────────────────────
  router.get('/stats', requireAuth, requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      const [tenants, users, revenue, plans, recentTenants] = await Promise.all([
        pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '30 days') as new_30d, COUNT(*) FILTER (WHERE is_active=TRUE) as active FROM tenants`),
        pool.query(`SELECT COUNT(*) as total FROM users`),
        pool.query(`SELECT COALESCE(SUM(amount),0) as total, COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month',CURRENT_DATE)),0) as this_month FROM payments WHERE status='captured'`),
        pool.query(`SELECT plan_id, COUNT(*) as count FROM tenants GROUP BY plan_id`),
        pool.query(`SELECT t.name, t.slug, t.plan_id, t.created_at, p.name as plan_name FROM tenants t LEFT JOIN plans p ON p.id=COALESCE(t.plan_id,'free') ORDER BY t.created_at DESC LIMIT 10`),
      ]);

      res.json({
        tenants: tenants.rows[0],
        users: users.rows[0],
        revenue: revenue.rows[0],
        plan_distribution: plans.rows,
        recent_tenants: recentTenants.rows,
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/admin/tenants/:id ────────────────────────────
  router.get('/tenants/:id', requireAuth, requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      const [tenant, users, usage] = await Promise.all([
        pool.query(`SELECT t.*, p.name as plan_name FROM tenants t LEFT JOIN plans p ON p.id=COALESCE(t.plan_id,'free') WHERE t.id=$1`, [req.params.id]),
        pool.query(`SELECT id,email,first_name,last_name,role_name,last_login,is_active,created_at FROM users WHERE tenant_id=$1`, [req.params.id]),
        pool.query(`SELECT (SELECT COUNT(*) FROM ar_invoices WHERE tenant_id=$1) as ar_count, (SELECT COUNT(*) FROM ap_invoices WHERE tenant_id=$1) as ap_count, (SELECT COUNT(*) FROM employees WHERE tenant_id=$1) as emp_count, (SELECT COUNT(*) FROM bank_transactions WHERE tenant_id=$1) as txn_count, (SELECT COALESCE(SUM(current_balance),0) FROM bank_accounts WHERE tenant_id=$1) as total_balance`, [req.params.id]),
      ]);

      if (!tenant.rows.length) { res.status(404).json({ error: 'Tenant not found' }); return; }
      res.json({ tenant: tenant.rows[0], users: users.rows, usage: usage.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/admin/tenants/:id/plan ─────────────────────
  router.post('/tenants/:id/plan', requireAuth, requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      const { plan_id, reason } = req.body;
      await pool.query(`UPDATE tenants SET plan_id=$1 WHERE id=$2`, [plan_id, req.params.id]);
      await pool.query(`INSERT INTO subscriptions (tenant_id, plan_id, status) VALUES ($1,$2,'active') ON CONFLICT (tenant_id) DO UPDATE SET plan_id=$2, status='active', updated_at=NOW()`, [req.params.id, plan_id]);
      res.json({ success: true, plan_id, reason });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/admin/tenants/:id/suspend ──────────────────
  router.post('/tenants/:id/suspend', requireAuth, requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      const { reason } = req.body;
      await pool.query(`UPDATE tenants SET is_active=FALSE, suspended_at=NOW(), metadata=metadata||$1 WHERE id=$2`, [JSON.stringify({ suspended_reason: reason }), req.params.id]);
      res.json({ success: true, message: 'Tenant suspended' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/admin/tenants/:id/activate ─────────────────
  router.post('/tenants/:id/activate', requireAuth, requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      await pool.query(`UPDATE tenants SET is_active=TRUE, suspended_at=NULL WHERE id=$1`, [req.params.id]);
      res.json({ success: true, message: 'Tenant activated' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/admin/revenue ────────────────────────────────
  router.get('/revenue', requireAuth, requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      const monthly = await pool.query(`
        SELECT TO_CHAR(created_at,'YYYY-MM') as month, COALESCE(SUM(amount),0) as revenue, COUNT(*) as payments
        FROM payments WHERE status='captured'
        GROUP BY month ORDER BY month DESC LIMIT 12
      `);
      const byPlan = await pool.query(`
        SELECT p.plan_id, pl.name as plan_name, COUNT(*) as count, COALESCE(SUM(p.amount),0) as revenue
        FROM payments p JOIN plans pl ON pl.id=p.plan_id
        WHERE p.status='captured' GROUP BY p.plan_id, pl.name
      `);
      res.json({ monthly: monthly.rows, by_plan: byPlan.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
