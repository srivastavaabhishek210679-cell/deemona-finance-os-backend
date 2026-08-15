import Anthropic from '@anthropic-ai/sdk';

const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@deemona.com';
const FROM_NAME = process.env.FROM_NAME || 'Deemona Finance OS';

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: Array<{ filename: string; content: string; type: string }>;
}

export async function sendEmail(opts: EmailOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!SENDGRID_KEY) {
    console.log('[Email] SendGrid not configured. Would send to:', opts.to, '| Subject:', opts.subject);
    return { success: false, error: 'SENDGRID_API_KEY not set in environment' };
  }

  const toArray = Array.isArray(opts.to) ? opts.to : [opts.to];

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: toArray.map(email => ({ email })), subject: opts.subject }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        content: [
          opts.html ? { type: 'text/html', value: opts.html } : null,
          opts.text ? { type: 'text/plain', value: opts.text } : null,
        ].filter(Boolean),
        attachments: opts.attachments || [],
      }),
    });

    if (res.ok || res.status === 202) {
      return { success: true, messageId: res.headers.get('X-Message-Id') || undefined };
    }
    const err = await res.json() as any;
    return { success: false, error: err.errors?.[0]?.message || 'SendGrid error' };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ── Email Templates ───────────────────────────────────────────
export function invoiceEmailTemplate(invoice: any): string {
  return `
<!DOCTYPE html>
<html>
<head><style>
  body { font-family: Inter, sans-serif; color: #0A1628; background: #EEF3FD; margin: 0; padding: 20px; }
  .card { background: #fff; border-radius: 12px; padding: 32px; max-width: 600px; margin: 0 auto; }
  .header { background: linear-gradient(135deg, #1B4FD8, #3B82F6); color: #fff; padding: 24px; border-radius: 10px; margin-bottom: 24px; }
  .amount { font-size: 32px; font-weight: 800; color: #1B4FD8; }
  .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #EEF3FD; }
  .btn { display: inline-block; padding: 12px 24px; background: #1B4FD8; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 700; }
  .footer { text-align: center; color: #94A3B8; font-size: 12px; margin-top: 24px; }
</style></head>
<body>
<div class="card">
  <div class="header">
    <h1 style="margin:0;font-size:20px">Deemona AI Finance OS</h1>
    <p style="margin:4px 0 0;opacity:0.8">Invoice Notification</p>
  </div>
  <div class="amount">Rs ${parseFloat(invoice.total_amount||0).toLocaleString('en-IN')}</div>
  <div style="margin:8px 0 20px;color:#64748B">Invoice #${invoice.invoice_number}</div>
  <div class="row"><span>Invoice Date</span><span>${new Date(invoice.date).toLocaleDateString('en-IN')}</span></div>
  <div class="row"><span>Due Date</span><span>${invoice.due_date ? new Date(invoice.due_date).toLocaleDateString('en-IN') : 'On Receipt'}</span></div>
  <div class="row"><span>Status</span><span style="color:${invoice.status==='paid'?'#059669':'#D97706'}">${invoice.status?.toUpperCase()}</span></div>
  <div style="text-align:center;margin:24px 0">
    <a class="btn" href="${process.env.FRONTEND_URL||'https://deemona-finance-os-frontend.onrender.com'}/accounting">View Invoice</a>
  </div>
  <div class="footer">Deemona Technologies | AI Finance OS<br>This is an automated email. Please do not reply.</div>
</div>
</body></html>`;
}

export function payslipEmailTemplate(payslip: any, employee: any): string {
  return `
<!DOCTYPE html>
<html><head><style>
  body { font-family: Inter, sans-serif; color: #0A1628; background: #EEF3FD; margin: 0; padding: 20px; }
  .card { background: #fff; border-radius: 12px; padding: 32px; max-width: 600px; margin: 0 auto; }
  .header { background: linear-gradient(135deg, #7C3AED, #6D28D9); color: #fff; padding: 24px; border-radius: 10px; margin-bottom: 24px; }
  .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #EEF3FD; font-size: 14px; }
  .total { font-size: 20px; font-weight: 800; color: #059669; }
</style></head>
<body>
<div class="card">
  <div class="header">
    <h2 style="margin:0">Payslip — ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][(payslip.month||1)-1]} ${payslip.year}</h2>
    <p style="margin:4px 0 0;opacity:0.8">${employee.first_name} ${employee.last_name} | ${employee.employee_code}</p>
  </div>
  <div class="row"><span>Basic Salary</span><span>Rs ${parseFloat(payslip.basic||0).toLocaleString('en-IN')}</span></div>
  <div class="row"><span>HRA</span><span>Rs ${parseFloat(payslip.hra||0).toLocaleString('en-IN')}</span></div>
  <div class="row"><span>Special Allowance</span><span>Rs ${parseFloat(payslip.special_allowance||0).toLocaleString('en-IN')}</span></div>
  <div class="row" style="color:#059669"><span><strong>Gross Salary</strong></span><span><strong>Rs ${parseFloat(payslip.gross||0).toLocaleString('en-IN')}</strong></span></div>
  <div class="row" style="color:#DC2626"><span>PF Deduction</span><span>- Rs ${parseFloat(payslip.pf_employee||0).toLocaleString('en-IN')}</span></div>
  <div class="row" style="color:#DC2626"><span>TDS</span><span>- Rs ${parseFloat(payslip.tds||0).toLocaleString('en-IN')}</span></div>
  <div class="row"><span class="total">Net Pay</span><span class="total">Rs ${parseFloat(payslip.net||0).toLocaleString('en-IN')}</span></div>
  <p style="font-size:12px;color:#94A3B8;margin-top:20px;text-align:center">Deemona AI Finance OS | Confidential Payslip</p>
</div></body></html>`;
}

export async function sendPasswordResetEmail(to: string, resetLink: string): Promise<{ success: boolean }> {
  return sendEmail({
    to,
    subject: 'Reset your Deemona password',
    text: `Click this link to reset your password: ${resetLink}`
  });
}
