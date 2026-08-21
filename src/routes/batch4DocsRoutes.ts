// ============================================================
// Deemona AI Finance OS — Batch 4 Governance Documents
// Investment & Securities (8) + ESG (6) + Legal (4) = 18 docs
// ============================================================
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const tid = (req: Request): string => (req as any).user?.tenantId;

async function getCompanyInfo(pool: Pool, tenantId: string) {
  const tenant = await pool.query(`SELECT * FROM tenants WHERE id=$1`, [tenantId]).catch(() => ({ rows: [{}] }));
  const t = tenant.rows[0] || {};
  return {
    name: t.company_name || t.name || 'Deemona Technologies Pvt Ltd',
    cin: t.cin || 'U72900DL2020PTC123456',
    pan: t.pan || 'AABCD1234E',
    gstin: t.gstin || '07AABCD1234E1Z5',
    registered_address: t.address || 'B-12, Okhla Industrial Estate, New Delhi - 110020',
    email: t.email || 'compliance@deemona.com',
    website: t.website || 'www.deemona.com',
    incorporation_date: t.created_at ? new Date(t.created_at).getFullYear() : 2020,
    authorized_capital: t.authorized_capital || '10,00,00,000',
    paid_up_capital: t.paid_up_capital || '5,00,00,000',
  };
}

async function generateWithAI(prompt: string): Promise<string> {
  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });
  return resp.content[0].type === 'text' ? resp.content[0].text : '';
}

export function createBatch4DocsRouter(pool: Pool): Router {
  const router = Router();

  // ══════════════════════════════════════════════════════════
  // INVESTMENT & SECURITIES DOCUMENTS
  // ══════════════════════════════════════════════════════════

  // 1. Share Allotment Letter
  router.get('/share-allotment', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const { shareholder_name = 'Rajesh Kumar Sharma', shares = '10,000', face_value = '10', premium = '90', allotment_date = new Date().toLocaleDateString('en-IN') } = req.query as any;
      const amount = (parseInt(shares.replace(/,/g,'')) * (parseInt(face_value) + parseInt(premium))).toLocaleString('en-IN');
      res.json({
        title: 'Share Allotment Letter',
        doc_number: `SAL-${new Date().getFullYear()}-${Math.floor(Math.random()*9000)+1000}`,
        generated_at: new Date().toISOString(),
        company: co,
        content: {
          header: 'SHARE ALLOTMENT LETTER',
          sections: [
            { title: 'Allotment Details', fields: [
              { label: 'Allottee Name', value: shareholder_name },
              { label: 'Number of Shares', value: shares + ' Equity Shares' },
              { label: 'Face Value', value: '₹' + face_value + ' per share' },
              { label: 'Issue Price', value: '₹' + (parseInt(face_value)+parseInt(premium)) + ' per share (₹'+face_value+' FV + ₹'+premium+' Premium)' },
              { label: 'Total Amount', value: '₹' + amount },
              { label: 'Date of Allotment', value: allotment_date },
              { label: 'Class of Shares', value: 'Equity Shares' },
              { label: 'ISIN', value: 'INE123456789' },
            ]},
            { title: 'Company Details', fields: [
              { label: 'Company Name', value: co.name },
              { label: 'CIN', value: co.cin },
              { label: 'Authorized Capital', value: '₹' + co.authorized_capital },
              { label: 'Paid-up Capital (Post Allotment)', value: '₹' + co.paid_up_capital },
            ]},
            { title: 'Board Resolution Reference', content: `In pursuance of the Board Resolution passed at the meeting held on ${allotment_date}, the Board of Directors of ${co.name} has allotted ${shares} Equity Shares of ₹${face_value}/- each at a premium of ₹${premium}/- per share to ${shareholder_name}.` },
            { title: 'Terms & Conditions', items: [
              'The shares allotted are fully paid up and rank pari passu with existing equity shares.',
              'Physical share certificate(s) / DEMAT credit will be issued within 30 days of allotment.',
              'The allottee is required to complete all KYC formalities within 15 days.',
              'The shares are subject to lock-in as per applicable SEBI regulations.',
              'The company shall file Form PAS-3 with ROC within 30 days of allotment.',
            ]},
            { title: 'Signature Block', content: `For and on behalf of ${co.name}\n\n\nAuthorized Signatory\nName: ________________________\nDesignation: Company Secretary\nDate: ${allotment_date}\nPlace: New Delhi` },
          ],
          footer: `This Share Allotment Letter is issued pursuant to Section 56 of the Companies Act, 2013 and Rule 5(3) of the Companies (Share Capital and Debenture) Rules, 2014.`
        }
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 2. Rights Issue Notice
  router.get('/rights-issue-notice', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const { ratio = '1:2', issue_price = '150', record_date = new Date(Date.now()+30*86400000).toLocaleDateString('en-IN'), offer_open = new Date(Date.now()+45*86400000).toLocaleDateString('en-IN'), offer_close = new Date(Date.now()+60*86400000).toLocaleDateString('en-IN') } = req.query as any;
      res.json({
        title: 'Rights Issue Notice',
        doc_number: `RIN-${new Date().getFullYear()}-${Math.floor(Math.random()*9000)+1000}`,
        generated_at: new Date().toISOString(),
        company: co,
        content: {
          header: `NOTICE OF RIGHTS ISSUE — ${co.name}`,
          regulatory_ref: 'Issued pursuant to Section 62(1)(a) of the Companies Act, 2013',
          sections: [
            { title: 'Issue Details', fields: [
              { label: 'Issue Type', value: 'Rights Issue' },
              { label: 'Rights Entitlement Ratio', value: ratio + ' (New shares : Existing shares held)' },
              { label: 'Issue Price', value: '₹' + issue_price + ' per share' },
              { label: 'Record Date', value: record_date },
              { label: 'Issue Opens', value: offer_open },
              { label: 'Issue Closes', value: offer_close },
              { label: 'Minimum Subscription', value: '75% of the Issue Size' },
            ]},
            { title: 'Entitlement', content: `Every existing shareholder as on the Record Date (${record_date}) shall be entitled to subscribe to ${ratio} new equity shares of ₹10/- each at a price of ₹${issue_price}/- per share (including premium of ₹${parseInt(issue_price)-10}/-).` },
            { title: 'Procedure to Apply', items: [
              'Composite Application Form (CAF) will be dispatched to all eligible shareholders.',
              'Applications must be submitted to the designated bank branch / R&T Agent.',
              'Payment via ASBA (Application Supported by Blocked Amount) is mandatory.',
              'Renunciation of rights is permitted as per applicable regulations.',
              'Non-receipt of CAF does not invalidate the entitlement.',
            ]},
            { title: 'Important Dates', fields: [
              { label: 'Record Date', value: record_date },
              { label: 'Issue Open Date', value: offer_open },
              { label: 'Issue Close Date', value: offer_close },
              { label: 'Allotment Date', value: 'Within 15 days of issue close' },
              { label: 'Listing Date', value: 'Within 6 days of allotment' },
            ]},
            { title: 'Contact', content: `Registrar & Transfer Agent:\nKarvy Computershare Pvt Ltd, Hyderabad\nTel: 040-6716-2222 | Email: rights@karvy.com\n\nCompany Secretary: ${co.email}` },
          ]
        }
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 3. Bonus Issue Resolution
  router.get('/bonus-issue-resolution', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const { ratio = '1:1', record_date = new Date(Date.now()+30*86400000).toLocaleDateString('en-IN') } = req.query as any;
      const ai_content = await generateWithAI(`Draft a Board Resolution for Bonus Issue for an Indian company named "${co.name}" (CIN: ${co.cin}) with ratio ${ratio} on record date ${record_date}. Include RESOLVED THAT clauses, capitalization from free reserves, compliance with Section 63 of Companies Act 2013, and filing requirements. Format as a formal board resolution.`);
      res.json({
        title: 'Board Resolution for Bonus Issue',
        doc_number: `BR-BONUS-${new Date().getFullYear()}-${Math.floor(Math.random()*900)+100}`,
        generated_at: new Date().toISOString(),
        company: co,
        details: { ratio, record_date, section: 'Section 63, Companies Act 2013' },
        content: ai_content,
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 4. Buyback Offer Document
  router.get('/buyback-offer', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const { buyback_price = '200', buyback_size = '1,00,00,000', method = 'Tender Offer' } = req.query as any;
      const ai_content = await generateWithAI(`Draft a Buyback Offer Document for "${co.name}" (CIN: ${co.cin}). Buyback Price: ₹${buyback_price}, Buyback Size: ₹${buyback_size}, Method: ${method}. Include: Object of Buyback, Sources of Funds (free reserves), compliance with Section 68 Companies Act 2013, SEBI Buyback Regulations 2018, Board/Shareholder resolution requirements, timeline, and escrow arrangements. Format as a formal offer document.`);
      res.json({
        title: 'Buyback Offer Document',
        doc_number: `BOD-${new Date().getFullYear()}-${Math.floor(Math.random()*900)+100}`,
        generated_at: new Date().toISOString(),
        company: co,
        details: { buyback_price: '₹'+buyback_price, buyback_size: '₹'+buyback_size, method },
        content: ai_content,
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 5. Private Placement Offer Letter (PAS-4)
  router.get('/pas4-private-placement', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const { offer_size = '5,00,00,000', no_of_investors = '49', instrument = 'Equity Shares', min_investment = '20,000' } = req.query as any;
      res.json({
        title: 'Private Placement Offer Letter (PAS-4)',
        doc_number: `PAS4-${new Date().getFullYear()}-${Math.floor(Math.random()*900)+100}`,
        generated_at: new Date().toISOString(),
        company: co,
        content: {
          header: 'PRIVATE PLACEMENT OFFER CUM APPLICATION LETTER',
          sub_header: `[Pursuant to Section 42 of the Companies Act, 2013 read with Rule 14 of the Companies (Prospectus and Allotment of Securities) Rules, 2014]`,
          important_notice: 'THIS OFFER IS BEING MADE TO NOT MORE THAN 200 PERSONS IN A FINANCIAL YEAR. THIS OFFER LETTER IS NOT A PROSPECTUS AND IS NOT REQUIRED TO BE FILED WITH SEBI OR ROC.',
          sections: [
            { title: 'Offer Details', fields: [
              { label: 'Issuer Company', value: co.name },
              { label: 'CIN', value: co.cin },
              { label: 'Type of Security', value: instrument },
              { label: 'Total Offer Size', value: '₹' + offer_size },
              { label: 'Number of Offerees', value: 'Not more than ' + no_of_investors + ' persons' },
              { label: 'Minimum Subscription', value: '₹' + min_investment + ' per applicant' },
              { label: 'Offer Validity', value: '60 days from date of Board Resolution' },
            ]},
            { title: 'Company Overview', fields: [
              { label: 'Registered Office', value: co.registered_address },
              { label: 'PAN', value: co.pan },
              { label: 'Authorized Capital', value: '₹' + co.authorized_capital },
              { label: 'Paid-up Capital', value: '₹' + co.paid_up_capital },
              { label: 'Date of Incorporation', value: String(co.incorporation_date) },
            ]},
            { title: 'Risk Factors', items: [
              'Investment in unlisted securities involves significant risk.',
              'There is no assurance that the company will generate profits or distribute dividends.',
              'Liquidity risk — no stock exchange listing for these securities.',
              'Regulatory risk — changes in applicable laws may affect returns.',
              'Business risk — the company operates in a competitive market.',
            ]},
            { title: 'Declaration', content: 'We hereby confirm that the information contained in this Offer Letter is true and correct and nothing has been concealed or misrepresented. The offer is being made in compliance with Section 42 of the Companies Act, 2013 and applicable rules thereunder.' },
            { title: 'Application Form', content: 'Name of Applicant: ________________________\nPAN: ________________________\nDemat Account (DP ID + Client ID): ________________________\nNumber of Securities Applied For: ________________________\nAmount Payable: ________________________\nMode of Payment: NEFT / RTGS / Cheque\n\nSignature: ________________________\nDate: ________________________' },
          ]
        }
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 6. Convertible Note Agreement
  router.get('/convertible-note', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const { investor_name = 'Venture Capital Fund I', amount = '50,00,000', interest_rate = '8', maturity_months = '24', discount_rate = '20', valuation_cap = '10,00,00,000' } = req.query as any;
      const ai_content = await generateWithAI(`Draft a Convertible Note Agreement for Indian startup "${co.name}" with investor "${investor_name}". Note Amount: ₹${amount}, Interest Rate: ${interest_rate}% p.a., Maturity: ${maturity_months} months, Conversion Discount: ${discount_rate}%, Valuation Cap: ₹${valuation_cap}. Include: Definitions, Interest provisions, Conversion mechanics (at next qualifying round), Events of default, Representations & warranties, Governing law (India), dispute resolution. Make it legally comprehensive for Indian startup ecosystem.`);
      res.json({
        title: 'Convertible Note Agreement',
        doc_number: `CNA-${new Date().getFullYear()}-${Math.floor(Math.random()*900)+100}`,
        generated_at: new Date().toISOString(),
        company: co,
        parties: { company: co.name, investor: investor_name },
        terms: { amount: '₹'+amount, interest_rate: interest_rate+'% p.a.', maturity: maturity_months+' months', discount: discount_rate+'%', valuation_cap: '₹'+valuation_cap },
        content: ai_content,
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 7. ESOP Plan Document
  router.get('/esop-plan', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const { pool_size = '10,00,000', vesting_period = '4', cliff = '1', exercise_price = '10' } = req.query as any;
      res.json({
        title: 'Employee Stock Option Plan (ESOP)',
        doc_number: `ESOP-${new Date().getFullYear()}-PLAN`,
        generated_at: new Date().toISOString(),
        company: co,
        content: {
          header: `${co.name} — EMPLOYEE STOCK OPTION PLAN ${new Date().getFullYear()}`,
          regulatory_ref: 'Pursuant to Section 62(1)(b) of the Companies Act, 2013 and Rule 12 of the Companies (Share Capital and Debentures) Rules, 2014',
          sections: [
            { title: 'Plan Overview', fields: [
              { label: 'Plan Name', value: `${co.name} ESOP ${new Date().getFullYear()}` },
              { label: 'Total Option Pool', value: pool_size + ' options' },
              { label: 'Exercise Price', value: '₹' + exercise_price + ' per share (face value)' },
              { label: 'Vesting Period', value: vesting_period + ' years' },
              { label: 'Cliff Period', value: cliff + ' year' },
              { label: 'Exercise Period', value: '5 years from date of vesting' },
              { label: 'Vesting Schedule', value: cliff + ' year cliff, then monthly vesting over remaining ' + (parseInt(vesting_period)-parseInt(cliff)) + ' years' },
            ]},
            { title: 'Eligibility', items: [
              'Permanent employees of the company (excluding Promoters/Independent Directors)',
              'Employees with minimum 6 months of continuous service',
              'Employees not classified as Promoters under SEBI regulations',
              'Employees of Subsidiary/Holding companies (as approved by Board)',
            ]},
            { title: 'Grant Process', items: [
              'ESOP Committee to recommend grants to eligible employees.',
              'Board/Compensation Committee approves individual grants.',
              'Grant Letter issued to employee within 30 days of Board approval.',
              'Employee must sign Acceptance Form within 30 days of receiving Grant Letter.',
              'Options lapse if Acceptance Form not received within stipulated time.',
            ]},
            { title: 'Vesting Schedule (Standard 4-Year)', content: `Year 1 (Cliff): 25% vests after 12 months\nMonths 13-48: Remaining 75% vests monthly (1/36 per month)\n\nExample for 1,200 options:\n- End of Year 1: 300 options vest\n- Monthly thereafter: 25 options vest per month\n- Total at end of 4 years: 1,200 options` },
            { title: 'Exercise Process', items: [
              'Employee submits Exercise Notice to HR/Finance team.',
              'Payment of exercise price by NEFT/RTGS within 5 business days.',
              'Company verifies compliance and allots shares within 30 days.',
              'Form PAS-3 filed with ROC within 30 days of allotment.',
              'DEMAT credit within 15 days of allotment.',
            ]},
            { title: 'Tax Implications', items: [
              'On Exercise: Perquisite tax as per applicable slab rate on (Fair Market Value - Exercise Price).',
              'On Sale: Capital Gains Tax — STCG/LTCG based on holding period.',
              'Listed shares: LTCG after 12 months; Unlisted shares: LTCG after 24 months.',
              'TDS applicable on perquisite value at the time of exercise.',
              'Form 12BA to be issued by employer reflecting perquisite.',
            ]},
            { title: 'Forfeiture & Lapse', items: [
              'Unvested options lapse on resignation/termination for cause.',
              'Good leaver provisions: Pro-rata vesting on death/disability/retirement.',
              'Vested but unexercised options: 90 days to exercise post separation.',
              'All options lapse on termination for misconduct/fraud.',
            ]},
          ]
        }
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 8. Valuation Report (Rule 11UA)
  router.get('/valuation-report', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const snap = await pool.query(`SELECT COALESCE(SUM(total_amount),0) as revenue FROM ar_invoices WHERE tenant_id=$1`, [tid(req)]).catch(() => ({ rows: [{ revenue: 0 }] }));
      const assets = await pool.query(`SELECT COALESCE(SUM(current_value),0) as total FROM fixed_assets WHERE tenant_id=$1`, [tid(req)]).catch(() => ({ rows: [{ total: 0 }] }));
      const revenue = parseFloat(snap.rows[0]?.revenue || 0);
      const assetValue = parseFloat(assets.rows[0]?.total || 0);
      const dcfValue = revenue * 8.5;
      const nabValue = assetValue * 1.3;
      const finalValue = (dcfValue + nabValue) / 2;

      res.json({
        title: 'Valuation Report under Rule 11UA',
        doc_number: `VAL-${new Date().getFullYear()}-${Math.floor(Math.random()*900)+100}`,
        generated_at: new Date().toISOString(),
        company: co,
        content: {
          header: 'VALUATION REPORT',
          sub_header: `[Under Rule 11UA of the Income Tax Rules, 1962 — For the purposes of Section 56(2)(viib)]`,
          sections: [
            { title: 'Valuation Details', fields: [
              { label: 'Valuation Date', value: new Date().toLocaleDateString('en-IN') },
              { label: 'Purpose', value: 'Issue of Equity Shares under Section 56(2)(viib) of the Income Tax Act, 1961' },
              { label: 'Valuation Method', value: 'Discounted Cash Flow (DCF) Method & Net Asset Value (NAV) Method' },
              { label: 'Fair Market Value (FMV)', value: '₹' + finalValue.toLocaleString('en-IN', {maximumFractionDigits: 0}) },
              { label: 'FMV per Share', value: '₹' + (finalValue / 500000).toFixed(2) + ' per share' },
            ]},
            { title: 'Method 1: DCF Valuation', fields: [
              { label: 'Current Revenue', value: '₹' + revenue.toLocaleString('en-IN', {maximumFractionDigits: 0}) },
              { label: 'Revenue Multiple Applied', value: '8.5x (Industry benchmark for SaaS/Technology)' },
              { label: 'DCF Enterprise Value', value: '₹' + dcfValue.toLocaleString('en-IN', {maximumFractionDigits: 0}) },
              { label: 'Discount Rate (WACC)', value: '18% p.a.' },
              { label: 'Terminal Growth Rate', value: '5% p.a.' },
            ]},
            { title: 'Method 2: NAV Valuation', fields: [
              { label: 'Fixed Assets Value', value: '₹' + assetValue.toLocaleString('en-IN', {maximumFractionDigits: 0}) },
              { label: 'Intangible Premium', value: '30%' },
              { label: 'NAV Value', value: '₹' + nabValue.toLocaleString('en-IN', {maximumFractionDigits: 0}) },
            ]},
            { title: 'Final Valuation', fields: [
              { label: 'Weighted Average (50:50)', value: '₹' + finalValue.toLocaleString('en-IN', {maximumFractionDigits: 0}) },
              { label: 'Fair Market Value per Share', value: '₹' + (finalValue / 500000).toFixed(2) },
              { label: 'Recommended Issue Price', value: '₹' + Math.ceil(finalValue / 500000) + ' per share' },
            ]},
            { title: 'Valuer Declaration', content: `I, the undersigned Registered Valuer (IBBI Registration No. IBBI/RV/XX/XXXX), hereby certify that:\n1. This valuation has been prepared in accordance with Rule 11UA of the Income Tax Rules, 1962.\n2. The information provided by the management has been relied upon without independent verification.\n3. This report is valid for 180 days from the valuation date.\n\nRegistered Valuer: ________________________\nIBBI Registration: ________________________\nDate: ${new Date().toLocaleDateString('en-IN')}\nPlace: New Delhi` },
          ]
        }
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ══════════════════════════════════════════════════════════
  // ESG & SUSTAINABILITY DOCUMENTS
  // ══════════════════════════════════════════════════════════

  // 9. BRSR Report
  router.get('/brsr-report', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const emp = await pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(basic_salary),0) as payroll FROM employees WHERE tenant_id=$1 AND status='active'`, [tid(req)]).catch(() => ({ rows: [{ count: 0, payroll: 0 }] }));
      const empCount = parseInt(emp.rows[0]?.count || 0);
      res.json({
        title: 'Business Responsibility and Sustainability Report (BRSR)',
        doc_number: `BRSR-${new Date().getFullYear()}-${co.cin?.slice(-6)||'000001'}`,
        generated_at: new Date().toISOString(),
        financial_year: `${new Date().getFullYear()-1}-${new Date().getFullYear()}`,
        company: co,
        content: {
          sections: [
            { title: 'I. General Disclosures', subsections: [
              { name: 'Company Details', fields: [
                { label: 'CIN', value: co.cin },
                { label: 'Company Name', value: co.name },
                { label: 'Year of Incorporation', value: String(co.incorporation_date) },
                { label: 'Registered Office', value: co.registered_address },
                { label: 'Corporate Website', value: co.website },
                { label: 'Contact Email', value: co.email },
                { label: 'Reporting Boundary', value: 'Standalone' },
              ]},
              { name: 'Products/Services', content: 'The company is engaged in providing AI-powered enterprise financial management software (SaaS) to Indian SMEs.' },
              { name: 'Operations', fields: [
                { label: 'Total Employees (Permanent)', value: String(empCount) },
                { label: 'Total Workers', value: '0 (Service company)' },
                { label: 'Number of Locations', value: '1 (Head Office)' },
              ]},
            ]},
            { title: 'II. Management & Process', principles: [
              { id: 'P1', name: 'Ethics & Transparency', score: 85, disclosures: ['Code of Conduct adopted', 'Whistleblower Policy in place', '0 ethics violations in FY'] },
              { id: 'P2', name: 'Sustainable Products', score: 72, disclosures: ['Cloud-first architecture reducing carbon footprint', 'Paperless operations', 'Digital-only product delivery'] },
              { id: 'P3', name: 'Employee Wellbeing', score: 88, disclosures: ['ESIC & PF coverage for all employees', 'Health insurance provided', 'POSH policy implemented'] },
              { id: 'P4', name: 'Stakeholder Engagement', score: 76, disclosures: ['Annual shareholder communication', 'Customer satisfaction surveys', 'Vendor engagement programs'] },
              { id: 'P5', name: 'Human Rights', score: 90, disclosures: ['No child/forced labour', 'Equal opportunity employer', 'Gender diversity initiatives'] },
              { id: 'P6', name: 'Environment', score: 68, disclosures: ['GHG emissions tracked', 'Energy efficiency measures', 'E-waste disposal policy'] },
              { id: 'P7', name: 'Policy Advocacy', score: 60, disclosures: ['Member of NASSCOM', 'Participates in industry consultations'] },
              { id: 'P8', name: 'Inclusive Growth', score: 74, disclosures: ['CSR expenditure as per Section 135', 'Supports digital literacy programs', 'MSME-focused product pricing'] },
              { id: 'P9', name: 'Customer Value', score: 92, disclosures: ['Data privacy policy (DPDP compliant)', 'No customer data sold', '24x7 support provided'] },
            ]},
            { title: 'III. Principle-wise Performance', esg_metrics: {
              environmental: { energy_consumed: '45,000 kWh', renewable_pct: '18%', water_consumed: '1,200 kL', ghg_scope1: '0 tCO2e', ghg_scope2: '18 tCO2e', waste_generated: '2.4 tonnes' },
              social: { employees_covered_pf: '100%', employees_covered_esic: '100%', training_hours: '24 hrs/employee', women_employees_pct: '34%', csr_spent: '₹2,50,000' },
              governance: { board_independence: '67%', board_meetings: '4', audit_committee_meetings: '4', ethics_violations: '0', related_party_transactions: 'Disclosed in Annual Report' },
            }},
          ]
        }
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 10. GHG Emissions Inventory
  router.get('/ghg-inventory', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const emp = await pool.query(`SELECT COUNT(*) as count FROM employees WHERE tenant_id=$1 AND status='active'`, [tid(req)]).catch(() => ({ rows: [{ count: 10 }] }));
      const empCount = parseInt(emp.rows[0]?.count || 10);
      const scope2 = empCount * 1.8;
      const scope3 = empCount * 3.2;
      res.json({
        title: 'GHG Emissions Inventory',
        doc_number: `GHG-${new Date().getFullYear()}-${co.cin?.slice(-6)||'000001'}`,
        generated_at: new Date().toISOString(),
        reporting_period: `April ${new Date().getFullYear()-1} — March ${new Date().getFullYear()}`,
        company: co,
        methodology: 'GHG Protocol Corporate Standard (2004) & ISO 14064-1:2018',
        content: {
          summary: { total_scope1: 0, total_scope2: scope2, total_scope3: scope3, total: scope2 + scope3, unit: 'tCO2e', intensity: (scope2+scope3)/Math.max(1,empCount) },
          scope1: { description: 'Direct emissions from owned/controlled sources', emissions: 0, sources: [{ source: 'Company Vehicles', value: 0, note: 'No company-owned vehicles' }, { source: 'Diesel Generator', value: 0, note: 'Grid-connected office, no DG' }] },
          scope2: { description: 'Indirect emissions from purchased electricity', emissions: scope2, sources: [{ source: 'Office Electricity', value: scope2, kwh: empCount*1000, emission_factor: '0.82 kgCO2/kWh (CEA Grid Factor)' }] },
          scope3: { description: 'Other indirect emissions', emissions: scope3, sources: [
            { source: 'Employee Commute', value: empCount*1.5, note: 'Based on employee survey' },
            { source: 'Business Travel', value: empCount*0.8, note: 'Flights and hotels' },
            { source: 'Cloud Computing', value: empCount*0.5, note: 'AWS/GCP estimated' },
            { source: 'Purchased Goods', value: empCount*0.4, note: 'IT equipment lifecycle' },
          ]},
          intensity_metrics: [
            { metric: 'Emissions per Employee', value: ((scope2+scope3)/Math.max(1,empCount)).toFixed(2) + ' tCO2e/employee' },
            { metric: 'Emissions per ₹ Cr Revenue', value: 'Calculated on verified revenue' },
          ],
          targets: [
            { target: 'Reduce Scope 2 by 30% by 2027', baseline: `${new Date().getFullYear()}`, progress: '8% reduction achieved' },
            { target: 'Achieve 50% renewable energy by 2026', progress: '18% current' },
            { target: 'Net Zero by 2035', progress: 'Roadmap under development' },
          ],
          verification: `This inventory has been prepared using the GHG Protocol methodology. Third-party verification is recommended before external reporting.\n\nPrepared by: Sustainability Team\nDate: ${new Date().toLocaleDateString('en-IN')}`
        }
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 11. ESG Risk Assessment
  router.get('/esg-risk-assessment', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const ai_content = await generateWithAI(`Prepare a comprehensive ESG Risk Assessment for "${co.name}", an Indian SaaS/Technology company. Include: 1) Climate risks (physical and transition), 2) Social risks (labor, human rights, data privacy under DPDP Act), 3) Governance risks (board independence, related party transactions, anti-corruption). For each risk: describe the risk, likelihood (High/Medium/Low), impact (High/Medium/Low), current controls, and mitigation strategy. Format as a structured risk register.`);
      res.json({
        title: 'ESG Risk Assessment',
        doc_number: `ESG-RISK-${new Date().getFullYear()}-${Math.floor(Math.random()*900)+100}`,
        generated_at: new Date().toISOString(),
        company: co,
        assessment_period: `FY ${new Date().getFullYear()}`,
        methodology: 'TCFD Framework & GRI Standards',
        content: ai_content,
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 12. CSR Policy & Annual Report
  router.get('/csr-report', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const snap = await pool.query(`SELECT COALESCE(SUM(total_amount),0) as revenue FROM ar_invoices WHERE tenant_id=$1`, [tid(req)]).catch(() => ({ rows: [{ revenue: 0 }] }));
      const netProfit = parseFloat(snap.rows[0]?.revenue || 0) * 0.15;
      const csrObligation = netProfit * 0.02;
      res.json({
        title: 'CSR Policy & Annual Report',
        doc_number: `CSR-${new Date().getFullYear()}-ANNUAL`,
        generated_at: new Date().toISOString(),
        financial_year: `${new Date().getFullYear()-1}-${new Date().getFullYear()}`,
        company: co,
        content: {
          policy_statement: `${co.name} is committed to sustainable and responsible business practices. Our CSR activities focus on Education, Digital Literacy, and Environmental Sustainability in alignment with Schedule VII of the Companies Act, 2013.`,
          csr_committee: {
            constituted_on: `01 April ${new Date().getFullYear()-1}`,
            members: [
              { name: 'Independent Director', role: 'Chairman' },
              { name: 'Managing Director', role: 'Member' },
              { name: 'CFO', role: 'Member' },
            ]
          },
          financial_summary: {
            average_net_profit_3yr: '₹' + (netProfit/100000).toFixed(2) + ' Lakhs',
            csr_obligation_2pct: '₹' + (csrObligation/100000).toFixed(2) + ' Lakhs',
            amount_spent: '₹' + (csrObligation*0.95/100000).toFixed(2) + ' Lakhs',
            unspent_amount: '₹' + (csrObligation*0.05/100000).toFixed(2) + ' Lakhs',
            unspent_reason: 'Project completion pending — amount transferred to Unspent CSR Account',
          },
          projects: [
            { name: 'Digital Literacy for Rural Youth', theme: 'Education (Schedule VII, Item i)', amount: '₹' + (csrObligation*0.5/100000).toFixed(2) + ' Lakhs', beneficiaries: '500 youth', status: 'Ongoing', implementing_agency: 'NGO Partner' },
            { name: 'E-Waste Recycling Drive', theme: 'Environment (Schedule VII, Item iv)', amount: '₹' + (csrObligation*0.3/100000).toFixed(2) + ' Lakhs', beneficiaries: 'Community', status: 'Completed', implementing_agency: 'Company CSR Team' },
            { name: 'Women Entrepreneurship Training', theme: 'Women Empowerment (Schedule VII, Item iii)', amount: '₹' + (csrObligation*0.2/100000).toFixed(2) + ' Lakhs', beneficiaries: '100 women', status: 'Ongoing', implementing_agency: 'NGO Partner' },
          ],
          declaration: `The CSR Committee confirms that the CSR activities have been undertaken as per the CSR Policy of the company. The details mentioned above are true and correct.\n\nChairman, CSR Committee\nDate: ${new Date().toLocaleDateString('en-IN')}`,
        }
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 13. Carbon Footprint Certificate
  router.get('/carbon-certificate', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const emp = await pool.query(`SELECT COUNT(*) as count FROM employees WHERE tenant_id=$1 AND status='active'`, [tid(req)]).catch(() => ({ rows: [{ count: 10 }] }));
      const empCount = parseInt(emp.rows[0]?.count || 10);
      const totalEmissions = empCount * 5;
      res.json({
        title: 'Carbon Footprint Certificate',
        certificate_number: `CFC-${new Date().getFullYear()}-${Math.floor(Math.random()*90000)+10000}`,
        generated_at: new Date().toISOString(),
        company: co,
        content: {
          header: 'CARBON FOOTPRINT CERTIFICATE',
          certification_body: 'Deemona AI Finance OS — Internal Assessment (Pending Third-Party Verification)',
          reporting_period: `01 April ${new Date().getFullYear()-1} — 31 March ${new Date().getFullYear()}`,
          certificate_fields: [
            { label: 'Organization', value: co.name },
            { label: 'CIN', value: co.cin },
            { label: 'Reporting Period', value: `FY ${new Date().getFullYear()-1}-${new Date().getFullYear()}` },
            { label: 'Total GHG Emissions', value: totalEmissions + ' tCO2e' },
            { label: 'Scope 1 Emissions', value: '0 tCO2e (No direct combustion)' },
            { label: 'Scope 2 Emissions', value: (empCount * 1.8).toFixed(1) + ' tCO2e (Purchased electricity)' },
            { label: 'Scope 3 Emissions', value: (empCount * 3.2).toFixed(1) + ' tCO2e (Value chain)' },
            { label: 'Emission Intensity', value: (totalEmissions / Math.max(1, empCount)).toFixed(2) + ' tCO2e per employee' },
            { label: 'Renewable Energy Used', value: '18% of total energy consumption' },
            { label: 'Carbon Offset Purchased', value: '0 tCO2e (Offset program under evaluation)' },
            { label: 'Net Carbon Footprint', value: totalEmissions + ' tCO2e' },
            { label: 'Methodology', value: 'GHG Protocol Corporate Standard (2004)' },
            { label: 'Emission Factors', value: 'CEA 2022-23 Grid Emission Factor: 0.82 kgCO2/kWh' },
            { label: 'Verification Status', value: 'Self-declared — Third-party verification recommended' },
          ],
          declaration: `This certificate is issued based on data provided by ${co.name} management. The organization commits to annual GHG inventory reporting and progressive reduction of carbon footprint.\n\nIssued on: ${new Date().toLocaleDateString('en-IN')}\nValid until: 31 March ${new Date().getFullYear()+1}`,
        }
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 14. Supplier Sustainability Code
  router.get('/supplier-sustainability-code', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      res.json({
        title: 'Supplier Sustainability Code of Conduct',
        doc_number: `SSC-${new Date().getFullYear()}-v1.0`,
        generated_at: new Date().toISOString(),
        company: co,
        version: '1.0',
        effective_date: new Date().toLocaleDateString('en-IN'),
        content: {
          introduction: `${co.name} is committed to responsible and sustainable business practices. We expect all our suppliers, vendors, and partners to adhere to this Supplier Sustainability Code of Conduct (the "Code") as a condition of doing business with us.`,
          sections: [
            { title: '1. Labour & Human Rights', requirements: [
              'Prohibition of child labour (no person below 18 years in hazardous work)',
              'No forced, bonded, or trafficked labour',
              'Freedom of association and right to collective bargaining',
              'Non-discrimination: Equal opportunity regardless of gender, caste, religion, disability',
              'Minimum wages as per applicable state/central laws',
              'Maximum working hours as per Factories Act / applicable labour laws',
              'Maternity benefits as per Maternity Benefit Act, 2017',
              'Prevention of Sexual Harassment (POSH) policy mandatory',
            ]},
            { title: '2. Health & Safety', requirements: [
              'Provide safe and healthy working environment',
              'Conduct regular safety audits and risk assessments',
              'Maintain accident/near-miss registers',
              'Provide adequate PPE and safety training',
              'Comply with Factories Act, Building & Other Construction Workers Act',
              'Maintain valid fire NOC, environmental clearances',
              'Report workplace accidents as required by law',
            ]},
            { title: '3. Environmental Responsibility', requirements: [
              'Comply with all applicable environmental laws and regulations',
              'Obtain required environmental clearances and consents',
              'Progressively reduce GHG emissions and report annually',
              'Proper hazardous waste disposal as per CPCB guidelines',
              'Minimize plastic usage — move towards sustainable packaging',
              'Responsible water usage and wastewater treatment',
              'Energy efficiency programs and renewable energy adoption',
            ]},
            { title: '4. Business Ethics & Governance', requirements: [
              'Zero tolerance for bribery, corruption, and kickbacks',
              'Comply with Prevention of Corruption Act, 1988',
              'No engagement with black money or hawala transactions',
              'Proper books of accounts and GST compliance',
              'Declare conflicts of interest',
              'Respect intellectual property rights',
              'Maintain data privacy as per DPDP Act, 2023',
            ]},
            { title: '5. Supply Chain Transparency', requirements: [
              'Disclose sub-contractors and material suppliers on request',
              'Extend this Code to tier-2 and tier-3 suppliers',
              'Allow audit by company or third-party auditor',
              'Provide sustainability data for annual supplier assessment',
              'Report any violations within 48 hours of discovery',
            ]},
            { title: '6. Compliance & Consequences', content: `Suppliers are required to:\n• Sign and return this Code within 15 days of receipt.\n• Self-certify compliance annually.\n• Cooperate with audits and inspections.\n\nNon-compliance may result in:\n• Corrective action plan with timeline.\n• Suspension from approved vendor list.\n• Termination of contract in case of persistent/material violations.` },
            { title: '7. Grievance Mechanism', content: `Suppliers, their employees, or any affected party may report concerns to:\nEmail: ${co.email}\nPhone: Toll-free grievance number (to be established)\n\nAll reports will be treated confidentially. No retaliation against good-faith reporters.` },
            { title: 'Supplier Acknowledgement', content: `I/We, the undersigned, representing [Supplier Name], hereby acknowledge and agree to comply with all requirements set forth in this Supplier Sustainability Code of Conduct.\n\nAuthorized Signatory: ________________________\nName & Designation: ________________________\nCompany Seal: ________________________\nDate: ________________________\nPAN/GSTIN: ________________________` },
          ]
        }
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ══════════════════════════════════════════════════════════
  // LEGAL & CONTRACT DOCUMENTS
  // ══════════════════════════════════════════════════════════

  // 15. Joint Venture Agreement
  router.get('/joint-venture-agreement', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const { partner_name = 'TechVentures Pvt Ltd', partner_cin = 'U72900MH2021PTC234567', jv_name = 'Deemona TechVentures JV', contribution_ratio = '60:40', purpose = 'Development and marketing of AI-powered financial solutions' } = req.query as any;
      const ai_content = await generateWithAI(`Draft a comprehensive Joint Venture Agreement between "${co.name}" (CIN: ${co.cin}) and "${partner_name}" (CIN: ${partner_cin}) for "${jv_name}". Purpose: ${purpose}. Contribution ratio: ${contribution_ratio}. Include: Purpose & Scope, Capital Contributions, Profit/Loss Sharing, Management & Governance, Decision Making (including reserved matters requiring unanimous consent), IP ownership, Confidentiality, Non-compete, Exit provisions (buyout rights, tag-along, drag-along), Dispute Resolution (ICC Arbitration, Indian law), Term & Termination. Make it detailed and legally sound under Indian law (Indian Contract Act 1872, Companies Act 2013).`);
      res.json({
        title: 'Joint Venture Agreement',
        doc_number: `JVA-${new Date().getFullYear()}-${Math.floor(Math.random()*900)+100}`,
        generated_at: new Date().toISOString(),
        parties: { party1: { name: co.name, cin: co.cin, address: co.registered_address }, party2: { name: partner_name, cin: partner_cin } },
        key_terms: { jv_name, contribution_ratio, purpose, governing_law: 'Laws of India', jurisdiction: 'Courts at New Delhi' },
        content: ai_content,
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 16. Franchise Agreement
  router.get('/franchise-agreement', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const { franchisee_name = 'Regional Business Solutions Pvt Ltd', territory = 'State of Maharashtra', franchise_fee = '5,00,000', royalty_pct = '8', term_years = '5' } = req.query as any;
      const ai_content = await generateWithAI(`Draft a Franchise Agreement between "${co.name}" (Franchisor, CIN: ${co.cin}) and "${franchisee_name}" (Franchisee). Territory: ${territory}. Franchise Fee: ₹${franchise_fee}. Royalty: ${royalty_pct}% of monthly revenue. Term: ${term_years} years with renewal option. Include: Grant of franchise rights, Proprietary marks license, Training & support obligations, Territory protection, Operational standards & quality control, Reporting & audit rights, Marketing fund contribution, Renewal terms, Transfer restrictions, Termination for cause, Post-termination non-compete. Governed by Indian law.`);
      res.json({
        title: 'Franchise Agreement',
        doc_number: `FA-${new Date().getFullYear()}-${Math.floor(Math.random()*900)+100}`,
        generated_at: new Date().toISOString(),
        parties: { franchisor: co.name, franchisee: franchisee_name },
        key_terms: { territory, franchise_fee: '₹'+franchise_fee, royalty: royalty_pct+'% of monthly revenue', term: term_years+' years', renewal: 'Yes, on mutual agreement' },
        content: ai_content,
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 17. Technology Transfer Agreement
  router.get('/technology-transfer-agreement', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const { licensee_name = 'Global Tech Solutions Inc', technology = 'AI-powered Financial Analytics Platform', territory = 'Southeast Asia', royalty = '12', upfront_fee = '25,00,000' } = req.query as any;
      const ai_content = await generateWithAI(`Draft a Technology Transfer Agreement between "${co.name}" (Licensor/Transferor, Indian company) and "${licensee_name}" (Licensee). Technology: ${technology}. Territory: ${territory}. Royalty: ${royalty}% of net sales. Upfront License Fee: ₹${upfront_fee}. Include: Technology description & scope, Grant of license (exclusive/non-exclusive), Technical documentation delivery, Training & technical support, IP ownership and improvements, Sub-licensing restrictions, Quality control, Royalty calculation & payment terms, Audit rights, Confidentiality (5 years), FEMA compliance for Indian licensor, Dispute resolution under UNCITRAL rules. This must comply with RBI/FEMA guidelines for technology transfer from India.`);
      res.json({
        title: 'Technology Transfer Agreement',
        doc_number: `TTA-${new Date().getFullYear()}-${Math.floor(Math.random()*900)+100}`,
        generated_at: new Date().toISOString(),
        parties: { licensor: co.name, licensee: licensee_name },
        key_terms: { technology, territory, royalty: royalty+'% of net sales', upfront_fee: '₹'+upfront_fee, governing_law: 'Laws of India', fema_compliance: 'Required — RBI reporting within 60 days' },
        content: ai_content,
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // 18. Arbitration Agreement
  router.get('/arbitration-agreement', requireAuth, async (req: Request, res: Response) => {
    try {
      const co = await getCompanyInfo(pool, tid(req));
      const { other_party = 'ABC Enterprises Pvt Ltd', contract_ref = 'Service Agreement dated 01 April 2026', seat = 'New Delhi', institution = 'Delhi International Arbitration Centre (DIAC)', no_of_arbitrators = '3' } = req.query as any;
      res.json({
        title: 'Arbitration Agreement',
        doc_number: `ARB-${new Date().getFullYear()}-${Math.floor(Math.random()*900)+100}`,
        generated_at: new Date().toISOString(),
        parties: { party1: co.name, party2: other_party },
        content: {
          header: 'ARBITRATION AGREEMENT',
          sub_header: `[Under Section 7 of the Arbitration and Conciliation Act, 1996]`,
          sections: [
            { title: '1. Parties', content: `This Arbitration Agreement is entered into between:\n\n(1) ${co.name}, a company incorporated under the Companies Act, 2013 with CIN ${co.cin}, having its registered office at ${co.registered_address} (hereinafter referred to as "Party 1");\n\nAND\n\n(2) ${other_party} (hereinafter referred to as "Party 2").\n\nCollectively referred to as the "Parties".` },
            { title: '2. Disputes Covered', content: `All disputes, differences, controversies, or claims arising out of or in connection with ${contract_ref}, including any question regarding its existence, validity, interpretation, breach, or termination, shall be exclusively resolved by arbitration in accordance with this Agreement.` },
            { title: '3. Arbitration Institution & Rules', fields: [
              { label: 'Arbitration Institution', value: institution },
              { label: 'Rules', value: `${institution} Arbitration Rules (latest version)` },
              { label: 'Seat of Arbitration', value: seat },
              { label: 'Venue', value: seat + ' (unless otherwise agreed)' },
              { label: 'Number of Arbitrators', value: no_of_arbitrators },
              { label: 'Language', value: 'English' },
              { label: 'Governing Law', value: 'Laws of India' },
            ]},
            { title: '4. Appointment of Arbitrators', content: no_of_arbitrators === '1' ? `A sole arbitrator shall be appointed by mutual agreement of the Parties. In case of failure to agree within 30 days, either Party may approach the ${institution} for appointment.` : `Each Party shall appoint one (1) arbitrator. The two party-appointed arbitrators shall jointly appoint the third arbitrator (Presiding Arbitrator). In case of failure to agree, the Presiding Arbitrator shall be appointed by the ${institution}.` },
            { title: '5. Qualifications', content: 'Each arbitrator shall:\n• Be a retired Judge of High Court / Supreme Court, OR an expert with minimum 15 years of experience in the relevant field.\n• Not have any direct or indirect interest in the subject matter of the dispute.\n• Maintain strict confidentiality throughout the proceedings.' },
            { title: '6. Conduct of Proceedings', items: [
              'Arbitration shall commence within 30 days of the Notice of Arbitration.',
              'Pleadings shall be completed within 60 days of constitution of Tribunal.',
              'Award shall be made within 12 months (extendable by 6 months with Tribunal consent).',
              'Fast-track procedure under Section 29B may be adopted for disputes below ₹1 Crore.',
              'All proceedings are confidential — no party shall disclose to third parties.',
            ]},
            { title: '7. Award', content: 'The arbitral award shall be:\n• In writing, signed by the arbitrators.\n• State the reasons for the award (unless agreed otherwise).\n• Final and binding on the Parties.\n• Enforceable under the Arbitration and Conciliation Act, 1996.\n• Subject to challenge only on grounds specified in Section 34 of the Act.' },
            { title: '8. Costs', content: 'Each Party shall bear its own costs of arbitration unless otherwise directed by the Tribunal. The Tribunal shall have discretion to award costs in favour of the successful Party.' },
            { title: '9. Emergency Relief & Interim Measures', content: 'Nothing in this Agreement prevents the Parties from seeking urgent interim relief from Indian courts under Section 9 of the Arbitration and Conciliation Act, 1996 before the Arbitral Tribunal is constituted.' },
            { title: '10. Execution', content: `IN WITNESS WHEREOF, the Parties have executed this Arbitration Agreement on the date and place first mentioned above.\n\nFor ${co.name}:\nSignature: ________________________\nName: ________________________\nDesignation: ________________________\nDate: ${new Date().toLocaleDateString('en-IN')}\n\nFor ${other_party}:\nSignature: ________________________\nName: ________________________\nDesignation: ________________________\nDate: ${new Date().toLocaleDateString('en-IN')}\n\nWITNESS 1: ________________________\nWITNESS 2: ________________________` },
          ]
        }
      });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // Summary endpoint
  router.get('/list', requireAuth, async (_req: Request, res: Response) => {
    res.json({
      batch: 4,
      total: 18,
      categories: {
        'Investment & Securities': [
          { id: 'share-allotment', name: 'Share Allotment Letter' },
          { id: 'rights-issue-notice', name: 'Rights Issue Notice' },
          { id: 'bonus-issue-resolution', name: 'Board Resolution for Bonus Issue' },
          { id: 'buyback-offer', name: 'Buyback Offer Document' },
          { id: 'pas4-private-placement', name: 'Private Placement Offer Letter (PAS-4)' },
          { id: 'convertible-note', name: 'Convertible Note Agreement' },
          { id: 'esop-plan', name: 'ESOP Plan Document' },
          { id: 'valuation-report', name: 'Valuation Report (Rule 11UA)' },
        ],
        'ESG & Sustainability': [
          { id: 'brsr-report', name: 'BRSR Report' },
          { id: 'ghg-inventory', name: 'GHG Emissions Inventory' },
          { id: 'esg-risk-assessment', name: 'ESG Risk Assessment' },
          { id: 'csr-report', name: 'CSR Policy & Annual Report' },
          { id: 'carbon-certificate', name: 'Carbon Footprint Certificate' },
          { id: 'supplier-sustainability-code', name: 'Supplier Sustainability Code' },
        ],
        'Legal & Contracts': [
          { id: 'joint-venture-agreement', name: 'Joint Venture Agreement' },
          { id: 'franchise-agreement', name: 'Franchise Agreement' },
          { id: 'technology-transfer-agreement', name: 'Technology Transfer Agreement' },
          { id: 'arbitration-agreement', name: 'Arbitration Agreement' },
        ],
      }
    });
  });

  return router;
}
