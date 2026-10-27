// Wires the scheduled reports into src/index.ts. Run from C:\deemona-finance-os\backend :  node apply-reports.cjs
const fs = require('fs')
const file = 'src/index.ts'
let t = fs.readFileSync(file, 'utf8'); if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
const eol = t.includes('\r\n') ? '\r\n' : '\n'
const lines = t.split(/\r?\n/)
let bad = false
function add(name, already, anchor, text) {
  if (lines.some(l => l.includes(already))) return console.log('already  ' + name)
  const i = lines.findIndex(l => anchor.test(l))
  if (i < 0) { console.log('NO ANCHOR ' + name); bad = true; return }
  lines.splice(i + 1, 0, lines[i].match(/^\s*/)[0] + text); console.log('added    ' + name + ' (after line ' + (i + 1) + ')')
}
add('import', 'startScheduledReports }', /import\s*\{\s*startCfoProactiveJob\s*\}/, "import { startScheduledReports } from './jobs/scheduledReports';")
add('start call', 'startScheduledReports(pool)', /^\s*startCfoProactiveJob\(pool\);/, 'startScheduledReports(pool);')
fs.writeFileSync(file, lines.join(eol), 'utf8')
process.exitCode = bad ? 1 : 0
