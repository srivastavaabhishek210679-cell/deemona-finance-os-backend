const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");

// Remove old SSE route block
const oldSSEStart = c.indexOf("// SSE endpoint - clients connect here");
const oldSSEEnd = c.indexOf("setupCDC(pool);", oldSSEStart);

if (oldSSEStart > -1 && oldSSEEnd > oldSSEStart) {
  const oldBlock = c.substring(oldSSEStart, oldSSEEnd);
  console.log("Removing old SSE block:", oldBlock.length, "chars");
  c = c.replace(oldBlock, "");
  console.log("Old SSE removed");
}

// Also remove sseClients map if still present
c = c.replace(
  "// SSE broadcast helper - broadcast to all clients of a tenant\nconst sseClients = new Map<string, Set<any>>();\n\nconst broadcastToTenant = (tenantId: string, event: any) => {\n  if (!tenantId) return;\n  const clients = sseClients.get(tenantId);\n  if (!clients || clients.size === 0) return;\n  const data = `data: ${JSON.stringify(event)}\n\n`;\n  clients.forEach(client => {\n    try { client.write(data); } catch {}\n  });\n};\n\n",
  ""
);

// Wire createSSERouter before 404 handler
if (!c.includes("createSSERouter(pool)")) {
  c = c.replace(
    "// \u2500\u2500 404",
    "app.use('/api/stream', createSSERouter(pool));\n\n// \u2500\u2500 404"
  );
  console.log("SSE router wired");
}

fs.writeFileSync(f, c, "utf8");
console.log("Done");
console.log("Has createSSERouter wire:", c.includes("createSSERouter(pool)"));
console.log("Has old SSE route:", c.includes("// SSE endpoint"));
