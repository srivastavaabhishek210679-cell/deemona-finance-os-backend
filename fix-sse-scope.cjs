const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");

// Fix 1: Add SSL to CDC client connection
c = c.replace(
  "const cdcClient = new pg.Client({ connectionString: process.env.DATABASE_URL });",
  "const cdcClient = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });"
);

// Fix 2: Move SSE route BEFORE setupCDC call so it always registers
// Find the SSE route block
const sseStart = c.indexOf("// SSE endpoint - clients connect here");
const sseEnd = c.indexOf("// Start CDC after DB connection");

// Find setupCDC call line
const setupCall = c.indexOf("setupCDC().catch");

if (sseStart > sseEnd) {
  console.log("SSE is after setupCDC call - need to move it");
} else {
  console.log("SSE at:", sseStart, "setupCDC call at:", setupCall);
  console.log("SSE is before setupCDC - route should register");
}

// Fix: Extract SSE route and sseClients and put them before start()
const sseClientsStart = c.indexOf("// SSE broadcast helper");
const sseRouteEnd = c.indexOf("setupCDC().catch", sseClientsStart);

const sseBlock = c.substring(sseClientsStart, sseRouteEnd);
console.log("SSE block length:", sseBlock.length);
console.log("SSE block starts:", sseBlock.substring(0,80));

// Remove from inside start() and add before start()
c = c.replace(sseBlock, "");
const startFnIdx = c.indexOf("async function start()");
c = c.substring(0, startFnIdx) + sseBlock + "\n" + c.substring(startFnIdx);

fs.writeFileSync(f, c, "utf8");
console.log("Done. SSE route now at global scope");
console.log("app.get stream position:", c.indexOf("app.get('/api/stream/live'"));
console.log("start() position:", c.indexOf("async function start()"));
