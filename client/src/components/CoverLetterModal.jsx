import { useState } from "react";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

const TONES = [
  { value: "professional",   label: "Professional" },
  { value: "conversational", label: "Conversational" },
  { value: "enthusiastic",   label: "Enthusiastic" },
];

export default function CoverLetterModal({ resumeText, jobDescription, jobTitle, company, onClose }) {
  const { theme, isDark } = useTheme();
  const [tone, setTone] = useState("professional");
  const [jd, setJd] = useState(jobDescription || "");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    setLoading(true); setError(""); setResult("");
    try {
      const d = await api("/api/cover-letter/generate", {
        method: "POST",
        body: JSON.stringify({ resumeText, jobDescription: jd, tone, jobTitle, company }),
      });
      setResult(d.coverLetter || "");
    } catch (e) {
      setError(e.message || "Failed to generate cover letter.");
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const download = () => {
    const blob = new Blob([result], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), {
      href: url,
      download: `Cover_Letter_${(company || "Application").replace(/\s+/g, "_")}.txt`,
    });
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const overlay = {
    position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:9000,
    display:"flex", alignItems:"center", justifyContent:"center", padding:16,
  };
  const modal = {
    background: theme.surface, border:`1px solid ${theme.border}`,
    borderRadius:12, width:"100%", maxWidth:680, maxHeight:"90vh",
    display:"flex", flexDirection:"column", overflow:"hidden",
    boxShadow:"0 24px 80px rgba(0,0,0,0.35)",
  };
  const hdr = {
    display:"flex", alignItems:"center", justifyContent:"space-between",
    padding:"14px 18px", borderBottom:`1px solid ${theme.border}`, flexShrink:0,
  };
  const btn = (accent, secondary = false) => ({
    border: secondary ? `1px solid ${theme.border}` : "none",
    borderRadius:6, padding:"8px 14px", fontWeight:700, fontSize:12,
    cursor:"pointer", background: secondary ? theme.surfaceHigh : accent,
    color: secondary ? theme.text : "#fff",
  });

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={modal}>
        {/* Header */}
        <div style={hdr}>
          <div>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                          fontSize:20, letterSpacing:"0.06em", textTransform:"uppercase",
                          color:theme.text }}>
              Cover Letter
            </div>
            {(jobTitle || company) && (
              <div style={{ fontSize:11, color:theme.textMuted, marginTop:2 }}>
                {[jobTitle, company].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
          <button onClick={onClose}
            style={{ background:"none", border:"none", cursor:"pointer",
                     color:theme.textMuted, fontSize:18, lineHeight:1 }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex:1, overflowY:"auto", padding:"16px 18px", display:"flex", flexDirection:"column", gap:14 }}>
          {/* Tone */}
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:theme.textMuted, marginBottom:6, textTransform:"uppercase", letterSpacing:"0.06em" }}>Tone</div>
            <div style={{ display:"flex", gap:8 }}>
              {TONES.map(t => (
                <button key={t.value} onClick={() => setTone(t.value)}
                  style={{ ...btn(theme.accent, tone !== t.value), padding:"6px 12px",
                           border:`1px solid ${tone === t.value ? theme.accent : theme.border}`,
                           background: tone === t.value ? theme.accent+"22" : "transparent",
                           color: tone === t.value ? theme.accent : theme.textMuted }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* JD textarea (pre-filled, editable) */}
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:theme.textMuted, marginBottom:6, textTransform:"uppercase", letterSpacing:"0.06em" }}>
              Job Description (optional)
            </div>
            <textarea
              value={jd}
              onChange={e => setJd(e.target.value)}
              rows={5}
              placeholder="Paste the job description here for a more tailored letter..."
              style={{ width:"100%", borderRadius:6, border:`1px solid ${theme.border}`,
                       background:theme.bg, color:theme.text, fontSize:12,
                       padding:"8px 10px", resize:"vertical", fontFamily:"inherit",
                       outline:"none", boxSizing:"border-box" }}
            />
          </div>

          {error && (
            <div style={{ background:"#fee2e2", color:"#991b1b", borderRadius:6,
                          padding:"8px 12px", fontSize:12 }}>{error}</div>
          )}

          {/* Result */}
          {result && (
            <div>
              <div style={{ fontSize:11, fontWeight:700, color:theme.textMuted, marginBottom:6,
                            textTransform:"uppercase", letterSpacing:"0.06em" }}>Your Cover Letter</div>
              <div style={{ background:theme.bg, border:`1px solid ${theme.border}`, borderRadius:6,
                            padding:"12px 14px", fontSize:13, color:theme.text,
                            lineHeight:1.7, whiteSpace:"pre-wrap", maxHeight:320, overflowY:"auto" }}>
                {result}
              </div>
              <div style={{ display:"flex", gap:8, marginTop:10 }}>
                <button onClick={copy} style={btn(theme.accent)}>
                  {copied ? "✓ Copied" : "Copy"}
                </button>
                <button onClick={download} style={btn(theme.accent, true)}>
                  Download .txt
                </button>
                <button onClick={generate} disabled={loading} style={btn(theme.surfaceHigh, true)}>
                  ↻ Regenerate
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {!result && (
          <div style={{ padding:"12px 18px", borderTop:`1px solid ${theme.border}`, flexShrink:0 }}>
            <button onClick={generate} disabled={loading || !resumeText}
              style={{ ...btn(theme.accent), opacity: loading || !resumeText ? 0.6 : 1, width:"100%" }}>
              {loading ? "Writing your cover letter…" : "Generate Cover Letter"}
            </button>
            {!resumeText && (
              <div style={{ fontSize:11, color:theme.textMuted, marginTop:6, textAlign:"center" }}>
                Upload your resume first to generate a cover letter.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
