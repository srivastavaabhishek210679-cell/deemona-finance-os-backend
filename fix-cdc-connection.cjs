const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/routes/sseRoutes.ts";
let c = fs.readFileSync(f, "utf8");

// Use direct connection (not pooler) for LISTEN/NOTIFY
// Neon pooler doesn't support LISTEN - need direct endpoint
c = c.replace(
  "connectionString: process.env.DATABASE_URL,",
  "connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL?.replace('-pooler', '') || process.env.DATABASE_URL,"
);

fs.writeFileSync(f, c, "utf8");
console.log("Fixed - using direct connection for CDC");
