// Closes the same hole in dataIngestionRoutes.ts and fixes its caller autoIngestRoutes.ts.
// Run from C:\deemona-finance-os\backend :  node secure-ingest-auth.cjs
// REQUIRES CRON_SECRET (16+ chars) to be set on Render BEFORE you deploy, or auto-ingest will get 401.
const fs = require('fs')
let failed = false
const read = f => { let t = fs.readFileSync(f, 'utf8'); return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t }

// 1) receiving side
const f1 = 'src/routes/dataIngestionRoutes.ts'
let a = read(f1)
const re = /\/\/ Allow internal calls with Bearer internal-\{tenantId\}\r?\nconst requireAuthOrInternal = [\s\S]*?\r?\n\};/
const block = `// Internal calls send "Bearer internal-<CRON_SECRET>.<tenantId>". Rejected unless CRON_SECRET is set (>=16 chars) and matches.
const requireAuthOrInternal = (req: any, res: any, next: any) => {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer internal-')) {
    const secret = process.env.CRON_SECRET || '';
    const rest = auth.slice('Bearer internal-'.length);
    const dot = rest.lastIndexOf('.');
    const given = dot > 0 ? rest.slice(0, dot) : '';
    const tenantId = dot > 0 ? rest.slice(dot + 1) : '';
    const ga = Buffer.from(given), sb = Buffer.from(secret);
    const ok = secret.length >= 16 && ga.length === sb.length && nodeCrypto.timingSafeEqual(ga, sb) && /^[0-9a-f-]{36}$/i.test(tenantId);
    if (!ok) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { tenantId, role: 'internal' };
    return next();
  }
  return requireAuth(req, res, next);
};`
if (a.includes('internal-<CRON_SECRET>')) console.log('already  dataIngestionRoutes.ts')
else if (!re.test(a)) { console.log('NO ANCHOR dataIngestionRoutes.ts'); failed = true }
else {
  a = a.replace(re, () => block)
  if (!a.includes('as nodeCrypto')) a = a.replace(/(import \{ requireAuth \} from '\.\.\/middleware\/auth';)/, "$1\nimport * as nodeCrypto from 'crypto';")
  fs.writeFileSync(f1, a, 'utf8'); console.log('patched  dataIngestionRoutes.ts')
}

// 2) calling side
const f2 = 'src/routes/autoIngestRoutes.ts'
let b = read(f2)
const oldTok = "'Bearer internal-' + tenantId", newTok = "'Bearer internal-' + process.env.CRON_SECRET + '.' + tenantId"
if (b.includes("internal-' + process.env.CRON_SECRET")) console.log('already  autoIngestRoutes.ts')
else if (!b.includes(oldTok)) { console.log('NO MATCH autoIngestRoutes.ts'); failed = true }
else { fs.writeFileSync(f2, b.split(oldTok).join(newTok), 'utf8'); console.log('patched  autoIngestRoutes.ts (' + (b.split(oldTok).length - 1) + ' call(s))') }
process.exitCode = failed ? 1 : 0
