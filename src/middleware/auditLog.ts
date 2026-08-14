// ============================================================
// Audit Trail Middleware
// ============================================================
import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';

export function createAuditLogger(pool: Pool) {
  return function auditLog(action: string, module: string) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const originalJson = res.json.bind(res);
      res.json = function(data: any) {
        // Log after successful response
        if (res.statusCode < 400) {
          const user = (req as any).user;
          if (user) {
            pool.query(
              `INSERT INTO audit_log (tenant_id, user_id, user_name, action, module, resource_id, details, ip_address, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
               ON CONFLICT DO NOTHING`,
              [
                user.tenantId,
                user.id,
                user.name || user.email || 'System',
                action,
                module,
                data?.id || data?.invoice?.id || data?.employee?.id || null,
                JSON.stringify({ method: req.method, path: req.path, body: req.body }).substring(0, 500),
                req.ip,
              ]
            ).catch(() => {}); // Non-blocking
          }
        }
        return originalJson(data);
      };
      next();
    };
  };
}

export async function getAuditLog(pool: Pool, tenantId: string, options: { limit?: number; module?: string; userId?: string }) {
  const { limit = 50, module, userId } = options;
  let q = 'SELECT * FROM audit_log WHERE tenant_id=$1';
  const params: any[] = [tenantId];
  let idx = 2;
  if (module) { q += ` AND module=$${idx++}`; params.push(module); }
  if (userId) { q += ` AND user_id=$${idx++}`; params.push(userId); }
  q += ` ORDER BY created_at DESC LIMIT $${idx}`;
  params.push(limit);
  const result = await pool.query(q, params);
  return result.rows;
}
