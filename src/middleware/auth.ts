import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  /*sse-token*/
  const authHeader = req.headers.authorization;
  // Browsers cannot set headers on EventSource, so the live-updates stream (and only it) may pass ?token=
  const isStream = req.method === 'GET' && (req.originalUrl || '').split('?')[0] === '/api/events/stream';
  const qToken = isStream && typeof req.query.token === 'string' ? req.query.token : '';
  if (!authHeader?.startsWith('Bearer ') && !qToken) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : qToken;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as AuthUser;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
