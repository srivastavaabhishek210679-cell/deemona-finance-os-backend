const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");

// Find and remove the old setupCDC function definition from index.ts
const oldCDCStart = c.indexOf("// \u2500\u2500 pg_notify CDC");
const oldCDCEnd = c.indexOf("setupCDC(pool);") + "setupCDC(pool);".length;

if (oldCDCStart > -1 && oldCDCEnd > oldCDCStart) {
  const removed = c.substring(oldCDCStart, oldCDCEnd);
  console.log("Removing CDC block:", removed.length, "chars");
  console.log("First 100:", removed.substring(0, 100));
  // Replace entire old CDC block with just the new call
  c = c.substring(0, oldCDCStart) + "setupCDC(pool);\n" + c.substring(oldCDCEnd);
  fs.writeFileSync(f, c, "utf8");
  console.log("Done. Old CDC removed, new call kept");
} else {
  console.log("CDC start:", oldCDCStart, "CDC end:", oldCDCEnd);
}
