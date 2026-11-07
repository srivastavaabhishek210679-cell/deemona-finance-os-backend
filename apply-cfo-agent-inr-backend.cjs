// Digital CFO agent: give every money figure a ready-written "_inr" text twin so the model copies amounts instead of
// formatting them (it can misread Indian digit grouping). Idempotent. Run from the backend folder.
// Needs apply-specialist-agents-backend.cjs applied first (it provides withInrText).
const fs=require('fs');
const f='src/routes/cfoAgentRoutes.ts';
if(!fs.existsSync(f)||!fs.existsSync('src/routes/specialistAgentRoutes.ts')){console.error('Run from the backend folder, after applying apply-specialist-agents-backend.cjs');process.exit(1);}
const raw=fs.readFileSync(f,'utf8');const crlf=raw.includes('\r\n');let s=raw.replace(/\r\n/g,'\n');
if(s.includes('withInrText')){console.log('Already applied');process.exit(0);}
function rep(a,b,l){if(!s.includes(a)){console.error('Pattern not found: '+l);process.exit(1);}s=s.replace(a,()=>b);}
rep("import { METRICS, runMetric, recordSnapshot } from '../services/cfoMetrics';","import { METRICS, runMetric, recordSnapshot } from '../services/cfoMetrics';\nimport { withInrText } from './specialistAgentRoutes';",'import');
rep("let out = JSON.stringify(await runMetric(pool, tenantId, c.name, c.input));","let out = JSON.stringify(withInrText(await runMetric(pool, tenantId, c.name, c.input)));",'tool result');
rep("HOW TO ANSWER\n","HOW TO ANSWER\n- Money fields come with a ready-made text twin ending in \"_inr\" (for example \"total_cash_inr\": \"₹11.80 Cr\"). Copy those strings exactly. Never convert, re-spell, round or add up amounts, and never write amounts in words. If a field has no \"_inr\" twin, quote the number as the tool gives it.\n",'prompt');
fs.writeFileSync(f,crlf?s.replace(/\n/g,'\r\n'):s);console.log('Done: CFO agent now quotes pre-formatted amounts');
