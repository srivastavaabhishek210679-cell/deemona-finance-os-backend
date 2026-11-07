// Adds PATCH /api/accounting/ar-invoices/:id/send and /ap-invoices/:id/confirm so new invoices can take payments. Idempotent. Run from the backend folder.
const fs=require('fs');const f='src/routes/accountingRoutes.ts';
if(!fs.existsSync(f)){console.error('Run from the backend folder');process.exit(1);}
const raw=fs.readFileSync(f,'utf8');const crlf=raw.includes('\r\n');let s=raw.replace(/\r\n/g,'\n');
if(s.includes("/ar-invoices/:id/send")){console.log('Already applied');process.exit(0);}
const a="  router.patch('/ap-invoices/:id/approve', requireAuth,";
if(!s.includes(a)){console.error('anchor not found');process.exit(1);}
const add=`  router.patch('/ar-invoices/:id/send', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        \`UPDATE ar_invoices SET status='sent', updated_at=NOW() WHERE id=$1 AND tenant_id=$2 AND status='draft' RETURNING *\`,
        [req.params.id, tid(req)]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'Invoice not found or not a draft' }); return; }
      res.json({ invoice: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.patch('/ap-invoices/:id/confirm', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        \`UPDATE ap_invoices SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
         WHERE id=$2 AND tenant_id=$3 AND status IN ('draft','pending_approval') RETURNING *\`,
        [(req as any).user.id, req.params.id, tid(req)]
      );
      if (!result.rows.length) { res.status(404).json({ error: 'Bill not found or already processed' }); return; }
      res.json({ invoice: result.rows[0] });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

`;
s=s.replace(a,()=>add+a);
fs.writeFileSync(f,crlf?s.replace(/\n/g,'\r\n'):s);console.log('Done');
