/**
 * Text-Based Marksheet Parser for Gondwana University PDFs
 *
 * Parses structured text directly from PDF.js textContent layers.
 * Handles B.Tech and B.E. tabulation registers with varying subject counts.
 */

/**
 * Extract all text from a PDF page, grouped into lines by Y coordinate.
 * @param {PDFPageProxy} page - pdf.js page object
 * @returns {Promise<Array<{y: number, text: string}>>} - lines sorted top-to-bottom
 */
export async function extractPageLines(page) {
  const textContent = await page.getTextContent();
  const lineMap = new Map();

  for (const item of textContent.items) {
    if (!item.str) continue; // Only skip truly empty strings

    const y = Math.round(item.transform[5]);
    if (!lineMap.has(y)) {
      lineMap.set(y, []);
    }
    lineMap.get(y).push({
      x: Math.round(item.transform[4]),
      text: item.str
    });
  }

  // Sort items within each line by X, then join with space preservation
  const lines = [];
  for (const [y, items] of lineMap.entries()) {
    items.sort((a, b) => a.x - b.x);
    const text = items.map(i => i.text).join(''); // Keep original spacing from PDF
    lines.push({ y, text });
  }

  // Sort lines top-to-bottom
  lines.sort((a, b) => b.y - a.y);

  return lines;
}

/**
 * Extract metadata from page header
 * @param {Array<{y: number, text: string}>} lines
 * @returns {Object} - {university, course, semester, examDate, college, branch}
 */
export function extractMetadata(lines) {
  const meta = {
    university: "",
    course: "",
    semester: "",
    examDate: "",
    college: "",
    branch: ""
  };

  for (const line of lines) {
    const t = line.text;

    if (t.includes("GONDWANA UNIVERSITY")) {
      meta.university = "Gondwana University, Gadchiroli";
      const dateMatch = t.match(/RESULT DATE:\s*(\d{2}-\d{2}-\d{4})/i);
      if (dateMatch) meta.examDate = dateMatch[1];
    }

    if (t.includes("TABULATION REGISTER FOR")) {
      // Extract semester
      const semMatch = t.match(/(FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH)\s+SEMESTER/i);
      if (semMatch) {
        meta.semester = semMatch[1].charAt(0) + semMatch[1].slice(1).toLowerCase() + " Semester";
      }

      // Extract course
      if (t.includes("B.TECH") || t.includes("BACHELOR OF TECHNOLOGY")) {
        meta.course = "B.Tech";
      } else if (t.includes("B.E.")) {
        meta.course = "B.E.";
      }

      // Extract branch
      if (t.includes("COMPUTER SCIENCE")) {
        meta.branch = "Computer Science and Engineering";
      }
    }

    if (t.includes("COLLEGE CODE & NAME")) {
      const collegeMatch = t.match(/:\s*\((\d+)\)(.+?)(?:,\s*\w+)?$/);
      if (collegeMatch) {
        meta.college = collegeMatch[2].trim();
      }
    }
  }

  return meta;
}

/**
 * Parse student records from page lines
 * @param {Array<{y: number, text: string}>} lines
 * @returns {Array<Object>} - array of student records
 */
export function parseStudents(lines) {
  const students = [];
  const lineTexts = lines.map(l => l.text);

  // Find student blocks: each starts with a line containing PRN (13-17 digit number)
  for (let i = 0; i < lineTexts.length - 5; i++) {
    const line1 = lineTexts[i];

    // Line 1: Identity line with PRN (13-17 digits typical for these PDFs)
    const prnMatch = line1.match(/\d{13,17}/);
    if (!prnMatch) continue;

    // Check if this looks like a student identity line (has uppercase name pattern)
    const hasNamePattern = /[A-Z]{3,}/.test(line1);
    if (!hasNamePattern) continue;

    const line2 = lineTexts[i + 1];
    const line3 = lineTexts[i + 2];
    const line4 = lineTexts[i + 3];
    const line5 = lineTexts[i + 4];
    const line6 = lineTexts[i + 5];

    // Line 2 should be max marks (contains colons like "80:20/40")
    if (!line2.includes(':') || !line2.includes('/')) continue;

    // Line 3 should be scores (pipe-separated, no colon-slash pattern like "80:20/40")
    if (line3.includes('80:20') || line3.includes(':25/') || line3.includes(':50/')) continue; // Skip max marks lines
    if (!line3.includes('|')) continue;

    try {
      const student = parseStudentBlock(line1, line2, line3, line4, line5, line6);
      if (student) {
        students.push(student);
      }
    } catch (err) {
      console.warn('Failed to parse student block:', err.message);
    }
  }

  return students;
}

/**
 * Parse a single student's 6-line block
 */
function parseStudentBlock(line1, line2, line3, line4, line5, line6) {
  const student = {};

  // LINE 1: Extract PRN, Name, Mother Name
  // Format: "693457112022033700259876BALBUDHE TRUPTI YADAVPUSHPA311 1FE"
  // Structure: Serial + PRN(16 digits starting with 20) + NAME + MOTHERNAME + "311 1"

  // Extract the PRN: 16 digits starting with "20" (year pattern)
  const prnMatch = line1.match(/(20\d{14})/);

  if (prnMatch) {
    student.rollNo = prnMatch[1];

    // Find where PRN ends and extract everything after it
    const prnEndIndex = line1.indexOf(student.rollNo) + student.rollNo.length;
    const afterPRN = line1.substring(prnEndIndex);

    // Extract name section before college code "311 1" or similar
    const beforeCodeMatch = afterPRN.match(/^([A-Z\s]+?)(\d{3}\s+\d)/);

    if (beforeCodeMatch) {
      const nameSection = beforeCodeMatch[1];

      // Split by spaces
      const words = nameSection.trim().split(/\s+/).filter(w => w.length > 0);

      if (words.length >= 2) {
        student.motherName = words[words.length - 1];
        student.name = words.slice(0, -1).join(' ');
      } else if (words.length === 1) {
        student.name = words[0];
        student.motherName = "";
      } else {
        student.name = "";
        student.motherName = "";
      }
    } else {
      student.name = "";
      student.motherName = "";
    }
  } else {
    // Fallback: try to find any 16-digit number
    const fallbackPrn = line1.match(/(\d{16})/);
    student.rollNo = fallbackPrn ? fallbackPrn[1] : "";
    student.name = "";
    student.motherName = "";
  }

  // LINE 6: Extract subject codes
  const subjectCodes = extractSubjectCodes(line6);

  // LINE 3: Extract UA and CA marks
  const scores = extractScores(line3);

  // LINE 4: Extract subject totals + grand total using known subject count
  const { subjectTotals, finalTotal } = extractTotals(line4, subjectCodes.length);

  // Map scores and totals to subject codes
  for (let i = 0; i < subjectCodes.length; i++) {
    const code = subjectCodes[i];
    if (scores[i]) {
      student[`${code}_UA`] = scores[i].ua || "";
      student[`${code}_CA`] = scores[i].ca || "";
    }
    if (subjectTotals[i] !== undefined) {
      student[`${code}_Total`] = subjectTotals[i];
    }
  }

  // Grand total (from position after subject totals)
  student.finalTotal = finalTotal;

  // LINE 4: Extract result (PASS BY GRACE checked before PASS)
  const resultMatch = line4.match(/(PASS BY GRACE|ATKT|ABSENT|FAIL|PASS)/i);
  student.result = resultMatch ? resultMatch[1].toUpperCase() : "";

  // LINE 5: Extract SGPA
  const sgpaMatch = line5.match(/(\d+\.\d{2})\s*\|/);
  student.sgpa = sgpaMatch ? sgpaMatch[1] : "";

  return student;
}

/**
 * Extract subject codes from the subject line (line 6)
 * Example: "| TE201CS| TE202CS| TE203CS|..."
 */
function extractSubjectCodes(line) {
  const codes = [];
  // Match pattern: | CODE where CODE is 2-4 letters + 3 digits + 0-3 letters
  const matches = line.matchAll(/\|\s*([A-Z]{2,4}\d{3}[A-Z]{0,3})(?:-[IVX]+)?/g);

  for (const match of matches) {
    codes.push(match[1]);
  }

  return codes;
}

/**
 * Extract UA and CA scores from line 3
 * Example: "| 066| 014| - | 031| 015| - |..." (with spaces)
 * Pattern: | UA| CA| - | (repeated)
 */
function extractScores(line) {
  const scores = [];

  // Match pattern with spaces: | digits| digits| -
  // Example: "| 066| 014| - " means UA=066, CA=014
  const pattern = /\|\s*(\d{2,3}|0AB|EC|EUC)\s*\|\s*(\d{2,3}|0AB|EC|EUC)\s*\|\s*-/g;
  let match;

  while ((match = pattern.exec(line)) !== null) {
    scores.push({
      ua: match[1].trim(),
      ca: match[2].trim()
    });
  }

  return scores;
}

/**
 * Extract subject totals + grand total from line 4 using known subject count.
 *
 * The line lists N subject totals, then the grand total, then dGPV, then RESULT.
 * FAIL students have grade-code suffixes on totals: "26 EC", "56 EUC".
 * Grace marks appear as "38*2". We keep the numeric (with grace marker) and
 * strip trailing grade-letter codes.
 *
 * PASS example: "| 80 | 46 | 50 | 63 | 44 | 33 | 35 | 43 | 394| 138 | PASS |"
 * FAIL example: "| 26 EC | 2 EC | 7 EC | ... | 15 EC | 87| 8 | FAIL |"
 *
 * @param {string} line - the totals line (line 4)
 * @param {number} numSubjects - number of subjects (from subject-code line)
 * @returns {{subjectTotals: string[], finalTotal: string}}
 */
function extractTotals(line, numSubjects) {
  // Split into pipe-delimited cells, keep only non-empty
  const cells = line.split('|').map(c => c.trim()).filter(c => c.length > 0);

  // Pull the leading number (with optional "*n" grace marker) from a cell,
  // ignoring any trailing grade code like "EC"/"EUC".
  const leadingNumber = (cell) => {
    const m = cell.match(/^(\d+(?:\*\d+)?)/);
    return m ? m[1] : "";
  };

  const subjectTotals = [];
  for (let i = 0; i < numSubjects && i < cells.length; i++) {
    subjectTotals.push(leadingNumber(cells[i]));
  }

  // The grand total is the cell immediately after the subject totals
  let finalTotal = "";
  if (cells.length > numSubjects) {
    finalTotal = leadingNumber(cells[numSubjects]);
  }

  return { subjectTotals, finalTotal };
}

/**
 * Normalize students: merge duplicates by rollNo, fill missing keys
 */
export function normalizeStudents(students) {
  if (students.length === 0) return [];

  // Collect all unique keys
  const allKeys = new Set();
  students.forEach(s => Object.keys(s).forEach(k => allKeys.add(k)));

  // Merge duplicates by rollNo
  const byRoll = new Map();
  for (const student of students) {
    const roll = (student.rollNo || "").toString().trim() || `__no_roll_${Math.random()}`;

    if (!byRoll.has(roll)) {
      byRoll.set(roll, { ...student });
    } else {
      const existing = byRoll.get(roll);
      // Non-empty value wins
      for (const [k, v] of Object.entries(student)) {
        const newVal = (v ?? "").toString().trim();
        const oldVal = (existing[k] ?? "").toString().trim();
        if (newVal !== "" && oldVal === "") {
          existing[k] = v;
        }
      }
    }
  }

  // Fill missing keys with empty strings
  const normalized = [...byRoll.values()].map(s => {
    const filled = {};

    // Fixed fields first
    filled.rollNo = s.rollNo || "";
    filled.name = s.name || "";
    filled.motherName = s.motherName || "";

    // Subject fields (sorted)
    const subjectKeys = [...allKeys]
      .filter(k => /^[A-Z]{2,4}\d{3}[A-Z]{0,3}_(UA|CA|Total)$/.test(k))
      .sort();

    for (const key of subjectKeys) {
      filled[key] = s[key] || "";
    }

    // Summary fields
    filled.finalTotal = s.finalTotal || "";
    filled.sgpa = s.sgpa || "";
    filled.result = s.result || "";

    return filled;
  });

  return normalized;
}

/**
 * Get unique subject codes from normalized students
 */
export function getSubjectCodes(students) {
  const codes = new Set();

  for (const student of students) {
    for (const key of Object.keys(student)) {
      const match = key.match(/^([A-Z]{2,4}\d{3}[A-Z]{0,3})_(UA|CA|Total)$/);
      if (match) {
        codes.add(match[1]);
      }
    }
  }

  return [...codes].sort();
}
