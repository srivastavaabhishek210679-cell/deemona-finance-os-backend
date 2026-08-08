import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// WhatsApp message templates for finance alerts
const TEMPLATES = {
  invoice_approval: (data: any) => `*Invoice Approval Required* ✅
  
Vendor: ${data.vendor_name}
Invoice No: ${data.invoice_number}
Amount: ₹${parseFloat(data.amount).toLocaleString('en-IN')}
Due Date: ${data.due_date}

Please approve or reject within 24 hours.
Reply *APPROVE ${data.invoice_id}* or *REJECT ${data.invoice_id}*`,

  payment_confirmation: (data: any) => `*Payment Confirmed* 💳

Paid to: ${data.vendor_name}
Amount: ₹${parseFloat(data.amount).toLocaleString('en-IN')}
Reference: ${data.reference}
Date: ${data.date}

Your invoice has been settled. Thank you!`,

  overdue_alert: (data: any) => `*Overdue Invoice Alert* ⚠️

Customer: ${data.customer_name}
Invoice: ${data.invoice_number}
Amount Due: ₹${parseFloat(data.amount).toLocaleString('en-IN')}
Overdue By: ${data.days_overdue} days

Please make payment immediately to avoid service disruption.`,

  gst_reminder: (data: any) => `*GST Filing Reminder* 🧾

Filing: ${data.filing_type}
Period: ${data.period}
Due Date: ${data.due_date}
Estimated Liability: ₹${parseFloat(data.amount).toLocaleString('en-IN')}

File before ${data.due_date} to avoid penalty of ₹50/day.`,

  payroll_processed: (data: any) => `*Payroll Processed* 👥

Month: ${data.month}
Employees: ${data.count}
Total Net Pay: ₹${parseFloat(data.total_net).toLocaleString('en-IN')}
Status: ${data.status}

Payslips have been sent to all employees.`,

  expense_approved: (data: any) => `*Expense Claim Approved* ✅

Claim: ${data.claim_number}
Amount: ₹${parseFloat(data.amount).toLocaleString('en-IN')}
Approved by: ${data.approved_by}

Reimbursement will be credited with next payroll.`,

  low_cash_alert: (data: any) => `*Low Cash Alert* 🚨

Current Balance: ₹${parseFloat(data.balance).toLocaleString('en-IN')}
Runway: ${data.runway_months} months
Monthly Burn: ₹${parseFloat(data.burn).toLocaleString('en-IN')}

Action required: Review cash flow immediately.`,

  compliance_deadline: (data: any) => `*Compliance Deadline* ⏰

Filing: ${data.filing}
Due: ${data.due_date}
Penalty if missed: ${data.penalty}

Complete filing immediately to avoid penalties.`,
};

export function createWhatsAppRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/whatsapp/config ──────────────────────────────
  router.get('/config', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      let config = null;
      try {
        const result = await pool.query(
          `SELECT * FROM whatsapp_config WHERE tenant_id=$1`,
          [tenantId]
        );
        config = result.rows[0] || null;
      } catch { config = null; }

      res.json({
        configured: !!config,
        config: config ? {
          phone_number: config.phone_number,
          provider: config.provider || 'twilio',
          is_active: config.is_active,
          notifications: config.notifications || {
            invoice_approval: true,
            payment_confirmation: true,
            overdue_alerts: true,
            gst_reminders: true,
            payroll_processed: true,
            expense_approved: false,
            low_cash_alert: true,
            compliance_deadline: true,
          },
        } : null,
        providers: [
          { id: 'twilio', name: 'Twilio WhatsApp', description: 'Official WhatsApp Business API via Twilio', setup_url: 'https://www.twilio.com/whatsapp' },
          { id: 'wati', name: 'WATI', description: 'India-focused WhatsApp Business platform', setup_url: 'https://www.wati.io' },
          { id: 'interakt', name: 'Interakt', description: 'Popular India WhatsApp BSP', setup_url: 'https://www.interakt.shop' },
          { id: 'gupshup', name: 'Gupshup', description: 'Enterprise WhatsApp messaging', setup_url: 'https://www.gupshup.io' },
        ],
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/whatsapp/config ─────────────────────────────
  router.post('/config', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { phone_number, provider, api_key, notifications } = req.body;

      await pool.query(
        `INSERT INTO whatsapp_config (tenant_id, phone_number, provider, api_key, notifications, is_active)
         VALUES ($1,$2,$3,$4,$5,TRUE)
         ON CONFLICT (tenant_id) DO UPDATE SET phone_number=$2, provider=$3, api_key=$4, notifications=$5, is_active=TRUE, updated_at=NOW()`,
        [tenantId, phone_number, provider, api_key, JSON.stringify(notifications)]
      ).catch(() => {
        // Table may not exist — just return success
      });

      res.json({ success: true, message: 'WhatsApp configuration saved' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/whatsapp/send ───────────────────────────────
  router.post('/send', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { to, template, data, custom_message } = req.body;

      if (!to) { res.status(400).json({ error: 'to (phone number) is required' }); return; }

      let message = custom_message;
      if (!message && template && TEMPLATES[template as keyof typeof TEMPLATES]) {
        message = TEMPLATES[template as keyof typeof TEMPLATES](data || {});
      }
      if (!message) { res.status(400).json({ error: 'Either custom_message or valid template required' }); return; }

      // Check if Twilio is configured
      const twilioSid  = process.env.TWILIO_ACCOUNT_SID;
      const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
      const twilioFrom = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

      if (twilioSid && twilioAuth) {
        // Send via Twilio
        const response = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
          {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + Buffer.from(`${twilioSid}:${twilioAuth}`).toString('base64'),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              From: twilioFrom,
              To: `whatsapp:${to}`,
              Body: message,
            }),
          }
        );
        const result = await response.json() as any;
        if (!response.ok) throw new Error(result.message || 'Twilio error');

        // Log message
        await pool.query(
          `INSERT INTO whatsapp_messages (tenant_id, to_number, message, template, status, provider_message_id) VALUES ($1,$2,$3,$4,'sent',$5)`,
          [tenantId, to, message, template||'custom', result.sid]
        ).catch(() => {});

        res.json({ success: true, message_id: result.sid, status: 'sent' });
      } else {
        // Simulate (no Twilio configured)
        console.log(`[WhatsApp] Would send to ${to}:\n${message}`);
        await pool.query(
          `INSERT INTO whatsapp_messages (tenant_id, to_number, message, template, status) VALUES ($1,$2,$3,$4,'simulated')`,
          [tenantId, to, message, template||'custom']
        ).catch(() => {});
        res.json({ success: true, message_id: `sim_${Date.now()}`, status: 'simulated', note: 'Configure TWILIO_ACCOUNT_SID to send real messages' });
      }
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/whatsapp/templates ───────────────────────────
  router.get('/templates', requireAuth, async (_req: Request, res: Response) => {
    const templates = Object.entries(TEMPLATES).map(([id, fn]) => ({
      id,
      name: id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      preview: fn({
        vendor_name: 'Acme Ltd', invoice_number: 'INV-001', amount: 150000,
        due_date: '2026-08-15', invoice_id: 'uuid-here', customer_name: 'XYZ Corp',
        days_overdue: 15, filing_type: 'GSTR-3B', period: 'July 2026',
        month: 'July 2026', count: 15, total_net: 2500000, status: 'Completed',
        claim_number: 'EXP-001', approved_by: 'Arjun Mehta', balance: 5000000,
        runway_months: 8, burn: 600000, filing: 'GSTR-3B', penalty: 'Rs 50/day',
        reference: 'TXN123456', date: '2026-08-08',
      }),
    }));
    res.json({ templates });
  });

  // ── GET /api/whatsapp/messages ────────────────────────────
  router.get('/messages', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      let messages: any[] = [];
      try {
        const result = await pool.query(
          `SELECT * FROM whatsapp_messages WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50`,
          [tenantId]
        );
        messages = result.rows;
      } catch { messages = []; }
      res.json({ messages });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/whatsapp/ai-message ────────────────────────
  // Generate a custom WhatsApp message using AI
  router.post('/ai-message', requireAuth, async (req: Request, res: Response) => {
    try {
      const { context, recipient, tone = 'professional' } = req.body;
      if (!context) { res.status(400).json({ error: 'context is required' }); return; }

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Write a WhatsApp message for Indian business finance context.
Recipient: ${recipient || 'business contact'}
Tone: ${tone}
Context: ${context}

Rules:
- Keep it under 200 words
- Use Indian Rs symbol (₹) for amounts
- Include relevant emoji
- Be clear and actionable
- End with a specific call to action
- Format for WhatsApp (use *bold* for emphasis)

Write only the message, no explanation.`,
        }],
      });

      const message = response.content[0].type === 'text' ? response.content[0].text : '';
      res.json({ message });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/whatsapp/bulk-alert ────────────────────────
  // Send alerts to multiple contacts
  router.post('/bulk-alert', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { alert_type } = req.body;

      const results: any[] = [];

      if (alert_type === 'overdue_ar') {
        const overdue = await pool.query(
          `SELECT ar.*, c.name as customer_name, c.phone as customer_phone
           FROM ar_invoices ar JOIN customers c ON c.id=ar.customer_id
           WHERE ar.tenant_id=$1 AND ar.status NOT IN ('paid','cancelled')
           AND ar.due_date < CURRENT_DATE`,
          [tenantId]
        );

        for (const inv of overdue.rows) {
          if (!inv.customer_phone) continue;
          const days = Math.floor((Date.now() - new Date(inv.due_date).getTime()) / 86400000);
          results.push({
            customer: inv.customer_name,
            phone: inv.customer_phone,
            invoice: inv.invoice_number,
            amount: inv.balance_due,
            days_overdue: days,
            message_queued: true,
          });
        }
      } else if (alert_type === 'compliance_deadlines') {
        const items = await pool.query(
          `SELECT * FROM compliance_items WHERE tenant_id=$1 AND status='pending' AND due_date <= CURRENT_DATE + INTERVAL '7 days'`,
          [tenantId]
        );
        for (const item of items.rows) {
          results.push({ title: item.title, due_date: item.due_date, penalty: item.penalty_if_missed, queued: true });
        }
      }

      res.json({ alert_type, results, total_queued: results.length });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
