import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import fs from 'fs';

const PROCESSED_FILE = process.env.PROCESSED_FILE || '/mnt/session/outputs/processed_files.json';
const ERROR_LOG = process.env.ERROR_LOG || '/mnt/session/outputs/error_log.txt';

export function createMonitorRouter(): Router {
  const router = Router();

  // GET /api/monitor/status
  router.get('/status', requireAuth, async (_req, res: Response) => {
    try {
      const configured = !!process.env.DRIVE_FOLDER_ID;
      let processed = {};
      let errorCount = 0;
      try { processed = JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8')); } catch {}
      try {
        const log = fs.readFileSync(ERROR_LOG, 'utf8');
        errorCount = (log.match(/\[ERROR\]/g) || []).length;
      } catch {}
      res.json({
        active: configured,
        folder_id: process.env.DRIVE_FOLDER_ID || null,
        recipients: (process.env.MONITOR_RECIPIENTS || '').split(','),
        sleep_seconds: parseInt(process.env.MONITOR_SLEEP_SECONDS || '60'),
        files_processed: Object.keys(processed).length,
        recent_files: Object.values(processed).slice(-5),
        error_count: errorCount,
        message: configured ? 'Monitor is active' : 'Set DRIVE_FOLDER_ID in Render to activate',
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // GET /api/monitor/processed
  router.get('/processed', requireAuth, async (_req, res: Response) => {
    try {
      const data = fs.existsSync(PROCESSED_FILE) ? JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8')) : {};
      res.json({ files: Object.values(data), total: Object.keys(data).length });
    } catch { res.json({ files: [], total: 0 }); }
  });

  // GET /api/monitor/errors
  router.get('/errors', requireAuth, async (_req, res: Response) => {
    try {
      const log = fs.existsSync(ERROR_LOG) ? fs.readFileSync(ERROR_LOG, 'utf8') : '';
      const lines = log.split('\n').filter(Boolean).slice(-50); // Last 50 errors
      res.json({ errors: lines, total: lines.length });
    } catch { res.json({ errors: [], total: 0 }); }
  });

  // DELETE /api/monitor/processed/:id — remove from tracking (re-process)
  router.delete('/processed/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const data = fs.existsSync(PROCESSED_FILE) ? JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8')) : {};
      delete data[req.params.id];
      fs.writeFileSync(PROCESSED_FILE, JSON.stringify(data, null, 2));
      res.json({ removed: true, id: req.params.id });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
