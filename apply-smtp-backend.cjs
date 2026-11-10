// Adds SMTP email (your MilesWeb mailbox). Switched on by SMTP_HOST; without it everything keeps using Resend. Idempotent.
// Run from the backend folder.
const fs = require('fs'); const path = require('path');

const MAILER = String.raw`// Email sender. If SMTP_HOST is set, mail goes out through your own mailbox (SMTP). Otherwise Resend is used, as before.
import nodemailer from 'nodemailer';

export const smtpEnabled = (): boolean => !!process.env.SMTP_HOST;

let transport: any = null;
function getTransport(): any {
  if (transport) return transport;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = (process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
  return transport;
}

const nameOf = (s: string): string => { const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(s || ''); return m ? m[1].trim() : ''; };

// The sender address must be the mailbox you log in with (or one it is allowed to send as).
function fromAddress(): string {
  const f = process.env.FROM_EMAIL || '';
  return process.env.SMTP_FROM_EMAIL || (f && !/resend\.dev$/i.test(f) ? f : '') || process.env.SMTP_USER || '';
}

export async function sendMail(m: { from?: string; to: string | string[]; subject: string; html?: string; text?: string }): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const address = fromAddress();
    if (!address) return { ok: false, error: 'No sender address: set FROM_EMAIL (or SMTP_USER) to your mailbox' };
    const name = nameOf(m.from || '') || process.env.FROM_NAME || 'Deemona Finance OS';
    const info = await getTransport().sendMail({ from: { name, address }, to: m.to, subject: m.subject, html: m.html, text: m.text || (m.html ? undefined : '') });
    return { ok: true, id: String(info.messageId || 'smtp') };
  } catch (e: any) {
    console.error('[mailer] SMTP send failed:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// Drop-in replacement for the Resend client: same calls, goes through SMTP when it is configured.
export class Resend {
  emails: { send: (p: any) => Promise<{ data: any; error: any }> };
  constructor(private key?: string) {
    this.emails = {
      send: async (p: any) => {
        if (smtpEnabled()) {
          const r = await sendMail({ from: p.from, to: p.to, subject: p.subject, html: p.html, text: p.text });
          return r.ok ? { data: { id: r.id }, error: null } : { data: null, error: { message: r.error } };
        }
        const { Resend: Real } = require('resend');
        return new Real(this.key).emails.send(p);
      },
    };
  }
}

// Drop-in for fetch('https://api.resend.com/emails', ...): same request and the same {id} / {message} answer.
export async function mailFetch(url: string, init?: any): Promise<Response> {
  if (smtpEnabled() && url === 'https://api.resend.com/emails') {
    let p: any = {};
    try { p = JSON.parse(String(init?.body || '{}')); } catch { /* ignore */ }
    const r = await sendMail({ from: p.from, to: p.to, subject: p.subject || '', html: p.html, text: p.text });
    return new Response(JSON.stringify(r.ok ? { id: r.id } : { message: r.error }), { status: r.ok ? 200 : 502, headers: { 'Content-Type': 'application/json' } });
  }
  return fetch(url, init);
}
`;
const SMTPMODE = "// If email goes out by SMTP, make the existing 'is email configured?' checks pass.\nif (process.env.SMTP_HOST && !process.env.RESEND_API_KEY) process.env.RESEND_API_KEY = 'smtp-mode';\n";

function read(p) { let s = fs.readFileSync(p, 'utf8'); const bom = s.charCodeAt(0) === 0xFEFF; if (bom) s = s.slice(1); const crlf = s.includes('\r\n'); if (crlf) s = s.replace(/\r\n/g, '\n'); return { s, bom, crlf }; }
function write(p, o, s) { fs.writeFileSync(p, (o.bom ? '﻿' : '') + (o.crlf ? s.replace(/\n/g, '\r\n') : s)); console.log('patched', p); }
function patch(p, fn) { if (!fs.existsSync(p)) { console.log('MISSING', p); process.exitCode = 1; return; } const o = read(p); const t = fn(o.s); if (t !== o.s) write(p, o, t); else console.log('no change', p); }

// new files
for (const [p, c] of [['src/services/mailer.ts', MAILER], ['src/smtpMode.ts', SMTPMODE]]) {
  if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== c) { fs.writeFileSync(p, c); console.log('wrote', p); } else console.log('up to date', p);
}
// index.ts: load smtpMode right after dotenv, and use the shim for the dynamic Resend import
patch('src/index.ts', s => {
  if (!s.includes("import './smtpMode';")) {
    if (!s.startsWith("import 'dotenv/config';")) { console.log("index.ts must start with import 'dotenv/config'; (apply apply-dotenv-first-backend.cjs first)"); process.exit(1); }
    s = s.replace(/^(import 'dotenv\/config';[^\n]*\n)/, (m) => m + "import './smtpMode';\n");
  }
  return s.split("await import('resend')").join("await import('./services/mailer')");
});
// files that import the Resend class
for (const f of ['src/jobs/scheduledReports.ts', 'src/routes/phase1Routes.ts', 'src/routes/eventBusRoutes.ts', 'src/routes/driveMonitorRoutes.ts', 'src/routes/autoIngestRoutes.ts', 'src/routes/dashboardRoutes.ts'])
  patch(f, s => s.split("from 'resend'").join("from '../services/mailer'").split("await import('resend')").join("await import('../services/mailer')"));
// files that call the Resend web API with fetch
for (const [f, rel] of [['src/services/automationEngine.ts', './mailer'], ['src/services/driveMonitorMultiTenant.ts', './mailer'], ['src/services/emailService.ts', './mailer'], ['src/services/driveMonitor.ts', './mailer'], ['src/routes/automationTestRoutes.ts', '../services/mailer']])
  patch(f, s => {
    if (!s.includes("fetch('https://api.resend.com/emails'")) return s;
    s = s.split("fetch('https://api.resend.com/emails'").join("mailFetch('https://api.resend.com/emails'");
    return "import { mailFetch } from '" + rel + "';\n" + s;
  });
