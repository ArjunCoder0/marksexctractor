import { useState, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;

const GROQ_ENDPOINT = "/api/groq/openai/v1/chat/completions";
const GROQ_MODEL    = "meta-llama/llama-4-scout-17b-16e-instruct";
const BATCH_SIZE    = 1; // 1 page per call — prevents multi-page confusion
const MAX_RETRIES   = 4;
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);
const TEXT_SUBJECT_CODES = ["SE201CS", "SE202CS", "SE203CS", "SE204CS", "SE205CS", "SE206CS", "SE207CS", "SE208CS"];

// Derive subject codes dynamically from whatever the AI extracted
function getSubjectCodes(rows) {
  const codes = new Set();
  rows.forEach(row => {
    Object.keys(row).forEach(k => {
      const m = k.match(/^(.+)_(UA|CA|Total)$/);
      if (m) codes.add(m[1]);
    });
  });
  return [...codes].sort();
}

function buildColumns(subjectCodes) {
  return [
    { key: "rollNo",     label: "Roll No" },
    { key: "name",       label: "Name" },
    { key: "motherName", label: "Mother Name" },
    ...subjectCodes.flatMap(c => [
      { key: `${c}_UA`,    label: `${c}_UA`    },
      { key: `${c}_CA`,    label: `${c}_CA`    },
      { key: `${c}_Total`, label: `${c}_Total` },
    ]),
    { key: "finalTotal", label: "Final Total" },
    { key: "sgpa",       label: "SGPA" },
    { key: "result",     label: "Result" },
  ];
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function parseResponseBody(res) {
  const raw = await res.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { error: { message: raw.slice(0, 300) } };
  }
}

function parseTextMarksheet(fullText) {
  const text = fullText.replace(/\s+/g, " ");
  const starts = [...text.matchAll(/\s(69\d{5})\s+\d+\s+(20\d{13,16})\s+/g)];
  const students = [];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const block = text.slice(start, end).replace(/\s+/g, " ");
    const head = block.match(/^\s*(69\d{5})\s+\d+\s+(20\d{13,16})\s+(.+?)\s*311\s+\d+\s+([MF])\s+E/);
    if (!head) continue;

    const nameParts = head[3].trim().split(" ");
    const motherName = nameParts.pop() || "";
    const row = {
      rollNo: head[1],
      name: nameParts.join(" "),
      motherName,
    };

    const scorePairs = [...block.matchAll(/\|\s*([0-9A-Z]+)\|\s*([0-9A-Z]+)\|\s*-/g)]
      .slice(0, TEXT_SUBJECT_CODES.length)
      .map(m => [m[1], m[2]]);

    const totalsMatch = block.match(/\|\s*20\s*\|\s*\|\s*\|([\s\S]+?)\|\s*4\s*\|/);
    const totalFields = totalsMatch
      ? totalsMatch[1].split("|").map(v => v.trim()).filter(Boolean)
      : [];

    TEXT_SUBJECT_CODES.forEach((code, idx) => {
      row[`${code}_UA`] = scorePairs[idx]?.[0] || "";
      row[`${code}_CA`] = scorePairs[idx]?.[1] || "";
      row[`${code}_Total`] = totalFields[idx]?.split(/\s+/)[0] || "";
    });

    row.finalTotal = totalFields[8]?.split(/\s+/)[0] || "";
    row.sgpa = (block.match(/\|\s*([0-9]+\.[0-9]+)\s*\|\s*\|\s*\|\s*SE201CS/) || [])[1] || "";
    row.result = (totalFields[10] || "").trim();

    students.push(row);
  }

  const meta = {
    university: (fullText.match(/GONDWANA UNIVERSITY,\s*GADCHIROLI/i) || [])[0] || "",
    course: (fullText.match(/B\.TECH\.\(with credits\).*?SEM IV/i) || [])[0]?.replace(/\s+/g, " ") || "",
    semester: "SEM IV",
    examDate: (fullText.match(/RESULT DATE:([0-9-]+)/i) || [])[1] || "",
    college: (fullText.match(/COLLEGE CODE & NAME\s*:\s*(.+?)\s*-{5,}/i) || [])[1]?.replace(/\s+/g, " ").trim() || "",
  };

  return { meta, students };
}

async function extractTextMarksheet(buffer) {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  let text = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += ` ${content.items.map(item => item.str).join(" ")} `;
  }

  return parseTextMarksheet(text);
}

function stripJsonComments(input) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
      continue;
    }

    out += ch;
  }

  return out;
}

function extractJsonCandidate(raw) {
  const fencedJson = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson) return fencedJson[1];

  const first = raw.indexOf("{");
  if (first === -1) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = first; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(first, i + 1);
    }
  }

  return raw.slice(first);
}

const PROMPT = `Extract data from the attached marksheet image. The image is attached in this same message.

You are a precise data extractor for Gondwana University tabulation register marksheets.

This PDF uses a SPECIFIC MULTI-LINE FORMAT per student. Each student block has EXACTLY these lines:
LINE 1 (MAX MARKS HEADER): Shows maximum marks like "|80/20/40|" or "|80/20/40|" — DO NOT USE THESE, they are NOT student scores.
LINE 2 (STUDENT RAW SCORES): Shows the student's actual raw scores like "|066| 014|  -|" separated by | pipes. These are the REAL UA and CA values.
LINE 3 (GRADE/CREDIT LINE): Shows letter grades and credits like "4(A+)|10|40" — ignore this line for marks.
LINE 4 (SUBJECT CODE LINE): Shows the subject codes like "SE201CS SE202CS SE203CS..." — use these as column headers.
LINE 5 (TOTALS/FINAL): Shows computed subject totals separated by | like "80|46|50|63|44|33| |43" — use these as Total per subject.

CRITICAL RULES:
1. NEVER use values from LINE 1 (the max marks like 80, 20/40, etc.) as student scores.
2. LINE 2 contains the actual UA and CA raw scores — these are what you MUST extract.
3. If a subject shows "EC", "EUC", "EU" or "-" it means Exempted — record "EC" as the value.
4. The TOTAL for each subject = UA + CA (from line 2). The last row of the student block shows the computed totals.
5. Each student has a 4-digit or 7-digit roll number (PRN) and a serial number (1,2,3...). Use the serial number as rollNo unless a full PRN like 6922071 is available — then use that.
6. Extract EVERY student on the page — do not skip any.
7. The subject layout per student (reading the | separated columns left to right) maps to: Subject 1 (UA|CA|TOT), Subject 2 (UA|CA|TOT), ..., Subject N (UA|CA|TOT).
8. finalTotal is the sum printed at the end of the student row (e.g., 394, 87, 452, 441, etc.) — NOT 800 or any maximum.
9. result is exactly as printed: "PASS", "FAIL", "PASS BY GRACE", "ATKT", etc.

For the subject codes: look at the bottom row of the table header area. They appear as codes like SE201CS, SE202CS, SE203CS, SE204CS, SE205CS, SE206CS, SE207CS, SE208CS or similar. Use the EXACT codes printed.

Return ONLY valid JSON. Do not write markdown, explanations, assumptions, code snippets, or comments. JSON does not allow // comments.
If a field is unreadable, use an empty string. If no student records are readable from the attached image, return {"meta":{},"students":[]} and nothing else.

Required JSON shape:
{
  "meta": {"university":"...","course":"...","semester":"...","examDate":"...","college":"..."},
  "students": [
    {
      "rollNo":"6922071",
      "name":"AKASH GAJANAN SAHU",
      "motherName":"SANGITA",
      "SE201CS_UA":"66", "SE201CS_CA":"14", "SE201CS_Total":"80",
      "SE202CS_UA":"31", "SE202CS_CA":"15", "SE202CS_Total":"46",
      "SE203CS_UA":"40", "SE203CS_CA":"10", "SE203CS_Total":"50",
      "SE204CS_UA":"49", "SE204CS_CA":"14", "SE204CS_Total":"63",
      "SE205CS_UA":"31", "SE205CS_CA":"13", "SE205CS_Total":"44",
      "SE206CS_UA":"17", "SE206CS_CA":"16", "SE206CS_Total":"33",
      "SE207CS_UA":"EC", "SE207CS_CA":"EC", "SE207CS_Total":"EC",
      "SE208CS_UA":"21", "SE208CS_CA":"22", "SE208CS_Total":"43",
      "finalTotal":"394", "sgpa":"6.90", "result":"PASS"
    }
  ]
}`;

async function pdfToImages(buffer) {
  const pdf  = await pdfjsLib.getDocument({ data: buffer }).promise;
  const imgs = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);

    // Try scale 2.0 first; fall back to 1.5 if the base64 is too large for Groq (~4 MB limit)
    const renderAt = async (scale, quality) => {
      const vp     = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width  = vp.width;
      canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      return canvas.toDataURL("image/jpeg", quality).split(",")[1];
    };

    let b64 = await renderAt(2.0, 0.80);
    // base64 length * 0.75 ≈ bytes; Groq rejects images > ~4 MB
    if (b64.length * 0.75 > 4 * 1024 * 1024) {
      b64 = await renderAt(1.5, 0.75); // fallback: smaller + more compressed
    }
    imgs.push(b64);
  }
  return imgs;
}


function downloadCSV(rows, columns) {
  const lines = [columns.map(c => c.label).join(",")];
  rows.forEach(row =>
    lines.push(columns.map(c => `"${(row[c.key] ?? "").toString().replace(/"/g, '""')}"`).join(","))
  );
  const a  = document.createElement("a");
  a.href   = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = "marksheet_results.csv";
  a.click();
}

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

function Header({ status, rateLimit, onClearKey }) {
  const used = rateLimit.limit > 0 ? rateLimit.limit - rateLimit.remaining : 0;
  const pct  = rateLimit.limit > 0 ? Math.min(100, Math.round((used / rateLimit.limit) * 100)) : 0;
  const barC = pct > 90 ? "#f87171" : pct > 70 ? "#fbbf24" : "#34d399";
  return (
    <div style={{ background:"linear-gradient(90deg,#0f172a,#1a1f3a)", borderBottom:"1px solid #1e293b", padding:"14px 32px" }}>
      <div style={{ display:"flex", alignItems:"center", gap:16 }}>
        <div style={{ width:40, height:40, background:"linear-gradient(135deg,#6366f1,#8b5cf6)",
          borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>📋</div>
        <div>
          <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:700, fontSize:20, color:"#f1f5f9" }}>Marksheet Extractor</div>
          <div style={{ fontSize:11, color:"#64748b", letterSpacing:".05em" }}>PDF → AI VISION → STRUCTURED DATA → CSV</div>
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
              🔑 Change Key
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
        <div style={{ fontSize:40, marginBottom:16 }}>🔑</div>
        <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:700, fontSize:20, color:"#f1f5f9", marginBottom:8 }}>Groq API Key Required</div>
        <div style={{ fontSize:13, color:"#64748b", marginBottom:6, lineHeight:1.7 }}>
          Groq is <strong style={{ color:"#34d399" }}>100% free</strong> — no credit card, no region restrictions.
        </div>
        <div style={{ fontSize:13, color:"#64748b", marginBottom:24, lineHeight:1.7 }}>
          Get your key at <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer"
            style={{ color:"#818cf8", textDecoration:"none" }}>console.groq.com/keys</a> → Sign up → Create API Key
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
            Save & Continue
          </button>
        </div>
        <div style={{ fontSize:11, color:"#334155", marginTop:12 }}>Key saved in browser only (localStorage).</div>
      </div>
    </div>
  );
}

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

      setProgress("Reading embedded PDF text...");
      const textExtraction = await extractTextMarksheet(buf.slice(0));
      if (textExtraction.students.length > 0) {
        setMeta(textExtraction.meta);
        setRows(textExtraction.students);
        setStatus("success");
        setProgress("");
        setBatch({ cur:0, tot:0 });
        return;
      }

      setProgress("Rendering pages...");
      const imgs = await pdfToImages(buf);

      const batches = [];
      for (let i = 0; i < imgs.length; i += BATCH_SIZE) batches.push(imgs.slice(i, i + BATCH_SIZE));
      setBatch({ cur:0, tot:batches.length });

      for (let b = 0; b < batches.length; b++) {
        setBatch({ cur: b + 1, tot: batches.length });
        setProgress(`Pages ${b * BATCH_SIZE + 1}–${Math.min((b + 1) * BATCH_SIZE, imgs.length)} of ${imgs.length}`);

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
              max_tokens: 4096,
              temperature: 0,
              messages: [
                { role:"system", content:"You extract marksheet data from attached images and return only strict JSON." },
                { role:"user", content },
              ],
            }),
          });
          const data = await parseResponseBody(res);

          const lim = parseInt(res.headers.get("x-ratelimit-limit-tokens")     || "0");
          const rem = parseInt(res.headers.get("x-ratelimit-remaining-tokens") || "0");
          if (lim > 0) setRl({ limit: lim, remaining: rem });

          if (res.status === 429) {
            const errMsg    = data?.error?.message || "";
            const limMatch  = errMsg.match(/Limit\s+([\d]+)/i);
            const usedMatch = errMsg.match(/Used\s+([\d]+)/i);
            if (limMatch && usedMatch) {
              const parsedLim  = parseInt(limMatch[1]);
              const parsedUsed = parseInt(usedMatch[1]);
              setRl({ limit: parsedLim, remaining: parsedLim - parsedUsed });
            }
            const m = errMsg.match(/try again in ([\d.]+)s/i);
            const waitSeconds = m ? Math.ceil(parseFloat(m[1])) + 2 : 15;
            for (let s = waitSeconds; s > 0; s--) {
              setProgress(`Rate limited — retrying in ${s}s...`);
              await wait(1000);
            }
            setProgress(`Pages ${b * BATCH_SIZE + 1}–${Math.min((b + 1) * BATCH_SIZE, imgs.length)} of ${imgs.length}`);
            continue;
          }

          if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
            attempt += 1;
            const retryAfter = parseInt(res.headers.get("retry-after") || "0");
            const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 2500 * attempt * attempt);
            const seconds = Math.ceil(delay / 1000);
            for (let s = seconds; s > 0; s--) {
              setProgress(`Batch ${b + 1} hit HTTP ${res.status} — retry ${attempt}/${MAX_RETRIES} in ${s}s...`);
              await wait(1000);
            }
            setProgress(`Pages ${b * BATCH_SIZE + 1}–${Math.min((b + 1) * BATCH_SIZE, imgs.length)} of ${imgs.length}`);
            continue;
          }

          if (!res.ok) {
            if (res.status === 401) { localStorage.removeItem("groq_api_key"); setApiKey(""); }
            throw new Error(`Batch ${b + 1} failed: ${data?.error?.message || `HTTP ${res.status}`}`);
          }

          const text = data?.choices?.[0]?.message?.content || "";
          if (!text) throw new Error(`Empty response for batch ${b + 1}.`);

          // Robust JSON extraction — handles markdown, comments, unquoted keys, single-quoted keys, trailing commas
          const cleanJSON = (raw) => stripJsonComments(extractJsonCandidate(raw))
            .replace(/```json\s*/gi, "").replace(/```\s*/g, "")   // strip markdown fences
            .replace(/[\u2018\u2019]/g, "'")                       // smart single quotes → straight
            .replace(/[\u201C\u201D]/g, '"')                       // smart double quotes → straight
            .replace(/,\s*([}\]])/g, "$1")                        // trailing commas before } or ]
            .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')        // 'key': → "key":
            .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":') // unquoted key: → "key":
            // eslint-disable-next-line no-control-regex
            .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, " ")  // strip control chars (keep \n \r)
            .trim();

          const cleaned = cleanJSON(text);
          const jMatch  = cleaned.match(/\{[\s\S]*\}/);
          if (!jMatch) throw new Error(`No JSON found in batch ${b + 1} response.`);

          let parsed;
          try {
            parsed = JSON.parse(jMatch[0]);
          } catch (e1) {
            // Last resort: aggressive comma fix + log snippet for debugging
            const snippet = jMatch[0].slice(Math.max(0, (e1.message.match(/position (\d+)/)?.[1] ?? 50) - 30), (parseInt(e1.message.match(/position (\d+)/)?.[1] ?? 50) + 30));
            console.error(`[Batch ${b + 1}] JSON error near: ...${snippet}...`);
            console.error(`[Batch ${b + 1}] Full raw response:\n`, text);
            const sanitised = jMatch[0].replace(/,\s*([}\]])/g, "$1");
            try { parsed = JSON.parse(sanitised); }
            catch (e2) { throw new Error(`JSON parse failed (batch ${b + 1}): ${e2.message} — see console for raw response`); }
          }

          if (b === 0 && parsed.meta) {
            extractedMeta = parsed.meta;
            setMeta(extractedMeta);
          }
          if (Array.isArray(parsed.students)) {
            allStudents = [...allStudents, ...parsed.students];
            setRows(allStudents);
          }
          done = true;

        }

        if (b < batches.length - 1) await wait(1000);
      }

      setMeta(extractedMeta); setRows(allStudents); setStatus("success");
      setProgress(""); setBatch({ cur:0, tot:0 });
    } catch (err) {
      if (allStudents.length > 0) setRows(allStudents);
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
      <Header status="idle" rateLimit={{ limit:0, remaining:0 }} onClearKey={null}/>
      <ApiKeySetup onSave={setApiKey}/>
    </div>
  );

  const batchPct = batch.tot > 0 ? Math.round((batch.cur / batch.tot) * 100) : 0;

  // Derive columns from actual extracted data
  const subjectCodes = getSubjectCodes(rows);
  const columns      = buildColumns(subjectCodes);

  return (
    <div style={{ fontFamily:"'DM Mono',monospace", minHeight:"100vh", background:"#0b0f1a", color:"#e2e8f0" }}>
      <style>{CSS}</style>
      <Header status={status} rateLimit={rl} onClearKey={() => { localStorage.removeItem("groq_api_key"); setApiKey(""); }}/>

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
              {fileName && <div style={{ color:"#334155", fontSize:11 }}>📎 {fileName}</div>}
            </div>
          ) : (
            <>
              <div style={{ fontSize:36, marginBottom:12 }}>📄</div>
              <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:600, fontSize:16, color:"#cbd5e1", marginBottom:6 }}>
                {fileName && status === "success" ? `📎 ${fileName}` : "Drop your Marksheet PDF here"}
              </div>
              <div style={{ fontSize:12, color:"#475569" }}>or click to browse · Gondwana University tabulation register supported</div>
              <div style={{ marginTop:10, display:"inline-block", background:"rgba(52,211,153,.08)",
                border:"1px solid rgba(52,211,153,.2)", borderRadius:6, padding:"3px 10px", fontSize:11, color:"#34d399" }}>
                Powered by Groq · Llama 4 Scout Vision ⚡
              </div>
            </>
          )}
        </div>

        {/* Error */}
        {error && (
          <div style={{ background:"rgba(239,68,68,.08)", border:"1px solid rgba(239,68,68,.25)",
            borderRadius:10, padding:"12px 16px", marginBottom:20, color:"#fca5a5", fontSize:13 }}>
            ⚠️ {error}
          </div>
        )}

        {/* Meta */}
        {meta && (
          <div className="fi glow" style={{ background:"#111827", border:"1px solid #1e293b", borderRadius:12,
            padding:"16px 20px", marginBottom:24, display:"flex", gap:32, flexWrap:"wrap" }}>
            {Object.entries(meta).map(([k, v]) => v && (
              <div key={k}>
                <div style={{ fontSize:10, color:"#475569", textTransform:"uppercase", letterSpacing:".08em", marginBottom:3 }}>{k}</div>
                <div style={{ fontSize:13, color:"#cbd5e1", fontFamily:"'Space Grotesk',sans-serif", fontWeight:500 }}>{v}</div>
              </div>
            ))}
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
                ⬇️ Download CSV
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
                          <td key={`${code}_UA`} style={{ padding:"8px 8px", color:"#94a3b8", textAlign:"center" }}>{row[`${code}_UA`] ?? "—"}</td>,
                          <td key={`${code}_CA`} style={{ padding:"8px 8px", color:"#94a3b8", textAlign:"center" }}>{row[`${code}_CA`] ?? "—"}</td>,
                          <td key={`${code}_Total`} style={{ padding:"8px 8px", color:"#c7d2fe", textAlign:"center",
                            fontWeight:500, borderRight:"1px solid #1e293b" }}>{row[`${code}_Total`] ?? "—"}</td>,
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
              EC = Exempted/Carry-over · *1/*2 = Grace marks applied
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
