const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let lines = fs.readFileSync(f, "utf8").split("\n");

// Find app.use('/api/stream' line and add setupCDC before it
const streamIdx = lines.findIndex(l => l.includes("app.use('/api/stream'"));
console.log("Stream route at line:", streamIdx + 1);
lines.splice(streamIdx, 0, "  setupCDC(pool);");

fs.writeFileSync(f, lines.join("\n"), "utf8");
console.log("Done. setupCDC call added at line:", streamIdx + 1);
