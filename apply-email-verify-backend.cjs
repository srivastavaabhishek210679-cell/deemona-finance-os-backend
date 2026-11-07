// Run from the backend folder AFTER apply-consent-backend.cjs:  node apply-email-verify-backend.cjs
// Adds: POST /api/auth/register/send-code (6-digit email code, rate-limited) and makes POST /register require a valid code.
// Also makes Google sign-in require a verified Google email. Safe to run twice.
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
if (t.includes('consumeEmailCode')) { console.log('already patched'); process.exit(0); }
if (!t.includes('ensureConsentColumns')) { console.log('Run apply-consent-backend.cjs first.'); process.exit(1); }
let ok = true;
function rep(label, find, replace) {
  const i = t.indexOf(find);
  if (i < 0) { console.log('NO MATCH: ' + label); ok = false; return; }
  t = t.slice(0, i) + replace + t.slice(i + find.length);
  console.log('patched: ' + label);
}

rep('import crypto', "import jwt from 'jsonwebtoken';\n", "import jwt from 'jsonwebtoken';\nimport nodeCrypto from 'crypto';\n");

rep('google: require verified email', "    if (data.aud !== GOOGLE_CLIENT_ID) return null;\n", "    if (data.aud !== GOOGLE_CLIENT_ID) return null;\n    if (data.email_verified !== 'true' && data.email_verified !== true) return null;\n");

rep('verification helpers', "const TERMS_REQUIRED_MSG =",
`// ── Email verification before account creation ──
let verifyReady: Promise<void> | null = null;
function ensureVerifyTable(pool: Pool): Promise<void> {
  if (!verifyReady) {
    verifyReady = pool.query(\`CREATE TABLE IF NOT EXISTS email_verifications (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      sent_count INT NOT NULL DEFAULT 1,
      window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )\`).then(() => undefined).catch((e) => { verifyReady = null; throw e; });
  }
  return verifyReady;
}
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 60;
const MAX_CODES_PER_HOUR = 5;
const ipHits = new Map<string, { n: number; reset: number }>();
function ipAllowed(ip: string): boolean {
  const now = Date.now();
  const h = ipHits.get(ip);
  if (!h || h.reset < now) { ipHits.set(ip, { n: 1, reset: now + 3600000 }); return true; }
  h.n++; return h.n <= 12;
}
function hashCode(email: string, code: string): string {
  return nodeCrypto.createHash('sha256').update(email + '|' + code + '|' + JWT_SECRET).digest('hex');
}
function validEmail(e: string): boolean { return e.length <= 254 && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(e); }
async function sendVerificationEmail(to: string, code: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') throw new Error('Email service is not configured');
    console.log('[Auth] DEV verification code for ' + to + ': ' + code); return;
  }
  const from = process.env.EMAIL_FROM || 'Deemona AI Finance OS <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [to], subject: 'Your Deemona verification code: ' + code,
      html: '<div style="font-family:Arial,sans-serif;max-width:480px"><h2>Verify your email</h2><p>Use this code to finish creating your Deemona AI Finance OS account:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">' + code + '</p><p>It expires in ' + CODE_MINUTES + ' minutes. If you did not request it, ignore this email.</p></div>',
    }),
  });
  if (!r.ok) throw new Error('Could not send the verification email');
}
// Checks and consumes the code. Wrong guesses are counted (and persisted) so codes cannot be brute-forced.
async function consumeEmailCode(pool: Pool, email: string, code: string): Promise<string | null> {
  await ensureVerifyTable(pool);
  if (!/^\\d{6}$/.test(code)) return 'Enter the 6-digit verification code sent to your email';
  const r = await pool.query('SELECT * FROM email_verifications WHERE email = $1', [email]);
  const row = r.rows[0];
  if (!row) return 'Please request a verification code first';
  if (new Date(row.expires_at).getTime() < Date.now()) return 'The code has expired. Please request a new one';
  if (row.attempts >= MAX_ATTEMPTS) return 'Too many wrong attempts. Please request a new code';
  const given = Buffer.from(hashCode(email, code));
  const want = Buffer.from(row.code_hash);
  const same = given.length === want.length && nodeCrypto.timingSafeEqual(given, want);
  if (!same) {
    await pool.query('UPDATE email_verifications SET attempts = attempts + 1 WHERE email = $1', [email]);
    return 'Incorrect code';
  }
  await pool.query('DELETE FROM email_verifications WHERE email = $1', [email]);
  return null;
}
const TERMS_REQUIRED_MSG =`);

rep('send-code route', "  router.post('/register', async (req: Request, res: Response) => {",
`  // ── POST /api/auth/register/send-code ── (no account is created here)
  router.post('/register/send-code', async (req: Request, res: Response) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (req.body?.website) { res.json({ success: true }); return; } // honeypot field: bots fill it, people never see it
      if (!validEmail(email)) { res.status(400).json({ error: 'Enter a valid email address' }); return; }
      if (!ipAllowed(clientIp(req))) { res.status(429).json({ error: 'Too many requests. Please try again later' }); return; }
      await ensureVerifyTable(pool);
      const exists = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (exists.rows.length) { res.status(409).json({ error: 'Email already registered. Please sign in.' }); return; }
      const prev = (await pool.query('SELECT * FROM email_verifications WHERE email = $1', [email])).rows[0];
      let sentCount = 1; let windowStart = new Date();
      if (prev) {
        const sinceLast = (Date.now() - new Date(prev.last_sent_at).getTime()) / 1000;
        if (sinceLast < RESEND_COOLDOWN_SEC) { res.status(429).json({ error: 'Please wait ' + Math.ceil(RESEND_COOLDOWN_SEC - sinceLast) + ' seconds before requesting another code' }); return; }
        const inWindow = Date.now() - new Date(prev.window_start).getTime() < 3600000;
        if (inWindow) { if (prev.sent_count >= MAX_CODES_PER_HOUR) { res.status(429).json({ error: 'Too many codes requested. Please try again in an hour' }); return; } sentCount = prev.sent_count + 1; windowStart = new Date(prev.window_start); }
      }
      const code = String(nodeCrypto.randomInt(100000, 1000000));
      await pool.query(
        \`INSERT INTO email_verifications (email, code_hash, expires_at, attempts, sent_count, window_start, last_sent_at)
         VALUES ($1,$2, NOW() + ($3 || ' minutes')::interval, 0, $4, $5, NOW())
         ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0,
           sent_count = EXCLUDED.sent_count, window_start = EXCLUDED.window_start, last_sent_at = NOW()\`,
        [email, hashCode(email, code), String(CODE_MINUTES), sentCount, windowStart]
      );
      await sendVerificationEmail(email, code);
      res.json({ success: true, message: 'Verification code sent', expires_in_minutes: CODE_MINUTES });
    } catch (err) {
      console.error('[Auth] send-code error:', err);
      res.status(502).json({ error: 'Could not send the verification email. Please try again shortly.' });
    }
  });

  router.post('/register', async (req: Request, res: Response) => {`);

rep('register: require code',
"      await ensureConsentColumns(pool);\n      await client.query('BEGIN');\n      const { company_name, industry, gstin, first_name, last_name, email, password, accepted_terms, terms_version } = req.body;\n",
"      await ensureConsentColumns(pool);\n      if (req.body?.accepted_terms !== true) { res.status(400).json({ error: TERMS_REQUIRED_MSG }); return; }\n      const codeErr = await consumeEmailCode(pool, String(req.body?.email || '').trim().toLowerCase(), String(req.body?.email_otp || ''));\n      if (codeErr) { res.status(400).json({ error: codeErr }); return; }\n      await client.query('BEGIN');\n      const { company_name, industry, gstin, first_name, last_name, email, password, accepted_terms, terms_version } = req.body;\n");

if (!ok) { console.log('\nNothing written (a patch did not match). Send me the output above.'); process.exit(1); }
fs.writeFileSync(file, (bom ? '﻿' : '') + (crlf ? t.replace(/\n/g, '\r\n') : t));
console.log('\nDone: ' + file);
