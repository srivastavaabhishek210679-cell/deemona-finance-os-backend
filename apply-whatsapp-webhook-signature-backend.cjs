// Secures POST /api/whatsapp/webhook with Twilio's X-Twilio-Signature and connects it to the tenant-scoped APPROVE/REJECT handler.
// Idempotent. Run from the backend folder (after apply-automation-tenant-scope-backend.cjs).
const fs = require('fs');
const f = 'src/routes/whatsappRoutes.ts';
if (!fs.existsSync(f)) { console.error('Run from the backend folder'); process.exit(1); }
const raw = fs.readFileSync(f, 'utf8'); const crlf = raw.includes('\r\n'); let s = raw.replace(/\r\n/g, '\n');
if (s.includes('/*twilio-signature*/')) { console.log('Already applied'); process.exit(0); }
function must(c, m) { if (!c) { console.error('Pattern not found: ' + m); process.exit(1); } }
const helper = `/*twilio-signature*/
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
`;
const anchor = "export function createWhatsAppRouter(";
must(s.includes(anchor), 'createWhatsAppRouter');
s = s.replace(anchor, () => helper + '\n' + anchor);
const start = s.indexOf("  router.post('/webhook'");
must(start > 0, 'webhook route');
const end = s.indexOf('  });\n', start) + 6;
const route = `  // Twilio inbound webhook: reject anything not signed by Twilio, then process APPROVE / REJECT replies.
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
`;
s = s.slice(0, start) + route + s.slice(end);
fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s); console.log('Done');
