const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/dataIngestionRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

// Replace the broken processIngestData with correct version
const oldFn = c.substring(c.indexOf('\n// ── Exported: processIngestData'), c.indexOf('\nexport function createDataIngestionRouter'));
const newFn = `
// ── Exported: processIngestData for internal use ─────────────
export async function processIngestData(pool: any, tenantId: string, data: string, format: string): Promise<{inserted:number,updated:number,errors:number,dataType:string}> {
  try {
    let rows: Record<string, string>[] = [];
    let headers: string[] = [];

    if (format === 'json') {
      const jsonData = typeof data === 'string' ? JSON.parse(data) : data;
      if (Array.isArray(jsonData) && jsonData.length > 0) {
        headers = Object.keys(jsonData[0]).map((h: string) => h.toLowerCase().replace(/\\s+/g, '_'));
        rows = jsonData.map((item: any) => {
          const row: Record<string, string> = {};
          Object.entries(item).forEach(([k, v]: [string, any]) => { row[k.toLowerCase().replace(/\\s+/g, '_')] = String(v || ''); });
          return row;
        });
      }
    } else if (format === 'csv' || format === 'text') {
      const parsed = parseCSV(data);
      headers = parsed.headers;
      rows = parsed.rows;
    } else if (format === 'gsheet') {
      const parsed = await parseGoogleSheet(data.trim());
      headers = parsed.headers;
      rows = parsed.rows;
    } else if (format === 'excel' || format === 'xlsx') {
      const buf = Buffer.from(data, 'base64');
      const parsed = parseExcel(buf);
      headers = parsed.headers;
      rows = parsed.rows;
    } else if (format === 'xml') {
      const parsed = parseXML(data);
      headers = parsed.headers;
      rows = parsed.rows;
    }

    if (!rows.length) return { inserted: 0, updated: 0, errors: 0, dataType: 'UNKNOWN' };

    const dataType = await detectDataType(headers, rows);
    const fm = await mapFields(dataType, headers, rows.slice(0, 3));
    const result = await processRows(pool, tenantId, dataType, rows, fm);

    await pool.query(
      "INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at) VALUES ($1, 'DATA_INGESTION', $2, $3, NOW())",
      [tenantId, result.errors.length === 0 ? 'success' : 'partial', dataType + ': ' + result.inserted + ' inserted via auto-ingest']
    ).catch(() => {});

    return { inserted: result.inserted || 0, updated: result.updated || 0, errors: result.errors.length || 0, dataType };
  } catch(e) {
    console.error('[processIngestData] Error:', e);
    return { inserted: 0, updated: 0, errors: 1, dataType: 'UNKNOWN' };
  }
}

`;

c = c.replace(oldFn, newFn);
fs.writeFileSync(f, c, 'utf8');
console.log('Fixed. processIngestData uses parseCSV/mapFields/processRows correctly');
console.log('Size:', fs.statSync(f).size);
