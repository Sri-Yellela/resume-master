// REVAMP v2 — SandboxPanel.jsx (shadcn UI integrated)
import { useState, useEffect } from "react";
import { useTheme } from "../styles/theme.jsx";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";

export default function SandboxPanel({ entry, onClose, onSave, onExport }) {
  const { theme } = useTheme();
  const [code,      setCode]      = useState(entry?.html || "");
  const [live,      setLive]      = useState(entry?.html || "");
  const [view,      setView]      = useState("split");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (entry?.html) { setCode(entry.html); setLive(entry.html); }
  }, [entry?.html]);

  const apply      = () => setLive(code);
  const save       = async () => { if (onSave) await onSave(code); };
  const downloadHtml = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([live], { type:"text/html" }));
    a.download = `Resume_${(entry?.company || "resume").replace(/\s+/g,"_")}.html`;
    a.click();
  };
  const exportPdf = async () => {
    if (!live || exporting) return;
    setExporting(true);
    try { await onExport?.(null, live, entry?.company); }
    catch(e) { alert("PDF export failed: " + e.message); }
    finally { setExporting(false); }
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
        <div style={{ flex:1 }}/>

        {/* View toggle */}
        <div style={{ display:"flex", background:`rgba(0,0,0,0.3)`,
                      borderRadius:6, padding:2, gap:1 }}>
          {[["preview","👁"],["split","⊞"],["code","✏️"]].map(([t, i]) => (
            <button key={t}
              style={{ background:view===t ? theme.colorPrimary : "transparent",
                       color:view===t ? "#fff" : theme.colorMuted,
                       border:"none", borderRadius:4, padding:"3px 10px",
                       cursor:"pointer", fontSize:11, fontWeight:700 }}
              onClick={() => setView(t)}>
              {i} {t}
            </button>
          ))}
        </div>

        {(view === "code" || view === "split") && (
          <TB theme={theme} bg={theme.colorSecondary} onClick={apply}>▶ Apply</TB>
        )}
        <TB theme={theme} bg="#8b5cf6" disabled={!live} onClick={save}>💾 Save</TB>
        <TB theme={theme} bg="#10b981" disabled={!live} onClick={downloadHtml}>⬇ HTML</TB>
        <TB theme={theme} bg="#6366f1" disabled={!live || exporting} onClick={exportPdf}>
          {exporting ? "⏳…" : "🖨 PDF"}
        </TB>
        <button onClick={onClose}
          style={{ background:"transparent", color:theme.colorMuted,
                   border:`1px solid ${theme.colorBorder}`,
                   borderRadius:4, padding:"3px 8px", cursor:"pointer", fontSize:11 }}>
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
        <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
          {(view === "code" || view === "split") && (
            <div style={{ flex:view==="split" ? "0 0 44%" : 1, display:"flex",
                          flexDirection:"column",
                          borderRight:view==="split" ? `2px solid ${theme.colorBorder}` : "none" }}>
              <div style={{ background:"rgba(0,0,0,0.4)", padding:"4px 10px",
                            fontSize:10, color:theme.colorDim,
                            borderBottom:`1px solid ${theme.colorBorder}`, flexShrink:0 }}>
                HTML Editor · Ctrl+Enter to apply
              </div>
              <textarea value={code} onChange={e => setCode(e.target.value)}
                onKeyDown={e => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    e.preventDefault(); apply();
                  }
                }}
                spellCheck={false}
                style={{ flex:1, background:"rgba(0,0,0,0.5)",
                         color:theme.colorText, border:"none", outline:"none",
                         fontFamily:"'JetBrains Mono','Courier New',monospace",
                         fontSize:11, lineHeight:1.6, padding:10,
                         resize:"none", tabSize:2 }}/>
            </div>
          )}
          {(view === "preview" || view === "split") && (
            <div style={{ flex:1, display:"flex", flexDirection:"column",
                          background:theme.colorDim, overflow:"auto" }}>
              <div style={{ background:theme.colorSurface, padding:"4px 10px",
                            fontSize:10, color:theme.colorMuted,
                            borderBottom:`1px solid ${theme.colorBorder}`, flexShrink:0 }}>
                Live Preview
              </div>
              <div style={{ flex:1, padding:10, display:"flex",
                            justifyContent:"center", overflow:"auto" }}>
                <div style={{ width:"100%", maxWidth:800, background:"#fff",
                              boxShadow:"0 2px 12px #0004", borderRadius:3 }}>
                  <iframe srcDoc={live}
                    style={{ width:"100%", minHeight:900, border:"none", display:"block" }}
                    title="preview" sandbox="allow-same-origin"/>
                </div>
              </div>
            </div>
          )}
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
               borderRadius:5, padding:"5px 11px",
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
