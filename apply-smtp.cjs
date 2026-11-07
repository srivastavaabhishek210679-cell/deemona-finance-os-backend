// Run from the backend folder AFTER apply-email-verify-backend.cjs:  node apply-smtp.cjs
// Sends the verification email through SMTP when SMTP_HOST is set (otherwise Resend, as before). Safe to run twice.
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
if (t.includes('SMTP_HOST')) { console.log('already patched'); process.exit(0); }
if (!t.includes('sendVerificationEmail')) { console.log('Run apply-email-verify-backend.cjs first.'); process.exit(1); }
const find1 = "async function sendVerificationEmail(to: string, code: string): Promise<void> {\n  const key = process.env.RESEND_API_KEY;\n";
const i = t.indexOf(find1);
if (i < 0) { console.log('NO MATCH: sendVerificationEmail'); process.exit(1); }
const add = `async function sendVerificationEmail(to: string, code: string): Promise<void> {
  if (process.env.SMTP_HOST) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER || '';
    const tx = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port,
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
`;
t = t.slice(0, i) + add + t.slice(i + find1.length);
fs.writeFileSync(file, (bom ? '﻿' : '') + (crlf ? t.replace(/\n/g, '\r\n') : t));
console.log('patched: SMTP sending\nDone: ' + file + '\nNow run: npm install nodemailer');
