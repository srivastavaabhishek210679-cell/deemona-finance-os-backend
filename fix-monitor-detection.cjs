const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/services/driveMonitorMultiTenant.ts';
let c = fs.readFileSync(f, 'utf8');

// Fix 1: Detection order - check WEEKLY before MONTHLY
// weekly_summary_w33.xlsx was detected as monthly because month name check runs first
// Fix: check weekly patterns first, then monthly
c = c.replace(
  `function detectFileType(filename: string): FileType {
  const lower = filename.toLowerCase();
  if (!FINANCIAL_EXTS.some(ext => lower.endsWith(ext))) return null;
  if (MONTH_PATTERNS.some(p => lower.includes(p)) || MONTH_NAMES.some(m => lower.includes(m))) return 'monthly';
  if (WEEK_PATTERNS.some(p => lower.includes(p))) return 'weekly';
  if (DAILY_PATTERNS.some(p => lower.includes(p)) || DAY_NAMES.some(d => lower.includes(d))) return 'daily';
  return null;
}`,
  `function detectFileType(filename: string): FileType {
  const lower = filename.toLowerCase();
  if (!FINANCIAL_EXTS.some(ext => lower.endsWith(ext))) return null;
  // Check weekly FIRST to avoid month name false positives
  if (WEEK_PATTERNS.some(p => lower.includes(p))) return 'weekly';
  // Check daily before monthly
  if (DAILY_PATTERNS.some(p => lower.includes(p)) || DAY_NAMES.some(d => lower.includes(d))) return 'daily';
  // Monthly last
  if (MONTH_PATTERNS.some(p => lower.includes(p)) || MONTH_NAMES.some(m => lower.includes(m))) return 'monthly';
  return null;
}`
);

// Fix 2: PDF support - extract text from PDF using pdfjs or just send metadata
// For PDF files, send the raw buffer as base64 to Claude with document type
c = c.replace(
  `  let preview = '';
  if (['csv','txt'].includes(ext)) {
    preview = buffer.toString('utf8').substring(0, 6000);
  } else {
    preview = \`[\${ext.toUpperCase()} file: \${filename}, \${buffer.length} bytes]\`;
  }`,
  `  let preview = '';
  if (['csv','txt'].includes(ext)) {
    preview = buffer.toString('utf8').substring(0, 6000);
  } else if (ext === 'pdf') {
    // For PDF: extract readable text by looking for plain text between PDF markers
    const pdfText = buffer.toString('latin1');
    const textMatches = pdfText.match(/BT[\s\S]*?ET/g) || [];
    const extracted = textMatches
      .join(' ')
      .replace(/[^\x20-\x7E\n]/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim()
      .substring(0, 4000);
    preview = extracted.length > 100 
      ? extracted 
      : \`[PDF file: \${filename}, \${buffer.length} bytes. Binary content - analyzing metadata and filename only.]\`;
  } else {
    preview = \`[\${ext.toUpperCase()} file: \${filename}, \${buffer.length} bytes]\`;
  }`
);

fs.writeFileSync(f, c, 'utf8');
console.log('Fixed detection order and PDF support');
console.log('Weekly before monthly:', c.indexOf('WEEK_PATTERNS') < c.indexOf('MONTH_PATTERNS'));
