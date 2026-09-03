const fs = require("fs");
const f = "C:/deemona-finance-os/backend/src/index.ts";
let c = fs.readFileSync(f, "utf8");

// Find start of CDC block inside start()
const cdcStart = c.indexOf("// ── pg_notify CDC");
const startFnIdx = c.lastIndexOf("async function start()", cdcStart);
console.log("start() at:", startFnIdx);
console.log("CDC at:", cdcStart);

// Find where start() ends - look for the closing brace and app.listen after CDC
const setupCDCCall = c.indexOf("setupCDC().catch", cdcStart);
const appListenIdx = c.indexOf("app.listen(", cdcStart);
console.log("setupCDC call at:", setupCDCCall);
console.log("app.listen at:", appListenIdx);

// Show context around app.listen
console.log("Around app.listen:");
console.log(c.substring(appListenIdx-50, appListenIdx+100));
