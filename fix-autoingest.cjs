const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/autoIngestRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

// Add import for ingest processor at top
if (!c.includes('processIngest')) {
  c = c.replace(
    "import Anthropic from '@anthropic-ai/sdk';",
    "import Anthropic from '@anthropic-ai/sdk';\nimport { processIngestData } from './dataIngestionRoutes';"
  );
}

// Replace localhost fetch with direct function call
const oldFn = `  try {
    const resp = await fetch(\`http://localhost:\${process.env.PORT||4001}/api/ingest\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-tenant': tenantId },
      body: JSON.stringify({ data, format, tenantId }),
    });
    const result = await resp.json() as any;
    const outcome = { inserted: result.inserted||0, updated: result.updated||0, errors: result.errors||0, dataType: result.dataType||'UNKNOWN' };`;

const newFn = `  try {
    const result = await processIngestData(pool, tenantId, data, format);
    const outcome = { inserted: result.inserted||0, updated: result.updated||0, errors: result.errors||0, dataType: result.dataType||'UNKNOWN' };`;

c = c.replace(oldFn, newFn);

fs.writeFileSync(f, c, 'utf8');
console.log('Fixed. Has processIngestData:', c.includes('processIngestData'));
