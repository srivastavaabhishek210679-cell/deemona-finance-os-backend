const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/services/automationEngine.ts';
let c = fs.readFileSync(f, 'utf8');

// Replace hardcoded admin email with dynamic tenant email lookup
// Add a helper function to get tenant admin email

const helperFn = `
// ── Get tenant admin email dynamically ───────────────────────
async function getTenantAdminEmail(pool: Pool, tenantId: string): Promise<string> {
  try {
    // 1. Check monitor settings recipients first
    const monitor = await pool.query(
      'SELECT recipients FROM monitor_settings WHERE tenant_id=$1 AND enabled=true LIMIT 1',
      [tenantId]
    );
    if (monitor.rows[0]?.recipients?.length > 0) return monitor.rows[0].recipients[0];
    
    // 2. Check tenant admin user email
    const admin = await pool.query(
      "SELECT email FROM users WHERE tenant_id=$1 AND role IN ('admin','owner') ORDER BY created_at ASC LIMIT 1",
      [tenantId]
    );
    if (admin.rows[0]?.email) return admin.rows[0].email;
    
    // 3. Fall back to env var
    return process.env.ADMIN_EMAIL || 'admin@deemona.com';
  } catch {
    return process.env.ADMIN_EMAIL || 'admin@deemona.com';
  }
}

// ── Get all tenant notification emails ────────────────────────
async function getTenantNotificationEmails(pool: Pool, tenantId: string): Promise<string[]> {
  try {
    const monitor = await pool.query(
      'SELECT recipients FROM monitor_settings WHERE tenant_id=$1 LIMIT 1',
      [tenantId]
    );
    if (monitor.rows[0]?.recipients?.length > 0) return monitor.rows[0].recipients;
    const admin = await pool.query(
      "SELECT email FROM users WHERE tenant_id=$1 AND role IN ('admin','owner') ORDER BY created_at ASC LIMIT 3",
      [tenantId]
    );
    if (admin.rows.length > 0) return admin.rows.map((r: any) => r.email);
    return [process.env.ADMIN_EMAIL || 'admin@deemona.com'];
  } catch {
    return [process.env.ADMIN_EMAIL || 'admin@deemona.com'];
  }
}
`;

// Insert helper functions before the first export
c = c.replace(
  '// ── Helper functions ──────────────────────────────────────────',
  helperFn + '\n// ── Helper functions ──────────────────────────────────────────'
);

// Replace all hardcoded adminEmail lookups with dynamic ones
c = c.split("const adminEmail = process.env.ADMIN_EMAIL || 'admin@deemona.com';").join(
  "const adminEmail = await getTenantAdminEmail(pool, tenantId);"
);

// For functions that send to multiple recipients, use getTenantNotificationEmails
// In checkLowCashAlert - send to all recipients
c = c.replace(
  `const adminEmail = await getTenantAdminEmail(pool, tenantId);
      const managerPhone = await getManagerPhone(pool, tenantId);

      const message = \`*Deemona Finance - CASH ALERT*`,
  `const recipients = await getTenantNotificationEmails(pool, tenantId);
      const adminEmail = recipients[0];
      const managerPhone = await getManagerPhone(pool, tenantId);

      const message = \`*Deemona Finance - CASH ALERT*`
);

// Add v2 marker
c = '// v2 - dynamic tenant email\n' + c;

fs.writeFileSync(f, c, 'utf8');
console.log('Fixed: dynamic tenant admin email');
console.log('Has getTenantAdminEmail:', c.includes('getTenantAdminEmail'));
console.log('Has getTenantNotificationEmails:', c.includes('getTenantNotificationEmails'));
console.log('Has hardcoded admin@deemona.com:', (c.match(/admin@deemona\.com/g)||[]).length);
