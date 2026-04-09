// client/src/components/TopBar.jsx — Design System v4
import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { AtomEmblem } from "./AuthScreen.jsx";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel,
} from "./ui/dropdown-menu";
import { Avatar, AvatarFallback } from "./ui/avatar";

const APPLY_MODES = [
  { value:"SIMPLE",         label:"Simple",         icon:"⚡", desc:"Job board only — no generation" },
  { value:"TAILORED",       label:"Tailored",        icon:"✦", desc:"Rewrite bullets, fixed employers" },
  { value:"CUSTOM_SAMPLER", label:"Custom Sampler",  icon:"⚙", desc:"Full customisation, JD-driven companies" },
];

// Light/Dark toggle
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
        position: "absolute",
        top: 3, left: mode === "dark" ? 27 : 3,
        width: 22, height: 22, borderRadius: "50%",
        background: "white",
        boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
        transition: "left 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)",
      }}/>
    </button>
  );
}

const TABS = [
  { id:"jobs",     label:"Jobs"     },
  { id:"database", label:"Database" },
  { id:"profile",  label:"Profile"  },
];

export default function TopBar({ user, activeTab, onTabChange, onLogout, onUserChange }) {
  const { theme, mode } = useTheme();
  const [tokenInput,   setTokenInput]   = useState("");
  const [tokenSaving,  setTokenSaving]  = useState(false);
  const [tokenMsg,     setTokenMsg]     = useState("");

  const currentMode = user?.applyMode || "TAILORED";
  const modeObj = APPLY_MODES.find(m => m.value === currentMode) || APPLY_MODES[1];

  const selectMode = async (val) => {
    try {
      const d = await api("/api/settings/apply-mode", { method:"PATCH", body:JSON.stringify({ mode:val }) });
      if (onUserChange) onUserChange(u => ({ ...u, applyMode: val }));
    } catch {}
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

  const tabs = [...TABS, ...(user?.isAdmin ? [{ id:"admin", label:"Admin" }] : [])];

  return (
    <div style={{
      height: 56,
      background: mode === "light" ? "rgba(255,255,255,0.92)" : "rgba(17,17,17,0.92)",
      backdropFilter: "blur(20px) saturate(180%)",
      WebkitBackdropFilter: "blur(20px) saturate(180%)",
      borderBottom: `1px solid ${theme.border}`,
      display: "flex", alignItems: "center",
      padding: "0 20px", gap: 24,
      position: "sticky", top: 0, zIndex: 100,
      flexShrink: 0,
    }}>
      {/* Brand */}
      <div style={{ display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
        <AtomEmblem size={28} textSize={4} orbitSize={9}/>
        <span className="site-title">Resume Master</span>
      </div>

      {/* Nav tabs */}
      <nav style={{ display:"flex", alignItems:"center", gap:4, flex:1 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => onTabChange(t.id)}
            style={{
              background: "transparent", border: "none",
              padding: "6px 14px", borderRadius: 8,
              fontWeight: activeTab === t.id ? 700 : 500,
              fontSize: 13,
              color: activeTab === t.id ? theme.accent : theme.textMuted,
              cursor: "pointer", position: "relative",
              transition: "color 0.15s",
            }}>
            {t.label}
            {activeTab === t.id && (
              <motion.div layoutId="tab-underline"
                style={{
                  position: "absolute", bottom: -1, left: "50%",
                  transform: "translateX(-50%)",
                  width: 16, height: 2,
                  borderRadius: 999,
                  background: theme.accent,
                }}/>
            )}
          </button>
        ))}
      </nav>

      {/* Right side controls */}
      <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
        {/* Theme toggle */}
        <ThemeToggle/>

        {/* Mode chip */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button style={{
              display:"flex", alignItems:"center", gap:5,
              background: theme.accentMuted, color: theme.accentText,
              border: `1px solid ${theme.accent}33`,
              borderRadius: 999, padding:"4px 12px",
              fontSize: 11, fontWeight: 700, cursor:"pointer",
            }}>
              <span>{modeObj.icon}</span>
              <span>{modeObj.label}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" style={{ borderRadius:16, minWidth:220 }}>
            <DropdownMenuLabel style={{ fontSize:10, letterSpacing:"0.1em", textTransform:"uppercase", padding:"8px 16px", color:theme.textDim }}>Apply Mode</DropdownMenuLabel>
            {APPLY_MODES.map(m => (
              <DropdownMenuItem key={m.value} onClick={() => selectMode(m.value)}
                style={{ display:"flex", gap:10, padding:"10px 16px", cursor:"pointer",
                         background: m.value===currentMode ? theme.accentMuted : "transparent" }}>
                <span style={{ fontWeight:700, fontSize:13 }}>{m.icon} {m.label}</span>
                {m.value===currentMode && <span style={{ marginLeft:"auto", color:theme.accent }}>✓</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Hamburger menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button style={{
              width:36, height:36, borderRadius:999,
              background:"transparent", border:`1px solid ${theme.border}`,
              cursor:"pointer", fontSize:16, color:theme.text,
              display:"flex", alignItems:"center", justifyContent:"center",
              transition:"all 0.15s",
            }}>☰</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" style={{ borderRadius:16, minWidth:260, padding:"8px 0" }}>
            <DropdownMenuLabel style={{ fontSize:10, letterSpacing:"0.1em", textTransform:"uppercase", padding:"8px 16px", color:theme.textDim }}>API Keys</DropdownMenuLabel>
            <div style={{ padding:"8px 16px 12px" }}>
              <div style={{ fontSize:11, color:theme.textMuted, marginBottom:6 }}>Apify Token (for job scraping)</div>
              <div style={{ display:"flex", gap:6 }}>
                <input value={tokenInput} onChange={e=>setTokenInput(e.target.value)}
                  placeholder="apify_api_…" type="password"
                  className="rm-input" style={{ flex:1, height:34, fontSize:11 }}/>
                <button onClick={saveToken} disabled={tokenSaving}
                  className="rm-btn rm-btn-primary rm-btn-sm" style={{ flexShrink:0 }}>
                  {tokenSaving ? "…" : "Save"}
                </button>
              </div>
              {tokenMsg && <div style={{ fontSize:10, marginTop:4, color:theme.success }}>{tokenMsg}</div>}
            </div>
            <DropdownMenuSeparator/>
            <DropdownMenuItem onClick={onLogout} style={{ padding:"10px 16px", cursor:"pointer", color:theme.danger }}>
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Avatar */}
        <Avatar style={{ width:36, height:36, cursor:"pointer", border:`2px solid ${theme.border}` }}>
          <AvatarFallback style={{ background:theme.accent, color:"white", fontWeight:700, fontSize:13 }}>
            {(user?.username||"U")[0].toUpperCase()}
          </AvatarFallback>
        </Avatar>
      </div>
    </div>
  );
}
