import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs";
import { extractPageLines } from "./src/text_parser.js";

async function debugLines(pdfPath) {
  console.log(`\n========== Debug: ${pdfPath} ==========`);

  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const page = await pdf.getPage(2);
  const lines = await extractPageLines(page);

  // Find lines that look like student identity lines (contain long numbers)
  console.log("\nLines with 7+ digit numbers (potential PRN lines):");
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const line = lines[i];
    if (/\d{7,}/.test(line.text)) {
      console.log(`\nLine ${i} (y=${line.y}):`);
      console.log(JSON.stringify(line.text));

      // Show next 5 lines
      for (let j = 1; j <= 5 && i + j < lines.length; j++) {
        console.log(`  +${j}: ${JSON.stringify(lines[i + j].text.slice(0, 150))}`);
      }
    }
  }
}

await debugLines("Btech6thsemSummer25.pdf");
