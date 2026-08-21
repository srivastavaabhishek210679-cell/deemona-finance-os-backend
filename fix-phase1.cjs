const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/phase1Routes.ts';
let c = fs.readFileSync(f, 'utf8');

// Fix getFinancialSnapshot - the catch returns wrong shape
c = c.replace(
  "}).catch(() => Array(9).fill({ rows: [{}] }));",
  `}).catch(() => [
    {rows:[{total:0,outstanding:0,overdue:0}]},
    {rows:[{total:0,outstanding:0}]},
    {rows:[{total:0}]},
    {rows:[{value:0,items:0}]},
    {rows:[{count:0,payroll:0}]},
    {rows:[{budget:0,spent:0}]},
    {rows:[{cash:0}]},
    {rows:[{total:0}]},
    {rows:[{gross:0,net:0}]},
  ]);`
);

// Fix balance sheet - safer array access
c = c.replace(
  "const [ar, ap, exp, inv, emp, bud, bank, gst, payroll] = await Promise.all([",
  "const results = await Promise.all(["
);
c = c.replace(
  `]).catch(() => [
    {rows:[{total:0,outstanding:0,overdue:0}]},
    {rows:[{total:0,outstanding:0}]},
    {rows:[{total:0}]},
    {rows:[{value:0,items:0}]},
    {rows:[{count:0,payroll:0}]},
    {rows:[{budget:0,spent:0}]},
    {rows:[{cash:0}]},
    {rows:[{total:0}]},
    {rows:[{gross:0,net:0}]},
  ]);`,
  `]).catch(() => Array(9).fill({rows:[{}]}));
  const [ar, ap, exp, inv, emp, bud, bank, gst, payroll] = results;`
);

fs.writeFileSync(f, c, 'utf8');
console.log('Fixed');
