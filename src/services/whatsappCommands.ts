import { listActions, findByCode, approveAction, rejectAction } from './controlledActions';
import { runMetric } from './cfoMetrics';
// WhatsApp commands for finance data. Returns a reply, or null when the message is not a command.
const inr = (n: any): string => 'Rs ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const day = (d: any): string => { try { return new Date(d).toISOString().slice(0, 10); } catch { return String(d || ''); } };
const cut = (s: string): string => (s.length > 1500 ? s.slice(0, 1480) + '\n...(more in the app)' : s);

const HELP = [
  'Deemona Finance commands:',
  'DUE - what is due in the next 7 days or overdue',
  'PENDING - invoices waiting for your approval',
  'INVOICE <number> - details of one invoice',
  'APPROVE <ID> / REJECT <ID> - act on a pending invoice',
  'ACTIONS - actions proposed by your Digital CFO (admins)',
  'OK <code> / NO <code> - approve or reject a proposed action (admins)',
].join('\n');

export async function handleWhatsAppCommand(pool: any, from: string, body: string): Promise<string | null> {
  const text = String(body || '').trim();
  const upper = text.toUpperCase();
  const m = /^(HELP|MENU|DUE|PENDING|INVOICE|INV|ACTIONS|OK|NO)\b\s*(.*)$/i.exec(text);
  if (!m) return null;                                    // not ours: APPROVE/REJECT and anything else go to the old handler
  const cmd = m[1].toUpperCase();
  const arg = m[2].trim();
  if ((cmd === 'OK' || cmd === 'NO') && !/^[A-F0-9]{6}$/i.test(arg)) return null;   // a plain OK / No is just chat
  try {
    const digits = String(from || '').replace(/\D/g, '').slice(-10);
    if (digits.length < 10) return 'Sender not recognised.';
    const who = await pool.query(
      "SELECT DISTINCT tenant_id FROM employees WHERE status='active' AND RIGHT(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$1", [digits]);
    if (who.rows.length !== 1) return 'Sender not recognised.';
    const t = who.rows[0].tenant_id;
    if (cmd === 'HELP' || cmd === 'MENU') return HELP;

    if (cmd === 'ACTIONS' || cmd === 'OK' || cmd === 'NO') {
      const emp = await pool.query("SELECT LOWER(email) AS email FROM employees WHERE tenant_id=$1 AND status='active' AND email IS NOT NULL AND RIGHT(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$2 LIMIT 1", [t, digits]);
      const usr = emp.rows.length ? await pool.query("SELECT id::text AS id, email, role, first_name FROM users WHERE tenant_id=$1 AND LOWER(email)=$2 AND role IN ('admin','owner') LIMIT 1", [t, emp.rows[0].email]) : { rows: [] as any[] };
      if (!usr.rows.length) return 'Only company admins can see or approve actions. Your WhatsApp number must be saved on your employee record with the same email as your admin login.';
      const who2 = { id: usr.rows[0].id, email: usr.rows[0].email, name: usr.rows[0].first_name, role: usr.rows[0].role };
      if (cmd === 'ACTIONS') {
        const list = await listActions(pool, t, 'open', 5);
        if (!list.length) return 'No actions are waiting for your approval.';
        return cut(['Waiting for your approval:'].concat(list.map((x: any) => '\n' + x.code + ' - ' + x.title + '\n' + (x.summary || ''))).concat(['\nReply OK <code> to approve or NO <code> to reject.']).join('\n'));
      }
      const found = await findByCode(pool, t, arg);
      if (!found.id) return found.error || 'Not found.';
      if (cmd === 'NO') { const r = await rejectAction(pool, t, found.id, who2); return r.ok ? 'Rejected. Nothing was sent.' : (r.error || 'Could not reject.'); }
      const r = await approveAction(pool, t, found.id, who2, { runMetric });
      return r.ok ? 'Approved and done: ' + (r.action && r.action.title ? r.action.title : 'action') + '.' : (r.error || 'Could not approve.');
    }

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
        "SELECT a.id, a.invoice_number, a.total_amount, a.due_date, v.name AS vendor FROM ap_invoices a LEFT JOIN vendors v ON v.id=a.vendor_id AND v.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.status IN ('pending','pending_approval') ORDER BY a.due_date LIMIT 5", [t]);
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
