const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");

// Fix 1: Add SSL to CDC pg.Client
c = c.replace(
  "const cdcClient = new pg.Client({ connectionString: process.env.DATABASE_URL });",
  "const cdcClient = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });"
);

// Fix 2: The SSE route is inside start() which is fine
// But we need to verify JWT_SECRET matches
// Just log when route is hit for debugging
c = c.replace(
  "[SSE] Request received, token:",
  "[SSE] Hit /api/stream/live, token:"
);

fs.writeFileSync(f, c, "utf8");
console.log("Fixed SSL for CDC");
console.log("Has SSL:", c.includes("rejectUnauthorized: false"));
