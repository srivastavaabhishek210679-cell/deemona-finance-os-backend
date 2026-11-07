// Adds DELETE /api/accounting/ar-invoices/:id and /ap-invoices/:id (only when no payment has been recorded). Idempotent. Run from the backend folder.
const fs=require('fs');const f='src/routes/accountingRoutes.ts';
if(!fs.existsSync(f)){console.error('Run from the backend folder');process.exit(1);}
const raw=fs.readFileSync(f,'utf8');const crlf=raw.includes('\r\n');let s=raw.replace(/\r\n/g,'\n');
if(s.includes("router.delete('/ar-invoices/:id'")){console.log('Already applied');process.exit(0);}
const a="  router.patch('/ap-invoices/:id/approve', requireAuth,";
if(!s.includes(a)){console.error('anchor not found');process.exit(1);}
const mk=(kind,table,label)=>`  router.delete('/${kind}-invoices/:id', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const id = String(req.params.id);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) { res.status(404).json({ error: 'Not found' }); return; }
      await client.query('BEGIN');
      const inv = await client.query(\`SELECT id, invoice_number, paid_amount FROM ${table} WHERE id = $1 AND tenant_id = $2 FOR UPDATE\`, [id, tid(req)]);
      if (!inv.rows.length) { await client.query('ROLLBACK'); res.status(404).json({ error: '${label} not found' }); return; }
      let events = 0;
      try {
        const ev = await client.query(\`SELECT COUNT(*)::int AS n FROM invoice_payment_events WHERE tenant_id = $1 AND invoice_type = '${kind}' AND invoice_id = $2\`, [tid(req), id]);
        events = ev.rows[0].n;
      } catch { /* payment events table not created yet */ await client.query('ROLLBACK'); await client.query('BEGIN'); }
      if (Number(inv.rows[0].paid_amount || 0) > 0 || events > 0) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'This ${label.toLowerCase()} has payments recorded, so it cannot be deleted.' });
        return;
      }
      await client.query(\`DELETE FROM ${kind}_invoice_lines WHERE ${kind}_invoice_id = $1\`, [id]);
      await client.query(\`DELETE FROM ${table} WHERE id = $1 AND tenant_id = $2\`, [id, tid(req)]);
      await client.query('COMMIT');
      console.log('[accounting] ${label.toLowerCase()} ' + inv.rows[0].invoice_number + ' deleted by ' + ((req as any).user.email || (req as any).user.id));
      res.json({ deleted: true, invoice_number: inv.rows[0].invoice_number });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if (err && err.code === '23503') { res.status(409).json({ error: 'This record is linked to other records (such as payments), so it cannot be deleted.' }); return; }
      res.status(500).json({ error: String(err) });
    } finally { client.release(); }
  });

`;
s=s.replace(a,()=>mk('ar','ar_invoices','Invoice')+mk('ap','ap_invoices','Bill')+a);
fs.writeFileSync(f,crlf?s.replace(/\n/g,'\r\n'):s);console.log('Done');
