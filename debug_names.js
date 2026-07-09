import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs";

async function debugNameParsing() {
  const data = new Uint8Array(fs.readFileSync("Btech6thsemSummer25.pdf"));
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const page = await pdf.getPage(2);
  const textContent = await page.getTextContent();

  // Get line with first student
  const lineMap = new Map();
  for (const item of textContent.items) {
    const text = item.str.trim();
    if (!text) continue;
    const y = Math.round(item.transform[5]);
    if (!lineMap.has(y)) lineMap.set(y, []);
    lineMap.get(y).push({ x: Math.round(item.transform[4]), text: item.str });
  }

  const lines = [];
  for (const [y, items] of lineMap.entries()) {
    items.sort((a, b) => a.x - b.x);
    const text = items.map(i => i.text).join('');
    lines.push({ y, text });
  }
  lines.sort((a, b) => b.y - a.y);

  // Find student line
  const studentLine = lines.find(l => l.text.includes('2022033700259876'));
  console.log("Full line:", studentLine.text);
  console.log("\nExpected:");
  console.log("  PRN: 2022033700259876");
  console.log("  Name: BALBUDHE TRUPTI YADAV");
  console.log("  Mother: PUSHPA");

  // Try different extraction approaches
  console.log("\n--- Approach 1: Find 16-digit PRN ---");
  const prn16 = studentLine.text.match(/(\d{16})/);
  if (prn16) {
    console.log("PRN:", prn16[1]);
    const afterPRN = studentLine.text.substring(studentLine.text.indexOf(prn16[1]) + 16);
    console.log("After PRN:", afterPRN);

    // Split before "311" college code
    const beforeCode = afterPRN.split(/\d{3}\s*\d/)[0];
    console.log("Before code:", beforeCode);

    // All uppercase words
    const words = beforeCode.match(/[A-Z]{2,}/g);
    console.log("Words:", words);
  }
}

await debugNameParsing();
