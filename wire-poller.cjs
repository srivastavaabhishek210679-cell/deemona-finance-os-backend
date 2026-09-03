const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");
if (!c.includes("universalPollerRoutes")) {
  c = c.replace("import { createSSERouter", "import { createUniversalPollerRouter, startUniversalPoller } from './routes/universalPollerRoutes';\nimport { createSSERouter");
  c = c.replace("app.use('/api/stream', createSSERouter(pool));", "app.use('/api/stream', createSSERouter(pool));\n  app.use('/api/poller', createUniversalPollerRouter(pool));\n  startUniversalPoller(pool);");
  fs.writeFileSync(f, c, "utf8");
  console.log("Backend wired:", c.includes("universalPollerRoutes"));
}
