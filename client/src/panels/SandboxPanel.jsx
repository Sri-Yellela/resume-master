// client/src/panels/SandboxPanel.jsx — Design System v4
import { useState, useEffect, useRef } from "react";
import { useTheme } from "../styles/theme.jsx";

export default function SandboxPanel({ entry, onClose, onSave, onExport }) {
  const { theme, mode } = useTheme();
  const [exporting, setExporting] = useState(false);
  const [dirty,     setDirty]     = useState(false);
  const [saveMsg,   setSaveMsg]   = useState("");
  const frameRef = useRef(null);

  useEffect(() => { setDirty(false); }, [entry?.html]);

  const getCurrentHtml = () => {
    if (!frameRef.current) return entry?.html || "";
    const doc = frameRef.current.contentDocument;
    return doc ? doc.documentElement.outerHTML : entry?.html || "";
  };

  const save = async () => {
    const html = getCurrentHtml();
    try {
      if (onSave) await onSave(html);
      setDirty(false);
      setSaveMsg("✓ Saved");
    } catch(e) {
      setSaveMsg("✗ Save failed");
    }
    setTimeout(() => setSaveMsg(""), 2500);
  };

  const downloadHtml = () => {
    const html = getCurrentHtml();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type:"text/html" }));
    a.download = `Resume_${(entry?.company||"resume").replace(/\s+/g,"_")}.html`;
    a.click();
  };

  const exportPdf = async () => {
    if (!entry?.html || exporting) return;
    setExporting(true);
    try {
      const html = getCurrentHtml();
      await onExport?.(null, html, entry?.company);
    } catch(e) { alert("PDF export failed: " + e.message); }
    finally { setExporting(false); }
  };

  const handleFrameLoad = () => {
    const frame = frameRef.current;
    if (!frame) return;
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.body.contentEditable = "true";
    doc.body.spellcheck = false;
    doc.addEventListener("input", () => setDirty(true));
  };

  const btnStyle = () => ({
    display:"inline-flex", alignItems:"center", gap:5,
    padding:"5px 14px", borderRadius:999,
    background:"transparent", color:theme.textMuted,
    border:`1px solid ${theme.border}`,
    fontSize:11, fontWeight:600, cursor:"pointer",
    transition:"all 0.15s",
  });

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%",
                  background:theme.bg }}>
      {/* Toolbar */}
      <div style={{
        background:theme.surface, borderBottom:`1px solid ${theme.border}`,
        padding:"8px 14px", display:"flex", alignItems:"center",
        gap:8, flexShrink:0,
      }}>
        <span style={{ fontWeight:800, fontSize:12, color:theme.accent }}>✏ Sandbox</span>
        {entry && (
          <span style={{ fontSize:11, color:theme.textMuted,
                         borderLeft:`1px solid ${theme.border}`, paddingLeft:10 }}>
            {entry.company} — {entry.title}
          </span>
        )}
        {dirty && <span style={{ fontSize:10, color:theme.warning, fontWeight:700 }}>● unsaved</span>}
        {saveMsg && <span style={{ fontSize:10, fontWeight:700,
          color: saveMsg.startsWith("✓") ? "#16a34a" : "#dc2626" }}>{saveMsg}</span>}
        <div style={{ flex:1 }}/>
        <button style={btnStyle()} onClick={save} disabled={!entry?.html}>💾 Save{dirty?"*":""}</button>
        <button style={btnStyle()} onClick={downloadHtml} disabled={!entry?.html}>⬇ HTML</button>
        <button style={btnStyle()} onClick={exportPdf} disabled={!entry?.html||exporting}>
          {exporting ? "⏳ Exporting…" : "🖨 PDF"}
        </button>
        <button onClick={onClose}
          style={{ ...btnStyle(), color:theme.danger, borderColor:theme.dangerMuted }}>✕</button>
      </div>

      {!entry ? (
        <div style={{ flex:1, display:"flex", flexDirection:"column",
                      alignItems:"center", justifyContent:"center", gap:12,
                      color:theme.textMuted }}>
          <div style={{ fontSize:48 }}>⚡</div>
          <div style={{ fontWeight:700, fontSize:14 }}>Generate a resume to populate the sandbox.</div>
        </div>
      ) : (
        <div style={{ flex:1, overflow:"auto",
                      background:mode==="dark" ? theme.bg : theme.surfaceHigh,
                      padding:32, display:"flex", justifyContent:"center" }}>
          <div style={{ width:"100%", maxWidth:760,
                        background:theme.surface, borderRadius:4,
                        boxShadow:theme.shadowXl }}>
            <iframe ref={frameRef} srcDoc={entry.html}
              onLoad={handleFrameLoad}
              style={{ width:"100%", minHeight:900, border:"none", display:"block" }}
              title="preview" sandbox="allow-same-origin allow-scripts"/>
          </div>
        </div>
      )}
    </div>
  );
}
