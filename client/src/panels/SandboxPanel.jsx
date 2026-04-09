// REVAMP v3 — SandboxPanel.jsx — contentEditable preview
import { useState, useEffect, useRef } from "react";
import { useTheme } from "../styles/theme.jsx";

export default function SandboxPanel({ entry, onClose, onSave, onExport }) {
  const { theme } = useTheme();
  const [exporting, setExporting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const frameRef = useRef(null);

  useEffect(() => {
    setDirty(false);
  }, [entry?.html]);

  const getCurrentHtml = () => {
    if (!frameRef.current) return entry?.html || "";
    const doc = frameRef.current.contentDocument;
    return doc ? doc.documentElement.outerHTML : entry?.html || "";
  };

  const save = async () => {
    const html = getCurrentHtml();
    if (onSave) await onSave(html);
    setDirty(false);
  };

  const downloadHtml = () => {
    const html = getCurrentHtml();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type:"text/html" }));
    a.download = `Resume_${(entry?.company || "resume").replace(/\s+/g,"_")}.html`;
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

  // Enable contentEditable on the iframe document after load
  const handleFrameLoad = () => {
    const frame = frameRef.current;
    if (!frame) return;
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.body.contentEditable = "true";
    doc.body.spellcheck = false;
    doc.addEventListener("input", () => setDirty(true));
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%",
                  background:theme.gradBg }}>
      {/* Toolbar */}
      <div style={{ background:theme.gradPanel, padding:"7px 12px",
                    display:"flex", alignItems:"center", gap:7, flexShrink:0,
                    borderBottom:`1px solid ${theme.colorBorder}`, flexWrap:"wrap" }}>
        <span style={{ fontWeight:800, fontSize:12, color:theme.colorPrimary }}>
          ✏️ Sandbox
        </span>
        {entry && (
          <span style={{ fontSize:10, color:theme.colorMuted,
                         borderLeft:`1px solid ${theme.colorBorder}`, paddingLeft:8 }}>
            {entry.company} — {entry.title}
          </span>
        )}
        {dirty && (
          <span style={{ fontSize:10, color:"#f59e0b", fontWeight:700 }}>● unsaved</span>
        )}
        <div style={{ flex:1 }}/>

        <TB theme={theme} bg="#8b5cf6" disabled={!entry?.html} onClick={save}>
          💾 Save{dirty ? "*" : ""}
        </TB>
        <TB theme={theme} bg="#10b981" disabled={!entry?.html} onClick={downloadHtml}>
          ⬇ HTML
        </TB>
        <TB theme={theme} bg="#6366f1" disabled={!entry?.html || exporting} onClick={exportPdf}>
          {exporting ? "⏳…" : "🖨 PDF"}
        </TB>
        <button onClick={onClose}
          style={{ background:"transparent", color:theme.colorMuted,
                   border:`1px solid ${theme.colorBorder}`,
                   borderRadius:"999px", padding:"3px 8px", cursor:"pointer", fontSize:11 }}>
          ✕
        </button>
      </div>

      {!entry ? (
        <div style={{ flex:1, display:"flex", flexDirection:"column",
                      alignItems:"center", justifyContent:"center", gap:10 }}>
          <div style={{ fontSize:36 }}>⚡</div>
          <div style={{ color:theme.colorMuted, fontWeight:700 }}>
            Generate a resume to populate the sandbox.
          </div>
        </div>
      ) : (
        <div style={{ flex:1, display:"flex", flexDirection:"column",
                      background:theme.colorDim, overflow:"auto" }}>
          <div style={{ background:theme.colorSurface, padding:"4px 10px",
                        fontSize:10, color:theme.colorMuted,
                        borderBottom:`1px solid ${theme.colorBorder}`, flexShrink:0 }}>
            Live Preview — click any text to edit directly
          </div>
          <div style={{ flex:1, padding:10, display:"flex",
                        justifyContent:"center", overflow:"auto" }}>
            <div style={{ width:"100%", maxWidth:800, background:"#fff",
                          boxShadow:"0 2px 12px #0004", borderRadius:3 }}>
              <iframe
                ref={frameRef}
                srcDoc={entry.html}
                onLoad={handleFrameLoad}
                style={{ width:"100%", minHeight:900, border:"none", display:"block" }}
                title="preview"
                sandbox="allow-same-origin allow-scripts"/>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TB({ theme, bg, disabled, onClick, children }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      style={{ position:"relative", overflow:"hidden",
               background:disabled ? theme.colorDim : (hov ? "transparent" : bg),
               color:disabled ? theme.colorMuted : "#fff",
               border:`1px solid ${disabled ? theme.colorDim : bg}`,
               borderRadius:"999px", padding:"5px 11px",
               cursor:disabled ? "not-allowed" : "pointer",
               fontSize:11, fontWeight:700, whiteSpace:"nowrap",
               opacity:disabled ? 0.5 : 1, transition:"color 0.2s" }}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}>
      <span style={{
        position:"absolute", inset:0,
        background:bg,
        transform:hov && !disabled ? "translateY(0)" : "translateY(100%)",
        transition:"transform 0.2s ease",
        zIndex:0,
      }}/>
      <span style={{ position:"relative", zIndex:1 }}>{children}</span>
    </button>
  );
}
