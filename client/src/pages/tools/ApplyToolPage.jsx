// client/src/pages/tools/ApplyToolPage.jsx — Standalone auto-apply
import { useState, useRef } from "react";
import { Link } from "react-router-dom";
import { useTheme } from "../../styles/theme.jsx";
import { Footer } from "../../components/Footer.jsx";
import ScrollDock from "../../components/ScrollDock.jsx";

export function ApplyToolPage() {
  const { theme } = useTheme();
  const [pdfFile,    setPdfFile]    = useState(null);
  const [urlsText,   setUrlsText]   = useState("");
  const [profile,    setProfile]    = useState({ name:"", email:"", phone:"", linkedin:"", location:"", work_auth:"" });
  const [loading,    setLoading]    = useState(false);
  const [results,    setResults]    = useState(null);
  const [error,      setError]      = useState("");
  const [authNeeded, setAuthNeeded] = useState(false);
  const fileRef = useRef();

  const setField = (k, v) => setProfile(p => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!pdfFile) { setError("Upload your resume PDF."); return; }
    const urls = urlsText.split("\n").map(u => u.trim()).filter(Boolean);
    if (!urls.length) { setError("Add at least one job URL."); return; }
    if (urls.length > 20) { setError("Maximum 20 URLs per run."); return; }

    setLoading(true); setError(""); setResults(null);
    try {
      const fd = new FormData();
      fd.append("resume", pdfFile);
      fd.append("profile", JSON.stringify(profile));
      fd.append("urls", JSON.stringify(urls));
      const r = await fetch("/api/standalone/apply", { method: "POST", credentials: "include", body: fd });
      if (r.status === 401) { setAuthNeeded(true); return; }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Apply run failed");
      setResults(d.results);
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const STATUS_COLOR = { submitted: "#16a34a", failed: "#dc2626", skipped: "#d97706", pending: "#6b7280" };

  if (authNeeded) {
    return (
      <div className="scroll-dock-page" style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                    background: theme.bg, color: theme.text,
                    fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <ScrollDock variant="tools" />
        <div style={{ flex: 1, display: "flex", flexDirection: "column",
                      alignItems: "center", justifyContent: "center", gap: 16, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 48 }}>🔒</div>
          <div style={{ fontWeight: 800, fontSize: 22, color: theme.text }}>Sign in to use Auto Apply</div>
          <div style={{ fontSize: 14, color: theme.textMuted, maxWidth: 360 }}>
            Auto Apply requires a free account. ATS scoring and resume generation are available without signing in.
          </div>
          <Link to="/login">
            <button style={{ padding: "10px 28px", borderRadius: 6, border: "none",
                             background: theme.accent, color: "#0f0f0f", fontWeight: 700, cursor: "pointer", fontSize: 14 }}>
              Sign in or register free →
            </button>
          </Link>
        </div>
        <Footer/>
      </div>
    );
  }

  return (
    <div className="scroll-dock-page" style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                  background: theme.bg, color: theme.text,
                  fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ScrollDock variant="tools" />

      <main style={{ flex: 1, maxWidth: 720, margin: "0 auto", padding: "48px 24px", width: "100%" }}>
        <h1 style={{ fontSize: "clamp(28px, 5vw, 44px)", fontWeight: 900,
                     fontFamily: "'Barlow Condensed', sans-serif",
                     letterSpacing: "-1px", marginBottom: 10, color: theme.text }}>
          Apply to multiple jobs in one click
        </h1>
        <p style={{ fontSize: 15, color: theme.textMuted, marginBottom: 36, lineHeight: 1.6 }}>
          Upload your resume, add up to 20 job URLs, and we'll fill out every application for you.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* PDF */}
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
          </div>

          {/* Profile mini-form */}
          <div style={{ padding: "16px 20px", borderRadius: 8, border: `1px solid ${theme.border}`,
                        background: theme.surface, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: theme.textMuted,
                          textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Your details (used to fill applications)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {[["name","Full name"],["email","Email"],["phone","Phone"],
                ["linkedin","LinkedIn URL"],["location","City, State"],["work_auth","Work authorization"]].map(([k,ph]) => (
                <input key={k} value={profile[k]} onChange={e => setField(k, e.target.value)}
                  placeholder={ph}
                  style={{ padding: "7px 10px", borderRadius: 6, border: `1px solid ${theme.border}`,
                           background: theme.bg, color: theme.text, fontSize: 12, outline: "none" }}/>
              ))}
            </div>
          </div>

          {/* URLs */}
          <textarea
            value={urlsText} onChange={e => setUrlsText(e.target.value)}
            placeholder={"Paste job URLs, one per line (max 20):\nhttps://company.com/jobs/123\nhttps://boards.greenhouse.io/..."}
            rows={6}
            style={{ width: "100%", padding: "12px 14px", borderRadius: 8,
                     border: `1.5px solid ${theme.border}`, background: theme.surface,
                     color: theme.text, fontSize: 13, resize: "vertical",
                     outline: "none", boxSizing: "border-box", lineHeight: 1.6,
                     fontFamily: "monospace" }}
          />

          {error && <div style={{ fontSize: 12, color: "#dc2626", fontWeight: 600 }}>{error}</div>}

          <button onClick={submit} disabled={loading} style={{
            padding: "12px", borderRadius: 8, border: "none",
            background: loading ? theme.surfaceHigh : theme.accent,
            color: loading ? theme.textMuted : "#0f0f0f",
            fontSize: 14, fontWeight: 700, cursor: loading ? "default" : "pointer",
          }}>
            {loading ? "Applying…" : "Apply to All"}
          </button>
        </div>

        {/* Results table */}
        {results && (
          <div style={{ marginTop: 32 }}>
            <div style={{ fontWeight: 700, marginBottom: 12, color: theme.text }}>Results</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {results.map((r, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 14px", borderRadius: 6, background: theme.surface,
                  border: `1px solid ${theme.border}`,
                }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                    background: (STATUS_COLOR[r.status] || "#6b7280") + "20",
                    color: STATUS_COLOR[r.status] || "#6b7280",
                    flexShrink: 0,
                  }}>
                    {r.status}
                  </span>
                  <span style={{ fontSize: 12, color: theme.text, flex: 1, overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.company || r.url}
                  </span>
                  {r.error && <span style={{ fontSize: 11, color: "#dc2626" }}>{r.error}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Upsell */}
      <section style={{ borderTop: `1px solid ${theme.border}`, padding: "48px 24px", background: theme.surface }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 6, color: theme.text }}>
            Imagine doing this for every job in your pipeline.
          </h2>
          <p style={{ color: theme.textMuted, marginBottom: 28 }}>
            The full platform gives you a searchable job board, ATS scoring, and AI-generated resumes for every role.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16, marginBottom: 24 }}>
            {[
              { title: "Job Discovery",        desc: "Find fresh roles matched to your domain profile" },
              { title: "ATS Scoring",          desc: "See your score before you apply" },
              { title: "AI Resume Generator", desc: "Tailored resume per job in 30 seconds" },
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
