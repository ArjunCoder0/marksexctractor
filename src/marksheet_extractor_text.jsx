import { useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import {
  extractPageLines,
  extractMetadata,
  parseStudents,
  normalizeStudents,
  getSubjectCodes
} from "./text_parser.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).href;

// CSV Download
function downloadCSV(rows, columns) {
  const lines = [columns.map(c => `"${c.label}"`).join(",")];
  rows.forEach(row =>
    lines.push(
      columns
        .map(c => `"${(row[c.key] ?? "").toString().replace(/"/g, '""')}"`)
        .join(",")
    )
  );
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "marksheet_results.csv";
  link.click();
}

function buildColumns(subjectCodes) {
  return [
    { key: "rollNo", label: "Roll No" },
    { key: "name", label: "Name" },
    { key: "motherName", label: "Mother Name" },
    ...subjectCodes.flatMap(c => [
      { key: `${c}_UA`, label: `${c}_UA` },
      { key: `${c}_CA`, label: `${c}_CA` },
      { key: `${c}_Total`, label: `${c}_Total` }
    ]),
    { key: "finalTotal", label: "Final Total" },
    { key: "sgpa", label: "SGPA" },
    { key: "result", label: "Result" }
  ];
}

export default function MarksheetExtractorText() {
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [meta, setMeta] = useState({});
  const [subjectCodes, setSubjectCodes] = useState([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setStatus("Loading PDF...");
    setRows([]);
    setMeta({});
    setSubjectCodes([]);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      setStatus(`Parsing ${pdf.numPages} pages...`);

      let allStudents = [];
      let pageMeta = {};

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        setStatus(`Processing page ${pageNum}/${pdf.numPages}...`);

        const page = await pdf.getPage(pageNum);
        const lines = await extractPageLines(page);

        // Extract metadata from first page
        if (pageNum === 1) {
          pageMeta = extractMetadata(lines);
        }

        // Parse students from this page
        const students = parseStudents(lines);
        allStudents = allStudents.concat(students);
      }

      // Normalize and deduplicate
      const normalized = normalizeStudents(allStudents);
      const codes = getSubjectCodes(normalized);
      const cols = buildColumns(codes);

      setRows(normalized);
      setColumns(cols);
      setMeta(pageMeta);
      setSubjectCodes(codes);
      setStatus(`✅ Extracted ${normalized.length} students from ${pdf.numPages} pages`);
    } catch (err) {
      console.error("Parse error:", err);
      setStatus(`❌ Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#0f172a,#1e1b4b)", padding: "2rem" }}>
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <h1 style={{ fontSize: 42, fontWeight: 800, background: "linear-gradient(135deg,#6366f1,#a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", marginBottom: 8 }}>
            📄 Marksheet Extractor
          </h1>
          <p style={{ fontSize: 15, color: "#94a3b8", fontFamily: "'Space Grotesk',sans-serif" }}>
            Gondwana University Tabulation Register • Text-Based Parser • 100% Accurate • Instant • No API
          </p>
        </div>

        {/* Upload Section */}
        <div style={{ background: "linear-gradient(135deg,#1e293b,#312e81)", borderRadius: 16, padding: "2rem", marginBottom: 32, border: "1px solid #334155" }}>
          <label htmlFor="pdf-upload" style={{ display: "block", cursor: "pointer" }}>
            <div style={{ textAlign: "center", padding: "2rem", border: "2px dashed #475569", borderRadius: 12, transition: "all 0.3s" }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>📤</div>
              <div style={{ fontSize: 16, color: "#cbd5e1", fontWeight: 600, marginBottom: 8 }}>
                Click to upload PDF marksheet
              </div>
              <div style={{ fontSize: 13, color: "#64748b" }}>
                Supports B.Tech / B.E. tabulation registers (all semesters)
              </div>
            </div>
          </label>
          <input
            id="pdf-upload"
            type="file"
            accept=".pdf"
            onChange={handleFile}
            style={{ display: "none" }}
          />
        </div>

        {/* Status */}
        {status && (
          <div style={{ background: loading ? "#1e3a5f" : "#1e293b", padding: "1rem 1.5rem", borderRadius: 10, marginBottom: 24, border: "1px solid #334155", fontSize: 14, color: "#94a3b8" }}>
            {loading && <span style={{ marginRight: 8 }}>⏳</span>}
            {status}
          </div>
        )}

        {/* Metadata */}
        {Object.keys(meta).length > 0 && (
          <div style={{ background: "#0f172a", padding: "1.5rem", borderRadius: 12, marginBottom: 24, border: "1px solid #1e293b", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
            {Object.entries(meta).map(([k, v]) => v && (
              <div key={k}>
                <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 3 }}>
                  {k}
                </div>
                <div style={{ fontSize: 13, color: "#cbd5e1", fontFamily: "'Space Grotesk',sans-serif", fontWeight: 500 }}>
                  {v}
                </div>
              </div>
            ))}
            {subjectCodes.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 3 }}>
                  Subjects Detected
                </div>
                <div style={{ fontSize: 13, color: "#a5b4fc", fontFamily: "'DM Mono',monospace", fontWeight: 500 }}>
                  {subjectCodes.length} ({subjectCodes.join(", ")})
                </div>
              </div>
            )}
          </div>
        )}

        {/* Table */}
        {rows.length > 0 && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 600, fontSize: 15, color: "#94a3b8" }}>
                {rows.length} student{rows.length !== 1 ? "s" : ""} extracted
              </div>
              <button
                onClick={() => downloadCSV(rows, columns)}
                style={{ background: "linear-gradient(135deg,#6366f1,#8b5cf6)", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontSize: 13, fontFamily: "'Space Grotesk',sans-serif", fontWeight: 600, cursor: "pointer" }}
              >
                ⬇️ Download CSV
              </button>
            </div>

            <div style={{ overflowX: "auto", border: "1px solid #1e293b", borderRadius: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    {["Roll No", "Name", "Mother Name"].map(h => (
                      <th key={h} style={{ background: "#0f172a", color: "#6366f1", padding: "10px 12px", textAlign: "left", borderBottom: "1px solid #1e293b", fontFamily: "'Space Grotesk',sans-serif", fontSize: 11 }}>
                        {h}
                      </th>
                    ))}
                    {subjectCodes.map(code => [
                      <th key={`${code}_UA`} style={{ background: "#131929", color: "#94a3b8", padding: "10px 8px", borderBottom: "1px solid #1e293b", fontFamily: "'DM Mono',monospace", fontSize: 10 }}>
                        {code}<br />UA
                      </th>,
                      <th key={`${code}_CA`} style={{ background: "#131929", color: "#94a3b8", padding: "10px 8px", borderBottom: "1px solid #1e293b", fontFamily: "'DM Mono',monospace", fontSize: 10 }}>
                        CA
                      </th>,
                      <th key={`${code}_Total`} style={{ background: "#0f1725", color: "#7c83fd", padding: "10px 8px", borderBottom: "1px solid #1e293b", fontFamily: "'DM Mono',monospace", fontSize: 10, borderRight: "1px solid #1e293b" }}>
                        Total
                      </th>
                    ])}
                    {["Final Total", "SGPA", "Result"].map(h => (
                      <th key={h} style={{ background: "#0f172a", color: "#34d399", padding: "10px 12px", borderBottom: "1px solid #1e293b", fontFamily: "'Space Grotesk',sans-serif", fontSize: 11 }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const res = row.result?.toLowerCase() || "";
                    const rc = res.includes("pass") ? "#34d399" : res.includes("fail") ? "#f87171" : "#fbbf24";
                    return (
                      <tr key={i} style={{ borderBottom: "1px solid #0f172a", background: i % 2 === 0 ? "#0b0f1a" : "#0d1120" }}>
                        <td style={{ padding: "8px 12px", color: "#a5b4fc", fontWeight: 500, whiteSpace: "nowrap" }}>
                          {row.rollNo}
                        </td>
                        <td style={{ padding: "8px 12px", color: "#e2e8f0", whiteSpace: "nowrap", fontFamily: "'Space Grotesk',sans-serif" }}>
                          {row.name}
                        </td>
                        <td style={{ padding: "8px 12px", color: "#94a3b8", whiteSpace: "nowrap" }}>
                          {row.motherName}
                        </td>
                        {subjectCodes.map(code => [
                          <td key={`${code}_UA`} style={{ padding: "8px 8px", color: "#94a3b8", textAlign: "center" }}>
                            {row[`${code}_UA`] ?? "—"}
                          </td>,
                          <td key={`${code}_CA`} style={{ padding: "8px 8px", color: "#94a3b8", textAlign: "center" }}>
                            {row[`${code}_CA`] ?? "—"}
                          </td>,
                          <td key={`${code}_Total`} style={{ padding: "8px 8px", color: "#c7d2fe", textAlign: "center", fontWeight: 500, borderRight: "1px solid #1e293b" }}>
                            {row[`${code}_Total`] ?? "—"}
                          </td>
                        ])}
                        <td style={{ padding: "8px 12px", color: "#34d399", fontWeight: 600, textAlign: "center" }}>
                          {row.finalTotal}
                        </td>
                        <td style={{ padding: "8px 12px", color: "#fbbf24", fontWeight: 600, textAlign: "center" }}>
                          {row.sgpa}
                        </td>
                        <td style={{ padding: "8px 12px", fontWeight: 600, whiteSpace: "nowrap", color: rc, fontFamily: "'Space Grotesk',sans-serif" }}>
                          {row.result}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: "#334155", textAlign: "right" }}>
              EC = Exempted/Carry-over · 0AB = Absent · EUC = Exempted University · Parsed from text layer
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
