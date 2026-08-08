import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';

// Permission definitions
export const PERMISSIONS = {
  owner:     ['*'],
  admin:     ['accounting.*','treasury.*','procurement.*','payroll.*','tax.*','budgeting.*','expenses.*','assets.*','inventory.*','projects.*','compliance.*','crm.*','reports.*','users.read','users.invite','settings.*'],
  manager:   ['accounting.read','accounting.approve','treasury.read','procurement.*','payroll.read','expenses.approve','projects.*','crm.*','reports.read'],
  accountant:['accounting.*','treasury.read','expenses.read','reports.*','tax.read'],
  staff:     ['accounting.read','treasury.read','expenses.submit','projects.read','crm.read','reports.read'],
  viewer:    ['accounting.read','treasury.read','reports.read','projects.read'],
};

export function hasPermission(role: string, permission: string): boolean {
  const perms = PERMISSIONS[role as keyof typeof PERMISSIONS] || [];
  if (perms.includes('*')) return true;
  if (perms.includes(permission)) return true;
  // Check wildcard — e.g. 'accounting.*' covers 'accounting.read'
  const [module, action] = permission.split('.');
  if (perms.includes(`${module}.*`)) return true;
  return false;
}

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const role = user.role || user.role_name || 'viewer';
    if (hasPermission(role, permission)) {
      next();
    } else {
      res.status(403).json({
        error: 'Forbidden',
        message: `Your role (${role}) does not have permission: ${permission}`,
        required_permission: permission,
        your_role: role,
      });
    }
  };
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const role = user.role || user.role_name || 'viewer';
    if (roles.includes(role) || role === 'owner') {
      next();
    } else {
      res.status(403).json({ error: 'Forbidden', required_roles: roles, your_role: role });
    }
  };
}

export function createRBACRouter(pool: Pool) {
  const { Router } = require('express');
  const { requireAuth } = require('./auth');
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/rbac/roles ───────────────────────────────────
  router.get('/roles', requireAuth, async (req: Request, res: Response) => {
    try {
      const roles = Object.entries(PERMISSIONS).map(([name, perms]) => ({
        name,
        permissions: perms,
        permission_count: perms.includes('*') ? 'All' : perms.length,
      }));
      res.json({ roles });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/rbac/users ───────────────────────────────────
  router.get('/users', requireAuth, requirePermission('users.read'), async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const result = await pool.query(
        `SELECT id, email, first_name, last_name, role_name, department, phone, last_login, is_active, created_at
         FROM users WHERE tenant_id=$1 ORDER BY created_at ASC`,
        [tenantId]
      );
      res.json({ users: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── PUT /api/rbac/users/:id/role ──────────────────────────
  router.put('/users/:id/role', requireAuth, requireRole('owner', 'admin'), async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { role_name } = req.body;
      const validRoles = Object.keys(PERMISSIONS);
      if (!validRoles.includes(role_name)) {
        res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` }); return;
      }
      await pool.query(
        `UPDATE users SET role_name=$1 WHERE id=$2 AND tenant_id=$3`,
        [role_name, req.params.id, tenantId]
      );
      res.json({ success: true, user_id: req.params.id, new_role: role_name });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── PUT /api/rbac/users/:id/toggle ───────────────────────
  router.put('/users/:id/toggle', requireAuth, requireRole('owner', 'admin'), async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const result = await pool.query(
        `UPDATE users SET is_active = NOT is_active WHERE id=$1 AND tenant_id=$2 RETURNING is_active, email`,
        [req.params.id, tenantId]
      );
      res.json({ success: true, ...result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/rbac/invite ─────────────────────────────────
  router.post('/invite', requireAuth, requirePermission('users.invite'), async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const userId = (req as any).user.id;
      const { email, role_name = 'staff' } = req.body;
      if (!email) { res.status(400).json({ error: 'email required' }); return; }

      const crypto = require('crypto');
      const token = crypto.randomBytes(32).toString('hex');

      await pool.query(
        `INSERT INTO user_invitations (tenant_id, invited_by, email, role_name, token)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT DO NOTHING`,
        [tenantId, userId, email.toLowerCase(), role_name, token]
      );

      const inviteLink = `${process.env.FRONTEND_URL}/accept-invite?token=${token}`;
      res.json({ success: true, invite_link: inviteLink, email, role_name, expires_in: '7 days' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/rbac/accept-invite ─────────────────────────
  router.post('/accept-invite', async (req: Request, res: Response) => {
    try {
      const { token, password, first_name, last_name } = req.body;
      if (!token || !password) { res.status(400).json({ error: 'token and password required' }); return; }

      const inv = await pool.query(
        `SELECT * FROM user_invitations WHERE token=$1 AND accepted_at IS NULL AND expires_at > NOW()`,
        [token]
      );
      if (!inv.rows.length) { res.status(400).json({ error: 'Invalid or expired invitation' }); return; }

      const invite = inv.rows[0];
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash(password, 12);

      const user = await pool.query(
        `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role_name, invited_by, is_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE) RETURNING id, email, first_name, role_name`,
        [invite.tenant_id, invite.email, hash, first_name||'User', last_name||'', invite.role_name, invite.invited_by]
      );

      await pool.query(`UPDATE user_invitations SET accepted_at=NOW() WHERE id=$1`, [invite.id]);
      res.json({ success: true, user: user.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/rbac/my-permissions ─────────────────────────
  router.get('/my-permissions', requireAuth, async (req: Request, res: Response) => {
    const user = (req as any).user;
    const role = user.role || user.role_name || 'viewer';
    res.json({ role, permissions: PERMISSIONS[role as keyof typeof PERMISSIONS] || [] });
  });

  return router;
}
