// This script patches the mapFields function in dataIngestionRoutes.ts
// to use fully dynamic AI-powered mapping for any number of columns

const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/dataIngestionRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

// Replace the entire mapFields function with a dynamic AI-powered version
const oldFn = `  // ── Helper: AI field mapping ──────────────────────────────
  async function mapFields(dataType: string, headers: string[]): Promise<Record<string, string>> {
    const fieldMaps: Record<string, Record<string, string[]>> = {
      SALES_INVOICES: {
        invoice_number: ['invoice_number','invoice_no','inv_no','invoice','bill_no','order_no','ref_no'],
        customer_name: ['customer_name','customer','client','buyer','customer_id','bill_to'],
        total_amount: ['total_amount','amount','total','invoice_amount','bill_amount','value','grand_total'],
        due_date: ['due_date','payment_due','due_on','expiry_date'],
        date: ['date','invoice_date','bill_date','order_date','created_date','created_at'],
        status: ['status','payment_status','state'],
        description: ['description','notes','remarks','details','narration'],
        tax_amount: ['tax','gst','tax_amount','gst_amount','vat'],
      },
      PURCHASE_INVOICES: {
        invoice_number: ['invoice_number','invoice_no','bill_no','ref_no','vendor_invoice'],
        vendor_name: ['vendor_name','vendor','supplier','seller'],
        total_amount: ['total_amount','amount','total','bill_amount','value'],
        date: ['date','invoice_date','bill_date'],
        due_date: ['due_date','payment_due'],
        status: ['status','payment_status'],
      },
      EXPENSES: {
        title: ['title','description','expense_name','category','type','narration'],
        employee_name: ['employee_name','employee','staff','name','submitted_by'],
        total_amount: ['total_amount','amount','expense_amount','value','claim_amount'],
        date: ['date','expense_date','claim_date','transaction_date'],
        category: ['category','type','expense_type','classification'],
        status: ['status','approval_status'],
      },
      INVENTORY: {
        name: ['name','item_name','product_name','description','item'],
        sku: ['sku','code','item_code','product_code','part_no'],
        quantity: ['quantity','qty','stock','units','available'],
        unit_cost: ['unit_cost','cost','price','unit_price','rate'],
        category: ['category','type','group','classification'],
        reorder_level: ['reorder_level','reorder_point','min_stock','minimum'],
      },
      PAYROLL: {
        employee_name: ['employee_name','name','staff','employee'],
        basic_salary: ['basic_salary','basic','salary','wages','gross_salary'],
        hra: ['hra','house_rent','housing_allowance'],
        other_allowances: ['other_allowances','allowances','special_allowance'],
        pf_employee: ['pf_employee','pf','provident_fund','epf'],
        tds: ['tds','tax','income_tax'],
        net_pay: ['net_pay','net_salary','take_home','net'],
        month: ['month','pay_month','payroll_month','period'],
      },
      CUSTOMERS: {
        name: ['name','customer_name','company','client','business'],
        email: ['email','email_address','mail'],
        phone: ['phone','mobile','contact','phone_no'],
        address: ['address','location','city'],
        gstin: ['gstin','gst','gst_number','tax_id'],
        credit_limit: ['credit_limit','limit','credit'],
      },
      VENDORS: {
        name: ['name','vendor_name','company','supplier','business'],
        email: ['email','email_address'],
        phone: ['phone','mobile','contact'],
        gstin: ['gstin','gst','gst_number'],
        payment_terms: ['payment_terms','terms','days'],
        pan: ['pan','pan_number'],
      },
      BANK_TRANSACTIONS: {
        date: ['date','transaction_date','value_date','posting_date'],
        description: ['description','narration','particulars','remarks'],
        debit: ['debit','withdrawal','dr','amount_dr'],
        credit: ['credit','deposit','cr','amount_cr'],
        balance: ['balance','closing_balance','running_balance'],
        reference: ['reference','ref_no','cheque_no','utr'],
      },
      ASSETS: {
        name: ['name','asset_name','description','item'],
        category: ['category','type','asset_type'],
        purchase_date: ['purchase_date','date','acquisition_date'],
        actual_cost: ['actual_cost','cost','purchase_price','value'],
        useful_life_years: ['useful_life_years','useful_life','life','years'],
        depreciation_method: ['depreciation_method','method','dep_method'],
      },
    };

    const mapping: Record<string, string> = {};
    const typeMap = fieldMaps[dataType] || {};

    for (const [targetField, aliases] of Object.entries(typeMap)) {
      // Exact match first, then partial
      const matched = headers.find(h => aliases.some(a => h === a)) || headers.find(h => aliases.some(a => h.includes(a) && !['date'].includes(h)));
      if (matched) mapping[targetField] = matched;
    }
    return mapping;
  }`;

const newFn = `  // ── Helper: Dynamic AI field mapping for ANY number of columns ──
  async function mapFields(dataType: string, headers: string[], sampleRows?: Record<string, string>[]): Promise<Record<string, string>> {
    
    // DB schema for each data type - all possible target fields
    const dbSchemas: Record<string, string[]> = {
      SALES_INVOICES: ['invoice_number','customer_name','date','due_date','total_amount','tax_amount','status','description','discount','subtotal','currency','payment_terms','billing_address','shipping_address','po_number','sales_rep'],
      PURCHASE_INVOICES: ['invoice_number','vendor_name','date','due_date','total_amount','tax_amount','status','description','discount','payment_terms','delivery_date','department','cost_center'],
      EXPENSES: ['title','employee_name','category','date','total_amount','status','project','cost_center','description','receipt_number','payment_method','approved_by','reimbursable'],
      INVENTORY: ['name','sku','category','quantity','unit_cost','reorder_level','unit_of_measure','location','supplier','barcode','hsn_code','description','max_stock','lead_time_days'],
      PAYROLL: ['employee_name','employee_id','department','designation','basic_salary','hra','other_allowances','pf_employee','pf_employer','esic','tds','professional_tax','gross_salary','net_pay','month','bank_account','ifsc'],
      CUSTOMERS: ['name','email','phone','address','city','state','country','gstin','pan','credit_limit','payment_terms','contact_person','website','industry'],
      VENDORS: ['name','email','phone','address','city','state','gstin','pan','payment_terms','bank_account','ifsc','contact_person','category','rating'],
      BANK_TRANSACTIONS: ['date','description','debit','credit','balance','reference','transaction_type','account_number','narration','cheque_number','utr'],
      ASSETS: ['name','category','purchase_date','actual_cost','useful_life_years','depreciation_method','location','serial_number','manufacturer','model','warranty_expiry','insurance_value'],
    };

    const targetFields = dbSchemas[dataType] || [];
    
    // Step 1: Try exact and fuzzy matching first (fast, no AI cost)
    const mapping: Record<string, string> = {};
    const usedHeaders = new Set<string>();
    
    for (const target of targetFields) {
      // Exact match
      let match = headers.find(h => h === target);
      
      // Alias match
      if (!match) {
        const commonAliases: Record<string, string[]> = {
          invoice_number: ['invoice_no','inv_no','bill_no','ref_no','order_no','invoice#','bill#'],
          customer_name: ['customer','client','buyer','bill_to','sold_to','party_name'],
          vendor_name: ['vendor','supplier','seller','party_name'],
          total_amount: ['amount','total','grand_total','invoice_amount','bill_amount','net_amount','value'],
          due_date: ['due_date','payment_due','due_on','expiry','maturity_date'],
          date: ['invoice_date','bill_date','order_date','transaction_date','created_date','doc_date'],
          tax_amount: ['tax','gst','vat','tax_amount','gst_amount','igst','cgst','sgst'],
          basic_salary: ['basic','salary','gross_salary','ctc','wage'],
          employee_name: ['employee','staff','name','emp_name','worker'],
          unit_cost: ['cost','price','unit_price','rate','mrp','selling_price'],
          quantity: ['qty','stock','units','count','available_qty'],
        };
        const aliases = commonAliases[target] || [];
        match = headers.find(h => aliases.includes(h)) ||
                headers.find(h => h.includes(target.replace(/_/g,'')) || target.replace(/_/g,'').includes(h)) ||
                headers.find(h => h.replace(/_/g,'') === target.replace(/_/g,''));
      }
      
      if (match && !usedHeaders.has(match)) {
        mapping[target] = match;
        usedHeaders.add(match);
      }
    }
    
    // Step 2: For unmapped headers, use AI to figure out what they are
    const unmappedHeaders = headers.filter(h => !usedHeaders.has(h));
    
    if (unmappedHeaders.length > 0 && sampleRows && sampleRows.length > 0) {
      try {
        const sample = unmappedHeaders.map(h => ({
          column: h,
          values: sampleRows.slice(0,3).map(r => r[h]).filter(Boolean)
        }));
        
        const prompt = \`You are a data mapping expert. Map these CSV columns to database fields for \${dataType}.

Available target DB fields (unmapped so far): \${targetFields.filter(f => !mapping[f]).join(', ')}

Unmapped CSV columns with sample values:
\${JSON.stringify(sample, null, 2)}

Rules:
- Return ONLY a JSON object like: {"csv_column": "db_field", ...}
- Only map if you are confident (>80% sure)
- If a column doesn't match any DB field, map it to "metadata"
- Do not map same DB field twice
- Example: {"inv_date": "date", "party": "customer_name", "remarks": "metadata"}\`;

        const resp = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }]
        });
        
        const text = (resp.content[0] as any).text || '{}';
        const jsonMatch = text.match(/\\{[^}]+\\}/s);
        if (jsonMatch) {
          const aiMapping = JSON.parse(jsonMatch[0]);
          for (const [csvCol, dbField] of Object.entries(aiMapping)) {
            if (dbField === 'metadata') continue; // skip metadata for now
            if (!mapping[dbField as string] && headers.includes(csvCol) && targetFields.includes(dbField as string)) {
              mapping[dbField as string] = csvCol;
              usedHeaders.add(csvCol);
            }
          }
        }
      } catch (e) {
        console.error('AI mapping failed, using rule-based only:', e);
      }
    }
    
    return mapping;
  }`;

if (c.includes('async function mapFields')) {
  // Find and replace the entire function
  const start = c.indexOf('  // ── Helper: AI field mapping');
  const end = c.indexOf('\n  // ── Helper: process and insert rows');
  if (start > -1 && end > -1) {
    c = c.substring(0, start) + newFn + '\n\n' + c.substring(end);
    console.log('Replaced mapFields function');
  } else {
    console.log('Could not find function boundaries, trying simple replace');
    c = c.replace('  // ── Helper: AI field mapping', newFn + '\n  // ── OLD:');
  }
}

// Also update the preview endpoint to pass sampleRows to mapFields
c = c.replace(
  'const fieldMap = await mapFields(dataType, headers);',
  'const fieldMap = await mapFields(dataType, headers, rows.slice(0,3));'
);

// And the main ingest endpoint
c = c.replace(
  "const fieldMap = fieldMapping || await mapFields(dataType, headers);",
  "const fieldMap = fieldMapping || await mapFields(dataType, headers, rows.slice(0,3));"
);

fs.writeFileSync(f, c, 'utf8');
console.log('Done. File size:', fs.statSync(f).size, 'bytes');
