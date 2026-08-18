const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/services/driveMonitorMultiTenant.ts';
let lines = fs.readFileSync(f, 'utf8').split('\n');

// Find and fix detectFileType function
let inFunc = false;
let funcStart = -1;
let funcEnd = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('function detectFileType')) {
    funcStart = i;
    inFunc = true;
  }
  if (inFunc && i > funcStart && lines[i].includes('}')) {
    funcEnd = i;
    break;
  }
}

console.log('detectFileType found at lines:', funcStart + 1, 'to', funcEnd + 1);
console.log('Current function:');
lines.slice(funcStart, funcEnd + 1).forEach(l => console.log(' ', l));

// Replace with fixed version (weekly before monthly)
const newFunc = [
  'function detectFileType(filename: string): FileType {',
  '  const lower = filename.toLowerCase();',
  '  if (!FINANCIAL_EXTS.some(ext => lower.endsWith(ext))) return null;',
  '  // Check weekly FIRST to avoid false positives from month names',
  "  if (WEEK_PATTERNS.some(p => lower.includes(p))) return 'weekly';",
  '  // Check daily before monthly',
  "  if (DAILY_PATTERNS.some(p => lower.includes(p)) || DAY_NAMES.some(d => lower.includes(d))) return 'daily';",
  '  // Monthly last',
  "  if (MONTH_PATTERNS.some(p => lower.includes(p)) || MONTH_NAMES.some(m => lower.includes(m))) return 'monthly';",
  '  return null;',
  '}',
];

lines.splice(funcStart, funcEnd - funcStart + 1, ...newFunc);

// Also fix PDF preview extraction
const content = lines.join('\n');
const fixedContent = content.replace(
  "  } else {\n    preview = `[${ext.toUpperCase()} file: ${filename}, ${buffer.length} bytes]`;\n  }",
  `  } else if (ext === 'pdf') {
    // Extract readable text from PDF
    const pdfStr = buffer.toString('latin1');
    const matches = pdfStr.match(/\\(([^)]{3,200})\\)/g) || [];
    const extracted = matches
      .map(m => m.slice(1, -1))
      .filter(t => /[a-zA-Z]{3,}/.test(t))
      .join(' ')
      .substring(0, 4000);
    preview = extracted.length > 50 ? extracted : \`[PDF: \${filename}, \${buffer.length} bytes]\`;
  } else {
    preview = \`[\${ext.toUpperCase()} file: \${filename}, \${buffer.length} bytes]\`;
  }`
);

fs.writeFileSync(f, fixedContent, 'utf8');

// Verify
const final = fs.readFileSync(f, 'utf8');
const weekIdx = final.indexOf("return 'weekly'");
const monthIdx = final.indexOf("return 'monthly'");
console.log('\nAfter fix:');
console.log('Weekly detected before monthly:', weekIdx < monthIdx);
console.log('PDF extraction added:', final.includes("ext === 'pdf'"));
