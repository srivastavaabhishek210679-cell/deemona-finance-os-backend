import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodeCrypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { sendPasswordResetEmail } from '../services/emailService';

const JWT_SECRET = process.env.JWT_SECRET || 'deemona-secret';
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '7d';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// Proof of consent: when, which version, from which IP.
let consentReady: Promise<void> | null = null;
function ensureConsentColumns(pool: Pool): Promise<void> {
  if (!consentReady) {
    consentReady = pool.query(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS terms_version TEXT, ADD COLUMN IF NOT EXISTS terms_accepted_ip TEXT'
    ).then(() => undefined).catch((e) => { consentReady = null; throw e; });
  }
  return consentReady;
}
function clientIp(req: Request): string {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xf || req.ip || '').slice(0, 64);
}
function cleanVersion(v: any): string {
  return typeof v === 'string' && /^[0-9A-Za-z._-]{1,20}$/.test(v) ? v : 'unknown';
}
// ── Email verification before account creation ──
let verifyReady: Promise<void> | null = null;
function ensureVerifyTable(pool: Pool): Promise<void> {
  if (!verifyReady) {
    verifyReady = pool.query(`CREATE TABLE IF NOT EXISTS email_verifications (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      sent_count INT NOT NULL DEFAULT 1,
      window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).then(() => undefined).catch((e) => { verifyReady = null; throw e; });
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
function validEmail(e: string): boolean { return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }
async function sendVerificationEmail(to: string, code: string): Promise<void> {
  if (process.env.SMTP_HOST) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER || '';
    const tx = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, family: 4,
      secure: port === 465 || process.env.SMTP_SECURE === 'true',
      auth: user ? { user, pass: process.env.SMTP_PASS || '' } : undefined,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
    await tx.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || user,
      to, subject: 'Your Deemona verification code: ' + code,
      text: 'Your Deemona AI Finance OS verification code is ' + code + '. It expires in ' + CODE_MINUTES + ' minutes. If you did not request it, ignore this email.',
      html: '<div style="font-family:Arial,sans-serif;max-width:480px"><h2>Verify your email</h2><p>Use this code to finish creating your Deemona AI Finance OS account:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">' + code + '</p><p>It expires in ' + CODE_MINUTES + ' minutes. If you did not request it, ignore this email.</p></div>',
    });
    return;
  }
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
async function consumeEmailCode(pool: Pool, email: string, code: string, consume = true): Promise<string | null> {
  await ensureVerifyTable(pool);
  if (!/^\d{6}$/.test(code)) return 'Enter the 6-digit verification code sent to your email';
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
  if (consume) await pool.query('DELETE FROM email_verifications WHERE email = $1', [email]);
  return null;
}
const TERMS_REQUIRED_MSG = 'You must accept the Terms of Service, Privacy Policy and Acceptable Use Policy to create an account';

function generateToken(user: any, tenant: any): string {
  return jwt.sign(
    { id: user.id, tenantId: user.tenant_id, email: user.email,
      name: user.first_name + (user.last_name ? ' ' + user.last_name : ''),
      role: user.role, tenantName: tenant.name, tenantSlug: tenant.slug },
    JWT_SECRET, { expiresIn: JWT_EXPIRES } as any
  );
}

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 50) + '-' + Date.now().toString(36);
}

async function verifyGoogleToken(idToken: string): Promise<{ sub: string; email: string; name: string; picture: string; given_name: string; family_name: string } | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + idToken);
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (data.aud !== GOOGLE_CLIENT_ID) return null;
    if (data.email_verified !== 'true' && data.email_verified !== true) return null;
    return { sub: data.sub, email: data.email, name: data.name, picture: data.picture, given_name: data.given_name, family_name: data.family_name };
  } catch { return null; }
}

export function createAuthRouter(pool: Pool): Router {
  const router = Router();
  ensureConsentColumns(pool).catch((e) => console.error('[Auth] could not add consent columns:', e));

  // â”€â”€ POST /api/auth/register â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Returns success:true â€” client must redirect to login
  // ── POST /api/auth/register/send-code ── (no account is created here)
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
        `INSERT INTO email_verifications (email, code_hash, expires_at, attempts, sent_count, window_start, last_sent_at)
         VALUES ($1,$2, NOW() + ($3 || ' minutes')::interval, 0, $4, $5, NOW())
         ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0,
           sent_count = EXCLUDED.sent_count, window_start = EXCLUDED.window_start, last_sent_at = NOW()`,
        [email, hashCode(email, code), String(CODE_MINUTES), sentCount, windowStart]
      );
      await sendVerificationEmail(email, code);
      res.json({ success: true, message: 'Verification code sent', expires_in_minutes: CODE_MINUTES });
    } catch (err) {
      console.error('[Auth] send-code error:', err);
      res.status(502).json({ error: 'Could not send the verification email. Please try again shortly.' });
    }
  });

  // ── POST /api/auth/register/verify-code ── checks the emailed code (does not use it up; /register does)
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

  router.post('/register', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      await ensureConsentColumns(pool);
      if (req.body?.accepted_terms !== true) { res.status(400).json({ error: TERMS_REQUIRED_MSG }); return; }
      const codeErr = await consumeEmailCode(pool, String(req.body?.email || '').trim().toLowerCase(), String(req.body?.email_otp || ''));
      if (codeErr) { res.status(400).json({ error: codeErr }); return; }
      await client.query('BEGIN');
      const { company_name, industry, gstin, first_name, last_name, email, password, accepted_terms, terms_version } = req.body;
      if (!company_name || !email || !password || !first_name) {
        await client.query('ROLLBACK'); res.status(400).json({ error: 'company_name, first_name, email, and password are required' }); return;
      }
      if (password.length < 8) { await client.query('ROLLBACK'); res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }
      if (accepted_terms !== true) { await client.query('ROLLBACK'); res.status(400).json({ error: TERMS_REQUIRED_MSG }); return; }
      const existing = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (existing.rows.length) { await client.query('ROLLBACK'); res.status(409).json({ error: 'Email already registered. Please sign in.' }); return; }
      const slug = slugify(company_name);
      const tenant = await client.query(
        'INSERT INTO tenants (name, slug, industry, gstin) VALUES ($1,$2,$3,$4) RETURNING *',
        [company_name, slug, industry, gstin]
      );
      const hash = await bcrypt.hash(password, 12);
      await client.query(
        "INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, is_verified, terms_accepted_at, terms_version, terms_accepted_ip) VALUES ($1,$2,$3,$4,$5,'owner',TRUE,NOW(),$6,$7)",
        [tenant.rows[0].id, email.toLowerCase(), hash, first_name, last_name, cleanVersion(terms_version), clientIp(req)]
      );
      const defaultAccounts = [
        {code:'1000',name:'Cash and Cash Equivalents',type:'asset',sub:'current_asset'},
        {code:'1010',name:'Bank Account - Current',type:'asset',sub:'current_asset'},
        {code:'1100',name:'Accounts Receivable',type:'asset',sub:'current_asset'},
        {code:'1400',name:'GST Input Credit',type:'asset',sub:'current_asset'},
        {code:'2000',name:'Accounts Payable',type:'liability',sub:'current_liability'},
        {code:'2100',name:'GST Payable - CGST',type:'liability',sub:'current_liability'},
        {code:'2110',name:'GST Payable - SGST',type:'liability',sub:'current_liability'},
        {code:'2200',name:'TDS Payable',type:'liability',sub:'current_liability'},
        {code:'2300',name:'Salary Payable',type:'liability',sub:'current_liability'},
        {code:'3000',name:'Share Capital',type:'equity',sub:'equity'},
        {code:'3100',name:'Retained Earnings',type:'equity',sub:'equity'},
        {code:'4000',name:'Sales Revenue',type:'income',sub:'operating_income'},
        {code:'4100',name:'Service Revenue',type:'income',sub:'operating_income'},
        {code:'5000',name:'Cost of Goods Sold',type:'expense',sub:'cogs'},
        {code:'5100',name:'Salaries and Wages',type:'expense',sub:'operating_expense'},
        {code:'5200',name:'Rent Expense',type:'expense',sub:'operating_expense'},
        {code:'5300',name:'Utilities',type:'expense',sub:'operating_expense'},
        {code:'5400',name:'Marketing and Advertising',type:'expense',sub:'operating_expense'},
        {code:'5900',name:'Miscellaneous Expenses',type:'expense',sub:'operating_expense'},
      ];
      for (const acc of defaultAccounts) {
        await client.query('INSERT INTO accounts (tenant_id, code, name, type, sub_type) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [tenant.rows[0].id, acc.code, acc.name, acc.type, acc.sub]);
      }
      await client.query('COMMIT');
      // Return success only â€” client redirects to login
      res.status(201).json({ success: true, message: 'Account created successfully. Please sign in.' });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  // â”€â”€ POST /api/auth/login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) { res.status(400).json({ error: 'Email and password required' }); return; }
      const result = await pool.query(
        'SELECT u.*, t.name as tenant_name, t.slug as tenant_slug, t.industry, t.currency FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = $1 AND u.is_active = TRUE',
        [email.toLowerCase()]
      );
      if (!result.rows.length) { res.status(401).json({ error: 'Invalid email or password' }); return; }
      const user = result.rows[0];
      if (!user.password_hash) { res.status(401).json({ error: 'This account uses Google Sign-In. Please use the Google button.' }); return; }
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) { res.status(401).json({ error: 'Invalid email or password' }); return; }
      await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
      const token = generateToken(user, { name: user.tenant_name, slug: user.tenant_slug });
      res.json({ token, user: { id: user.id, email: user.email, name: user.first_name + (user.last_name ? ' ' + user.last_name : ''), role: user.role, avatar_url: user.avatar_url }, tenant: { id: user.tenant_id, name: user.tenant_name, slug: user.tenant_slug, industry: user.industry, currency: user.currency } });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // â”€â”€ POST /api/auth/google â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Handles Google OAuth â€” signs in existing users or creates new ones
  router.post('/google', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const { id_token, company_name, industry, accepted_terms, terms_version } = req.body;
      if (!id_token) { res.status(400).json({ error: 'id_token is required' }); return; }

      const google = await verifyGoogleToken(id_token);
      if (!google) { res.status(401).json({ error: 'Invalid Google token' }); return; }

      await ensureConsentColumns(pool);
      await client.query('BEGIN');

      // Check if user already exists
      const existing = await client.query(
        'SELECT u.*, t.name as tenant_name, t.slug as tenant_slug, t.industry, t.currency FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.google_id = $1 OR u.email = $2',
        [google.sub, google.email]
      );

      if (existing.rows.length) {
        // Existing user â€” update google_id if not set
        const user = existing.rows[0];
        if (!user.google_id) {
          await client.query('UPDATE users SET google_id = $1, avatar_url = $2, updated_at = NOW() WHERE id = $3',
            [google.sub, google.picture, user.id]);
        }
        await client.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
        await client.query('COMMIT');
        const token = generateToken(user, { name: user.tenant_name, slug: user.tenant_slug });
        res.json({ token, user: { id: user.id, email: user.email, name: user.first_name + (user.last_name ? ' ' + user.last_name : ''), role: user.role, avatar_url: google.picture }, tenant: { id: user.tenant_id, name: user.tenant_name, slug: user.tenant_slug }, isNew: false });
        return;
      }

      // New user â€” need company_name to create tenant
      if (!company_name) {
        await client.query('ROLLBACK');
        res.status(202).json({ needsCompany: true, email: google.email, name: google.name, given_name: google.given_name, family_name: google.family_name, picture: google.picture, google_sub: google.sub });
        return;
      }

      if (accepted_terms !== true) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: TERMS_REQUIRED_MSG }); return;
      }

      // Create tenant + user
      const slug = slugify(company_name);
      const tenant = await client.query('INSERT INTO tenants (name, slug, industry) VALUES ($1,$2,$3) RETURNING *', [company_name, slug, industry || 'Technology']);
      const user = await client.query(
        "INSERT INTO users (tenant_id, email, google_id, first_name, last_name, avatar_url, role, is_verified, terms_accepted_at, terms_version, terms_accepted_ip) VALUES ($1,$2,$3,$4,$5,$6,'owner',TRUE,NOW(),$7,$8) RETURNING *",
        [tenant.rows[0].id, google.email, google.sub, google.given_name || google.name, google.family_name || '', google.picture, cleanVersion(terms_version), clientIp(req)]
      );
      const defaultAccounts = [
        {code:'1000',name:'Cash and Cash Equivalents',type:'asset',sub:'current_asset'},
        {code:'1010',name:'Bank Account - Current',type:'asset',sub:'current_asset'},
        {code:'1100',name:'Accounts Receivable',type:'asset',sub:'current_asset'},
        {code:'2000',name:'Accounts Payable',type:'liability',sub:'current_liability'},
        {code:'2300',name:'Salary Payable',type:'liability',sub:'current_liability'},
        {code:'3000',name:'Share Capital',type:'equity',sub:'equity'},
        {code:'4000',name:'Sales Revenue',type:'income',sub:'operating_income'},
        {code:'5100',name:'Salaries and Wages',type:'expense',sub:'operating_expense'},
        {code:'5200',name:'Rent Expense',type:'expense',sub:'operating_expense'},
        {code:'5900',name:'Miscellaneous Expenses',type:'expense',sub:'operating_expense'},
      ];
      for (const acc of defaultAccounts) {
        await client.query('INSERT INTO accounts (tenant_id, code, name, type, sub_type) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [tenant.rows[0].id, acc.code, acc.name, acc.type, acc.sub]);
      }
      await client.query('COMMIT');
      const token = generateToken(user.rows[0], tenant.rows[0]);
      res.status(201).json({ token, user: { id: user.rows[0].id, email: user.rows[0].email, name: google.given_name + (google.family_name ? ' ' + google.family_name : ''), role: 'owner', avatar_url: google.picture }, tenant: { id: tenant.rows[0].id, name: tenant.rows[0].name, slug: tenant.rows[0].slug }, isNew: true });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

  // â”€â”€ GET /api/auth/me â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  router.get('/me', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.last_login, u.avatar_url, t.id as tenant_id, t.name as tenant_name, t.slug, t.industry, t.currency, t.gstin, t.plan FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1',
        [(req as any).user.id]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'User not found' }); return; }
      const u = result.rows[0];
      res.json({ user: { id: u.id, email: u.email, name: u.first_name + (u.last_name ? ' ' + u.last_name : ''), role: u.role, lastLogin: u.last_login, avatar_url: u.avatar_url }, tenant: { id: u.tenant_id, name: u.tenant_name, slug: u.slug, industry: u.industry, currency: u.currency, gstin: u.gstin, plan: u.plan } });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/logout', requireAuth, (_req: Request, res: Response) => { res.json({ success: true }); });

  router.get('/users', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT id, email, first_name, last_name, role, is_active, last_login, avatar_url, created_at FROM users WHERE tenant_id = $1 ORDER BY created_at', [(req as any).user.tenantId]);
      res.json({ users: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/invite-user', requireAuth, async (req: Request, res: Response) => {
    try {
      const { email, first_name, last_name, role, temp_password } = req.body;
      if (!email || !first_name || !temp_password) { res.status(400).json({ error: 'email, first_name, and temp_password required' }); return; }
      const hash = await bcrypt.hash(temp_password, 12);
      const result = await pool.query(
        "INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, is_verified) VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING id, email, role",
        [(req as any).user.tenantId, email.toLowerCase(), hash, first_name, last_name, role || 'member']
      );
      res.status(201).json({ user: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });


  router.post('/forgot-password', async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) { res.status(400).json({ error: 'Email is required' }); return; }
      const user = await pool.query('SELECT u.*, t.name as tenant_name FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = $1 AND u.is_active = TRUE', [email.toLowerCase()]);
      if (!user.rows.length) { res.json({ success: true, message: 'If that email exists, an OTP has been sent.' }); return; }
      const u = user.rows[0];
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const crypto = require('crypto');
      const tokenHash = crypto.createHash('sha256').update(otp + u.id + Date.now()).digest('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [u.id]);
      await pool.query('INSERT INTO password_reset_tokens (user_id, token_hash, otp, expires_at) VALUES ($1,$2,$3,$4)', [u.id, tokenHash, otp, expiresAt]);
      await sendPasswordResetEmail(u.email, u.first_name, otp, 15);
      res.json({ success: true, message: 'If that email exists, an OTP has been sent.', token_hash: tokenHash });
    } catch (err) { console.error('[Auth] forgot-password error:', err); res.status(500).json({ error: String(err) }); }
  });

  router.post('/verify-otp', async (req, res) => {
    try {
      const { token_hash, otp } = req.body;
      if (!token_hash || !otp) { res.status(400).json({ error: 'token_hash and otp are required' }); return; }
      const result = await pool.query('SELECT * FROM password_reset_tokens WHERE token_hash = $1 AND otp = $2 AND used_at IS NULL AND expires_at > NOW()', [token_hash, otp]);
      if (!result.rows.length) { res.status(400).json({ error: 'Invalid or expired OTP. Please request a new one.' }); return; }
      res.json({ valid: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/reset-password', async (req, res) => {
    try {
      const { token_hash, otp, new_password } = req.body;
      if (!token_hash || !otp || !new_password) { res.status(400).json({ error: 'token_hash, otp, and new_password are required' }); return; }
      if (new_password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query('SELECT prt.*, u.email, u.first_name FROM password_reset_tokens prt JOIN users u ON u.id = prt.user_id WHERE prt.token_hash = $1 AND prt.otp = $2 AND prt.used_at IS NULL AND prt.expires_at > NOW()', [token_hash, otp]);
        if (!result.rows.length) { res.status(400).json({ error: 'Invalid or expired OTP. Please request a new one.' }); return; }
        const token = result.rows[0];
        const hash = await bcrypt.hash(new_password, 12);
        await client.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, token.user_id]);
        await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [token.id]);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Password reset successfully. Please sign in.' });
      } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  return router;
}

