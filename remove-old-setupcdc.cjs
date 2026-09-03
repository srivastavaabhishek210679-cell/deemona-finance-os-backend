const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let lines = fs.readFileSync(f, "utf8").split("\n");

// Find old setupCDC definition inside start()
const oldDefIdx = lines.findIndex(l => l.includes("const setupCDC = async () => {"));
console.log("Old setupCDC def at line:", oldDefIdx + 1);

// Find its end - look for the setTimeout(setupCDC, 5000) line
const oldEndIdx = lines.findIndex((l,i) => i > oldDefIdx && l.includes("setTimeout(setupCDC, 5000)"));
console.log("Old setupCDC end at line:", oldEndIdx + 1);

if (oldDefIdx > -1 && oldEndIdx > oldDefIdx) {
  // Remove from oldDefIdx to oldEndIdx inclusive
  lines.splice(oldDefIdx, oldEndIdx - oldDefIdx + 1);
  console.log("Removed", oldEndIdx - oldDefIdx + 1, "lines");
}

// Also remove the extra setupCDC(pool) that was left at line 380
// Find any setupCDC(pool) that is NOT inside start() or app.use
const remaining = lines.map((l,i) => ({l,i})).filter(x => x.l.includes("setupCDC(pool)"));
console.log("Remaining setupCDC(pool) calls:", remaining.map(x => x.i+1));
// Keep only the one inside app.use (via createSSERouter) - remove standalone ones
remaining.forEach(({l,i}) => {
  if (!l.includes("app.use") && l.trim() === "setupCDC(pool);") {
    lines[i] = ""; // blank it
    console.log("Blanked standalone setupCDC(pool) at line:", i+1);
  }
});

fs.writeFileSync(f, lines.join("\n"), "utf8");
const c = fs.readFileSync(f, "utf8");
console.log("Has old setupCDC def:", c.includes("const setupCDC = async"));
console.log("Has import setupCDC:", c.includes("from './routes/sseRoutes'"));
