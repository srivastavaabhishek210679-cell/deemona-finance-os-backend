// Restores the /api prefix when the host's proxy strips it. Switched on by PROXY_STRIPS_API=1. Idempotent.
const fs=require('fs');const p='src/index.ts';
let s=fs.readFileSync(p,'utf8');
if(s.includes('/*proxy-prefix*/')){console.log('already patched');process.exit(0);}
const crlf=s.includes('\r\n');if(crlf)s=s.replace(/\r\n/g,'\n');
const a="app.set('trust proxy', 1); // Required for Render/reverse proxy";
if(s.split(a).length!==2){console.log('anchor not found');process.exit(1);}
const b=a+`
/*proxy-prefix*/
// MilesWeb's proxy forwards /api/x as /x. Put the prefix back so existing routes match.
if (process.env.PROXY_STRIPS_API === '1') {
  app.use((req, _res, next) => {
    if (!req.url.startsWith('/api/') && req.url !== '/api' && !req.url.startsWith('/health')) req.url = '/api' + req.url;
    next();
  });
}`;
s=s.replace(a,()=>b);
fs.writeFileSync(p,crlf?s.replace(/\n/g,'\r\n'):s);console.log('patched',p);
