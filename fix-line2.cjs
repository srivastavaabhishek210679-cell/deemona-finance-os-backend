const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let lines = fs.readFileSync(f, "utf8").split("\n");
// Fix line 2 (index 1)
lines[1] = "import { createSSERouter, setupCDC } from './routes/sseRoutes';";
fs.writeFileSync(f, lines.join("\n"), "utf8");
console.log("Fixed line 2:", lines[1]);
