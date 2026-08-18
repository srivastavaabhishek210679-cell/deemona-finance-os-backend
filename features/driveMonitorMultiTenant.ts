// ============================================================
// Deemona AI Finance OS — Multi-Tenant Drive Monitor
// File: src/services/driveMonitorMultiTenant.ts
// Each tenant has their own folder, recipients, API key
// ============================================================

import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FINANCIAL_EXTS = ['.xlsx', '.xls', '.csv', '.pdf', '.xlsm'];
const MONTH_PATTERNS = ['monthly','month','mtd'];
const WEEK_PATTERNS  = ['weekly','week','wk'];
const DAILY_PATTERNS = ['daily','day','dtd'];
const MONTH_NAMES    = ['january','february','march','april','may','june','july','august','september','october','november','december','jan','feb','mar','apr','jun','jul','aug','sep','oct','nov','dec'];
const DAY_NAMES      = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday','mon','tue','wed','thu','fri','sat','sun'];

type FileType = 'monthly' | 'weekly' | 'daily' | null;

interface TenantSettings {
  id: string;
  tenant_id: string;
  folder_id: string;
  folder_name: string;
  google_api_key: string;
  recipients: string[];
  check_interval_seconds: number;
  file_types: string[];
}

function detectFileType(filename: string): FileType {
  const lower = filename.toLowerCase();
  if (!FINANCIAL_EXTS.some(ext => lower.endsWith(ext))) return null;
  if (MONTH_PATTERNS.some(p => lower.includes(p)) || MONTH_NAMES.some(m => lower.includes(m))) return 'monthly';
  if (WEEK_PATTERNS.some(p => lower.includes(p))) return 'weekly';
  if (DAILY_PATTERNS.some(p => lower.includes(p)) || DAY_NAMES.some(d => lower.includes(d))) return 'daily';
  return null;
}

async function logToDb(pool: Pool, tenantId: string, level: string, message: string, fileName?: string) {
  try {
    await pool.query(
      `INSERT INTO monitor_logs (tenant_id, level, message, file_name) VALUES ($1,$2,$3,$4)`,
      [tenantId, level, message, fileName || null]
    );
  } catch {}
  console.log(`[Monitor][${tenantId.substring(0,8)}] ${level.toUpperCase()}: ${message}`);
}

async function listDriveFiles(folderId: string, apiKey: string): Promise<any[]> {
  const query = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,size)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&pageSize=100&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Drive API ${res.status}: ${err.substring(0, 200)}`);
  }
  const data = await res.json() as any;
  return data.files || [];
}

async function downloadFile(fileId: string, apiKey: string): Promise<Buffer> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function analyzeFile(filename: string, buffer: Buffer, fileType: FileType, priorReports: string[]): Promise<string> {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  let preview = '';
  if (['csv','txt'].includes(ext)) {
    preview = buffer.toString('utf8').substring(0, 6000);
  } else {
    preview = `[${ext.toUpperCase()} file: ${filename}, ${buffer.length} bytes]`;
  }
  const priorCtx = priorReports.length > 0
    ? `\nPRIOR REPORTS:\n${priorReports.slice(-2).join('\n---\n').substring(0, 2000)}`
    : '\nNo prior reports for comparison.';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are the Deemona AI Finance OS executive analyst. Analyze this ${fileType} financial report and generate a structured executive FOS&A report.

FILE: ${filename} (${fileType} report, ${buffer.length} bytes)
CONTENT: ${preview}
${priorCtx}

Generate a professional executive report with:
1. EXECUTIVE SUMMARY — Key highlights, period, critical alerts
2. FINANCIAL PERFORMANCE — Revenue, expenses, profit/loss, cash
3. PERIOD COMPARISON — vs prior ${fileType} (if available), variances
4. KEY METRICS — Top 5 KPIs with values
5. RISKS & ALERTS — Anomalies, compliance flags, cash concerns
6. AI RECOMMENDATIONS — Top 3 action items with priority
7. AGENT INSIGHTS — Arya (HR), Raj (Sales), Priya (Procurement)

Rules: Never fabricate numbers. If data missing, say so. Professional C-suite tone.`
    }]
  });
  return (response.content[0] as any).text || 'Analysis unavailable.';
}

async function sendEmail(recipients: string[], filename: string, fileType: FileType, report: string, tenantName: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const from = process.env.FROM_EMAIL || 'onboarding@resend.dev';
  const subject = `Deemona FOS&A: ${fileType?.toUpperCase()} Report | ${filename}`;
  const html = `<!DOCTYPE html><html><head><style>
    body{font-family:Arial,sans-serif;background:#EEF3FD;padding:20px}
    .card{background:#fff;border-radius:12px;padding:32px;max-width:700px;margin:0 auto}
    .hdr{background:linear-gradient(135deg,#1B4FD8,#3B82F6);padding:24px;border-radius:10px;color:#fff;margin-bottom:20px}
    .hdr h1{margin:0;font-size:18px}.hdr p{margin:6px 0 0;opacity:.8;font-size:12px}
    .meta{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
    .tag{padding:5px 12px;border-radius:6px;background:#EEF3FD;border:1px solid #C7D9F8;font-size:11px;color:#1B4FD8;font-weight:700}
    .report{white-space:pre-wrap;font-size:13px;line-height:1.7;color:#334155;background:#F8FAFC;padding:20px;border-radius:8px;border:1px solid #E2E8F0}
    .footer{text-align:center;color:#94A3B8;font-size:11px;margin-top:20px}
  </style></head><body><div class="card">
    <div class="hdr"><h1>Deemona AI Finance OS — Executive Report</h1><p>FOS&A Autonomous Monitor · ${tenantName} · ${new Date().toLocaleString('en-IN')}</p></div>
    <div class="meta"><span class="tag">File: ${filename}</span><span class="tag">Type: ${fileType?.toUpperCase()}</span><span class="tag">${new Date().toLocaleDateString('en-IN')}</span></div>
    <div class="report">${report.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
    <div class="footer">Deemona Technologies | AI Finance OS | Autonomous FOS&amp;A Report<br/>This report was generated automatically by the Drive Monitor system.</div>
  </div></body></html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Deemona Finance OS <${from}>`, to: recipients, subject, html, text: report }),
    });
    const data = await res.json() as any;
    return !!data.id;
  } catch { return false; }
}

async function processTenantFile(pool: Pool, settings: TenantSettings, file: any, fileType: FileType, priorReports: string[]): Promise<void> {
  const tid = settings.tenant_id;
  await logToDb(pool, tid, 'info', `Processing ${fileType} file: ${file.name}`, file.name);

  try {
    // Download
    const buffer = await downloadFile(file.id, settings.google_api_key);
    await logToDb(pool, tid, 'info', `Downloaded ${buffer.length} bytes`, file.name);

    // Analyze
    const report = await analyzeFile(file.name, buffer, fileType, priorReports);
    await logToDb(pool, tid, 'info', `Analysis complete`, file.name);

    // Get tenant name
    const tenantRow = await pool.query('SELECT name FROM tenants WHERE id=$1', [tid]).catch(() => ({ rows: [] }));
    const tenantName = tenantRow.rows[0]?.name || 'Deemona';

    // Send email
    const sent = await sendEmail(settings.recipients, file.name, fileType, report, tenantName);
    await logToDb(pool, tid, sent ? 'info' : 'error', sent ? `Email sent to ${settings.recipients.join(', ')}` : 'Email send failed', file.name);

    // Mark as processed in DB
    await pool.query(
      `INSERT INTO monitor_processed_files (tenant_id, drive_file_id, file_name, file_type, report_sent_to, report_summary)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, drive_file_id) DO NOTHING`,
      [tid, file.id, file.name, fileType, settings.recipients, report.substring(0, 500)]
    );

    // Update settings stats
    await pool.query(
      `UPDATE monitor_settings SET last_file_processed=$1, last_checked_at=NOW(), total_files_processed=total_files_processed+1, updated_at=NOW() WHERE tenant_id=$2`,
      [file.name, tid]
    );

    await logToDb(pool, tid, 'info', `Successfully processed: ${file.name}`, file.name);
  } catch (e) {
    await logToDb(pool, tid, 'error', `Failed to process ${file.name}: ${String(e)}`, file.name);
  }
}

async function monitorTenant(pool: Pool, settings: TenantSettings, priorReportsCache: Record<string, string[]>): Promise<void> {
  const tid = settings.tenant_id;
  try {
    if (!settings.folder_id || !settings.google_api_key) {
      await logToDb(pool, tid, 'warn', 'Skipping — folder_id or google_api_key not configured');
      return;
    }

    // Get already-processed file IDs
    const processed = await pool.query(
      'SELECT drive_file_id FROM monitor_processed_files WHERE tenant_id=$1',
      [tid]
    ).catch(() => ({ rows: [] }));
    const processedIds = new Set(processed.rows.map((r: any) => r.drive_file_id));

    // List Drive files
    const files = await listDriveFiles(settings.folder_id, settings.google_api_key);
    await logToDb(pool, tid, 'info', `Found ${files.length} files in Drive folder`);

    // Filter new financial files
    const newFiles = files.filter((f: any) => {
      if (processedIds.has(f.id)) return false;
      const type = detectFileType(f.name);
      if (!type) return false;
      return settings.file_types.includes(type);
    });

    if (newFiles.length === 0) {
      await pool.query('UPDATE monitor_settings SET last_checked_at=NOW() WHERE tenant_id=$1', [tid]);
      return;
    }

    await logToDb(pool, tid, 'info', `${newFiles.length} new files to process`);

    // Process each new file
    for (const file of newFiles) {
      const fileType = detectFileType(file.name);
      const prior = fileType ? (priorReportsCache[`${tid}_${fileType}`] || []) : [];
      await processTenantFile(pool, settings, file, fileType, prior);
      await new Promise(r => setTimeout(r, 2000)); // Rate limit between files
    }

  } catch (e) {
    await logToDb(pool, tid, 'error', `Monitoring cycle error: ${String(e)}`);
  }
}

export async function startMultiTenantMonitor(pool: Pool): Promise<void> {
  console.log('[Monitor] Starting multi-tenant Drive monitor...');
  const priorReportsCache: Record<string, string[]> = {};
  let cycle = 0;

  // Run migrations
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monitor_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        enabled BOOLEAN DEFAULT false,
        folder_id VARCHAR(255),
        folder_name VARCHAR(255),
        google_api_key TEXT,
        recipients TEXT[],
        check_interval_seconds INTEGER DEFAULT 60,
        file_types TEXT[] DEFAULT ARRAY['monthly','weekly','daily'],
        last_checked_at TIMESTAMPTZ,
        last_file_processed VARCHAR(255),
        total_files_processed INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tenant_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monitor_processed_files (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        drive_file_id VARCHAR(255) NOT NULL,
        file_name VARCHAR(500) NOT NULL,
        file_type VARCHAR(50),
        processed_at TIMESTAMPTZ DEFAULT NOW(),
        report_sent_to TEXT[],
        report_summary TEXT,
        UNIQUE(tenant_id, drive_file_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monitor_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        level VARCHAR(20) DEFAULT 'info',
        message TEXT NOT NULL,
        file_name VARCHAR(500),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('[Monitor] DB tables ready');
  } catch (e) {
    console.error('[Monitor] Migration error:', e);
  }

  // Main loop
  while (true) {
    cycle++;
    try {
      // Load all enabled tenants
      const result = await pool.query(
        `SELECT * FROM monitor_settings WHERE enabled=true AND folder_id IS NOT NULL AND google_api_key IS NOT NULL`
      ).catch(() => ({ rows: [] }));

      const tenants: TenantSettings[] = result.rows;

      if (tenants.length === 0) {
        // Also check env var fallback for backward compatibility
        if (process.env.DRIVE_FOLDER_ID && process.env.GOOGLE_DRIVE_API_KEY) {
          const fallback: TenantSettings = {
            id: 'env',
            tenant_id: process.env.DEFAULT_TENANT_ID || 'af1845e2-39f3-4e9d-b1ed-91c2798a0f6f',
            folder_id: process.env.DRIVE_FOLDER_ID,
            folder_name: 'Default Folder',
            google_api_key: process.env.GOOGLE_DRIVE_API_KEY,
            recipients: (process.env.MONITOR_RECIPIENTS || '').split(',').filter(Boolean),
            check_interval_seconds: parseInt(process.env.MONITOR_SLEEP_SECONDS || '60'),
            file_types: ['monthly', 'weekly', 'daily'],
          };
          await monitorTenant(pool, fallback, priorReportsCache);
        }
      } else {
        console.log(`[Monitor] Cycle #${cycle}: Checking ${tenants.length} active tenant(s)`);
        for (const tenant of tenants) {
          await monitorTenant(pool, tenant, priorReportsCache);
        }
      }
    } catch (e) {
      console.error('[Monitor] Outer loop error:', e);
    }

    const interval = parseInt(process.env.MONITOR_SLEEP_SECONDS || '60');
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}
