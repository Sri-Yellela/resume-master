// REVAMP v2 — TopBar.jsx (shadcn UI integrated)
import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api }        from "../lib/api.js";
import { useTheme }   from "../styles/theme.jsx";
import { AtomEmblem } from "./AuthScreen.jsx";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel,
} from "./ui/dropdown-menu";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "./ui/popover";
import {
  Tooltip, TooltipContent, TooltipTrigger, TooltipProvider,
} from "./ui/tooltip";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { Separator } from "./ui/separator";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

const APPLY_MODES = [
  { value:"SIMPLE",         label:"Simple Apply",   icon:"⚡", desc:"Job board only — no generation",
    info:"Job board link only. No resume generation. Use this if you want to apply manually or already have a resume ready." },
  { value:"TAILORED",       label:"Tailored Apply",  icon:"✦", desc:"Rewrite bullets, fixed employers",
    info:"Rewrites your resume bullets to match the job description. Uses fixed employer names from a predefined map based on job category." },
  { value:"CUSTOM_SAMPLER", label:"Custom Sampler",  icon:"⚙", desc:"Full customisation, JD-driven companies",
    info:"Full customisation — rewrites your entire resume driven by the job description. Company names are pulled directly from the JD. Best ATS scores." },
];

// ── ThemeSwitcher ────────────────────────────────────────────
function ThemeSwitcher() {
  const { theme, themeName, setTheme, THEMES } = useTheme();
  const order = ["ember","aurora","forest","studio"];
  const next  = () => setTheme(order[(order.indexOf(themeName) + 1) % order.length]);
  const [hov, setHov] = useState(false);
  return (
    <div style={{ position:"relative", display:"flex", flexDirection:"column",
                  alignItems:"center", cursor:"pointer", gap:2 }}
      onClick={next}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      title={themeName}>
      <div style={{ width:16, height:16, borderRadius:"50%",
                    background:theme.colorPrimary,
                    transition:"background 0.3s ease",
                    boxShadow:`0 0 6px ${theme.colorPrimary}80` }}/>
      <span style={{ fontSize:9, color:theme.colorMuted, textTransform:"uppercase",
                     letterSpacing:"0.05em", lineHeight:1 }}>Theme</span>
      {hov && (
        <div style={{ position:"absolute", bottom:"calc(100% + 6px)",
                      background:theme.gradPanel, border:`1px solid ${theme.colorBorder}`,
                      borderRadius:6, padding:"3px 8px", fontSize:9,
                      color:theme.colorText, whiteSpace:"nowrap", zIndex:100 }}>
          {themeName}
        </div>
      )}
    </div>
  );
}

function ModeOption({ m, active, theme, onSelect, onInfo }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      style={{ display:"flex", alignItems:"flex-start", gap:10,
               background:hov ? theme.gradHover : active ? `rgba(0,0,0,0.2)` : "transparent",
               border:"none",
               borderLeft:active ? `3px solid ${theme.colorPrimary}` : "3px solid transparent",
               color:theme.colorText, fontSize:12, padding:"9px 12px",
               cursor:"pointer", width:"100%", textAlign:"left", boxSizing:"border-box" }}
      onClick={onSelect}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}>
      <span style={{ fontSize:14, flexShrink:0 }}>{m.icon}</span>
      <div style={{ flex:1, minWidth:0, overflow:"hidden" }}>
        <div style={{ fontWeight:700, color:theme.colorText, fontSize:12,
                      display:"flex", alignItems:"center", gap:3 }}>
          <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {m.label}
          </span>
          <span role="button" tabIndex={0}
            style={{ color:theme.colorMuted, cursor:"pointer", userSelect:"none",
                     flexShrink:0, fontSize:11, lineHeight:1, fontWeight:400 }}
            onClick={onInfo}
            onKeyDown={e => { if (e.key==="Enter"||e.key===" ") e.currentTarget.click(); }}
            title="More info">
            ⓘ
          </span>
        </div>
        <div style={{ fontSize:10, color:theme.colorMuted, marginTop:1,
                      whiteSpace:"normal", wordBreak:"break-word" }}>
          {m.desc}
        </div>
      </div>
      {active && <span style={{ color:theme.colorPrimary, fontWeight:900, flexShrink:0 }}>✓</span>}
    </button>
  );
}

function ApifyTokenRow({ theme }) {
  const [token,    setToken]    = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [busy,     setBusy]     = useState(false);

  useEffect(() => {
    api("/api/settings")
      .then(d => setHasToken(!!d.hasApifyToken))
      .catch(() => {});
  }, []);

  const save = async () => {
    const t = token.trim();
    if (!t) return;
    setBusy(true);
    try {
      await api("/api/settings/apify-token", { method:"PATCH", body:JSON.stringify({ token:t }) });
      setSaved(true); setHasToken(true); setToken("");
      setTimeout(() => setSaved(false), 2500);
    } catch(e) { alert("Failed to save token: " + e.message); }
    setBusy(false);
  };

  const clear = async () => {
    if (!confirm("Remove your Apify token? You won't be able to search for jobs until you add one again.")) return;
    setBusy(true);
    try {
      await api("/api/settings/apify-token", { method:"DELETE" });
      setHasToken(false); setToken("");
    } catch(e) { alert("Failed to clear token: " + e.message); }
    setBusy(false);
  };

  return (
    <div style={{ padding:"6px 12px 10px", boxSizing:"border-box", width:"100%" }}>
      <div style={{ fontSize:10, color:theme.colorMuted, marginBottom:5,
                    lineHeight:1.5, wordBreak:"break-word" }}>
        {hasToken
          ? <span style={{ color:"#86efac", fontWeight:700 }}>✓ Token saved</span>
          : <><span style={{ color:"#f87171", fontWeight:700 }}>Required</span> to search for jobs.</>
        }
        <br/>
        Get a free token at{" "}
        <a href="https://console.apify.com" target="_blank" rel="noreferrer"
           style={{ color:theme.colorPrimary, textDecoration:"none" }}>
          console.apify.com
        </a>{" "}→ Settings → Integrations.<br/>
        Subscribe to{" "}
        <span style={{ color:theme.colorAccent }}>curious_coder/linkedin-jobs-scraper</span>{" "}
        and <span style={{ color:theme.colorAccent }}>valig/indeed-jobs-scraper</span>.
      </div>
      <div style={{ display:"flex", gap:5, width:"100%", boxSizing:"border-box" }}>
        <Input type="password" value={token}
          onChange={e => setToken(e.target.value)}
          onKeyDown={e => e.key==="Enter" && save()}
          placeholder={hasToken ? "Paste new token to replace…" : "apify_api_…"}
          className="flex-1 min-w-0 h-8 text-xs bg-background border-border text-foreground"/>
        <Button size="sm" onClick={save} disabled={busy || !token.trim()}
          className="h-8 text-xs bg-primary text-primary-foreground hover:bg-primary/90 shrink-0 rounded-full"
          style={{ background:saved ? "#10b981" : undefined }}>
          {saved ? "✓" : busy ? "…" : "Save"}
        </Button>
        {hasToken && (
          <Button size="sm" variant="outline" onClick={clear} disabled={busy}
            className="h-8 text-xs shrink-0 rounded-full text-destructive border-destructive hover:bg-destructive/10"
            title="Remove saved token">✕</Button>
        )}
      </div>
    </div>
  );
}

function ModeInfoPopover({ rect, text, theme, onClose }) {
  const popRef = useRef();
  const maxWidth = 240;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = rect.right + 8;
  if (left + maxWidth > vw - 8) left = Math.max(8, rect.left - maxWidth - 8);
  let top = rect.top;
  if (top + 120 > vh - 8) top = Math.max(8, vh - 128);

  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    const onMD  = e => {
      if (popRef.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("keydown",   onKey);
    document.addEventListener("mousedown", onMD);
    return () => {
      document.removeEventListener("keydown",   onKey);
      document.removeEventListener("mousedown", onMD);
    };
  }, [onClose]);

  return (
    <div ref={popRef} style={{
      position:"fixed", top, left, maxWidth,
      background:theme.gradPanel, border:`1px solid ${theme.colorBorder}`,
      borderRadius:8, padding:"10px 12px",
      color:theme.colorMuted, fontSize:10, lineHeight:1.6,
      zIndex:10000, boxShadow:"0 8px 24px rgba(0,0,0,.6)",
      wordBreak:"break-word",
    }}>
      {text}
    </div>
  );
}

const SLabel = ({ children, theme }) => (
  <div style={{ fontSize:9, fontWeight:700, color:theme.colorMuted,
                letterSpacing:"0.8px", textTransform:"uppercase",
                padding:"8px 12px 4px" }}>
    {children}
  </div>
);

const Divider = ({ theme }) => (
  <div style={{ height:1, background:theme.colorBorder, margin:"4px 0" }}/>
);

function DItem({ icon, label, onClick, danger, theme }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      style={{ display:"flex", alignItems:"center", gap:8, width:"100%",
               background:hov ? theme.gradHover : "transparent",
               border:"none",
               color:danger ? "#f87171" : theme.colorText,
               fontSize:12, padding:"7px 12px", cursor:"pointer",
               textAlign:"left", boxSizing:"border-box",
               whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}>
      <span style={{ width:18, textAlign:"center", flexShrink:0 }}>{icon}</span>
      {label}
    </button>
  );
}

// ── Viewport-aware dropdown wrapper ───────────────────────────
function DropdownPortal({ anchorRef, open, onClose, align, children }) {
  const { theme } = useTheme();
  const [rect, setRect] = useState(null);

  useEffect(() => {
    if (!open || !anchorRef.current) return;
    setRect(anchorRef.current.getBoundingClientRect());
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const h = e => {
      if (anchorRef.current && !anchorRef.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open, anchorRef, onClose]);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const PREFERRED_W = align === "left" ? 272 : 216;
  const GAP = 6;
  const MARGIN = 8;

  let pos = null;
  if (rect) {
    const spaceBelow = vh - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    const openUp = spaceBelow < 260 && spaceAbove > spaceBelow;
    const maxH   = openUp ? Math.min(spaceAbove, vh - 32) : Math.min(spaceBelow, vh - 32);
    let left, width;
    if (align === "left") {
      left  = Math.max(MARGIN, Math.min(rect.left, vw - PREFERRED_W - MARGIN));
      width = Math.min(PREFERRED_W, vw - left - MARGIN);
    } else {
      const idealLeft = rect.right - PREFERRED_W;
      left  = Math.max(MARGIN, idealLeft);
      width = Math.min(PREFERRED_W, vw - left - MARGIN);
    }
    const top = openUp
      ? rect.top - GAP - Math.min(maxH, 9999)
      : rect.bottom + GAP;
    pos = { openUp, maxH, left, width, top, rect };
  }

  return (
    <AnimatePresence>
      {open && pos && (
        <motion.div
          key="dropdown"
          initial={{ opacity:0, y:-8, scale:0.97 }}
          animate={{ opacity:1, y:0, scale:1 }}
          exit={{ opacity:0, y:-8, scale:0.97 }}
          transition={{ duration:0.15 }}
          style={{
            position:"fixed",
            top:   pos.openUp ? "auto" : pos.top,
            bottom:pos.openUp ? vh - pos.rect.top + GAP : "auto",
            left:  pos.left,
            width: pos.width,
            maxHeight: pos.maxH,
            background: theme.gradPanel,
            border:`1px solid ${theme.colorBorder}`,
            borderRadius:12,
            boxShadow:"0 20px 60px rgba(0,0,0,.7)",
            zIndex:9999,
            overflowY:"auto",
            overflowX:"hidden",
            boxSizing:"border-box",
          }}
          onMouseDown={e => e.stopPropagation()}>
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default function TopBar({ user, activeTab, onTabChange, onLogout, onUserChange }) {
  const { theme } = useTheme();
  const [sandwichOpen, setSandwichOpen] = useState(false);
  const [profileOpen,  setProfileOpen]  = useState(false);
  const [mode,         setMode]         = useState(user?.applyMode || "TAILORED");
  const [savingMode,   setSavingMode]   = useState(false);
  const [modeInfo,     setModeInfo]     = useState(null);

  const sandwichRef = useRef();
  const profileRef  = useRef();

  const changeMode = async newMode => {
    setSavingMode(true);
    try {
      await api("/api/settings/apply-mode", { method:"PATCH", body:JSON.stringify({ mode:newMode }) });
      setMode(newMode);
      onUserChange?.({ ...user, applyMode:newMode });
    } catch {}
    setSavingMode(false);
  };

  const currentMode = APPLY_MODES.find(m => m.value === mode) || APPLY_MODES[1];

  const tabs = [
    { id:"jobs",     label:"Jobs"     },
    { id:"database", label:"Database" },
    ...(user?.isAdmin ? [{ id:"admin", label:"Admin" }] : []),
  ];

  return (
    <TooltipProvider>
      <>
        <header style={{ background:theme.gradPanel,
                         backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)",
                         borderBottom:`1px solid ${theme.colorBorder}`,
                         padding:"0 12px", height:52,
                         display:"flex", alignItems:"center", gap:8,
                         flexShrink:0, zIndex:100 }}>
          {/* Brand */}
          <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
            <AtomEmblem size={38} textSize={5.5} orbitSize={10}/>
            <span className="site-title" style={{ fontSize:24, letterSpacing:"0.5px",
                                                  whiteSpace:"nowrap" }}>
              Resume Master
            </span>
          </div>

          {/* Tabs */}
          <nav style={{ display:"flex", gap:2 }}>
            {tabs.map(t => (
              <button key={t.id}
                style={{ background:activeTab===t.id ? theme.colorPrimary : "transparent",
                         color:activeTab===t.id ? "#000" : theme.colorMuted,
                         border:"none", padding:"5px 16px", borderRadius:"999px",
                         cursor:"pointer", fontSize:12, fontWeight:700,
                         transition:"background 0.2s, color 0.2s" }}
                onClick={() => onTabChange(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>

          <div style={{ flex:1 }}/>

          {/* Theme switcher */}
          <ThemeSwitcher/>

          {/* Mode badge */}
          <div style={{ background:theme.colorSurface, color:theme.colorMuted,
                        fontSize:10, fontWeight:700, padding:"3px 10px", borderRadius:"999px",
                        border:`1px solid ${theme.colorBorder}`,
                        whiteSpace:"nowrap", flexShrink:0 }}>
            {savingMode ? "⏳" : currentMode.icon} {currentMode.label}
          </div>

          {/* Sandwich */}
          <div ref={sandwichRef} style={{ position:"relative" }}>
            <button style={{ background:"transparent", border:"none", cursor:"pointer",
                             padding:"6px 8px", borderRadius:"8px",
                             display:"flex", alignItems:"center" }}
              onClick={() => { setSandwichOpen(o => !o); setProfileOpen(false); }}
              title="Settings">
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                <span style={{ display:"block", width:18, height:2,
                               background:theme.colorMuted, borderRadius:2 }}/>
                <span style={{ display:"block", width:18, height:2,
                               background:theme.colorMuted, borderRadius:2 }}/>
                <span style={{ display:"block", width:18, height:2,
                               background:theme.colorMuted, borderRadius:2 }}/>
              </div>
            </button>
          </div>

          {/* Avatar */}
          <div ref={profileRef} style={{ position:"relative" }}>
            <Avatar className="w-9 h-9 cursor-pointer ring-2 ring-primary"
              onClick={() => { setProfileOpen(o => !o); setSandwichOpen(false); }}
              title={user?.username}>
              <AvatarFallback className="bg-primary text-primary-foreground font-black text-sm">
                {(user?.username || "U")[0].toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </div>
        </header>

        {/* ── Sandwich dropdown ── */}
        <DropdownPortal anchorRef={sandwichRef} open={sandwichOpen}
          onClose={() => setSandwichOpen(false)} align="left">
          <SLabel theme={theme}>Apply Mode</SLabel>
          {APPLY_MODES.map(m => (
            <ModeOption key={m.value} m={m} active={mode === m.value}
              theme={theme}
              onSelect={() => { changeMode(m.value); setSandwichOpen(false); }}
              onInfo={e => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                setModeInfo(modeInfo?.value === m.value ? null : { value:m.value, rect });
              }}/>
          ))}
          <Divider theme={theme}/>
          <SLabel theme={theme}>API Keys</SLabel>
          <ApifyTokenRow theme={theme}/>
          <Divider theme={theme}/>
          <SLabel theme={theme}>Job Refresh</SLabel>
          <DItem theme={theme} icon="🔄" label="View Refresh Quota" onClick={async () => {
            setSandwichOpen(false);
            const q = await api("/api/scrape/quota");
            alert(`Refreshes used today: ${q.used} / 4\nRemaining: ${q.remaining}${
              q.windowEnds ? `\nResets: ${new Date(q.windowEnds*1000).toLocaleString()}` : ""}`);
          }}/>
        </DropdownPortal>

        {/* ── Mode info popover ── */}
        {modeInfo && (
          <ModeInfoPopover theme={theme}
            rect={modeInfo.rect}
            text={APPLY_MODES.find(m => m.value === modeInfo.value)?.info}
            onClose={() => setModeInfo(null)}
          />
        )}

        {/* ── Avatar dropdown ── */}
        <DropdownPortal anchorRef={profileRef} open={profileOpen}
          onClose={() => setProfileOpen(false)} align="right">
          <div style={{ padding:"10px 12px 6px" }}>
            <div style={{ color:theme.colorText, fontWeight:700, fontSize:13,
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {user?.username}
            </div>
            <div style={{ fontSize:10, color:theme.colorMuted, marginTop:2 }}>
              {user?.isAdmin ? "Administrator" : "User"} · {currentMode.label}
            </div>
          </div>
          <Divider theme={theme}/>
          <DItem theme={theme} icon="👤" label="Edit Profile"
            onClick={() => { onTabChange("profile"); setProfileOpen(false); }}/>
          {user?.isAdmin && (
            <DItem theme={theme} icon="🛡" label="Admin Panel"
              onClick={() => { onTabChange("admin"); setProfileOpen(false); }}/>
          )}
          <Divider theme={theme}/>
          <DItem theme={theme} icon="🚪" label="Sign out" onClick={onLogout} danger/>
        </DropdownPortal>
      </>
    </TooltipProvider>
  );
}
