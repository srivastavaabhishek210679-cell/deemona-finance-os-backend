const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");

// Fix JWT secret to match auth middleware exactly
c = c.replace(
  "const decoded = jwtLib.verify(token, process.env.JWT_SECRET || 'deemona-secret-2024') as any;",
  "const decoded = jwtLib.verify(token, process.env.JWT_SECRET!) as any;"
);

// Also add debug logging to understand what is happening
c = c.replace(
  "app.get('/api/stream/live', (req: any, res: any) => {",
  `app.get('/api/stream/live', (req: any, res: any) => {
  console.log('[SSE] Request received, token:', req.query.token ? 'present' : 'missing');`
);

fs.writeFileSync(f, c, "utf8");
console.log("Fixed JWT secret");
