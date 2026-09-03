const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/routes/sseRoutes.ts";
let c = fs.readFileSync(f, "utf8");

// Add a test endpoint to verify CDC triggers exist
const testRoute = `
export function createSSETestRouter(pool: Pool): Router {
  const router = Router();
  router.get('/cdc-status', async (req: any, res: any) => {
    try {
      const triggers = await pool.query(\`
        SELECT trigger_name, event_object_table 
        FROM information_schema.triggers 
        WHERE trigger_name LIKE '%_notify'
        ORDER BY event_object_table
      \`);
      const fn = await pool.query(\`
        SELECT proname FROM pg_proc WHERE proname = 'notify_data_change'
      \`);
      res.json({
        trigger_function_exists: fn.rows.length > 0,
        triggers: triggers.rows,
        trigger_count: triggers.rows.length
      });
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });
  return router;
}
`;

if (!c.includes("cdc-status")) {
  c = c + "\n" + testRoute;
  fs.writeFileSync(f, c, "utf8");
  console.log("Test route added");
}
