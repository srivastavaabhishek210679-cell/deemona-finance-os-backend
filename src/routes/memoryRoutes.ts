// ============================================================
// Deemona AI Finance OS — Finance Memory API Routes
// File: api/memoryRoutes.ts
// Drop into: deemona-api/src/routes/memoryRoutes.ts
// Mount at: app.use('/api/memory', memoryRouter)
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { getMemoryService, WriteMemoryInput, MemorySearchOptions, MemoryService } from '../services/memoryService';

export function createMemoryRouter(pool: Pool): Router {
  const router = Router();
  const svc = getMemoryService(pool);

  // ── Auth middleware (reuse your existing one) ────────────
  // We assume req.user = { id, tenantId, role } is set upstream.
  // Adjust if your auth middleware differs.
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!(req as any).user?.tenantId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

  const tenantId = (req: Request): string => (req as any).user.tenantId;

  // ────────────────────────────────────────────────────────
  // POST /api/memory/write
  // Write a new memory entry (called internally by other modules)
  // ────────────────────────────────────────────────────────
  router.post('/write', requireAuth, async (req: Request, res: Response) => {
    try {
      const input: WriteMemoryInput = {
        ...req.body,
        tenantId: tenantId(req),
        actorUserId: (req as any).user.id,
        actorName: (req as any).user.name ?? req.body.actorName ?? 'System',
        actorType: req.body.actorType ?? 'user',
      };

      if (!input.memoryType || !input.entityType || !input.title || !input.summary) {
        res.status(400).json({ error: 'Required: memoryType, entityType, title, summary' });
        return;
      }

      const id = await svc.write(input);
      res.json({ success: true, id });
    } catch (err) {
      console.error('[Memory] write error:', err);
      res.status(500).json({ error: 'Failed to write memory' });
    }
  });

  // ────────────────────────────────────────────────────────
  // GET /api/memory/search?q=...&module=...&type=...&limit=...
  // Hybrid semantic + keyword search
  // ────────────────────────────────────────────────────────
  router.get('/search', requireAuth, async (req: Request, res: Response) => {
    try {
      const { q, module, type, entityType, entityId, limit, mode, minImportance } = req.query;

      if (!q || typeof q !== 'string') {
        res.status(400).json({ error: 'Query param "q" is required' });
        return;
      }

      const options: MemorySearchOptions = {
        tenantId: tenantId(req),
        query: q,
        limit: Math.min(parseInt(String(limit ?? '10')), 50),
        module: module as any,
        memoryType: type as any,
        entityType: entityType as any,
        entityId: entityId as string | undefined,
        searchMode: (mode as any) ?? 'hybrid',
        minImportance: parseInt(String(minImportance ?? '1')),
      };

      const results = await svc.search(options);
      res.json({ results, count: results.length });
    } catch (err) {
      console.error('[Memory] search error:', err);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /api/memory/ask
  // AI-powered question answering over memory
  // Body: { question, conversationHistory? }
  // ────────────────────────────────────────────────────────
  router.post('/ask', requireAuth, async (req: Request, res: Response) => {
    try {
      const { question, conversationHistory } = req.body;

      if (!question || typeof question !== 'string') {
        res.status(400).json({ error: '"question" is required' });
        return;
      }

      const result = await svc.ask(tenantId(req), question, conversationHistory);

      // Save the Q&A as a conversation memory
      await svc.write({
        tenantId: tenantId(req),
        memoryType: 'ai_insight',
        entityType: 'user',
        entityId: (req as any).user.id,
        entityRef: `User: ${(req as any).user.name}`,
        title: `Memory query: "${question.slice(0, 60)}${question.length > 60 ? '...' : ''}"`,
        summary: result.answer.slice(0, 300),
        detail: { question, answer: result.answer, confidence: result.confidence, sourceCount: result.sources.length },
        actorUserId: (req as any).user.id,
        actorName: (req as any).user.name,
        actorType: 'user',
        importance: 2,
        tags: ['memory-query'],
      });

      res.json(result);
    } catch (err) {
      console.error('[Memory] ask error:', err);
      res.status(500).json({ error: 'Failed to process question' });
    }
  });

  // ────────────────────────────────────────────────────────
  // GET /api/memory/recent?limit=&module=&type=&minImportance=
  // Recent memory feed
  // ────────────────────────────────────────────────────────
  router.get('/recent', requireAuth, async (req: Request, res: Response) => {
    try {
      const { limit, module, type, minImportance } = req.query;
      const results = await svc.getRecent(tenantId(req), {
        limit: Math.min(parseInt(String(limit ?? '20')), 100),
        module: module as any,
        memoryType: type as any,
        minImportance: parseInt(String(minImportance ?? '1')),
      });
      res.json({ results, count: results.length });
    } catch (err) {
      console.error('[Memory] recent error:', err);
      res.status(500).json({ error: 'Failed to fetch recent memories' });
    }
  });

  // ────────────────────────────────────────────────────────
  // GET /api/memory/entity/:type/:id
  // Entity profile — all memories + AI summary for one entity
  // ────────────────────────────────────────────────────────
  router.get('/entity/:entityType/:entityId', requireAuth, async (req: Request, res: Response) => {
    try {
      const { entityType, entityId } = req.params;
      const profile = await svc.getEntityProfile(tenantId(req), entityType as any, entityId);
      if (!profile) {
        res.status(404).json({ error: 'No profile found for this entity' });
        return;
      }
      res.json(profile);
    } catch (err) {
      console.error('[Memory] entity profile error:', err);
      res.status(500).json({ error: 'Failed to fetch entity profile' });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /api/memory/entity/:type/:id/refresh
  // Regenerate AI summary for an entity (can be cron-triggered)
  // ────────────────────────────────────────────────────────
  router.post('/entity/:entityType/:entityId/refresh', requireAuth, async (req: Request, res: Response) => {
    try {
      const { entityType, entityId } = req.params;
      await svc.refreshEntityProfile(tenantId(req), entityType as any, entityId);
      res.json({ success: true });
    } catch (err) {
      console.error('[Memory] refresh error:', err);
      res.status(500).json({ error: 'Failed to refresh entity profile' });
    }
  });

  // ────────────────────────────────────────────────────────
  // Internal: POST /api/memory/queue/process
  // Called by cron job — processes pending embedding queue
  // Protect with internal secret header
  // ────────────────────────────────────────────────────────
  router.post('/queue/process', async (req: Request, res: Response) => {
    const secret = req.headers['x-internal-secret'];
    if (secret !== process.env.INTERNAL_CRON_SECRET) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const processed = await svc.processEmbeddingQueue(10);
      res.json({ processed });
    } catch (err) {
      console.error('[Memory] queue process error:', err);
      res.status(500).json({ error: 'Queue processing failed' });
    }
  });

  return router;
}

// ────────────────────────────────────────────────────────────
// MEMORY WRITER HELPERS
// Import these in any module to write memories without
// touching the HTTP layer. One helper per common event type.
// ────────────────────────────────────────────────────────────

export class MemoryWriter {
  constructor(
    private pool: Pool,
    private tenantId: string,
    private actorUserId?: string,
    private actorName?: string
  ) {}

  private get svc() { return getMemoryService(this.pool); }

  async invoiceApproved(invoiceId: string, invoiceRef: string, amount: number, vendorName: string, approvedBy: string) {
    return this.svc.write({
      tenantId: this.tenantId, memoryType: 'approval', entityType: 'invoice',
      entityId: invoiceId, entityRef: `Invoice: ${invoiceRef}`,
      title: `Invoice ${invoiceRef} approved — ${vendorName}`,
      summary: `Invoice of INR ${amount.toLocaleString('en-IN')} from ${vendorName} was approved by ${approvedBy}.`,
      detail: { invoiceId, invoiceRef, amount, vendorName, approvedBy },
      actorUserId: this.actorUserId, actorName: approvedBy, actorType: 'user',
      amount, module: 'accounting', tags: ['invoice', 'approval'],
      importance: 3,
    });
  }

  async invoiceRejected(invoiceId: string, invoiceRef: string, amount: number, vendorName: string, reason: string, rejectedBy: string) {
    return this.svc.write({
      tenantId: this.tenantId, memoryType: 'rejection', entityType: 'invoice',
      entityId: invoiceId, entityRef: `Invoice: ${invoiceRef}`,
      title: `Invoice ${invoiceRef} rejected — ${vendorName}`,
      summary: `Invoice of INR ${amount.toLocaleString('en-IN')} from ${vendorName} was rejected by ${rejectedBy}. Reason: ${reason}`,
      detail: { invoiceId, invoiceRef, amount, vendorName, reason, rejectedBy },
      actorUserId: this.actorUserId, actorName: rejectedBy, actorType: 'user',
      amount, module: 'accounting', tags: ['invoice', 'rejection', 'vendor'],
      importance: 4,
    });
  }

  async vendorBlocked(vendorId: string, vendorName: string, reason: string, blockedBy: string) {
    return this.svc.write({
      tenantId: this.tenantId, memoryType: 'vendor_event', entityType: 'vendor',
      entityId: vendorId, entityRef: `Vendor: ${vendorName}`,
      title: `Vendor blocked: ${vendorName}`,
      summary: `${vendorName} was blocked from the vendor master by ${blockedBy}. Reason: ${reason}`,
      detail: { vendorId, vendorName, reason, blockedBy },
      actorUserId: this.actorUserId, actorName: blockedBy, actorType: 'user',
      module: 'procurement', tags: ['vendor', 'blocked', 'procurement'],
      importance: 5,
    });
  }

  async fraudDetected(entityType: string, entityId: string, entityRef: string, description: string, amount?: number) {
    return this.svc.write({
      tenantId: this.tenantId, memoryType: 'anomaly', entityType: entityType as any,
      entityId, entityRef,
      title: `Fraud/anomaly detected: ${entityRef}`,
      summary: description,
      detail: { entityType, entityId, description, amount },
      actorName: 'AI Fraud Detection', actorType: 'agent',
      amount, module: 'compliance', tags: ['fraud', 'anomaly', 'alert'],
      importance: 5,
    });
  }

  async budgetBreached(budgetId: string, budgetName: string, department: string, overage: number, approver: string) {
    return this.svc.write({
      tenantId: this.tenantId, memoryType: 'alert', entityType: 'budget',
      entityId: budgetId, entityRef: `Budget: ${budgetName}`,
      title: `Budget breach: ${budgetName} — ${department}`,
      summary: `${department} has exceeded their budget "${budgetName}" by INR ${overage.toLocaleString('en-IN')}. Escalated to ${approver}.`,
      detail: { budgetId, budgetName, department, overage, approver },
      actorName: 'Budget Monitor', actorType: 'system',
      amount: overage, module: 'budgeting', tags: ['budget', 'breach', 'alert'],
      importance: 4,
    });
  }

  async aiRecommendation(module: string, title: string, recommendation: string, confidence: number) {
    return this.svc.write({
      tenantId: this.tenantId, memoryType: 'recommendation', entityType: 'policy',
      title, summary: recommendation,
      detail: { module, recommendation, confidence },
      actorName: 'Finance AI Copilot', actorType: 'agent',
      module: module as any, tags: ['ai', 'recommendation'],
      importance: 3,
    });
  }

  async paymentScheduled(paymentId: string, vendorName: string, amount: number, scheduledDate: string) {
    return this.svc.write({
      tenantId: this.tenantId, memoryType: 'transaction', entityType: 'payment',
      entityId: paymentId, entityRef: `Payment to ${vendorName}`,
      title: `Payment scheduled: ${vendorName} — INR ${amount.toLocaleString('en-IN')}`,
      summary: `Payment of INR ${amount.toLocaleString('en-IN')} to ${vendorName} scheduled for ${scheduledDate}.`,
      detail: { paymentId, vendorName, amount, scheduledDate },
      actorName: this.actorName ?? 'System', actorType: 'user',
      amount, module: 'accounting', tags: ['payment', 'vendor'],
      importance: 3,
    });
  }

  async complianceFiled(filingType: string, period: string, amount: number, filedBy: string) {
    return this.svc.write({
      tenantId: this.tenantId, memoryType: 'compliance_event', entityType: 'policy',
      entityRef: `${filingType} — ${period}`,
      title: `${filingType} filed for ${period}`,
      summary: `${filingType} return for period ${period} filed successfully by ${filedBy}. Tax amount: INR ${amount.toLocaleString('en-IN')}.`,
      detail: { filingType, period, amount, filedBy },
      actorName: filedBy, actorType: 'user',
      amount, module: 'tax', tags: ['tax', 'compliance', 'gst', 'filing'],
      importance: 4,
    });
  }
}
