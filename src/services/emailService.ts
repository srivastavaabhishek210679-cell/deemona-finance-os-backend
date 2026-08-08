// ============================================================
// Deemona AI Finance OS — Email Service
// Uses Gmail SMTP (nodemailer) — same pattern as your other apps
// Add to backend .env:
//   EMAIL_FROM=your-gmail@gmail.com
//   EMAIL_PASSWORD=your-app-password  (Gmail App Password, not account password)
// ============================================================

import * as nodemailer from 'nodemailer';

function getTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_FROM,
      pass: process.env.EMAIL_PASSWORD,
    },
  });
}

export async function sendPasswordResetEmail(
  to: string,
  firstName: string,
  otp: string,
  expiresMinutes: number = 15
): Promise<void> {
  if (!process.env.EMAIL_FROM || !process.env.EMAIL_PASSWORD) {
    // Log OTP to console in development if email not configured
    console.log(`[Email] Password reset OTP for ${to}: ${otp} (expires in ${expiresMinutes} minutes)`);
    console.log('[Email] Configure EMAIL_FROM and EMAIL_PASSWORD in .env to send real emails');
    return;
  }

  const transporter = getTransporter();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reset your Deemona password</title>
</head>
<body style="margin:0;padding:0;background:#0B0B13;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0B0B13;min-height:100vh;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table width="480" cellpadding="0" cellspacing="0" style="background:#13131E;border-radius:16px;border:1px solid #2A2A42;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="padding:32px 36px 24px;border-bottom:1px solid #2A2A42;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:linear-gradient(135deg,#6C63FF,#9B8FFF);width:44px;height:44px;border-radius:12px;text-align:center;vertical-align:middle;">
                    <span style="color:#fff;font-size:22px;font-weight:900;font-style:italic;line-height:44px;">D</span>
                  </td>
                  <td style="padding-left:12px;">
                    <div style="color:#fff;font-size:17px;font-weight:800;letter-spacing:0.02em;">DEEMONA</div>
                    <div style="color:#55536A;font-size:11px;letter-spacing:0.05em;">AI Finance OS</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 36px;">
              <h2 style="color:#F0EEF8;font-size:20px;font-weight:700;margin:0 0 12px;">Reset your password</h2>
              <p style="color:#8B89A8;font-size:15px;line-height:1.6;margin:0 0 28px;">
                Hi ${firstName}, we received a request to reset your password for your Deemona Finance OS account.
                Use the OTP below to proceed.
              </p>

              <!-- OTP Box -->
              <div style="background:#1A1A28;border:2px solid #6C63FF40;border-radius:12px;padding:28px;text-align:center;margin:0 0 28px;">
                <div style="color:#8B89A8;font-size:13px;margin-bottom:12px;letter-spacing:0.05em;">YOUR ONE-TIME PASSWORD</div>
                <div style="color:#6C63FF;font-size:42px;font-weight:900;letter-spacing:12px;font-family:'Courier New',monospace;">${otp}</div>
                <div style="color:#55536A;font-size:12px;margin-top:12px;">Expires in ${expiresMinutes} minutes</div>
              </div>

              <p style="color:#8B89A8;font-size:14px;line-height:1.6;margin:0 0 20px;">
                Enter this OTP on the password reset page along with your new password.
              </p>

              <div style="background:#FF5C5C10;border:1px solid #FF5C5C30;border-radius:8px;padding:14px;margin:0 0 28px;">
                <p style="color:#FF5C5C;font-size:13px;margin:0;">
                  If you didn't request a password reset, please ignore this email. Your account is safe.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 36px;border-top:1px solid #2A2A42;">
              <p style="color:#55536A;font-size:12px;margin:0;text-align:center;line-height:1.6;">
                This email was sent by Deemona AI Finance OS &bull; Do not reply to this email
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  await transporter.sendMail({
    from: `"Deemona Finance OS" <${process.env.EMAIL_FROM}>`,
    to,
    subject: `${otp} is your Deemona password reset OTP`,
    html,
    text: `Hi ${firstName},\n\nYour Deemona password reset OTP is: ${otp}\n\nThis OTP expires in ${expiresMinutes} minutes.\n\nIf you didn't request this, ignore this email.`,
  });

  console.log(`[Email] Password reset OTP sent to ${to}`);
}

export async function sendWelcomeEmail(
  to: string,
  firstName: string,
  companyName: string
): Promise<void> {
  if (!process.env.EMAIL_FROM || !process.env.EMAIL_PASSWORD) {
    console.log(`[Email] Welcome email would be sent to ${to}`);
    return;
  }

  const transporter = getTransporter();

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0B0B13;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0B0B13;min-height:100vh;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table width="480" cellpadding="0" cellspacing="0" style="background:#13131E;border-radius:16px;border:1px solid #2A2A42;">
          <tr>
            <td style="padding:32px 36px 24px;border-bottom:1px solid #2A2A42;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:linear-gradient(135deg,#6C63FF,#9B8FFF);width:44px;height:44px;border-radius:12px;text-align:center;vertical-align:middle;">
                    <span style="color:#fff;font-size:22px;font-weight:900;font-style:italic;line-height:44px;">D</span>
                  </td>
                  <td style="padding-left:12px;">
                    <div style="color:#fff;font-size:17px;font-weight:800;">DEEMONA</div>
                    <div style="color:#55536A;font-size:11px;">AI Finance OS</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px;">
              <h2 style="color:#F0EEF8;font-size:20px;font-weight:700;margin:0 0 12px;">Welcome to Deemona, ${firstName}!</h2>
              <p style="color:#8B89A8;font-size:15px;line-height:1.6;margin:0 0 20px;">
                Your Finance OS for <strong style="color:#6C63FF;">${companyName}</strong> is ready.
                19 standard GL accounts have been created and all modules are active.
              </p>
              <div style="background:#22C98A10;border:1px solid #22C98A30;border-radius:8px;padding:16px;margin:0 0 20px;">
                <p style="color:#22C98A;font-size:14px;margin:0;font-weight:600;">Your Finance OS is live</p>
                <p style="color:#8B89A8;font-size:13px;margin:8px 0 0;">15 modules ready: Memory, Accounting, Treasury, Payroll, Tax, Budgeting, and more.</p>
              </div>
              <p style="color:#8B89A8;font-size:14px;line-height:1.6;margin:0;">
                Start by setting up your Chart of Accounts in Accounting, adding vendors, and configuring your bank accounts in Treasury.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 36px;border-top:1px solid #2A2A42;">
              <p style="color:#55536A;font-size:12px;margin:0;text-align:center;">Deemona AI Finance OS &bull; Built for Indian SMEs</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  await transporter.sendMail({
    from: `"Deemona Finance OS" <${process.env.EMAIL_FROM}>`,
    to,
    subject: `Welcome to Deemona Finance OS — ${companyName} is ready`,
    html,
  });
}
