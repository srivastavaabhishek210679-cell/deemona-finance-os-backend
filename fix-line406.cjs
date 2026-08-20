const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/eventBusRoutes.ts';
const lines = fs.readFileSync(f, 'utf8').split('\n');
lines[405] = "        await pool.query('INSERT INTO automation_logs (tenant_id, automation_type, status, detail, created_at) VALUES ($1, $2, $3, $4, NOW())', [tenantId, 'SCHEDULED_REPORT', 'success', result.subject + ' to ' + email]).catch(() => {});";
fs.writeFileSync(f, lines.join('\n'), 'utf8');
console.log('Fixed:', lines[405].substring(0,80));
