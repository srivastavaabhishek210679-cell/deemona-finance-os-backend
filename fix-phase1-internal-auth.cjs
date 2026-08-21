const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/phase1Routes.ts';
let c = fs.readFileSync(f, 'utf8');

// Add internal auth bypass at top of file (after imports)
if (!c.includes('requireAuthOrInternal')) {
  c = c.replace(
    "import { requireAuth } from '../middleware/auth';",
    `import { requireAuth } from '../middleware/auth';

// Allow internal cron calls with Bearer internal-{tenantId}
const requireAuthOrInternal = (req: any, res: any, next: any) => {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer internal-')) {
    req.user = { tenantId: auth.replace('Bearer internal-', ''), role: 'internal' };
    return next();
  }
  return requireAuth(req, res, next);
};`
  );

  // Replace requireAuth with requireAuthOrInternal for key endpoints
  c = c.replace(
    "router.get('/balance-sheet', requireAuth,",
    "router.get('/balance-sheet', requireAuthOrInternal,"
  );
  c = c.replace(
    "router.post('/anomaly/detect', requireAuth,",
    "router.post('/anomaly/detect', requireAuthOrInternal,"
  );
  c = c.replace(
    "router.post('/insights/generate', requireAuth,",
    "router.post('/insights/generate', requireAuthOrInternal,"
  );
  c = c.replace(
    "router.post('/filing/generate', requireAuth,",
    "router.post('/filing/generate', requireAuthOrInternal,"
  );

  fs.writeFileSync(f, c, 'utf8');
  console.log('Internal auth added to phase1Routes');
} else {
  console.log('Already has internal auth');
}
