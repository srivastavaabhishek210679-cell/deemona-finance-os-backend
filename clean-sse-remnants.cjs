const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");

// Remove the leftover sseClients + broadcastToTenant block
const startIdx = c.indexOf("// SSE broadcast helper - broadcast to all clients of a tenant");
const endIdx = c.indexOf("setupCDC(pool);", startIdx);

if (startIdx > -1 && endIdx > startIdx) {
  const block = c.substring(startIdx, endIdx);
  console.log("Removing leftover SSE block:", block.length, "chars");
  c = c.replace(block, "");
  console.log("Removed");
}

fs.writeFileSync(f, c, "utf8");
console.log("Done");
console.log("Has sseClients:", c.includes("const sseClients"));
console.log("Has setupCDC:", c.includes("setupCDC(pool)"));
