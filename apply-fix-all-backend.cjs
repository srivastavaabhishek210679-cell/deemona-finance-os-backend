// Backend: (1) live-updates stream accepts the token in the URL (stream path only), (2) sensible runway cap. Idempotent.
const fs=require('fs');
function rw(p,fn){let s=fs.readFileSync(p,'utf8');const crlf=s.includes('\r\n');if(crlf)s=s.replace(/\r\n/g,'\n');const t=fn(s);if(t===s){console.log('no change',p);return;}fs.writeFileSync(p,crlf?t.replace(/\n/g,'\r\n'):t);console.log('patched',p);}
function must(s,a){if(s.split(a).length<2){console.log('ANCHOR NOT FOUND:',a.slice(0,70));process.exit(1);}}
rw('src/middleware/auth.ts',s=>{
  if(s.includes('/*sse-token*/'))return s;
  const a=`  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader.slice(7);`;
  must(s,a);
  const b=`  /*sse-token*/
  const authHeader = req.headers.authorization;
  // Browsers cannot set headers on EventSource, so the live-updates stream (and only it) may pass ?token=
  const isStream = req.method === 'GET' && (req.originalUrl || '').split('?')[0] === '/api/events/stream';
  const qToken = isStream && typeof req.query.token === 'string' ? req.query.token : '';
  if (!authHeader?.startsWith('Bearer ') && !qToken) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : qToken;`;
  return s.replace(a,()=>b);
});
rw('src/routes/cfoAgentRoutes.ts',s=>{
  if(s.includes('/*runway-cap*/'))return s;
  const old='runway.runway_days_gross != null ? parseFloat((runway.runway_days_gross / 30).toFixed(1)) : 0,';
  const n=s.split(old).length-1; if(n<1){console.log('runway anchor missing');process.exit(1);}
  s=s.split(old).join('runway.runway_days_gross != null ? Math.min(36, parseFloat((runway.runway_days_gross / 30).toFixed(1))) : 0, /*runway-cap*/');
  const old2='runway?.runway_days_gross != null ? parseFloat((runway.runway_days_gross / 30).toFixed(1)) : null,';
  s=s.split(old2).join('runway?.runway_days_gross != null ? Math.min(36, parseFloat((runway.runway_days_gross / 30).toFixed(1))) : null,');
  return s;
});
