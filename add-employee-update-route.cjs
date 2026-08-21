const fs = require('fs');

// Add PUT /employees/:id route to existing employees routes or phase1Routes
const f = 'C:/deemona-finance-os/backend/src/routes/phase1Routes.ts';
let c = fs.readFileSync(f, 'utf8');

if (!c.includes("router.put('/employees")) {
  // Add employee update route before the return router line
  const newRoute = `
  // ── Update employee joining/exit data ──────────────────────
  router.put('/employees/:id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { joining_date, exit_date, exit_reason, status } = req.body;
      const result = await pool.query(
        \`UPDATE employees SET 
          joining_date = COALESCE($1::date, joining_date),
          exit_date = $2::date,
          exit_reason = $3,
          status = COALESCE($4, status),
          updated_at = NOW()
         WHERE id = $5 AND tenant_id = $6 RETURNING *\`,
        [joining_date||null, exit_date||null, exit_reason||null, status||null, req.params.id, tid(req)]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Employee not found' }) as any;
      res.json({ success: true, employee: result.rows[0] });
    } catch(e) { res.status(500).json({ error: String(e) }); }
  });

  // ── GET /employees list ───────────────────────────────────
  router.get('/employees', requireAuth, async (req: Request, res: Response) => {
    const result = await pool.query(
      \`SELECT id, name, department, status, basic_salary, joining_date, exit_date, exit_reason, employment_type FROM employees WHERE tenant_id=$1 ORDER BY name\`,
      [tid(req)]
    ).catch(() => ({ rows: [] }));
    res.json({ employees: result.rows });
  });

`;

  c = c.replace('  return router;', newRoute + '  return router;');
  fs.writeFileSync(f, c, 'utf8');
  console.log('Employee routes added');
} else {
  console.log('Already exists');
}
