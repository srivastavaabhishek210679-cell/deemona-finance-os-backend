// Run from the backend folder:  node apply-consent-backend.cjs
// Server-side enforcement of terms acceptance + proof of consent (users.terms_accepted_at / terms_version / terms_accepted_ip).
// Also fixes early returns in /register that left a database transaction open. Safe to run twice.
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
if (t.includes('ensureConsentColumns')) { console.log('already patched'); process.exit(0); }
let ok = true;
function rep(label, find, replace) {
  const i = t.indexOf(find);
  if (i < 0) { console.log('NO MATCH: ' + label); ok = false; return; }
  t = t.slice(0, i) + replace + t.slice(i + find.length);
  console.log('patched: ' + label);
}

rep('helpers', "const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';\n",
`const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

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
const TERMS_REQUIRED_MSG = 'You must accept the Terms of Service, Privacy Policy and Acceptable Use Policy to create an account';
`);

rep('create columns at startup', "  const router = Router();\n", "  const router = Router();\n  ensureConsentColumns(pool).catch((e) => console.error('[Auth] could not add consent columns:', e));\n");

// /register
rep('register: read + ensure columns', "      await client.query('BEGIN');\n      const { company_name, industry, gstin, first_name, last_name, email, password } = req.body;\n",
"      await ensureConsentColumns(pool);\n      await client.query('BEGIN');\n      const { company_name, industry, gstin, first_name, last_name, email, password, accepted_terms, terms_version } = req.body;\n");
rep('register: rollback on missing fields', "res.status(400).json({ error: 'company_name, first_name, email, and password are required' }); return;", "await client.query('ROLLBACK'); res.status(400).json({ error: 'company_name, first_name, email, and password are required' }); return;");
rep('register: rollback + require consent', "if (password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }",
"if (password.length < 8) { await client.query('ROLLBACK'); res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }\n      if (accepted_terms !== true) { await client.query('ROLLBACK'); res.status(400).json({ error: TERMS_REQUIRED_MSG }); return; }");
rep('register: rollback on duplicate', "if (existing.rows.length) { res.status(409).json({ error: 'Email already registered. Please sign in.' }); return; }", "if (existing.rows.length) { await client.query('ROLLBACK'); res.status(409).json({ error: 'Email already registered. Please sign in.' }); return; }");
rep('register: store consent',
"\"INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, is_verified) VALUES ($1,$2,$3,$4,$5,'owner',TRUE)\",\n        [tenant.rows[0].id, email.toLowerCase(), hash, first_name, last_name]",
"\"INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, is_verified, terms_accepted_at, terms_version, terms_accepted_ip) VALUES ($1,$2,$3,$4,$5,'owner',TRUE,NOW(),$6,$7)\",\n        [tenant.rows[0].id, email.toLowerCase(), hash, first_name, last_name, cleanVersion(terms_version), clientIp(req)]");

// /google
rep('google: read body', "const { id_token, company_name, industry } = req.body;", "const { id_token, company_name, industry, accepted_terms, terms_version } = req.body;");
rep('google: ensure columns', "      await client.query('BEGIN');\n\n      // Check if user already exists", "      await ensureConsentColumns(pool);\n      await client.query('BEGIN');\n\n      // Check if user already exists");
rep('google: require consent for new accounts', "      // Create tenant + user\n", "      if (accepted_terms !== true) {\n        await client.query('ROLLBACK');\n        res.status(400).json({ error: TERMS_REQUIRED_MSG }); return;\n      }\n\n      // Create tenant + user\n");
rep('google: store consent',
"\"INSERT INTO users (tenant_id, email, google_id, first_name, last_name, avatar_url, role, is_verified) VALUES ($1,$2,$3,$4,$5,$6,'owner',TRUE) RETURNING *\",\n        [tenant.rows[0].id, google.email, google.sub, google.given_name || google.name, google.family_name || '', google.picture]",
"\"INSERT INTO users (tenant_id, email, google_id, first_name, last_name, avatar_url, role, is_verified, terms_accepted_at, terms_version, terms_accepted_ip) VALUES ($1,$2,$3,$4,$5,$6,'owner',TRUE,NOW(),$7,$8) RETURNING *\",\n        [tenant.rows[0].id, google.email, google.sub, google.given_name || google.name, google.family_name || '', google.picture, cleanVersion(terms_version), clientIp(req)]");

if (!ok) { console.log('\nNothing written (a patch did not match). Send me the output above.'); process.exit(1); }
fs.writeFileSync(file, (bom ? '﻿' : '') + (crlf ? t.replace(/\n/g, '\r\n') : t));
console.log('\nDone: ' + file);
