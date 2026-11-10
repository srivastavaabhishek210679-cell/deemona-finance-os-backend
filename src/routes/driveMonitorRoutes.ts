// ============================================================
// Deemona AI Finance OS — Google Drive File Monitor
// File: src/routes/driveMonitorRoutes.ts
// - Monitors a Google Drive folder for new files
// - Supports: Excel, CSV, PDF, XML, JSON
// - Auto-imports into Finance OS database
// - Claude AI analysis + email report via Resend
// - Tracks processed files to avoid duplicates
// - Runs via node-cron every 5 minutes
// ============================================================

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';
import { Resend } from '../services/mailer';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Types ─────────────────────────────────────────────────────
interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size: string;
}

interface MonitorConfig {
  tenantId: string;
  folderId: string;
  recipients: string[];
  enabled: boolean;
  lastChecked?: string;
}

// ── Google Drive API Helpers ──────────────────────────────────
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const SUPPORTED_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'text/csv',
  'application/pdf',
  'text/xml',
  'application/xml',
  'application/json',
  'text/plain',
  'application/vnd.google-apps.spreadsheet', // Google Sheets
];

async function listNewFiles(folderId: string, apiKey: string, since?: string): Promise<DriveFile[]> {
  try {
    const mimeQuery = SUPPORTED_MIME_TYPES.map(m => `mimeType='${m}'`).join(' or ');
    const sinceQuery = since ? ` and modifiedTime > '${since}'` : '';
    const query = encodeURIComponent(`'${folderId}' in parents and trashed=false and (${mimeQuery})${sinceQuery}`);
    const url = `${DRIVE_API}/files?q=${query}&fields=files(id,name,mimeType,modifiedTime,size)&orderBy=modifiedTime desc&key=${apiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Drive API error ${resp.status}: ${err}`);
    }
    const data = await resp.json() as any;
    return (data.files || []) as DriveFile[];
  } catch (e) {
    console.error('[DriveMonitor] List files error:', e);
    return [];
  }
}

async function downloadFile(fileId: string, mimeType: string, apiKey: string): Promise<Buffer | null> {
  try {
    let url: string;
    // Google Sheets need export
    if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/csv&key=${apiKey}`;
    } else {
      url = `${DRIVE_API}/files/${fileId}?alt=media&key=${apiKey}`;
    }
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    return buffer;
  } catch (e) {
    console.error('[DriveMonitor] Download error:', e);
    return null;
  }
}

function getFormat(mimeType: string, fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'csv';
  if (mimeType.includes('spreadsheet') || ext === 'xlsx' || ext === 'xls') return 'excel';
  if (mimeType === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mimeType === 'text/csv' || ext === 'csv') return 'csv';
  if (mimeType.includes('xml') || ext === 'xml') return 'xml';
  if (mimeType === 'application/json' || ext === 'json') return 'json';
  return 'csv';
}

// ── Claude Analysis ───────────────────────────────────────────
async function analyzeWithClaude(fileName: string, format: string, dataBuffer: Buffer, importResult: any): Promise<string> {
  try {
    const dataPreview = format === 'excel' || format === 'pdf'
      ? `[Binary file: ${dataBuffer.length} bytes]`
      : dataBuffer.toString('utf8').substring(0, 3000);

    const prompt = `You are a senior financial analyst at Deemona Technologies. Analyze this financial file and provide an executive FOS&A (Financial Overview, Summary & Analysis) report.

File: ${fileName}
Format: ${format.toUpperCase()}
Import Result: ${JSON.stringify(importResult)}
Data Preview:
${dataPreview}

Provide a comprehensive FOS&A report covering:
1. **Executive Summary** — What this file contains and key findings
2. **Financial Overview** — Key metrics, totals, trends observed
3. **Data Quality Assessment** — Completeness, anomalies, data issues
4. **Key Insights** — Top 3-5 actionable insights from the data
5. **Risk Flags** — Any concerning patterns (overdue, high values, anomalies)
6. **Recommendations** — Specific actions to take based on this data

Keep it concise, professional, and actionable. Use Indian financial context (₹, lakhs, crores).`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    return (response.content[0] as any).text || 'Analysis unavailable';
  } catch (e) {
    console.error('[DriveMonitor] Claude analysis error:', e);
    return 'Claude analysis failed: ' + String(e);
  }
}

// ── Email Report Generator ─────────────────────────────────────
function generateMonitorEmail(fileName: string, importResult: any, analysis: string, fileUrl?: string): string {
  const fmt = (n: any) => '₹' + parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const now = new Date().toLocaleString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // Convert markdown-style analysis to HTML
  const analysisHtml = analysis
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^(\d+\.\s+)/gm, '<br><strong>$1</strong>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html>
<head><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#f0f4ff}
  .wrapper{max-width:720px;margin:0 auto;background:#fff}
  .header{background:linear-gradient(135deg,#1e3a8a,#1d4ed8);color:#fff;padding:28px 32px}
  .header-logo{font-size:11px;font-weight:700;letter-spacing:0.1em;opacity:0.7;margin-bottom:6px}
  .header-title{font-size:22px;font-weight:800;margin-bottom:4px}
  .header-sub{font-size:12px;opacity:0.8}
  .body{padding:24px 32px}
  .kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
  .kpi{padding:14px 16px;border-radius:8px;border-left:4px solid}
  .kpi-label{font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px}
  .kpi-value{font-size:20px;font-weight:800}
  .bg-blue{background:#eff6ff;border-color:#1d4ed8}.blue{color:#1d4ed8}
  .bg-green{background:#f0fdf4;border-color:#16a34a}.green{color:#16a34a}
  .bg-red{background:#fef2f2;border-color:#dc2626}.red{color:#dc2626}
  .bg-amber{background:#fffbeb;border-color:#d97706}.amber{color:#d97706}
  h2{font-size:14px;font-weight:700;color:#1e3a8a;margin:20px 0 10px;padding-bottom:6px;border-bottom:2px solid #e2e8f0}
  .analysis{background:#f8faff;border-radius:8px;padding:16px;font-size:12px;line-height:1.7;color:#334155;border-left:4px solid #1d4ed8}
  .file-badge{display:inline-block;padding:4px 12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;font-size:11px;color:#1d4ed8;font-family:monospace;margin:8px 0}
  .tag{padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;display:inline-block}
  table{width:100%;border-collapse:collapse;margin:8px 0;font-size:12px}
  th{background:#1d4ed8;color:#fff;padding:8px 12px;text-align:left;font-size:11px}
  td{padding:8px 12px;border-bottom:1px solid #f1f5f9}
  .footer{background:#f8faff;padding:16px 32px;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0}
  .alert{padding:10px 14px;border-radius:6px;margin:10px 0;font-size:12px}
  .alert-green{background:#f0fdf4;border-left:4px solid #16a34a;color:#14532d}
  .alert-red{background:#fef2f2;border-left:4px solid #dc2626;color:#7f1d1d}
</style></head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="header-logo">DEEMONA AI FINANCE OS · GOOGLE DRIVE MONITOR</div>
    <div class="header-title">📁 New File Detected & Processed</div>
    <div class="header-sub">${fileName}</div>
    <div style="font-size:11px;opacity:0.6;margin-top:8px">${now}</div>
  </div>
  <div class="body">
    <div class="file-badge">📄 ${fileName}</div>

    <div class="kpi-grid">
      <div class="kpi bg-${importResult.errors === 0 ? 'green' : 'red'}">
        <div class="kpi-label">Records Imported</div>
        <div class="kpi-value ${importResult.errors === 0 ? 'green' : 'red'}">${importResult.inserted || 0}</div>
      </div>
      <div class="kpi bg-blue">
        <div class="kpi-label">Data Type</div>
        <div class="kpi-value blue" style="font-size:13px">${(importResult.dataType || 'UNKNOWN').replace(/_/g, ' ')}</div>
      </div>
      <div class="kpi bg-${importResult.errors === 0 ? 'green' : 'amber'}">
        <div class="kpi-label">Status</div>
        <div class="kpi-value ${importResult.errors === 0 ? 'green' : 'amber'}" style="font-size:13px">${importResult.errors === 0 ? '✓ Clean' : `${importResult.errors} Errors`}</div>
      </div>
    </div>

    ${importResult.errors === 0
      ? '<div class="alert alert-green">✅ File successfully imported into Deemona Finance OS. All dashboards updated automatically.</div>'
      : `<div class="alert alert-red">⚠️ Import completed with ${importResult.errors} errors. Some records may not have been saved.</div>`}

    <h2>🤖 AI Financial Analysis (Claude)</h2>
    <div class="analysis"><p>${analysisHtml}</p></div>

    <h2>📊 Import Details</h2>
    <table>
      <tr><th>Metric</th><th>Value</th></tr>
      <tr><td>File Name</td><td style="font-family:monospace">${fileName}</td></tr>
      <tr><td>Records Inserted</td><td>${importResult.inserted || 0}</td></tr>
      <tr><td>Records Updated</td><td>${importResult.updated || 0}</td></tr>
      <tr><td>Errors</td><td class="${importResult.errors > 0 ? 'red' : 'green'}">${importResult.errors || 0}</td></tr>
      <tr><td>Data Type Detected</td><td>${importResult.dataType || 'Auto-detected'}</td></tr>
      <tr><td>Processed At</td><td>${now}</td></tr>
      ${fileUrl ? `<tr><td>Source File</td><td><a href="${fileUrl}" style="color:#1d4ed8">View in Google Drive</a></td></tr>` : ''}
    </table>
  </div>
  <div class="footer">
    <strong>Deemona AI Finance OS</strong> · Autonomous Google Drive Monitor<br>
    This report was automatically generated when a new file was detected in your monitored Drive folder.<br>
    © ${new Date().getFullYear()} Deemona Technologies · Do not reply to this email
  </div>
</div>
</body></html>`;
}

// ── Process a single file ─────────────────────────────────────
async function processFile(pool: Pool, tenantId: string, file: DriveFile, apiKey: string, recipients: string[]): Promise<void> {
  console.log(`[DriveMonitor] Processing: ${file.name}`);

  try {
    // 1. Download file
    const buffer = await downloadFile(file.id, file.mimeType, apiKey);
    if (!buffer) throw new Error('Failed to download file');

    const format = getFormat(file.mimeType, file.name);
    const isBinary = format === 'excel' || format === 'pdf';
    const data = isBinary ? buffer.toString('base64') : buffer.toString('utf8');

    // 2. Import into Finance OS via internal logic
    // Call the ingest API internally
    const ingestResp = await fetch(`http://localhost:${process.env.PORT || 4001}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-tenant': tenantId,
        ...(process.env.CRON_SECRET ? { Authorization: 'Bearer internal-' + process.env.CRON_SECRET + '.' + tenantId } : {}),
      },
      body: JSON.stringify({ data, format, tenantId }),
    });

    let importResult = { inserted: 0, updated: 0, errors: 0, dataType: 'UNKNOWN' };
    try {
      const ingestData = await ingestResp.json() as any;
      importResult = {
        inserted: ingestData.inserted || 0,
        updated: ingestData.updated || 0,
        errors: ingestData.errors || 0,
        dataType: ingestData.dataType || 'UNKNOWN',
      };
    } catch (e) {
      importResult.errors = 1;
    }

    // 3. Claude AI analysis
    const analysis = await analyzeWithClaude(file.name, format, buffer, importResult);

    // 4. Generate and send email report
    const html = generateMonitorEmail(
      file.name, importResult, analysis,
      `https://drive.google.com/file/d/${file.id}/view`
    );

    for (const recipient of recipients) {
      const { error } = await resend.emails.send({
        from: 'Deemona Drive Monitor <onboarding@resend.dev>',
        to: recipient,
        subject: `📁 Drive Monitor: ${file.name} — ${importResult.inserted} records imported — Deemona Finance OS`,
        html,
      });
      if (error) console.error('[DriveMonitor] Email error:', error);
      else console.log(`[DriveMonitor] Report sent to ${recipient}`);
    }

    // 5. Mark as processed
    await pool.query(
      `INSERT INTO processed_drive_files (tenant_id, file_id, file_name, processed_at, records_inserted, status)
       VALUES ($1, $2, $3, NOW(), $4, 'success')
       ON CONFLICT (tenant_id, file_id) DO UPDATE SET processed_at=NOW(), records_inserted=$4, status='success'`,
      [tenantId, file.id, file.name, importResult.inserted]
    ).catch(() => {});

    // 6. Log
    await pool.query(
      `INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at)
       VALUES ($1, 'DRIVE_MONITOR', 'success', $2, NOW())`,
      [tenantId, `Processed ${file.name}: ${importResult.inserted} records, report sent to ${recipients.join(', ')}`]
    ).catch(() => {});

  } catch (e) {
    console.error(`[DriveMonitor] Error processing ${file.name}:`, e);
    await pool.query(
      `INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at)
       VALUES ($1, 'DRIVE_MONITOR', 'error', $2, NOW())`,
      [tenantId, `Failed to process ${file.name}: ${String(e)}`]
    ).catch(() => {});
  }
}

// ── Main monitor function (called by cron) ────────────────────
let lastDriveRun = 0;
export async function runDriveMonitor(pool: Pool, force = false): Promise<{ checked: number; processed: number }> {
  const gapMs = Math.max(1, Number(process.env.DRIVE_MONITOR_MINUTES) || 10) * 60000;
  if (!force && Date.now() - lastDriveRun < gapMs) return { checked: 0, processed: 0 };
  lastDriveRun = Date.now();
  let checked = 0, processed = 0;

  try {
    // Get all monitor configs from DB
    const configs = await pool.query(
      `SELECT tenant_id, setting_key, setting_value FROM monitor_settings WHERE setting_key = 'drive_monitor_config'`
    ).catch(() => ({ rows: [] }));

    for (const row of configs.rows) {
      try {
        const config: MonitorConfig = JSON.parse(row.setting_value || '{}');
        if (!config.enabled || !config.folderId || !config.recipients?.length) continue;

        const apiKey = process.env.GOOGLE_DRIVE_API_KEY || process.env.GOOGLE_SHEETS_API_KEY;
        if (!apiKey) { console.error('[DriveMonitor] No Google API key found'); continue; }

        checked++;

        // Get already processed file IDs
        const processed_files = await pool.query(
          `SELECT file_id FROM processed_drive_files WHERE tenant_id=$1`,
          [row.tenant_id]
        ).catch(() => ({ rows: [] }));
        const processedIds = new Set(processed_files.rows.map((r: any) => r.file_id));

        // List new files
        const files = await listNewFiles(config.folderId, apiKey, config.lastChecked);
        const newFiles = files.filter(f => !processedIds.has(f.id));

        if (newFiles.length > 0) console.log(`[DriveMonitor] Tenant ${row.tenant_id}: ${files.length} files found, ${newFiles.length} new`);

        for (const file of newFiles) {
          await processFile(pool, row.tenant_id, file, apiKey, config.recipients);
          processed++;
        }

        // Update last checked time
        const updatedConfig = { ...config, lastChecked: new Date().toISOString() };
        await pool.query(
          `UPDATE monitor_settings SET setting_value=$1, updated_at=NOW() WHERE tenant_id=$2 AND setting_key='drive_monitor_config'`,
          [JSON.stringify(updatedConfig), row.tenant_id]
        ).catch(() => {});

      } catch (e) {
        console.error('[DriveMonitor] Config error:', e);
      }
    }
  } catch (e) {
    console.error('[DriveMonitor] Fatal error:', e);
  }

  return { checked, processed };
}

// ── Router ────────────────────────────────────────────────────
export function createDriveMonitorRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user?.tenantId;

  // ── Get/Set monitor config ────────────────────────────────
  router.get('/config', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT setting_value FROM monitor_settings WHERE tenant_id=$1 AND setting_key='drive_monitor_config'`,
        [tid(req)]
      );
      const config = result.rows[0] ? JSON.parse(result.rows[0].setting_value) : {
        folderId: process.env.DRIVE_FOLDER_ID || '',
        recipients: [],
        enabled: false,
      };
      res.json({ config });
    } catch (e) {
      res.json({ config: { folderId: '', recipients: [], enabled: false } });
    }
  });

  router.post('/config', requireAuth, async (req: Request, res: Response) => {
    try {
      const { folderId, recipients, enabled } = req.body;
      const config = { folderId, recipients, enabled, lastChecked: null };
      await pool.query(
        `INSERT INTO monitor_settings (tenant_id, setting_key, setting_value, updated_at)
         VALUES ($1, 'drive_monitor_config', $2, NOW())
         ON CONFLICT (tenant_id, setting_key) DO UPDATE SET setting_value=$2, updated_at=NOW()`,
        [tid(req), JSON.stringify(config)]
      );
      res.json({ success: true, config });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Run monitor manually ──────────────────────────────────
  router.post('/run', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await runDriveMonitor(pool, true);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── List processed files ──────────────────────────────────
  router.get('/processed', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT file_id, file_name, processed_at, records_inserted, status
         FROM processed_drive_files WHERE tenant_id=$1 ORDER BY processed_at DESC LIMIT 50`,
        [tid(req)]
      );
      res.json({ files: result.rows });
    } catch (e) {
      res.json({ files: [] });
    }
  });

  // ── Get monitor logs ──────────────────────────────────────
  router.get('/logs', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT automation_type, status, detail, created_at FROM automation_logs
         WHERE tenant_id=$1 AND automation_type='DRIVE_MONITOR' ORDER BY created_at DESC LIMIT 50`,
        [tid(req)]
      );
      res.json({ logs: result.rows });
    } catch (e) {
      res.json({ logs: [] });
    }
  });

  // ── Test connection ───────────────────────────────────────
  router.post('/test', requireAuth, async (req: Request, res: Response) => {
    try {
      const { folderId } = req.body;
      const apiKey = process.env.GOOGLE_DRIVE_API_KEY || process.env.GOOGLE_SHEETS_API_KEY;
      if (!apiKey) return res.status(400).json({ error: 'GOOGLE_DRIVE_API_KEY not set in environment' }) as any;
      const files = await listNewFiles(folderId || process.env.DRIVE_FOLDER_ID || '', apiKey);
      res.json({ success: true, filesFound: files.length, files: files.slice(0, 5).map(f => ({ name: f.name, type: f.mimeType, modified: f.modifiedTime })) });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
