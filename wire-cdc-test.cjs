const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");
if (!c.includes("cdc-status")) {
  c = c.replace(
    "import { createSSERouter, setupCDC }",
    "import { createSSERouter, setupCDC, createSSETestRouter }"
  );
  c = c.replace(
    "app.use('/api/stream', createSSERouter(pool));",
    "app.use('/api/stream', createSSERouter(pool));\napp.use('/api/cdc', createSSETestRouter(pool));"
  );
  fs.writeFileSync(f, c, "utf8");
  console.log("Wired");
}
