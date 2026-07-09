import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs";
import { extractPageLines, parseStudents } from "./src/text_parser.js";

const data = new Uint8Array(fs.readFileSync('btech4thsemSummer25.pdf'));
const pdf = await pdfjsLib.getDocument({ data }).promise;
const page = await pdf.getPage(2);
const lines = await extractPageLines(page);

// Find first student's lines
for (let i = 0; i < lines.length; i++) {
  if (lines[i].text.includes('2024033700001096')) {
    console.log('Found student at line', i);
    console.log('\nLine 1 (identity):', JSON.stringify(lines[i].text));
    console.log('Line 2 (max marks):', JSON.stringify(lines[i+1].text));
    console.log('Line 3 (scores):', JSON.stringify(lines[i+2].text));
    console.log('Line 4 (totals):', JSON.stringify(lines[i+3].text));
    console.log('Line 5 (grades):', JSON.stringify(lines[i+4].text));
    console.log('Line 6 (subjects):', JSON.stringify(lines[i+5].text));
    break;
  }
}

console.log('\n\nParsing students...');
const students = parseStudents(lines);
console.log('Found:', students.length, 'students');
if (students.length > 0) {
  console.log('\nFirst student UA/CA values:');
  const s = students[0];
  for (const key of Object.keys(s)) {
    if (key.includes('_UA') || key.includes('_CA')) {
      console.log(key + ':', s[key]);
    }
  }
}
