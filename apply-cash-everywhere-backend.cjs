// Points every remaining "cash balance" query at the manual cash balance. Idempotent. Run from the backend folder.
// Requires apply-manual-cash-backend.cjs to have been applied first (src/services/cashPosition.ts).
const fs=require('fs');
if(!fs.existsSync('src/services/cashPosition.ts')){console.error('Apply apply-manual-cash-backend.cjs first');process.exit(1);}
const re=/pool\.query\(\s*(["`'])SELECT COALESCE\(SUM\((?:current_balance|balance)\),\s*0\)\s+as\s+(\w+)\s+FROM bank_accounts WHERE tenant_id=\$1[^"'`]*\1\s*,\s*\[([^\]]+)\]\s*\)/g;
const files=[['src/services/automationEngine.ts','./cashPosition'],['src/routes/phase1Routes.ts','../services/cashPosition'],['src/routes/dashboardRoutes.ts','../services/cashPosition'],['src/routes/auditAgentRoutes.ts','../services/cashPosition'],['src/routes/missingDocsRoutes.ts','../services/cashPosition'],['src/routes/forecastingRoutes.ts','../services/cashPosition']];
let total=0;
for(const [f,rel] of files){
  if(!fs.existsSync(f)){console.error('Missing '+f);process.exit(1);}
  const raw=fs.readFileSync(f,'utf8');const crlf=raw.includes('\r\n');let s=raw.replace(/\r\n/g,'\n');
  let n=0;
  s=s.replace(re,(m,q,alias,arg)=>{n++;return `cashAsOf(pool, ${arg.trim()}).then((c: any) => ({ rows: [{ ${alias}: c.amount }] }))`;});
  if(n&&!s.includes('cashAsOf }')){ const i=s.search(/^import /m); s=s.slice(0,i)+`import { cashAsOf } from '${rel}';\n`+s.slice(i); }
  if(n){fs.writeFileSync(f,crlf?s.replace(/\n/g,'\r\n'):s);}
  console.log((n?'patched ':'nothing to do ')+f+(n?' ('+n+')':''));total+=n;
}
console.log('Done: '+total+' queries switched.');
