// Disables every write path for bank statement data. Idempotent. Run from the backend folder.
// Escape hatch: set BANK_DATA_DISABLED=false on Render to re-enable.
const fs=require('fs');
const T="/*bankoff*/";
const G=(extra)=>"if (process.env.BANK_DATA_DISABLED !== 'false') { "+extra+" } "+T;
function edit(file, steps){
  if(!fs.existsSync(file)){console.error('Missing '+file+' (run from the backend folder)');process.exit(1);}
  const raw=fs.readFileSync(file,'utf8'); const crlf=raw.includes('\r\n'); let s=raw.replace(/\r\n/g,'\n'); let n=0;
  for(const [find,rep] of steps){
    if(s.includes(rep)) continue;
    if(!s.includes(find)){console.error('NOT FOUND in '+file+': '+find.slice(0,70));process.exit(1);}
    s=s.replace(find,()=>rep); n++;
  }
  if(n){fs.writeFileSync(file,crlf?s.replace(/\n/g,'\r\n'):s);} console.log((n?'patched ':'already ')+file);
}
const deny="res.status(410).json({ error: 'Bank data storage is disabled' }); return;";
const H=(m,p)=>m+"('"+p+"', requireAuth, async (req: Request, res: Response) => {";
edit('src/routes/treasuryRoutes.ts',[
 [H('router.post','/bank-accounts'), H('router.post','/bank-accounts')+"\n    "+G(deny)],
 [H('router.patch','/bank-accounts/:id'), H('router.patch','/bank-accounts/:id')+"\n    "+G(deny)],
 [H('router.post','/transactions'), H('router.post','/transactions')+"\n    "+G(deny)],
]);
edit('src/routes/paymentEventsRoutes.ts',[
 ["if (bank_account_id) {","if (bank_account_id && process.env.BANK_DATA_DISABLED === 'false') { "+T],
]);
const svc=(fn)=>{const re=new RegExp('(export async function '+fn+'\\([^{]*\\{)');return re;};
{ const f='src/services/crossModuleService.ts'; const raw=fs.readFileSync(f,'utf8'); const crlf=raw.includes('\r\n'); let s=raw.replace(/\r\n/g,'\n'); let n=0;
  for(const fn of ['postAPPaymentToTreasury','postARReceiptToTreasury']){
    const re=svc(fn); const m=s.match(re); if(!m){console.error('NOT FOUND '+fn);process.exit(1);}
    const after=s.slice(m.index+m[0].length,m.index+m[0].length+120); if(after.includes(T)) continue;
    s=s.replace(re,(a)=>a+"\n  if (process.env.BANK_DATA_DISABLED !== 'false') return; "+T); n++; }
  if(n)fs.writeFileSync(f,crlf?s.replace(/\n/g,'\r\n'):s); console.log((n?'patched ':'already ')+f); }
edit('src/routes/universalPollerRoutes.ts',[["'inventory_items', 'bank_transactions', 'payments',","'inventory_items', 'payments', "+T]]);
edit('src/routes/dataIngestionRoutes.ts',[["case 'BANK_TRANSACTIONS': {","case 'BANK_TRANSACTIONS': { break; } "+T+"\n          case '__bank_disabled__': {"]]);
console.log('Done. Next: run the SQL in Neon, then git add/commit/push.');
