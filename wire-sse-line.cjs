const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let lines = fs.readFileSync(f, "utf8").split("\n");

// Find the 404 handler line
const idx404 = lines.findIndex(l => l.includes("Route not found") || (l.includes("app.use") && l.includes("404")));
console.log("404 handler at line:", idx404 + 1);
console.log("Line:", lines[idx404]);

// Find the comment line before it (// -- 404)
let insertAt = idx404;
while (insertAt > 0 && lines[insertAt-1].includes("404")) insertAt--;
// Insert 2 lines before the 404 comment
insertAt = insertAt - 2;
console.log("Inserting at line:", insertAt + 1);

lines.splice(insertAt, 0, "app.use('/api/stream', createSSERouter(pool));", "");

// Also fix TS error - check for orphaned closing braces
fs.writeFileSync(f, lines.join("\n"), "utf8");
console.log("Done. Has createSSERouter wire:", lines.join("\n").includes("createSSERouter(pool)"));
