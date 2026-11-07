// Cash Flow statement: receipts/payments come from recorded payment events, opening/closing from the manual cash balance.
// Idempotent. Run from the backend folder (after apply-manual-cash-backend.cjs).
const fs=require('fs');const f='src/routes/statementsRoutes.ts';
if(!fs.existsSync(f)){console.error('Run from the backend folder');process.exit(1);}
const raw=fs.readFileSync(f,'utf8');const crlf=raw.includes('\r\n');let s=raw.replace(/\r\n/g,'\n');
if(s.includes('/*cfs-events*/')){console.log('Already applied');process.exit(0);}
if(!s.includes("import { cashAsOf }")){console.error('Apply apply-manual-cash-backend.cjs first');process.exit(1);}
const a=s.indexOf("      // Operating: customer receipts and vendor payments");
const b=s.indexOf("      const operatingInflow  = parseFloat(receipts.rows[0].total);");
if(a<0||b<0||b<a){console.error('cash flow block not found');process.exit(1);}
const nb=`      // Operating: customer receipts and vendor payments (recorded payment events). /*cfs-events*/
      await ensurePaymentEventsTable(pool);
      const receipts = await pool.query(\`
        SELECT COALESCE(SUM(amount), 0) as total FROM invoice_payment_events
        WHERE tenant_id = $1 AND invoice_type = 'ar' AND payment_date BETWEEN $2 AND $3
      \`, [tenantId, fromDate, toDate]);

      const payments = await pool.query(\`
        SELECT COALESCE(SUM(amount), 0) as total FROM invoice_payment_events
        WHERE tenant_id = $1 AND invoice_type = 'ap' AND payment_date BETWEEN $2 AND $3
      \`, [tenantId, fromDate, toDate]);

      // Salaries and taxes paid are not recorded as dated payments yet.
      const salaries = { rows: [{ total: '0' }] };
      const taxes = { rows: [{ total: '0' }] };

      // Investing: asset purchases
      const assetPurchases = await pool.query(\`
        SELECT COALESCE(SUM(purchase_price), 0) as total
        FROM fixed_assets
        WHERE tenant_id = $1 AND purchase_date BETWEEN $2 AND $3
      \`, [tenantId, fromDate, toDate]);

      // Opening and closing cash come from the manual cash balance plus recorded receipts and payments.
      const dayBefore = new Date(new Date(fromDate + 'T00:00:00Z').getTime() - 86400000).toISOString().split('T')[0];
      const cOpen = await cashAsOf(pool, tenantId, dayBefore);
      const cClose = await cashAsOf(pool, tenantId, toDate);
      const openingBal = { rows: [{ total: String(cOpen.amount) }] };
      const closingBal = { rows: [{ total: String(cClose.amount) }] };

`;
s=s.slice(0,a)+nb+s.slice(b);
fs.writeFileSync(f,crlf?s.replace(/\n/g,'\r\n'):s);console.log('Done');
