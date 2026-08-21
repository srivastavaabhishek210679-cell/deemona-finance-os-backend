const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/dataIngestionRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

// Find the exported router function and add processIngestData before it
const exportIdx = c.indexOf('export function createDataIngestionRouter');
if (exportIdx === -1) {
  // Try to find export default or module.exports
  console.log('Looking for router export...');
  const routerIdx = c.indexOf('const router = Router()');
  console.log('Router at:', routerIdx);
}

// Add exported processIngestData function before the router export
const exportedFn = `
// ── Exported: processIngestData for internal use ─────────────
export async function processIngestData(pool: any, tenantId: string, data: string, format: string): Promise<{inserted:number,updated:number,errors:number,dataType:string}> {
  try {
    // Parse data based on format
    let rows: Record<string, string>[] = [];
    let headers: string[] = [];

    if (format === 'json') {
      const jsonData = typeof data === 'string' ? JSON.parse(data) : data;
      if (Array.isArray(jsonData) && jsonData.length > 0) {
        headers = Object.keys(jsonData[0]).map((h: string) => h.toLowerCase().replace(/\\s+/g, '_'));
        rows = jsonData.map((item: any) => {
          const row: Record<string, string> = {};
          Object.entries(item).forEach(([k, v]: [string, any]) => {
            row[k.toLowerCase().replace(/\\s+/g, '_')] = String(v || '');
          });
          return row;
        });
      }
    } else if (format === 'csv' || format === 'text') {
      const lines = data.trim().split('\\n');
      if (lines.length > 1) {
        headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\\s+/g,'_').replace(/[^a-z0-9_]/g,''));
        rows = lines.slice(1).filter(l => l.trim()).map(line => {
          const vals = line.split(',');
          const row: Record<string, string> = {};
          headers.forEach((h, i) => { row[h] = (vals[i]||'').trim().replace(/^"|"$/g,''); });
          return row;
        });
      }
    } else if (format === 'excel' || format === 'xlsx') {
      const XLSX = await import('xlsx');
      const buffer = Buffer.from(data, 'base64');
      const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'yyyy-mm-dd' }) as any[][];
      if (raw.length >= 2) {
        headers = (raw[0] as string[]).map((h: string) => String(h||'').toLowerCase().trim().replace(/\\s+/g,'_').replace(/[^a-z0-9_]/g,''));
        rows = raw.slice(1).filter((r: any[]) => r.some((v: any) => v !== null && v !== '')).map((r: any[]) => {
          const row: Record<string, string> = {};
          headers.forEach((h: string, i: number) => { row[h] = String(r[i] ?? '').trim(); });
          return row;
        });
      }
    } else if (format === 'gsheet') {
      const idMatch = data.match(/\\/spreadsheets\\/d\\/([a-zA-Z0-9-_]+)/);
      const sheetId = idMatch ? idMatch[1] : data.trim();
      const resp = await fetch(\`https://docs.google.com/spreadsheets/d/\${sheetId}/export?format=csv\`);
      if (resp.ok) {
        const csvText = await resp.text();
        const lines = csvText.trim().split('\\n');
        if (lines.length > 1) {
          headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\\s+/g,'_').replace(/[^a-z0-9_]/g,''));
          rows = lines.slice(1).filter(l => l.trim()).map(line => {
            const vals = line.split(',');
            const row: Record<string, string> = {};
            headers.forEach((h, i) => { row[h] = (vals[i]||'').trim().replace(/^"|"$/g,''); });
            return row;
          });
        }
      }
    }

    if (!rows.length) return { inserted: 0, updated: 0, errors: 0, dataType: 'UNKNOWN' };

    // Detect data type
    const dataType = await detectDataType(headers, rows);
    // Process rows
    const result = await processRows(pool, tenantId, dataType, rows, fieldMap(headers, dataType));
    return { inserted: result.inserted||0, updated: result.updated||0, errors: result.errors||0, dataType };
  } catch(e) {
    console.error('[processIngestData] Error:', e);
    return { inserted: 0, updated: 0, errors: 1, dataType: 'UNKNOWN' };
  }
}

`;

// Insert before export or near end of file
const insertBefore = 'export function createDataIngestionRouter';
if (c.includes(insertBefore)) {
  c = c.replace(insertBefore, exportedFn + insertBefore);
  console.log('Inserted before router export');
} else {
  // Append near end
  c = c.trimEnd() + '\n' + exportedFn + '\n';
  console.log('Appended to end');
}

fs.writeFileSync(f, c, 'utf8');
console.log('Done. Has processIngestData export:', c.includes('export async function processIngestData'));
