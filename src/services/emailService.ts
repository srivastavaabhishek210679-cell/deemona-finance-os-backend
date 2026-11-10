import { mailFetch } from './mailer';
// ============================================================
// Email Service using Resend (resend.com)
// Env: RESEND_API_KEY, FROM_EMAIL, FROM_NAME
// ============================================================

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@deemona.com';
const FROM_NAME  = process.env.FROM_NAME  || 'Deemona Finance OS';

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
}

export async function sendEmail(opts: EmailOptions): Promise<{ success: boolean; id?: string; error?: string }> {
  if (!RESEND_KEY) {
    console.log('[Email] RESEND_API_KEY not set. Would send to:', opts.to, '| Subject:', opts.subject);
    return { success: false, error: 'RESEND_API_KEY not configured' };
  }

  const toArray = Array.isArray(opts.to) ? opts.to : [opts.to];

  try {
    const res = await mailFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: toArray,
        subject: opts.subject,
        html: opts.html || `<p>${opts.text || ''}</p>`,
        text: opts.text,
      }),
    });

    const data = await res.json() as any;

    if (data.id) {
      console.log('[Email] Sent successfully. ID:', data.id);
      return { success: true, id: data.id };
    }
    console.error('[Email] Resend error:', data);
    return { success: false, error: data.message || JSON.stringify(data) };
  } catch (err) {
    console.error('[Email] Fetch error:', err);
    return { success: false, error: String(err) };
  }
}

// ── Password Reset Email ──────────────────────────────────────
export async function sendPasswordResetEmail(
  to: string,
  name: string,
  otp: string,
  expiryMinutes: number
): Promise<{ success: boolean }> {
  return sendEmail({
    to,
    subject: 'Your Deemona Password Reset OTP',
    html: `
      <div style="font-family:Inter,sans-serif;max-width:500px;margin:0 auto;padding:24px">
        <div style="background:linear-gradient(135deg,#1B4FD8,#3B82F6);padding:24px;border-radius:12px;color:#fff;margin-bottom:24px">
          <h2 style="margin:0;font-size:20px">Deemona AI Finance OS</h2>
          <p style="margin:4px 0 0;opacity:0.8">Password Reset Request</p>
        </div>
        <p>Hi <strong>${name}</strong>,</p>
        <p>Your OTP to reset your password is:</p>
        <div style="font-size:32px;font-weight:800;color:#1B4FD8;letter-spacing:8px;padding:16px;background:#EEF3FD;border-radius:10px;text-align:center;margin:16px 0">${otp}</div>
        <p style="color:#64748B;font-size:13px">This OTP expires in <strong>${expiryMinutes} minutes</strong>. Do not share it with anyone.</p>
        <p style="color:#94A3B8;font-size:12px">If you did not request this, please ignore this email.</p>
        <hr style="border:none;border-top:1px solid #E2E8F0;margin:20px 0"/>
        <p style="color:#94A3B8;font-size:11px;text-align:center">Deemona Technologies | AI Finance OS</p>
      </div>
    `,
    text: `Hi ${name}, your OTP is: ${otp}. Expires in ${expiryMinutes} minutes.`,
  });
}

// ── Invoice Email ─────────────────────────────────────────────
export async function sendInvoiceEmail(to: string, invoice: any): Promise<{ success: boolean }> {
  const amount = parseFloat(invoice.total_amount || 0).toLocaleString('en-IN');
  return sendEmail({
    to,
    subject: `Invoice ${invoice.invoice_number} - Rs ${amount}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <div style="background:linear-gradient(135deg,#1B4FD8,#3B82F6);padding:24px;border-radius:12px;color:#fff;margin-bottom:24px">
          <h2 style="margin:0">Invoice Notification</h2>
          <p style="margin:4px 0 0;opacity:0.8">Deemona AI Finance OS</p>
        </div>
        <div style="font-size:28px;font-weight:800;color:#1B4FD8;margin-bottom:4px">Rs ${amount}</div>
        <div style="color:#64748B;margin-bottom:20px">Invoice #${invoice.invoice_number}</div>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="border-bottom:1px solid #E2E8F0"><td style="padding:8px 0;color:#64748B">Date</td><td style="padding:8px 0;text-align:right">${new Date(invoice.date).toLocaleDateString('en-IN')}</td></tr>
          <tr style="border-bottom:1px solid #E2E8F0"><td style="padding:8px 0;color:#64748B">Status</td><td style="padding:8px 0;text-align:right;font-weight:600;color:${invoice.status==='paid'?'#059669':'#D97706'}">${invoice.status?.toUpperCase()}</td></tr>
        </table>
        <div style="margin-top:24px;text-align:center">
          <a href="https://deemona-finance-os-frontend.onrender.com/accounting" style="background:#1B4FD8;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">View Invoice</a>
        </div>
        <p style="color:#94A3B8;font-size:11px;text-align:center;margin-top:24px">Deemona Technologies | AI Finance OS</p>
      </div>
    `,
  });
}

// ── Payslip Email ─────────────────────────────────────────────
export async function sendPayslipEmail(to: string, payslip: any, employee: any): Promise<{ success: boolean }> {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = months[(payslip.month || 1) - 1];
  return sendEmail({
    to,
    subject: `Payslip - ${month} ${payslip.year} | ${employee.first_name} ${employee.last_name}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <div style="background:linear-gradient(135deg,#7C3AED,#6D28D9);padding:24px;border-radius:12px;color:#fff;margin-bottom:24px">
          <h2 style="margin:0">Payslip - ${month} ${payslip.year}</h2>
          <p style="margin:4px 0 0;opacity:0.8">${employee.first_name} ${employee.last_name} | ${employee.employee_code}</p>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="border-bottom:1px solid #E2E8F0"><td style="padding:8px 0;color:#64748B">Basic</td><td style="padding:8px 0;text-align:right">Rs ${parseFloat(payslip.basic||0).toLocaleString('en-IN')}</td></tr>
          <tr style="border-bottom:1px solid #E2E8F0"><td style="padding:8px 0;color:#64748B">HRA</td><td style="padding:8px 0;text-align:right">Rs ${parseFloat(payslip.hra||0).toLocaleString('en-IN')}</td></tr>
          <tr style="border-bottom:1px solid #E2E8F0;color:#059669"><td style="padding:8px 0"><strong>Gross</strong></td><td style="padding:8px 0;text-align:right"><strong>Rs ${parseFloat(payslip.gross||0).toLocaleString('en-IN')}</strong></td></tr>
          <tr style="border-bottom:1px solid #E2E8F0;color:#DC2626"><td style="padding:8px 0">PF</td><td style="padding:8px 0;text-align:right">- Rs ${parseFloat(payslip.pf_employee||0).toLocaleString('en-IN')}</td></tr>
          <tr style="border-bottom:1px solid #E2E8F0;color:#DC2626"><td style="padding:8px 0">TDS</td><td style="padding:8px 0;text-align:right">- Rs ${parseFloat(payslip.tds||0).toLocaleString('en-IN')}</td></tr>
          <tr><td style="padding:12px 0;font-size:18px;font-weight:800;color:#059669">Net Pay</td><td style="padding:12px 0;text-align:right;font-size:18px;font-weight:800;color:#059669">Rs ${parseFloat(payslip.net||0).toLocaleString('en-IN')}</td></tr>
        </table>
        <p style="color:#94A3B8;font-size:11px;text-align:center;margin-top:24px">Confidential | Deemona AI Finance OS</p>
      </div>
    `,
  });
}
