// client/src/panels/SandboxPanel.jsx — Design System v4
//
// RESUME SCALING:
// Renders the resume at fixed A4 dimensions (794×1123px at 96dpi).
// Scale is stored in a ref — NOT state — so ResizeObserver can update the
// transform directly on the DOM node (innerRef) without triggering a React
// re-render. This eliminates the flicker that occurs when setScale() causes
// a re-render mid-drag.
// Initial scale is calculated synchronously on mount (before first paint) to
// prevent the scale-1 → scale-N snap on first load.
// willChange: transform promotes the inner div to a GPU layer.
// Container: overflowX hidden, overflowY auto — one clean vertical scrollbar.
// iframe: scrolling="no", overflow hidden — no internal scroll.
// To change page dimensions edit RESUME_PAGE_WIDTH / RESUME_PAGE_HEIGHT below.

import { useState, useEffect, useRef } from "react";
import { useTheme } from "../styles/theme.jsx";

const RESUME_PAGE_WIDTH  = 794;  // A4 at 96dpi
const RESUME_PAGE_HEIGHT = 1123; // A4 at 96dpi

export default function SandboxPanel({ entry, onClose, onSave, onExport }) {
  const { theme, isDark } = useTheme();
  const [exporting,   setExporting]   = useState(false);
  const [exportError, setExportError] = useState("");
  const [dirty,       setDirty]       = useState(false);
  const [saveMsg,     setSaveMsg]     = useState("");
  const [selectedTool, setSelectedTool] = useState(entry?.activeTool || entry?.tool || "generate");
  const variants = entry?.variants || null;
  const variantKeys = variants ? Object.keys(variants) : [];
  const activeEntry = variants?.[selectedTool] || entry;

  const frameRef     = useRef(null);
  const containerRef = useRef(null);  // outer scroll container, observed by ResizeObserver
  const innerRef     = useRef(null);  // scale host — transform applied directly to DOM
  const scaleRef     = useRef(1);     // current scale value — never stored in state

  useEffect(() => {
    setSelectedTool(entry?.activeTool || entry?.tool || "generate");
    setDirty(false);
    setExportError("");
  }, [entry?.html, entry?.activeTool, entry?.tool]);

  // Apply scale directly to the DOM node — no state update, no re-render, no flicker.
  const applyScale = (s) => {
    scaleRef.current = s;
    if (innerRef.current) {
      innerRef.current.style.transform = `scale(${s})`;
      innerRef.current.style.height    = `${RESUME_PAGE_HEIGHT * s}px`;
    }
  };

  // Compute initial scale synchronously, then observe for changes.
  // Dependency [activeEntry?.html] ensures scale recalculates when new resume arrives.
  useEffect(() => {
    // Compute initial scale immediately — avoids scale-1 flash before RO fires
    if (containerRef.current) {
      const w = containerRef.current.clientWidth - 8;
      if (w > 0) applyScale(Math.min(w / RESUME_PAGE_WIDTH, 1));
    }

    const ro = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width - 8;
      const s = Math.min(Math.max(w, 0) / RESUME_PAGE_WIDTH, 1);
      if (Math.abs(s - scaleRef.current) > 0.001) applyScale(s);
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [activeEntry?.html]); // eslint-disable-line react-hooks/exhaustive-deps

  const getCurrentHtml = () => {
    if (!frameRef.current) return activeEntry?.html || "";
    const doc = frameRef.current.contentDocument;
    return doc ? doc.documentElement.outerHTML : activeEntry?.html || "";
  };

  const save = async () => {
    const html = getCurrentHtml();
    try {
      if (onSave) await onSave(html, activeEntry);
      setDirty(false);
      setSaveMsg("✓ Saved");
    } catch {
      setSaveMsg("✗ Save failed");
    }
    setTimeout(() => setSaveMsg(""), 2500);
  };

  const downloadHtml = () => {
    const html = getCurrentHtml();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type:"text/html" }));
    a.download = `Resume_${(activeEntry?.company||"resume").replace(/\s+/g,"_")}.html`;
    a.click();
  };

  const exportPdf = async () => {
    if (!activeEntry?.html || exporting) return;
    setExporting(true);
    setExportError("");
    try {
      const html = getCurrentHtml();
      await onExport?.(null, html, activeEntry?.company, activeEntry);
    } catch(e) {
      setExportError("PDF export failed: " + e.message);
    } finally { setExporting(false); }
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
    <div style={{ display:"flex", flexDirection:"column", height:"100%", background:theme.bg }}>
      <style>{`
        @keyframes rmShimmer { from { opacity: 0.4; } to { opacity: 0.9; } }
      `}</style>

      {/* Generating skeleton */}
      {activeEntry?.generating && (
        <div style={{ flex:1, padding:"24px 20px", display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:11, fontWeight:700, color:theme.accent,
                        display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ display:"inline-block", animation:"spin 0.8s linear infinite" }}>↻</span>
            {activeEntry?.stage || "Generating…"}
          </div>
          {[90,75,85,60,80,70,65,88,55,78].map((w,i) => (
            <div key={i} style={{
              height: i % 4 === 0 ? 16 : 11,
              width: `${w}%`,
              borderRadius: 3,
              background: theme.surfaceHigh,
              animation: `rmShimmer 1.2s ${i * 0.12}s ease-in-out infinite alternate`,
            }}/>
          ))}
        </div>
      )}

      {/* Error state */}
      {activeEntry?.error && !activeEntry?.generating && (
        <div style={{ flex:1, padding:24, display:"flex", flexDirection:"column",
                      alignItems:"center", justifyContent:"center", gap:12, textAlign:"center" }}>
          <div style={{ fontSize:32 }}>⚠</div>
          <div style={{ fontSize:13, color:theme.text, fontWeight:700 }}>Generation failed</div>
          <div style={{ fontSize:12, color:theme.textMuted }}>{activeEntry.error}</div>
          <button onClick={onClose}
            style={{ marginTop:8, padding:"7px 20px", borderRadius:999,
                     background:theme.surfaceHigh, border:`1px solid ${theme.border}`,
                     cursor:"pointer", fontSize:12, color:theme.text }}>
            Dismiss
          </button>
        </div>
      )}

      {/* Normal sandbox UI — only when not generating/errored */}
      {!activeEntry?.generating && !activeEntry?.error && (
        <>
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
                {activeEntry.company} — {activeEntry.title}
              </span>
            )}
            {variantKeys.length > 1 && (
              <div style={{ display:"flex", gap:4, borderLeft:`1px solid ${theme.border}`, paddingLeft:10 }}>
                {variantKeys.map(tool => (
                  <button key={tool} onClick={() => setSelectedTool(tool)}
                    style={{
                      ...btnStyle(),
                      padding:"4px 8px",
                      color:selectedTool === tool ? theme.accent : theme.textMuted,
                      borderColor:selectedTool === tool ? theme.accent : theme.border,
                    }}>
                    {variants[tool]?.toolLabel || (tool === "a_plus_resume" ? "A+ Resume" : "Generate")}
                  </button>
                ))}
              </div>
            )}
            {dirty && <span style={{ fontSize:10, color:theme.warning, fontWeight:700 }}>● unsaved</span>}
            {saveMsg && <span style={{ fontSize:10, fontWeight:700,
              color: saveMsg.startsWith("✓") ? "#16a34a" : "#dc2626" }}>{saveMsg}</span>}
            <div style={{ flex:1 }}/>
            <button style={btnStyle()} onClick={save} disabled={!activeEntry?.html}>💾 Save{dirty?"*":""}</button>
            <button style={btnStyle()} onClick={downloadHtml} disabled={!activeEntry?.html}>⬇ HTML</button>
            <button style={btnStyle()} onClick={exportPdf} disabled={!activeEntry?.html||exporting}>
              {exporting ? "⏳ Exporting…" : "🖨 PDF"}
            </button>
            {exportError && (
              <span style={{ fontSize:10, color:"#991b1b" }}>✗ {exportError}</span>
            )}
            <button onClick={onClose}
              style={{ ...btnStyle(), color:theme.danger, borderColor:theme.dangerMuted }}>✕</button>
          </div>

          {!activeEntry ? (
            <div style={{ flex:1, display:"flex", flexDirection:"column",
                          alignItems:"center", justifyContent:"center", gap:12,
                          color:theme.textMuted }}>
              <div style={{ fontSize:48 }}>⚡</div>
              <div style={{ fontWeight:700, fontSize:14 }}>Generate a resume to populate the sandbox.</div>
            </div>
          ) : (
            // containerRef — observed by ResizeObserver, single vertical scroll surface.
            // innerRef     — scale host, transform applied directly to DOM (no re-render).
            <div
              ref={containerRef}
              style={{
                flex:1,
                overflowX: "hidden",  // never horizontal scroll
                overflowY: "auto",    // one clean vertical scrollbar
                background: isDark ? theme.bg : theme.surfaceHigh,
                padding: "4px",
                boxSizing: "border-box",
              }}
            >
              {/* Scale host — natural A4 dimensions; transform mutated directly via innerRef */}
              <div
                ref={innerRef}
                style={{
                  width:           RESUME_PAGE_WIDTH + "px",
                  height:          RESUME_PAGE_HEIGHT + "px",
                  transformOrigin: "top left",
                  transform:       `scale(${scaleRef.current})`,
                  overflow:        "hidden",
                  willChange:      "transform",  // GPU layer — prevents paint flicker
                  background:      theme.surface,
                  borderRadius:    4,
                  boxShadow:       theme.shadowXl,
                }}
              >
                <iframe
                  ref={frameRef}
                  srcDoc={activeEntry.html}
                  onLoad={handleFrameLoad}
                  style={{
                    width:    RESUME_PAGE_WIDTH  + "px",
                    height:   RESUME_PAGE_HEIGHT + "px",
                    border:   "none",
                    display:  "block",
                    overflow: "hidden",
                  }}
                  scrolling="no"
                  title="resume-preview"
                  sandbox="allow-same-origin allow-scripts"
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
