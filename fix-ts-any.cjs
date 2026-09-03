const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/routes/phase1Routes.ts";
let c = fs.readFileSync(f, "utf8");

c = c.replace(
  "const data = await resp.json();\n      const meta = data?.chart?.result?.[0]?.meta;",
  "const data = await resp.json() as any;\n      const meta = data?.chart?.result?.[0]?.meta;"
);

fs.writeFileSync(f, c, "utf8");
console.log("Fixed. Has as any:", c.includes("json() as any"));
