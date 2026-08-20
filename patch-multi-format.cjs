const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/dataIngestionRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

// Add imports at the top after existing imports
const newImports = `import Anthropic from '@anthropic-ai/sdk';
import * as XLSX from 'xlsx';
import { XMLParser } from 'fast-xml-parser';
import pdfParse from 'pdf-parse';`;

// Replace existing anthropic import
c = c.replace(
  "import Anthropic from '@anthropic-ai/sdk';",
  `import Anthropic from '@anthropic-ai/sdk';
import * as XLSX from 'xlsx';
import { XMLParser } from 'fast-xml-parser';`
);

// Add parseXML helper after parseCSV function
const xmlParser = `
  // ── Helper: parse XML ──────────────────────────────────────
  function parseXML(text: string): { headers: string[], rows: Record<string, string>[] } {
    try {
      const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: true });
      const obj = parser.parse(text);
      // Find array of records - look for first array in parsed object
      const findArray = (o: any): any[] => {
        if (Array.isArray(o)) return o;
        if (typeof o === 'object' && o !== null) {
          for (const v of Object.values(o)) {
            const found = findArray(v);
            if (found.length > 0) return found;
          }
        }
        return [];
      };
      const records = findArray(obj);
      if (!records.length) return { headers: [], rows: [] };
      const headers = Object.keys(records[0]).map(h => h.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/@/g,''));
      const rows = records.map(r => {
        const row: Record<string, string> = {};
        Object.entries(r).forEach(([k, v], i) => { row[headers[i]] = String(v ?? ''); });
        return row;
      });
      return { headers, rows };
    } catch { return { headers: [], rows: [] }; }
  }

  // ── Helper: parse Excel buffer ─────────────────────────────
  function parseExcel(buffer: Buffer): { headers: string[], rows: Record<string, string>[] } {
    try {
      const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'yyyy-mm-dd' }) as any[][];
      if (raw.length < 2) return { headers: [], rows: [] };
      const headers = (raw[0] as string[]).map(h => String(h||'').toLowerCase().trim().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,''));
      const rows = raw.slice(1).filter(r => r.some(v => v !== null && v !== '')).map(r => {
        const row: Record<string, string> = {};
        headers.forEach((h, i) => { row[h] = String(r[i] ?? '').trim(); });
        return row;
      });
      return { headers, rows };
    } catch (e) { console.error('Excel parse error:', e); return { headers: [], rows: [] }; }
  }

  // ── Helper: extract PDF table data via AI ─────────────────
  async function parsePDF(buffer: Buffer): Promise<{ headers: string[], rows: Record<string, string>[] }> {
    try {
      // Convert buffer to base64 for Claude vision
      const base64 = buffer.toString('base64');
      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 }
            },
            {
              type: 'text',
              text: \`Extract ALL tabular data from this PDF document. 
Return ONLY a JSON object with this exact structure:
{
  "headers": ["col1", "col2", ...],
  "rows": [
    {"col1": "val1", "col2": "val2", ...},
    ...
  ]
}
Rules:
- Include every row and column you can find
- Normalize header names to snake_case (lowercase, underscores)
- Convert dates to YYYY-MM-DD format
- Remove currency symbols from numbers but keep the numeric value
- If multiple tables exist, merge them if they have the same structure
- Return empty arrays if no table found
- Return ONLY the JSON, no explanation\`
            }
          ]
        }]
      });
      const text = (resp.content[0] as any).text || '{}';
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return { headers: parsed.headers || [], rows: parsed.rows || [] };
      }
      return { headers: [], rows: [] };
    } catch (e) {
      console.error('PDF parse error:', e);
      return { headers: [], rows: [] };
    }
  }
`;

// Insert parsers before processRows helper
c = c.replace(
  '  // ── Helper: process and insert rows ──────────────────────',
  xmlParser + '  // ── Helper: process and insert rows ──────────────────────'
);

// Now update the main POST endpoint to handle all formats
const oldFormatBlock = `      let rows: Record<string, string>[] = [];
      let headers: string[] = [];

      // Parse based on format
      if (format === 'csv' || format === 'text') {
        const parsed = parseCSV(typeof data === 'string' ? data : JSON.stringify(data));
        headers = parsed.headers;
        rows = parsed.rows;
      } else if (format === 'json') {
        const jsonData = typeof data === 'string' ? JSON.parse(data) : data;
        if (Array.isArray(jsonData) && jsonData.length > 0) {
          headers = Object.keys(jsonData[0]).map(h => h.toLowerCase().replace(/\\s+/g, '_'));
          rows = jsonData.map(item => {
            const row: Record<string, string> = {};
            Object.entries(item).forEach(([k, v]) => {
              row[k.toLowerCase().replace(/\\s+/g, '_')] = String(v || '');
            });
            return row;
          });
        }
      }`;

const newFormatBlock = `      let rows: Record<string, string>[] = [];
      let headers: string[] = [];

      // Parse based on format
      if (format === 'csv' || format === 'text') {
        const parsed = parseCSV(typeof data === 'string' ? data : JSON.stringify(data));
        headers = parsed.headers;
        rows = parsed.rows;
      } else if (format === 'json') {
        const jsonData = typeof data === 'string' ? JSON.parse(data) : data;
        if (Array.isArray(jsonData) && jsonData.length > 0) {
          headers = Object.keys(jsonData[0]).map(h => h.toLowerCase().replace(/\\s+/g, '_'));
          rows = jsonData.map(item => {
            const row: Record<string, string> = {};
            Object.entries(item).forEach(([k, v]) => {
              row[k.toLowerCase().replace(/\\s+/g, '_')] = String(v || '');
            });
            return row;
          });
        }
      } else if (format === 'excel' || format === 'xlsx') {
        const buffer = Buffer.from(data, 'base64');
        const parsed = parseExcel(buffer);
        headers = parsed.headers;
        rows = parsed.rows;
      } else if (format === 'xml') {
        const parsed = parseXML(typeof data === 'string' ? data : '');
        headers = parsed.headers;
        rows = parsed.rows;
      } else if (format === 'pdf') {
        const buffer = Buffer.from(data, 'base64');
        const parsed = await parsePDF(buffer);
        headers = parsed.headers;
        rows = parsed.rows;
      }`;

c = c.replace(oldFormatBlock, newFormatBlock);

// Same for preview endpoint
const oldPreviewFormat = `      if (format === 'csv' || format === 'text') {
        const parsed = parseCSV(data);
        headers = parsed.headers;
        rows = parsed.rows;
      } else if (format === 'json') {
        const jsonData = typeof data === 'string' ? JSON.parse(data) : data;
        if (Array.isArray(jsonData)) {
          headers = Object.keys(jsonData[0] || {});
          rows = jsonData.map(item => {
            const r: Record<string, string> = {};
            Object.entries(item).forEach(([k,v]) => r[k] = String(v||''));
            return r;
          });
        }
      }`;

const newPreviewFormat = `      if (format === 'csv' || format === 'text') {
        const parsed = parseCSV(data);
        headers = parsed.headers;
        rows = parsed.rows;
      } else if (format === 'json') {
        const jsonData = typeof data === 'string' ? JSON.parse(data) : data;
        if (Array.isArray(jsonData)) {
          headers = Object.keys(jsonData[0] || {});
          rows = jsonData.map(item => {
            const r: Record<string, string> = {};
            Object.entries(item).forEach(([k,v]) => r[k] = String(v||''));
            return r;
          });
        }
      } else if (format === 'excel' || format === 'xlsx') {
        const buffer = Buffer.from(data, 'base64');
        const parsed = parseExcel(buffer);
        headers = parsed.headers;
        rows = parsed.rows;
      } else if (format === 'xml') {
        const parsed = parseXML(data);
        headers = parsed.headers;
        rows = parsed.rows;
      } else if (format === 'pdf') {
        const buffer = Buffer.from(data, 'base64');
        const parsed = await parsePDF(buffer);
        headers = parsed.headers;
        rows = parsed.rows;
      }`;

c = c.replace(oldPreviewFormat, newPreviewFormat);

fs.writeFileSync(f, c, 'utf8');
console.log('Backend patched. Size:', fs.statSync(f).size);
