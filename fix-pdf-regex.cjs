const fs = require('fs');
const f = 'C:/deemona-finance-os/backend/src/services/driveMonitorMultiTenant.ts';
let c = fs.readFileSync(f, 'utf8');

// Remove the old broken PDF block and replace with simple version
const oldPdfBlock = `  } else if (ext === 'pdf') {
    // Extract readable text from PDF
    const pdfStr = buffer.toString('latin1');
    const matches = pdfStr.match(/\\(([^)]{3,200})\\)/g) || [];
    const extracted = matches
      .map(m => m.slice(1, -1))
      .filter(t => /[a-zA-Z]{3,}/.test(t))
      .join(' ')
      .substring(0, 4000);
    preview = extracted.length > 50 ? extracted : \`[PDF: \${filename}, \${buffer.length} bytes]\`;
  } else {`;

// Also handle the broken regex version from the original
// Find and replace the entire pdf block with a safe version
const lines = c.split('\n');
let inPdfBlock = false;
let pdfStart = -1;
let elseStart = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("} else if (ext === 'pdf')")) {
    pdfStart = i;
    inPdfBlock = true;
  }
  if (inPdfBlock && i > pdfStart && lines[i].trim() === '} else {') {
    elseStart = i;
    break;
  }
}

console.log('PDF block found at lines:', pdfStart + 1, 'to', elseStart + 1);

if (pdfStart > 0 && elseStart > 0) {
  const newPdfBlock = [
    "  } else if (ext === 'pdf') {",
    "    // Simple PDF text extraction - look for readable strings",
    "    const pdfStr = buffer.toString('binary');",
    "    const words = [];",
    "    let word = '';",
    "    for (let i = 0; i < Math.min(pdfStr.length, 50000); i++) {",
    "      const code = pdfStr.charCodeAt(i);",
    "      if (code >= 32 && code <= 126) {",
    "        word += pdfStr[i];",
    "      } else if (word.length >= 4) {",
    "        words.push(word);",
    "        word = '';",
    "      } else {",
    "        word = '';",
    "      }",
    "    }",
    "    preview = words.join(' ').substring(0, 4000) || `[PDF: ${filename}, ${buffer.length} bytes]`;",
    "  } else {",
  ];
  lines.splice(pdfStart, elseStart - pdfStart + 1, ...newPdfBlock);
  console.log('PDF block replaced with safe version');
}

// Also fix the old broken textMatches regex if present
const result = lines.join('\n');
const fixed = result.replace(/\.replace\(\/\[\^ -~[\s\S]*?\/g,\s*' '\)/, ".replace(/[^\\x20-\\x7E]/g, ' ')");

fs.writeFileSync(f, fixed, 'utf8');
console.log('Done! File saved.');

// Verify no syntax issues
const verify = fs.readFileSync(f, 'utf8');
console.log('Has pdf block:', verify.includes("ext === 'pdf'"));
console.log('Has broken regex:', verify.includes('[^ -~\n'));
