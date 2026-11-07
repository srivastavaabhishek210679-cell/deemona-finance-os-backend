// Fixed asset purchases reduce cash (dated by purchase_date, after the latest manual cash entry). Idempotent. Run from the backend folder.
const fs=require('fs');const f='src/services/cashPosition.ts';
if(!fs.existsSync(f)){console.error('Run from the backend folder (apply-manual-cash-backend.cjs first)');process.exit(1);}
const raw=fs.readFileSync(f,'utf8');const crlf=raw.includes('\r\n');let s=raw.replace(/\r\n/g,'\n');
if(s.includes('/*asset-cash*/')){console.log('Already applied');process.exit(0);}
const a="  const entryAmount = parseFloat(e.rows[0].amount);\n  const movement = parseFloat(m.rows[0].net);";
if(!s.includes(a)){console.error('anchor not found');process.exit(1);}
s=s.replace(a,()=>`  const entryAmount = parseFloat(e.rows[0].amount);
  // Fixed asset purchases made after the entry date also reduce cash. /*asset-cash*/
  let assetSpend = 0;
  try {
    const fa = await pool.query(
      \`SELECT COALESCE(SUM(purchase_price), 0) AS total FROM fixed_assets
       WHERE tenant_id = $1 AND purchase_date > $2 AND purchase_date <= $3\`,
      [tenantId, e.rows[0].as_of, d]);
    assetSpend = parseFloat(fa.rows[0].total) || 0;
  } catch { /* fixed_assets not available: ignore */ }
  const movement = parseFloat(m.rows[0].net) - assetSpend;`);
fs.writeFileSync(f,crlf?s.replace(/\n/g,'\r\n'):s);console.log('Done');
