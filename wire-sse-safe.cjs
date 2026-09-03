const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let lines = fs.readFileSync(f, "utf8").split("\n");

// Add import after line 1
lines.splice(1, 0, "import { createSSERouter, setupCDC } from './routes/sseRoutes';");

// Find 404 handler line number
const idx = lines.findIndex(l => l.includes("Route not found"));
// Insert app.use 2 lines before it
lines.splice(idx - 2, 0, "app.use('/api/stream', createSSERouter(pool));");

// Find setupCDC().catch line and replace with setupCDC(pool)
const cdcIdx = lines.findIndex(l => l.includes("setupCDC().catch"));
if (cdcIdx > -1) lines[cdcIdx] = "  setupCDC(pool);";

fs.writeFileSync(f, lines.join("\n"), "utf8");
const c = fs.readFileSync(f, "utf8");
console.log("Has import:", c.includes("from './routes/sseRoutes'"));
console.log("Has route:", c.includes("createSSERouter(pool)"));
console.log("Has CDC:", c.includes("setupCDC(pool)"));
