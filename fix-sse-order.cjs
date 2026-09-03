const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");

// Find the SSE block - from sseClients map to setupCDC call
const sseStart = c.indexOf("// SSE broadcast helper");
const sseEnd = c.indexOf("setupCDC().catch", sseStart);
const sseBlock = c.substring(sseStart, sseEnd);

// Find the 404 handler
const handler404 = c.indexOf("// \u2500\u2500 404");

console.log("SSE block at:", sseStart, "length:", sseBlock.length);
console.log("404 handler at:", handler404);
console.log("SSE is after 404:", sseStart > handler404);

if (sseStart > handler404) {
  // Remove SSE block from current position
  c = c.replace(sseBlock, "");
  // Insert SSE block before 404 handler
  const new404Idx = c.indexOf("// \u2500\u2500 404");
  c = c.substring(0, new404Idx) + sseBlock + "\n" + c.substring(new404Idx);
  console.log("Moved SSE block before 404 handler");
  console.log("New SSE position:", c.indexOf("app.get('/api/stream/live'"));
  console.log("New 404 position:", c.indexOf("// \u2500\u2500 404"));
}

fs.writeFileSync(f, c, "utf8");
console.log("Done");
