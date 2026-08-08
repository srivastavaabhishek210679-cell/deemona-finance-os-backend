import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';

export function createTallyRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user.tenantId;

  // ── Helper: format date for Tally ────────────────────────
  const tallyDate = (d: string | Date): string => {
    const dt = new Date(d);
    return `${dt.getFullYear()}${String(dt.getMonth()+1).padStart(2,'0')}${String(dt.getDate()).padStart(2,'0')}`;
  };

  // ── Helper: escape XML special chars ─────────────────────
  const esc = (s: any): string => String(s||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&apos;');

  // ── GET /api/tally/export/vouchers ───────────────────────
  // Exports journal entries as Tally XML vouchers
  router.get('/export/vouchers', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { from, to, type = 'all' } = req.query;

      const fromDate = from as string || new Date(new Date().getFullYear(), 3, 1).toISOString().split('T')[0];
      const toDate   = to   as string || new Date().toISOString().split('T')[0];

      const tenant = await pool.query('SELECT * FROM tenants WHERE id=$1', [tenantId]);
      const company = tenant.rows[0];

      // Get journal entries
      const journals = await pool.query(`
        SELECT je.*, array_agg(json_build_object(
          'account_code', a.code, 'account_name', a.name, 'account_type', a.type,
          'debit', jel.debit, 'credit', jel.credit, 'narration', jel.narration
        )) as lines
        FROM journal_entries je
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN accounts a ON a.id = jel.account_id
        WHERE je.tenant_id = $1 AND je.date BETWEEN $2 AND $3 AND je.status = 'posted'
        GROUP BY je.id ORDER BY je.date
      `, [tenantId, fromDate, toDate]);

      // Get AP invoices as purchase vouchers
      const apInvoices = await pool.query(`
        SELECT ap.*, v.name as vendor_name, v.gstin as vendor_gstin
        FROM ap_invoices ap LEFT JOIN vendors v ON v.id=ap.vendor_id
        WHERE ap.tenant_id=$1 AND ap.date BETWEEN $2 AND $3 AND ap.status NOT IN ('draft','rejected')
        ORDER BY ap.date
      `, [tenantId, fromDate, toDate]);

      // Get AR invoices as sales vouchers
      const arInvoices = await pool.query(`
        SELECT ar.*, c.name as customer_name, c.gstin as customer_gstin
        FROM ar_invoices ar LEFT JOIN customers c ON c.id=ar.customer_id
        WHERE ar.tenant_id=$1 AND ar.date BETWEEN $2 AND $3 AND ar.status NOT IN ('draft','cancelled')
        ORDER BY ar.date
      `, [tenantId, fromDate, toDate]);

      // Get payments from bank transactions
      const payments = await pool.query(`
        SELECT * FROM bank_transactions
        WHERE tenant_id=$1 AND date BETWEEN $2 AND $3
        ORDER BY date
      `, [tenantId, fromDate, toDate]);

      // Build Tally XML
      let xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${esc(company?.name || 'Company')}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;

      // Journal entries → Journal vouchers
      for (const je of journals.rows) {
        const lines = Array.isArray(je.lines) ? je.lines : [];
        const debitLines  = lines.filter((l: any) => parseFloat(l.debit)  > 0);
        const creditLines = lines.filter((l: any) => parseFloat(l.credit) > 0);

        xml += `          <VOUCHER VCHTYPE="Journal" ACTION="Create">
            <DATE>${tallyDate(je.date)}</DATE>
            <VOUCHERNUMBER>${esc(je.reference_number || je.id.slice(0,8))}</VOUCHERNUMBER>
            <NARRATION>${esc(je.narration || je.description || '')}</NARRATION>
            <VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>\n`;

        for (const line of debitLines) {
          xml += `            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${esc(line.account_name)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${parseFloat(line.debit).toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>\n`;
        }
        for (const line of creditLines) {
          xml += `            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${esc(line.account_name)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${parseFloat(line.credit).toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>\n`;
        }
        xml += `          </VOUCHER>\n`;
      }

      // AP invoices → Purchase vouchers
      for (const ap of apInvoices.rows) {
        xml += `          <VOUCHER VCHTYPE="Purchase" ACTION="Create">
            <DATE>${tallyDate(ap.date)}</DATE>
            <VOUCHERNUMBER>${esc(ap.invoice_number)}</VOUCHERNUMBER>
            <NARRATION>Purchase from ${esc(ap.vendor_name)} - Invoice ${esc(ap.invoice_number)}</NARRATION>
            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
            <PARTYLEDGERNAME>${esc(ap.vendor_name)}</PARTYLEDGERNAME>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${esc(ap.vendor_name)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${parseFloat(ap.total_amount).toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Purchase Account</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${parseFloat(ap.subtotal).toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            ${parseFloat(ap.tax_amount) > 0 ? `<ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>GST Input Credit</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${parseFloat(ap.tax_amount).toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>` : ''}
          </VOUCHER>\n`;
      }

      // AR invoices → Sales vouchers
      for (const ar of arInvoices.rows) {
        xml += `          <VOUCHER VCHTYPE="Sales" ACTION="Create">
            <DATE>${tallyDate(ar.date)}</DATE>
            <VOUCHERNUMBER>${esc(ar.invoice_number)}</VOUCHERNUMBER>
            <NARRATION>Sale to ${esc(ar.customer_name)} - Invoice ${esc(ar.invoice_number)}</NARRATION>
            <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
            <PARTYLEDGERNAME>${esc(ar.customer_name)}</PARTYLEDGERNAME>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${esc(ar.customer_name)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${parseFloat(ar.total_amount).toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Sales Account</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${parseFloat(ar.subtotal).toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            ${parseFloat(ar.tax_amount) > 0 ? `<ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>GST Payable</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${parseFloat(ar.tax_amount).toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>` : ''}
          </VOUCHER>\n`;
      }

      // Bank transactions → Receipt/Payment vouchers
      for (const txn of payments.rows) {
        const vchType = txn.type === 'credit' ? 'Receipt' : 'Payment';
        xml += `          <VOUCHER VCHTYPE="${vchType}" ACTION="Create">
            <DATE>${tallyDate(txn.date)}</DATE>
            <VOUCHERNUMBER>${esc(txn.id?.slice(0,8) || '')}</VOUCHERNUMBER>
            <NARRATION>${esc(txn.description)}</NARRATION>
            <VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Bank Account</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${txn.type === 'credit' ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
              <AMOUNT>${txn.type === 'credit' ? '-' : ''}${parseFloat(txn.amount).toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${txn.type === 'credit' ? 'Debtors' : 'Creditors'}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${txn.type === 'credit' ? 'No' : 'Yes'}</ISDEEMEDPOSITIVE>
              <AMOUNT>${txn.type === 'credit' ? '' : '-'}${parseFloat(txn.amount).toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>\n`;
      }

      xml += `        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

      const totalVouchers = journals.rows.length + apInvoices.rows.length + arInvoices.rows.length + payments.rows.length;

      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="deemona-tally-${fromDate}-to-${toDate}.xml"`);
      res.send(xml);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/tally/export/masters ────────────────────────
  // Exports ledger masters (accounts, vendors, customers)
  router.get('/export/masters', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);

      const [accounts, vendors, customers, tenant] = await Promise.all([
        pool.query('SELECT * FROM accounts WHERE tenant_id=$1 ORDER BY code', [tenantId]),
        pool.query('SELECT * FROM vendors WHERE tenant_id=$1 AND is_active=TRUE', [tenantId]),
        pool.query('SELECT * FROM customers WHERE tenant_id=$1 AND is_active=TRUE', [tenantId]),
        pool.query('SELECT * FROM tenants WHERE id=$1', [tenantId]),
      ]);

      const company = tenant.rows[0];

      // Map account types to Tally groups
      const tallyGroup = (type: string, sub: string): string => {
        if (type === 'asset' && sub?.includes('current')) return 'Current Assets';
        if (type === 'asset' && sub?.includes('fixed'))   return 'Fixed Assets';
        if (type === 'liability' && sub?.includes('current')) return 'Current Liabilities';
        if (type === 'equity') return 'Capital Account';
        if (type === 'income')  return 'Sales Accounts';
        if (type === 'expense') return 'Indirect Expenses';
        return 'Sundry Debtors';
      };

      let xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${esc(company?.name || 'Company')}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;

      // Ledger masters from chart of accounts
      for (const acc of accounts.rows) {
        xml += `          <LEDGER NAME="${esc(acc.name)}" ACTION="Create">
            <NAME>${esc(acc.name)}</NAME>
            <PARENT>${esc(tallyGroup(acc.type, acc.sub_type))}</PARENT>
            <OPENINGBALANCE>${parseFloat(acc.opening_balance || 0).toFixed(2)}</OPENINGBALANCE>
          </LEDGER>\n`;
      }

      // Vendor ledgers
      for (const v of vendors.rows) {
        xml += `          <LEDGER NAME="${esc(v.name)}" ACTION="Create">
            <NAME>${esc(v.name)}</NAME>
            <PARENT>Sundry Creditors</PARENT>
            <GSTREGISTRATIONTYPE>${v.gstin ? 'Regular' : 'Unregistered'}</GSTREGISTRATIONTYPE>
            <GSTIN.LIST><GSTIN>${esc(v.gstin || '')}</GSTIN></GSTIN.LIST>
          </LEDGER>\n`;
      }

      // Customer ledgers
      for (const c of customers.rows) {
        xml += `          <LEDGER NAME="${esc(c.name)}" ACTION="Create">
            <NAME>${esc(c.name)}</NAME>
            <PARENT>Sundry Debtors</PARENT>
            <GSTREGISTRATIONTYPE>${c.gstin ? 'Regular' : 'Unregistered'}</GSTREGISTRATIONTYPE>
            <GSTIN.LIST><GSTIN>${esc(c.gstin || '')}</GSTIN></GSTIN.LIST>
          </LEDGER>\n`;
      }

      xml += `        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="deemona-tally-masters.xml"`);
      res.send(xml);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/tally/summary ────────────────────────────────
  // Returns counts of exportable data
  router.get('/summary', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { from, to } = req.query;
      const fromDate = from as string || new Date(new Date().getFullYear(), 3, 1).toISOString().split('T')[0];
      const toDate   = to   as string || new Date().toISOString().split('T')[0];

      const [journals, ap, ar, txns, accounts, vendors, customers] = await Promise.all([
        pool.query(`SELECT COUNT(*) as count FROM journal_entries WHERE tenant_id=$1 AND date BETWEEN $2 AND $3 AND status='posted'`, [tenantId, fromDate, toDate]),
        pool.query(`SELECT COUNT(*) as count FROM ap_invoices WHERE tenant_id=$1 AND date BETWEEN $2 AND $3 AND status NOT IN ('draft','rejected')`, [tenantId, fromDate, toDate]),
        pool.query(`SELECT COUNT(*) as count FROM ar_invoices WHERE tenant_id=$1 AND date BETWEEN $2 AND $3 AND status NOT IN ('draft','cancelled')`, [tenantId, fromDate, toDate]),
        pool.query(`SELECT COUNT(*) as count FROM bank_transactions WHERE tenant_id=$1 AND date BETWEEN $2 AND $3`, [tenantId, fromDate, toDate]),
        pool.query(`SELECT COUNT(*) as count FROM accounts WHERE tenant_id=$1`, [tenantId]),
        pool.query(`SELECT COUNT(*) as count FROM vendors WHERE tenant_id=$1 AND is_active=TRUE`, [tenantId]),
        pool.query(`SELECT COUNT(*) as count FROM customers WHERE tenant_id=$1 AND is_active=TRUE`, [tenantId]),
      ]);

      res.json({
        period: { from: fromDate, to: toDate },
        vouchers: {
          journal_entries: parseInt(journals.rows[0].count),
          purchase_vouchers: parseInt(ap.rows[0].count),
          sales_vouchers: parseInt(ar.rows[0].count),
          payment_receipts: parseInt(txns.rows[0].count),
          total: parseInt(journals.rows[0].count) + parseInt(ap.rows[0].count) + parseInt(ar.rows[0].count) + parseInt(txns.rows[0].count),
        },
        masters: {
          ledgers: parseInt(accounts.rows[0].count),
          vendors: parseInt(vendors.rows[0].count),
          customers: parseInt(customers.rows[0].count),
          total: parseInt(accounts.rows[0].count) + parseInt(vendors.rows[0].count) + parseInt(customers.rows[0].count),
        },
      });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
