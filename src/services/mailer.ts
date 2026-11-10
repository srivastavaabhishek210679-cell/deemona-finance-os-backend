// Email sender. If SMTP_HOST is set, mail goes out through your own mailbox (SMTP). Otherwise Resend is used, as before.
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

export async function sendMail(m: { from?: string; to: string | string[]; subject: string; html?: string; text?: string; replyTo?: string }): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const address = fromAddress();
    if (!address) return { ok: false, error: 'No sender address: set FROM_EMAIL (or SMTP_USER) to your mailbox' };
    const name = nameOf(m.from || '') || process.env.FROM_NAME || 'Deemona Finance OS';
    const info = await getTransport().sendMail({ from: { name, address }, to: m.to, subject: m.subject, html: m.html, text: m.text || (m.html ? undefined : ''), replyTo: m.replyTo });
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
          const r = await sendMail({ from: p.from, to: p.to, subject: p.subject, html: p.html, text: p.text, replyTo: p.replyTo || p.reply_to });
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
