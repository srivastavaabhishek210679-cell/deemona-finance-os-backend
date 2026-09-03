const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");
if (!c.includes("netsuiteRoutes")) {
  c = c.replace("import { createMessageStreamRouter }", "import { createNetSuiteRouter, startNetSuitePoller } from './routes/netsuiteRoutes';\nimport { createMessageStreamRouter }");
  c = c.replace("app.use('/api/stream-connections', createMessageStreamRouter(pool));", "app.use('/api/stream-connections', createMessageStreamRouter(pool));\n  app.use('/api/netsuite', createNetSuiteRouter(pool));\n  startNetSuitePoller(pool);");
  fs.writeFileSync(f, c, "utf8");
  console.log("Wired:", c.includes("netsuiteRoutes"));
}
