const fs = require('fs');

// 1. Fix autoIngestRoutes - use backend URL instead of localhost
const f = 'C:/deemona-finance-os/backend/src/routes/autoIngestRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

// Remove the processIngestData import
c = c.replace("import { processIngestData } from './dataIngestionRoutes';\n", '');

// Replace the processIngestData call with direct URL call using backend URL
c = c.replace(
  'const result = await processIngestData(pool, tenantId, data, format);',
  `const backendUrl = process.env.BACKEND_URL || 'https://deemona-finance-os-api.onrender.com';
    const authToken = await pool.query('SELECT id FROM users WHERE tenant_id=$1 LIMIT 1', [tenantId]).then(r => r.rows[0]?.id).catch(()=>null);
    const resp = await fetch(backendUrl + '/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer internal-' + tenantId },
      body: JSON.stringify({ data, format, tenantId }),
    });
    const result = await resp.json() as any;`
);

fs.writeFileSync(f, c, 'utf8');
console.log('Fixed autoIngestRoutes');

// 2. Remove processIngestData export from dataIngestionRoutes
const f2 = 'C:/deemona-finance-os/backend/src/routes/dataIngestionRoutes.ts';
let c2 = fs.readFileSync(f2, 'utf8');
const fnStart = c2.indexOf('\n// ── Exported: processIngestData');
if (fnStart !== -1) {
  c2 = c2.substring(0, fnStart) + '\n';
  fs.writeFileSync(f2, c2, 'utf8');
  console.log('Removed processIngestData from dataIngestionRoutes');
}
