// (1) Finance Memory endpoints use the real login check, (2) CFO brief logs its real error, model can be set by CFO_MODEL. Idempotent.
const fs=require('fs');
function rw(p,fn){let s=fs.readFileSync(p,'utf8');const crlf=s.includes('\r\n');if(crlf)s=s.replace(/\r\n/g,'\n');const t=fn(s);if(t===s){console.log('no change',p);return;}fs.writeFileSync(p,crlf?t.replace(/\n/g,'\r\n'):t);console.log('patched',p);}
function must(s,a){if(s.split(a).length!==2){console.log('ANCHOR NOT FOUND:',a.slice(0,80));process.exit(1);}}
rw('src/routes/memoryRoutes.ts',s=>{
  if(s.includes('/*mem-auth*/'))return s;
  const a=`  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!(req as any).user?.tenantId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };`;
  must(s,a);
  s=s.replace(a,()=>`  /*mem-auth*/ // uses the shared JWT check (the old local check expected req.user to be set upstream, which never happened)`);
  const imp=`import { getMemoryService, WriteMemoryInput, MemorySearchOptions, MemoryService } from '../services/memoryService';`;
  must(s,imp);
  return s.replace(imp,()=>imp+`\nimport { requireAuth } from '../middleware/auth';`);
});
rw('src/routes/cfoAgentRoutes.ts',s=>{
  if(s.includes('/*cfo-brief-log*/'))return s;
  const m=`const MODEL = 'claude-sonnet-4-6';`;
  must(s,m);
  s=s.replace(m,()=>`const MODEL = process.env.CFO_MODEL || 'claude-sonnet-4-6';`);
  const a=`      const { answer, tools_used } = await agentLoop(pool, tid(req), [], q);
      res.json({ text: answer, tools_used });
    } catch (err) { res.status(500).json({ error: String(err) }); }`;
  must(s,a);
  return s.replace(a,()=>`      const { answer, tools_used } = await agentLoop(pool, tid(req), [], q);
      res.json({ text: answer, tools_used });
    } catch (err) { console.error('[cfo/brief] /*cfo-brief-log*/', err); res.status(500).json({ error: String(err) }); }`);
});
