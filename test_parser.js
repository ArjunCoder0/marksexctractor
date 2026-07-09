import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs";
import {
  extractPageLines,
  extractMetadata,
  parseStudents,
  normalizeStudents,
  getSubjectCodes
} from "./src/text_parser.js";

async function testParser(pdfPath) {
  console.log(`\n========== Testing: ${pdfPath} ==========`);

  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  console.log(`Pages: ${pdf.numPages}`);

  let allStudents = [];
  let meta = {};

  // Test first page only for quick verification
  const page = await pdf.getPage(2);
  const lines = await extractPageLines(page);

  meta = extractMetadata(lines);
  console.log("\nMetadata:", meta);

  const students = parseStudents(lines);
  console.log(`\nStudents found on page 2: ${students.length}`);

  if (students.length > 0) {
    console.log("\nFirst student:");
    console.log(JSON.stringify(students[0], null, 2));
  }

  allStudents = students;

  const normalized = normalizeStudents(allStudents);
  const codes = getSubjectCodes(normalized);

  console.log(`\nSubject codes detected: ${codes.join(", ")}`);
  console.log(`Total normalized students: ${normalized.length}`);
}

// Test all three PDFs
const pdfs = [
  "Btech6thsemSummer25.pdf",
  "BE8thsemsummer25.pdf",
  "btech4thsemSummer25.pdf"
];

for (const pdf of pdfs) {
  try {
    await testParser(pdf);
  } catch (err) {
    console.error(`Error testing ${pdf}:`, err.message);
  }
}
