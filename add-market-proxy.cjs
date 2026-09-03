const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/routes/phase1Routes.ts";
let c = fs.readFileSync(f, "utf8");

if (!c.includes("market/quote")) {
  const route = `
  // NSE Stock Quote Proxy (bypasses browser CORS)
  router.get("/market/quote", async (req: Request, res: Response) => {
    try {
      const sym = req.query.sym as string;
      if (!sym) return res.status(400).json({ error: "sym required" }) as any;
      const resp = await fetch(
        "https://query1.finance.yahoo.com/v8/finance/chart/" + sym + ".NS?interval=1d&range=1d",
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      if (!resp.ok) throw new Error("Yahoo error");
      const data = await resp.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) throw new Error("No data");
      res.json({
        price: meta.regularMarketPrice,
        previousClose: meta.previousClose || meta.chartPreviousClose,
        symbol: sym,
      });
    } catch(e) {
      res.status(500).json({ error: String(e) });
    }
  });
`;
  c = c.replace("  return router;", route + "  return router;");
  fs.writeFileSync(f, c, "utf8");
  console.log("Market quote proxy added");
}
