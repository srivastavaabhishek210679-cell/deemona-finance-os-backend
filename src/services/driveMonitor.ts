import { mailFetch } from './mailer';
// ============================================================
// Deemona AI Finance OS — Autonomous Google Drive Monitor
// File: src/services/driveMonitor.ts
// Runs forever, detects new financial files, generates reports
// ============================================================

import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Config ────────────────────────────────────────────────────
const DRIVE_FOLDER_ID   = process.env.DRIVE_FOLDER_ID || '';
const DRIVE_API_KEY     = process.env.GOOGLE_DRIVE_API_KEY || '';
const RECIPIENT_EMAILS  = (process.env.MONITOR_RECIPIENTS || 'srivastava.abhishek210679@gmail.com').split(',');
const RESEND_API_KEY    = process.env.RESEND_API_KEY || '';
const FROM_EMAIL        = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const SLEEP_SECONDS     = parseInt(process.env.MONITOR_SLEEP_SECONDS || '60');
const PROCESSED_FILE    = process.env.PROCESSED_FILE || '/mnt/session/outputs/processed_files.json';
const ERROR_LOG         = process.env.ERROR_LOG || '/mnt/session/outputs/error_log.txt';

// ── File pattern detection ─────────────────────────────────────
const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december','jan','feb','mar','apr','jun','jul','aug','sep','oct','nov','dec'];
const DAY_NAMES   = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday','mon','tue','wed','thu','fri','sat','sun'];
const WEEK_PATTERNS = ['week','weekly','wk','w1','w2','w3','w4','w5'];
const MONTH_PATTERNS = ['monthly','month','mtd','m1','m2','m3','m4','m5','m6','m7','m8','m9','m10','m11','m12'];
const DAILY_PATTERNS = ['daily','day','dtd','d1','d2','d3','d4','d5','d6','d7'];
const FINANCIAL_EXTS  = ['.xlsx','.xls','.csv','.pdf','.xlsm'];

type FileType = 'monthly' | 'weekly' | 'daily' | null;

function detectFileType(filename: string): FileType {
  const lower = filename.toLowerCase();
  if (!FINANCIAL_EXTS.some(ext => lower.endsWith(ext))) return null;
  if (MONTH_PATTERNS.some(p => lower.includes(p)) || MONTH_NAMES.some(m => lower.includes(m))) return 'monthly';
  if (WEEK_PATTERNS.some(p => lower.includes(p))) return 'weekly';
  if (DAILY_PATTERNS.some(p => lower.includes(p)) || DAY_NAMES.some(d => lower.includes(d))) return 'daily';
  return null;
}

// ── Logging ───────────────────────────────────────────────────
function logError(msg: string, err?: any) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ERROR: ${msg}${err ? ' | ' + String(err) : ''}\n`;
  console.error(line.trim());
  try {
    const dir = path.dirname(ERROR_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(ERROR_LOG, line, 'utf8');
  } catch (e) {
    console.error('[Monitor] Could not write to error log:', e);
  }
}

function logInfo(msg: string) {
  console.log(`[${new Date().toISOString()}] INFO: ${msg}`);
}

// ── Processed files tracker ───────────────────────────────────
interface ProcessedFile {
  id: string;
  name: string;
  type: FileType;
  processedAt: string;
  reportSentTo: string[];
}

function loadProcessed(): Record<string, ProcessedFile> {
  try {
    const dir = path.dirname(PROCESSED_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(PROCESSED_FILE)) {
      fs.writeFileSync(PROCESSED_FILE, JSON.stringify({}), 'utf8');
      return {};
    }
    return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
  } catch (e) {
    logError('Failed to load processed_files.json', e);
    return {};
  }
}

function saveProcessed(processed: Record<string, ProcessedFile>) {
  try {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify(processed, null, 2), 'utf8');
  } catch (e) {
    logError('Failed to save processed_files.json', e);
  }
}

function markProcessed(processed: Record<string, ProcessedFile>, file: { id: string; name: string }, type: FileType, recipients: string[]) {
  processed[file.id] = {
    id: file.id,
    name: file.name,
    type,
    processedAt: new Date().toISOString(),
    reportSentTo: recipients,
  };
  saveProcessed(processed);
  logInfo(`Marked as processed: ${file.name} (${file.id})`);
}

// ── Google Drive API ──────────────────────────────────────────
interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
}

async function listDriveFiles(folderId: string): Promise<DriveFile[]> {
  if (!folderId) throw new Error('DRIVE_FOLDER_ID not configured');

  // Use Google Drive API v3
  // Supports both API key (public folders) and service account (private)
  const query = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,size)');

  let url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&pageSize=100`;
  if (DRIVE_API_KEY) url += `&key=${DRIVE_API_KEY}`;

  const headers: Record<string, string> = { 'Accept': 'application/json' };

  // If OAuth token available (for private folders)
  const oauthToken = process.env.GOOGLE_OAUTH_TOKEN;
  if (oauthToken) headers['Authorization'] = `Bearer ${oauthToken}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Drive API error ${res.status}: ${err}`);
  }
  const data = await res.json() as any;
  return data.files || [];
}

async function downloadDriveFile(fileId: string): Promise<Buffer> {
  let url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  if (DRIVE_API_KEY) url += `&key=${DRIVE_API_KEY}`;

  const headers: Record<string, string> = {};
  const oauthToken = process.env.GOOGLE_OAUTH_TOKEN;
  if (oauthToken) headers['Authorization'] = `Bearer ${oauthToken}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

// ── Financial Analysis with Claude ───────────────────────────
async function analyzeFile(filename: string, fileBuffer: Buffer, fileType: FileType, priorReports: string[]): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  const fileSize = fileBuffer.length;

  // For CSV files — parse as text
  let fileContent = '';
  if (ext === '.csv' || ext === '.txt') {
    fileContent = fileBuffer.toString('utf8').substring(0, 8000);
  } else if (ext === '.xlsx' || ext === '.xls') {
    // For Excel — convert to base64 and send as document
    fileContent = `[Excel file: ${filename}, ${fileSize} bytes — binary data not shown in text preview]`;
  } else if (ext === '.pdf') {
    fileContent = `[PDF file: ${filename}, ${fileSize} bytes]`;
  }

  const priorContext = priorReports.length > 0
    ? `\nPRIOR REPORTS FOR COMPARISON:\n${priorReports.slice(-2).join('\n\n---\n\n').substring(0, 3000)}`
    : '\nNo prior reports available for comparison.';

  const prompt = `You are the Deemona AI Finance OS executive analyst. Analyze this ${fileType} financial report file and generate a comprehensive executive FOS&A (Finance OS & Agents) report.

FILE DETAILS:
- Filename: ${filename}
- Type: ${fileType} report
- Size: ${fileSize} bytes
- Extension: ${ext}

FILE CONTENT PREVIEW:
${fileContent}
${priorContext}

Generate a structured executive report with these sections:

1. EXECUTIVE SUMMARY
   - Key financial highlights
   - Period covered
   - Critical alerts (if any)

2. FINANCIAL PERFORMANCE
   - Revenue analysis
   - Expense breakdown
   - Profit/Loss position
   - Cash flow status

3. PERIOD-OVER-PERIOD COMPARISON
   - Compare vs prior ${fileType} report (if available)
   - Variance analysis
   - Trend direction

4. KEY METRICS
   - Top 5 financial KPIs
   - Ratios and benchmarks

5. RISK & ALERTS
   - Any anomalies detected
   - Compliance flags
   - Cash runway concerns

6. AI RECOMMENDATIONS
   - Top 3 action items
   - Priority level for each

7. DEEMONA AGENTS INSIGHTS
   - Arya (HR): Payroll observations
   - Raj (Sales): Revenue observations
   - Priya (Procurement): Spend observations

IMPORTANT: 
- Never fabricate specific numbers not present in the file
- If data is missing, state clearly what is missing
- Base all analysis only on data available in the file
- Flag any data quality issues

Format the report professionally for C-suite distribution.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  return (response.content[0] as any).text || 'Analysis could not be generated.';
}

// ── Email Report ──────────────────────────────────────────────
async function sendReport(filename: string, fileType: FileType, report: string, recipients: string[]): Promise<boolean> {
  if (!RESEND_API_KEY) {
    logError('RESEND_API_KEY not configured — cannot send email');
    return false;
  }

  const subject = `Deemona FOS&A Report: ${fileType?.toUpperCase()} | ${filename} | ${new Date().toLocaleDateString('en-IN')}`;

  const html = `
<!DOCTYPE html>
<html>
<head><style>
  body { font-family: Inter, Arial, sans-serif; color: #0A1628; background: #EEF3FD; margin: 0; padding: 20px; }
  .card { background: #fff; border-radius: 12px; padding: 32px; max-width: 700px; margin: 0 auto; }
  .header { background: linear-gradient(135deg, #1B4FD8, #3B82F6); padding: 24px; border-radius: 10px; color: #fff; margin-bottom: 24px; }
  .header h1 { margin: 0; font-size: 20px; }
  .header p { margin: 6px 0 0; opacity: 0.8; font-size: 13px; }
  .meta { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  .meta-item { padding: 8px 14px; border-radius: 7px; background: #EEF3FD; border: 1px solid #C7D9F8; font-size: 12px; color: #1B4FD8; font-weight: 600; }
  .report { white-space: pre-wrap; font-size: 13px; line-height: 1.7; color: #334155; background: #F8FAFC; padding: 20px; border-radius: 8px; border: 1px solid #E2E8F0; }
  .footer { text-align: center; color: #94A3B8; font-size: 11px; margin-top: 24px; }
</style></head>
<body>
<div class="card">
  <div class="header">
    <h1>Deemona AI Finance OS — Executive Report</h1>
    <p>FOS&A Autonomous Monitoring System · Generated ${new Date().toLocaleString('en-IN')}</p>
  </div>
  <div class="meta">
    <span class="meta-item">File: ${filename}</span>
    <span class="meta-item">Type: ${fileType?.toUpperCase()}</span>
    <span class="meta-item">Generated: ${new Date().toLocaleDateString('en-IN')}</span>
  </div>
  <div class="report">${report.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  <div class="footer">
    Deemona Technologies | AI Finance OS | Autonomous Report<br/>
    This report was generated automatically by the FOS&A monitoring system.
  </div>
</div>
</body>
</html>`;

  try {
    const res = await mailFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Deemona Finance OS <${FROM_EMAIL}>`,
        to: recipients,
        subject,
        html,
        text: `Deemona FOS&A Report\n\nFile: ${filename}\nType: ${fileType}\nGenerated: ${new Date().toISOString()}\n\n${report}`,
      }),
    });
    const data = await res.json() as any;
    if (data.id) {
      logInfo(`Email sent successfully to ${recipients.join(', ')} | ID: ${data.id}`);
      return true;
    }
    logError(`Email send failed: ${JSON.stringify(data)}`);
    return false;
  } catch (e) {
    logError('Email send exception', e);
    return false;
  }
}

// ── Prior reports cache ───────────────────────────────────────
const priorReportsCache: Record<string, string[]> = { monthly: [], weekly: [], daily: [] };

// ── Process a single file ─────────────────────────────────────
async function processFile(file: DriveFile, fileType: FileType, processed: Record<string, ProcessedFile>): Promise<void> {
  logInfo(`Processing ${fileType} file: ${file.name} (${file.id})`);

  try {
    // 1. Download file
    logInfo(`Downloading: ${file.name}`);
    let fileBuffer: Buffer;
    try {
      fileBuffer = await downloadDriveFile(file.id);
      logInfo(`Downloaded ${fileBuffer.length} bytes`);
    } catch (e) {
      logError(`Failed to download ${file.name}`, e);
      return; // Skip this file, continue loop
    }

    // 2. Analyze with Claude
    logInfo(`Analyzing: ${file.name}`);
    let report: string;
    try {
      const prior = fileType ? priorReportsCache[fileType] || [] : [];
      report = await analyzeFile(file.name, fileBuffer, fileType, prior);
      logInfo(`Analysis complete for: ${file.name}`);
    } catch (e) {
      logError(`Failed to analyze ${file.name}`, e);
      return; // Skip this file
    }

    // 3. Send email immediately
    logInfo(`Sending report email for: ${file.name}`);
    try {
      const sent = await sendReport(file.name, fileType, report, RECIPIENT_EMAILS);
      if (!sent) logError(`Email not sent for ${file.name} — will still mark as processed`);
    } catch (e) {
      logError(`Failed to send email for ${file.name}`, e);
      // Continue — still mark as processed
    }

    // 4. Update prior reports cache
    if (fileType && priorReportsCache[fileType]) {
      priorReportsCache[fileType].push(`=== ${file.name} ===\n${report}`);
      if (priorReportsCache[fileType].length > 3) priorReportsCache[fileType].shift(); // Keep last 3
    }

    // 5. Mark as processed
    markProcessed(processed, file, fileType, RECIPIENT_EMAILS);
    logInfo(`Successfully processed: ${file.name}`);

  } catch (e) {
    // Catch-all — never crash the loop
    logError(`Unexpected error processing ${file.name}`, e);
  }
}

// ── Main monitoring loop ──────────────────────────────────────
export async function startMonitoringLoop(): Promise<void> {
  logInfo('=== Deemona FOS&A Drive Monitor Starting ===');
  logInfo(`Folder ID: ${DRIVE_FOLDER_ID || 'NOT SET'}`);
  logInfo(`Recipients: ${RECIPIENT_EMAILS.join(', ')}`);
  logInfo(`Sleep interval: ${SLEEP_SECONDS}s`);
  logInfo(`Processed file: ${PROCESSED_FILE}`);
  logInfo(`Error log: ${ERROR_LOG}`);
  logInfo('==========================================');

  if (!DRIVE_FOLDER_ID) {
    logError('DRIVE_FOLDER_ID environment variable not set. Set it in Render and restart.');
  }

  let cycleCount = 0;

  // ── Infinite loop — never terminates ──────────────────────
  while (true) {
    cycleCount++;
    logInfo(`--- Monitoring Cycle #${cycleCount} ---`);

    try {
      // Load processed files tracker
      const processed = loadProcessed();
      const processedIds = new Set(Object.keys(processed));

      // List files from Google Drive
      let files: DriveFile[] = [];
      try {
        files = await listDriveFiles(DRIVE_FOLDER_ID);
        logInfo(`Found ${files.length} files in Drive folder`);
      } catch (e) {
        logError('Failed to list Drive files', e);
        // Don't crash — sleep and retry
        logInfo(`Sleeping ${SLEEP_SECONDS}s before retry...`);
        await sleep(SLEEP_SECONDS);
        continue;
      }

      // Filter: only financial files not yet processed
      const newFiles = files.filter(f => {
        if (processedIds.has(f.id)) return false;
        const type = detectFileType(f.name);
        return type !== null;
      });

      logInfo(`New unprocessed financial files: ${newFiles.length}`);

      if (newFiles.length === 0) {
        logInfo(`No new files. Sleeping ${SLEEP_SECONDS}s...`);
        await sleep(SLEEP_SECONDS);
        continue;
      }

      // Process each new file — never stop for single failure
      for (const file of newFiles) {
        const fileType = detectFileType(file.name);
        logInfo(`Detected ${fileType} file: ${file.name}`);
        await processFile(file, fileType, processed);
        // Small delay between files to avoid API rate limits
        await sleep(2);
      }

    } catch (e) {
      // Outer catch — should never reach here but just in case
      logError('Unexpected error in monitoring cycle', e);
    }

    // Sleep before next cycle
    logInfo(`Cycle #${cycleCount} complete. Sleeping ${SLEEP_SECONDS}s...`);
    await sleep(SLEEP_SECONDS);
  }
}

// ── Sleep helper ──────────────────────────────────────────────
function sleep(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// ── Start if run directly ─────────────────────────────────────
if (require.main === module) {
  startMonitoringLoop().catch(e => {
    logError('FATAL: Monitor crashed', e);
    // Even on fatal error — restart after 30 seconds
    setTimeout(() => {
      logInfo('Restarting after fatal error...');
      startMonitoringLoop();
    }, 30000);
  });
}
