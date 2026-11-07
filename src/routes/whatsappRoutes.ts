import { handleWhatsAppApprovalReply } from '../services/automationEngine';
﻿import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

async function sendWA(to: string, message: string) {
  console.log('[WhatsApp] Sending to:', to, '| From:', TWILIO_FROM, '| SID configured:', !!TWILIO_SID);
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    return { success: false, error: 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN not set in environment variables' };
  }
  const toNum = to.startsWith('whatsapp:') ? to : `whatsapp:+91${to.replace(/\D/g,'').slice(-10)}`;
  try {
    const body = new URLSearchParams({ From: TWILIO_FROM, To: toNum, Body: message });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const data = await res.json() as any;
    console.log('[WhatsApp] Twilio response:', JSON.stringify(data));
    if (data.sid) return { success: true, sid: data.sid };
    return { success: false, error: data.message || JSON.stringify(data) };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

const TEMPLATES: Record<string, (d: any) => string> = {
  invoice_approval: d => `*Deemona Finance* - Approval Required\n\nInvoice: ${d.invoice_number}\nAmount: Rs ${parseFloat(d.amount||0).toLocaleString('en-IN')}\nVendor: ${d.vendor}\nDue: ${d.due_date}\n\nApprove at: https://deemona-finance-os-frontend.onrender.com/accounting\n\nReply APPROVE or REJECT`,
  payment_received: d => `Payment Received\n\nInvoice: ${d.invoice_number}\nAmount: Rs ${parseFloat(d.amount||0).toLocaleString('en-IN')}\nFrom: ${d.customer}`,
  gst_reminder:     d => `GST Filing Reminder\n\n${d.filing_type} for ${d.period} due on ${d.due_date}\nEstimated: Rs ${parseFloat(d.amount||0).toLocaleString('en-IN')}`,
  payroll_approved: d => `Payroll Approved\n\nMonth: ${d.month} ${d.year}\nEmployees: ${d.count}\nTotal: Rs ${parseFloat(d.amount||0).toLocaleString('en-IN')}`,
  low_cash_alert:   d => `Cash Alert\n\nCurrent position: Rs ${parseFloat(d.cash||0).toLocaleString('en-IN')}\nRunway: ${d.runway} months`,
  custom:           d => d.message || 'Message from Deemona Finance',
};

/*twilio-signature*/
import crypto from 'crypto';
function xmlEscape(t: string): string { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// Twilio signs: full URL + each POST param (sorted by name) as name+value, HMAC-SHA1 with the auth token, base64.
export function twilioSignatureValid(url: string, params: Record<string, any>, signature: string, token: string): boolean {
  if (!signature || !token) return false;
  const data = url + Object.keys(params).sort().reduce((a, k) => a + k + String(params[k] ?? ''), '');
  const expected = crypto.createHmac('sha1', token).update(data).digest('base64');
  const a = Buffer.from(expected); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createWhatsAppRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  router.post('/send', requireAuth, async (req: Request, res: Response) => {
    try {
      const { to, template, data, message } = req.body;
      console.log('[WhatsApp] /send called. to:', to, 'template:', template, 'message:', message);
      if (!to) return res.status(400).json({ error: 'Phone number required' }) as any;
      const fn = TEMPLATES[template] || TEMPLATES.custom;
      const body = message || fn({ ...data, message });
      const result = await sendWA(to, body);
      // Log
      await pool.query(
        `INSERT INTO whatsapp_logs (tenant_id, to_number, template, message, status, twilio_sid, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT DO NOTHING`,
        [tid(req), to, template||'custom', body, result.success?'sent':'failed', (result as any).sid||null]
      ).catch(()=>{});
      res.json(result);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post('/bulk', requireAuth, async (req: Request, res: Response) => {
    try {
      const { numbers, template, data } = req.body;
      if (!numbers?.length) return res.status(400).json({ error: 'Numbers array required' }) as any;
      const fn = TEMPLATES[template] || TEMPLATES.custom;
      const body = fn(data || {});
      const results = await Promise.allSettled(numbers.map((n: string) => sendWA(n, body)));
      const sent = results.filter(r => r.status === 'fulfilled' && (r.value as any).success).length;
      res.json({ sent, failed: results.length - sent, total: results.length });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get('/templates', requireAuth, async (_req, res) => {
    res.json({ templates: Object.keys(TEMPLATES).map(id => ({ id, name: id.replace(/_/g,' ') })) });
  });

  router.get('/logs', requireAuth, async (req: Request, res: Response) => {
    try {
      const r = await pool.query('SELECT * FROM whatsapp_logs WHERE tenant_id=$1 ORDER BY sent_at DESC LIMIT 50', [tid(req)]);
      res.json({ logs: r.rows });
    } catch { res.json({ logs: [] }); }
  });

  router.get('/status', requireAuth, async (_req, res) => {
    const configured = !!(TWILIO_SID && TWILIO_TOKEN);
    res.json({
      configured,
      from_number: TWILIO_FROM,
      message: configured ? 'WhatsApp ready to send' : 'Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to Render environment variables',
    });
  });

  // Twilio inbound webhook: reject anything not signed by Twilio, then process APPROVE / REJECT replies.
  router.post('/webhook', async (req: Request, res: Response) => {
    const token = process.env.TWILIO_AUTH_TOKEN || '';
    if (!token) { res.status(503).send('Webhook not configured'); return; }
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    const url = process.env.TWILIO_WEBHOOK_URL || (proto + '://' + req.get('host') + req.originalUrl);
    const sig = String(req.headers['x-twilio-signature'] || '');
    if (!twilioSignatureValid(url, req.body || {}, sig, token)) {
      console.warn('[WhatsApp webhook] rejected: bad signature');
      res.status(403).send('Invalid signature'); return;
    }
    const { Body, From } = req.body || {};
    let reply = 'Thank you! Your message has been received by Deemona Finance.';
    try { reply = await handleWhatsAppApprovalReply(pool, From, String(Body || '')); } catch (e) { console.error('[WhatsApp webhook] handler error', e); }
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Message>' + xmlEscape(reply) + '</Message></Response>');
  });

  return router;
}
