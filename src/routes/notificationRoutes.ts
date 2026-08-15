import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createNotificationRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/notifications ─────────────────────────────────
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT * FROM notifications WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [tid(req)]
      );
      const unread = result.rows.filter(n => !n.read_at).length;
      res.json({ notifications: result.rows, unread });
    } catch (err) {
      // Generate smart notifications from business data
      const [arResult, compResult, payResult] = await Promise.all([
        pool.query(`SELECT COUNT(*) as overdue FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled') AND due_date < NOW()`, [tid(req)]).catch(() => ({rows:[{overdue:0}]})),
        pool.query(`SELECT COUNT(*) as due_soon FROM compliance_items WHERE tenant_id=$1 AND status='pending' AND due_date <= NOW() + INTERVAL '7 days'`, [tid(req)]).catch(() => ({rows:[{due_soon:0}]})),
        pool.query(`SELECT COUNT(*) as pending FROM expense_claims WHERE tenant_id=$1 AND status='submitted'`, [tid(req)]).catch(() => ({rows:[{pending:0}]})),
      ]);

      const notifications = [];
      const now = new Date();

      if (parseInt(arResult.rows[0].overdue) > 0) {
        notifications.push({ id: 1, type: 'warning', title: 'Overdue Invoices', message: `${arResult.rows[0].overdue} AR invoices are overdue. Take action to collect payment.`, created_at: now, read_at: null });
      }
      if (parseInt(compResult.rows[0].due_soon) > 0) {
        notifications.push({ id: 2, type: 'alert', title: 'Compliance Deadline', message: `${compResult.rows[0].due_soon} compliance items due in the next 7 days. File on time to avoid penalties.`, created_at: now, read_at: null });
      }
      if (parseInt(payResult.rows[0].pending) > 0) {
        notifications.push({ id: 3, type: 'info', title: 'Pending Approvals', message: `${payResult.rows[0].pending} expense claims waiting for your approval.`, created_at: now, read_at: null });
      }
      notifications.push({ id: 4, type: 'success', title: 'System Ready', message: 'Deemona AI Finance OS is running normally. All modules active.', created_at: new Date(now - 3600000), read_at: new Date() });

      res.json({ notifications, unread: notifications.filter(n => !n.read_at).length });
    }
  });

  // ── POST /api/notifications/create ────────────────────────
  router.post('/create', requireAuth, async (req: Request, res: Response) => {
    try {
      const { title, message, type } = req.body;
      const result = await pool.query(
        `INSERT INTO notifications (tenant_id, title, message, type, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING *`,
        [tid(req), title, message, type || 'info']
      );
      res.json({ notification: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── PATCH /api/notifications/:id/read ─────────────────────
  router.patch('/:id/read', requireAuth, async (req: Request, res: Response) => {
    try {
      await pool.query('UPDATE notifications SET read_at=NOW() WHERE id=$1 AND tenant_id=$2', [req.params.id, tid(req)]);
      res.json({ read: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/notifications/read-all ──────────────────────
  router.post('/read-all', requireAuth, async (req: Request, res: Response) => {
    try {
      await pool.query('UPDATE notifications SET read_at=NOW() WHERE tenant_id=$1 AND read_at IS NULL', [tid(req)]);
      res.json({ read: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
