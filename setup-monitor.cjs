// Run this script to wire the monitor into the backend
const fs = require('fs');
const path = require('path');

const BACKEND = 'C:/deemona-finance-os/backend/src';

// ── 1. Wire monitor into index.ts ─────────────────────────────
const indexFile = path.join(BACKEND.replace(/\//g,'\\'), 'index.ts');
let idx = fs.readFileSync(indexFile, 'utf8');

if (!idx.includes('startMonitoringLoop')) {
  // Add import
  idx = idx.replace(
    "import { createNotificationRouter }",
    "import { startMonitoringLoop } from './services/driveMonitor';\nimport { createNotificationRouter }"
  );

  // Start monitor after server starts
  idx = idx.replace(
    "console.log(`[Server] Health: http://localhost:${PORT}/health`);",
    `console.log(\`[Server] Health: http://localhost:\${PORT}/health\`);

  // Start autonomous Drive monitor if configured
  if (process.env.DRIVE_FOLDER_ID) {
    console.log('[Monitor] Starting autonomous Google Drive monitor...');
    startMonitoringLoop().catch(err => {
      console.error('[Monitor] Fatal error:', err);
      // Restart after 30s — never permanently stop
      setTimeout(() => startMonitoringLoop(), 30000);
    });
  } else {
    console.log('[Monitor] DRIVE_FOLDER_ID not set — monitor not started. Add to Render env vars to activate.');
  }`
  );

  fs.writeFileSync(indexFile, idx, 'utf8');
  console.log('✓ Monitor wired into index.ts');
} else {
  console.log('- Monitor already wired');
}

// ── 2. Create monitor API route for status/control ────────────
const monitorRoute = `import { Router, Request, Response } from 'express';
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
        errorCount = (log.match(/\\[ERROR\\]/g) || []).length;
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
      const lines = log.split('\\n').filter(Boolean).slice(-50); // Last 50 errors
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
`;

const monitorRouteFile = path.join(BACKEND.replace(/\//g,'\\'), 'routes', 'monitorRoutes.ts');
fs.writeFileSync(monitorRouteFile, monitorRoute, 'utf8');
console.log('✓ Monitor routes created');

// ── 3. Wire monitor routes ────────────────────────────────────
if (!idx.includes('createMonitorRouter')) {
  idx = fs.readFileSync(indexFile, 'utf8');
  idx = idx.replace(
    "import { startMonitoringLoop }",
    "import { createMonitorRouter } from './routes/monitorRoutes';\nimport { startMonitoringLoop }"
  );
  idx = idx.replace(
    "app.use('/api/notifications',",
    "app.use('/api/monitor', createMonitorRouter());\napp.use('/api/notifications',"
  );
  fs.writeFileSync(indexFile, idx, 'utf8');
  console.log('✓ Monitor routes wired into index.ts');
}

console.log('\n✅ Monitor setup complete!');
console.log('\nNext steps:');
console.log('1. Copy driveMonitor.ts to C:/deemona-finance-os/backend/src/services/driveMonitor.ts');
console.log('2. Run this setup script: node setup-monitor.cjs');
console.log('3. Add these env vars to Render backend:');
console.log('   DRIVE_FOLDER_ID=<your-google-drive-folder-id>');
console.log('   MONITOR_RECIPIENTS=srivastava.abhishek210679@gmail.com');
console.log('   MONITOR_SLEEP_SECONDS=60');
console.log('   GOOGLE_DRIVE_API_KEY=<your-google-api-key> (for public folders)');
console.log('   OR GOOGLE_OAUTH_TOKEN=<token> (for private folders)');
console.log('4. Push backend to GitHub — monitor starts automatically');
