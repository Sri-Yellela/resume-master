// client/src/pages/tools/ATSToolPage.jsx — Standalone ATS scorer
import { useState, useRef } from "react";
import { useTheme } from "../../styles/theme.jsx";
import { Footer } from "../../components/Footer.jsx";
import ScrollDock from "../../components/ScrollDock.jsx";

function ScoreDonut({ score }) {
  const { theme } = useTheme();
  const r = 44, cx = 56, cy = 56;
  const circ = 2 * Math.PI * r;
  const fill = ((score || 0) / 100) * circ;
  const color = score >= 75 ? "#16a34a" : score >= 50 ? "#d97706" : "#dc2626";
  return (
    <svg width={112} height={112} viewBox="0 0 112 112">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={theme.surfaceHigh} strokeWidth={10}/>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={10}
        strokeDasharray={`${fill} ${circ}`} strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}/>
      <text x={cx} y={cy+1} textAnchor="middle" dominantBaseline="middle"
        fontSize={20} fontWeight={900} fill={color}>{score}</text>
      <text x={cx} y={cy+18} textAnchor="middle" dominantBaseline="middle"
        fontSize={10} fill={theme.textMuted}>/ 100</text>
    </svg>
  );
}

export function ATSToolPage() {
  const { theme } = useTheme();
  const [pdfFile,   setPdfFile]   = useState(null);
  const [jdText,    setJdText]    = useState("");
  const [loading,   setLoading]   = useState(false);
  const [result,    setResult]    = useState(null);
  const [error,     setError]     = useState("");
  const fileRef = useRef();

  const submit = async () => {
    if (!pdfFile || !jdText.trim()) { setError("Upload a PDF and paste a job description."); return; }
    setLoading(true); setError(""); setResult(null);
    try {
      const fd = new FormData();
      fd.append("resume", pdfFile);
      fd.append("jd_text", jdText);
      const r = await fetch("/api/standalone/ats", { method: "POST", credentials: "include", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Scoring failed");
      setResult(d);
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="scroll-dock-page" style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                  background: theme.bg, color: theme.text,
                  fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ScrollDock variant="tools" />

      <main style={{ flex: 1, maxWidth: 720, margin: "0 auto", padding: "48px 24px", width: "100%" }}>
        <h1 style={{ fontSize: "clamp(28px, 5vw, 44px)", fontWeight: 900,
                     fontFamily: "'Barlow Condensed', sans-serif",
                     letterSpacing: "-1px", marginBottom: 10, color: theme.text }}>
          See how your resume scores against any job
        </h1>
        <p style={{ fontSize: 15, color: theme.textMuted, marginBottom: 36, lineHeight: 1.6 }}>
          Upload your resume and paste a job description. Get an instant ATS score with matched and missing keywords.
        </p>

        {/* Upload + JD */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* PDF upload */}
          <div
            onClick={() => fileRef.current?.click()}
            style={{
              border: `2px dashed ${pdfFile ? theme.accent : theme.border}`,
              borderRadius: 10, padding: "28px 20px", textAlign: "center",
              cursor: "pointer", background: theme.surface,
              transition: "border-color 0.15s",
            }}
          >
            <input ref={fileRef} type="file" accept=".pdf" style={{ display:"none" }}
              onChange={e => setPdfFile(e.target.files?.[0] || null)}/>
            <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>
              {pdfFile ? `✓ ${pdfFile.name}` : "Click to upload your resume PDF"}
            </div>
            <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4 }}>PDF only · max 5 MB</div>
          </div>

          {/* JD text area */}
          <textarea
            value={jdText} onChange={e => setJdText(e.target.value)}
            placeholder="Paste the job description here…"
            rows={8}
            style={{
              width: "100%", padding: "12px 14px", borderRadius: 8,
              border: `1.5px solid ${theme.border}`, background: theme.surface,
              color: theme.text, fontSize: 13, resize: "vertical",
              outline: "none", boxSizing: "border-box", lineHeight: 1.6,
            }}
          />

          {error && <div style={{ fontSize: 12, color: "#dc2626", fontWeight: 600 }}>{error}</div>}

          <button onClick={submit} disabled={loading} style={{
            padding: "12px", borderRadius: 8, border: "none",
            background: loading ? theme.surfaceHigh : theme.accent,
            color: loading ? theme.textMuted : "#0f0f0f",
            fontSize: 14, fontWeight: 700, cursor: loading ? "default" : "pointer",
          }}>
            {loading ? "Scoring…" : "Score My Resume"}
          </button>
        </div>

        {/* Results */}
        {result && (
          <div style={{ marginTop: 40, display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 24,
                          padding: 24, borderRadius: 10, background: theme.surface,
                          border: `1px solid ${theme.border}` }}>
              <ScoreDonut score={result.score}/>
              <div>
                <div style={{ fontWeight: 800, fontSize: 20, color: theme.text }}>{result.verdict}</div>
                <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4 }}>{result.summary}</div>
              </div>
            </div>

            {/* Matched / Missing keywords */}
            {[["Matched keywords", result.matched_keywords, "#16a34a"],
              ["Missing keywords", result.missing_keywords, "#dc2626"]].map(([lbl, chips, col]) =>
              chips?.length ? (
                <div key={lbl}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: theme.textMuted,
                                textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                    {lbl}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {chips.map(c => (
                      <span key={c} style={{ padding: "3px 10px", borderRadius: 999, fontSize: 12,
                                              background: col + "18", color: col, fontWeight: 600 }}>
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null
            )}

            <div style={{
              padding: "16px 20px", borderRadius: 8,
              background: theme.surfaceHigh, fontSize: 13, color: theme.text,
              border: `1px solid ${theme.border}`,
            }}>
              Want to fix these gaps?{" "}
              <Link to="/tools/generate" style={{ color: theme.accent, fontWeight: 700, textDecoration: "none" }}>
                Generate a focused resume →
              </Link>
            </div>
          </div>
        )}
      </main>

      {/* Upsell */}
      <section style={{ borderTop: `1px solid ${theme.border}`, padding: "48px 24px", background: theme.surface }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 6, color: theme.text }}>
            You just found your gaps. Now fix them.
          </h2>
          <p style={{ color: theme.textMuted, marginBottom: 28 }}>
            The full platform rewrites your resume, discovers matching jobs, and applies automatically.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16, marginBottom: 24 }}>
            {[
              { title: "AI Resume Generator", desc: "Rewrites your resume to hit every missing keyword" },
              { title: "Job Discovery",        desc: "Find roles where your score is already high" },
              { title: "Auto Apply",            desc: "Apply to matched roles in one click" },
            ].map(f => (
              <div key={f.title} style={{ padding: 20, borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.bg }}>
                <div style={{ fontWeight: 700, marginBottom: 6, color: theme.text }}>{f.title}</div>
                <div style={{ fontSize: 12, color: theme.textMuted }}>{f.desc}</div>
              </div>
            ))}
          </div>
          <Link to="/login">
            <button style={{ padding: "10px 28px", borderRadius: 6, border: "none",
                             background: theme.accent, color: "#0f0f0f", fontWeight: 700, cursor: "pointer" }}>
              Get full access →
            </button>
          </Link>
        </div>
      </section>

      <Footer/>
    </div>
  );
}
