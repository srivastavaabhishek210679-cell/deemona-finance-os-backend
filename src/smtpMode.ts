// If email goes out by SMTP, make the existing 'is email configured?' checks pass.
if (process.env.SMTP_HOST && !process.env.RESEND_API_KEY) process.env.RESEND_API_KEY = 'smtp-mode';
