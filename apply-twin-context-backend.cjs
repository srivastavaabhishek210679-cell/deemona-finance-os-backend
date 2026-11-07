// Adds GET /api/cfo/twin-context to src/routes/cfoAgentRoutes.ts (idempotent, CRLF-aware).
// Run from the backend repo root:  node apply-twin-context-backend.cjs
const fs = require('fs'), path = require('path');
const file = path.join(process.cwd(), 'src', 'routes', 'cfoAgentRoutes.ts');
if (!fs.existsSync(file)) { console.error('Not found: ' + file + ' - run this from the backend repo root.'); process.exit(1); }
const raw = fs.readFileSync(file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let s = raw.replace(/\r\n/g, '\n');
if (s.includes("'/twin-context'")) { console.log('Already applied - nothing to do.'); process.exit(0); }
const anchor = "  // ── GET /api/cfo/metrics — list;";
const at = s.indexOf(anchor);
if (at < 0) { console.error('Anchor not found; file differs from expected. No changes made.'); process.exit(1); }
const block = `  // ── GET /api/cfo/twin-context — real baseline figures for the Digital Twin (null where the books have no data) ──
  router.get('/twin-context', requireAuth, async (req: Request, res: Response) => {
    try {
      const t = tid(req);
      const [cash, runway, wc, pnl, emp]: any[] = await Promise.all([
        runMetric(pool, t, 'cash_position', {}), runMetric(pool, t, 'cash_runway', {}), runMetric(pool, t, 'working_capital', {}),
        runMetric(pool, t, 'pnl_trend', { months: 13 }),
        pool.query(\`SELECT COUNT(*)::int AS n FROM employees WHERE tenant_id=$1 AND status='active'\`, [t]).catch(() => null),
      ]);
      // completed months only (the last pnl month is month-to-date), starting from the first month with any activity
      const all: any[] = Array.isArray(pnl?.months) ? pnl.months.filter((m: any) => !m.partial_month) : [];
      const firstActive = all.findIndex((m: any) => (m.revenue || 0) > 0 || (m.vendor_costs || 0) + (m.payroll || 0) + (m.expense_claims || 0) > 0);
      const covered: any[] = firstActive >= 0 ? all.slice(firstActive) : [];
      const n = covered.length;
      const sum = (f: (m: any) => number) => covered.reduce((a, m) => a + (f(m) || 0), 0);
      const revenue = sum(m => m.revenue);
      const costs = sum(m => m.vendor_costs + m.payroll + m.expense_claims);
      const ebitda = sum(m => m.ebitda);
      const employees = emp?.rows?.[0]?.n > 0 ? emp.rows[0].n : null;
      res.json({
        as_of: new Date().toISOString(), currency: 'INR',
        months_covered: n,
        basis: n > 0 ? 'Average of the last ' + n + ' completed month(s) of invoices, payroll and approved claims, annualised for revenue. Not a general-ledger P&L.' : 'No invoices, payroll or claims found - nothing to prefill.',
        baseline: {
          annual_revenue: n > 0 && revenue > 0 ? Math.round((revenue / n) * 12) : null,
          monthly_opex: n > 0 && costs > 0 ? Math.round(costs / n) : null,
          employees,
        },
        position: {
          cash: cash?.total_cash ?? null,
          runway_months: runway?.runway_days_gross != null ? parseFloat((runway.runway_days_gross / 30).toFixed(1)) : null,
          net_monthly_burn: runway?.net_monthly_burn ?? null,
          receivables: wc?.receivables ?? null, payables: wc?.payables ?? null, working_capital: wc?.working_capital ?? null,
          dso_days: wc?.dso_days ?? null, ar_overdue: wc?.ar_overdue ?? null,
          ebitda_margin_pct: n > 0 && revenue > 0 ? parseFloat(((ebitda / revenue) * 100).toFixed(1)) : null,
        },
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

`;
s = s.slice(0, at) + block + s.slice(at);
fs.writeFileSync(file, s.replace(/\n/g, eol), 'utf8');
console.log('Added GET /api/cfo/twin-context to src/routes/cfoAgentRoutes.ts');
