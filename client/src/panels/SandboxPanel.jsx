// client/src/panels/SandboxPanel.jsx — Design System v4
//
// RESUME SCALING:
// Renders the resume at A4 natural width (RESUME_PAGE_WIDTH_PX).
// When the panel is narrower than A4, CSS transform: scale() shrinks the
// content to fit. When wider, scale stays at 1 (no upscaling).
// transformOrigin: top left — content anchors to the top-left of its wrapper.
// The centered wrapper sets its width/height to the scaled dimensions so the
// outer scroll container sees the correct content size.
// Single scrollbar: outer container (overflow:auto) is the ONE scroll surface.
// Iframe height is set imperatively after load to prevent iframe-internal scroll.
// To change the page width constant edit RESUME_PAGE_WIDTH_PX below.

import { useState, useEffect, useRef } from "react";
import { useTheme } from "../styles/theme.jsx";

const RESUME_PAGE_WIDTH_PX = 794; // A4 at 96dpi

export default function SandboxPanel({ entry, onClose, onSave, onExport }) {
  const { theme, mode } = useTheme();
  const [exporting,      setExporting]      = useState(false);
  const [exportError,    setExportError]    = useState("");
  const [dirty,          setDirty]          = useState(false);
  const [saveMsg,        setSaveMsg]        = useState("");
  const [naturalHeight,  setNaturalHeight]  = useState(1100);
  const [containerWidth, setContainerWidth] = useState(0);

  const frameRef     = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => { setDirty(false); setExportError(""); }, [entry?.html]);

  // Observe container width — fires in real time as the resize handle is dragged
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setContainerWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scale: fit A4 to available width; never scale up past 1
  // availableWidth = containerWidth minus 4px padding on each side
  const availableWidth = Math.max(0, containerWidth - 8);
  const scale = availableWidth === 0 || availableWidth >= RESUME_PAGE_WIDTH_PX
    ? 1
    : availableWidth / RESUME_PAGE_WIDTH_PX;

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
    } catch {
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
    setExportError("");
    try {
      const html = getCurrentHtml();
      await onExport?.(null, html, entry?.company);
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
    // Measure actual content height — same-origin srcDoc allows this
    const h = Math.max(
      doc.documentElement.scrollHeight,
      doc.body?.scrollHeight || 0,
      1100
    );
    setNaturalHeight(h);
    // Set iframe height explicitly to prevent iframe-internal scrollbar
    frame.style.height = h + "px";
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
      {entry?.generating && (
        <div style={{ flex:1, padding:"24px 20px", display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:11, fontWeight:700, color:theme.accent,
                        display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ display:"inline-block", animation:"spin 0.8s linear infinite" }}>↻</span>
            {entry?.stage || "Generating…"}
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
      {entry?.error && !entry?.generating && (
        <div style={{ flex:1, padding:24, display:"flex", flexDirection:"column",
                      alignItems:"center", justifyContent:"center", gap:12, textAlign:"center" }}>
          <div style={{ fontSize:32 }}>⚠</div>
          <div style={{ fontSize:13, color:theme.text, fontWeight:700 }}>Generation failed</div>
          <div style={{ fontSize:12, color:theme.textMuted }}>{entry.error}</div>
          <button onClick={onClose}
            style={{ marginTop:8, padding:"7px 20px", borderRadius:999,
                     background:theme.surfaceHigh, border:`1px solid ${theme.border}`,
                     cursor:"pointer", fontSize:12, color:theme.text }}>
            Dismiss
          </button>
        </div>
      )}

      {/* Normal sandbox UI — only when not generating/errored */}
      {!entry?.generating && !entry?.error && (
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
            {exportError && (
              <span style={{ fontSize:10, color:"#991b1b" }}>✗ {exportError}</span>
            )}
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
            // SINGLE scroll surface — outer div only; iframe height is set
            // explicitly in handleFrameLoad to prevent a second scrollbar.
            // Scale wrapper width = RESUME_PAGE_WIDTH_PX * scale (scaled visual size).
            // margin:auto centers it when the panel is wider than A4 natural size.
            <div
              ref={containerRef}
              style={{
                flex:1, overflowY:"auto", overflowX:"hidden",
                background: mode==="dark" ? theme.bg : theme.surfaceHigh,
                padding:4,
              }}
            >
              {/* Centered wrapper — width/height match the scaled visual dimensions */}
              <div style={{
                width:      RESUME_PAGE_WIDTH_PX * scale,
                background: theme.surface,
                borderRadius: 4,
                boxShadow:  theme.shadowXl,
                margin:     "0 auto",
                overflow:   "hidden",
              }}>
                {/* Scale host — natural A4 width, scaled via CSS transform */}
                <div style={{
                  width:           RESUME_PAGE_WIDTH_PX,
                  transform:       `scale(${scale})`,
                  transformOrigin: "top left",
                  // Collapse empty vertical DOM space caused by scale < 1
                  marginBottom:    scale < 1 ? -(naturalHeight * (1 - scale)) : 0,
                }}>
                  <iframe
                    ref={frameRef}
                    srcDoc={entry.html}
                    onLoad={handleFrameLoad}
                    style={{
                      width:"100%",
                      height: naturalHeight,
                      border:"none",
                      display:"block",
                    }}
                    title="preview"
                    sandbox="allow-same-origin allow-scripts"
                  />
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
