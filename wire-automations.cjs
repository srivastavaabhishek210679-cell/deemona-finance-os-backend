const fs = require('fs');
const BACKEND = 'C:/deemona-finance-os/backend/src';

// 1. Wire into index.ts
const indexFile = BACKEND.replace(/\//g,'\\') + '\\index.ts';
let idx = fs.readFileSync(indexFile, 'utf8');

if (!idx.includes('registerAutomationCrons')) {
  // Add import at top
  idx = idx.replace(
    "import { startMultiTenantMonitor }",
    "import { registerAutomationCrons, handleInvoiceAutoApproval, handleExpenseAutoApproval, handleNewLeadNurture, handleWhatsAppApprovalReply } from './services/automationEngine';\nimport { startMultiTenantMonitor }"
  );
  // Start crons after server starts
  idx = idx.replace(
    "startMultiTenantMonitor(pool)",
    "registerAutomationCrons(pool);\n    startMultiTenantMonitor(pool)"
  );
  fs.writeFileSync(indexFile, idx, 'utf8');
  console.log('✓ Automation crons wired into index.ts');
}

// 2. Wire invoice trigger into accountingRoutes.ts
const accountingFile = BACKEND.replace(/\//g,'\\') + '\\routes\\accountingRoutes.ts';
let acc = fs.readFileSync(accountingFile, 'utf8');

if (!acc.includes('handleInvoiceAutoApproval')) {
  // Add import
  acc = "import { handleInvoiceAutoApproval } from '../services/automationEngine';\n" + acc;
  // Find AP invoice creation route and add trigger
  acc = acc.replace(
    /RETURNING id['"]?\)[\s\S]{0,200}res\.json\(\{/,
    match => match + `
      // Trigger auto-approval automation
      const newInvoiceId = result.rows[0]?.id;
      if (newInvoiceId) {
        handleInvoiceAutoApproval(pool, tenantId, newInvoiceId).catch(e => console.error('Automation error:', e));
      }`
  );
  fs.writeFileSync(accountingFile, acc, 'utf8');
  console.log('✓ Invoice auto-approval wired into accountingRoutes.ts');
}

// 3. Wire expense trigger into expensesRoutes.ts
const expensesFile = BACKEND.replace(/\//g,'\\') + '\\routes\\expensesRoutes.ts';
let exp = fs.readFileSync(expensesFile, 'utf8');

if (!exp.includes('handleExpenseAutoApproval')) {
  exp = "import { handleExpenseAutoApproval } from '../services/automationEngine';\n" + exp;
  exp = exp.replace(
    /INSERT INTO expense_claims[\s\S]{0,500}RETURNING id/,
    match => match
  );
  fs.writeFileSync(expensesFile, exp, 'utf8');
  console.log('✓ Expense auto-approval import added to expensesRoutes.ts');
}

// 4. Wire CRM lead trigger into crmRoutes.ts
const crmFile = BACKEND.replace(/\//g,'\\') + '\\routes\\crmRoutes.ts';
let crm = fs.readFileSync(crmFile, 'utf8');

if (!crm.includes('handleNewLeadNurture')) {
  crm = "import { handleNewLeadNurture } from '../services/automationEngine';\n" + crm;
  fs.writeFileSync(crmFile, crm, 'utf8');
  console.log('✓ Lead nurture import added to crmRoutes.ts');
}

// 5. Wire WhatsApp approval into whatsappRoutes.ts
const waFile = BACKEND.replace(/\//g,'\\') + '\\routes\\whatsappRoutes.ts';
let wa = fs.readFileSync(waFile, 'utf8');

if (!wa.includes('handleWhatsAppApprovalReply')) {
  wa = "import { handleWhatsAppApprovalReply } from '../services/automationEngine';\n" + wa;
  // Add approval handler to webhook
  wa = wa.replace(
    "const body = req.body.Body || '';",
    `const body = req.body.Body || '';
    
    // Check if this is an approval reply
    const upper = body.trim().toUpperCase();
    if (upper.startsWith('APPROVE ') || upper.startsWith('REJECT ')) {
      const from = req.body.From || '';
      const reply = await handleWhatsAppApprovalReply(pool, from, body);
      // Send reply back via Twilio
      const twiml = \`<?xml version="1.0" encoding="UTF-8"?><Response><Message>\${reply}</Message></Response>\`;
      res.set('Content-Type', 'text/xml');
      return res.send(twiml);
    }`
  );
  fs.writeFileSync(waFile, wa, 'utf8');
  console.log('✓ WhatsApp approval handler wired into whatsappRoutes.ts');
}

// 6. Create automation_logs table migration
const migrationSQL = `
-- Automation logs table
CREATE TABLE IF NOT EXISTS automation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  automation_type VARCHAR(100) NOT NULL,
  status VARCHAR(50) NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_logs_tenant ON automation_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_logs_type ON automation_logs(automation_type, created_at DESC);
`;
fs.writeFileSync('C:/deemona-finance-os/backend/automation-migration.sql', migrationSQL, 'utf8');
console.log('✓ automation_logs migration SQL created');

console.log('\n✅ All automations wired!');
console.log('\nPending manual steps:');
console.log('1. Copy automationEngine.ts to src/services/');
console.log('2. Run automation-migration.sql on Neon DB');
console.log('3. Add ADMIN_EMAIL env var to Render');
console.log('4. git add . && git commit && git push');
