// ============================================================
// Deemona AI Finance OS â€” Unified Data Ingestion Engine
// File: src/routes/dataIngestionRoutes.ts
// Single entry point for all data imports
// Supports: CSV, Excel, JSON, Manual entry
// Auto-detects: Sales, Expenses, Inventory, Payroll, AP, AR,
//               Bank Statements, Customers, Vendors, Assets
// ============================================================

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';
import * as XLSX from 'xlsx';
import { XMLParser } from 'fast-xml-parser';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function createDataIngestionRouter(pool: Pool): Router {
  const router = Router();
  const tid = (req: Request): string => (req as any).user?.tenantId;

  // â”€â”€ Helper: parse CSV string â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function parseCSV(text: string): { headers: string[], rows: Record<string, string>[] } {
    const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return { headers: [], rows: [] };
    
    // Auto-detect delimiter
    const firstLine = lines[0];
    const delimiter = (firstLine.split('\t').length > firstLine.split(',').length) ? '\t' : ',';
    
    const parseRow = (line: string): string[] => {
      if (delimiter === '\t') return line.split('\t').map(v => v.trim());
      const result: string[] = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') { inQuotes = !inQuotes; continue; }
        if (line[i] === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
        current += line[i];
      }
      result.push(current.trim());
      return result;
    };

    const headers = parseRow(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''));
    const rows = lines.slice(1).map(line => {
      const vals = parseRow(line);
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = vals[i] || ''; });
      return row;
    });
    return { headers, rows };
  }

  // â”€â”€ Helper: detect data type via AI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function detectDataType(headers: string[], sampleRows: Record<string, string>[]): Promise<string> {
    const sample = JSON.stringify({ headers, sample: sampleRows.slice(0, 3) });
    try {
      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: `Analyze these CSV headers and sample data and respond with ONLY one of these exact labels:
SALES_INVOICES, PURCHASE_INVOICES, EXPENSES, INVENTORY, PAYROLL, CUSTOMERS, VENDORS, BANK_TRANSACTIONS, ASSETS, JOURNAL_ENTRIES, UNKNOWN

Data: ${sample}

Respond with only the label, nothing else.`
        }]
      });
      return ((resp.content[0] as any).text || 'UNKNOWN').trim().toUpperCase();
    } catch {
      // Fallback: header-based detection
      const h = headers.join(' ').toLowerCase();
      if (h.includes('invoice') && (h.includes('customer') || h.includes('sale'))) return 'SALES_INVOICES';
      if (h.includes('invoice') && (h.includes('vendor') || h.includes('supplier'))) return 'PURCHASE_INVOICES';
      if (h.includes('expense') || h.includes('claim') || h.includes('reimburse')) return 'EXPENSES';
      if (h.includes('inventory') || h.includes('stock') || h.includes('sku') || h.includes('item')) return 'INVENTORY';
      if (h.includes('salary') || h.includes('payroll') || h.includes('employee') || h.includes('wage')) return 'PAYROLL';
      if (h.includes('customer') || h.includes('client') || h.includes('buyer')) return 'CUSTOMERS';
      if (h.includes('vendor') || h.includes('supplier') || h.includes('seller')) return 'VENDORS';
      if (h.includes('bank') || h.includes('transaction') || h.includes('debit') || h.includes('credit')) return 'BANK_TRANSACTIONS';
      if (h.includes('asset') || h.includes('equipment') || h.includes('depreciation')) return 'ASSETS';
      return 'UNKNOWN';
    }
  }

  // â”€â”€ Helper: AI field mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function mapFields(dataType: string, headers: string[], sampleRows: Record<string, string>[] = []): Promise<Record<string, string>> {
    const dbSchemas: Record<string, string[]> = {
      SALES_INVOICES: ['invoice_number','customer_name','date','due_date','total_amount','tax_amount','status','description','discount','currency','payment_terms','po_number'],
      PURCHASE_INVOICES: ['invoice_number','vendor_name','date','due_date','total_amount','tax_amount','status','description','department','cost_center'],
      EXPENSES: ['title','employee_name','category','date','total_amount','status','project','description','payment_method','approved_by'],
      INVENTORY: ['name','sku','category','quantity','unit_cost','reorder_level','unit_of_measure','location','supplier','barcode','hsn_code'],
      PAYROLL: ['employee_name','employee_id','department','designation','basic_salary','hra','other_allowances','pf_employee','tds','professional_tax','gross_salary','net_pay','month','bank_account','ifsc'],
      CUSTOMERS: ['name','email','phone','address','city','state','gstin','pan','credit_limit','payment_terms','contact_person','industry'],
      VENDORS: ['name','email','phone','address','city','state','gstin','pan','payment_terms','bank_account','ifsc','contact_person','category'],
      BANK_TRANSACTIONS: ['date','description','debit','credit','balance','reference','transaction_type','narration'],
      ASSETS: ['name','category','purchase_date','actual_cost','useful_life_years','depreciation_method','location','serial_number','manufacturer','warranty_expiry'],
    };
    const commonAliases: Record<string, string[]> = {
      invoice_number: ['invoice_no','inv_no','bill_no','ref_no','order_no','invoice#','bill#','doc_no'],
      customer_name: ['customer','client','buyer','bill_to','sold_to','party_name','party','debtor'],
      vendor_name: ['vendor','supplier','seller','party_name','party','creditor'],
      total_amount: ['amount','total','grand_total','invoice_amount','bill_amount','net_amount','value','gross'],
      due_date: ['due_date','payment_due','due_on','expiry','maturity_date','pay_by'],
      date: ['invoice_date','bill_date','order_date','transaction_date','created_date','doc_date','posting_date'],
      tax_amount: ['tax','gst','vat','tax_amount','gst_amount','igst','cgst','sgst','total_tax'],
      basic_salary: ['basic','salary','gross_salary','ctc','wage','basic_pay'],
      employee_name: ['employee','staff','name','emp_name','worker','emp_name'],
      unit_cost: ['cost','price','unit_price','rate','mrp','selling_price','purchase_price'],
      quantity: ['qty','stock','units','count','available_qty','on_hand'],
      net_pay: ['net','take_home','net_salary','in_hand','disbursed'],
      description: ['narration','remarks','notes','details','particulars','memo','comments'],
    };
    const targetFields = dbSchemas[dataType] || [];
    const mapping: Record<string, string> = {};
    const usedHeaders = new Set<string>();
    for (const target of targetFields) {
      const aliases = commonAliases[target] || [];
      const allAliases = [target, ...aliases];
      const match =
        headers.find(h => h === target) ||
        headers.find(h => aliases.includes(h)) ||
        headers.find(h => h.replace(/_/g,'') === target.replace(/_/g,'')) ||
        headers.find(h => allAliases.some(a => h.includes(a) || a.includes(h)));
      if (match && !usedHeaders.has(match)) {
        mapping[target] = match;
        usedHeaders.add(match);
      }
    }
    const unmapped = headers.filter(h => !usedHeaders.has(h));
    if (unmapped.length > 0 && sampleRows.length > 0) {
      try {
        const sample = unmapped.map(h => ({ column: h, values: sampleRows.slice(0,3).map(r => r[h]).filter(Boolean) }));
        const resp = await anthropic.messages.create({
          model: 'claude-sonnet-4-6', max_tokens: 500,
          messages: [{ role: 'user', content: `Map these CSV columns to DB fields for ${dataType}.\nAvailable DB fields not yet mapped: ${targetFields.filter(f => !mapping[f]).join(', ')}\nCSV columns with sample values: ${JSON.stringify(sample)}\nReturn ONLY JSON like {"csv_col":"db_field",...}. Use "skip" if no match.` }]
        });
        const text = (resp.content[0] as any).text || '{}';
        const m = text.match(/\{[\s\S]*?\}/);
        if (m) {
          const ai = JSON.parse(m[0]);
          for (const [col, field] of Object.entries(ai)) {
            if (field !== 'skip' && !mapping[field as string] && headers.includes(col) && targetFields.includes(field as string) && !usedHeaders.has(col)) {
              mapping[field as string] = col;
              usedHeaders.add(col);
            }
          }
        }
      } catch {}
    }
    return mapping;
  }


  async function parseGoogleSheet(urlOrId: string): Promise<{ headers: string[], rows: Record<string, string>[] }> {
    const idMatch = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const sheetId = idMatch ? idMatch[1] : urlOrId.trim();
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
    const response = await fetch(csvUrl);
    if (!response.ok) throw new Error(`Sheet fetch failed: ${response.status}`);
    const text = await response.text();
    if (text.includes("Sign in") || text.includes("accounts.google")) throw new Error("Sheet is private. Set sharing to Anyone with link - Viewer.");
    return parseCSV(text);
  }


  function parseExcel(buffer: Buffer): { headers: string[], rows: Record<string, string>[] } {
    try {
      const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'yyyy-mm-dd' }) as any[][];
      if (raw.length < 2) return { headers: [], rows: [] };
      const headers = (raw[0] as string[]).map((h: string) => String(h||'').toLowerCase().trim().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,''));
      const rows = raw.slice(1).filter((r: any[]) => r.some((v: any) => v !== null && v !== '')).map((r: any[]) => {
        const row: Record<string, string> = {};
        headers.forEach((h: string, i: number) => { row[h] = String(r[i] ?? '').trim(); });
        return row;
      });
      return { headers, rows };
    } catch (e) { console.error('Excel parse error:', e); return { headers: [], rows: [] }; }
  }

  function parseXML(text: string): { headers: string[], rows: Record<string, string>[] } {
    try {
      const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: true });
      const obj = parser.parse(text);
      const findArray = (o: any): any[] => {
        if (Array.isArray(o) && o.length > 0 && typeof o[0] === 'object') return o;
        if (typeof o === 'object' && o !== null) {
          for (const v of Object.values(o)) { const f = findArray(v); if (f.length > 0) return f; }
        }
        return [];
      };
      const records = findArray(obj);
      if (!records.length) return { headers: [], rows: [] };
      const headers = Object.keys(records[0]).map((h: string) => h.toLowerCase().replace(/[^a-z0-9_]/g,'_').replace(/^_+|_+$/g,''));
      const rows = records.map((r: any) => {
        const row: Record<string, string> = {};
        Object.entries(r).forEach(([k, v]: [string, any], i: number) => { row[headers[i]] = String(v ?? '').trim(); });
        return row;
      });
      return { headers, rows };
    } catch (e) { console.error('XML parse error:', e); return { headers: [], rows: [] }; }
  }

  // â”€â”€ Helper: process and insert rows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function processRows(
    pool: Pool, tenantId: string, dataType: string,
    rows: Record<string, string>[], fieldMap: Record<string, string>
  ): Promise<{ inserted: number; updated: number; errors: string[] }> {
    let inserted = 0, updated = 0;
    const errors: string[] = [];

    const get = (row: Record<string, string>, field: string): string =>
      fieldMap[field] ? (row[fieldMap[field]] || '') : '';

    const parseAmt = (v: string): number => {
      if (!v) return 0;
      return parseFloat(v.replace(/[â‚¹$,\s]/g, '').replace(/[()]/g, m => m === '(' ? '-' : '')) || 0;
    };

    const parseDate = (v: string): string | null => {
      if (!v) return null;
      try {
        // Handle DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD
        const parts = v.split(/[-\/]/);
        if (parts.length === 3) {
          if (parts[0].length === 4) return `${parts[0]}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`;
          if (parseInt(parts[0]) > 12) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
          return `${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}`;
        }
        return null;
      } catch { return null; }
    };

    for (const row of rows) {
      try {
        switch (dataType) {

          case 'SALES_INVOICES': {
            const invNum = get(row, 'invoice_number') || 'AR-' + Date.now();
            const custName = get(row, 'customer_name');
            const amount = parseAmt(get(row, 'total_amount')) || parseAmt(get(row, 'net_value')) || parseAmt(get(row, 'gross'));
            const date = parseDate(get(row, 'date')) || new Date().toISOString().split('T')[0];
            const dueDate = parseDate(get(row, 'due_date')) || new Date(Date.now()+30*86400000).toISOString().split('T')[0];
            const status = get(row, 'status') || 'sent';

            // Find or create customer
            let custId: string | null = null;
            if (custName) {
              const cust = await pool.query(
                `INSERT INTO customers (tenant_id, name, email) VALUES ($1,$2,$3)
                 ON CONFLICT (tenant_id, name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
                [tenantId, custName, get(row, 'email') || null]
              ).catch(() => ({ rows: [] }));
              custId = cust.rows[0]?.id || null;
            }

            await pool.query(
              `INSERT INTO ar_invoices (tenant_id, invoice_number, customer_id, date, due_date, total_amount, tax_amount, status, notes)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (tenant_id, invoice_number) DO UPDATE SET
               total_amount=EXCLUDED.total_amount, tax_amount=EXCLUDED.tax_amount, status=EXCLUDED.status, updated_at=NOW()`,
              [tenantId, invNum, custId, date, dueDate, amount, parseFloat(get(row, 'tax_amount')||'0'), status.toLowerCase(), get(row, 'description')]
            );
            inserted++;
            break;
          }

          case 'PURCHASE_INVOICES': {
            const invNum = get(row, 'invoice_number') || 'AP-' + Date.now();
            const vendName = get(row, 'vendor_name');
            const amount = parseAmt(get(row, 'total_amount'));
            const date = parseDate(get(row, 'date')) || new Date().toISOString().split('T')[0];
            const dueDate = parseDate(get(row, 'due_date')) || new Date(Date.now()+30*86400000).toISOString().split('T')[0];

            let vendId: string | null = null;
            if (vendName) {
              const vend = await pool.query(
                `INSERT INTO vendors (tenant_id, name) VALUES ($1,$2)
                 ON CONFLICT DO NOTHING RETURNING id`,
                [tenantId, vendName]
              ).catch(() => ({ rows: [] }));
              if (!vend.rows[0]?.id) {
                const existing = await pool.query(`SELECT id FROM vendors WHERE tenant_id=$1 AND name=$2 LIMIT 1`, [tenantId, vendName]).catch(()=>({rows:[]}));
                vendId = existing.rows[0]?.id || null;
              } else {
                vendId = vend.rows[0].id;
              }
            }

            await pool.query(
              `INSERT INTO ap_invoices (tenant_id, vendor_id, invoice_number, date, due_date, total_amount, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (tenant_id, invoice_number) DO UPDATE SET
               total_amount=EXCLUDED.total_amount, updated_at=NOW()`,
              [tenantId, vendId, invNum, date, dueDate, amount, 'pending']
            );
            inserted++;
            break;
          }

          case 'EXPENSES': {
            const claimNum = 'EXP-' + Date.now() + '-' + inserted;
            const amount = parseAmt(get(row, 'total_amount'));
            const date = parseDate(get(row, 'date')) || new Date().toISOString().split('T')[0];

            await pool.query(
              `INSERT INTO expense_claims (tenant_id, claim_number, title, employee_name, total_amount, category, date, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [tenantId, claimNum, get(row, 'title')||'Imported Expense', get(row, 'employee_name')||'Employee', amount, get(row, 'category')||'General', date, 'submitted']
            );
            inserted++;
            break;
          }

          case 'INVENTORY': {
            const name = get(row, 'name');
            if (!name) { errors.push(`Row ${inserted+1}: missing item name`); continue; }
            const qty = parseFloat(get(row, 'quantity')) || 0;
            const cost = parseAmt(get(row, 'unit_cost'));

            await pool.query(
              `INSERT INTO inventory_items (tenant_id, name, sku, quantity, unit_cost, category, reorder_level)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (tenant_id, sku) DO UPDATE SET
               quantity=EXCLUDED.quantity, unit_cost=EXCLUDED.unit_cost, updated_at=NOW()`,
              [tenantId, name, get(row, 'sku')||name.substring(0,10).toUpperCase()+'-'+Date.now(), qty, cost, get(row, 'category')||'General', parseFloat(get(row, 'reorder_level'))||10]
            );
            inserted++;
            break;
          }

          case 'PAYROLL': {
            const empName = get(row, 'employee_name');
            if (!empName) continue;
            const basic = parseAmt(get(row, 'basic_salary'));
            const hra = parseAmt(get(row, 'hra'));
            const other = parseAmt(get(row, 'other_allowances'));
            const gross = basic + hra + other;
            const pf = parseAmt(get(row, 'pf_employee')) || Math.round(Math.min(basic, 15000) * 0.12);
            const tds = parseAmt(get(row, 'tds'));
            const netPay = parseAmt(get(row, 'net_pay')) || gross - pf - tds;
            const month = get(row, 'month') || new Date().toISOString().split('T')[0].substring(0, 7);

            // Find or create employee
            const emp = await pool.query(
              `INSERT INTO employees (tenant_id, first_name, last_name, salary, status)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT DO NOTHING RETURNING id`,
              [tenantId, empName.split(' ')[0], empName.split(' ').slice(1).join(' '), basic, 'active']
            ).catch(()=>({rows:[]}));

            const empId = emp.rows[0]?.id || (await pool.query(`SELECT id FROM employees WHERE tenant_id=$1 AND first_name=$2 LIMIT 1`, [tenantId, empName.split(' ')[0]]).catch(()=>({rows:[]}))).rows[0]?.id;

            if (empId) {
              // Create payroll run if needed
              const runResult = await pool.query(
                `INSERT INTO payroll_runs (tenant_id, month, status, total_gross, total_net) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT DO NOTHING RETURNING id`,
                [tenantId, month+'-01', 'completed', gross, netPay]
              ).catch(()=>({rows:[]}));
              const runId = runResult.rows[0]?.id;

              if (runId) {
                await pool.query(
                  `INSERT INTO payslips (tenant_id, payroll_run_id, employee_id, gross_pay, basic_pay, hra, other_allowances, pf_employee, tds, net_pay)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                  [tenantId, runId, empId, gross, basic, hra, other, pf, tds, netPay]
                ).catch(()=>{});
              }
            }
            inserted++;
            break;
          }

          case 'CUSTOMERS': {
            const name = get(row, 'name');
            if (!name) continue;
            await pool.query(
              `INSERT INTO customers (tenant_id, name, email, phone, gstin, credit_limit)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (tenant_id, name) DO UPDATE SET
               email=COALESCE(EXCLUDED.email, customers.email),
               phone=COALESCE(EXCLUDED.phone, customers.phone),
               gstin=COALESCE(EXCLUDED.gstin, customers.gstin),
               updated_at=NOW()`,
              [tenantId, name, get(row,'email')||null, get(row,'phone')||null, get(row,'gstin')||null, parseAmt(get(row,'credit_limit'))||100000]
            );
            inserted++;
            break;
          }

          case 'VENDORS': {
            const name = get(row, 'name');
            if (!name) continue;
            await pool.query(
              `INSERT INTO vendors (tenant_id, name, email, phone, gstin, pan, payment_terms)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT DO NOTHING`,
              [tenantId, name, get(row,'email')||null, get(row,'phone')||null, get(row,'gstin')||null, get(row,'pan')||null, parseInt(get(row,'payment_terms'))||30]
            );
            inserted++;
            break;
          }

          case 'BANK_TRANSACTIONS': {
            const date = parseDate(get(row, 'date')) || new Date().toISOString().split('T')[0];
            const debit = parseAmt(get(row, 'debit'));
            const credit = parseAmt(get(row, 'credit'));
            const desc = get(row, 'description') || 'Bank Transaction';

            await pool.query(
              `INSERT INTO vendor_payments (tenant_id, amount, payment_date, payment_method, reference)
               VALUES ($1,$2,$3,$4,$5)`,
              [tenantId, debit||credit, date, 'bank_transfer', get(row,'reference')||null]
            ).catch(()=>{});
            inserted++;
            break;
          }

          case 'ASSETS': {
            const name = get(row, 'name');
            if (!name) continue;
            const cost = parseAmt(get(row, 'actual_cost'));
            const life = parseInt(get(row, 'useful_life_years')) || 5;
            const annualDep = cost > 0 ? cost / life : 0;
            const capexId = 'CAP-' + Date.now() + '-' + inserted;

            await pool.query(
              `INSERT INTO capex_register (tenant_id, capex_id, asset_name, asset_category, actual_cost, budgeted_cost, useful_life_years, depreciation_method, annual_depreciation, book_value, purchase_date, approval_status, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [tenantId, capexId, name, get(row,'category')||'other', cost, cost, life, get(row,'depreciation_method')||'SLM', annualDep, cost, parseDate(get(row,'purchase_date'))||new Date().toISOString().split('T')[0], 'approved', 'active']
            );
            inserted++;
            break;
          }

          default:
            errors.push(`Unknown data type: ${dataType}`);
        }
      } catch (e: any) {
        errors.push(`Row ${inserted + errors.length + 1}: ${e.message || String(e)}`);
      }
    }

    return { inserted, updated, errors };
  }

  // â”€â”€ POST /api/ingest â€” Main ingestion endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  router.post('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = tid(req);
      const { data, dataType: forcedType, format = 'csv', fieldMapping } = req.body;

      if (!data) return res.status(400).json({ error: 'No data provided' }) as any;

      let rows: Record<string, string>[] = [];
      let headers: string[] = [];

      // Parse based on format
      if (format === 'csv' || format === 'text') {
        const parsed = parseCSV(typeof data === 'string' ? data : JSON.stringify(data));
        headers = parsed.headers;
        rows = parsed.rows;
      } else if (format === 'json') {
        const jsonData = typeof data === 'string' ? JSON.parse(data) : data;
        if (Array.isArray(jsonData) && jsonData.length > 0) {
          headers = Object.keys(jsonData[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
          rows = jsonData.map(item => {
            const row: Record<string, string> = {};
            Object.entries(item).forEach(([k, v]) => {
              row[k.toLowerCase().replace(/\s+/g, '_')] = String(v || '');
            });
            return row;
          });
        }
      }

      if (format === 'gsheet' && !rows.length) { const gs = await parseGoogleSheet(data.trim()); headers = gs.headers; rows = gs.rows; }
      if ((format === 'excel' || format === 'xlsx') && !rows.length) { const buf = Buffer.from(data, 'base64'); const p = parseExcel(buf); headers = p.headers; rows = p.rows; }
      if (format === 'xml' && !rows.length) { const p = parseXML(typeof data === 'string' ? data : ''); headers = p.headers; rows = p.rows; }
      if (!rows.length) return res.status(400).json({ error: 'No data rows found' }) as any;

      // Detect data type
      const dataType = forcedType || await detectDataType(headers, rows);

      // Map fields
      const fieldMap = fieldMapping || await mapFields(dataType, headers, rows.slice(0,3));

      // Process and insert
      const result = await processRows(pool, tenantId, dataType, rows, fieldMap);

      // Log ingestion
      await pool.query(
        `INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at)
         VALUES ($1, 'DATA_INGESTION', $2, $3, NOW())`,
        [tenantId, result.errors.length === 0 ? 'success' : 'partial',
         `${dataType}: ${result.inserted} inserted, ${result.updated} updated, ${result.errors.length} errors`]
      ).catch(() => {});

      res.json({
        success: true,
        dataType,
        headers,
        totalRows: rows.length,
        inserted: result.inserted,
        updated: result.updated,
        errors: result.errors.slice(0, 10),
        fieldMapping: fieldMap,
        message: `Successfully ingested ${result.inserted} ${dataType.toLowerCase().replace(/_/g, ' ')} records`
      });

    } catch (e: any) {
      res.status(500).json({ error: String(e) });
    }
  });

  // â”€â”€ GET /api/ingest/preview â€” Preview before import â”€â”€â”€â”€â”€â”€â”€
  router.post('/preview', requireAuth, async (req: Request, res: Response) => {
    try {
      const { data, format = 'csv' } = req.body;
      if (!data) return res.status(400).json({ error: 'No data provided' }) as any;

      let rows: Record<string, string>[] = [];
      let headers: string[] = [];

      if (format === 'csv' || format === 'text') {
        const parsed = parseCSV(data);
        headers = parsed.headers;
        rows = parsed.rows;
      } else if (format === 'json') {
        const jsonData = typeof data === 'string' ? JSON.parse(data) : data;
        if (Array.isArray(jsonData)) {
          headers = Object.keys(jsonData[0] || {});
          rows = jsonData.map(item => {
            const r: Record<string, string> = {};
            Object.entries(item).forEach(([k,v]) => r[k] = String(v||''));
            return r;
          });
        }
      }

      if (format === 'gsheet') { const gs = await parseGoogleSheet(data.trim()); headers = gs.headers; rows = gs.rows; }
      if ((format === 'excel' || format === 'xlsx') && !rows.length) { const buf = Buffer.from(data, 'base64'); const p = parseExcel(buf); headers = p.headers; rows = p.rows; }
      if (format === 'xml' && !rows.length) { const p = parseXML(data); headers = p.headers; rows = p.rows; }
      const dataType = await detectDataType(headers, rows);
      const fieldMap = await mapFields(dataType, headers, rows.slice(0,3));

      res.json({
        dataType,
        headers,
        totalRows: rows.length,
        sampleRows: rows.slice(0, 5).map(r => { const out: any = {}; headers.forEach((h,i) => { out[h] = Object.values(r)[i] || ''; }); return out; }),
        fieldMapping: fieldMap,
        detectedColumns: Object.keys(fieldMap).length,
        unmappedColumns: headers.filter(h => !Object.values(fieldMap).includes(h)),
      });

    } catch (e: any) {
      res.status(500).json({ error: String(e) });
    }
  });

  // â”€â”€ GET /api/ingest/history â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  router.get('/history', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT automation_type, status, detail, created_at
         FROM automation_logs
         WHERE tenant_id=$1 AND automation_type='DATA_INGESTION'
         ORDER BY created_at DESC LIMIT 50`,
        [tid(req)]
      );
      res.json({ history: result.rows });
    } catch (e) {
      res.json({ history: [] });
    }
  });

  // â”€â”€ GET /api/ingest/templates â€” Download CSV templates â”€â”€â”€â”€
  router.get('/template/:type', requireAuth, async (req: Request, res: Response) => {
    const templates: Record<string, string> = {
      sales_invoices: 'invoice_number,customer_name,email,date,due_date,total_amount,tax_amount,status,description\nINV-001,Infosys Ltd,accounts@infosys.com,2024-04-01,2024-05-01,500000,90000,sent,IT Services Q1\nINV-002,TCS Mumbai,ap@tcs.com,2024-04-15,2024-05-15,350000,63000,paid,Consulting Services',
      purchase_invoices: 'invoice_number,vendor_name,date,due_date,total_amount,status\nBILL-001,Oracle India,2024-04-01,2024-05-01,120000,pending\nBILL-002,Microsoft India,2024-04-10,2024-05-10,85000,approved',
      expenses: 'title,employee_name,category,date,total_amount,status\nHotel Stay Mumbai,Rahul Sharma,Hotel,2024-04-05,7500,submitted\nFlight Bangalore,Priya Singh,Travel,2024-04-08,12000,approved',
      inventory: 'name,sku,category,quantity,unit_cost,reorder_level\nLaptop Dell XPS,DELL-XPS-001,Electronics,25,85000,5\nOffice Chair,CHAIR-001,Furniture,50,8500,10',
      payroll: 'employee_name,basic_salary,hra,other_allowances,pf_employee,tds,net_pay,month\nRahul Sharma,50000,20000,5000,6000,3000,66000,2024-04\nPriya Singh,45000,18000,4000,5400,2500,59100,2024-04',
      customers: 'name,email,phone,gstin,credit_limit,address\nInfosys Ltd,accounts@infosys.com,08023456789,29AABCI3592Q1ZF,1000000,Bengaluru Karnataka\nTCS Mumbai,ap@tcs.com,02223456789,27AAACT2727Q1ZX,800000,Mumbai Maharashtra',
      vendors: 'name,email,phone,gstin,pan,payment_terms\nOracle India,vendor@oracle.com,08023456789,29AAACO3592Q1ZF,AAACO3592Q,30\nMicrosoft India,vendor@microsoft.com,02223456789,27AABCM0786Q1ZX,AABCM0786Q,45',
      bank_transactions: 'date,description,debit,credit,balance,reference\n2024-04-01,TCS Payment Received,,500000,2500000,UTR2024040100001\n2024-04-02,Oracle Invoice Payment,120000,,2380000,CHQ000001',
      assets: 'name,category,purchase_date,actual_cost,useful_life_years,depreciation_method\nDell Server R740,IT Equipment,2024-04-01,450000,5,SLM\nConference Table,Furniture,2024-04-05,85000,10,SLM',
    };

    const type = req.params.type.toLowerCase();
    const template = templates[type];

    if (!template) {
      return res.status(404).json({ error: 'Template not found', available: Object.keys(templates) }) as any;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${type}_template.csv"`);
    res.send(template);
  });

  return router;
}
