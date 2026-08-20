const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/dataIngestionRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

// Add Google Sheets parser after parseXML function
const gsheetsFn = `
  // ── Helper: fetch Google Sheets data ──────────────────────
  // Supports public sheets via CSV export URL
  // Supports private sheets via Google Sheets API (requires GOOGLE_API_KEY)
  async function parseGoogleSheet(urlOrId: string): Promise<{ headers: string[], rows: Record<string, string>[] }> {
    try {
      let sheetId = urlOrId;
      // Extract sheet ID from full URL
      const idMatch = urlOrId.match(/\\/spreadsheets\\/d\\/([a-zA-Z0-9-_]+)/);
      if (idMatch) sheetId = idMatch[1];

      // Try public CSV export first (works for public sheets)
      const csvUrl = \`https://docs.google.com/spreadsheets/d/\${sheetId}/export?format=csv&gid=0\`;
      const response = await fetch(csvUrl, {
        headers: { 'User-Agent': 'Deemona-Finance-OS/1.0' }
      });

      if (response.ok) {
        const text = await response.text();
        // Check if we got actual CSV data (not an error page)
        if (text.includes(',') || text.includes('\\n')) {
          return parseCSV(text);
        }
      }

      // Try Google Sheets API v4 (for private sheets with API key)
      const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
      if (apiKey) {
        const apiUrl = \`https://sheets.googleapis.com/v4/spreadsheets/\${sheetId}/values/Sheet1?key=\${apiKey}\`;
        const apiResp = await fetch(apiUrl);
        if (apiResp.ok) {
          const data = await apiResp.json();
          const values = data.values || [];
          if (values.length < 2) return { headers: [], rows: [] };
          const headers = values[0].map((h: string) => String(h).toLowerCase().trim().replace(/\\s+/g,'_').replace(/[^a-z0-9_]/g,''));
          const rows = values.slice(1).map((row: string[]) => {
            const r: Record<string, string> = {};
            headers.forEach((h: string, i: number) => { r[h] = String(row[i] ?? '').trim(); });
            return r;
          });
          return { headers, rows };
        }
      }

      // Fallback: use AI to fetch and parse via Claude
      throw new Error('Sheet is private. Please make it public or provide GOOGLE_SHEETS_API_KEY, or export as CSV/Excel.');
    } catch (e: any) {
      throw new Error('Google Sheets error: ' + e.message);
    }
  }
`;

// Insert after parseXML function
c = c.replace(
  '  // ── Helper: parse Excel buffer ─────────────────────────────',
  gsheetsFn + '  // ── Helper: parse Excel buffer ─────────────────────────────'
);

// Add gsheet format handling in main POST endpoint
c = c.replace(
  "} else if (format === 'pdf') {\n        const buffer = Buffer.from(data, 'base64');\n        const parsed = await parsePDF(buffer);\n        headers = parsed.headers;\n        rows = parsed.rows;\n      }",
  `} else if (format === 'pdf') {
        const buffer = Buffer.from(data, 'base64');
        const parsed = await parsePDF(buffer);
        headers = parsed.headers;
        rows = parsed.rows;
      } else if (format === 'gsheet') {
        const parsed = await parseGoogleSheet(data.trim());
        headers = parsed.headers;
        rows = parsed.rows;
      }`
);

// Same for preview endpoint
c = c.replace(
  "} else if (format === 'pdf') {\n        const buffer = Buffer.from(data, 'base64');\n        const parsed = await parsePDF(buffer);\n        headers = parsed.headers;\n        rows = parsed.rows;\n      }",
  `} else if (format === 'pdf') {
        const buffer = Buffer.from(data, 'base64');
        const parsed = await parsePDF(buffer);
        headers = parsed.headers;
        rows = parsed.rows;
      } else if (format === 'gsheet') {
        const parsed = await parseGoogleSheet(data.trim());
        headers = parsed.headers;
        rows = parsed.rows;
      }`
);

fs.writeFileSync(f, c, 'utf8');
console.log('Google Sheets support added. Size:', fs.statSync(f).size);
