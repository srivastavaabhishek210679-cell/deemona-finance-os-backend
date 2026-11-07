// Specialist agents: for a one-customer delay, report each invoice's old/new arrival date and whether it falls after the horizon.
// Idempotent. Run from the backend folder (after apply-specialist-agents-backend.cjs).
const fs = require('fs');
const f = 'src/routes/specialistAgentRoutes.ts';
if (!fs.existsSync(f)) { console.error('Run from the backend folder, after the specialist agents patch'); process.exit(1); }
const raw = fs.readFileSync(f, 'utf8'); const crlf = raw.includes('\r\n'); let s = raw.replace(/\r\n/g, '\n');
if (s.includes('/*arrival-dates*/')) { console.log('Already applied'); process.exit(0); }
function rep(a, b, l) { if (!s.includes(a)) { console.error('Pattern not found: ' + l); process.exit(1); } s = s.replace(a, () => b); }
rep(`only_this_customer_is_delayed: true };`,
`only_this_customer_is_delayed: true,
      /*arrival-dates*/
      horizon_ends: addDays(today, cl(input?.days, 90, 7, 365)),
      invoices: hit.map(i => { const was = i.overdue ? addDays(today, 7) : i.due; const now = addDays(was, custDelay); return { invoice: i.ref, amount_inr: inrText(i.amount), expected_before: was, expected_after: now, falls_after_forecast_horizon: now > addDays(today, cl(input?.days, 90, 7, 365)) }; }) };`, 'customerNote');
rep(`If the answer depends on a receipt falling after the forecast horizon, say so.`,
`For a one-customer delay, always state the invoice number, the date the money was expected (expected_before) and the new date (expected_after). If falls_after_forecast_horizon is true, say plainly that the receipt lands after the forecast window (horizon_ends), so closing cash looks unchanged only because of the window, and offer to rerun with a longer horizon (days up to 365).`, 'prompt');
fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s); console.log('Done');
