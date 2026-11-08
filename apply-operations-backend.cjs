// Operations hardening. Run from the backend folder. Idempotent.
const fs=require('fs');
function rw(p,fn){let s=fs.readFileSync(p,'utf8');const crlf=s.includes('\r\n');if(crlf)s=s.replace(/\r\n/g,'\n');const t=fn(s);if(t===s){console.log('no change',p);return;}fs.writeFileSync(p,crlf?t.replace(/\n/g,'\r\n'):t);console.log('patched',p);}
// 1. scheduled jobs: every company, not just the first 20
rw('src/services/automationEngine.ts',s=>s.split('SELECT id FROM tenants LIMIT 20').join('SELECT id FROM tenants ORDER BY created_at LIMIT 1000'));
// 2. health check that really tests the database, plus crash logging
rw('src/index.ts',s=>{
  if(s.includes('/*ops-health*/'))return s;
  const a=`app.get('/health', (_req, res) => {
  res.json({ status: 'ok', app: 'Deemona AI Finance OS', timestamp: new Date().toISOString() });
});`;
  if(s.split(a).length!==2){console.log('health anchor not found');process.exitCode=1;return s;}
  const b=`/*ops-health*/
app.get('/health', async (_req, res) => {
  const t0 = Date.now();
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', db_ms: Date.now() - t0, uptime_s: Math.round(process.uptime()), app: 'Deemona AI Finance OS', timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('[health] database check failed', e);
    res.status(503).json({ status: 'degraded', db: 'down', timestamp: new Date().toISOString() });
  }
});
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));`;
  return s.replace(a,()=>b);
});
