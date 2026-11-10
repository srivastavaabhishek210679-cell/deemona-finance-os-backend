// WhatsApp commands: HELP, DUE, PENDING, INVOICE <number>. Only active employees (matched by phone) of a tenant see that tenant's data. Idempotent. Run from the backend folder.
const fs = require('fs');
const MOD = String.raw`// WhatsApp commands for finance data. Returns a reply, or null when the message is not a command.
const inr = (n: any): string => 'Rs ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const day = (d: any): string => { try { return new Date(d).toISOString().slice(0, 10); } catch { return String(d || ''); } };
const cut = (s: string): string => (s.length > 1500 ? s.slice(0, 1480) + '\n...(more in the app)' : s);

const HELP = [
  'Deemona Finance commands:',
  'DUE - what is due in the next 7 days or overdue',
  'PENDING - invoices waiting for your approval',
  'INVOICE <number> - details of one invoice',
  'APPROVE <ID> / REJECT <ID> - act on a pending invoice',
].join('\n');

export async function handleWhatsAppCommand(pool: any, from: string, body: string): Promise<string | null> {
  const text = String(body || '').trim();
  const upper = text.toUpperCase();
  const m = /^(HELP|MENU|DUE|PENDING|INVOICE|INV)\b\s*(.*)$/i.exec(text);
  if (!m) return null;                                    // not ours: APPROVE/REJECT and anything else go to the old handler
  const cmd = m[1].toUpperCase();
  const arg = m[2].trim();
  try {
    const digits = String(from || '').replace(/\D/g, '').slice(-10);
    if (digits.length < 10) return 'Sender not recognised.';
    const who = await pool.query(
      "SELECT DISTINCT tenant_id FROM employees WHERE status='active' AND RIGHT(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$1", [digits]);
    if (who.rows.length !== 1) return 'Sender not recognised.';
    const t = who.rows[0].tenant_id;
    if (cmd === 'HELP' || cmd === 'MENU') return HELP;

    if (cmd === 'DUE') {
      const ar = await pool.query(
        "SELECT invoice_number, balance_due, due_date FROM ar_invoices WHERE tenant_id=$1 AND status NOT IN ('paid','cancelled','draft') AND balance_due>0 AND due_date <= CURRENT_DATE + 7 ORDER BY due_date LIMIT 20", [t]);
      const ap = await pool.query(
        "SELECT invoice_number, balance_due, due_date FROM ap_invoices WHERE tenant_id=$1 AND status IN ('pending','approved','overdue') AND balance_due>0 AND due_date <= CURRENT_DATE + 7 ORDER BY due_date LIMIT 20", [t]);
      const sum = (r: any[]) => r.reduce((a, x) => a + Number(x.balance_due || 0), 0);
      const line = (x: any) => '- ' + x.invoice_number + ' ' + inr(x.balance_due) + ' (' + day(x.due_date) + ')';
      const out = ['Due in 7 days or overdue'];
      out.push('', 'To collect: ' + ar.rows.length + ' invoices, ' + inr(sum(ar.rows)), ...ar.rows.slice(0, 5).map(line));
      out.push('', 'To pay: ' + ap.rows.length + ' invoices, ' + inr(sum(ap.rows)), ...ap.rows.slice(0, 5).map(line));
      return cut(out.join('\n'));
    }

    if (cmd === 'PENDING') {
      const r = await pool.query(
        "SELECT a.id, a.invoice_number, a.total_amount, a.due_date, v.name AS vendor FROM ap_invoices a LEFT JOIN vendors v ON v.id=a.vendor_id AND v.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.status='pending' ORDER BY a.due_date LIMIT 5", [t]);
      if (!r.rows.length) return 'No invoices are waiting for approval.';
      const out = ['Waiting for approval (' + r.rows.length + (r.rows.length === 5 ? '+' : '') + '):'];
      for (const x of r.rows) out.push('', x.invoice_number + ' - ' + (x.vendor || 'vendor') + ' - ' + inr(x.total_amount) + ' - due ' + day(x.due_date), 'APPROVE ' + String(x.id).replace(/-/g, '').slice(0, 8).toUpperCase());
      return cut(out.join('\n'));
    }

    // INVOICE <number>
    if (!arg) return 'Send: INVOICE <invoice number>';
    const like = arg;
    const ar = await pool.query(
      "SELECT a.invoice_number, a.status, a.total_amount, a.paid_amount, a.balance_due, a.date, a.due_date, c.name AS party FROM ar_invoices a LEFT JOIN customers c ON c.id=a.customer_id AND c.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND UPPER(a.invoice_number)=UPPER($2) LIMIT 3", [t, like]);
    const ap = await pool.query(
      "SELECT a.invoice_number, a.status, a.total_amount, a.paid_amount, a.balance_due, a.date, a.due_date, v.name AS party FROM ap_invoices a LEFT JOIN vendors v ON v.id=a.vendor_id AND v.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND UPPER(a.invoice_number)=UPPER($2) LIMIT 3", [t, like]);
    const rows = [...ar.rows.map((x: any) => ({ ...x, kind: 'Sales invoice' })), ...ap.rows.map((x: any) => ({ ...x, kind: 'Purchase invoice' }))];
    if (!rows.length) return 'No invoice found with number ' + arg.slice(0, 40) + '.';
    return cut(rows.map((x: any) => [
      x.kind + ' ' + x.invoice_number, 'Party: ' + (x.party || '-'), 'Status: ' + x.status,
      'Total: ' + inr(x.total_amount), 'Paid: ' + inr(x.paid_amount), 'Balance: ' + inr(x.balance_due),
      'Date: ' + day(x.date) + '  Due: ' + day(x.due_date),
    ].join('\n')).join('\n\n'));
  } catch (e) {
    console.error('[WhatsApp command] error', e);
    return 'Could not fetch that right now. Please try again.';
  }
}
`;
function rd(p){let s=fs.readFileSync(p,'utf8');const bom=s.charCodeAt(0)===0xFEFF;if(bom)s=s.slice(1);const crlf=s.includes('\r\n');if(crlf)s=s.replace(/\r\n/g,'\n');return{s,bom,crlf};}
const mp='src/services/whatsappCommands.ts';
if(!fs.existsSync(mp)||fs.readFileSync(mp,'utf8')!==MOD){fs.writeFileSync(mp,MOD);console.log('wrote',mp);}else console.log('up to date',mp);
const p='src/routes/whatsappRoutes.ts';const o=rd(p);let s=o.s;
if(s.includes('/*wa-commands*/')){console.log('already patched');process.exit(0);}
const a="try { reply = await handleWhatsAppApprovalReply(pool, From, String(Body || '')); }";
if(!s.includes(a)){console.log('anchor not found');process.exit(1);}
s=s.replace(a,"try { const cmdReply = await handleWhatsAppCommand(pool, From, String(Body || '')); /*wa-commands*/ reply = cmdReply !== null ? cmdReply : await handleWhatsAppApprovalReply(pool, From, String(Body || '')); }");
s=s.replace(/^((?:﻿)?import [^\n]*\n)/,"$1import { handleWhatsAppCommand } from '../services/whatsappCommands';\n");
fs.writeFileSync(p,(o.bom?'﻿':'')+(o.crlf?s.replace(/\n/g,'\r\n'):s));console.log('patched',p);
