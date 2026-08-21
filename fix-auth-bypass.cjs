const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/dataIngestionRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

// Add internal auth middleware after requireAuth import
c = c.replace(
  "import { requireAuth } from '../middleware/auth';",
  `import { requireAuth } from '../middleware/auth';

// Allow internal calls with Bearer internal-{tenantId}
const requireAuthOrInternal = (req: any, res: any, next: any) => {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer internal-')) {
    req.user = { tenantId: auth.replace('Bearer internal-', ''), role: 'internal' };
    return next();
  }
  return requireAuth(req, res, next);
};`
);

// Replace requireAuth with requireAuthOrInternal in main POST route
c = c.replace(
  "router.post('/', requireAuth, async",
  "router.post('/', requireAuthOrInternal, async"
);

fs.writeFileSync(f, c, 'utf8');
console.log('Fixed. Has requireAuthOrInternal:', c.includes('requireAuthOrInternal'));
