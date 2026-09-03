const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/autoIngestRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

// Fix: isFinancial used in res.json outside the if block in teams webhook
c = c.replace(
  `    // Teams requires a specific response format
    res.json({ type: 'message', text: isFinancial ? '✅ Financial data captured.' : '👍 Received.' });`,
  `    // Teams requires a specific response format
    res.json({ type: 'message', text: '👍 Received.' });`
);

fs.writeFileSync(f, c, 'utf8');
console.log('Fixed. isFinancial scope error resolved');
