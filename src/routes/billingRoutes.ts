import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';

const PLANS = {
  free:       { name:'Free',       price_monthly:0,     price_yearly:0,      max_users:2,  max_invoices:20,  ai_calls:100 },
  starter:    { name:'Starter',    price_monthly:2999,  price_yearly:29990,  max_users:5,  max_invoices:500, ai_calls:2000 },
  pro:        { name:'Pro',        price_monthly:7999,  price_yearly:79990,  max_users:15, max_invoices:2000,ai_calls:10000 },
  enterprise: { name:'Enterprise', price_monthly:24999, price_yearly:249990, max_users:-1, max_invoices:-1,  ai_calls:-1 },
};

export function createBillingRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── GET /api/billing/plans ────────────────────────────────
  router.get('/plans', async (_req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT * FROM plans WHERE is_active=TRUE ORDER BY price_monthly ASC');
      res.json({ plans: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/billing/subscription ────────────────────────
  router.get('/subscription', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const [sub, tenant, usage] = await Promise.all([
        pool.query(`SELECT s.*, p.name as plan_name, p.price_monthly, p.max_users, p.max_invoices, p.ai_calls_limit, p.features FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.tenant_id=$1`, [tenantId]),
        pool.query('SELECT name, plan_id, trial_ends_at FROM tenants WHERE id=$1', [tenantId]),
        pool.query(`SELECT metric, value FROM usage_metrics WHERE tenant_id=$1 AND period=$2`, [tenantId, new Date().toISOString().slice(0,7)]),
      ]);

      const subscription = sub.rows[0] || { plan_id: 'free', status: 'trial', plan_name: 'Free', price_monthly: 0, features: [] };
      const usageMap: Record<string, number> = {};
      for (const u of usage.rows) usageMap[u.metric] = parseInt(u.value);

      // Get actual usage
      const [users, invoices, aiCalls] = await Promise.all([
        pool.query('SELECT COUNT(*) as count FROM users WHERE tenant_id=$1 AND is_active=TRUE', [tenantId]),
        pool.query(`SELECT COUNT(*) as count FROM ap_invoices WHERE tenant_id=$1 AND created_at >= date_trunc('month', CURRENT_DATE)`, [tenantId]),
        pool.query(`SELECT COALESCE(value,0) as count FROM usage_metrics WHERE tenant_id=$1 AND metric='ai_calls' AND period=$2`, [tenantId, new Date().toISOString().slice(0,7)]),
      ]);

      res.json({
        subscription,
        tenant: tenant.rows[0],
        trial_days_left: tenant.rows[0]?.trial_ends_at ? Math.max(0, Math.ceil((new Date(tenant.rows[0].trial_ends_at).getTime() - Date.now()) / 86400000)) : 0,
        usage: {
          users: { current: parseInt(users.rows[0].count), limit: subscription.max_users || 2 },
          invoices: { current: parseInt(invoices.rows[0].count), limit: subscription.max_invoices || 20 },
          ai_calls: { current: parseInt(aiCalls.rows[0]?.count || 0), limit: subscription.ai_calls_limit || 100 },
        },
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/billing/create-order ───────────────────────
  router.post('/create-order', requireAuth, requireRole('owner'), async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { plan_id, billing_cycle = 'monthly' } = req.body;
      const plan = PLANS[plan_id as keyof typeof PLANS];
      if (!plan) { res.status(400).json({ error: 'Invalid plan' }); return; }

      const amount = billing_cycle === 'yearly' ? plan.price_yearly : plan.price_monthly;
      if (amount === 0) { res.status(400).json({ error: 'Free plan does not require payment' }); return; }

      const razorpayKeyId  = process.env.RAZORPAY_KEY_ID;
      const razorpaySecret = process.env.RAZORPAY_KEY_SECRET;

      if (razorpayKeyId && razorpaySecret) {
        // Create real Razorpay order
        const response = await fetch('https://api.razorpay.com/v1/orders', {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from(`${razorpayKeyId}:${razorpaySecret}`).toString('base64'),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: amount * 100, // paise
            currency: 'INR',
            notes: { tenant_id: tenantId, plan_id, billing_cycle },
          }),
        });
        const order = await response.json() as any;
        if (!response.ok) throw new Error(order.error?.description || 'Razorpay error');

        await pool.query(
          `INSERT INTO payments (tenant_id, razorpay_order_id, amount, plan_id, description, status)
           VALUES ($1,$2,$3,$4,$5,'created')`,
          [tenantId, order.id, amount, plan_id, `${plan.name} plan - ${billing_cycle}`]
        );

        res.json({ order_id: order.id, amount, currency: 'INR', plan: plan.name, key_id: razorpayKeyId });
      } else {
        // Simulate order (no Razorpay configured)
        const orderId = `order_sim_${Date.now()}`;
        res.json({ order_id: orderId, amount, currency: 'INR', plan: plan.name, simulated: true, note: 'Configure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable real payments' });
      }
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/billing/verify-payment ─────────────────────
  router.post('/verify-payment', requireAuth, requireRole('owner'), async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { razorpay_payment_id, razorpay_order_id, razorpay_signature, plan_id, billing_cycle = 'monthly' } = req.body;

      const plan = PLANS[plan_id as keyof typeof PLANS];
      if (!plan) { res.status(400).json({ error: 'Invalid plan' }); return; }

      // Verify signature if Razorpay is configured
      if (process.env.RAZORPAY_KEY_SECRET && razorpay_signature) {
        const crypto = require('crypto');
        const expectedSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
          .update(`${razorpay_order_id}|${razorpay_payment_id}`)
          .digest('hex');
        if (expectedSig !== razorpay_signature) {
          res.status(400).json({ error: 'Payment signature verification failed' }); return;
        }
      }

      const periodEnd = billing_cycle === 'yearly'
        ? new Date(Date.now() + 365*24*60*60*1000)
        : new Date(Date.now() + 30*24*60*60*1000);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Update tenant plan
        await client.query(`UPDATE tenants SET plan_id=$1 WHERE id=$2`, [plan_id, tenantId]);

        // Create/update subscription
        await client.query(`
          INSERT INTO subscriptions (tenant_id, plan_id, status, razorpay_payment_id, current_period_end, amount, billing_cycle)
          VALUES ($1,$2,'active',$3,$4,$5,$6)
          ON CONFLICT (tenant_id) DO UPDATE SET plan_id=$2, status='active', razorpay_payment_id=$3, current_period_end=$4, amount=$5, billing_cycle=$6, updated_at=NOW()
        `, [tenantId, plan_id, razorpay_payment_id||`sim_${Date.now()}`, periodEnd, billing_cycle==='yearly'?plan.price_yearly:plan.price_monthly, billing_cycle]);

        // Record payment
        await client.query(`
          UPDATE payments SET status='captured', razorpay_payment_id=$1 WHERE razorpay_order_id=$2
        `, [razorpay_payment_id||`sim_${Date.now()}`, razorpay_order_id]);

        await client.query('COMMIT');
        res.json({ success: true, plan: plan.name, expires_at: periodEnd, message: `Successfully upgraded to ${plan.name}!` });
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally { client.release(); }
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/billing/cancel ──────────────────────────────
  router.post('/cancel', requireAuth, requireRole('owner'), async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      await pool.query(`UPDATE subscriptions SET status='cancelled', cancelled_at=NOW() WHERE tenant_id=$1`, [tenantId]);
      await pool.query(`UPDATE tenants SET plan_id='free' WHERE id=$1`, [tenantId]);
      res.json({ success: true, message: 'Subscription cancelled. Downgraded to Free plan.' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/billing/invoices ─────────────────────────────
  router.get('/invoices', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const result = await pool.query(`SELECT * FROM payments WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 20`, [tenantId]);
      res.json({ invoices: result.rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
