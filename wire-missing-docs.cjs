const fs = require('fs');

// Copy route file
fs.copyFileSync(
  'C:/deemona-finance-os/backend/src/routes/missingDocsRoutes.ts',
  'C:/deemona-finance-os/backend/src/routes/missingDocsRoutes.ts'
);
console.log('âœ“ missingDocsRoutes.ts copied');

// Wire into index.ts
const idxFile = 'C:/deemona-finance-os/backend/src/index.ts';
let idx = fs.readFileSync(idxFile, 'utf8');

if (!idx.includes('createMissingDocsRouter')) {
  idx = idx.replace(
    "import { createAutomationTestRouter }",
    "import { createMissingDocsRouter } from './routes/missingDocsRoutes';\nimport { createAutomationTestRouter }"
  );
  idx = idx.replace(
    "app.use('/api/automation', createAutomationTestRouter(pool));",
    "app.use('/api/docs', createMissingDocsRouter(pool));\n  app.use('/api/automation', createAutomationTestRouter(pool));"
  );
  fs.writeFileSync(idxFile, idx, 'utf8');
  console.log('âœ“ Wired into index.ts');
}

console.log('Done!');
