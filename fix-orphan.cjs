const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let lines = fs.readFileSync(f, "utf8").split("\n");

// Find orphan } at line 261 (0-indexed: 260)
// It's the } that used to close start()
// Find app.listen line
const listenIdx = lines.findIndex(l => l.includes("app.listen(PORT"));
console.log("app.listen at:", listenIdx + 1);
console.log("Lines around it:");
for(let i=listenIdx-3; i<=listenIdx+3; i++) console.log(i+1+":", lines[i]);

// Find the closing }); of app.listen and the orphan }
const listenCloseIdx = lines.findIndex((l,i) => i > listenIdx && l.trim() === "});");
const orphanIdx = lines.findIndex((l,i) => i > listenCloseIdx && l.trim() === "}");
console.log("listen close at:", listenCloseIdx+1, "orphan } at:", orphanIdx+1);

// Remove orphan }
if (orphanIdx > -1) {
  lines.splice(orphanIdx, 1);
  console.log("Removed orphan }");
}

// Add setupCDC and createSSERouter calls before app.listen
const newListen = lines.findIndex(l => l.includes("app.listen(PORT"));
lines.splice(newListen, 0,
  "  app.use('/api/stream', createSSERouter(pool));",
  "  setupCDC(pool);",
  ""
);

const c = lines.join("\n");
fs.writeFileSync(f, c, "utf8");
console.log("Done");
console.log("Has createSSERouter:", c.includes("createSSERouter(pool)"));
console.log("Has async function start:", c.includes("async function start"));
