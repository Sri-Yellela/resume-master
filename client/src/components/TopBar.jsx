// client/src/components/TopBar.jsx — Lucy Brand
// Dropdowns are state-controlled with explicit inline styles (no Radix Portal / CSS-var dependency)
import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { useViewport } from "../hooks/useViewport.js";
import { Avatar, AvatarFallback } from "./ui/avatar";

const APPLY_MODES = [
  { value:"SIMPLE",         label:"Simple",         icon:"⚡", desc:"Job board only — no generation" },
  { value:"TAILORED",       label:"Tailored",        icon:"✦", desc:"Rewrite bullets, fixed employers" },
  { value:"CUSTOM_SAMPLER", label:"Custom Sampler",  icon:"⚙", desc:"Full customisation, JD-driven companies" },
];

// ── Lucy nested-box logo ──────────────────────────────────────
function LucyLogo({ theme, mini = false }) {
  if (mini) {
    return (
      <div style={{ position:"relative", width:38, height:28, display:"flex",
                    alignItems:"center", justifyContent:"center", flexShrink:0 }}>
        <div style={{ position:"absolute", inset:0, background:theme.accent,
                      transform:"rotate(-3deg)", borderRadius:2 }}/>
        <div style={{ position:"relative", zIndex:1, padding:"2px 6px",
                      background:"#ffffff", border:"2px solid #0f0f0f",
                      transform:"rotate(-2deg)", borderRadius:2,
                      display:"flex", alignItems:"center", justifyContent:"center" }}>
          <span style={{ fontFamily:"'Barlow Condensed','DM Sans',system-ui,sans-serif",
                          fontWeight:800, fontSize:13, letterSpacing:"0.06em",
                          textTransform:"uppercase", color:"#0f0f0f", fontStyle:"italic",
                          lineHeight:1, whiteSpace:"nowrap" }}>RM</span>
        </div>
      </div>
    );
  }
  return (
    <div style={{ position:"relative", display:"inline-flex", alignItems:"center",
                  justifyContent:"center", flexShrink:0, height:38, width:166 }}>
      {/* Outer box — accent fill, slightly more tilted */}
      <div style={{ position:"absolute", inset:0, background:theme.accent,
                    transform:"rotate(-3deg)", borderRadius:2 }}/>
      {/* Inner box — white fill, thick black border */}
      <div style={{ position:"relative", zIndex:1, padding:"3px 10px",
                    background:"#ffffff", border:"2.5px solid #0f0f0f",
                    transform:"rotate(-2deg)", borderRadius:2,
                    display:"flex", alignItems:"center", justifyContent:"center" }}>
        <span style={{ fontFamily:"'Barlow Condensed','DM Sans',system-ui,sans-serif",
                        fontWeight:800, fontSize:17, letterSpacing:"0.06em",
                        textTransform:"uppercase", color:"#0f0f0f", fontStyle:"italic",
                        lineHeight:1, whiteSpace:"nowrap" }}>Resume Master</span>
      </div>
    </div>
  );
}

// ── Generic close-on-outside-click hook ───────────────────────
function useClickOutside(ref, onClose) {
  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, onClose]);
}

// ── Inline dropdown panel (no Portal, no CSS vars) ────────────
function Panel({ children, style = {}, theme }) {
  return (
    <div style={{
      position: "absolute", top: "calc(100% + 8px)", right: 0,
      background: theme.surface, border: `1px solid ${theme.border}`,
      borderRadius: 12, boxShadow: theme.shadowMd,
      zIndex: 9999, minWidth: 260, padding: "8px 0",
      ...style,
    }}>
      {children}
    </div>
  );
}

// ── Light/Dark toggle ─────────────────────────────────────────
function ThemeToggle() {
  const { mode, toggleMode, theme } = useTheme();
  return (
    <button onClick={toggleMode} title={`Switch to ${mode === "light" ? "dark" : "light"} mode`}
      style={{
        width: 52, height: 28, borderRadius: 999,
        background: mode === "dark" ? theme.accent : theme.border,
        border: "none", cursor: "pointer", position: "relative",
        transition: "background 0.3s ease", flexShrink: 0,
        display: "flex", alignItems: "center",
      }}>
      <span style={{ position:"absolute", left:7, fontSize:12,
                     opacity: mode==="light" ? 1 : 0.35, transition:"opacity 0.2s" }}>☀</span>
      <span style={{ position:"absolute", right:7, fontSize:11,
                     opacity: mode==="dark" ? 1 : 0.35, transition:"opacity 0.2s" }}>☽</span>
      <div style={{
        position:"absolute", top:3,
        left: mode === "dark" ? 27 : 3,
        width:22, height:22, borderRadius:"50%",
        background:"white", boxShadow:"0 1px 4px rgba(0,0,0,0.25)",
        transition:"left 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)",
      }}/>
    </button>
  );
}

const TABS = [
  { id:"jobs",     label:"Jobs",     icon:"💼" },
  { id:"database", label:"Database", icon:"🗃" },
];

export default function TopBar({ user, activeTab, onTabChange, onLogout, onUserChange, resumeWidget }) {
  const { theme, accentId, setAccentId, ACCENT_OPTIONS } = useTheme();
  const { mode: vpMode } = useViewport();
  const isMobile = vpMode === "mobile" || vpMode === "tablet";

  // Mode picker
  const [modeOpen,    setModeOpen]    = useState(false);
  const modeRef = useRef(null);
  useClickOutside(modeRef, () => setModeOpen(false));

  // User menu (avatar click)
  const [userOpen,    setUserOpen]    = useState(false);
  const userRef = useRef(null);
  useClickOutside(userRef, () => setUserOpen(false));

  // Apify token
  const [tokenInput,  setTokenInput]  = useState("");
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenMsg,    setTokenMsg]    = useState("");

  const currentMode = user?.applyMode || "TAILORED";
  const modeObj = APPLY_MODES.find(m => m.value === currentMode) || APPLY_MODES[1];

  const selectMode = async (val) => {
    try {
      await api("/api/settings/apply-mode", { method:"PATCH", body:JSON.stringify({ mode:val }) });
      if (onUserChange) onUserChange(u => ({ ...u, applyMode: val }));
    } catch {}
    setModeOpen(false);
  };

  const saveToken = async () => {
    if (!tokenInput.trim()) return;
    setTokenSaving(true);
    try {
      await api("/api/settings/apify-token", { method:"PATCH", body:JSON.stringify({ token:tokenInput.trim() }) });
      setTokenMsg("✓ Saved");
      setTokenInput("");
    } catch(e) { setTokenMsg("✗ " + e.message); }
    setTokenSaving(false);
    setTimeout(() => setTokenMsg(""), 3000);
  };

  const tabs = TABS;

  const menuItemStyle = {
    padding: "10px 16px", cursor: "pointer", fontSize: 13,
    color: theme.text, background: "transparent", border: "none",
    display: "block", width: "100%", textAlign: "left",
    transition: "background 0.1s",
  };

  return (
    <div style={{
      height: 56,
      background: theme.surface,
      borderBottom: `3px solid ${theme.accent}`,
      display: "flex", alignItems: "center",
      padding: isMobile ? "0 12px" : "0 20px",
      gap: isMobile ? 8 : 24,
      position: "sticky", top: 0, zIndex: 100,
      flexShrink: 0,
    }}>
      {/* Brand logo */}
      <div style={{ display:"flex", alignItems:"center", flexShrink:0 }}>
        <LucyLogo theme={theme} mini={isMobile}/>
      </div>

      {/* Nav tabs */}
      <nav style={{ display:"flex", alignItems:"center", gap:isMobile?0:4, flex:1 }}>
        {tabs.map(t => {
          const isActive = activeTab === t.id;
          return (
            <button key={t.id} onClick={() => onTabChange(t.id)}
              style={{
                background: "transparent", border: "none",
                padding: isMobile ? "6px 8px" : "6px 14px", borderRadius: 4,
                fontFamily: "'Barlow Condensed', 'DM Sans', sans-serif",
                fontWeight: isActive ? 800 : 600,
                fontSize: 14, letterSpacing: "0.06em", textTransform: "uppercase",
                color: isActive ? theme.text : theme.textMuted,
                cursor: "pointer", position: "relative",
                transition: "color 0.15s",
              }}>
              {isMobile ? t.icon : t.label}
              {isActive && (
                <motion.div layoutId="tab-underline"
                  style={{
                    position: "absolute", bottom: -1, left: "50%",
                    transform: "translateX(-50%)",
                    width: 16, height: 2, borderRadius: 999,
                    background: theme.accent,
                  }}/>
              )}
            </button>
          );
        })}
      </nav>

      {/* Right side controls */}
      <div style={{ display:"flex", alignItems:"center", gap:isMobile?4:8, flexShrink:0 }}>
        <ThemeToggle/>

        {/* Mode chip — hidden on mobile to save space */}
        {!isMobile && (
          <div ref={modeRef} style={{ position:"relative" }}>
            <button
              onClick={() => setModeOpen(o => !o)}
              style={{
                display:"flex", alignItems:"center", gap:5,
                background: theme.accentMuted, color: theme.accentText,
                border: `1px solid ${theme.accent}55`,
                borderRadius: 999, padding:"4px 12px",
                fontSize: 11, fontWeight: 700, cursor:"pointer",
                transition: "border-radius 1s ease",
              }}>
              <span>{modeObj.icon}</span>
              <span>{modeObj.label}</span>
            </button>
            {modeOpen && (
              <Panel theme={theme} style={{ minWidth:220 }}>
                <div style={{ fontSize:10, letterSpacing:"0.1em", textTransform:"uppercase",
                               padding:"8px 16px 6px", color:theme.textDim, fontWeight:700 }}>
                  Apply Mode
                </div>
                {APPLY_MODES.map(m => (
                  <button key={m.value}
                    onClick={() => selectMode(m.value)}
                    onMouseEnter={e => e.currentTarget.style.background=theme.surfaceHigh}
                    onMouseLeave={e => e.currentTarget.style.background=m.value===currentMode?"#e8f6fb":"transparent"}
                    style={{
                      ...menuItemStyle,
                      background: m.value === currentMode ? theme.accentMuted : "transparent",
                      display:"flex", alignItems:"center", gap:10,
                    }}>
                    <span style={{ fontWeight:700 }}>{m.icon} {m.label}</span>
                    <span style={{ fontSize:10, color:theme.textDim, flex:1 }}>{m.desc}</span>
                    {m.value === currentMode && <span style={{ color:theme.accent, fontWeight:700 }}>✓</span>}
                  </button>
                ))}
                {/* Base Resume */}
                {resumeWidget && (
                  <div style={{ borderTop:`1px solid ${theme.border}`, padding:"10px 16px 8px" }}>
                    <div style={{ fontSize:10, fontWeight:700, textTransform:"uppercase",
                                   letterSpacing:"0.08em", color:theme.textDim, marginBottom:6 }}>
                      Base Resume
                    </div>
                    <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                      <button
                        onClick={() => !resumeWidget.uploading && resumeWidget.onUploadClick?.()}
                        style={{
                          background:"transparent",
                          border:`1px solid ${resumeWidget.text ? "#16a34a44" : theme.border}`,
                          borderRadius:2, padding:"6px 10px", cursor:"pointer",
                          fontSize:11, flex:1,
                          color: resumeWidget.uploading ? "#d97706" : resumeWidget.text ? "#16a34a" : theme.textMuted,
                          fontFamily:"'DM Sans',system-ui",
                        }}>
                        {resumeWidget.uploading ? "⏳ Parsing…"
                          : resumeWidget.text
                            ? `✓ ${(resumeWidget.fileName||"").length>24 ? (resumeWidget.fileName||"").slice(0,24)+"…" : resumeWidget.fileName}`
                          : "📄 Upload Resume"}
                      </button>
                      {resumeWidget.text && !resumeWidget.uploading && (
                        <button onClick={() => resumeWidget.onClear?.()}
                          style={{ background:"none", border:"none", color:"#dc2626",
                                   cursor:"pointer", fontSize:12, padding:"4px 6px", flexShrink:0 }}>
                          ✕
                        </button>
                      )}
                    </div>
                    {/* Enhance button — only shown when resume is uploaded */}
                    {resumeWidget.text && !resumeWidget.uploading && (
                      <div style={{ marginTop:8 }}>
                        {/* STATE 1: free enhance available */}
                        {!resumeWidget.enhanceUsed && (
                          <button
                            onClick={() => resumeWidget.onEnhance?.()}
                            disabled={resumeWidget.enhancing}
                            title="One-time free enhancement — rewrites your resume for better ATS without changing any facts or experience"
                            style={{
                              width:"100%", padding:"7px 10px", borderRadius:4,
                              background: resumeWidget.enhancing ? theme.surfaceHigh : theme.accentMuted,
                              color: theme.accentText, border:`1px solid ${theme.accent}44`,
                              cursor: resumeWidget.enhancing ? "not-allowed" : "pointer",
                              fontSize:11, fontWeight:700, fontFamily:"'DM Sans',system-ui",
                              opacity: resumeWidget.enhancing ? 0.7 : 1,
                            }}>
                            {resumeWidget.enhancing ? "⏳ Rewriting for better ATS…" : "✨ Enhance Resume"}
                          </button>
                        )}
                        {/* STATE 2: used, not paid */}
                        {resumeWidget.enhanceUsed && !resumeWidget.enhancePaid && (
                          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
                            <span style={{
                              fontSize:11, fontWeight:700,
                              background:"#dcfce7", color:"#166534",
                              padding:"4px 10px", borderRadius:999,
                            }}>Enhanced ✓</span>
                            <a href="/pricing" style={{ fontSize:10, color:theme.textMuted, textDecoration:"none" }}>
                              Upgrade to enhance again →
                            </a>
                          </div>
                        )}
                        {/* STATE 3: paid — reserved for future */}
                        {resumeWidget.enhanceUsed && resumeWidget.enhancePaid && (
                          <button
                            onClick={() => resumeWidget.onEnhance?.()}
                            disabled={resumeWidget.enhancing}
                            style={{
                              width:"100%", padding:"7px 10px", borderRadius:4,
                              background: theme.accentMuted, color: theme.accentText,
                              border:`1px solid ${theme.accent}44`,
                              cursor: resumeWidget.enhancing ? "not-allowed" : "pointer",
                              fontSize:11, fontWeight:700, fontFamily:"'DM Sans',system-ui",
                            }}>
                            {resumeWidget.enhancing ? "⏳ Rewriting…" : "✨ Enhance Resume"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Panel>
            )}
          </div>
        )}

        {/* Avatar — opens user menu with API key + sign out */}
        <div ref={userRef} style={{ position:"relative" }}>
          <Avatar
            onClick={() => setUserOpen(o => !o)}
            style={{ width:36, height:36, cursor:"pointer",
                     border:`2px solid ${userOpen ? theme.accent : theme.border}`,
                     borderRadius:"50%", transition:"border-color 0.15s" }}>
            <AvatarFallback style={{ background:theme.accent, color:"#0f0f0f",
                                      fontWeight:800, fontSize:13 }}>
              {(user?.username||"U")[0].toUpperCase()}
            </AvatarFallback>
          </Avatar>

          {userOpen && (
            <Panel theme={theme} style={{ minWidth:280 }}>
              {/* PROFILE nav button + user info */}
              <div style={{ padding:"10px 16px 8px", borderBottom:`1px solid ${theme.border}` }}>
                <button
                  onClick={() => { setUserOpen(false); onTabChange("profile"); }}
                  style={{
                    background:"transparent", border:"none", padding:0, cursor:"pointer",
                    fontFamily:"'Barlow Condensed','DM Sans',sans-serif",
                    fontWeight:800, fontSize:14, letterSpacing:"0.06em",
                    textTransform:"uppercase", color:theme.text,
                    display:"block", width:"100%", textAlign:"left",
                    transition:"color 0.15s",
                  }}
                  onMouseEnter={e => e.currentTarget.style.color=theme.accent}
                  onMouseLeave={e => e.currentTarget.style.color=theme.text}>
                  PROFILE
                </button>
                <div style={{ fontSize:10, color:theme.textDim, marginTop:2 }}>
                  {user?.username} · {user?.isAdmin ? "Administrator" : "Member"}
                </div>
              </div>

              {/* Accent color */}
              <div style={{ padding:"10px 16px 8px", borderBottom:`1px solid ${theme.border}` }}>
                <div style={{ fontSize:10, fontWeight:700, textTransform:"uppercase",
                               letterSpacing:"0.08em", color:theme.textDim, marginBottom:8 }}>
                  Accent Color
                </div>
                <div style={{
                  display:"flex", alignItems:"center", gap:8,
                  overflowX:"auto", paddingBottom:2,
                  /* touch-scroll */ WebkitOverflowScrolling:"touch",
                }}>
                  {ACCENT_OPTIONS.map(opt => (
                    <button key={opt.id} title={opt.label} onClick={() => setAccentId(opt.id)}
                      style={{
                        width:22, height:22, borderRadius:"50%", flexShrink:0,
                        background: opt.color,
                        border: accentId === opt.id ? `2px solid ${theme.text}` : "2px solid transparent",
                        outline: accentId === opt.id ? `1.5px solid ${opt.color}` : "none",
                        outlineOffset:"1px",
                        cursor:"pointer",
                        transform: accentId === opt.id ? "scale(1.25)" : "scale(1)",
                        transition:"transform 0.15s, border-color 0.15s",
                        padding:0,
                      }}/>
                  ))}
                </div>
              </div>

              {/* Mode chip in mobile user menu */}
              {isMobile && (
                <div style={{ padding:"8px 16px 0", borderBottom:`1px solid ${theme.border}` }}>
                  <div style={{ fontSize:10, fontWeight:700, textTransform:"uppercase",
                                 letterSpacing:"0.08em", color:theme.textDim, marginBottom:6 }}>
                    Apply Mode
                  </div>
                  {APPLY_MODES.map(m => (
                    <button key={m.value}
                      onClick={() => selectMode(m.value)}
                      onMouseEnter={e => e.currentTarget.style.background=theme.surfaceHigh}
                      onMouseLeave={e => e.currentTarget.style.background="transparent"}
                      style={{
                        ...menuItemStyle,
                        display:"flex", alignItems:"center", gap:8, padding:"6px 0",
                        background: "transparent",
                      }}>
                      <span style={{ fontWeight:700 }}>{m.icon} {m.label}</span>
                      {m.value === currentMode && <span style={{ color:theme.accent, fontWeight:700 }}>✓</span>}
                    </button>
                  ))}
                  {resumeWidget && (
                    <div style={{ paddingTop:8 }}>
                      <div style={{ fontSize:10, fontWeight:700, textTransform:"uppercase",
                                     letterSpacing:"0.08em", color:theme.textDim, marginBottom:6 }}>
                        Base Resume
                      </div>
                      <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                        <button
                          onClick={() => !resumeWidget.uploading && resumeWidget.onUploadClick?.()}
                          style={{
                            background:"transparent",
                            border:`1px solid ${resumeWidget.text ? "#16a34a44" : theme.border}`,
                            borderRadius:2, padding:"6px 10px", cursor:"pointer",
                            fontSize:11, flex:1,
                            color: resumeWidget.uploading ? "#d97706" : resumeWidget.text ? "#16a34a" : theme.textMuted,
                            fontFamily:"'DM Sans',system-ui",
                          }}>
                          {resumeWidget.uploading ? "⏳ Parsing…"
                            : resumeWidget.text
                              ? `✓ ${(resumeWidget.fileName||"").length>24 ? (resumeWidget.fileName||"").slice(0,24)+"…" : resumeWidget.fileName}`
                            : "📄 Upload Resume"}
                        </button>
                        {resumeWidget.text && !resumeWidget.uploading && (
                          <button onClick={() => resumeWidget.onClear?.()}
                            style={{ background:"none", border:"none", color:"#dc2626",
                                     cursor:"pointer", fontSize:12, padding:"4px 6px", flexShrink:0 }}>
                            ✕
                          </button>
                        )}
                      </div>
                      {resumeWidget.text && !resumeWidget.uploading && (
                        <div style={{ marginTop:8, paddingBottom:8 }}>
                          {!resumeWidget.enhanceUsed && (
                            <button
                              onClick={() => resumeWidget.onEnhance?.()}
                              disabled={resumeWidget.enhancing}
                              style={{
                                width:"100%", padding:"7px 10px", borderRadius:4,
                                background: resumeWidget.enhancing ? theme.surfaceHigh : theme.accentMuted,
                                color: theme.accentText, border:`1px solid ${theme.accent}44`,
                                cursor: resumeWidget.enhancing ? "not-allowed" : "pointer",
                                fontSize:11, fontWeight:700, fontFamily:"'DM Sans',system-ui",
                              }}>
                              {resumeWidget.enhancing ? "⏳ Rewriting…" : "✨ Enhance Resume"}
                            </button>
                          )}
                          {resumeWidget.enhanceUsed && !resumeWidget.enhancePaid && (
                            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                              <span style={{ fontSize:11, fontWeight:700, background:"#dcfce7", color:"#166534",
                                              padding:"3px 8px", borderRadius:999 }}>Enhanced ✓</span>
                              <a href="/pricing" style={{ fontSize:10, color:theme.textMuted, textDecoration:"none" }}>
                                Upgrade →
                              </a>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* API key */}
              <div style={{ padding:"10px 16px 12px", borderBottom:`1px solid ${theme.border}` }}>
                <div style={{ fontSize:10, fontWeight:700, textTransform:"uppercase",
                               letterSpacing:"0.08em", color:theme.textDim, marginBottom:4 }}>
                  Apify Token
                </div>
                <div style={{ fontSize:10, color:theme.textDim, marginBottom:6, lineHeight:1.5 }}>
                  Used by{" "}
                  <code style={{ fontSize:9, background:theme.surfaceHigh, padding:"1px 3px", borderRadius:2 }}>
                    harvestapi/linkedin-job-search
                  </code>{" "}to fetch jobs.
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  <input
                    value={tokenInput} onChange={e => setTokenInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && saveToken()}
                    placeholder="apify_api_…" type="password"
                    style={{
                      flex:1, height:32, padding:"0 10px",
                      border:`1px solid ${tokenInput && !tokenInput.startsWith("apify_api_") ? "#dc2626" : theme.border}`,
                      borderRadius:4,
                      background:theme.surface, color:theme.text,
                      fontSize:11, outline:"none",
                    }}/>
                  <button onClick={saveToken} disabled={tokenSaving}
                    style={{
                      background: tokenSaving ? theme.border : theme.accent,
                      color:"#0f0f0f", border:"none", borderRadius:4,
                      padding:"0 12px", cursor:"pointer", fontSize:11,
                      fontWeight:700, flexShrink:0,
                      transition:"border-radius 1s ease",
                    }}
                    onMouseEnter={e => e.currentTarget.style.borderRadius="999px"}
                    onMouseLeave={e => e.currentTarget.style.borderRadius="4px"}>
                    {tokenSaving ? "…" : "Save"}
                  </button>
                </div>
                {tokenInput && !tokenInput.startsWith("apify_api_") && (
                  <div style={{ fontSize:10, marginTop:4, color:"#d97706" }}>
                    ⚠ Token should start with apify_api_
                  </div>
                )}
                {tokenMsg && (
                  <div style={{ fontSize:10, marginTop:4,
                                 color: tokenMsg.startsWith("✓") ? "#16a34a" : "#dc2626" }}>
                    {tokenMsg}
                  </div>
                )}
              </div>

              {/* Sign out */}
              <button
                onClick={() => { setUserOpen(false); onLogout(); }}
                onMouseEnter={e => e.currentTarget.style.background=theme.dangerMuted||"#fef2f2"}
                onMouseLeave={e => e.currentTarget.style.background="transparent"}
                style={{ ...menuItemStyle, color:"#dc2626", fontWeight:600 }}>
                Sign Out
              </button>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
