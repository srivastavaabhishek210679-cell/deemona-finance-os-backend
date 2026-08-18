// ============================================================
// Monitor Settings Routes — Multi-tenant Drive Monitor API
// File: src/routes/monitorSettingsRoutes.ts
// ============================================================

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createMonitorSettingsRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/monitor/settings ─────────────────────────────
  router.get('/settings', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'SELECT * FROM monitor_settings WHERE tenant_id=$1',
        [tid(req)]
      );
      if (result.rows.length === 0) {
        return res.json({
          settings: {
            enabled: false,
            folder_id: null,
            folder_name: null,
            google_api_key: null,
            recipients: [],
            check_interval_seconds: 60,
            file_types: ['monthly', 'weekly', 'daily'],
            last_checked_at: null,
            last_file_processed: null,
            total_files_processed: 0,
          }
        }) as any;
      }
      const s = result.rows[0];
      // Mask API key
      if (s.google_api_key) s.google_api_key = s.google_api_key.substring(0, 8) + '••••••••••••';
      res.json({ settings: s });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── POST /api/monitor/settings ────────────────────────────
  router.post('/settings', requireAuth, async (req: Request, res: Response) => {
    try {
      const { folder_id, folder_name, google_api_key, recipients, check_interval_seconds, file_types, enabled } = req.body;

      // Validate folder access if provided
      if (folder_id && google_api_key && !google_api_key.includes('•')) {
        try {
          const testUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folder_id}' in parents`)}&fields=files(id,name)&pageSize=1&key=${google_api_key}`;
          const testRes = await fetch(testUrl);
          if (!testRes.ok) {
            const errData = await testRes.json() as any;
            return res.status(400).json({
              error: 'Google Drive access failed: ' + (errData?.error?.message || testRes.status)
            }) as any;
          }
          const testData = await testRes.json() as any;
          console.log(`[Monitor] Folder validation OK for tenant ${tid(req)}: ${testData.files?.length || 0} files visible`);
        } catch (e) {
          return res.status(400).json({ error: 'Failed to validate Google Drive access: ' + String(e) }) as any;
        }
      }

      // Upsert settings
      const existingApiKey = google_api_key?.includes('•')
        ? (await pool.query('SELECT google_api_key FROM monitor_settings WHERE tenant_id=$1', [tid(req)])).rows[0]?.google_api_key
        : google_api_key;

      await pool.query(
        `INSERT INTO monitor_settings (tenant_id, folder_id, folder_name, google_api_key, recipients, check_interval_seconds, file_types, enabled, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET
           folder_id=EXCLUDED.folder_id,
           folder_name=EXCLUDED.folder_name,
           google_api_key=COALESCE(NULLIF($4,''), monitor_settings.google_api_key),
           recipients=EXCLUDED.recipients,
           check_interval_seconds=EXCLUDED.check_interval_seconds,
           file_types=EXCLUDED.file_types,
           enabled=EXCLUDED.enabled,
           updated_at=NOW()`,
        [tid(req), folder_id, folder_name || folder_id, existingApiKey, recipients || [], check_interval_seconds || 60, file_types || ['monthly','weekly','daily'], enabled || false]
      );

      res.json({ success: true, message: 'Monitor settings saved successfully' });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── PATCH /api/monitor/settings/toggle ────────────────────
  router.patch('/settings/toggle', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `UPDATE monitor_settings SET enabled=NOT enabled, updated_at=NOW() WHERE tenant_id=$1 RETURNING enabled`,
        [tid(req)]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Settings not found. Save settings first.' }) as any;
      res.json({ enabled: result.rows[0].enabled });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── GET /api/monitor/processed ────────────────────────────
  router.get('/processed', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT drive_file_id as id, file_name as name, file_type as type, processed_at, report_sent_to
         FROM monitor_processed_files WHERE tenant_id=$1 ORDER BY processed_at DESC LIMIT 50`,
        [tid(req)]
      );
      res.json({ files: result.rows, total: result.rows.length });
    } catch { res.json({ files: [], total: 0 }); }
  });

  // ── DELETE /api/monitor/processed/:id ─────────────────────
  router.delete('/processed/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      await pool.query(
        'DELETE FROM monitor_processed_files WHERE tenant_id=$1 AND drive_file_id=$2',
        [tid(req), req.params.id]
      );
      res.json({ removed: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── GET /api/monitor/logs ─────────────────────────────────
  router.get('/logs', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT level, message, file_name, created_at FROM monitor_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,
        [tid(req)]
      );
      res.json({ logs: result.rows, total: result.rows.length });
    } catch { res.json({ logs: [], total: 0 }); }
  });

  // ── GET /api/monitor/status ───────────────────────────────
  router.get('/status', requireAuth, async (req: Request, res: Response) => {
    try {
      const settings = await pool.query('SELECT * FROM monitor_settings WHERE tenant_id=$1', [tid(req)]);
      const s = settings.rows[0];
      res.json({
        active: s?.enabled || false,
        configured: !!(s?.folder_id && s?.google_api_key),
        folder_id: s?.folder_id || null,
        folder_name: s?.folder_name || null,
        recipients: s?.recipients || [],
        sleep_seconds: s?.check_interval_seconds || 60,
        file_types: s?.file_types || [],
        files_processed: s?.total_files_processed || 0,
        last_checked: s?.last_checked_at || null,
        last_file: s?.last_file_processed || null,
      });
    } catch { res.json({ active: false, configured: false, files_processed: 0 }); }
  });

  // ── POST /api/monitor/test ────────────────────────────────
  router.post('/test', requireAuth, async (req: Request, res: Response) => {
    try {
      const settings = await pool.query('SELECT * FROM monitor_settings WHERE tenant_id=$1', [tid(req)]);
      const s = settings.rows[0];
      if (!s?.folder_id || !s?.google_api_key) {
        return res.status(400).json({ error: 'Configure folder ID and API key first' }) as any;
      }
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${s.folder_id}' in parents and trashed=false`)}&fields=files(id,name,mimeType)&pageSize=10&key=${s.google_api_key}`;
      const driveRes = await fetch(url);
      const data = await driveRes.json() as any;
      if (!driveRes.ok) return res.status(400).json({ error: data?.error?.message || 'Drive API error' }) as any;
      res.json({
        success: true,
        folder_accessible: true,
        files_found: data.files?.length || 0,
        files: data.files?.slice(0, 5) || [],
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
