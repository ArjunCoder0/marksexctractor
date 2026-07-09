import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs";
import { extractPageLines } from "./src/text_parser.js";

const data = new Uint8Array(fs.readFileSync('Btech6thsemSummer25.pdf'));
const pdf = await pdfjsLib.getDocument({ data }).promise;
const page = await pdf.getPage(2);
const lines = await extractPageLines(page);

const studentLine = lines.find(l => l.text.includes('2022033700259876'));
console.log('Full line:');
console.log(JSON.stringify(studentLine.text));
console.log('\nExpected: spaces between YADAV and PUSHPA');
console.log('\nActual breakdown:');
const afterPRN = studentLine.text.substring(studentLine.text.indexOf('2022033700259876') + 16);
console.log('After PRN:', JSON.stringify(afterPRN));
