const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/dataIngestionRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

// Remove the exported function from current location (near top)
const fnStart = c.indexOf('\n// ── Exported: processIngestData');
const fnEnd = c.indexOf('\nexport function createDataIngestionRouter');
const exportedFn = c.substring(fnStart, fnEnd);

// Remove from current location
c = c.replace(exportedFn, '\n');

// Append at very end of file (after everything is defined)
c = c.trimEnd() + '\n' + exportedFn.trimStart() + '\n';

fs.writeFileSync(f, c, 'utf8');
console.log('Moved to end. Size:', fs.statSync(f).size);
console.log('processIngestData at:', c.indexOf('export async function processIngestData'));
console.log('processRows defined at:', c.indexOf('async function processRows'));
const piIdx = c.indexOf('export async function processIngestData');
const prIdx = c.indexOf('async function processRows');
console.log('processRows comes before processIngestData:', prIdx < piIdx);
