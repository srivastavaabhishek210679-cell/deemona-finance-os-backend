import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const log = (msg: string) => console.log('[Seed]', msg);

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    log('Starting demo data seed...');

    // â”€â”€ 1. Tenant â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating tenant...');
    const tenantRes = await client.query(`
      INSERT INTO tenants (name, slug, industry, gstin, city, state, plan)
      VALUES ('Techverse Solutions Pvt Ltd','techverse-demo','Technology','27AAPFT1234F1Z5','Mumbai','Maharashtra','pro')
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id
    `);
    const tenantId = tenantRes.rows[0].id;
    log('Tenant: ' + tenantId);

    // â”€â”€ 2. User â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating demo user...');
    const hash = await bcrypt.hash('Demo@2026', 12);
    await client.query(`
      INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, is_verified)
      VALUES ($1,'demo@techverse.in',$2,'Arjun','Mehta','owner',TRUE)
      ON CONFLICT (tenant_id, email) DO NOTHING
    `, [tenantId, hash]);

    // â”€â”€ 3. Accounts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating accounts...');
    const accs = [
      ['1000','Cash in Hand','asset','current_asset',245000],
      ['1010','HDFC Current Account','asset','current_asset',3842650],
      ['1020','ICICI Savings Account','asset','current_asset',1250000],
      ['1100','Accounts Receivable','asset','current_asset',2845000],
      ['1300','Prepaid Expenses','asset','current_asset',84000],
      ['1400','GST Input Credit','asset','current_asset',342000],
      ['1500','TDS Receivable','asset','current_asset',125000],
      ['1600','Office Equipment','asset','fixed_asset',850000],
      ['1610','Computer Hardware','asset','fixed_asset',1240000],
      ['1620','Furniture & Fixtures','asset','fixed_asset',380000],
      ['2000','Accounts Payable','liability','current_liability',1245000],
      ['2100','GST Payable - CGST','liability','current_liability',156000],
      ['2110','GST Payable - SGST','liability','current_liability',156000],
      ['2200','TDS Payable','liability','current_liability',124000],
      ['2300','Salary Payable','liability','current_liability',0],
      ['2400','PF Payable','liability','current_liability',84000],
      ['3000','Share Capital','equity','equity',5000000],
      ['3100','Retained Earnings','equity','equity',2845000],
      ['4000','Software Development Revenue','income','operating_income',0],
      ['4100','SaaS Subscription Revenue','income','operating_income',0],
      ['4200','Consulting Revenue','income','operating_income',0],
      ['5000','Cost of Development','expense','cogs',0],
      ['5100','Salaries and Wages','expense','operating_expense',0],
      ['5200','Office Rent','expense','operating_expense',0],
      ['5300','Electricity & Utilities','expense','operating_expense',0],
      ['5400','Marketing & Advertising','expense','operating_expense',0],
      ['5500','Cloud Infrastructure','expense','operating_expense',0],
      ['5600','Professional Fees','expense','operating_expense',0],
      ['5700','Travel & Conveyance','expense','operating_expense',0],
      ['5900','Miscellaneous Expenses','expense','operating_expense',0],
    ];
    const accMap: Record<string,string> = {};
    for (const [code, name, type, sub, bal] of accs) {
      const r = await client.query(
        `INSERT INTO accounts (tenant_id, code, name, type, sub_type, opening_balance)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id, code`,
        [tenantId, code, name, type, sub, bal]
      );
      if (r.rows.length) accMap[code as string] = r.rows[0].id;
    }
    const allAccs = await client.query('SELECT code, id FROM accounts WHERE tenant_id = $1', [tenantId]);
    for (const r of allAccs.rows) accMap[r.code] = r.id;
    log(`Created ${Object.keys(accMap).length} accounts`);

    // â”€â”€ 4. Vendors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating vendors...');
    const vendors = [
      ['Amazon Web Services India','29AABCA1234B1ZX','billing@aws.amazon.in','1800-103-0004',30],
      ['Microsoft India Pvt Ltd','27AAACM1234C1ZY','billing@microsoft.in','1800-102-1100',45],
      ['Regus Office Solutions','27AABCR1234D1ZZ','mumbai@regus.com','022-6745-0000',30],
      ['Justdial Digital Marketing','27AABCJ1234E1ZA','accounts@justdial.com','022-6120-7000',15],
      ['KPMG India LLP','29AAFCK1234F1ZB','india@kpmg.com','080-3980-6000',30],
      ['Airtel Business','27AABCA1234H1ZD','enterprise@airtel.in','1800-103-4444',15],
      ['Zelish Furniture Works','27AABCZ1234I1ZE','info@zelish.in','022-2876-5432',0],
      ['IndiaMART InterMESH','09AABCI1234G1ZC','accounts@indiamart.com','0120-4259-000',30],
    ];
    const vendorIds: string[] = [];
    for (const [name, gstin, email, phone, terms] of vendors) {
      const r = await client.query(
        `INSERT INTO vendors (tenant_id, name, gstin, email, phone, payment_terms)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tenantId, name, gstin, email, phone, terms]
      );
      vendorIds.push(r.rows[0].id);
    }
    log(`Created ${vendorIds.length} vendors`);

    // â”€â”€ 5. Customers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating customers...');
    const custs = [
      ['Reliance Jio Infocomm','27AAJCR1234A1ZX','vendor@jio.com','022-3555-5000',5000000],
      ['HDFC Bank Ltd','27AABCH1234B1ZY','procurement@hdfc.com','022-6652-1000',3000000],
      ['Tata Consultancy Services','27AAACT1234C1ZZ','accounts@tcs.com','022-6778-9999',2000000],
      ['Wipro Technologies','29AABCW1234D1ZA','accounts@wipro.com','080-2844-0011',1500000],
      ['Mahindra & Mahindra','27AABCM1234E1ZB','it@mahindra.com','022-2490-1441',2500000],
      ['Bajaj Finserv Ltd','27AABCB1234F1ZC','tech@bajajfinserv.com','020-6660-5555',1000000],
      ['Paytm Payments Bank','09AABCP1234G1ZD','b2b@paytm.com','0120-4770-770',800000],
      ['Zomato Ltd','09AABCZ1234H1ZE','tech@zomato.com','011-4000-0000',600000],
    ];
    const customerIds: string[] = [];
    for (const [name, gstin, email, phone, limit] of custs) {
      const r = await client.query(
        `INSERT INTO customers (tenant_id, name, gstin, email, phone, credit_limit)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tenantId, name, gstin, email, phone, limit]
      );
      customerIds.push(r.rows[0].id);
    }
    log(`Created ${customerIds.length} customers`);

    // â”€â”€ 6. Bank Accounts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating bank accounts...');
    const banks = [
      ['HDFC Current Account - Main','50200067845123','HDFC0001234','HDFC Bank','BKC Mumbai','current',3842650,3842650,true,'techverse@hdfcbank'],
      ['ICICI Savings Account','612305001234567','ICIC0006123','ICICI Bank','Lower Parel','savings',1250000,1250000,false,null],
      ['Kotak Overdraft Facility','9876543210123','KKBK0007456','Kotak Mahindra Bank','Andheri Mumbai','overdraft',0,0,false,null],
    ];
    const bankIds: string[] = [];
    for (const [name, num, ifsc, bank, branch, type, open, cur, primary, upi] of banks) {
      const r = await client.query(
        `INSERT INTO bank_accounts (tenant_id, name, account_number, ifsc, bank_name, branch, account_type, opening_balance, current_balance, is_primary, upi_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [tenantId, name, num, ifsc, bank, branch, type, open, cur, primary, upi]
      );
      bankIds.push(r.rows[0].id);
    }
    log(`Created ${bankIds.length} bank accounts`);

    // â”€â”€ 7. Bank Transactions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating bank transactions...');
    const txns = [
      ['2026-07-01','Receipt from Reliance Jio - Invoice TVI-2026-018','credit',590000,'customer_receipt'],
      ['2026-07-03','AWS Invoice Payment - June 2026','debit',284500,'vendor_payment'],
      ['2026-07-05','Receipt from HDFC Bank - Invoice TVI-2026-019','credit',472000,'customer_receipt'],
      ['2026-07-07','Office Rent - Regus BKC July 2026','debit',185000,'rent'],
      ['2026-07-10','Salaries July 2026 - Net payout','debit',2186800,'salary'],
      ['2026-07-12','TDS Challan - June 2026','debit',124000,'tax_payment'],
      ['2026-07-15','Receipt from TCS - Invoice TVI-2026-020','credit',944000,'customer_receipt'],
      ['2026-07-18','Microsoft Azure - June Invoice','debit',156000,'vendor_payment'],
      ['2026-07-20','GST Payment - CGST + SGST June','debit',312000,'tax_payment'],
      ['2026-07-22','Receipt from Wipro - Invoice TVI-2026-021','credit',354000,'customer_receipt'],
      ['2026-07-25','Airtel Business - Monthly Bill','debit',28500,'utilities'],
      ['2026-07-28','KPMG Audit Fees Q1','debit',250000,'vendor_payment'],
      ['2026-07-30','Interest Income - ICICI Savings','credit',6250,'other'],
      ['2026-08-01','Receipt from Mahindra - Invoice TVI-2026-022','credit',708000,'customer_receipt'],
      ['2026-08-03','AWS Invoice Payment - July 2026','debit',298000,'vendor_payment'],
      ['2026-08-05','PF Challan - July 2026','debit',168000,'tax_payment'],
    ];
    let bal = 3842650;
    for (const [date, desc, type, amt, cat] of txns) {
      bal = type === 'credit' ? bal + Number(amt) : bal - Number(amt);
      await client.query(
        `INSERT INTO bank_transactions (tenant_id, bank_account_id, date, value_date, description, type, amount, balance_after, category)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8)`,
        [tenantId, bankIds[0], date, desc, type, amt, bal, cat]
      );
    }
    log(`Created ${txns.length} bank transactions`);

    // â”€â”€ 8. AP Invoices â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating AP invoices...');
    const apInvs = [
      [0,'AWS-2026-0701','2026-07-01','2026-07-31',284500,43500,'paid'],
      [1,'MSFT-2026-0701','2026-07-01','2026-08-15',156000,24000,'paid'],
      [2,'REG-2026-07','2026-07-01','2026-07-07',185000,33300,'paid'],
      [3,'JD-2026-Q2','2026-06-30','2026-07-15',120000,21600,'paid'],
      [4,'KPMG-2026-01','2026-07-15','2026-08-14',250000,45000,'paid'],
      [0,'AWS-2026-0801','2026-08-01','2026-08-31',298000,45600,'approved'],
      [1,'MSFT-2026-0801','2026-08-01','2026-09-15',168000,25920,'approved'],
      [2,'REG-2026-08','2026-08-01','2026-08-07',185000,33300,'submitted'],
      [5,'AIR-2026-08','2026-08-01','2026-08-15',28500,5130,'submitted'],
    ];
    for (const [vi, inv, date, due, sub, tax, status] of apInvs) {
      const total = Number(sub) + Number(tax);
      const paid = status === 'paid' ? total : 0;
      await client.query(
        `INSERT INTO ap_invoices (tenant_id, vendor_id, invoice_number, date, due_date, subtotal, tax_amount, total_amount, paid_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [tenantId, vendorIds[Number(vi)], inv, date, due, sub, tax, total, paid, status]
      );
    }
    log(`Created ${apInvs.length} AP invoices`);

    // â”€â”€ 9. AR Invoices â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating AR invoices...');
    const arInvs = [
      [0,'TVI-2026-018','2026-06-30','2026-07-30',500000,90000,'paid'],
      [1,'TVI-2026-019','2026-07-01','2026-07-31',400000,72000,'paid'],
      [2,'TVI-2026-020','2026-07-10','2026-08-09',800000,144000,'paid'],
      [3,'TVI-2026-021','2026-07-15','2026-08-14',300000,54000,'paid'],
      [4,'TVI-2026-022','2026-07-20','2026-08-19',600000,108000,'paid'],
      [0,'TVI-2026-023','2026-08-01','2026-08-31',750000,135000,'sent'],
      [1,'TVI-2026-024','2026-08-01','2026-08-31',500000,90000,'sent'],
      [2,'TVI-2026-025','2026-08-05','2026-09-04',1200000,216000,'draft'],
      [5,'TVI-2026-026','2026-08-06','2026-09-05',350000,63000,'draft'],
    ];
    for (const [ci, inv, date, due, sub, tax, status] of arInvs) {
      const total = Number(sub) + Number(tax);
      const paid = status === 'paid' ? total : 0;
      await client.query(
        `INSERT INTO ar_invoices (tenant_id, customer_id, invoice_number, date, due_date, subtotal, tax_amount, total_amount, paid_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [tenantId, customerIds[Number(ci)], inv, date, due, sub, tax, total, paid, status]
      );
    }
    log(`Created ${arInvs.length} AR invoices`);

    // â”€â”€ 10. Employees â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating employees...');
    const emps = [
      ['EMP001','Arjun','Mehta','arjun@techverse.in','CEO & Co-Founder','Leadership','2021-04-01',250000,100000,50000,20000,false,false],
      ['EMP002','Priya','Sharma','priya@techverse.in','CTO','Technology','2021-04-01',200000,80000,40000,15000,false,false],
      ['EMP003','Rohit','Agarwal','rohit@techverse.in','VP Sales','Sales','2021-07-01',150000,60000,30000,10000,false,false],
      ['EMP004','Sneha','Patel','sneha@techverse.in','Senior Developer','Technology','2022-01-15',100000,40000,20000,5000,true,false],
      ['EMP005','Karan','Singh','karan@techverse.in','Senior Developer','Technology','2022-03-01',95000,38000,18000,4000,true,false],
      ['EMP006','Anita','Desai','anita@techverse.in','Product Manager','Product','2022-06-01',120000,48000,24000,8000,true,false],
      ['EMP007','Vikram','Nair','vikram@techverse.in','Full Stack Developer','Technology','2022-09-01',80000,32000,16000,3000,true,false],
      ['EMP008','Divya','Kumar','divya@techverse.in','UI/UX Designer','Design','2023-01-02',70000,28000,14000,3000,true,false],
      ['EMP009','Rahul','Joshi','rahul@techverse.in','DevOps Engineer','Technology','2023-03-15',85000,34000,17000,3500,true,false],
      ['EMP010','Pooja','Verma','pooja@techverse.in','Business Analyst','Product','2023-06-01',65000,26000,13000,2500,true,false],
      ['EMP011','Amit','Shah','amit@techverse.in','Sales Executive','Sales','2023-09-01',50000,20000,10000,2000,true,false],
      ['EMP012','Meera','Iyer','meera@techverse.in','Frontend Developer','Technology','2024-01-08',55000,22000,11000,2000,true,false],
      ['EMP013','Suresh','Reddy','suresh@techverse.in','QA Engineer','Technology','2024-04-01',48000,19200,9600,1800,true,false],
      ['EMP014','Nisha','Kapoor','nisha@techverse.in','HR Manager','HR','2024-06-01',60000,24000,12000,2500,true,false],
      ['EMP015','Arun','Bose','arun@techverse.in','Finance Manager','Finance','2024-08-01',75000,30000,15000,3000,true,false],
    ];
    const empIds: string[] = [];
    for (const [code,first,last,email,desig,dept,join,basic,hra,special,other,pf,esic] of emps) {
      const r = await client.query(
        `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, designation, department, date_of_joining, basic_salary, hra, special_allowance, other_allowances, pf_applicable, esic_applicable, bank_name, ifsc, bank_account)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'HDFC Bank','HDFC0001234',$2||'ACC') RETURNING id`,
        [tenantId, code, first, last, email, desig, dept, join, basic, hra, special, other, pf, esic]
      );
      empIds.push(r.rows[0].id);
    }
    log(`Created ${empIds.length} employees`);

    // â”€â”€ 11. Payroll Runs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating payroll runs...');
    for (const [month, year, status] of [[5,2026,'paid'],[6,2026,'paid'],[7,2026,'approved']]) {
      const run = await client.query(
        `INSERT INTO payroll_runs (tenant_id, month, year, status) VALUES ($1,$2,$3,$4) RETURNING id`,
        [tenantId, month, year, status]
      );
      const runId = run.rows[0].id;
      let tGross=0, tDed=0, tNet=0, tPF=0, tTDS=0;
      for (let i=0; i<emps.length; i++) {
        const empRow = emps[i];
        const basic = Number(empRow[8]); const hra = Number(empRow[9]); const special = Number(empRow[10]); const other = Number(empRow[11]); const pf = Boolean(empRow[12]);
        const gross = Number(basic)+Number(hra)+Number(special)+Number(other);
        const pfBasic = Math.min(Number(basic), 15000);
        const pfEmp = pf ? Math.round(pfBasic*0.12) : 0;
        const pfEmr = pf ? Math.round(pfBasic*0.12) : 0;
        const pt = gross > 15000 ? 200 : 0;
        const taxable = Math.max(0, gross*12 - 250000);
        const annTDS = taxable<=0?0:taxable<=500000?taxable*0.05:taxable<=1000000?12500+(taxable-500000)*0.2:112500+(taxable-1000000)*0.3;
        const tds = Math.round(annTDS/12);
        const ded = pfEmp+pt+tds;
        const net = gross-ded;
        await client.query(
          `INSERT INTO payslips (tenant_id, payroll_run_id, employee_id, month, year, basic_salary, hra, special_allowance, other_allowances, gross_salary, pf_employee, pf_employer, professional_tax, tds, total_deductions, net_salary, payment_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [tenantId, runId, empIds[i], month, year, basic, hra, special, other, gross, pfEmp, pfEmr, pt, tds, ded, net, status==='paid'?'paid':'pending']
        );
        tGross+=gross; tDed+=ded; tNet+=net; tPF+=pfEmr; tTDS+=tds;
      }
      await client.query(
        `UPDATE payroll_runs SET total_employees=$1,total_gross=$2,total_deductions=$3,total_net=$4,total_employer_pf=$5,total_tds=$6 WHERE id=$7`,
        [emps.length, tGross, tDed, tNet, tPF, tTDS, runId]
      );
    }
    log('Created 3 payroll runs');

    // â”€â”€ 12. Fixed Assets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating fixed assets...');
    const assets = [
      ['FA001','Dell PowerEdge Server','computer','2022-04-01',485000,5,20,'Server Room'],
      ['FA002','MacBook Pro 14" x10','computer','2023-01-15',350000,3,33,'Office'],
      ['FA003','Office Furniture Set','furniture','2022-06-01',285000,10,10,'BKC Office'],
      ['FA004','Cisco Networking Equipment','equipment','2022-04-01',180000,5,20,'Server Room'],
      ['FA005','Conference Room AV System','equipment','2023-03-01',245000,5,20,'Conference Room'],
      ['FA006','HP LaserJet Printers x3','equipment','2023-06-01',45000,5,20,'Office'],
      ['FA007','Standing Desks x20','furniture','2024-01-08',280000,8,12,'New Office'],
      ['FA008','Ergonomic Chairs x25','furniture','2024-01-08',125000,5,20,'New Office'],
    ];
    for (const [code,name,cat,date,price,life,rate,loc] of assets) {
      const years = (Date.now()-new Date(date as string).getTime())/(1000*60*60*24*365);
      const dep = Math.min(Number(price)*0.9, Number(price)*(Number(rate)/100)*years);
      const curVal = Math.max(Number(price)*0.1, Number(price)-dep);
      await client.query(
        `INSERT INTO fixed_assets (tenant_id, asset_code, name, category, purchase_date, purchase_price, current_value, location, useful_life_years, depreciation_method, depreciation_rate, salvage_value, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'straight_line',$10,$11,'active')`,
        [tenantId, code, name, cat, date, price, Math.round(curVal), loc, life, rate, Math.round(Number(price)*0.05)]
      );
    }
    log(`Created ${assets.length} fixed assets`);

    // â”€â”€ 13. Inventory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating inventory items...');
    const items = [
      ['SW-LIC-001','MS Office 365 Licenses','Software','license',25,5,0,8400,12000],
      ['HW-LAP-001','Laptop - Development Grade','Hardware','pcs',8,3,0,85000,0],
      ['HW-MON-001','27" 4K Monitors','Hardware','pcs',5,2,0,28000,0],
      ['OFF-STA-001','Stationery Bundle','Office','box',15,5,0,1200,0],
      ['SW-ANT-001','Antivirus Licenses - Annual','Software','license',30,10,0,1800,2500],
      ['HW-USP-001','UPS Units 1KVA','Hardware','pcs',4,2,0,8500,0],
    ];
    for (const [sku,name,cat,unit,stock,reorder,reorderQty,cost,price] of items) {
      await client.query(
        `INSERT INTO inventory_items (tenant_id, sku, name, category, unit, current_stock, reorder_level, reorder_qty, unit_cost, selling_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [tenantId, sku, name, cat, unit, stock, reorder, reorderQty, cost, price]
      );
    }
    log(`Created ${items.length} inventory items`);

    // â”€â”€ 14. Projects â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating projects...');
    const projects = [
      ['PRJ001','Jio Digital Platform v3',0,'active','urgent','2026-04-01','2026-09-30',4500000,2340000],
      ['PRJ002','HDFC Lending Analytics',1,'active','high','2026-05-01','2026-10-31',2800000,1120000],
      ['PRJ003','TCS Employee Portal',2,'active','normal','2026-06-01','2026-12-31',3200000,640000],
      ['PRJ004','Mahindra Fleet Management',4,'planning','high','2026-09-01','2027-02-28',5500000,0],
      ['PRJ005','Wipro HR Automation',3,'completed','normal','2025-10-01','2026-03-31',1800000,1750000],
      ['PRJ006','Bajaj Insurance Chatbot',5,'on_hold','low','2026-07-01','2026-12-31',900000,180000],
    ];
    for (const [code,name,ci,status,priority,start,end,budget,spent] of projects) {
      await client.query(
        `INSERT INTO projects (tenant_id, project_code, name, client_id, client_name, status, priority, start_date, end_date, budget, spent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [tenantId, code, name, customerIds[Number(ci)], custs[Number(ci)][0], status, priority, start, end, budget, spent]
      );
    }
    log(`Created ${projects.length} projects`);

    // â”€â”€ 15. Tax Filings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating tax filings...');
    const taxF = [
      ['GST_R3B',4,2026,'2026-05-20','2026-05-18',312000,312000,'filed','ARN-26051812345'],
      ['GST_R1', 4,2026,'2026-05-11','2026-05-10',0,0,'filed','ARN-26051089012'],
      ['GST_R3B',5,2026,'2026-06-20','2026-06-19',298000,298000,'filed','ARN-26061923456'],
      ['GST_R1', 5,2026,'2026-06-11','2026-06-09',0,0,'filed','ARN-26060990123'],
      ['GST_R3B',6,2026,'2026-07-20','2026-07-18',312000,312000,'filed','ARN-26071834567'],
      ['GST_R1', 6,2026,'2026-07-11','2026-07-10',0,0,'filed','ARN-26071001234'],
      ['TDS_26Q',null,2026,'2026-07-31',null,267000,267000,'filed','ACK-2026Q1678901'],
      ['GST_R3B',7,2026,'2026-08-20',null,285000,0,'pending',null],
      ['GST_R1', 7,2026,'2026-08-11',null,0,0,'pending',null],
      ['ADVANCE_TAX',null,2026,'2026-09-15',null,750000,0,'pending',null],
    ];
    for (const [type,month,year,due,filed,liability,paid,status,ref] of taxF) {
      await client.query(
        `INSERT INTO tax_filings (tenant_id, filing_type, period_month, period_year, due_date, filed_date, tax_liability, tax_paid, status, reference_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [tenantId, type, month, year, due, filed||null, liability, paid, status, ref||null]
      );
    }
    log(`Created ${taxF.length} tax filings`);

    // â”€â”€ 16. Compliance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating compliance items...');
    const comp = [
      ['tax','GST Monthly Return GSTR-3B','monthly','2026-08-20','pending',10000],
      ['tax','GST Return GSTR-1','monthly','2026-08-11','pending',10000],
      ['statutory','PF Monthly Challan','monthly','2026-08-15','pending',5000],
      ['statutory','ESIC Monthly Return','monthly','2026-08-21','pending',5000],
      ['roc','Annual Return Filing MCA','annual','2026-11-30','pending',100],
      ['tax','Advance Tax Q2 Installment','quarterly','2026-09-15','pending',1],
      ['labour','Professional Tax Annual Return','annual','2026-06-30','completed',0],
      ['roc','Director KYC Filing','annual','2026-09-30','pending',5000],
      ['statutory','Shops & Establishment Act Renewal','annual','2026-12-31','pending',2000],
      ['tax','TDS Quarterly Return 26Q','quarterly','2026-10-31','pending',200],
    ];
    for (const [cat,title,freq,due,status,penalty] of comp) {
      await client.query(
        `INSERT INTO compliance_items (tenant_id, category, title, frequency, due_date, status, penalty_if_missed, completed_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, cat, title, freq, due, status, penalty, status==='completed'?'2026-06-15':null]
      );
    }
    log(`Created ${comp.length} compliance items`);

    // â”€â”€ 17. CRM Leads â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating CRM leads...');
    const leads = [
      ['Rajesh Kumar','Nykaa Fashion Ltd','rajesh@nykaa.com','9820123456','referral','proposal',2500000,65,'2026-09-30'],
      ['Sunita Verma','PhonePe Private Ltd','sunita@phonepe.com','9876543210','website','qualified',1800000,45,'2026-10-31'],
      ['Aditya Birla','ABG Cement','aditya@abg.com','9012345678','referral','negotiation',4200000,80,'2026-09-15'],
      ['Pooja Hegde','Swiggy India Pvt Ltd','pooja@swiggy.com','9123456789','exhibition','contacted',900000,25,'2026-11-30'],
      ['Manish Tiwari','Ola Electric','manish@ola.com','9234567890','cold_call','new',3500000,15,'2026-12-31'],
      ['Deepika Singh','Dream11 Sports','deepika@dream11.com','9345678901','social','proposal',1500000,55,'2026-09-30'],
      ['Vikrant Massey','Policybazaar','vikrant@pb.com','9456789012','website','qualified',750000,40,'2026-10-15'],
      ['Anupama Rao','Lenskart Solutions','anupama@lenskart.com','9567890123','referral','won',1200000,100,'2026-07-31'],
      ['Siddharth Malhotra','MakeMyTrip Ltd','sid@mmt.com','9678901234','exhibition','lost',2000000,0,'2026-06-30'],
      ['Katrina Singh','BigBasket Technologies','katrina@bb.com','9789012345','referral','proposal',1100000,60,'2026-09-30'],
    ];
    for (const [name,company,email,phone,source,stage,value,prob,close] of leads) {
      await client.query(
        `INSERT INTO crm_leads (tenant_id, name, company, email, phone, source, stage, value, probability, expected_close, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [tenantId, name, company, email, phone, source, stage, value, prob, close,
         stage==='won'?'Contract signed.':stage==='lost'?'Lost to competitor.':'Follow up scheduled.']
      );
    }
    log(`Created ${leads.length} CRM leads`);

    // â”€â”€ 18. Expense Claims â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating expense claims...');
    const exps = [
      [2,'Rohit Agarwal','Sales','2026-07-28','Client Visit - Jio HQ Mumbai',18500,'approved'],
      [3,'Sneha Patel','Technology','2026-07-25','AWS re:Invent Conference Fees',45000,'approved'],
      [5,'Anita Desai','Product','2026-07-30','Product Research Tools - Annual',12000,'submitted'],
      [8,'Rahul Joshi','Technology','2026-08-01','Cloud Certifications - AWS SAA',8500,'submitted'],
      [2,'Rohit Agarwal','Sales','2026-08-05','Client Entertainment - HDFC',9800,'draft'],
      [1,'Priya Sharma','Technology','2026-08-06','Tech Conference - Bengaluru',28000,'draft'],
    ];
    for (const [ei,empName,dept,date,title,amount,status] of exps) {
      const num = 'EXP-2026-' + String(exps.indexOf(exps.find(e=>e[2]===dept&&e[4]===title)!)+1).padStart(3,'0');
      const claimRes = await client.query(
        `INSERT INTO expense_claims (tenant_id, claim_number, employee_id, employee_name, department, date, title, total_amount, approved_amount, status, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [tenantId, num, empIds[Number(ei)], empName, dept, date, title, amount,
         status==='approved'?amount:0, status, status!=='draft'?date:null]
      );
      await client.query(
        `INSERT INTO expense_items (claim_id, date, category, description, amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [claimRes.rows[0].id, date, Number(ei)%2===0?'travel':'professional', title, amount]
      );
    }
    log(`Created ${exps.length} expense claims`);

    // â”€â”€ 19. Finance Memory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating finance memory entries...');
    const memories = [
      ['Q1 FY2027 Revenue Target','Board has set Q1 FY2027 revenue target at Rs 2.5 Cr. Key growth drivers: Jio platform expansion, new HDFC modules, and TCS portal Phase 2. Sales team briefed.'],
      ['AWS Cost Optimization Decision','Decided to migrate to Reserved Instances. Expected 40% cost saving (~Rs 1.2L/month). Migration to complete by Q2. DevOps team leading the initiative.'],
      ['HDFC Bank Enterprise Deal','HDFC Bank signed 3-year contract worth Rs 84L annually. Includes lending analytics platform and risk scoring API. Contract manager: Arjun Mehta.'],
      ['Series A Fundraising - Board Note','Board approved initiating Series A fundraise of Rs 15-20Cr at Rs 80Cr valuation. Target close by December 2026. Key metrics: 2.8x YoY revenue growth, 78% gross margins.'],
      ['Vendor Payment Terms Renegotiation','Renegotiated AWS payment terms from Net-15 to Net-30. Will improve cash flow by ~Rs 2.8L/month. Similar negotiation in progress with Microsoft Azure.'],
      ['TCS Phase 2 SOW Signed','SOW for TCS Employee Portal Phase 2 signed. Value: Rs 1.2Cr over 6 months. Scope includes mobile app, AI chatbot integration, and multi-language support.'],
      ['GST Audit - FY2025 Resolved','GST department audit for FY2025 concluded with no major findings. Total additional payment: Rs 84,000. KPMG managed the audit process.'],
      ['Office Expansion - BKC Mumbai','Signed new office lease at BKC for 3,500 sqft. Monthly rent Rs 1.85L, 3-year lock-in. Fit-out budget Rs 18L approved. Move-in: September 2026.'],
    ];
    for (const [title, content] of memories) {
      await client.query(
        `INSERT INTO finance_memory (tenant_id, title, content, memory_type, source, category, importance_score, tags)
         VALUES ($1,$2,$3,'institutional_knowledge','manual','strategic',4,$4)`,
        [tenantId, title, content, ['finance','strategy','india']]
      );
    }
    log(`Created ${memories.length} finance memory entries`);

    // â”€â”€ 20. Budget â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log('Creating budget...');
    const budgetRes = await client.query(
      `INSERT INTO budgets (tenant_id, name, fiscal_year, type, status, total_budgeted, ai_generated)
       VALUES ($1,'FY2027 Annual Operating Budget',2027,'annual','active',48000000,FALSE) RETURNING id`,
      [tenantId]
    );
    const budgetId = budgetRes.rows[0].id;
    const lines = [
      ['Salaries & Benefits',3200000,3200000,3200000,3500000,3500000,3500000,3800000,3800000,3800000,4000000,4000000,4000000],
      ['Cloud Infrastructure',380000,390000,400000,420000,440000,460000,480000,500000,520000,540000,560000,580000],
      ['Office Rent',185000,185000,185000,194250,194250,194250,203963,203963,203963,214161,214161,214161],
      ['Marketing & Sales',250000,250000,300000,300000,350000,350000,400000,400000,450000,500000,500000,600000],
      ['Professional Fees',150000,150000,250000,150000,150000,250000,150000,150000,250000,150000,150000,350000],
      ['Travel & Conveyance',80000,80000,120000,80000,100000,150000,100000,120000,150000,120000,120000,200000],
      ['Software Licenses',95000,95000,95000,100000,100000,100000,105000,105000,105000,110000,110000,110000],
      ['Miscellaneous',60000,60000,80000,70000,70000,90000,80000,80000,100000,90000,90000,120000],
    ];
    for (const [cat,...months] of lines) {
      await client.query(
        `INSERT INTO budget_lines (budget_id, category, jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [budgetId, cat, ...months]
      );
    }
    log('Created budget with 8 lines');

    await client.query('COMMIT');
    log('');
    log('=== SEED COMPLETE ===');
    log('Email:    demo@techverse.in');
    log('Password: Demo@2026');
    log('Company:  Techverse Solutions Pvt Ltd');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Seed] ERROR:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(console.error);


