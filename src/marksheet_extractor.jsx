import { useState, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;

// â”€â”€â”€ API CONFIG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const GROQ_ENDPOINT     = "/api/groq/openai/v1/chat/completions";
const GROQ_MODEL        = "meta-llama/llama-4-scout-17b-16e-instruct";
const BATCH_SIZE        = 1;   // 1 page per API call â€” avoids multi-page confusion
const MAX_RETRIES       = 4;
const RETRYABLE_STATUS  = new Set([408, 500, 502, 503, 504]);

// â”€â”€â”€ UTILITY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function parseResponseBody(res) {
  const raw = await res.text();
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { return { error: { message: raw.slice(0, 300) } }; }
}

// â”€â”€â”€ UNIVERSAL AI PROMPT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Completely generic â€” no mention of any specific semester, branch, subject codes,
// or subject count. The AI discovers everything from the image.

const PROMPT = `You are a precise data extractor for Gondwana University tabulation register marksheets.
The image is ONE PAGE of a printed result register. Extract ALL student records visible on this page.

--- PAGE STRUCTURE ---

The top of the page shows university name, college, course, semester, result date.
A column-header row lists subject numbers: 1(Th), 2(Th), 3(Pr), etc.
A sub-header row shows: UA/CA/UA:TOT and CR|GI|GI|GPV for each subject.

Each student occupies EXACTLY 5 lines:

  LINE 1 (IDENTITY):
    SerialNo  PRN  NAME-OF-CANDIDATE  MOTHERS_NAME  CEN CAT GENDER ...
    PRN is 7 to 17 digits. Use the FULL number as rollNo.

  LINE 2 (MAX MARKS -- ALWAYS IGNORE):
    | 80:20/40 | 80:20/40 | :25/25 | :50/50 |
    KEY: contains colon ':' inside pipe cells.
    These are maximum marks, NOT student scores. NEVER extract from this line.

  LINE 3 (RAW SCORES -- EXTRACT UA AND CA FROM HERE):
    | 066| 019|  -|  | 041| 045|  -|  | 023| 024|  -|
    KEY: NO colon ':' inside the pipes. Only digits, 0AB, EC, or dash.
    For each subject group  | UA | CA | - | :
      - First number  = UA mark (university assessment)  --> use as <CODE>_UA
      - Second number = CA mark (continuous assessment)  --> use as <CODE>_CA
      - The dash -    = placeholder only, NOT absent -- ignore it
    Special values: '0AB' = absent. 'EC'/'EUC' = exempted. Use them as strings.

  LINE 4 (GRADE/CREDIT -- IGNORE FOR MARKS):
    | 4 |A+|10|40|  | 4 |B+|18|32| ...
    Credits and grade points, NOT raw marks.

  LINE 5 (TOTALS + RESULT):
    | 85 | 86 | 82 | 91 | 47 | 49 | 87 | 48 |   635 | 232 | PASS
    - Numbers before grand total = subject total per subject (UA+CA sum).
    - Large number near end = finalTotal (grand sum).
    - Decimal like 9.67 = SGPA.
    - Last word = result (PASS / FAIL / ATKT / PASS BY GRACE / ABSENT).

Subject codes appear below each column at the bottom of the block:
  TE201CS  TE202CS  TE203CS  ...
  Use these EXACT codes as JSON key prefixes.

--- HOW TO TELL LINE 2 FROM LINE 3 ---

  MAX MARKS (LINE 2) -- has colon ':' in pipes --> IGNORE
    Example: | 80:20/40 |  or  | :25/25 |

  RAW SCORES (LINE 3) -- no colon in pipes --> EXTRACT
    Example: | 066| 019|  -|   --> UA=066, CA=019, dash ignored

Concrete example for theory subject TE201CS:
  LINE 2 (ignore):  | 80:20/40 |      <- colon = max marks
  LINE 3 (extract): | 066| 019|  -|   <- no colon, UA=066, CA=019
  LINE 5 (extract): | 85 |            <- total = 85

Concrete example for practical subject TE206CS:
  LINE 2 (ignore):  | :25/25 |        <- colon = max marks
  LINE 3 (extract): | 023| 024|  -|   <- no colon, UA=023, CA=024
  LINE 5 (extract): | 47 |            <- total = 47

--- SUBJECT CODE RULES ---

  - Read EXACT codes from bottom of each column (e.g. TE201CS, SE401CS).
  - Any number of subjects is possible (4 to 12).
  - Use ONLY the alphanumeric code: no hyphens, no leading digits, no spaces.
    CORRECT: "TE201CS_UA"
    WRONG:   "TE201CS-I_UA", "1.TE201CS_UA", "TE201CS_I_UA"
  - If the PDF shows "TE203CS-I", strip the "-I" and use "TE203CS".

--- STUDENT FIELD RULES ---

  rollNo      : full PRN number from LINE 1 (7-17 digits)
  name        : all name words except the last (mother's name)
  motherName  : last word of the name cluster on LINE 1
  <CODE>_UA   : UA mark (string) from LINE 3
  <CODE>_CA   : CA mark (string) from LINE 3
  <CODE>_Total: subject total (string) from LINE 5
  finalTotal  : grand total from LINE 5 (NOT max marks)
  sgpa        : decimal string like "9.67"
  result      : "PASS", "FAIL", "ATKT", "PASS BY GRACE", or "ABSENT"

--- RULES ---

  1. Extract EVERY student on the page -- skip none.
  2. Subject codes come ONLY from the printed column footers -- never invent.
  3. finalTotal is the student grand total -- NOT the max marks total.
  4. SGPA appears once per student.
  5. Do NOT put grade letters (A+, B, C+), credits, or exemption notes into marks fields.
  6. Return {"meta":{},"students":[]} if this page has no student records.
  7. Return ONLY valid JSON -- no markdown, no comments, no explanations.

--- REQUIRED JSON OUTPUT ---

Return ONLY valid JSON in this exact shape:

{
  "meta": {
    "university": "...",
    "course": "...",
    "semester": "...",
    "examDate": "...",
    "college": "...",
    "branch": "..."
  },
  "students": [
    {
      "rollNo": "2022033700259876",
      "name": "BALBUDDHE TRUPTI YADAV",
      "motherName": "PUSHPHA",
      "TE201CS_UA": "066",
      "TE201CS_CA": "019",
      "TE201CS_Total": "85",
      "TE202CS_UA": "041",
      "TE202CS_CA": "045",
      "TE202CS_Total": "86",
      "TE206CS_UA": "023",
      "TE206CS_CA": "024",
      "TE206CS_Total": "47",
      "finalTotal": "635",
      "sgpa": "9.67",
      "result": "PASS"
    }
  ]
}`;
// â”€â”€â”€ JSON CLEANING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function stripJsonComments(input) {
  let out = "", inString = false, escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i], next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "/" && next === "/") { while (i < input.length && input[i] !== "\n") i++; out += "\n"; continue; }
    if (ch === "/" && next === "*") { i += 2; while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++; i++; continue; }
    out += ch;
  }
  return out;
}

function extractJsonCandidate(raw) {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1];
  const first = raw.indexOf("{");
  if (first === -1) return "";
  let depth = 0, inStr = false, esc = false;
  for (let i = first; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return raw.slice(first, i + 1); }
  }
  return raw.slice(first);
}

function cleanJSON(raw) {
  return stripJsonComments(extractJsonCandidate(raw))
    .replace(/```json\s*/gi, "").replace(/```\s*/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .trim();
}

// â”€â”€â”€ SCHEMA NORMALIZER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Normalize ANY subject key the AI might return into a canonical form.
 *
 * The AI sometimes returns inconsistent key names across pages for the same
 * subject. Examples observed:
 *   "BE203CS_UA"       â†’ OK as-is
 *   "BE203CS-I_UA"     â†’ hyphen + letter suffix â†’ strip to "BE203CS_UA"
 *   "BE203CS_I_UA"     â†’ underscore + letter suffix â†’ strip to "BE203CS_UA"
 *   "1.BE203CS_UA"     â†’ leading number prefix â†’ strip to "BE203CS_UA"
 *   "1 BE203CS_Total"  â†’ leading number+space â†’ strip to "BE203CS_Total"
 *
 * Strategy:
 *   1. Find the LAST occurrence of _UA / _CA / _Total (the real suffix).
 *   2. Everything before it is the "raw code" prefix.
 *   3. From the raw code, extract the FIRST token matching university code
 *      pattern: 2â€“4 uppercase letters + 3 digits + 0â€“3 uppercase letters.
 *   4. Combine: normalized_code + _ + suffix â†’ canonical key.
 *
 * Non-subject keys (rollNo, name, etc.) pass through unchanged.
 */
function sanitizeStudentKeys(student) {
  const SUFFIX_RE = /_(UA|CA|Total)$/i;
  const CODE_RE   = /([A-Z]{2,4}\d{3}[A-Z]{0,3})/i;

  const clean = {};
  for (const [k, v] of Object.entries(student)) {
    const suffixMatch = k.match(SUFFIX_RE);
    if (suffixMatch) {
      // Everything before the last _UA/_CA/_Total
      const rawCode = k.slice(0, k.length - suffixMatch[0].length);
      const codeMatch = rawCode.match(CODE_RE);
      if (codeMatch) {
        // Canonical suffix: UA stays UA, CA stays CA, total/Total/TOTAL → Total
        const s = suffixMatch[1].toUpperCase();
        const canonSuffix = s === "TOTAL" ? "Total" : s; // UA | CA | Total
        const normKey = `${codeMatch[1].toUpperCase()}_${canonSuffix}`;
        // Merge: non-empty wins if this key already exists from another variant
        if (!(normKey in clean) || (clean[normKey] ?? "").toString().trim() === "") {
          clean[normKey] = v;
        }
        continue;
      }
    }
    // Not a subject key â€” pass through (rollNo, name, motherName, finalTotal, sgpa, result)
    clean[k] = v;
  }
  return clean;
}

// After all batches merge:
//  1. Sanitize subject-code key names (strip AI noise like leading digits)
//  2. Collect all unique keys across all students
//  3. Merge duplicate rollNo records â€” NON-EMPTY value always wins
//     (prevents a partial page-2 record from wiping a complete page-1 record)
//  4. Fill every missing key with "" so CSV has uniform columns
function normalizeStudents(students) {
  const sanitized = students.map(sanitizeStudentKeys);

  const allKeys = new Set();
  sanitized.forEach(s => Object.keys(s).forEach(k => allKeys.add(k)));

  // Merge-deduplicate: non-empty value always wins over empty
  const byRoll = new Map();
  sanitized.forEach(s => {
    const key = (s.rollNo || "").toString().trim() || `__no_roll_${Math.random()}`;
    if (!byRoll.has(key)) {
      byRoll.set(key, { ...s });
    } else {
      const existing = byRoll.get(key);
      for (const [k, v] of Object.entries(s)) {
        const newVal = (v ?? "").toString().trim();
        const oldVal = (existing[k] ?? "").toString().trim();
        if (newVal !== "" && oldVal === "") existing[k] = v;
      }
    }
  });

  return [...byRoll.values()].map(s => {
    const filled = {};
    ["rollNo", "name", "motherName"].forEach(k => { filled[k] = s[k] ?? ""; });
    [...allKeys]
      .filter(k => /^.+_(UA|CA|Total)$/.test(k))
      .sort()
      .forEach(k => { filled[k] = s[k] ?? ""; });
    ["finalTotal", "sgpa", "result"].forEach(k => { filled[k] = s[k] ?? ""; });
    return filled;
  });
}

// â”€â”€â”€ DYNAMIC COLUMN BUILDER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Derives subject codes from whatever keys actually exist in the data.
// Zero assumptions about count, names, or semester.
function getSubjectCodes(rows) {
  const codes = new Set();
  rows.forEach(row =>
    Object.keys(row).forEach(k => {
      const m = k.match(/^(.+)_(UA|CA|Total)$/);
      if (m) codes.add(m[1]);
    })
  );
  return [...codes].sort();
}

function buildColumns(subjectCodes) {
  return [
    { key: "rollNo",     label: "Roll No"     },
    { key: "name",       label: "Name"         },
    { key: "motherName", label: "Mother Name"  },
    ...subjectCodes.flatMap(c => [
      { key: `${c}_UA`,    label: `${c}_UA`    },
      { key: `${c}_CA`,   label: `${c}_CA`    },
      { key: `${c}_Total`, label: `${c}_Total` },
    ]),
    { key: "finalTotal", label: "Final Total" },
    { key: "sgpa",       label: "SGPA"        },
    { key: "result",     label: "Result"      },
  ];
}

// â”€â”€â”€ PDF â†’ IMAGES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function pdfToImages(buffer) {
  const pdf  = await pdfjsLib.getDocument({ data: buffer }).promise;
  const imgs = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const renderAt = async (scale, quality) => {
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      return canvas.toDataURL("image/jpeg", quality).split(",")[1];
    };
    let b64 = await renderAt(2.0, 0.80);
    if (b64.length * 0.75 > 4 * 1024 * 1024) b64 = await renderAt(1.5, 0.75);
    imgs.push(b64);
  }
  return imgs;
}

// â”€â”€â”€ CSV DOWNLOAD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function downloadCSV(rows, columns) {
  const lines = [columns.map(c => `"${c.label}"`).join(",")];
  rows.forEach(row =>
    lines.push(columns.map(c => `"${(row[c.key] ?? "").toString().replace(/"/g, '""')}"` ).join(","))
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = "marksheet_results.csv";
  a.click();
}

// â”€â”€â”€ STYLES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Space+Grotesk:wght@400;600;700&display=swap');
  *{box-sizing:border-box;} body{margin:0;background:#0b0f1a;}
  #root{width:100%!important;max-width:100%!important;border:none!important;text-align:left!important;min-height:100vh;}
  ::-webkit-scrollbar{height:6px;width:6px;} ::-webkit-scrollbar-track{background:#0b0f1a;} ::-webkit-scrollbar-thumb{background:#334155;border-radius:3px;}
  .dz{border:2px dashed #334155;transition:all .25s;} .dz:hover,.dz.over{border-color:#6366f1;background:rgba(99,102,241,.05);}
  .glow{box-shadow:0 0 30px rgba(99,102,241,.15);} th{position:sticky;top:0;z-index:10;white-space:nowrap;}
  .spin{animation:spin 1s linear infinite;} @keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
  .fi{animation:fi .4s ease;} @keyframes fi{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
`;

// â”€â”€â”€ UI COMPONENTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Badge({ status }) {
  if (status === "idle") return null;
  const s = {
    loading: { bg:"rgba(251,191,36,.1)",  c:"#fbbf24", bc:"rgba(251,191,36,.3)",  t:"Extracting..." },
    success: { bg:"rgba(52,211,153,.1)",  c:"#34d399", bc:"rgba(52,211,153,.3)",  t:"Extracted!"    },
    error:   { bg:"rgba(248,113,113,.1)", c:"#f87171", bc:"rgba(248,113,113,.3)", t:"Failed"        },
  }[status];
  return (
    <span style={{ padding:"4px 12px", borderRadius:20, fontSize:11, fontFamily:"'DM Mono',monospace",
      border:`1px solid ${s.bc}`, background:s.bg, color:s.c }}>
      {s.t}
    </span>
  );
}

function Header({ status, meta, rateLimit, onClearKey }) {
  const used = rateLimit.limit > 0 ? rateLimit.limit - rateLimit.remaining : 0;
  const pct  = rateLimit.limit > 0 ? Math.min(100, Math.round((used / rateLimit.limit) * 100)) : 0;
  const barC = pct > 90 ? "#f87171" : pct > 70 ? "#fbbf24" : "#34d399";
  return (
    <div style={{ background:"linear-gradient(90deg,#0f172a,#1a1f3a)", borderBottom:"1px solid #1e293b", padding:"14px 32px" }}>
      <div style={{ display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" }}>
        <div style={{ width:40, height:40, background:"linear-gradient(135deg,#6366f1,#8b5cf6)",
          borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>ðŸ“‹</div>
        <div>
          <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:700, fontSize:20, color:"#f1f5f9" }}>
            Marksheet Extractor
          </div>
          <div style={{ fontSize:11, color:"#64748b", letterSpacing:".05em" }}>
            {meta?.semester
              ? `${meta.semester}${meta.branch ? " Â· " + meta.branch : ""}${meta.college ? " Â· " + meta.college : ""}`
              : "PDF â†’ AI VISION â†’ STRUCTURED DATA â†’ CSV Â· Any Semester Â· Any Branch"}
          </div>
        </div>
        {rateLimit.limit > 0 && (
          <div style={{ flex:1, maxWidth:260, marginLeft:20 }}>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#475569", marginBottom:4, fontFamily:"'DM Mono',monospace" }}>
              <span>Tokens / min</span>
              <span style={{ color:barC }}>{used.toLocaleString()} / {rateLimit.limit.toLocaleString()}</span>
            </div>
            <div style={{ height:4, background:"#1e293b", borderRadius:2, overflow:"hidden" }}>
              <div style={{ height:"100%", width:`${pct}%`, background:barC, borderRadius:2, transition:"width .5s ease,background .3s" }}/>
            </div>
          </div>
        )}
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:12 }}>
          <Badge status={status}/>
          {onClearKey && (
            <button id="change-api-key-btn" onClick={onClearKey}
              style={{ background:"transparent", border:"1px solid #334155", borderRadius:6, padding:"5px 10px",
                color:"#64748b", fontSize:11, cursor:"pointer", fontFamily:"'DM Mono',monospace" }}>
              ðŸ”‘ Change Key
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ApiKeySetup({ onSave }) {
  const [key, setKey] = useState("");
  const save = () => { const k = key.trim(); if (!k) return; localStorage.setItem("groq_api_key", k); onSave(k); };
  return (
    <div style={{ maxWidth:560, margin:"60px auto", padding:"0 24px" }}>
      <div style={{ background:"#111827", border:"1px solid #1e293b", borderRadius:16, padding:32, textAlign:"center" }}>
        <div style={{ fontSize:40, marginBottom:16 }}>ðŸ”‘</div>
        <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:700, fontSize:20, color:"#f1f5f9", marginBottom:8 }}>Groq API Key Required</div>
        <div style={{ fontSize:13, color:"#64748b", marginBottom:6, lineHeight:1.7 }}>
          Groq is <strong style={{ color:"#34d399" }}>100% free</strong> â€” no credit card, no region restrictions.
        </div>
        <div style={{ fontSize:13, color:"#64748b", marginBottom:24, lineHeight:1.7 }}>
          Get your key at <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer"
            style={{ color:"#818cf8", textDecoration:"none" }}>console.groq.com/keys</a> â†’ Sign up â†’ Create API Key
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <input id="groq-api-key-input" type="password" value={key}
            onChange={e => setKey(e.target.value)} onKeyDown={e => e.key === "Enter" && save()}
            placeholder="gsk_..."
            style={{ flex:1, background:"#0b0f1a", border:"1px solid #334155", borderRadius:8, padding:"10px 14px",
              color:"#e2e8f0", fontSize:13, fontFamily:"'DM Mono',monospace", outline:"none" }}/>
          <button id="save-api-key-btn" onClick={save}
            style={{ background:"linear-gradient(135deg,#6366f1,#8b5cf6)", color:"#fff", border:"none",
              borderRadius:8, padding:"10px 20px", fontSize:13, fontFamily:"'Space Grotesk',sans-serif",
              fontWeight:600, cursor:"pointer", whiteSpace:"nowrap" }}>
            Save &amp; Continue
          </button>
        </div>
        <div style={{ fontSize:11, color:"#334155", marginTop:12 }}>Key saved in browser only (localStorage).</div>
      </div>
    </div>
  );
}

// â”€â”€â”€ MAIN COMPONENT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function MarksheetExtractor() {
  const [apiKey,   setApiKey]   = useState(() => localStorage.getItem("groq_api_key") || "");
  const [status,   setStatus]   = useState("idle");
  const [rows,     setRows]     = useState([]);
  const [error,    setError]    = useState("");
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [meta,     setMeta]     = useState(null);
  const [progress, setProgress] = useState("");
  const [batch,    setBatch]    = useState({ cur: 0, tot: 0 });
  const [rl,       setRl]       = useState({ limit: 0, remaining: 0 });

  const processFile = useCallback(async (file) => {
    if (!file || file.type !== "application/pdf") { setError("Please upload a valid PDF file."); return; }
    setFileName(file.name); setStatus("loading"); setError(""); setRows([]); setMeta(null);
    setBatch({ cur:0, tot:0 }); setProgress("Reading PDF...");

    let allStudents = [], extractedMeta = null;

    try {
      const buf = await file.arrayBuffer();

      // â”€â”€ AI vision path â€” always used (reliable for any semester/branch) â”€â”€
      setProgress("Rendering pages for AI...");
      const imgs = await pdfToImages(buf);
      const batches = [];
      for (let i = 0; i < imgs.length; i += BATCH_SIZE) batches.push(imgs.slice(i, i + BATCH_SIZE));
      setBatch({ cur:0, tot:batches.length });

      for (let b = 0; b < batches.length; b++) {
        setBatch({ cur: b + 1, tot: batches.length });
        setProgress(`Pages ${b * BATCH_SIZE + 1}â€“${Math.min((b + 1) * BATCH_SIZE, imgs.length)} of ${imgs.length}`);

        const content = [
          { type:"text", text:PROMPT },
          ...batches[b].map(d => ({ type:"image_url", image_url:{ url:`data:image/jpeg;base64,${d}` } })),
        ];

        let done = false, attempt = 0;
        while (!done) {
          const res  = await fetch(GROQ_ENDPOINT, {
            method:  "POST",
            headers: { "Content-Type":"application/json", "Authorization":`Bearer ${apiKey}` },
            body:    JSON.stringify({
              model: GROQ_MODEL,
              max_tokens: 8192,
              temperature: 0,
              messages: [
                { role:"system", content:"You extract marksheet data from university result images and return only strict JSON. You adapt to any semester, branch, or subject count automatically." },
                { role:"user", content },
              ],
            }),
          });
          const data = await parseResponseBody(res);

          const lim = parseInt(res.headers.get("x-ratelimit-limit-tokens")     || "0");
          const rem = parseInt(res.headers.get("x-ratelimit-remaining-tokens") || "0");
          if (lim > 0) setRl({ limit: lim, remaining: rem });

          // Rate limit handling
          if (res.status === 429) {
            const errMsg   = data?.error?.message || "";
            const limMatch = errMsg.match(/Limit\s+([\d]+)/i);
            const useMatch = errMsg.match(/Used\s+([\d]+)/i);
            if (limMatch && useMatch) setRl({ limit:parseInt(limMatch[1]), remaining:parseInt(limMatch[1])-parseInt(useMatch[1]) });
            const m = errMsg.match(/try again in ([\d.]+)s/i);
            const ws = m ? Math.ceil(parseFloat(m[1])) + 2 : 15;
            for (let s = ws; s > 0; s--) { setProgress(`Rate limited â€” retrying in ${s}s...`); await wait(1000); }
            setProgress(`Pages ${b * BATCH_SIZE + 1}â€“${Math.min((b + 1) * BATCH_SIZE, imgs.length)} of ${imgs.length}`);
            continue;
          }

          // Transient error retry
          if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
            attempt++;
            const retryAfter = parseInt(res.headers.get("retry-after") || "0");
            const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 2500 * attempt * attempt);
            const secs = Math.ceil(delay / 1000);
            for (let s = secs; s > 0; s--) { setProgress(`HTTP ${res.status} â€” retry ${attempt}/${MAX_RETRIES} in ${s}s...`); await wait(1000); }
            continue;
          }

          if (!res.ok) {
            if (res.status === 401) { localStorage.removeItem("groq_api_key"); setApiKey(""); }
            throw new Error(`Batch ${b + 1} failed: ${data?.error?.message || `HTTP ${res.status}`}`);
          }

          const text = data?.choices?.[0]?.message?.content || "";
          if (!text) throw new Error(`Empty response for batch ${b + 1}.`);

          const cleaned = cleanJSON(text);
          const jMatch  = cleaned.match(/\{[\s\S]*\}/);
          if (!jMatch) throw new Error(`No JSON found in batch ${b + 1} response.`);

          let parsed;
          try {
            parsed = JSON.parse(jMatch[0]);
          } catch (e1) {
            console.error(`[Batch ${b + 1}] Raw response:\n`, text);
            const sanitised = jMatch[0].replace(/,\s*([}\]])/g, "$1");
            try { parsed = JSON.parse(sanitised); }
            catch (e2) { throw new Error(`JSON parse failed (batch ${b + 1}): ${e2.message}`); }
          }

          if (b === 0 && parsed.meta) { extractedMeta = parsed.meta; setMeta(parsed.meta); }
          if (Array.isArray(parsed.students)) {
            allStudents = [...allStudents, ...parsed.students];
            // Normalize after each batch so the table updates live
            setRows(normalizeStudents(allStudents));
          }
          done = true;
        }

        if (b < batches.length - 1) await wait(1000);
      }

      const finalNorm = normalizeStudents(allStudents);
      setMeta(extractedMeta); setRows(finalNorm); setStatus("success");
      setProgress(""); setBatch({ cur:0, tot:0 });

    } catch (err) {
      if (allStudents.length > 0) setRows(normalizeStudents(allStudents));
      if (extractedMeta) setMeta(extractedMeta);
      setError(err.message || "Extraction failed");
      setStatus("error"); setProgress(""); setBatch({ cur:0, tot:0 });
    }
  }, [apiKey]);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0]; if (f) processFile(f);
  }, [processFile]);
  const onFileChange = (e) => { const f = e.target.files[0]; if (f) processFile(f); };

  if (!apiKey) return (
    <div style={{ fontFamily:"'DM Mono',monospace", minHeight:"100vh", background:"#0b0f1a", color:"#e2e8f0" }}>
      <style>{CSS}</style>
      <Header status="idle" meta={null} rateLimit={{ limit:0, remaining:0 }} onClearKey={null}/>
      <ApiKeySetup onSave={setApiKey}/>
    </div>
  );

  const batchPct    = batch.tot > 0 ? Math.round((batch.cur / batch.tot) * 100) : 0;
  const subjectCodes = getSubjectCodes(rows);
  const columns      = buildColumns(subjectCodes);

  return (
    <div style={{ fontFamily:"'DM Mono',monospace", minHeight:"100vh", background:"#0b0f1a", color:"#e2e8f0" }}>
      <style>{CSS}</style>
      <Header status={status} meta={meta} rateLimit={rl}
        onClearKey={() => { localStorage.removeItem("groq_api_key"); setApiKey(""); }}/>

      <div style={{ padding:"28px 32px" }}>

        {/* Drop Zone */}
        <div id="pdf-drop-zone" className={`dz${dragging ? " over" : ""}`}
          style={{ borderRadius:16, padding:40, textAlign:"center", cursor:"pointer", marginBottom:24 }}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => status !== "loading" && document.getElementById("pdf-input").click()}>
          <input id="pdf-input" type="file" accept="application/pdf" style={{ display:"none" }} onChange={onFileChange}/>
          {status === "loading" ? (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:14, maxWidth:400, margin:"0 auto" }}>
              <div className="spin" style={{ width:36, height:36, border:"3px solid #334155", borderTopColor:"#6366f1", borderRadius:"50%" }}/>
              <div style={{ color:"#94a3b8", fontSize:14, fontFamily:"'Space Grotesk',sans-serif", fontWeight:600 }}>
                {batch.tot > 0 ? `Batch ${batch.cur} / ${batch.tot}` : progress || "Preparing..."}
              </div>
              {batch.tot > 0 && <div style={{ color:"#475569", fontSize:12 }}>{progress}</div>}
              {batch.tot > 0 && (
                <div style={{ width:"100%" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#475569", marginBottom:6 }}>
                    <span>Extracting student data...</span>
                    <span style={{ color:"#6366f1", fontWeight:600 }}>{batchPct}%</span>
                  </div>
                  <div style={{ width:"100%", height:6, background:"#1e293b", borderRadius:4, overflow:"hidden" }}>
                    <div style={{ height:"100%", width:`${batchPct}%`, background:"linear-gradient(90deg,#6366f1,#8b5cf6)", borderRadius:4, transition:"width .4s ease" }}/>
                  </div>
                </div>
              )}
              {fileName && <div style={{ color:"#334155", fontSize:11 }}>ðŸ“Ž {fileName}</div>}
            </div>
          ) : (
            <>
              <div style={{ fontSize:36, marginBottom:12 }}>ðŸ“„</div>
              <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:600, fontSize:16, color:"#cbd5e1", marginBottom:6 }}>
                {fileName && status === "success" ? `ðŸ“Ž ${fileName}` : "Drop your Marksheet PDF here"}
              </div>
              <div style={{ fontSize:12, color:"#475569" }}>
                or click to browse Â· Works for any semester (1â€“8) Â· any branch Â· any subject count
              </div>
              <div style={{ marginTop:10, display:"inline-block", background:"rgba(52,211,153,.08)",
                border:"1px solid rgba(52,211,153,.2)", borderRadius:6, padding:"3px 10px", fontSize:11, color:"#34d399" }}>
                Powered by Groq Â· Llama 4 Scout Vision âš¡
              </div>
            </>
          )}
        </div>

        {/* Error */}
        {error && (
          <div style={{ background:"rgba(239,68,68,.08)", border:"1px solid rgba(239,68,68,.25)",
            borderRadius:10, padding:"12px 16px", marginBottom:20, color:"#fca5a5", fontSize:13 }}>
            âš ï¸ {error}
          </div>
        )}

        {/* Meta */}
        {meta && Object.values(meta).some(Boolean) && (
          <div className="fi glow" style={{ background:"#111827", border:"1px solid #1e293b", borderRadius:12,
            padding:"16px 20px", marginBottom:24, display:"flex", gap:32, flexWrap:"wrap" }}>
            {Object.entries(meta).map(([k, v]) => v && (
              <div key={k}>
                <div style={{ fontSize:10, color:"#475569", textTransform:"uppercase", letterSpacing:".08em", marginBottom:3 }}>{k}</div>
                <div style={{ fontSize:13, color:"#cbd5e1", fontFamily:"'Space Grotesk',sans-serif", fontWeight:500 }}>{v}</div>
              </div>
            ))}
            {subjectCodes.length > 0 && (
              <div>
                <div style={{ fontSize:10, color:"#475569", textTransform:"uppercase", letterSpacing:".08em", marginBottom:3 }}>Subjects Detected</div>
                <div style={{ fontSize:13, color:"#a5b4fc", fontFamily:"'DM Mono',monospace", fontWeight:500 }}>
                  {subjectCodes.length} ({subjectCodes.join(", ")})
                </div>
              </div>
            )}
          </div>
        )}

        {/* Table */}
        {rows.length > 0 && (
          <div className="fi">
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
              <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:600, fontSize:15, color:"#94a3b8" }}>
                {rows.length} student{rows.length !== 1 ? "s" : ""} extracted
              </div>
              <button id="download-csv-btn" onClick={() => downloadCSV(rows, columns)}
                style={{ background:"linear-gradient(135deg,#6366f1,#8b5cf6)", color:"#fff", border:"none",
                  borderRadius:8, padding:"8px 18px", fontSize:13, fontFamily:"'Space Grotesk',sans-serif",
                  fontWeight:600, cursor:"pointer" }}>
                â¬‡ï¸ Download CSV
              </button>
            </div>
            <div style={{ overflowX:"auto", border:"1px solid #1e293b", borderRadius:12 }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead>
                  <tr>
                    {["Roll No","Name","Mother Name"].map(h => (
                      <th key={h} style={{ background:"#0f172a", color:"#6366f1", padding:"10px 12px", textAlign:"left",
                        borderBottom:"1px solid #1e293b", fontFamily:"'Space Grotesk',sans-serif", fontSize:11 }}>{h}</th>
                    ))}
                    {subjectCodes.map(code => [
                      <th key={`${code}_UA`} style={{ background:"#131929", color:"#94a3b8", padding:"10px 8px",
                        borderBottom:"1px solid #1e293b", fontFamily:"'DM Mono',monospace", fontSize:10 }}>{code}<br/>UA</th>,
                      <th key={`${code}_CA`} style={{ background:"#131929", color:"#94a3b8", padding:"10px 8px",
                        borderBottom:"1px solid #1e293b", fontFamily:"'DM Mono',monospace", fontSize:10 }}>CA</th>,
                      <th key={`${code}_Total`} style={{ background:"#0f1725", color:"#7c83fd", padding:"10px 8px",
                        borderBottom:"1px solid #1e293b", fontFamily:"'DM Mono',monospace", fontSize:10,
                        borderRight:"1px solid #1e293b" }}>Total</th>,
                    ])}
                    {["Final Total","SGPA","Result"].map(h => (
                      <th key={h} style={{ background:"#0f172a", color:"#34d399", padding:"10px 12px",
                        borderBottom:"1px solid #1e293b", fontFamily:"'Space Grotesk',sans-serif", fontSize:11 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const res = row.result?.toLowerCase() || "";
                    const rc  = res.includes("pass") ? "#34d399" : res.includes("fail") ? "#f87171" : "#fbbf24";
                    return (
                      <tr key={i} style={{ borderBottom:"1px solid #0f172a", background: i % 2 === 0 ? "#0b0f1a" : "#0d1120" }}>
                        <td style={{ padding:"8px 12px", color:"#a5b4fc", fontWeight:500, whiteSpace:"nowrap" }}>{row.rollNo}</td>
                        <td style={{ padding:"8px 12px", color:"#e2e8f0", whiteSpace:"nowrap", fontFamily:"'Space Grotesk',sans-serif" }}>{row.name}</td>
                        <td style={{ padding:"8px 12px", color:"#94a3b8", whiteSpace:"nowrap" }}>{row.motherName}</td>
                        {subjectCodes.map(code => [
                          <td key={`${code}_UA`}    style={{ padding:"8px 8px", color:"#94a3b8", textAlign:"center" }}>{row[`${code}_UA`]    ?? "â€”"}</td>,
                          <td key={`${code}_CA`}    style={{ padding:"8px 8px", color:"#94a3b8", textAlign:"center" }}>{row[`${code}_CA`]    ?? "â€”"}</td>,
                          <td key={`${code}_Total`} style={{ padding:"8px 8px", color:"#c7d2fe", textAlign:"center",
                            fontWeight:500, borderRight:"1px solid #1e293b" }}>{row[`${code}_Total`] ?? "â€”"}</td>,
                        ])}
                        <td style={{ padding:"8px 12px", color:"#34d399", fontWeight:600, textAlign:"center" }}>{row.finalTotal}</td>
                        <td style={{ padding:"8px 12px", color:"#fbbf24", fontWeight:600, textAlign:"center" }}>{row.sgpa}</td>
                        <td style={{ padding:"8px 12px", fontWeight:600, whiteSpace:"nowrap", color:rc,
                          fontFamily:"'Space Grotesk',sans-serif" }}>{row.result}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop:10, fontSize:11, color:"#334155", textAlign:"right" }}>
              EC = Exempted/Carry-over Â· 0AB = Absent Â· *n = Grace marks Â· Columns auto-detected from PDF
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
