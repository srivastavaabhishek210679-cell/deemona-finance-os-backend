const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let lines = fs.readFileSync(f, "utf8").split("\n");

// Remove lines 308-315 (0-indexed: 307-314) - orphaned CDC remnants
// Find the pg_notify comment line
const startRemove = lines.findIndex(l => l.includes("pg_notify CDC"));
// Find the end - the }; line after it
const endRemove = lines.findIndex((l,i) => i > startRemove && l.trim() === "};");
console.log("Removing lines", startRemove+1, "to", endRemove+1);
console.log("Content:", lines.slice(startRemove, endRemove+1).join("\n"));

lines.splice(startRemove, endRemove - startRemove + 1);

fs.writeFileSync(f, lines.join("\n"), "utf8");
console.log("Done. Has pg_notify CDC comment:", fs.readFileSync(f,"utf8").includes("pg_notify CDC"));
