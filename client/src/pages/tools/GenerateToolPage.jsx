// client/src/pages/tools/GenerateToolPage.jsx — Standalone resume generator
import { useState, useRef } from "react";
import { Link } from "react-router-dom";
import { useTheme } from "../../styles/theme.jsx";
import { Footer } from "../../components/Footer.jsx";

function ToolNav() {
  const { theme } = useTheme();
  return (
    <nav style={{
      borderBottom: `1px solid ${theme.border}`,
      padding: "14px 32px",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      background: theme.surface,
    }}>
      <Link to="/" style={{ textDecoration: "none" }}>
        <span style={{ fontFamily: "'Barlow Condensed', sans-serif",
                       fontWeight: 900, fontSize: 22, letterSpacing: "-0.5px", color: theme.accent }}>
          Resume Master
        </span>
      </Link>
      <Link to="/login">
        <button style={{ padding: "7px 20px", borderRadius: 6, border: `1px solid ${theme.border}`,
                         background: theme.accent, color: "#0f0f0f",
                         fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
          Try the full platform →
        </button>
      </Link>
    </nav>
  );
}

const RESUME_PAGE_WIDTH  = 794;
const RESUME_PAGE_HEIGHT = 1123;

export function GenerateToolPage() {
  const { theme } = useTheme();
  const [pdfFile,  setPdfFile]  = useState(null);
  const [jdText,   setJdText]   = useState("");
  const [loading,  setLoading]  = useState(false);
  const [result,   setResult]   = useState(null);
  const [error,    setError]    = useState("");
  const fileRef  = useRef();
  const iframeRef = useRef();

  const submit = async () => {
    if (!pdfFile || !jdText.trim()) { setError("Upload a PDF and paste a job description."); return; }
    setLoading(true); setError(""); setResult(null);
    try {
      const fd = new FormData();
      fd.append("resume", pdfFile);
      fd.append("jd_text", jdText);
      const r = await fetch("/api/standalone/generate", { method: "POST", credentials: "include", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Generation failed");
      setResult(d);
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const downloadHtml = () => {
    if (!result?.html) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([result.html], { type: "text/html" }));
    a.download = "tailored_resume.html";
    a.click();
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                  background: theme.bg, color: theme.text,
                  fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ToolNav/>

      <main style={{ flex: 1, maxWidth: 720, margin: "0 auto", padding: "48px 24px", width: "100%" }}>
        <h1 style={{ fontSize: "clamp(28px, 5vw, 44px)", fontWeight: 900,
                     fontFamily: "'Barlow Condensed', sans-serif",
                     letterSpacing: "-1px", marginBottom: 10, color: theme.text }}>
          Get a tailored resume for any job in 30 seconds
        </h1>
        <p style={{ fontSize: 15, color: theme.textMuted, marginBottom: 36, lineHeight: 1.6 }}>
          Upload your resume and a job description. Our AI rewrites it to beat ATS filters.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div onClick={() => fileRef.current?.click()} style={{
            border: `2px dashed ${pdfFile ? theme.accent : theme.border}`,
            borderRadius: 10, padding: "28px 20px", textAlign: "center",
            cursor: "pointer", background: theme.surface,
          }}>
            <input ref={fileRef} type="file" accept=".pdf" style={{ display:"none" }}
              onChange={e => setPdfFile(e.target.files?.[0] || null)}/>
            <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>
              {pdfFile ? `✓ ${pdfFile.name}` : "Click to upload your resume PDF"}
            </div>
            <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4 }}>PDF only · max 5 MB</div>
          </div>

          <textarea
            value={jdText} onChange={e => setJdText(e.target.value)}
            placeholder="Paste the job description here…"
            rows={8}
            style={{ width: "100%", padding: "12px 14px", borderRadius: 8,
                     border: `1.5px solid ${theme.border}`, background: theme.surface,
                     color: theme.text, fontSize: 13, resize: "vertical",
                     outline: "none", boxSizing: "border-box", lineHeight: 1.6 }}
          />

          {error && <div style={{ fontSize: 12, color: "#dc2626", fontWeight: 600 }}>{error}</div>}

          <button onClick={submit} disabled={loading} style={{
            padding: "12px", borderRadius: 8, border: "none",
            background: loading ? theme.surfaceHigh : theme.accent,
            color: loading ? theme.textMuted : "#0f0f0f",
            fontSize: 14, fontWeight: 700, cursor: loading ? "default" : "pointer",
          }}>
            {loading ? "Generating…" : "Generate My Resume"}
          </button>
        </div>

        {/* Results */}
        {result && (
          <div style={{ marginTop: 40, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "12px 16px", borderRadius: 8, background: theme.surface,
                          border: `1px solid ${theme.border}` }}>
              <div>
                <span style={{ fontWeight: 700, color: theme.text }}>Resume generated</span>
                {result.atsScore && (
                  <span style={{ marginLeft: 12, fontSize: 12, color: theme.textMuted }}>
                    ATS score: <strong style={{ color: theme.accent }}>{result.atsScore}</strong>/100
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={downloadHtml} style={{
                  padding: "5px 14px", borderRadius: 6, border: `1px solid ${theme.border}`,
                  background: theme.bg, color: theme.text, fontSize: 12, fontWeight: 600, cursor: "pointer",
                }}>
                  Download HTML
                </button>
                <button onClick={() => window.print()} style={{
                  padding: "5px 14px", borderRadius: 6, border: "none",
                  background: theme.accent, color: "#0f0f0f", fontSize: 12, fontWeight: 600, cursor: "pointer",
                }}>
                  Export PDF
                </button>
              </div>
            </div>

            {/* Resume preview — scaled to fit container */}
            <div style={{ width: "100%", overflowX: "hidden", borderRadius: 8,
                          background: theme.surface, border: `1px solid ${theme.border}` }}>
              <iframe
                ref={iframeRef}
                srcDoc={result.html}
                scrolling="no"
                title="resume-preview"
                style={{
                  width: RESUME_PAGE_WIDTH + "px",
                  height: RESUME_PAGE_HEIGHT + "px",
                  border: "none", display: "block",
                  transform: `scale(${Math.min((window.innerWidth > 768 ? 670 : window.innerWidth - 56) / RESUME_PAGE_WIDTH, 1)})`,
                  transformOrigin: "top left",
                }}
              />
            </div>
          </div>
        )}
      </main>

      {/* Upsell */}
      <section style={{ borderTop: `1px solid ${theme.border}`, padding: "48px 24px", background: theme.surface }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 6, color: theme.text }}>
            This is one resume. You probably need more.
          </h2>
          <p style={{ color: theme.textMuted, marginBottom: 28 }}>
            The full platform tracks your whole pipeline, scores every job, and applies automatically.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16, marginBottom: 24 }}>
            {[
              { title: "Job Discovery",  desc: "Find fresh roles matched to your profile" },
              { title: "ATS Scoring",    desc: "See your score before you apply" },
              { title: "Auto Apply",     desc: "Apply to matched roles in one click" },
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
