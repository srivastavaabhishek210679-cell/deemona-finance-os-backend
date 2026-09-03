const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");
if (!c.includes("messageStreamRoutes")) {
  c = c.replace("import { createUniversalPollerRouter", "import { createMessageStreamRouter } from './routes/messageStreamRoutes';\nimport { createUniversalPollerRouter");
  c = c.replace("app.use('/api/poller', createUniversalPollerRouter(pool));", "app.use('/api/poller', createUniversalPollerRouter(pool));\n  app.use('/api/stream-connections', createMessageStreamRouter(pool));");
  fs.writeFileSync(f, c, "utf8");
  console.log("Wired:", c.includes("messageStreamRoutes"));
}
