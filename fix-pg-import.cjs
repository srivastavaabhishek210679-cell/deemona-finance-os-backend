const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");

// Remove the pg import that was added inside the CDC block
c = c.replace(
  "// ── pg_notify CDC — Real-Time Change Detection ───────────────\n// Listen for any DB changes and broadcast to connected SSE clients\nimport pg from 'pg';",
  "// ── pg_notify CDC — Real-Time Change Detection ───────────────\n// Listen for any DB changes and broadcast to connected SSE clients"
);

// Add pg import at the very top with other imports
if (!c.includes("import pg from 'pg'")) {
  c = c.replace(
    "import express from 'express';",
    "import express from 'express';\nimport pg from 'pg';"
  );
}

fs.writeFileSync(f, c, "utf8");
console.log("Fixed. pg import at top:", c.indexOf("import pg from 'pg'") < 100);
