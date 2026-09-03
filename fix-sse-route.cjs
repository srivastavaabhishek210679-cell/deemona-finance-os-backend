const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");

// Check if jwt is already imported at top
const hasJwtImport = c.includes("import jwt from 'jsonwebtoken'") || c.includes("import * as jwt from 'jsonwebtoken'");
console.log("Has jwt import:", hasJwtImport);

// Fix: replace require with import-style jwt
c = c.replace(
  "    const jwt = require('jsonwebtoken');\n    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as any;",
  "    const jwtLib = require('jsonwebtoken');\n    const decoded = jwtLib.verify(token, process.env.JWT_SECRET || 'deemona-secret-2024') as any;"
);

// Also add CORS headers to SSE endpoint
c = c.replace(
  "  res.writeHead(200, {\n    'Content-Type': 'text/event-stream',\n    'Cache-Control': 'no-cache',\n    'Connection': 'keep-alive',\n    'Access-Control-Allow-Origin': '*',\n    'X-Accel-Buffering': 'no',\n  });",
  "  res.setHeader('Content-Type', 'text/event-stream');\n  res.setHeader('Cache-Control', 'no-cache');\n  res.setHeader('Connection', 'keep-alive');\n  res.setHeader('Access-Control-Allow-Origin', '*');\n  res.setHeader('X-Accel-Buffering', 'no');\n  res.flushHeaders();"
);

fs.writeFileSync(f, c, "utf8");
console.log("Fixed");

// Also check JWT_SECRET env var name used elsewhere
const jwtSecretMatches = (c.match(/JWT_SECRET/g)||[]).length;
console.log("JWT_SECRET references:", jwtSecretMatches);
