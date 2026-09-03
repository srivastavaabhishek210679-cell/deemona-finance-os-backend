const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");

if (!c.includes("sseRoutes")) {
  // Add import after other imports
  c = c.replace(
    "import { createBatch4DocsRouter }",
    "import { createSSERouter, setupCDC } from './routes/sseRoutes';\nimport { createBatch4DocsRouter }"
  );
  // Add route before 404 handler
  c = c.replace(
    "// \u2500\u2500 404",
    "app.use('/api/stream', createSSERouter(pool));\n\n// \u2500\u2500 404"
  );
  // Remove old CDC code from index.ts
  c = c.replace(
    "setupCDC().catch(e => console.error('[CDC] Setup failed:', e.message));",
    "setupCDC(pool);"
  );
  fs.writeFileSync(f, c, "utf8");
  console.log("Wired. Has sseRoutes:", c.includes("sseRoutes"));
  console.log("Has stream route:", c.includes("/api/stream"));
}
