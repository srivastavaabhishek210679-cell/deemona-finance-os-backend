// Run from the backend folder AFTER the earlier backend scripts:  node apply-verify-first-backend.cjs
// Adds POST /api/auth/register/verify-code (checks the code without using it up, so the email can be verified BEFORE the details form). Safe to run twice.
const fs = require('fs'), path = require('path');
function find(name) {
  const st = [path.join(process.cwd(), 'src')];
  while (st.length) { const d = st.pop(); let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') st.push(p); } else if (e.name === name) return p; } }
  return null;
}
const file = find('authRoutes.ts');
if (!file) { console.log('MISSING authRoutes.ts (run from the backend folder)'); process.exit(1); }
let raw = fs.readFileSync(file, 'utf8');
const bom = raw.charCodeAt(0) === 0xFEFF; if (bom) raw = raw.slice(1);
const crlf = raw.includes('\r\n');
let t = crlf ? raw.replace(/\r\n/g, '\n') : raw;
if (t.includes('/register/verify-code')) { console.log('already patched'); process.exit(0); }
if (!t.includes('consumeEmailCode')) { console.log('Run apply-email-verify-backend.cjs first.'); process.exit(1); }
let ok = true;
function rep(label, find, replace) {
  const i = t.indexOf(find);
  if (i < 0) { console.log('NO MATCH: ' + label); ok = false; return; }
  t = t.slice(0, i) + replace + t.slice(i + find.length);
  console.log('patched: ' + label);
}
rep('consume flag', "async function consumeEmailCode(pool: Pool, email: string, code: string): Promise<string | null> {", "async function consumeEmailCode(pool: Pool, email: string, code: string, consume = true): Promise<string | null> {");
rep('keep code when only checking', "  await pool.query('DELETE FROM email_verifications WHERE email = $1', [email]);\n  return null;", "  if (consume) await pool.query('DELETE FROM email_verifications WHERE email = $1', [email]);\n  return null;");
rep('verify-code route', "  router.post('/register', async (req: Request, res: Response) => {",
`  // ── POST /api/auth/register/verify-code ── checks the emailed code (does not use it up; /register does)
  router.post('/register/verify-code', async (req: Request, res: Response) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!validEmail(email)) { res.status(400).json({ error: 'Enter a valid email address' }); return; }
      const err = await consumeEmailCode(pool, email, String(req.body?.email_otp || ''), false);
      if (err) { res.status(400).json({ error: err }); return; }
      res.json({ success: true, verified: true });
    } catch (e) {
      console.error('[Auth] verify-code error:', e);
      res.status(500).json({ error: 'Could not verify the code. Please try again.' });
    }
  });

  router.post('/register', async (req: Request, res: Response) => {`);
if (!ok) { console.log('\nNothing written (a patch did not match). Send me the output above.'); process.exit(1); }
fs.writeFileSync(file, (bom ? '﻿' : '') + (crlf ? t.replace(/\n/g, '\r\n') : t));
console.log('\nDone: ' + file);
