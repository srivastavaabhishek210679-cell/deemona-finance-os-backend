const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/routes/driveMonitorRoutes.ts';
let c = fs.readFileSync(f, 'utf8');

// Fix line 64 - data.files
c = c.replace(
  'const data = await resp.json();\n    return data.files || [];',
  'const data = await resp.json() as any;\n    return (data.files || []) as DriveFile[];'
);

// Fix lines 261-264 - ingestData properties
c = c.replace(
  'const ingestData = await ingestResp.json();',
  'const ingestData = await ingestResp.json() as any;'
);

fs.writeFileSync(f, c, 'utf8');
console.log('Fixed. Size:', fs.statSync(f).size);
