// Closes the "Bearer internal-<tenantId>" hole. Run from C:\deemona-finance-os\backend :  node secure-cron-auth.cjs
// After this, internal cron calls must send  Bearer internal-<CRON_SECRET>.<tenantId>  and CRON_SECRET must be set on Render.
const fs = require('fs')
let failed = false

// 1) phase1Routes.ts: verify the secret before trusting the tenant id
const f1 = 'src/routes/phase1Routes.ts'
let a = fs.readFileSync(f1, 'utf8'); if (a.charCodeAt(0) === 0xfeff) a = a.slice(1)
const re = /\/\/ Allow internal cron calls[^\n]*\r?\nconst requireAuthOrInternal = [\s\S]*?\r?\n\};/
const replacement = `// Internal cron calls send "Bearer internal-<CRON_SECRET>.<tenantId>". Rejected unless CRON_SECRET is set (>=16 chars) and matches.
const requireAuthOrInternal = (req: any, res: any, next: any) => {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer internal-')) {
    const secret = process.env.CRON_SECRET || '';
    const rest = auth.slice('Bearer internal-'.length);
    const dot = rest.lastIndexOf('.');
    const given = dot > 0 ? rest.slice(0, dot) : '';
    const tenantId = dot > 0 ? rest.slice(dot + 1) : '';
    const ga = Buffer.from(given), sb = Buffer.from(secret);
    const ok = secret.length >= 16 && ga.length === sb.length && crypto.timingSafeEqual(ga, sb) && /^[0-9a-f-]{36}$/i.test(tenantId);
    if (!ok) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { tenantId, role: 'internal' };
    return next();
  }
  return requireAuth(req, res, next);
};`
if (a.includes('internal-<CRON_SECRET>')) console.log('already  phase1Routes.ts')
else if (!re.test(a)) { console.log('NO ANCHOR phase1Routes.ts - send me lines 8-25 of that file'); failed = true }
else { fs.writeFileSync(f1, a.replace(re, () => replacement), 'utf8'); console.log('patched  phase1Routes.ts') }

// 2) index.ts: the 4 cron jobs must send the secret too
const f2 = 'src/index.ts'
let b = fs.readFileSync(f2, 'utf8'); if (b.charCodeAt(0) === 0xfeff) b = b.slice(1)
const oldTok = "'Bearer internal-'+row.tenant_id", newTok = "'Bearer internal-'+process.env.CRON_SECRET+'.'+row.tenant_id"
const n = b.split(oldTok).length - 1
if (n) { fs.writeFileSync(f2, b.split(oldTok).join(newTok), 'utf8'); console.log('patched  index.ts (' + n + ' cron call(s))') }
else console.log(b.includes('internal-\'+process.env.CRON_SECRET') ? 'already  index.ts' : 'NO MATCH  index.ts - run: Select-String -Path src\\index.ts -Pattern "Bearer internal"')
const left = (fs.readFileSync(f2, 'utf8').match(/Bearer internal-['"`]\s*\+\s*row\.tenant_id/g) || []).length
if (left) { console.log('WARNING ' + left + ' call(s) still use the old format'); failed = true }
process.exitCode = failed ? 1 : 0
