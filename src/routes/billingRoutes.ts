import { Router, Request, Response } from 'express';
/*tenant-iso*/
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_API = 'https://api.razorpay.com/v1';

const rzpAuth = () => 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');

const PLANS = {
  starter:    { name: 'Starter',    amount: 299900,  period: 'monthly', interval: 1, features: ['5 users', '1000 invoices/mo', 'Basic AI'] },
  pro:        { name: 'Pro',        amount: 799900,  period: 'monthly', interval: 1, features: ['15 users', 'Unlimited invoices', 'Full AI suite'] },
  business:   { name: 'Business',   amount: 1499900, period: 'monthly', interval: 1, features: ['50 users', 'Multi-company', 'Priority support'] },
  enterprise: { name: 'Enterprise', amount: 0,       period: 'monthly', interval: 1, features: ['Unlimited', 'Custom AI', 'Dedicated support'] },
};

export function createBillingRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;
  const uid = (req: Request): string => (req as any).user.id;

  // ── GET /api/billing/plans ─────────────────────────────────
  router.get('/plans', async (_req, res) => {
    res.json({ plans: PLANS, currency: 'INR' });
  });

  // ── POST /api/billing/create-order ─────────────────────────
  router.post('/create-order', requireAuth, async (req: Request, res: Response) => {
    try {
      const { plan } = req.body;
      const planData = PLANS[plan as keyof typeof PLANS];
      if (!planData) return res.status(400).json({ error: 'Invalid plan' }) as any;
      if (planData.amount === 0) return res.json({ enterprise: true, message: 'Contact sales@deemona.com' });

      if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
        return res.json({ 
          demo: true,
          key_id: 'rzp_test_demo',
          amount: planData.amount,
          currency: 'INR',
          plan,
          note: 'Razorpay not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to environment.'
        }) as any;
      }

      const order = await fetch(`${RAZORPAY_API}/orders`, {
        method: 'POST',
        headers: { 'Authorization': rzpAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: planData.amount,
          currency: 'INR',
          receipt: `order_${Date.now()}`,
          notes: { tenant_id: tid(req), plan, user_id: uid(req) },
        }),
      }).then(r => r.json()) as any;

      await pool.query(
        `INSERT INTO billing_orders (tenant_id, plan, amount, razorpay_order_id, status, created_at)
         VALUES ($1,$2,$3,$4,'created',NOW()) ON CONFLICT DO NOTHING`,
        [tid(req), plan, planData.amount / 100, order.id]
      ).catch(() => {});

      res.json({ order_id: order.id, amount: planData.amount, currency: 'INR', key_id: RAZORPAY_KEY_ID, plan });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/billing/verify-payment ───────────────────────
  router.post('/verify-payment', requireAuth, async (req: Request, res: Response) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
      const crypto = require('crypto');
      if (!RAZORPAY_KEY_SECRET) return res.status(503).json({ error: 'Payments are not configured' }) as any;
      const expectedSig = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
      const a = Buffer.from(expectedSig), b = Buffer.from(String(razorpay_signature || ''));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(400).json({ error: 'Invalid payment signature' }) as any;
      }
      // The order must belong to this tenant and not be already used; the plan comes from the order, not the request.
      const ord = await pool.query(
        "SELECT plan, status FROM billing_orders WHERE razorpay_order_id=$1 AND tenant_id=$2", [razorpay_order_id, tid(req)]);
      if (!ord.rows.length) return res.status(404).json({ error: 'Order not found' }) as any;
      if (String(ord.rows[0].status).toLowerCase() === 'paid') return res.status(409).json({ error: 'Order already processed' }) as any;
      const plan = ord.rows[0].plan;

      const nextBilling = new Date();
      nextBilling.setMonth(nextBilling.getMonth() + 1);

      await pool.query(
        `UPDATE billing_orders SET status='paid', payment_id=$1, updated_at=NOW() WHERE razorpay_order_id=$2 AND tenant_id=$3`,
        [razorpay_payment_id, razorpay_order_id, tid(req)]
      ).catch(() => {});

      await pool.query(
        `UPDATE tenants SET plan=$1, plan_expires_at=$2, updated_at=NOW() WHERE id=$3`,
        [plan, nextBilling.toISOString(), tid(req)]
      ).catch(() => {});

      res.json({ success: true, plan, payment_id: razorpay_payment_id, next_billing: nextBilling });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/billing/subscription ──────────────────────────
  router.get('/subscription', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenant = await pool.query('SELECT plan, plan_expires_at FROM tenants WHERE id=$1', [tid(req)]);
      const orders = await pool.query('SELECT * FROM billing_orders WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 5', [tid(req)]);
      res.json({
        current_plan: tenant.rows[0]?.plan || 'starter',
        expires_at: tenant.rows[0]?.plan_expires_at,
        orders: orders.rows,
        plans: PLANS,
      });
    } catch (err) { res.json({ current_plan: 'starter', orders: [], plans: PLANS }); }
  });

  // ── POST /api/billing/webhook ── Razorpay webhook ──────────
  router.post('/webhook', async (req: Request, res: Response) => {
    try {
      const { event, payload } = req.body;
      if (event === 'payment.captured') {
        const notes = payload?.payment?.entity?.notes || {};
        if (notes.tenant_id && notes.plan) {
          const nextBilling = new Date();
          nextBilling.setMonth(nextBilling.getMonth() + 1);
          await pool.query(
            'UPDATE tenants SET plan=$1, plan_expires_at=$2 WHERE id=$3',
            [notes.plan, nextBilling.toISOString(), notes.tenant_id]
          ).catch(() => {});
        }
      }
      res.json({ received: true });
    } catch (err) { res.json({ received: false }); }
  });

  return router;
}
