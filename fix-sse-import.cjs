const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");
c = c.replace(
  "import { createSSERouter, setupCDC, createSSETestRouter }",
  "import { createSSERouter, setupCDC, createSSETestRouter } from './routes/sseRoutes';\n// duplicate removed"
);
// Fix properly
c = c.replace(
  /import \{ createSSERouter, setupCDC, createSSETestRouter \}.*\n\/\/ duplicate removed/,
  "import { createSSERouter, setupCDC, createSSETestRouter } from './routes/sseRoutes';"
);
// Actually just ensure the import is correct
c = c.replace(
  "import { createSSERouter, setupCDC, createSSETestRouter } from './routes/sseRoutes';",
  "import { createSSERouter, setupCDC } from './routes/sseRoutes';"
);
// Remove cdc test route wiring if present
c = c.replace(
  "\napp.use('/api/cdc', createSSETestRouter(pool));",
  ""
);
fs.writeFileSync(f, c, "utf8");
console.log("Fixed. Import:", c.match(/import.*sseRoutes.*/)?.[0]);
