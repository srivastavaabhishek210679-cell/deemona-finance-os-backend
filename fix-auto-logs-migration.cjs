const fs = require('fs');

// Add migration to ensure automation_logs has correct columns
const migrationCode = `
// ── Ensure automation_logs table exists with correct schema ──
async function ensureAutomationLogs(pool: Pool): Promise<void> {
  try {
    await pool.query(\`
      CREATE TABLE IF NOT EXISTS automation_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID,
        automation_type VARCHAR(100),
        status VARCHAR(50),
        detail TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    \`);
    // Add missing columns if table exists without them
    await pool.query(\`ALTER TABLE automation_logs ADD COLUMN IF NOT EXISTS automation_type VARCHAR(100)\`).catch(() => {});
    await pool.query(\`ALTER TABLE automation_logs ADD COLUMN IF NOT EXISTS status VARCHAR(50)\`).catch(() => {});
    await pool.query(\`ALTER TABLE automation_logs ADD COLUMN IF NOT EXISTS detail TEXT\`).catch(() => {});
    await pool.query(\`ALTER TABLE automation_logs ADD COLUMN IF NOT EXISTS tenant_id UUID\`).catch(() => {});
  } catch (e) {
    console.error('[Automation] Migration error:', e);
  }
}
`;

const f = 'C:/deemona-finance-os/backend/src/services/automationEngine.ts';
let c = fs.readFileSync(f, 'utf8');

// Add migration function before registerAutomationCrons
if (!c.includes('ensureAutomationLogs')) {
  c = c.replace(
    'export function registerAutomationCrons(pool: Pool): void {',
    migrationCode + '\nexport function registerAutomationCrons(pool: Pool): void {'
  );
  // Call it at start of registerAutomationCrons
  c = c.replace(
    "console.log('[Automation] Registering automation cron jobs...');",
    "ensureAutomationLogs(pool).catch(() => {});\n  console.log('[Automation] Registering automation cron jobs...');"
  );
  console.log('✓ ensureAutomationLogs migration added');
}

fs.writeFileSync(f, c, 'utf8');
console.log('Done');
