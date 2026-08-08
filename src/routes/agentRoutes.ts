// ============================================================
// Deemona AI Finance OS — Accounting Agent Routes
// File: src/routes/agentRoutes.ts
// Mount: app.use('/api/agents', agentRouter(pool))
// ============================================================

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { runAccountingAgent, detectAnomalies, suggestJournalEntry } from '../services/accountingAgent';

export function createAgentRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── POST /api/agents/accounting/ask ───────────────────────
  // Ask the Accounting Agent a question
  router.post('/accounting/ask', requireAuth, async (req: Request, res: Response) => {
    try {
      const { question, conversationHistory } = req.body;
      if (!question) { res.status(400).json({ error: 'question is required' }); return; }

      const result = await runAccountingAgent(
        pool, tid(req), question, conversationHistory ?? []
      );
      res.json(result);
    } catch (err) {
      console.error('[Agent] accounting ask error:', err);
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/agents/accounting/anomalies ──────────────────
  // Run anomaly detection
  router.get('/accounting/anomalies', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await detectAnomalies(pool, tid(req));
      res.json(result);
    } catch (err) {
      console.error('[Agent] anomaly detection error:', err);
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/agents/accounting/suggest-entry ─────────────
  // Suggest journal entry for a transaction description
  router.post('/accounting/suggest-entry', requireAuth, async (req: Request, res: Response) => {
    try {
      const { description } = req.body;
      if (!description) { res.status(400).json({ error: 'description is required' }); return; }

      const result = await suggestJournalEntry(pool, tid(req), description);
      res.json(result);
    } catch (err) {
      console.error('[Agent] suggest entry error:', err);
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
