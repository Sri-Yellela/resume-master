// client/src/panels/JobsPanel.jsx â€" Lucy Brand, shared job pool
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { api, printResume, dislikeJob, authHeaders, authContextQuery } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { useViewport } from "../hooks/useViewport.js";
import JobCard from "../components/JobCard.jsx";
import JobDetailPanel from "../components/JobDetailPanel.jsx";
import SandboxPanel from "./SandboxPanel.jsx";
import { ATSPanel } from "./ATSPanel.jsx";
import DomainProfileWizard from "../components/DomainProfileWizard.jsx";
import ProfileSelectorDropdown from "../components/ProfileSelectorDropdown.jsx";
import { useSyncEvents } from "../hooks/useSyncEvents.js";
import { useAppScroll } from "../contexts/AppScrollContext.jsx";
import { useJobBoard } from "../contexts/JobBoardContext.jsx";
import { toast } from "../hooks/use-toast.js";
import ROLE_ALIAS_MAP from "../../../data/ROLE_ALIAS_MAP.json";

// The three extension-bridge stubs that stood here (getLinkedInExtensionInstallUrl,
// isLinkedInExtensionInstalled, sendExtensionRequest) are gone with cleanup 5.3. They returned
// null / false / an empty promise, which meant every caller was unreachable or a no-op while
// still presenting working-looking UI. The extension integration that remains is the SINGLE-job
// capture, which talks to the server over HTTP and needs no in-page bridge at all.

// Normalizes the new /api/jobs aggregator field names to the shape
// the rest of JobsPanel and JobCard expect (legacy camelCase fields).
function normalizeApiJob(job) {
  return {
    ...job,
    jobId:          job.jobId          ?? job.id,
    applyUrl:       job.applyUrl       ?? job.url,
    postedAt:       job.postedAt       ?? job.posted_at,
    salaryMin:      job.salaryMin      != null ? job.salaryMin      : (job.salary_min  ?? null),
    salaryMax:      job.salaryMax      != null ? job.salaryMax      : (job.salary_max  ?? null),
    salaryCurrency: job.salaryCurrency ?? job.salary_currency ?? null,
    workType:       job.workType       ?? (job.remote === true ? "Remote" : job.remote === false ? "On-site" : null),
    employmentType: job.employmentType ?? job.contract_type ?? null,
    // mapJobRow already emits camelCase automationTier and the `...job` spread above would carry
    // it through untouched — this line is here for the endpoints that hand this function a raw
    // row rather than a mapped one (the poll feed), so the card gets the same field either way.
    // null stays null: JobCard's TierChip renders null exactly as it renders 'unknown'.
    automationTier: job.automationTier ?? job.automation_tier ?? null,
  };
}

const USER_TEXT   = "#0f0f0f";   // black text on accent
const PROFILE_UI_CACHE_KEY = "rm_jobs_profile_ui_v1";

function readProfileUiCache(profileId) {
  if (profileId == null) return null;
  try {
    const all = JSON.parse(localStorage.getItem(PROFILE_UI_CACHE_KEY) || "{}");
    return all[String(profileId)] || null;
  } catch { return null; }
}

function writeProfileUiCache(profileId, snapshot) {
  if (profileId == null || !snapshot) return;
  try {
    const all = JSON.parse(localStorage.getItem(PROFILE_UI_CACHE_KEY) || "{}");
    // The persisted key set is DERIVED from defaultFilterSnapshot() plus the four non-filter board
    // keys, instead of being spelled out. It used to be a hand-written list of 15 names that stopped
    // at ageFilter, so every filter added after it — salary, work models, experience levels, skills,
    // sponsor-friendly, providers, tiers — was silently dropped on reload: the board came back
    // unfiltered while the drawer had claimed the filter was applied.
    const persisted = { cachedAt: Date.now() };
    for (const key of ["boardTab", "localSearch", "sortBy", "currentPage",
                       ...Object.keys(defaultFilterSnapshot())]) {
      persisted[key] = snapshot[key];
    }
    all[String(profileId)] = persisted;
    localStorage.setItem(PROFILE_UI_CACHE_KEY, JSON.stringify(all));
  } catch {}
}

// Upstream scrape requests are profile-driven on the server.
// Board UI filters stay local to /api/jobs and must not shape /api/scrape.
// The request builder that used to carry that rule is gone (§5.12): /api/scrape has returned
// HTTP 410 since external scraping was removed, and this client never posts to it, so the builder
// had no call site left. The rule is kept here as a constraint on anyone re-adding an outbound
// path — the server derives it from the profile; board filters stay out of it.

// â"€â"€ Helpers â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// FE-2: mirrors server.js's own AGE_MAP for the /api/jobs handler's ageFilter — used to derive
// posted_after client-side from the SAME named interval, without a second UI control.
const AGE_DAYS_MAP = { "1d": 1, "2d": 2, "3d": 3, "1w": 7, "1m": 30 };

function ago(ts) {
  if (!ts) return "-";
  const d = Date.now() - new Date(ts).getTime();
  if (d < 3600000)  return `${Math.floor(d/60000)}m`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h`;
  return `${Math.floor(d/86400000)}d`;
}

// â"€â"€ LinkedIn "in" logo (inline SVG) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const GENERATE_TOOL = "generate";
const A_PLUS_TOOL = "a_plus_resume";
const TOOL_LABELS = { [GENERATE_TOOL]: "Generate", [A_PLUS_TOOL]: "A+ Resume" };

function normalizeTool(tool) {
  return tool === A_PLUS_TOOL ? A_PLUS_TOOL : GENERATE_TOOL;
}

function getActiveArtifact(entry, tool) {
  if (!entry) return null;
  const selected = normalizeTool(tool || entry.activeTool || entry.tool);
  return entry.variants?.[selected] || entry;
}

function mergeArtifact(entry, artifact) {
  const tool = normalizeTool(artifact.tool);
  const variants = { ...(entry?.variants || {}) };
  if (entry?.html && entry.html !== "__exists__" && entry.tool) {
    variants[normalizeTool(entry.tool)] = { ...entry, variants: undefined };
  }
  variants[tool] = { ...artifact, variants: undefined, activeTool: tool };
  return { ...artifact, variants, activeTool: tool };
}

function buildArtifact(job, data, tool) {
  const t = normalizeTool(data?.tool || tool);
  return {
    html: data.html,
    atsScore: data.atsScore ?? data.ats_score,
    atsReport: data.atsReport,
    company: data.company || job.company,
    title: data.title || data.role || job.title,
    jobId: job.jobId,
    jobUrl: job.url,
    source: job.source,
    location: job.location,
    tool: t,
    toolLabel: data.toolLabel || TOOL_LABELS[t],
    version: data.version || null,
    status: "success",
    // Company KB failsafe gate (Task 9.6) — additive; [] when the backend has nothing to say
    // (the common case), so SandboxPanel renders nothing extra for most generations.
    kbFindings: data.kbFindings || [],
  };
}

function LinkedInLogo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-label="LinkedIn" role="img">
      <rect width="20" height="20" rx="3" fill="#0A66C2"/>
      <text x="4" y="15" fontFamily="Georgia,serif" fontWeight="900" fontSize="13" fill="#fff">in</text>
    </svg>
  );
}

// â"€â"€ Indeed logo (inline SVG) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function IndeedLogo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-label="Indeed" role="img">
      <rect width="20" height="20" rx="3" fill="#003A9B"/>
      <circle cx="10" cy="8" r="3" fill="#fff"/>
      <rect x="7.5" y="11" width="5" height="6" rx="1" fill="#fff"/>
    </svg>
  );
}

// â"€â"€ Platform logo dispatcher â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function PlatformLogo({ platform, size = 20, theme }) {
  const p = (platform || "").toLowerCase();
  if (p === "linkedin") return <LinkedInLogo size={size}/>;
  if (p === "indeed")   return <IndeedLogo size={size}/>;
  return <span style={{ fontSize:size*0.5, color:theme?.textMuted||"#888" }}>◆</span>;
}

// â"€â"€ Company icon with monogram fallback â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function CompanyIcon({ company, iconUrl, size = 48 }) {
  const [failed, setFailed] = useState(false);
  const letter = (company || "?")[0].toUpperCase();
  // Deterministic color from company name
  const colors = ["#0A66C2","#7c3aed","#0891b2","#16a34a","#dc2626","#d97706","#9333ea"];
  let hash = 0;
  for (const c of company || "") hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  const bg = colors[hash % colors.length];

  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt={company}
        onError={() => setFailed(true)}
        style={{
          width:size, height:size, borderRadius:10,
          objectFit:"contain", border:"1px solid transparent",
          background:"transparent", flexShrink:0,
        }}
      />
    );
  }
  return (
    <div style={{
      width:size, height:size, borderRadius:10,
      background:bg, color:"#fff",
      display:"flex", alignItems:"center", justifyContent:"center",
      fontWeight:800, fontSize:Math.round(size*0.38), flexShrink:0,
      letterSpacing:"-0.5px",
    }}>
      {letter}
    </div>
  );
}

// â"€â"€ Work type badge â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function WorkBadge({ t, theme }) {
  // Use semantic colors that work in both light/dark â€" the fg/bg are theme tokens
  const map = {
    Remote: { bg:"#e8f6fb", fg:"#1a6a8a" },
    Hybrid: { bg:"#f0f9ff", fg:"#0284c7" },
  };
  const s = map[t] || null;
  if (s) {
    return (
      <span style={{ background:s.bg, color:s.fg, padding:"2px 8px",
                     borderRadius:999, fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
        {t}
      </span>
    );
  }
  return (
    <span style={{ background:theme?.surfaceHigh, color:theme?.textMuted, padding:"2px 8px",
                   borderRadius:999, fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
      {t || "-"}
    </span>
  );
}

// â"€â"€ ATS badge â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function ATSBadge({ score, onClick }) {
  if (score == null) return null;
  const bg = score>=80 ? "#dcfce7" : score>=60 ? "#fef9c3" : "#fee2e2";
  const fg = score>=80 ? "#166534" : score>=60 ? "#854d0e" : "#991b1b";
  return (
    <span
      onClick={onClick ? e => { e.stopPropagation(); onClick(); } : undefined}
      style={{ background:bg, color:fg, padding:"2px 8px",
               borderRadius:999, fontSize:10, fontWeight:700,
               cursor: onClick ? "pointer" : "default",
               border: onClick ? `1px solid ${fg}33` : "none" }}>
      ATS {score}
    </span>
  );
}

// â"€â"€ Resume badge â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function ResumeBadge({ onClick, loading }) {
  return (
    <span
      onClick={onClick ? e => { e.stopPropagation(); onClick(); } : undefined}
      style={{ background:"#e8f6fb", color:"#1a6a8a", padding:"2px 8px",
               borderRadius:999, fontSize:10, fontWeight:700,
               cursor:"pointer", border:"1px solid #A8D8EA44",
               display:"inline-flex", alignItems:"center", gap:3 }}>
      {loading ? "Loading" : "Resume"}
    </span>
  );
}

// â"€â"€ Lucy button (rectangular â†' pill on hover, 1s) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function LucyBtn({ children, onClick, disabled, accent: accentProp,
                    style = {}, title }) {
  const [hov, setHov] = useState(false);
  const { theme } = useTheme();
  const accent = accentProp || theme.accent;
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      onMouseEnter={() => !disabled && setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        // Water-fill: gradient fills upward from bottom over 1s
        backgroundImage: `linear-gradient(to top, ${accent}, ${accent})`,
        backgroundSize: hov && !disabled ? "100% 100%" : "100% 0%",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "bottom",
        backgroundColor: "transparent",
        color: theme.text,
        border: `2.5px solid ${hov && !disabled ? accent : theme.borderStrong}`,
        cursor: disabled ? "not-allowed" : "pointer",
        padding: "7px 18px", fontWeight: 800, fontSize: 12,
        fontFamily: "'Barlow Condensed','DM Sans',sans-serif",
        letterSpacing: "0.1em", textTransform: "uppercase",
        borderRadius: hov && !disabled ? 999 : 2,
        transition: "background-size 1s ease, border-radius 1s ease, border-color 1s ease",
        whiteSpace: "nowrap", flexShrink: 0,
        opacity: disabled ? 0.4 : 1,
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
        ...style,
      }}>
      {children}
    </button>
  );
}

// â"€â"€ Icon button â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function IconBtn({ bg, onClick, title, children, disabled = false, size = 28 }) {
  const [hov, setHov] = useState(false);
  const { theme } = useTheme();
  return (
    <button title={title} disabled={disabled} onClick={onClick}
      onMouseEnter={() => !disabled && setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width:size, height:size, borderRadius:999,
        background: disabled ? theme.surfaceHigh : hov ? bg : theme.surfaceHigh,
        border:`1px solid ${disabled ? theme.border : hov ? bg+"44" : theme.border}`,
        display:"flex", alignItems:"center", justifyContent:"center",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize:12, color: hov && !disabled ? "white" : theme.textMuted,
        opacity: disabled ? 0.4 : 1,
        transition:"all 0.15s ease", flexShrink:0,
        transform: hov && !disabled ? "scale(1.1)" : "scale(1)",
      }}>
      {children}
    </button>
  );
}

const EMP_TYPE_OPTIONS = [
  { value:"full-time",  label:"Full-time" },
  { value:"contract",   label:"Contract"  },
  { value:"internship", label:"Internship"},
  { value:"part-time",  label:"Part-time" },
];

// jobQuery.js's work_models dimension (sj.workplace_type — the Task-5 ENRICHMENT column). This is
// now the only work-location control: the legacy single-select over sj.work_type was removed because
// no write path populates that column, and this one filters the column enrichment actually fills.
const WORK_MODEL_OPTIONS = [
  { value:"remote", label:"Remote" },
  { value:"hybrid", label:"Hybrid" },
  { value:"onsite", label:"Onsite" },
];

// FE-2: jobQuery.js's experience_levels dimension (sj.experience_level — the profile-bridge's
// derived default; an explicit selection here overrides it, per server.js's per-key merge).
const EXPERIENCE_LEVEL_OPTIONS = [
  { value:"intern",    label:"Intern" },
  { value:"entry",     label:"Entry" },
  { value:"mid",       label:"Mid" },
  { value:"senior",    label:"Senior" },
  { value:"lead",      label:"Lead" },
  { value:"executive", label:"Executive" },
];

// Provider (scraped_jobs.source) options for the include/exclude control. Mirrors the vocabulary
// the writers actually emit — the same "UI options duplicate the server's vocabulary" idiom as
// WORK_MODEL_OPTIONS / EXPERIENCE_LEVEL_OPTIONS above, deliberately NOT an import of the server
// module. The counts beside each come from jobQuery.js's `sources` facet at runtime, so a provider
// with 0 rows shows "(0)" rather than being silently absent.
const SOURCE_OPTIONS = [
  { value:"greenhouse", label:"Greenhouse" },
  { value:"lever",      label:"Lever"      },
  { value:"ashby",      label:"Ashby"      },
  { value:"jobo",       label:"Jobo"       },
  { value:"adzuna",     label:"Adzuna"     },
  { value:"serpapi",    label:"SerpAPI"    },
  { value:"LinkedIn",   label:"LinkedIn"   },
];

// Automation tier (services/jobs/automationTier.js). Order is decreasing confidence, matching the
// module's AUTOMATION_TIERS. The descriptions are the point of this control: "account" is the one
// that changes what the user has to do, and "unknown" must read as an open question rather than
// as either a promise or a warning.
const TIER_OPTIONS = [
  { value:"direct",  label:"Direct",   hint:"No account — one-page apply" },
  { value:"guest",   label:"Guest",    hint:"Account optional, guest path exists" },
  { value:"account", label:"Account",  hint:"You sign in once, then autofill takes over" },
  { value:"gated",   label:"Gated",    hint:"Account + CAPTCHA/ID check — cannot be automated" },
  { value:"unknown", label:"Unknown",  hint:"Not established — may be either" },
];

function defaultFilterSnapshot() {
  return {
    roleFilter: "",
    locationFilter: "",
    workType: "",
    employmentTypePrefs: ["full-time"],
    catFilter: "",
    srcFilter: "",
    minYoe: "",
    maxYoe: "",
    maxApplicants: "",
    visitedFilter: "",
    ageFilter: "",
    // FE-2: Task-4 filter vocabulary + the profile-bridge visa preference override.
    salaryMin: "",
    salaryMax: "",
    workModels: [],
    experienceLevels: [],
    skillsInclude: [],
    sponsorFriendly: false,
    // Provider + automation-tier include/exclude. Empty arrays are the default-off state: buildParams
    // emits nothing at all for them, which is what keeps the default querystring byte-identical.
    sourcesInclude: [],
    sourcesExclude: [],
    tiersInclude: [],
    tiersExclude: [],
  };
}

// â"€â"€ Filters panel (collapsible) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function FiltersPanel({
  open, onClose, onApply,
  categories,
  role, setRole,
  location, setLocation,
  workType, setWorkType,
  employmentTypePrefs, setEmploymentTypePrefs,
  catFilter, setCatFilter,
  srcFilter, setSrcFilter,
  minYoe, setMinYoe,
  maxYoe, setMaxYoe,
  maxApplicants, setMaxApplicants,
  visitedFilter, setVisitedFilter,
  ageFilter, setAgeFilter,
  salaryMin, setSalaryMin,
  salaryMax, setSalaryMax,
  workModels, setWorkModels,
  experienceLevels, setExperienceLevels,
  skillsInclude, setSkillsInclude,
  sponsorFriendly, setSponsorFriendly,
  sourcesInclude, setSourcesInclude,
  sourcesExclude, setSourcesExclude,
  tiersInclude, setTiersInclude,
  tiersExclude, setTiersExclude,
  facetCounts,
  onReset,
}) {
  const { theme } = useTheme();
  const [skillDraft, setSkillDraft] = useState("");
  if (!open) return null;

  // FE-2: opt-in facet counts (services/jobs/jobQuery.js's FACET_DIMENSIONS) — only present
  // when the panel has fetched them; a control renders with no count suffix until then.
  const countFor = (dimension, value) => {
    const rows = facetCounts?.[dimension];
    if (!rows) return null;
    const hit = rows.find(r => String(r.value).toLowerCase() === String(value).toLowerCase());
    return hit ? hit.count : null;
  };
  const withCount = (label, count) => (count != null ? `${label} (${count})` : label);

  // Tri-state pill: neutral -> include -> exclude -> neutral. One control per option instead of
  // two parallel lists, because "greenhouse is in both include and exclude" is a state the user
  // can otherwise reach and the server cannot answer sensibly. Include and exclude are therefore
  // mutually exclusive by construction here, not by validation after the fact.
  const IncludeExcludeRow = ({ options, dimension, included, setIncluded, excluded, setExcluded }) => (
    <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
      {options.map(opt => {
        const isIn  = included.includes(opt.value);
        const isOut = excluded.includes(opt.value);
        const cycle = () => {
          if (isIn) {                                   // include -> exclude
            setIncluded(included.filter(v => v !== opt.value));
            setExcluded([...excluded, opt.value]);
          } else if (isOut) {                           // exclude -> neutral
            setExcluded(excluded.filter(v => v !== opt.value));
          } else {                                      // neutral -> include
            setIncluded([...included, opt.value]);
          }
        };
        const border = isIn ? theme.accent : isOut ? "#dc2626" : theme.border;
        const bg     = isIn ? theme.accentMuted : isOut ? "#fee2e2" : "transparent";
        const fg     = isIn ? theme.accentText : isOut ? "#991b1b" : theme.textMuted;
        return (
          <button key={opt.value} type="button" onClick={cycle}
            title={[opt.hint, isIn ? "Included — click to exclude" : isOut ? "Excluded — click to clear" : "Click to include"]
              .filter(Boolean).join(" · ")}
            style={{
              padding:"5px 12px", borderRadius:999, fontSize:11, fontWeight:600,
              cursor:"pointer", border:`1px solid ${border}`, background:bg, color:fg,
              transition:"all 0.15s", textDecoration: isOut ? "line-through" : "none",
            }}>
            {isOut ? "− " : isIn ? "+ " : ""}
            {withCount(opt.label, dimension ? countFor(dimension, opt.value) : null)}
          </button>
        );
      })}
    </div>
  );

  const selStyle = {
    width:"100%", height:36, padding:"0 10px",
    border:`1px solid ${theme.border}`, borderRadius:4,
    background:theme.surface, color:theme.text, fontSize:12, outline:"none",
  };
  const labelStyle = { fontSize:11, fontWeight:700, color:theme.textMuted,
                        textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 };
  return (
    <div style={{
      position:"fixed", inset:0, zIndex:500,
      display:"flex", alignItems:"flex-start", justifyContent:"flex-end",
      background:"rgba(0,0,0,0.42)",
      isolation:"isolate",
    }}
    onClick={e => { if(e.target===e.currentTarget) onClose(); }}>
      <motion.div
        initial={{ x:360 }} animate={{ x:0 }} exit={{ x:360 }}
        transition={{ type:"tween", duration:0.22 }}
        style={{
          width:320, height:"100%", background:theme.modalSurface || "#111827",
          borderLeft:`3px solid ${theme.accent}`,
          padding:"24px 20px", overflowY:"auto",
          display:"flex", flexDirection:"column", gap:16,
          boxShadow:theme.shadowXl || "-12px 0 36px rgba(0,0,0,0.24)",
        }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                          fontSize:20, letterSpacing:"0.06em", textTransform:"uppercase" }}>
            Filters
          </span>
          <button onClick={onClose} style={{ background:"none", border:"none",
                                             cursor:"pointer", fontSize:18, color:theme.textMuted }}>x</button>
        </div>

        <div>
          <div style={labelStyle}>Role</div>
          <input value={role} onChange={e=>setRole(e.target.value)}
            placeholder="e.g. Software Engineer"
            style={{...selStyle, padding:"0 10px", height:36, borderRadius:4}}/>
        </div>

        <div>
          <div style={labelStyle}>Location</div>
          <input value={location} onChange={e=>setLocation(e.target.value)}
            placeholder="e.g. San Francisco"
            style={{...selStyle, padding:"0 10px", height:36, borderRadius:4}}/>
        </div>

        {/* Work Type (sj.work_type) removed: no write path populates that column — it is absent
            from aggregator's upsertStmt, the single writer shared by cacheJobs, cacheJoboFeed and
            importJob — so the control could never change the result set. "Work Model" below filters
            sj.workplace_type, which enrichment DOES populate (remote/hybrid/onsite all non-zero on
            a real board), and covers the same intent. The workType PARAM is still honoured by
            /api/jobs, soft-null, so saved searches and API callers are unaffected. */}

        <div>
          <div style={labelStyle}>Employment Type</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            {EMP_TYPE_OPTIONS.map(opt => {
              const active = employmentTypePrefs.includes(opt.value);
              return (
                <button key={opt.value}
                  type="button"
                  onClick={() => {
                    const next = active
                      ? employmentTypePrefs.filter(v => v !== opt.value)
                      : [...employmentTypePrefs, opt.value];
                    // Always keep at least one selected
                    if (next.length > 0) setEmploymentTypePrefs(next);
                  }}
                  style={{
                    padding:"5px 12px", borderRadius:999, fontSize:11, fontWeight:600,
                    cursor:"pointer", border:`1px solid ${active ? theme.accent : theme.border}`,
                    background: active ? theme.accentMuted : "transparent",
                    color: active ? theme.accentText : theme.textMuted,
                    transition:"all 0.15s",
                  }}>
                  {withCount(opt.label, countFor("employment_type", opt.value))}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div style={labelStyle}>Work Model</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            {WORK_MODEL_OPTIONS.map(opt => {
              const active = workModels.includes(opt.value);
              return (
                <button key={opt.value}
                  type="button"
                  onClick={() => setWorkModels(active
                    ? workModels.filter(v => v !== opt.value)
                    : [...workModels, opt.value])}
                  style={{
                    padding:"5px 12px", borderRadius:999, fontSize:11, fontWeight:600,
                    cursor:"pointer", border:`1px solid ${active ? theme.accent : theme.border}`,
                    background: active ? theme.accentMuted : "transparent",
                    color: active ? theme.accentText : theme.textMuted,
                    transition:"all 0.15s",
                  }}>
                  {withCount(opt.label, countFor("work_model", opt.value))}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize:10, color:theme.textDim, marginTop:4 }}>
            Remote / hybrid / onsite as tagged by enrichment. Postings not yet tagged are kept
            rather than hidden, so coverage may lag for very recently-crawled jobs.
          </div>
        </div>

        <div>
          <div style={labelStyle}>Experience Level</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            {EXPERIENCE_LEVEL_OPTIONS.map(opt => {
              const active = experienceLevels.includes(opt.value);
              return (
                <button key={opt.value}
                  type="button"
                  onClick={() => setExperienceLevels(active
                    ? experienceLevels.filter(v => v !== opt.value)
                    : [...experienceLevels, opt.value])}
                  style={{
                    padding:"5px 12px", borderRadius:999, fontSize:11, fontWeight:600,
                    cursor:"pointer", border:`1px solid ${active ? theme.accent : theme.border}`,
                    background: active ? theme.accentMuted : "transparent",
                    color: active ? theme.accentText : theme.textMuted,
                    transition:"all 0.15s",
                  }}>
                  {withCount(opt.label, countFor("experience_level", opt.value))}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize:10, color:theme.textDim, marginTop:4 }}>
            Selecting any level here overrides your profile's derived default for this search.
          </div>
        </div>

        {/* Category removed for two independent reasons, either of which is fatal: sj.category is
            not in aggregator's upsertStmt so nothing can write it, AND the options came from
            /api/categories — a hardcoded marketing taxonomy ("Fintech / Banking", "Design / UX")
            whose strings never matched that column's vocabulary even in principle. A domain filter
            worth having would read sj.bucket_domain, which IS written (from classifyJob's
            detectDomain); that is a separate piece of work, not a rename of this one. The category
            param stays honoured server-side. */}

        {/* Legacy Source select removed. Unlike the others here its COLUMN is fine — sj.source is
            written by every path — but its two options were "linkedin" and "indeed", and neither is
            a value any current writer produces (the live sources are greenhouse/lever/ashby/
            workday/smartrecruiters/workable/recruitee/jobo). So both choices returned 0 rows while
            "All sources" was a no-op: dead by vocabulary rather than by NULL. "Provider" directly
            below is the same filter done properly — real source values, live facet counts, and an
            exclude direction. The source param stays honoured server-side as a hard match. */}

        <div>
          <div style={labelStyle}>Provider</div>
          <IncludeExcludeRow
            options={SOURCE_OPTIONS}
            dimension="sources"
            included={sourcesInclude} setIncluded={setSourcesInclude}
            excluded={sourcesExclude} setExcluded={setSourcesExclude}
          />
          <div style={{ fontSize:10, color:theme.textDim, marginTop:4 }}>
            Which job board the posting came from. Click once to include, twice to exclude.
            Counts are for your current board.
          </div>
        </div>

        <div>
          <div style={labelStyle}>Automation Tier</div>
          <IncludeExcludeRow
            options={TIER_OPTIONS}
            dimension="automation_tier"
            included={tiersInclude} setIncluded={setTiersInclude}
            excluded={tiersExclude} setExcluded={setTiersExclude}
          />
          <div style={{ fontSize:10, color:theme.textDim, marginTop:4 }}>
            What the apply page will ask of you. <strong>Unknown</strong> means we have not
            established it — those postings may apply cleanly or may need an account, and are
            neither promised nor ruled out.
          </div>
        </div>

        <div>
          <div style={labelStyle}>Date Posted</div>
          <select value={ageFilter} onChange={e=>setAgeFilter(e.target.value)} style={selStyle}>
            <option value="">Any time</option>
            <option value="1d">Past 24h</option>
            <option value="2d">Past 2 days</option>
            <option value="3d">Past 3 days</option>
            <option value="1w">Past week</option>
            <option value="1m">Past month</option>
          </select>
        </div>

        {/* Years of Experience removed: sj.min_years_exp has no writer at all — not in the upsert,
            not in enrichment — so both inputs were no-ops. server.js's own sort comment already
            records this ("nothing on the ATS crawl path ever writes it"). "Experience Level" above
            expresses the same intent over sj.experience_level, which enrichment does populate
            (intern/mid/senior/lead all non-zero). The YoE SORT is unaffected: it already ranks by
            experience_level when min_years_exp is null. minYoe/maxYoe stay honoured server-side,
            soft-null, including the profile-derived default. */}

        {/* Max Applicants removed: sj.applicant_count has no writer either. It was fed by the
            LinkedIn bulk saved-jobs import, which cleanup 5.3 deleted outright — so the column is
            orphaned from a feature that no longer exists, and no ATS board exposes an applicant
            count. The param stays honoured server-side, soft-null. */}

        <div>
          <div style={labelStyle}>Status</div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            <select value={visitedFilter} onChange={e=>setVisitedFilter(e.target.value)} style={selStyle}>
              <option value="">Visited & unvisited</option>
              <option value="0">Unvisited only</option>
              <option value="1">Visited only</option>
            </select>
          </div>
        </div>

        <div>
          <div style={labelStyle}>Salary Range (USD)</div>
          <div style={{ display:"flex", gap:6 }}>
            <input type="number" min={0} placeholder="$60000"
              value={salaryMin} onChange={e=>setSalaryMin(e.target.value)}
              style={{...selStyle, flex:1}}/>
            <input type="number" min={0} placeholder="$200000"
              value={salaryMax} onChange={e=>setSalaryMax(e.target.value)}
              style={{...selStyle, flex:1}}/>
          </div>
          <div style={{ fontSize:10, color:theme.textDim, marginTop:4 }}>
            Matches jobs whose posted range overlaps this window — postings with no
            salary data are excluded once either bound is set.
          </div>
        </div>

        <div>
          <div style={labelStyle}>Skills (must include)</div>
          <div style={{ display:"flex", gap:6 }}>
            <input value={skillDraft} onChange={e=>setSkillDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const v = skillDraft.trim();
                if (v && !skillsInclude.some(s => s.toLowerCase() === v.toLowerCase())) {
                  setSkillsInclude([...skillsInclude, v]);
                }
                setSkillDraft("");
              }}
              placeholder="e.g. React, SQL"
              style={{...selStyle, flex:1}}/>
            <LucyBtn onClick={() => {
              const v = skillDraft.trim();
              if (v && !skillsInclude.some(s => s.toLowerCase() === v.toLowerCase())) {
                setSkillsInclude([...skillsInclude, v]);
              }
              setSkillDraft("");
            }}>Add</LucyBtn>
          </div>
          {skillsInclude.length > 0 && (
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginTop:8 }}>
              {skillsInclude.map(skill => (
                <button key={skill} type="button" onClick={() => setSkillsInclude(skillsInclude.filter(s => s !== skill))}
                  style={{
                    padding:"4px 10px", borderRadius:999, fontSize:11, fontWeight:600,
                    cursor:"pointer", border:`1px solid ${theme.accent}`,
                    background:theme.accentMuted, color:theme.accentText,
                  }}>
                  {skill} ×
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <button type="button" onClick={() => setSponsorFriendly(!sponsorFriendly)}
            style={{
              display:"flex", alignItems:"center", gap:8, width:"100%",
              padding:"8px 10px", borderRadius:4, cursor:"pointer",
              border:`1px solid ${sponsorFriendly ? theme.accent : theme.border}`,
              background: sponsorFriendly ? theme.accentMuted : "transparent",
              color: sponsorFriendly ? theme.accentText : theme.text,
            }}>
            <span style={{
              width:16, height:16, borderRadius:3, flexShrink:0,
              border:`1px solid ${sponsorFriendly ? theme.accent : theme.border}`,
              background: sponsorFriendly ? theme.accent : "transparent",
            }}/>
            <span style={{ fontSize:12, fontWeight:600 }}>Sponsor-friendly only</span>
          </button>
        </div>

        <div style={{ display:"flex", gap:8, paddingTop:8 }}>
          <LucyBtn onClick={onReset} accent={theme.surfaceHigh} style={{ flex:1 }}>
            Reset All
          </LucyBtn>
          <LucyBtn onClick={onApply} style={{ flex:1 }}>
            Apply
          </LucyBtn>
        </div>
      </motion.div>
    </div>
  );
}

// -- Aliases (mirrors server normaliser) -----------------------
const ALIASES = Object.fromEntries(
  Object.entries(ROLE_ALIAS_MAP).map(([alias, entry]) => [alias, entry.canonical])
);

const ROLE_FAMILY_DOMAIN_FALLBACK = {
  data: "data",
  pm: "pm_general",
  finance: "finance",
  marketing: "marketing",
  hr: "hr",
  design: "design",
  legal: "legal",
  operations: "operations",
};

function intentDomainForAlias(entry) {
  if (!entry) return "general";
  if (entry.domain && entry.domain !== "it_digital") return entry.domain;
  if (entry.roleFamily === "general" && entry.domain) return entry.domain;
  return ROLE_FAMILY_DOMAIN_FALLBACK[entry.roleFamily] || entry.roleFamily || "general";
}

function mergeIntentTerms(baseIntents) {
  const byDomain = new Map(baseIntents.map(intent => [intent.domainKey, { ...intent, terms: [...intent.terms] }]));
  for (const [alias, entry] of Object.entries(ROLE_ALIAS_MAP)) {
    const domainKey = intentDomainForAlias(entry);
    const current = byDomain.get(domainKey) || {
      domainKey,
      label: entry.roleFamily ? `${entry.roleFamily[0].toUpperCase()}${entry.roleFamily.slice(1)} Roles` : "Supported Roles",
      terms: [],
    };
    current.terms.push(alias, entry.canonical, ...(entry.searchVariants || []));
    byDomain.set(domainKey, current);
  }
  return [...byDomain.values()].map(intent => ({
    ...intent,
    terms: [...new Set(intent.terms.map(normaliseIntentText).filter(Boolean))],
  }));
}

// Search/profile intent guard:
// /api/scrape normalises the typed query, but the outbound provider call uses
// the active domain profile's target_titles. Strong cross-profile signals are
// intercepted here so searches run under the intended profile only after user
// confirmation.
const BASE_SEARCH_PROFILE_INTENTS = [
  {
    domainKey: "engineering_embedded_firmware",
    label: "Firmware, Embedded & Device Software",
    terms: [
      "firmware", "embedded", "embedded software", "embedded systems",
      "bsp", "board support", "rtos", "device driver", "driver engineer",
      "soc bring-up", "chip bring-up", "post-silicon", "hardware debug",
    ],
  },
  {
    domainKey: "engineering_systems_low_level",
    label: "Systems, Platform & Performance Engineering",
    terms: [
      "kernel", "compiler", "operating systems", "systems software",
      "performance engineer", "platform software", "linux kernel",
    ],
  },
  {
    domainKey: "data",
    label: "Data Science & Analytics",
    terms: [
      "data scientist", "data analyst", "machine learning", "ml engineer",
      "analytics engineer", "research scientist", "business intelligence",
    ],
  },
  {
    domainKey: "pm_general",
    label: "Product Management",
    terms: [
      "product manager", "technical product manager", "associate product manager",
      "group product manager", "director of product",
    ],
  },
  {
    domainKey: "pm_it",
    label: "IT / Technical Program Management",
    terms: [
      "technical program manager", "program manager", "scrum master",
      "delivery manager", "release manager", "pmo",
    ],
  },
  {
    domainKey: "finance",
    label: "Finance & Accounting",
    terms: ["financial analyst", "fp&a", "investment banking", "credit analyst", "controller"],
  },
  {
    domainKey: "marketing",
    label: "Marketing & Growth",
    terms: ["marketing manager", "growth manager", "seo manager", "demand generation"],
  },
  {
    domainKey: "design",
    label: "Design & UX",
    terms: ["ux designer", "product designer", "ui/ux", "ux researcher"],
  },
];

const SEARCH_PROFILE_INTENTS = mergeIntentTerms(BASE_SEARCH_PROFILE_INTENTS);

function normaliseIntentText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").replace(/\s+/g, " ").trim();
}

function profileMatchesIntent(profile, intent) {
  if (!profile || !intent) return false;
  if (profile.domain === intent.domainKey) return true;
  const titles = Array.isArray(profile.target_titles) ? profile.target_titles : [];
  const haystack = normaliseIntentText([
    profile.profile_name,
    profile.domain,
    profile.role_family,
    ...titles,
  ].join(" "));
  return intent.terms.some(term => haystack.includes(normaliseIntentText(term)));
}

function detectSearchProfileIntent(query, profiles, activeProfile) {
  const text = normaliseIntentText(ALIASES[query.trim().toLowerCase()] || query);
  if (!text || text.split(" ").length > 8) return null;
  const intent = SEARCH_PROFILE_INTENTS.find(candidate =>
    candidate.terms.some(term => {
      const t = normaliseIntentText(term);
      return text === t || text.includes(t);
    })
  );
  if (!intent || profileMatchesIntent(activeProfile, intent)) return null;
  const existingProfile = (profiles || []).find(profile => profileMatchesIntent(profile, intent));
  return { ...intent, existingProfile };
}

// -- Pull-to-refresh -------------------------------------------
function PullToRefresh({ onRefresh, refreshing, theme, children }) {
  const scrollRef = useRef(null);
  const { update: updateScroll, scrollToTopRef } = useAppScroll();
  const [pullY,   setPullY]   = useState(0);
  const [ready,   setReady]   = useState(false);
  const startY = useRef(null);
  const THRESHOLD = 56;

  // Register scroll-to-top fn so goPage can scroll this container, not window
  useEffect(() => {
    scrollToTopRef.current = () => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    };
    return () => { scrollToTopRef.current = null; };
  }, [scrollToTopRef]);

  // Touch: pull-down gesture when already at the top
  const onTouchStart = (e) => {
    if ((scrollRef.current?.scrollTop ?? 1) === 0)
      startY.current = e.touches[0].clientY;
  };
  const onTouchMove = (e) => {
    if (startY.current === null) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy > 0) {
      setPullY(Math.min(dy * 0.55, THRESHOLD + 20));
      setReady(dy * 0.55 >= THRESHOLD);
    }
  };
  const onTouchEnd = () => {
    if (ready) onRefresh();
    setPullY(0); setReady(false); startY.current = null;
  };

  // Desktop: expose the scrollRef so parent can detect wheel-at-top if needed
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      {/* Pull indicator — animates down then snaps back */}
      <div style={{
        height: pullY, flexShrink:0, overflow:"hidden",
        display:"flex", alignItems:"center", justifyContent:"center",
        background: theme.accentMuted,
        transition: pullY === 0 ? "height 0.22s ease" : "none",
      }}>
        {pullY > 12 && (
          <span style={{ fontSize:11, fontWeight:700, color:theme.accentText }}>
            {ready ? "? Release to refresh" : "? Keep pulling…"}
          </span>
        )}
      </div>

      {/* Desktop "check for new" strip — visible at very top, compact */}
      {!refreshing && pullY === 0 && (
        <div onClick={onRefresh} style={{
          flexShrink:0, padding:"4px 20px",
          display:"flex", alignItems:"center", justifyContent:"center", gap:6,
          background:theme.accentMuted, borderBottom:`1px solid ${theme.accent}22`,
          cursor:"pointer", fontSize:10, fontWeight:700,
          color:theme.accentText, letterSpacing:"0.06em", textTransform:"uppercase",
        }}>
          <span style={{ display:"inline-block", width:10, height:10,
                         border:`2px solid ${theme.border}`, borderTop:`2px solid ${theme.accent}`,
                         borderRadius:"50%", marginRight:6, verticalAlign:"-2px" }}/>
          Check for new jobs
        </div>
      )}
      {refreshing && (
        <div style={{
          flexShrink:0, padding:"4px 20px",
          display:"flex", alignItems:"center", justifyContent:"center", gap:6,
          background:theme.accentMuted, borderBottom:`1px solid ${theme.accent}22`,
          fontSize:10, fontWeight:700, color:theme.accentText,
          letterSpacing:"0.06em", textTransform:"uppercase",
        }}>
          <span style={{ display:"inline-block", width:10, height:10,
                         border:`2px solid ${theme.border}`, borderTop:`2px solid ${theme.accent}`,
                         borderRadius:"50%", animation:"spin 0.8s linear infinite" }}/>
          Checking…
        </div>
      )}

      <div
        ref={scrollRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onScroll={(e) => updateScroll(e.currentTarget.scrollTop / 90)}
        style={{ flex:1, overflowY:"auto", paddingTop:4, paddingBottom:8 }}>
        {children}
      </div>
    </div>
  );
}



// DEFAULT SIZES (canonical, do not edit inline):
// A only:                 A=100
// A + one other panel:    A=30, other=70
// A + 2+ other panels:    A=6, residual split uniformly
// Resume panel exception: resume receives 10 percentage points more than
// each other non-collapsed panel; A is excluded from that bonus.
// Rule: panel defaults reapply on every open/close transition.
// Manual resize remains in effect until the next transition.
// To change defaults edit getPanelDefaults() below.
// -- Card tier — driven by open-panel count, not pixel width ------
// Tier 1 (full layout):  A alone, or A+B (detail only, 30% default)
// Tier 3 (condensed):    A+B+C or A+B+C+D (panel A shrinks to 6%)
// Tier 2 (medium):       only reached by manual drag — ResizeObserver
//                        overrides Tier 1 ? 2 when user drags A to 180-279px.
//                        Tier 3 always wins over pixel measurement.
function getCardTier(panelBVisible, panelCVisible, panelDVisible) {
  const extraPanels = [panelBVisible, panelCVisible, panelDVisible].filter(Boolean).length;
  if (extraPanels === 0) return 1; // A only — full width
  if (extraPanels === 1) return 1; // A+B — still 30%, full layout
  return 3;                        // A+B+C or A+B+C+D — 6%, condensed
}

function getPanelDefaults(showDetail, showSandbox, showAts) {
  const openPanels = [
    ["detail", showDetail],
    ["sandbox", showSandbox],
    ["ats", showAts],
  ].filter(([, visible]) => visible).map(([key]) => key);

  if (openPanels.length === 0) return { jobs: 100, detail: 0, sandbox: 0, ats: 0 };
  if (openPanels.length === 1) {
    return {
      jobs: 30,
      detail: showDetail ? 70 : 0,
      sandbox: showSandbox ? 70 : 0,
      ats: showAts ? 70 : 0,
    };
  }

  const jobs = 6;
  const residualWidth = 100 - jobs;
  const hasResumePanel = openPanels.includes("sandbox");
  const baseShare = hasResumePanel
    ? Math.max(0, (residualWidth - 10) / openPanels.length)
    : residualWidth / openPanels.length;
  const panelShare = key => (
    openPanels.includes(key)
      ? (hasResumePanel && key === "sandbox" ? baseShare + 10 : baseShare)
      : 0
  );

  return {
    jobs,
    detail: panelShare("detail"),
    sandbox: panelShare("sandbox"),
    ats: panelShare("ats"),
  };
}

function buildAtsPayload(job, artifact = null) {
  const activeArtifact = artifact ? getActiveArtifact(artifact, artifact.activeTool || artifact.tool) : null;
  const score = activeArtifact?.atsScore
    ?? job?.atsScore
    ?? job?.resumeAtsScore
    ?? job?.baseAtsScore
    ?? null;
  const report = activeArtifact?.atsReport
    ?? job?.atsReport
    ?? job?.resumeAtsReport
    ?? job?.baseAtsReport
    ?? job?.ats_report
    ?? null;
  return {
    score,
    report,
    company: activeArtifact?.company || job?.company,
    title: activeArtifact?.title || job?.title || job?.role,
  };
}

// -- Main panel ------------------------------------------------
export default function JobsPanel({ user, onUserChange, refreshKey = 0, isActive = true }) {
  const { theme } = useTheme();
  const { mode: vpMode } = useViewport();
  const navigate = useNavigate();
  const { pin: pinDock, scrollToTopRef, progress: scrollProgress } = useAppScroll();
  const isWide     = vpMode === "wide";
  const isMobile   = vpMode === "mobile" || vpMode === "tablet";
  const isPortrait = vpMode === "portrait" || vpMode === "laptop";

  // Mobile pane state
  const [mobilePane, setMobilePane] = useState("jobs"); // "jobs" | "editor" | "ats"

  // Tracks jobs disliked in this browser session — survives filter/sort refetches
  // but is cleared on page reload (so server exclusions take effect on next login)
  const sessionDislikedRef = useRef(new Map()); // jobId ? job object

  // Job data
  const [jobs,        setJobs]        = useState([]);
  const [totalJobs,   setTotalJobs]   = useState(0);
  const [totalPages,  setTotalPages]  = useState(0);
  const [currentPage, setCurrentPage] = useState(1);

  // UI state
  const [scraping,    setScraping]    = useState(false);  // Apify live scrape
  const [bgLoading,   setBgLoading]   = useState(false);  // background DB fetch
  const [categories,  setCategories]  = useState([]);
  const [resumeText,  setResumeText]  = useState("");
  const [fileName,    setFileName]    = useState("");
  const [uploading,   setUploading]   = useState(false);
  const [generated,   setGenerated]   = useState({});
  const [loading,     setLoading]     = useState({});
  const [sandbox,     setSandbox]     = useState(null);
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [rightTab,      setRightTab]      = useState("history");
  const [rightPanelOpen, setRightPanelOpen] = useState(false);

  // Split view — selectedJob lifted to JobBoardContext (must be declared here,
  // before the useMemo at ~line 962 that uses !!selectedJob in its dep array)
  const {
    boardTab, setBoardTab, localSearch, setLocalSearch, sortBy, setSortBy,
    activeProfileId, setActiveProfileId, getProfileCache, setProfileCache, deleteProfileCache,
    selectedJob, setSelectedJob, setSelectedJobMeta,
  } = useJobBoard();

  // Open / close sandbox — panel size rebalancing handled by useEffect below
  const openSandbox = useCallback((entry) => {
    setSandbox(entry);
    setSandboxOpen(true);
    if (isMobile) setMobilePane("editor");
  }, [isMobile]);

  const closeSandbox = useCallback(() => {
    setSandboxOpen(false);
    if (isMobile) setMobilePane("jobs");
  }, [isMobile]);

  const openAtsPanel = useCallback((atsData) => {
    if (atsData) setActiveAts(atsData);
    setRightPanelOpen(true);
    setRightTab("ats");
    if (isMobile) setMobilePane("ats");
  }, [isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeAtsPanel = useCallback(() => {
    setRightPanelOpen(false);
  }, []);

  const [activeAts,   setActiveAts]   = useState(null);
  const [smartSearching, setSmartSearching] = useState(false);
  const [attribution, setAttribution] = useState([]); // job source attribution from aggregator

  // Domain profiles
  const [domainProfiles,   setDomainProfiles]   = useState([]);
  const [profileWizardOpen, setProfileWizardOpen] = useState(false);
  const [profileWizardIntent, setProfileWizardIntent] = useState(null);
  const [searchIntentPrompt, setSearchIntentPrompt] = useState(null);
  // Increments when active profile changes — triggers job board refetch
  const [profileSwitchKey, setProfileSwitchKey] = useState(0);

  // Live scrape status
  const [scrapeError,    setScrapeError]    = useState("");
  const [applyQueue, setApplyQueue] = useState([]);
  const [applyRuns, setApplyRuns] = useState([]);
  const [applyReviewJobs, setApplyReviewJobs] = useState([]); // held_review items across all runs
  // Gated jobs, grouped by the portal you have to sign in to. One crossing releases the whole group,
  // which is a different offer from N separate reviews — see TASK G5.
  const [applyGatePortals, setApplyGatePortals] = useState([]);
  const [applyQueueMsg, setApplyQueueMsg] = useState("");
  const [applyRunDetailOpen, setApplyRunDetailOpen] = useState(false);
  const [applyRunDetail, setApplyRunDetail] = useState(null); // { run, jobs, logs }
  const [applyReadiness, setApplyReadiness] = useState(null); // null=unknown, {available,reason}
  // Validation-correction loop. A held run used to be a dead end; these are the questions that would
  // turn it into a completion, deduplicated across jobs by GET /api/apply/questions.
  const [applyQuestions, setApplyQuestions] = useState([]);
  const [applyQuestionMeta, setApplyQuestionMeta] = useState({ eligibilityCount: 0, blockedJobs: 0 });
  const [questionDrafts, setQuestionDrafts] = useState({});   // question text -> answer
  const [answersSaving, setAnswersSaving] = useState(false);
  const [answersMsg, setAnswersMsg] = useState("");
  // Queue-then-approve. An auto run now fills the form, runs every gate and STOPS; these are the
  // applications waiting on a decision. Approving them submits to a real employer and cannot be
  // undone, which is why the detail view shows every answer with the rule that produced it.
  const [applyPending, setApplyPending] = useState([]);
  const [pendingDetail, setPendingDetail] = useState(null); // { runJobId, answers, resume, ... }
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingMsg, setPendingMsg] = useState("");
  const [confirmApproveAll, setConfirmApproveAll] = useState(false);

  // LIVE POLLING: polls /api/jobs/poll every 4s during active scrape.
  // Stops when scraping:false returned or after 3 consecutive failures.
  // To change poll interval edit POLL_INTERVAL_MS below.
  const POLL_INTERVAL_MS = 4000;
  const [pollStatus,   setPollStatus]   = useState("idle"); // "idle"|"polling"|"complete"|"error"
  const pollIntervalRef = useRef(null);

  const [searchPhase, setSearchPhase] = useState("idle");

  // Generation progress
  const [genStage, setGenStage] = useState("");
  const genTimerRef = useRef(null);

  // Panel resize refs (react-resizable-panels imperative API)
  const jobsPanelRef    = useRef(null);
  const detailPanelRef  = useRef(null);
  const sandboxPanelRef = useRef(null);
  const atsPanelRef     = useRef(null);
  const detailPanelElementRef = useRef(null);
  const initialPanelDefaultsAppliedRef = useRef(false);
  const prevPanelVisibilityRef = useRef({ detail: false, sandbox: false, ats: false });

  // ResizeObserver: tracks manual drag width for Tier 1 ? 2 override only
  const jobsPanelElementRef = useRef(null);
  const [manualWidth, setManualWidth] = useState(null);


  // effectiveTier: panel count is primary driver; ResizeObserver only overrides Tier 1 ? 2
  const effectiveTier = useMemo(() => {
    const baseTier = getCardTier(!!selectedJob, sandboxOpen, rightPanelOpen);
    if (baseTier === 3) return 3; // panel count wins — never override Tier 3
    if (manualWidth !== null && manualWidth < 280 && manualWidth >= 180) return 2;
    return baseTier;
  }, [!!selectedJob, sandboxOpen, rightPanelOpen, manualWidth]); // eslint-disable-line react-hooks/exhaustive-deps


  // Task 5 — Inline error states
  const [smartSearchError, setSmartSearchError] = useState("");
  const [uploadError,      setUploadError]      = useState("");

  // Task 6 — Company reuse modal
  const [companyReuseTarget, setCompanyReuseTarget] = useState(null);

  // Board tabs — shared via JobBoardContext (destructured earlier, near line 887)
  const [pendingJobs, setPendingJobs] = useState([]);
  // linkedinInstallModalOpen / linkedinImporting / linkedinExtensionNotice removed in cleanup
  // 5.3 along with the bulk-import flow that was their only writer.
  // extensionState / refreshExtensionState stubs removed in cleanup 5.3 — the last readers of
  // both went with the bulk-import flow.

  const activeDomainProfile = useMemo(() => (
    domainProfiles.find(p => p.id === activeProfileId)
      || domainProfiles.find(p => p.is_active)
      || domainProfiles[0]
      || null
  ), [domainProfiles, activeProfileId]);
  const activeProfileKey = activeDomainProfile?.id || null;
  const activeProfileResumePath = activeDomainProfile?.id
    ? `/api/domain-profiles/${activeDomainProfile.id}/base-resume`
    : null;
  const activeProfileEnhanceStatusPath = activeDomainProfile?.id
    ? `/api/domain-profiles/${activeDomainProfile.id}/enhance-status`
    : null;
  const activeProfileEnhancePath = activeDomainProfile?.id
    ? `/api/domain-profiles/${activeDomainProfile.id}/enhance`
    : null;
  const activeProfileAdoptEnhancedPath = activeDomainProfile?.id
    ? `/api/domain-profiles/${activeDomainProfile.id}/adopt-enhanced`
    : null;

  // Distinguishes "the profile list came back empty" from "the profile list has not come back".
  // fetchJobs keys its board-clearing branch off this — see the note there.
  const profilesLoadedRef = useRef(false);

  // Load domain profiles on mount and seed the shared active profile id.
  useEffect(() => {
    api("/api/domain-profiles")
      .then(rows => {
        const profiles = Array.isArray(rows) ? rows : [];
        profilesLoadedRef.current = true;
        setDomainProfiles(profiles);
        const active = profiles.find(p => p.is_active) || profiles[0];
        if (active && !activeProfileId) setActiveProfileId?.(active.id);
        // Clear any stale "create profile" error that may have appeared before profiles loaded
        if (profiles.length > 0) setScrapeError(e => e.startsWith("Create a job search profile") ? "" : e);
      })
      .catch(() => {});
  }, [activeProfileId, setActiveProfileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enhance resume state
  // ENHANCE GATING: one free per account lifetime.
  // enhance_used is set server-side on API call, not on adoption. Cannot be reset.
  // Future paid unlock: enhance_paid flag in users table.
  // To change gating logic: edit the profile-scoped enhance routes in server.js and update enhance-status response.
  const [enhanceUsed,    setEnhanceUsed]    = useState(false);
  const [enhancePaid,    setEnhancePaid]    = useState(false);
  const [enhancing,      setEnhancing]      = useState(false);
  const [enhanceResult,  setEnhanceResult]  = useState(null); // { original, enhanced, delta }
  const [enhanceModalOpen, setEnhanceModalOpen] = useState(false);

  // Filter panel
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Employment type preferences — persisted in localStorage
  const [employmentTypePrefs, setEmploymentTypePrefsRaw] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("empTypePrefs") || "null");
      return Array.isArray(saved) && saved.length ? saved : ["full-time"];
    } catch { return ["full-time"]; }
  });
  const setEmploymentTypePrefs = (val) => {
    setEmploymentTypePrefsRaw(val);
    try { localStorage.setItem("empTypePrefs", JSON.stringify(val)); } catch {}
  };

  // Scrape trigger input
  const [searchInput, setSearchInput] = useState("");
  // Tracks whether the user has committed the current search input via Enter/button.
  // Used to dismiss the normalised-preview tooltip after submission.
  const [searchCommitted, setSearchCommitted] = useState(false);

  // Filters
  const [roleFilter,    setRoleFilter]    = useState("");
  const [locationFilter,setLocationFilter]= useState("");
  const [workType,      setWorkType]      = useState("");
  const [catFilter,     setCatFilter]     = useState("");
  const [srcFilter,     setSrcFilter]     = useState("");
  const [minYoe,        setMinYoe]        = useState("");
  const [maxYoe,        setMaxYoe]        = useState("");
  const [maxApplicants, setMaxApplicants] = useState("");
  const [visitedFilter, setVisitedFilter] = useState("");
  const [ageFilter,     setAgeFilter]     = useState("");
  // FE-2: Task-4 filter vocabulary + the profile-bridge visa preference override.
  const [salaryMin,      setSalaryMin]      = useState("");
  const [salaryMax,      setSalaryMax]      = useState("");
  const [workModels,     setWorkModels]     = useState([]);
  const [experienceLevels,setExperienceLevels]= useState([]);
  const [skillsInclude,  setSkillsInclude]  = useState([]);
  const [sponsorFriendly,setSponsorFriendly]= useState(false);
  // Provider + automation-tier include/exclude. Default [] on all four — buildParams emits nothing
  // for an empty array, so the default querystring is unchanged.
  const [sourcesInclude, setSourcesInclude] = useState([]);
  const [sourcesExclude, setSourcesExclude] = useState([]);
  const [tiersInclude,   setTiersInclude]   = useState([]);
  const [tiersExclude,   setTiersExclude]   = useState([]);
  const [facetCounts,    setFacetCounts]    = useState(null);
  const [pendingFilters, setPendingFilters] = useState(defaultFilterSnapshot);

  const activeProfileKeyRef = useRef(activeProfileKey);
  const switchingProfileRef = useRef(false);
  const latestSnapshotRef = useRef(null);
  const jobsFetchSeqRef = useRef(0);
  const nextFetchPageRef = useRef(1);
  const pendingIntentSearchRef = useRef(null);
  const searchIntentResolveRef = useRef(null);
  // Stable ref so startPollLoop (empty deps) can always call the latest fetchJobs
  const fetchJobsRef = useRef(null);

  const activeFilterSnapshot = useCallback(() => ({
    roleFilter,
    locationFilter,
    workType,
    employmentTypePrefs: Array.isArray(employmentTypePrefs) && employmentTypePrefs.length
      ? employmentTypePrefs
      : ["full-time"],
    catFilter,
    srcFilter,
    minYoe,
    maxYoe,
    maxApplicants,
    visitedFilter,
    ageFilter,
    salaryMin,
    salaryMax,
    workModels,
    experienceLevels,
    skillsInclude,
    sponsorFriendly,
    sourcesInclude,
    sourcesExclude,
    tiersInclude,
    tiersExclude,
  }), [
    roleFilter, locationFilter, workType, employmentTypePrefs,
    catFilter, srcFilter, minYoe, maxYoe, maxApplicants, visitedFilter, ageFilter,
    salaryMin, salaryMax, workModels, experienceLevels, skillsInclude, sponsorFriendly,
    sourcesInclude, sourcesExclude, tiersInclude, tiersExclude,
  ]);

  const stageFilter = useCallback((key, value) => {
    setPendingFilters(prev => ({ ...prev, [key]: value }));
  }, []);

  // openFilterPanel is defined after buildParams below (it needs to call fetchFacets, which
  // needs buildParams — both declared further down in this component).

  // THE ONE WRITER for the committed filter states. Three separate places used to set them by hand
  // — the drawer's Apply, the profile-switch/reload restore, and Clear All — and the newer filters
  // (salary, work models, experience levels, skills, sponsor, providers, tiers) were only ever added
  // to the first of the three. The consequence was measured in a browser: apply Onsite, board goes
  // 27 → 4, reload, board comes back 27 with the filter silently gone, because the restore path had
  // never heard of workModels. That is the same "a new filter was left out of a hand-maintained
  // list" failure as the refetch dep array, in its third location. One writer, keyed off
  // defaultFilterSnapshot, so a filter added there is picked up by every path at once.
  const applyFilterSnapshot = useCallback((snap) => {
    const next = { ...defaultFilterSnapshot(), ...(snap || {}) };
    setRoleFilter(next.roleFilter || "");
    setLocationFilter(next.locationFilter || "");
    setWorkType(next.workType || "");
    setEmploymentTypePrefs(
      Array.isArray(next.employmentTypePrefs) && next.employmentTypePrefs.length
        ? next.employmentTypePrefs
        : ["full-time"]
    );
    setCatFilter(next.catFilter || "");
    setSrcFilter(next.srcFilter || "");
    setMinYoe(next.minYoe || "");
    setMaxYoe(next.maxYoe || "");
    setMaxApplicants(next.maxApplicants || "");
    setVisitedFilter(next.visitedFilter || "");
    setAgeFilter(next.ageFilter || "");
    setSalaryMin(next.salaryMin || "");
    setSalaryMax(next.salaryMax || "");
    setWorkModels(Array.isArray(next.workModels) ? next.workModels : []);
    setExperienceLevels(Array.isArray(next.experienceLevels) ? next.experienceLevels : []);
    setSkillsInclude(Array.isArray(next.skillsInclude) ? next.skillsInclude : []);
    setSponsorFriendly(!!next.sponsorFriendly);
    setSourcesInclude(Array.isArray(next.sourcesInclude) ? next.sourcesInclude : []);
    setSourcesExclude(Array.isArray(next.sourcesExclude) ? next.sourcesExclude : []);
    setTiersInclude(Array.isArray(next.tiersInclude) ? next.tiersInclude : []);
    setTiersExclude(Array.isArray(next.tiersExclude) ? next.tiersExclude : []);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyPendingFilters = useCallback(() => {
    applyFilterSnapshot(pendingFilters);
    setFiltersOpen(false);
  }, [pendingFilters, applyFilterSnapshot]);

  const resetPendingFilters = useCallback(() => {
    setPendingFilters(defaultFilterSnapshot());
  }, []);

  // How many COMMITTED filters are narrowing the board right now. Compared against
  // defaultFilterSnapshot() rather than against a hand-written list, so a filter added later is
  // counted without anyone remembering to come back here.
  const activeFilterCount = useMemo(() => {
    const current = activeFilterSnapshot();
    const base = defaultFilterSnapshot();
    return Object.keys(base).filter(k => {
      const a = current[k], b = base[k];
      if (Array.isArray(b)) return JSON.stringify(a ?? []) !== JSON.stringify(b);
      return (a ?? "") !== (b ?? "");
    }).length;
  }, [activeFilterSnapshot]);

  // Clears every committed filter AND the staged copy, so the drawer does not reopen still
  // showing the filters the user just cleared from the empty-board notice.
  const clearAllFilters = useCallback(() => {
    const base = defaultFilterSnapshot();
    setPendingFilters(base);
    applyFilterSnapshot(base);
    // localSearch is counted as a narrowing filter by JobsColumn's empty-state branch, so it has to
    // be cleared here too — otherwise "Clear all filters" leaves the board empty and the notice
    // still up, which reads as the button being broken.
    setLocalSearch("");
    setCurrentPage(1);
  }, [applyFilterSnapshot, setLocalSearch]);

  // Spreads activeFilterSnapshot() rather than re-listing the filters: this snapshot is what gets
  // persisted (writeProfileUiCache) and restored, so a filter missing here is a filter that does not
  // survive a reload or a profile switch. It listed only the 11 legacy ones, which is why applying a
  // work-model filter and reloading silently returned the unfiltered board.
  const makeProfileSnapshot = useCallback((overrides = {}) => ({
    jobs,
    pendingJobs,
    totalJobs,
    totalPages,
    currentPage,
    boardTab,
    localSearch,
    sortBy,
    ...activeFilterSnapshot(),
    selectedJob,
    ...overrides,
  }), [jobs, pendingJobs, totalJobs, totalPages, currentPage, boardTab, localSearch, sortBy,
      activeFilterSnapshot, selectedJob]);

  latestSnapshotRef.current = makeProfileSnapshot();

  const applyProfileSnapshot = useCallback((snapshot) => {
    // Do NOT restore stale job rows from cache — they cause the "jobs appear then vanish"
    // flicker when the fresh fetch arrives with a filtered subset. Filter settings and
    // pagination state are still restored so the board refetches with the right params.
    setJobs([]);
    setPendingJobs([]);
    setTotalJobs(snapshot.totalJobs || 0);
    setTotalPages(snapshot.totalPages || 0);
    setCurrentPage(snapshot.currentPage || 1);
    setBoardTab(["linkedin", "linkedin_saved"].includes(snapshot.boardTab) ? "saved" : (snapshot.boardTab || "all"));
    setLocalSearch(snapshot.localSearch || "");
    setSortBy(snapshot.sortBy || "dateDesc");
    // Restore every committed filter through the single writer, and re-stage the drawer to match, so
    // reopening it shows the filters the board is actually applying. Hand-listing them here is what
    // dropped the newer ones on every reload and profile switch.
    applyFilterSnapshot(snapshot);
    setPendingFilters({ ...defaultFilterSnapshot(), ...snapshot });
    setSelectedJob(snapshot.selectedJob || null);
  }, [setBoardTab, setLocalSearch, setSortBy, applyFilterSnapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileRef        = useRef();
  const jobCountRef    = useRef(0);
  const displayJobsRef = useRef([]);
  jobCountRef.current = jobs.length;
  const applyMode = user?.applyMode || "SIMPLE";
  const planTier = String(user?.planTier || "BASIC").toUpperCase();
  const canUseGenerate = planTier === "PLUS" || planTier === "PRO";
  const canUseAPlusResume = planTier === "PRO";

  // Reset panel sizes to defaults on first desktop render and every open/close transition.
  // Triple RAF ensures react-resizable-panels has committed the layout first.
  useEffect(() => {
    if (isMobile) return;
    const showDetail  = !!selectedJob;
    const showSandbox = sandboxOpen;
    const showAts     = rightPanelOpen;
    const prev = prevPanelVisibilityRef.current;
    const visibilityChanged = prev.detail !== showDetail || prev.sandbox !== showSandbox || prev.ats !== showAts;
    const shouldApply = !initialPanelDefaultsAppliedRef.current || visibilityChanged;
    prevPanelVisibilityRef.current = { detail: showDetail, sandbox: showSandbox, ats: showAts };
    if (!shouldApply) return;

    const d = getPanelDefaults(showDetail, showSandbox, showAts);
    let r1, r2, r3;
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        r3 = requestAnimationFrame(() => {
          try {
            if (jobsPanelRef.current)                           jobsPanelRef.current.resize(d.jobs);
            if (showDetail  && detailPanelRef.current)          detailPanelRef.current.resize(d.detail);
            if (showSandbox && sandboxPanelRef.current)         sandboxPanelRef.current.resize(d.sandbox);
            if (showAts     && atsPanelRef.current)             atsPanelRef.current.resize(d.ats);
            initialPanelDefaultsAppliedRef.current = true;
          } catch(e) { console.warn("[panels] resize not ready:", e.message); }
        });
      });
    });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); cancelAnimationFrame(r3); };
  }, [!!selectedJob, sandboxOpen, rightPanelOpen, isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

  // ResizeObserver — only used for Tier 1 → 2 manual-drag fallback
  useEffect(() => {
    const nodes = [jobsPanelElementRef.current, detailPanelElementRef.current].filter(Boolean);
    if (!nodes.length) return;
    let debounceTimer;
    const ro = new ResizeObserver(entries => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const jobsEntry = entries.find(entry => entry.target === jobsPanelElementRef.current) || entries[0];
        const w = jobsEntry?.contentRect.width;
        if (w !== undefined) setManualWidth(w);
      }, 50);
    });
    nodes.forEach(node => ro.observe(node));
    return () => {
      clearTimeout(debounceTimer);
      ro.disconnect();
    };
  }, [!!selectedJob]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync drawer meta to context whenever selectedJob or related state changes
  useEffect(() => {
    if (!selectedJob) { setSelectedJobMeta(null); return; }
    const g2 = generated[selectedJob.jobId];
    const done2 = !!g2?.html;
    const st2 = loading[selectedJob.jobId];
    setSelectedJobMeta({
      g: g2, done: done2, st: st2,
      applyMode, canUseGenerate, canUseAPlusResume: false,
      resumeText,
      onGenerate: (force) => generate(selectedJob, force),
      onViewSandbox: isImported ? undefined : () => {
        const e2 = { ...g2, company: g2?.company || selectedJob.company, title: g2?.title || selectedJob.title };
        openSandbox(e2); openAtsPanel(buildAtsPayload(selectedJob, g2));
      },
      onExport: isImported ? undefined : () => exportAndTrack(selectedJob, getActiveArtifact(g2)?.html, selectedJob.company, getActiveArtifact(g2)),
      onVisit: () => visitUrl(selectedJob),
      onStar: isImported ? undefined : () => toggleStar(selectedJob.jobId, selectedJob),
      onDislike: () => toggleDislike?.(selectedJob.jobId, selectedJob),
      onAts: isImported ? undefined : () => openAtsPanel(buildAtsPayload(selectedJob, g2)),
      onResume: isImported ? undefined : () => generate(selectedJob, false),
      onQueueApply: isImported ? undefined : addToApplyQueue,
    });
  }, [selectedJob, generated, loading, applyMode, canUseGenerate, resumeText]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open resume + ATS panel when a pending job card is selected
  useEffect(() => {
    if (!selectedJob || boardTab !== "pending") return;
    const key = selectedJob.jobId;

    // If pending job response included resume_html, use it directly (no extra fetch)
    if (selectedJob.resume_html) {
      const entry = {
        html:      selectedJob.resume_html,
        atsScore:  selectedJob.ats_score,
        atsReport: selectedJob.ats_report,
        company:   selectedJob.company,
        title:     selectedJob.title,
        jobId:     selectedJob.jobId,
        tool:      selectedJob.apply_mode === "CUSTOM_SAMPLER" ? A_PLUS_TOOL : GENERATE_TOOL,
        toolLabel: selectedJob.apply_mode === "CUSTOM_SAMPLER" ? TOOL_LABELS[A_PLUS_TOOL] : TOOL_LABELS[GENERATE_TOOL],
        status:    "success",
      };
      setGenerated(p => ({ ...p, [key]: entry }));
      openSandbox({ ...entry });
      openAtsPanel({ score: entry.atsScore, report: entry.atsReport,
                     company: selectedJob.company, title: selectedJob.title });
      return;
    }

    // Fallback: resume exists in DB (generated[key] = __exists__) - fetch on demand
    if (generated[key]?.html === "__exists__") {
      generateActual(selectedJob, false, true);
      return;
    }

    // No generated artifact yet. Keep the pre-generation state neutral.
  }, [selectedJob?.jobId, boardTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const PAGE_SIZE = 25;

  // Profile-scoped cache restore: show the correct profile's last board state
  // immediately, then let the normal fetch effect refresh it in the background.
  useEffect(() => {
    const nextKey = activeProfileKey == null ? null : String(activeProfileKey);
    const prevKey = activeProfileKeyRef.current == null ? null : String(activeProfileKeyRef.current);
    if (!nextKey || nextKey === prevKey) {
      activeProfileKeyRef.current = activeProfileKey;
      return;
    }
    if (!prevKey && latestSnapshotRef.current?.jobs?.length) {
      setProfileCache?.(nextKey, latestSnapshotRef.current);
      writeProfileUiCache(nextKey, latestSnapshotRef.current);
      activeProfileKeyRef.current = activeProfileKey;
      return;
    }

    if (prevKey && latestSnapshotRef.current) {
      setProfileCache?.(prevKey, latestSnapshotRef.current);
    }

    switchingProfileRef.current = true;
    const cached = getProfileCache?.(nextKey);
    if (cached) {
      nextFetchPageRef.current = cached.currentPage || 1;
      applyProfileSnapshot(cached);
      setScrapeError("");
    } else {
      const cachedUi = readProfileUiCache(nextKey);
      nextFetchPageRef.current = cachedUi?.currentPage || 1;
      applyProfileSnapshot({ ...(cachedUi || {}), jobs: [], pendingJobs: [], totalJobs: 0, totalPages: 0, selectedJob: null });
      setSandbox(null);
      setSandboxOpen(false);
      setRightPanelOpen(false);
      setScrapeError("");
    }

    activeProfileKeyRef.current = activeProfileKey;
    requestAnimationFrame(() => { switchingProfileRef.current = false; });
  }, [activeProfileKey, applyProfileSnapshot, getProfileCache, setProfileCache]);

  // Keyed on makeProfileSnapshot rather than on a hand-listed copy of everything the snapshot
  // contains. That list was the FOURTH copy of the filter set in this file and it stopped at
  // ageFilter too, so changing a work model updated the board but never rewrote the cache — the
  // stale cache was then what a reload restored. makeProfileSnapshot's own deps now run through
  // activeFilterSnapshot, so this effect fires for any filter, including ones added later.
  useEffect(() => {
    if (!activeProfileKey || switchingProfileRef.current) return;
    setProfileCache?.(activeProfileKey, latestSnapshotRef.current);
    writeProfileUiCache(activeProfileKey, latestSnapshotRef.current);
  }, [activeProfileKey, makeProfileSnapshot, setProfileCache]);

  // -- Split-view: job selection ---------------------------------
  const handleJobSelect = useCallback((job) => {
    setSelectedJob(prev => {
      if (prev?.jobId === job.jobId) return null; // toggle off
      return job;
    });
    markVisited(job);
    if (!job.visited) {
      api(`/api/jobs/${job.jobId}/visited`, { method:"PATCH" }).catch(()=>{});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard nav: Escape closes, ArrowUp/Down navigates
  useEffect(() => {
    if (!selectedJob) return;
    const handler = (e) => {
      if (e.key === "Escape") { setSelectedJob(null); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedJob(prev => {
          if (!prev) return prev;
          const jobs = displayJobsRef.current;
          const idx = jobs.findIndex(j => j.jobId === prev.jobId);
          const nextIdx = e.key === "ArrowDown" ? idx + 1 : idx - 1;
          if (nextIdx >= 0 && nextIdx < jobs.length) {
            const next = jobs[nextIdx];
            markVisited(next);
            return next;
          }
          return prev;
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedJob]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Build query params from current filter state ----------
  const buildParams = useCallback((page = 1, overrideStarred = null, overrides = {}) => {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("pageSize", String(PAGE_SIZE));
    p.set("sort", sortBy);
    const effectiveRole = overrides.role ?? roleFilter;
    const effectiveVisited = overrides.visited ?? visitedFilter;
    if (effectiveRole.trim()) p.set("role",     effectiveRole.trim().toLowerCase());
    if (locationFilter.trim())p.set("location", locationFilter.trim());
    if (workType)             p.set("workType", workType);
    if (employmentTypePrefs.length && !(employmentTypePrefs.length === 1 && employmentTypePrefs[0] === "full-time"))
      p.set("employmentType", employmentTypePrefs.join(","));
    if (catFilter)            p.set("category", catFilter);
    if (srcFilter)            p.set("source",   srcFilter);
    if (minYoe !== "")        p.set("minYoe",        minYoe);
    if (maxYoe !== "")        p.set("maxYoe",        maxYoe);
    if (maxApplicants !== "") p.set("maxApplicants", maxApplicants);
    if (effectiveVisited)     p.set("visited",       effectiveVisited);
    if (ageFilter)            p.set("ageFilter",     ageFilter);
    if (overrideStarred === "1" || boardTab === "saved") p.set("starred","1");
    if (localSearch.trim())   p.set("localSearch",   localSearch.trim().toLowerCase());
    // FE-2: Task-4 filter vocabulary (services/jobs/jobQuery.js) — additive, legacy params
    // above are untouched and remain the override channel.
    if (salaryMin !== "")        p.set("salary_min_usd", salaryMin);
    if (salaryMax !== "")        p.set("salary_max_usd", salaryMax);
    if (workModels.length)       p.set("work_models",    workModels.join(","));
    if (experienceLevels.length) p.set("experience_levels", experienceLevels.join(","));
    if (skillsInclude.length)    p.set("skills_include", skillsInclude.join(","));
    // Sponsor-friendly: ON emits the param the profile-bridge/jobQuery already honor as a
    // soft, null-preserving filter; OFF emits nothing at all (falls back to whatever the
    // active profile already derives by default — see services/jobs/profileFilterBridge.js).
    if (sponsorFriendly)         p.set("sponsorship_friendly", "1");
    // Provider + automation tier (services/jobs/jobQuery.js). Each is emitted ONLY when the user
    // has actually picked something, so with the drawer untouched none of these four keys appear
    // and the default querystring is byte-for-byte what it was before this change — the same
    // property FE-2 established and verified for its own additions.
    if (sourcesInclude.length) p.set("sources_include", sourcesInclude.join(","));
    if (sourcesExclude.length) p.set("sources_exclude", sourcesExclude.join(","));
    if (tiersInclude.length)   p.set("tiers_include",   tiersInclude.join(","));
    if (tiersExclude.length)   p.set("tiers_exclude",   tiersExclude.join(","));
    // posted_after: derived from the SAME named-interval the legacy ageFilter already uses —
    // no new UI control, matching the server's own AGE_MAP (server.js's /api/jobs handler).
    // Redundant with ageFilter's own inline clause (same date, same source of truth) — both
    // apply harmlessly; this just also feeds the Task-4 richFilters path.
    if (ageFilter && AGE_DAYS_MAP[ageFilter]) {
      const postedAfter = Math.floor(Date.now() / 1000) - AGE_DAYS_MAP[ageFilter] * 86400;
      p.set("posted_after", String(postedAfter));
    }
    return p.toString();
  }, [sortBy, roleFilter, locationFilter, workType, employmentTypePrefs, catFilter, srcFilter,
      minYoe, maxYoe, maxApplicants, visitedFilter, ageFilter, boardTab, localSearch,
      salaryMin, salaryMax, workModels, experienceLevels, skillsInclude, sponsorFriendly,
      sourcesInclude, sourcesExclude, tiersInclude, tiersExclude]);

  // FE-2: opt-in facet counts for the panel currently being edited — requested against the
  // CURRENTLY-COMMITTED filters (buildParams(1)), not the still-being-staged pendingFilters, so
  // counts describe "how many jobs match today's board" rather than moving under the user's
  // cursor. The default board fetchJobs() call never requests this — response shape for the
  // common case is unchanged, per the task's explicit regression requirement.
  const fetchFacets = useCallback(async () => {
    try {
      const qs = buildParams(1);
      const data = await api(`/api/jobs?${qs}&include_facets=work_model,experience_level,employment_type,sources,automation_tier`);
      setFacetCounts(data?.facets || null);
    } catch {
      setFacetCounts(null);
    }
  }, [buildParams]);

  const openFilterPanel = useCallback(() => {
    setPendingFilters(activeFilterSnapshot());
    setFiltersOpen(true);
    fetchFacets();
  }, [activeFilterSnapshot, fetchFacets]);

  // openLinkedInExtensionPopup / closeLinkedInImportTab / startLinkedInImport removed in cleanup
  // 5.3. They drove the LinkedIn bulk saved-jobs import, and every one of them called
  // sendExtensionRequest — a stub returning an empty promise since BYO-2. startLinkedInImport
  // additionally gated on isLinkedInExtensionInstalled(), a stub hardcoded to false, so the
  // function could never get past its own guard: it always opened the install modal, for an
  // extension capability that v1.2.0 deleted outright. Nothing here could succeed.

  // -- Fetch pending jobs ----------------------------------------
  const fetchPending = useCallback(async () => {
    const requestProfileKey = activeProfileKeyRef.current;
    try {
      const rows = await api("/api/jobs/pending");
      if (requestProfileKey !== activeProfileKeyRef.current) return;
      setPendingJobs(Array.isArray(rows) ? rows : []);
    } catch {}
  }, []);

  // -- Fetch jobs — never clears board before data arrives ------
  const fetchJobs = useCallback(async (page = 1, mergeMode = false, options = {}) => {
    if (boardTab === "pending") { fetchPending(); return; }
    if (!activeDomainProfile) {
      // "No active profile" has two causes that must not be treated alike: the profile list has
      // genuinely come back empty (a new account — clear the board, setupBlock takes over the
      // UI), or /api/domain-profiles simply has not answered yet. Clearing on the second is how
      // a transient loading state became data loss: any caller reaching here early wiped a board
      // that had already loaded, and nothing refetched afterwards because no dependency had
      // changed. Absence of an answer is not an answer — leave what is on screen alone.
      if (profilesLoadedRef.current) {
        setJobs([]);
        setTotalJobs(0);
        setTotalPages(0);
      }
      // setupBlock already gates the UI — no need to set scrapeError here
      return;
    }
    const requestProfileKey = activeProfileKeyRef.current;
    const requestSeq = ++jobsFetchSeqRef.current;
    setBgLoading(true);
    try {
      const qs = buildParams(page, null, options.overrides || {});
      const d = await api(`/api/jobs?${qs}`);
      if (requestProfileKey !== activeProfileKeyRef.current || requestSeq !== jobsFetchSeqRef.current) return;
      // Normalize aggregator field names to legacy camelCase expected by JobCard/JobsPanel
      const incoming = (d.jobs || []).map(normalizeApiJob);
      // Capture attribution from aggregator response for footer rendering
      if (Array.isArray(d.attribution)) setAttribution(d.attribution);
      if (mergeMode) {
        setJobs(prev => {
          const map = new Map(prev.map(j => [j.jobId, j]));
          incoming.forEach(j => map.set(j.jobId, j));
          return [...map.values()];
        });
      } else {
        // Replace list but re-inject any jobs disliked this session so they
        // remain visible (faded) until the user reloads the page.
        setJobs(() => {
          const result = new Map(incoming.map(j => [j.jobId, j]));
          for (const [id, job] of sessionDislikedRef.current) {
            if (job.__profileKey && String(job.__profileKey) !== String(requestProfileKey)) continue;
            if (!result.has(id)) result.set(id, job);
          }
          return [...result.values()];
        });
      }
      setTotalJobs(d.total || 0);
      setTotalPages(d.totalPages || 0);
      setCurrentPage(page);
      console.log(`[board] profile:${requestProfileKey} sort:${buildParams(page).match(/sort=([^&]+)/)?.[1]||"?"} page:${page} total:${d.total||0} returned:${incoming.length} source:${mergeMode?"merge":"replace"}`);
      setProfileCache?.(requestProfileKey, makeProfileSnapshot({
        jobs: mergeMode
          ? [...new Map([...jobs, ...incoming].map(j => [j.jobId, j])).values()]
          : [...new Map([
              ...incoming.map(j => [j.jobId, j]),
              ...[...sessionDislikedRef.current].filter(([id, job]) =>
                (!job.__profileKey || String(job.__profileKey) === String(requestProfileKey))
                && !incoming.some(j => j.jobId === id)
              ),
            ]).values()],
        totalJobs: d.total || 0,
        totalPages: d.totalPages || 0,
        currentPage: page,
      }));
    } finally {
      if (requestSeq === jobsFetchSeqRef.current) setBgLoading(false);
    }
  }, [activeDomainProfile, buildParams, boardTab, fetchPending, jobs, makeProfileSnapshot, setProfileCache]);
  // Keep stable ref in sync so callbacks with empty deps (e.g. startPollLoop) always
  // call the current fetchJobs closure without needing it in their dep arrays.
  fetchJobsRef.current = fetchJobs;

  // -- Boot --------------------------------------------------
  //
  // This effect deliberately does NOT fetch /api/jobs, and must not start again.
  //
  // It used to open with api("/api/jobs?page=1&pageSize=25&sort=dateDesc") — a hardcoded
  // querystring, i.e. a SECOND param builder alongside buildParams, which is the one thing
  // buildParams exists to prevent. Three separate defects came out of that one line:
  //
  //   1. It ignored every committed filter, so whatever it returned was the unfiltered first page.
  //   2. It had neither of fetchJobs' two guards — no jobsFetchSeqRef sequence check and no
  //      activeProfileKeyRef check — so its response could not be recognised as stale and simply
  //      won whenever it landed last.
  //   3. Its dep array is [user], and JobsConsole was rebuilding `user` as a fresh object literal
  //      on every parent render (see client/src/consoles/PlanConsoles.jsx), so it re-ran on any
  //      ancestor re-render and called setJobs() with (1). That is the "board reverts to its
  //      first-load state on trivial interaction" report, and it was measured: one click on IMPORT
  //      produced one unfiltered /api/jobs and reset the list.
  //
  // Nothing was lost by deleting it. The "Re-fetch when server-side filters/sort/tab change" effect
  // below already runs on mount and loads the board through buildParams()/fetchJobs(), and fetchJobs
  // sets every piece of state this used to set — jobs, totalJobs, totalPages and attribution. The
  // categories and resumes loads below are genuine boot-only reads and stay here.
  useEffect(() => {
    if (!user) return;
    Promise.all([
      api("/api/categories"),
      api("/api/resumes"),
    ]).then(([cats, gr]) => {
      setCategories(cats || []);
      if (gr?.length) {
        const map = {};
        gr.forEach(r => { map[r.job_id] = { html:"__exists__", status:"exists", atsScore:r.ats_score,
          atsReport:r.ats_report, company:r.company, title:r.role,
          jobId:r.job_id, tool:r.apply_mode === "CUSTOM_SAMPLER" ? A_PLUS_TOOL : GENERATE_TOOL,
          toolLabel:r.apply_mode === "CUSTOM_SAMPLER" ? TOOL_LABELS[A_PLUS_TOOL] : TOOL_LABELS[GENERATE_TOOL] }; });
        setGenerated(map);
      }
    }).catch(console.error);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user) return;
    if (!activeProfileResumePath || !activeProfileEnhanceStatusPath) {
      setResumeText("");
      setFileName("");
      setEnhanceUsed(false);
      setEnhancePaid(false);
      return;
    }
    Promise.all([
      api(activeProfileResumePath),
      api(activeProfileEnhanceStatusPath),
    ]).then(([resume, status]) => {
      setResumeText(resume?.content || "");
      setFileName(resume?.name || (resume?.content ? "Saved resume" : ""));
      setEnhanceUsed(!!status?.enhanceUsed);
      setEnhancePaid(!!status?.enhancePaid);
    }).catch(() => {
      setResumeText("");
      setFileName("");
      setEnhanceUsed(false);
      setEnhancePaid(false);
    });
  }, [user, activeProfileResumePath, activeProfileEnhanceStatusPath]);

  // Bulk-import completion effect removed in cleanup 5.3. `extensionState` is a hardcoded
  // { status: "IDLE" } literal, so neither branch could ever run — it watched for DONE/ERROR
  // states that nothing has published since the bridge became a stub.

  // "rm-extension:event" listener removed in cleanup 5.3. It handled LINKEDIN_LOGIN_REQUIRED,
  // which only the bulk-import flow ever published, and its handler wrote the two pieces of
  // state removed above. Nothing dispatches this event any more — the bridge that did is a stub.

  useEffect(() => {
    if (["linkedin", "linkedin_saved"].includes(boardTab)) setBoardTab("saved");
  }, [boardTab, setBoardTab]);

  // Re-fetch when server-side filters/sort/tab change (background — board stays visible)
  // Note: localSearch is NOT in this dep array — it has its own debounced effect below
  useEffect(() => {
    if (!user) return;
    const page = nextFetchPageRef.current || 1;
    nextFetchPageRef.current = 1;
    fetchJobs(page);
  }, [sortBy, roleFilter, locationFilter, workType, employmentTypePrefs, catFilter, srcFilter,
      minYoe, maxYoe, maxApplicants, visitedFilter, ageFilter, boardTab, refreshKey,
      profileSwitchKey, activeProfileKey,
      // FE-2's Task-4 params (salaryMin/Max, workModels, experienceLevels, skillsInclude,
      // sponsorFriendly) feed the SAME buildParams()/fetchJobs() call as the legacy filters
      // above — they were missing from this list, so changing ONLY one of them (leaving every
      // legacy filter untouched) would build the right querystring but never actually refetch.
      salaryMin, salaryMax, workModels, experienceLevels, skillsInclude, sponsorFriendly,
      // Same failure, third time this file has been at risk of it: a new filter that feeds
      // buildParams but is missing HERE builds a correct querystring that is never sent, so the
      // control looks dead. FE-3 fixed it for FE-2's params; these four are added in the same
      // commit that introduces them precisely so there is no fourth time. Verified by changing
      // only a provider pill and watching a request fire.
      sourcesInclude, sourcesExclude, tiersInclude, tiersExclude,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSearchPhase("idle");
  }, [activeProfileKey, searchInput]);

  // Debounced backend search — fires 300ms after user stops typing.
  //
  // Two things here are load-bearing, and the board came up empty on every cold load without
  // them.
  //
  // 1. It must NOT fire on mount. `localSearch` starts "" and this effect ran once anyway, 300ms
  //    after mount — a "search" for the empty string that nobody typed. The board is already
  //    being loaded by the boot effect and the refetch effect, so that call was never needed;
  //    it only raced them.
  //
  // 2. It must call through fetchJobsRef, not the captured `fetchJobs`. The dep array is
  //    [localSearch] alone, so when localSearch never changes the effect never re-runs and the
  //    timer keeps the closure from the FIRST render — the render where /api/domain-profiles had
  //    not answered yet, so activeDomainProfile was still null. That stale closure hit
  //    fetchJobs' "no active profile" branch and called setJobs([]) 300ms in, wiping the 11 jobs
  //    the real fetch had just delivered ~170ms earlier. Traced in a browser: `fetchJobs SET
  //    {total:11}` at +3661ms, then `fetchJobs ENTER {hasProfile=false, nProfiles=0}` at +3838ms
  //    while the component's own next render logged nProfiles:1 — the call was reading a dead
  //    render's state. fetchJobsRef is already maintained a few lines above for exactly this
  //    hazard (startPollLoop's empty deps); this is the second caller that needed it.
  const searchDebounceReady = useRef(false);
  useEffect(() => {
    // The mount-skip is checked BEFORE the `user` guard on purpose. Putting it after would leave
    // the flag unset whenever the component mounts logged-out, and the user's FIRST real search
    // would then be swallowed as if it were the mount run.
    if (!searchDebounceReady.current) { searchDebounceReady.current = true; return; }
    if (!user) return;
    const timer = setTimeout(() => {
      setCurrentPage(1);
      fetchJobsRef.current?.(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [localSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Multi-session sync — reflect changes from other tabs/devices without full reload
  useSyncEvents({
    job_flag: ({ jobId, starred, disliked }) => {
      setJobs(prev => prev.map(j =>
        j.jobId === jobId
          ? { ...j, ...(starred  != null ? { starred:  !!starred,  disliked: false } : {}),
                     ...(disliked != null ? { disliked: !!disliked, starred:  false } : {}) }
          : j
      ));
    },
    resume_generated: () => {
      fetchJobs(currentPage);
    },
    profile_switched: ({ profileId }) => {
      if (profileId) setActiveProfileId?.(Number(profileId));
      setProfileSwitchKey(k => k + 1);
    },
    scrape_complete: () => {
      fetchJobs(1);
    },
  });

  // Shared poll loop — used by handleSearch, handlePullRefresh, handleSetRole
  const startPollLoop = useCallback((roleQ, pollSince) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    setPollStatus("polling");
    let failCount = 0;
    const seenIds = new Set();
    let totalNew = 0;

    pollIntervalRef.current = setInterval(async () => {
      try {
        const qs = new URLSearchParams({ since: String(pollSince), query: roleQ });
        const pollData = await api(`/api/jobs/poll?${qs.toString()}`);
        failCount = 0;
        if (pollData.needsProfileSetup) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
          setScraping(false);
          setPollStatus("idle");
          setScrapeError("Create a job search profile to load matching jobs.");
          return;
        }
        if (pollData.needsBaseResume) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
          setScraping(false);
          setPollStatus("idle");
          setScrapeError("Upload the active profile's base resume before searching jobs.");
          return;
        }
        if (pollData.scrapeUnavailable && pollData.message) {
          setScrapeError(pollData.message);
        }

        const newJobs = (pollData.jobs || []).filter(j => !seenIds.has(j.jobId));
        if (newJobs.length > 0) {
          newJobs.forEach(j => seenIds.add(j.jobId));
          totalNew += newJobs.length;
          // Re-read through /api/jobs so progressive merges honor local filters,
          // profile hard constraints, sort mode, and pagination consistently.
          fetchJobsRef.current?.(1);
        }

        if (!pollData.scraping) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
          setScraping(false);
          setPollStatus("idle");
          // Re-fetch from DB with current sort so poll-prepended jobs end up in correct order
          fetchJobsRef.current?.(1);
        }
      } catch {
        failCount++;
        if (failCount >= 3) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
          setScraping(false);
          setPollStatus("error");
          setScrapeError("Could not fetch new jobs - check Apify in Integrations.");
        }
      }
    }, POLL_INTERVAL_MS);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activateProfileForSearch = useCallback(async (profileId) => {
    await api(`/api/domain-profiles/${profileId}/activate`, { method: "POST" });
    setDomainProfiles(prev => prev.map(p => ({ ...p, is_active: p.id === profileId ? 1 : 0 })));
    setActiveProfileId?.(profileId);
    setProfileSwitchKey(k => k + 1);
  }, [setActiveProfileId]);

  // FE-3: persist the CURRENTLY-COMMITTED filter set (buildParams(1), same querystring
  // fetchJobs already sent) as this profile's tracked search — not pendingFilters, so "save"
  // always captures exactly what's on screen right now.
  const saveTrackedSearch = useCallback(async () => {
    if (!activeDomainProfile?.id) return;
    try {
      const data = await api(`/api/domain-profiles/${activeDomainProfile.id}/tracked-search`, {
        method: "PUT",
        body: JSON.stringify({ params: buildParams(1) }),
      });
      setDomainProfiles(prev => prev.map(p =>
        p.id === activeDomainProfile.id ? { ...p, tracked_search: data.trackedSearch } : p
      ));
    } catch(e) {
      setScrapeError(e.message || "Could not save search.");
    }
  }, [activeDomainProfile, buildParams]);

  const clearTrackedSearch = useCallback(async () => {
    if (!activeDomainProfile?.id) return;
    try {
      await api(`/api/domain-profiles/${activeDomainProfile.id}/tracked-search`, {
        method: "PUT",
        body: JSON.stringify({ params: null }),
      });
      setDomainProfiles(prev => prev.map(p =>
        p.id === activeDomainProfile.id ? { ...p, tracked_search: null } : p
      ));
    } catch(e) {
      setScrapeError(e.message || "Could not clear saved search.");
    }
  }, [activeDomainProfile]);

  // Loads a tracked search's saved querystring back into filter state. The refetch effect
  // (dependent on all of these) then fires fetchJobs on its own — no direct fetchJobs call here.
  const applyTrackedSearch = useCallback(() => {
    const saved = activeDomainProfile?.tracked_search;
    if (!saved?.params) return;
    const p = new URLSearchParams(saved.params);
    setRoleFilter(p.get("role") || "");
    setLocationFilter(p.get("location") || "");
    setWorkType(p.get("workType") || "");
    setEmploymentTypePrefs(p.get("employmentType") ? p.get("employmentType").split(",") : ["full-time"]);
    setCatFilter(p.get("category") || "");
    setSrcFilter(p.get("source") || "");
    setMinYoe(p.get("minYoe") || "");
    setMaxYoe(p.get("maxYoe") || "");
    setMaxApplicants(p.get("maxApplicants") || "");
    setVisitedFilter(p.get("visited") || "");
    setAgeFilter(p.get("ageFilter") || "");
    setLocalSearch(p.get("localSearch") || "");
    if (p.get("sort")) setSortBy(p.get("sort"));
    setSalaryMin(p.get("salary_min_usd") || "");
    setSalaryMax(p.get("salary_max_usd") || "");
    setWorkModels(p.get("work_models") ? p.get("work_models").split(",") : []);
    setExperienceLevels(p.get("experience_levels") ? p.get("experience_levels").split(",") : []);
    setSkillsInclude(p.get("skills_include") ? p.get("skills_include").split(",") : []);
    setSponsorFriendly(p.get("sponsorship_friendly") === "1");
    // A saved search stores buildParams' raw querystring, so a param buildParams emits but this
    // function never reads is silently dropped on apply — the saved search would come back
    // subtly wider than the one that was saved. These four round-trip through the same
    // comma-joined encoding buildParams writes.
    const csv = key => (p.get(key) ? p.get(key).split(",") : []);
    setSourcesInclude(csv("sources_include"));
    setSourcesExclude(csv("sources_exclude"));
    setTiersInclude(csv("tiers_include"));
    setTiersExclude(csv("tiers_exclude"));
    setCurrentPage(1);
  }, [activeDomainProfile]);

  const askSearchIntent = useCallback((prompt) => new Promise(resolve => {
    searchIntentResolveRef.current = resolve;
    setSearchIntentPrompt(prompt);
  }), []);

  const closeSearchIntentPrompt = useCallback((accepted) => {
    const resolve = searchIntentResolveRef.current;
    searchIntentResolveRef.current = null;
    setSearchIntentPrompt(null);
    resolve?.(accepted);
  }, []);

  const addToApplyQueue = useCallback((job) => {
    if (!job?.jobId) return;
    setApplyQueue(prev => prev.some(item => item.jobId === job.jobId) ? prev : [...prev, job]);
    setApplyQueueMsg(`${job.company || "Job"} queued for auto apply.`);
    setTimeout(() => setApplyQueueMsg(""), 3000);
  }, []);

  const removeFromApplyQueue = useCallback((jobId) => {
    setApplyQueue(prev => prev.filter(item => item.jobId !== jobId));
  }, []);

  const loadApplyRuns = useCallback(async () => {
    try {
      const data = await api("/api/apply/runs");
      setApplyRuns(Array.isArray(data.runs) ? data.runs : []);
      setApplyReviewJobs(Array.isArray(data.review) ? data.review : []);
    } catch {}
    // Separate call: the grouping lives with the packets, and a failure here must not blank the runs
    // list that the rest of this panel is built on.
    try {
      const gates = await api("/api/apply/gate-packets");
      setApplyGatePortals(Array.isArray(gates.portals) ? gates.portals : []);
    } catch { setApplyGatePortals([]); }
  }, []);

  const loadApplyRunDetail = useCallback(async (runId) => {
    try {
      const data = await api(`/api/apply/runs/${runId}`);
      setApplyRunDetail(data);
      setApplyRunDetailOpen(true);
    } catch {}
  }, []);

  const loadApplyQuestions = useCallback(async () => {
    try {
      const data = await api("/api/apply/questions");
      const questions = Array.isArray(data.questions) ? data.questions : [];
      setApplyQuestions(questions);
      setApplyQuestionMeta({
        eligibilityCount: data.eligibilityCount || 0,
        blockedJobs: data.blockedJobs || 0,
      });
      // A low_confidence question is a CONFIRMATION, not a blank: the resolver already has a value it
      // was not confident enough to submit, so seed the field with it. Accepting it is the answer.
      setQuestionDrafts(prev => {
        const next = { ...prev };
        for (const q of questions) {
          if (next[q.question] === undefined) next[q.question] = q.proposed ?? "";
        }
        return next;
      });
    } catch {}
  }, []);

  /**
   * Save the drafted answers, optionally retrying whatever they unblock.
   *
   * retryJobIds is the union of every job the answered questions block; the SERVER decides which of
   * those are actually retryable (it only retries a job once every question blocking it is answered)
   * and reports the rest as `skipped`. Sending the union rather than guessing keeps that authority
   * in one place.
   */
  const submitApplyAnswers = useCallback(async (retry) => {
    const answers = {};
    for (const q of applyQuestions) {
      const v = questionDrafts[q.question];
      if (v !== undefined && String(v).trim() !== "") answers[q.question] = String(v).trim();
    }
    if (Object.keys(answers).length === 0) {
      setAnswersMsg("Answer at least one question first.");
      return;
    }
    const blocked = [...new Set(
      applyQuestions
        .filter(q => answers[q.question] !== undefined)
        .flatMap(q => (q.blocking || []).map(b => b.jobId))
    )];

    setAnswersSaving(true);
    setAnswersMsg("");
    try {
      const data = await api("/api/apply/answers", {
        method: "POST",
        body: JSON.stringify({
          answers,
          ...(retry ? { retryJobIds: blocked, mode: "auto" } : {}),
        }),
      });
      const saved = data.saved?.length || 0;
      const started = data.retry?.queued?.length || 0;
      setAnswersMsg(
        started
          ? `Saved ${saved} answer${saved === 1 ? "" : "s"} — retrying ${started} application${started === 1 ? "" : "s"}.`
          : `Saved ${saved} answer${saved === 1 ? "" : "s"}.` +
            (data.unblocked?.length ? ` ${data.unblocked.length} ready to retry.` : "")
      );
      await Promise.all([loadApplyQuestions(), loadApplyRuns()]);
    } catch (e) {
      // The answers are saved even when a retry is refused (cap spent, kill switch, run in flight),
      // so say so rather than implying the input was lost. api.js now surfaces the server's sentence.
      const stillSaved = e.payload?.saved?.length || 0;
      setAnswersMsg(
        (stillSaved ? `Saved ${stillSaved} answer${stillSaved === 1 ? "" : "s"}, but the retry did not start: ` : "") +
        (e.message || "Could not save answers.")
      );
      if (stillSaved) await Promise.all([loadApplyQuestions(), loadApplyRuns()]);
    } finally {
      setAnswersSaving(false);
    }
  }, [applyQuestions, questionDrafts, loadApplyQuestions, loadApplyRuns]);

  // ── Queue-then-approve ─────────────────────────────────────────────────────
  const loadApplyPending = useCallback(async () => {
    try {
      const data = await api("/api/apply/pending");
      setApplyPending(Array.isArray(data.pending) ? data.pending : []);
    } catch {}
  }, []);

  /**
   * The full record of one previewed application: every answer with the rule that produced it.
   * Loaded on demand rather than with the list — this is what you read before deciding, and the
   * list is only meant to tell you which ones need attention.
   */
  const openPendingDetail = useCallback(async (runJobId) => {
    if (pendingDetail?.runJobId === runJobId) { setPendingDetail(null); return; }
    setPendingDetail({ runJobId, loading: true });
    try {
      const data = await api(`/api/apply/run-jobs/${runJobId}/review`);
      setPendingDetail({ ...data, runJobId, loading: false });
    } catch (e) {
      setPendingDetail(null);
      setPendingMsg(e.message || "Could not load that application.");
    }
  }, [pendingDetail]);

  /**
   * Approve (submit) or reject the given applications.
   * Approving is the one irreversible action on this surface, so the outcome is always reported
   * from the server's reply rather than assumed — a refused run (cap, kill switch, another run in
   * flight) leaves the approval in place to retry, and the user needs to be told that, not shown a
   * success message for something that did not happen.
   */
  const decidePending = useCallback(async (runJobIds, approve) => {
    if (!runJobIds.length) return;
    setPendingBusy(true);
    setPendingMsg("");
    try {
      const data = await api(`/api/apply/${approve ? "approve" : "reject"}`, {
        method: "POST",
        body: JSON.stringify({ runJobIds }),
      });
      const n = (approve ? data.approved : data.rejected)?.length || 0;
      setPendingMsg(approve
        ? `Submitting ${n} application${n === 1 ? "" : "s"}.`
        : `Rejected ${n} application${n === 1 ? "" : "s"}. Nothing was sent.`);
      setPendingDetail(null);
      setConfirmApproveAll(false);
      await Promise.all([loadApplyPending(), loadApplyRuns()]);
    } catch (e) {
      setPendingMsg(e.message || (approve ? "Could not submit." : "Could not reject."));
      await loadApplyPending();
    } finally {
      setPendingBusy(false);
    }
  }, [loadApplyPending, loadApplyRuns]);

  // The resume and screenshot are served as files, so they cannot carry the auth header api() adds.
  // authContextQuery is the query-param form of the same token, which requireAuth also honours
  // (server.js: `req.query?.authContext`) — the mechanism useSyncEvents already relies on for SSE.
  const artifactUrl = useCallback((runJobId, kind) => {
    const qs = authContextQuery();
    return `/api/apply/run-jobs/${runJobId}/${kind}${qs ? `?${qs}` : ""}`;
  }, []);

  useEffect(() => {
    if (user) { loadApplyRuns(); loadApplyQuestions(); loadApplyPending(); }
  }, [user, loadApplyRuns, loadApplyQuestions, loadApplyPending]);

  // A run does its work in the background, and nothing refreshed this panel — so progress and the
  // final result never appeared until the page was reloaded, which read as "it did nothing".
  // Polls only while a run is actually in flight, and stops as soon as none are, so an idle board
  // costs no requests.
  const runInFlight = applyRuns.some(r => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!user || !runInFlight) return;
    const id = setInterval(() => {
      loadApplyRuns();
      loadApplyPending();
      // The open run-detail modal is a snapshot; refresh it too or it freezes mid-run.
      if (applyRunDetailOpen && applyRunDetail?.run?.id) loadApplyRunDetail(applyRunDetail.run.id);
    }, 4000);
    return () => clearInterval(id);
  }, [user, runInFlight, applyRunDetailOpen, applyRunDetail?.run?.id,
      loadApplyRuns, loadApplyPending, loadApplyRunDetail]);

  useEffect(() => {
    if (!user) return;
    api("/api/apply/readiness").then(d => setApplyReadiness(d)).catch(() => setApplyReadiness({ available: false, reason: "probe_error" }));
  }, [user]);

  /**
   * @param intent "review" — fill, run every gate, stop before submitting, and park each
   *                          application for a human decision (the approval flow).
   *               "auto"   — the same today: mode:"auto" without approvalMode means the server
   *                          defaults to approval-required. Full-auto is opt-in per run via
   *                          approvalMode:"auto", which nothing in this UI sends.
   *
   * "review" replaces the old mode:"manual" (semi) path. Semi's promise — a visible browser you
   * review the filled form in and submit from — cannot be kept in production: applyAutomation
   * launches headless whenever the host is not Windows, so on Railway the form is filled in an
   * invisible container browser and the link here points at an untouched apply URL. The approval
   * flow keeps the same promise in a way that works remotely: the server fills and verifies, then
   * shows every resolved answer with its provenance, the resume PDF and a screenshot of the filled
   * form, and submits only when you approve.
   */
  const startApplyRun = useCallback(async (intent = "auto") => {
    if (!applyQueue.length) return;
    // Both paths post mode:"auto" and omit approvalMode, so the server's approval-required default
    // applies. They are deliberately the same request today — see the note above.
    const mode = intent === "review" ? "auto" : intent;
    try {
      const data = await api("/api/apply/runs", {
        method: "POST",
        body: JSON.stringify({ jobIds: applyQueue.map(job => job.jobId), mode, tool: canUseAPlusResume ? A_PLUS_TOOL : GENERATE_TOOL }),
      });
      setApplyQueue([]);
      const n = data.queued?.length || 0;
      setApplyQueueMsg(
        `${n} job${n === 1 ? "" : "s"} queued — nothing is sent until you approve each one.`,
      );
      loadApplyRuns();
    } catch(e) {
      const missing = e.payload?.missingPrerequisites;
      setApplyQueueMsg(missing?.length
        ? `Setup needed in Integrations: ${missing.join(", ")}.`
        : (e.message || "Could not start apply run."));
    }
  }, [applyQueue, canUseAPlusResume, loadApplyRuns]);

  const deleteDomainProfile = useCallback(async (profileId) => {
    const profile = domainProfiles.find(p => p.id === profileId);
    if (!profile || domainProfiles.length <= 1) return;
    if (!confirm(`Delete job profile "${profile.profile_name}"?`)) return;
    try {
      await api(`/api/domain-profiles/${profileId}`, { method: "DELETE" });
      deleteProfileCache?.(profileId);
      const next = await api("/api/domain-profiles");
      const rows = Array.isArray(next) ? next : [];
      setDomainProfiles(rows);
      const active = rows.find(p => p.is_active) || rows[0];
      if (active) setActiveProfileId?.(active.id);
      setProfileSwitchKey(k => k + 1);
    } catch(e) {
      setScrapeError(e.message || "Could not delete profile.");
    }
  }, [deleteProfileCache, domainProfiles, setActiveProfileId]);

  const ensureSearchProfileAlignment = useCallback(async (query) => {
    const intent = detectSearchProfileIntent(query, domainProfiles, activeDomainProfile);
    if (!intent) return true;

    if (intent.existingProfile) {
      const ok = await askSearchIntent({
        title: "Switch Profile?",
        body: `This search looks like ${intent.label}. Switch to "${intent.existingProfile.profile_name}" for this search?`,
        confirmLabel: "Switch and Search",
        cancelLabel: "Cancel Search",
      });
      if (!ok) {
        setScrapeError(`Search canceled. Switch profiles or refine the query to avoid wrong-profile results.`);
        return false;
      }
      try {
        await activateProfileForSearch(intent.existingProfile.id);
      } catch(e) {
        setScrapeError(e.message || "Could not switch profile for this search.");
        return false;
      }
      return true;
    }

    const canAddProfile = domainProfiles.length < 4;
    if (!canAddProfile) {
      setScrapeError(`This search looks like ${intent.label}, but you already have 4 profiles. Search canceled to avoid wrong-profile results.`);
      return false;
    }

    const ok = await askSearchIntent({
      title: "Add Matching Profile?",
      body: `This search fits ${intent.label}. Add that profile before searching?`,
      confirmLabel: "Add Profile",
      cancelLabel: "Cancel Search",
    });
    if (!ok) {
      setScrapeError(`Search canceled. Add the matching profile or refine the query to continue.`);
      return false;
    }
    pendingIntentSearchRef.current = query;
    setProfileWizardIntent(intent);
    setProfileWizardOpen(true);
    return false;
  }, [activeDomainProfile, activateProfileForSearch, askSearchIntent, domainProfiles]);

  // Set active role — immediately shows local DB results only.
  const handleSetRole = useCallback(async (overrideQuery, options = {}) => {
    const q = (overrideQuery || searchInput).trim();
    if (!q) return false;
    if (!activeDomainProfile) {
      setScrapeError("Create a job search profile before setting a search role.");
      setProfileWizardOpen(true);
      return false;
    }
    if (!resumeText.trim()) {
      setScrapeError("Upload the active profile's base resume before setting a search role.");
      return false;
    }
    if (!options.skipProfileIntent) {
      const aligned = await ensureSearchProfileAlignment(q);
      if (!aligned) return false;
    }
    setScrapeError("");
    const roleQ = q.toLowerCase();
    setRoleFilter(roleQ);
    setSearchInput(q);
    setSearchCommitted(true);
    await fetchJobs(1, false, { overrides: { role: roleQ } });
    return true;
  }, [activeDomainProfile, resumeText, searchInput, ensureSearchProfileAlignment, fetchJobs]);

  // -- Scrape / search ---------------------------------------
  const handleSearch = useCallback(async (overrideQuery, options = {}) => {
    const q = (overrideQuery || searchInput).trim();
    if (!q) return;
    if (!activeDomainProfile) {
      setScrapeError("Create a job search profile before searching jobs.");
      setProfileWizardOpen(true);
      return;
    }
    if (!resumeText.trim()) {
      setScrapeError("Upload the active profile's base resume before searching jobs.");
      return;
    }
    if (!options.skipProfileIntent) {
      const aligned = await ensureSearchProfileAlignment(q);
      if (!aligned) return;
    }
    setScrapeError("");
    setSearchCommitted(true);
    const immediateRoleQ = q.toLowerCase();
    setRoleFilter(immediateRoleQ);
    // Fetch from aggregator — results come back directly, no scraping needed
    await fetchJobs(1, false, { overrides: { role: immediateRoleQ } });
  }, [activeDomainProfile, resumeText, searchInput, fetchJobs, ensureSearchProfileAlignment]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Pull / Check-for-new: DB-first, then scrape if quota unmet -
  // Merges new jobs into the board; removes visited entries.
  const handlePullRefresh = useCallback(async () => {
    const q = (searchInput || roleFilter).trim();
    if (!q) return false;
    if (!activeDomainProfile) {
      setScrapeError("Create a job search profile before checking for jobs.");
      setProfileWizardOpen(true);
      return false;
    }
    if (!resumeText.trim()) {
      setScrapeError("Upload the active profile's base resume before checking for jobs.");
      return false;
    }
    if (bgLoading) return false;
    setScrapeError("");
    const immediateRoleQ = q.toLowerCase();
    setRoleFilter(immediateRoleQ);
    // Fetch from aggregator — results come back directly
    await fetchJobs(1, false, { overrides: { role: immediateRoleQ } });
    setSearchPhase("idle");
    return true;
  }, [searchInput, roleFilter, bgLoading, fetchJobs, activeDomainProfile, resumeText]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Resume Enhancer ------------------------------------------
  const handleEnhance = useCallback(async () => {
    if (enhancing) return;
    if (!activeProfileEnhancePath) {
      setUploadError("Select a job profile before enhancing its resume.");
      return;
    }
    setEnhancing(true);
    try {
      const result = await api(activeProfileEnhancePath, { method: "POST" });
      setEnhanceResult(result);
      setEnhanceModalOpen(true);
    } catch(e) {
      if (e.status === 403) {
        setEnhanceUsed(true);
      } else {
        setUploadError("Enhancement failed: " + e.message);
      }
    } finally {
      // Consume the free use regardless of outcome — server already set enhance_used
      setEnhanceUsed(true);
      setEnhancing(false);
    }
  }, [enhancing, activeProfileEnhancePath]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAdoptEnhanced = useCallback(async () => {
    try {
      if (!activeProfileAdoptEnhancedPath) throw new Error("No active profile");
      await api(activeProfileAdoptEnhancedPath, { method: "PATCH" });
      if (enhanceResult?.enhanced?.text) setResumeText(enhanceResult.enhanced.text);
    } catch(e) { console.warn("[adopt]", e.message); }
    setEnhanceModalOpen(false);
  }, [enhanceResult, activeProfileAdoptEnhancedPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSmartSearch = useCallback(async () => {
    if (!resumeText) {
      setSmartSearchError("Upload the active profile's base resume from Job Profiles first — smart search extracts the best query from it.");
      navigate("/app/job-profiles");
      return;
    }
    setSmartSearchError("");
    setSmartSearching(true);
    try {
      const result = await api("/api/smart-search", { method:"POST", body:JSON.stringify({ resumeText }) });
      if (result.error) { setSmartSearchError(result.error); return; }
      const q = result.searchQuery;
      if (q) { setSearchInput(q); await handleSearch(q); }
    } catch(e) { setSmartSearchError("Smart search failed: " + e.message); }
    finally { setSmartSearching(false); }
  }, [resumeText, handleSearch, navigate]);

  // -- File upload -------------------------------------------
  const handleFile = useCallback(async e => {
    const file = e.target.files[0]; if (!file) return;
    if (!activeProfileResumePath) {
      setUploadError("Create or select a job profile before uploading a resume.");
      return;
    }
    setFileName(file.name); setUploading(true); setUploadError("");
    try {
      const ext = file.name.split(".").pop().toLowerCase();
      let text = "";
      if (ext === "pdf") {
        const fd = new FormData(); fd.append("file", file);
        const r = await fetch("/api/parse-pdf", { method:"POST", credentials:"include", headers:authHeaders(), body:fd });
        const d = await r.json(); if (d.error) throw new Error(d.error);
        text = d.text;
      } else if (ext === "docx") {
        const mammoth = (await import("mammoth")).default;
        text = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
      } else { text = await file.text(); }
      setResumeText(text);
      await api(activeProfileResumePath, { method:"POST", body:JSON.stringify({ content:text, name:file.name }) });
    } catch(err) {
      setUploadError("Error: " + err.message);
      setFileName(""); if (fileRef.current) fileRef.current.value = "";
    } finally { setUploading(false); }
  }, [activeProfileResumePath]);

  // -- Generate (actual logic) -------------------------------
  const generateActual = useCallback(async (job, force = false, skipCompanyCheck = false, tool = "generate") => {
    tool = normalizeTool(tool);
    if (tool === A_PLUS_TOOL ? !canUseAPlusResume : !canUseGenerate) { return; }
    if (!resumeText)            { return; }
    const key = job.jobId, existing = generated[key];
    if (loading[key]) { return; }
    const existingArtifact = getActiveArtifact(existing, tool);
    if (existingArtifact?.html && existingArtifact.html !== "__exists__" && !force) {
      const entry = {...existing, ...existingArtifact, company:existingArtifact.company||job.company, title:existingArtifact.title||job.title};
      openSandbox(entry);
      openAtsPanel({ score:existingArtifact.atsScore, report:existingArtifact.atsReport, company:job.company, title:job.title });
      return;
    }
    if (existing?.html === "__exists__" && existing.tool === tool && !force) {
      // Resume exists in DB but not in memory — fetch on demand
      setLoading(p => ({ ...p, [key]: tool }));
      try {
        const d = await api(`/api/resumes/${key}`);
        const entry = buildArtifact(job, { html: d.html, ats_score: d.ats_score, atsReport: d.atsReport, company: d.company, role: d.role, tool }, tool);
        setGenerated(p => ({ ...p, [key]: entry }));
        openSandbox({ ...entry, company: entry.company, title: entry.title });
        openAtsPanel({ score: d.ats_score, report: d.atsReport, company: d.company, title: d.role });
      } catch(e) {
        setSandbox({ generating: false, status:"missing", missing:true, error: e.message, company: job.company, title: job.title });
      }
      finally { setLoading(p => { const n = {...p}; delete n[key]; return n; }); }
      return;
    }

    // Open sandbox with skeleton state immediately
    openSandbox({ generating: true, status:"loading", company: job.company, title: job.title, jobId:key, tool, toolLabel:TOOL_LABELS[tool] });

    // Cycle through generation stages
    const stages = [
      [0,    "Analysing job description…"],
      [5000, "Selecting companies…"],
      [12000,"Writing experience bullets…"],
      [22000,"Formatting resume…"],
    ];
    if (genTimerRef.current) clearInterval(genTimerRef.current);
    const startTime = Date.now();
    const advanceStage = () => {
      const elapsed = Date.now() - startTime;
      const current = [...stages].reverse().find(([ms]) => elapsed >= ms);
      const stage = current?.[1] || stages[0][1];
      setGenStage(stage);
      setSandbox(s => s?.generating ? { ...s, stage } : s);
    };
    advanceStage();
    genTimerRef.current = setInterval(advanceStage, 1000);

    setLoading(p => ({ ...p, [key]:tool }));
    try {
      const d = await api("/api/generate", { method:"POST",
        body:JSON.stringify({ jobId:key, job, resumeText, forceRegen:force, tool }) });
      if (d.limitReached) {
        setSandbox({ generating: false, status:"error", error: d.error, company: job.company, title: job.title });
        return; // don't throw, just show error in sandbox panel
      }
      if (d.error) throw new Error(d.error);
      const artifact = buildArtifact(job, d, tool);
      setGenerated(p => ({ ...p, [key]: mergeArtifact(p[key], artifact) }));
      openSandbox(mergeArtifact(generated[key], artifact));
      openAtsPanel({ score:d.atsScore, report:d.atsReport, company:job.company, title:job.title });
    } catch(e) {
      setSandbox({ generating: false, status:"error", error: e.message, company: job.company, title: job.title });
    }
    finally {
      if (genTimerRef.current) { clearInterval(genTimerRef.current); genTimerRef.current = null; }
      setGenStage("");
      setLoading(p => { const n = {...p}; delete n[key]; return n; });
    }
  }, [resumeText, generated, loading, canUseGenerate, canUseAPlusResume, openSandbox]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Generate (with company-reuse check) ------------------
  const generate = useCallback(async (job, force = false, tool = "generate") => {
    tool = normalizeTool(tool);
    if (tool === A_PLUS_TOOL ? !canUseAPlusResume : !canUseGenerate) { return; }
    if (!resumeText)            { return; }
    if (loading[job.jobId])     { return; }
    // Company check: if we have a prior resume for this company and this is a fresh generate (not force),
    // show the reuse modal instead of generating.
    if (!force) {
      const priorEntry = Object.values(generated).find(v =>
        getActiveArtifact(v)?.html && getActiveArtifact(v)?.html !== "__exists__" &&
        getActiveArtifact(v)?.company?.toLowerCase() === (job.company || "").toLowerCase()
      );
      if (priorEntry && !generated[job.jobId]?.html) {
        setCompanyReuseTarget({ job, priorEntry, tool });
        return;
      }
    }
    await generateActual(job, force, false, tool);
  }, [generated, generateActual, resumeText, canUseGenerate, canUseAPlusResume, loading]);

  const saveSandboxHtml = useCallback(async (html, artifact = null) => {
    const current = artifact || getActiveArtifact(sandbox);
    if (!current) return;
    const key = current.jobId || Object.entries(generated).find(([,v]) => getActiveArtifact(v)?.company === current.company)?.[0];
    if (key) {
      await api(`/api/resumes/${key}/html`, { method:"POST", body:JSON.stringify({ html, tool:current.tool, version:current.version }) });
      setGenerated(p => {
        const prev = p[key];
        const updated = { ...current, html };
        return { ...p, [key]: mergeArtifact(prev, updated) };
      });
    }
    setSandbox(s => ({...s, html}));
  }, [sandbox, generated]);

  const exportAndTrack = useCallback(async (job, html, company, artifact = null) => {
    const current = artifact || getActiveArtifact(sandbox);
    const targetJob = job || (current?.jobId ? {
      jobId: current.jobId, company: current.company, title: current.title,
      url: current.jobUrl, source: current.source, location: current.location,
    } : null);
    const filename = `Resume_${(company||current?.company||"").replace(/\s+/g,"_")}`;
    if (current?.jobId) {
      await api(`/api/resumes/${current.jobId}/keep`, { method:"POST",
        body:JSON.stringify({ tool:current.tool, version:current.version }) }).catch(()=>{});
    }
    printResume(html, filename);
    if (targetJob) {
      await api("/api/applications", { method:"POST", body:JSON.stringify({
        jobId:targetJob.jobId, company:targetJob.company, role:targetJob.title,
        jobUrl:targetJob.url, source:targetJob.source, location:targetJob.location,
        applyMode: current?.tool === A_PLUS_TOOL ? "CUSTOM_SAMPLER" : applyMode, resumeFile:filename + ".pdf",
      }) }).catch(()=>{});
      await fetchJobs(currentPage);
    }
  }, [applyMode, fetchJobs, currentPage, sandbox]);

  // -- Starred toggle ----------------------------------------
  const toggleStar = useCallback(async (jobId, job = null) => {
    try {
      const d = await api(`/api/jobs/${jobId}/starred`, { method:"PATCH" });
      setJobs(prev => prev.map(j => j.jobId === jobId ? {...j, starred: d.starred, disliked: false} : j));
    } catch {}
  }, []);

  // -- Dislike toggle — deferred removal ------------------------
  // Card stays visible (faded/greyed) for the rest of the session.
  // sessionDislikedRef ensures the card survives any fetchJobs call
  // (sort change, filter change, pagination, etc.) within this session.
  // Only a page reload clears the ref and lets the server exclusion apply.
  const toggleDislike = useCallback(async (jobId, job = null) => {
    try {
      const d = await dislikeJob(jobId);
      const isNowDisliked = !!d.disliked;
      setJobs(prev => {
        return prev.map(j => {
          if (j.jobId !== jobId) return j;
          const updated = { ...j, disliked: isNowDisliked, starred: isNowDisliked ? false : j.starred };
          if (isNowDisliked) {
            sessionDislikedRef.current.set(jobId, { ...updated, __profileKey: activeProfileKeyRef.current });
          } else {
            sessionDislikedRef.current.delete(jobId);
          }
          return updated;
        });
      });
      setPendingJobs(prev => prev.map(j => j.jobId !== jobId ? j : {
        ...j, disliked: isNowDisliked, starred: isNowDisliked ? false : j.starred,
      }));
    } catch {}
  }, []);

  // -- Mark visited in local state ---------------------------
  const markVisited = useCallback((job) => {
    setJobs(prev => prev.map(j => j.jobId === job.jobId ? {...j, visited:true} : j));
  }, []);

  // -- Direct URL open (no dialog) ------------------------------
  const visitUrl = useCallback(async (job) => {
    if (!job.url) return;
    try {
      await api(`/api/jobs/${job.jobId}/visited`, { method:"PATCH" });
    } catch {}
    markVisited(job);
    window.open(job.url, "_blank", "noreferrer");
  }, [markVisited]);

  // -- Pagination --------------------------------------------
  const goPage = async (p) => {
    pinDock();                       // collapse dock immediately
    scrollToTopRef.current?.();      // scroll job list to top (not window)
    await fetchJobs(p);
  };

  // -- Filter reset ------------------------------------------
  const resetFilters = () => {
    setRoleFilter(""); setLocationFilter(""); setWorkType(""); setEmploymentTypePrefs(["full-time"]); setCatFilter("");
    setSrcFilter(""); setMinYoe(""); setMaxYoe(""); setMaxApplicants(""); setVisitedFilter("");
    setAgeFilter(""); setLocalSearch("");
  };

  // displayJobs: backend handles localSearch filtering across all pages
  const displayJobs = useMemo(() => {
    if (boardTab === "pending") return pendingJobs;
    return jobs;
  }, [jobs, pendingJobs, boardTab]);
  displayJobsRef.current = displayJobs;

  const genCount = Object.values(generated).filter(v=>v?.html && v.html !== "__exists__").length;
  const normalisedPreview = ALIASES[searchInput.trim().toLowerCase()]
    || (searchInput.trim() ? searchInput.trim().replace(/\b\w/g, c=>c.toUpperCase()) : "");
  const showPreview = !searchCommitted && !!(normalisedPreview && normalisedPreview.toLowerCase() !== searchInput.trim().toLowerCase());
  const boardTabs = [
    ["all", "All Jobs"],
    ["saved", "Saved ★"],
    ["pending", "Pending"],
  ];

  const isLastPage = currentPage >= totalPages;

  // BUTTON STATES: first click applies local role filter, second click triggers fresh scrape.
  // To change labels edit the buttonLabel derived value below.
  const roleIsSet = !!roleFilter &&
    searchInput.trim().toLowerCase() === roleFilter.trim();
  const runSearchButton = useCallback(async (overrideQuery) => {
    const q = (overrideQuery || searchInput).trim();
    if (!q) return;
    if (!roleIsSet || searchPhase === "idle") {
      const applied = await handleSetRole(q);
      if (applied) setSearchPhase("local");
      return;
    }
    const refreshed = await handlePullRefresh();
    if (!refreshed) setSearchPhase("idle");
  }, [handlePullRefresh, handleSetRole, roleIsSet, searchInput, searchPhase]);
  const buttonLabel = scraping ? "Searching…" : searchPhase === "local" && roleIsSet ? "Search New" : "Set Role";
  const buttonIcon = scraping ? "…" : searchPhase === "local" && roleIsSet ? "↻" : "⌕";
  const setupBlock = !activeDomainProfile
    ? {
        title: "Create a job profile",
        body: "Search and grouped jobs need an active profile so results stay in the right role family.",
        actionLabel: "Add Profile",
        onAction: () => setProfileWizardOpen(true),
      }
    : !resumeText.trim()
      ? {
          title: "Upload a profile resume",
          body: "Search defaults and ATS sorting use extracted signals from this profile's own base resume. Manage it from the Job Profiles section.",
          actionLabel: "Open Job Profiles",
          onAction: () => navigate("/app/job-profiles"),
        }
      : null;

  // Panel sizing is handled by react-resizable-panels + getPanelDefaults().
  // See the getPanelDefaults() function above for default size rules.

  return (
    <div style={{ flex:1, minHeight:0, minWidth:0, display:"flex", flexDirection:"column", overflow:"hidden", background:theme.bg }}>

      {/* Domain profile wizard modal (non-blocking "+ New Profile") */}
      {profileWizardOpen && (
        <DomainProfileWizard
          initialDomainKey={profileWizardIntent?.domainKey || null}
          bannerText={profileWizardIntent ? `Create ${profileWizardIntent.label} to search "${pendingIntentSearchRef.current || searchInput}" in the right profile.` : undefined}
          onComplete={async profile => {
            setDomainProfiles(prev => [...prev, profile]);
            setProfileWizardOpen(false);
            setProfileWizardIntent(null);
            const pendingQuery = pendingIntentSearchRef.current;
            pendingIntentSearchRef.current = null;
            if (profile?.id) {
              try {
                await activateProfileForSearch(profile.id);
              } catch(e) {
                setScrapeError(e.message || "Profile created, but switching before search failed.");
                return;
              }
            }
            if (pendingQuery) {
              const applied = await handleSetRole(pendingQuery, { skipProfileIntent: true });
              if (applied) setSearchPhase("local");
            }
          }}
          onDismiss={() => {
            pendingIntentSearchRef.current = null;
            setProfileWizardIntent(null);
            setProfileWizardOpen(false);
          }}
        />
      )}

      {searchIntentPrompt && (
        <SearchIntentDialog
          theme={theme}
          prompt={searchIntentPrompt}
          onConfirm={() => closeSearchIntentPrompt(true)}
          onCancel={() => closeSearchIntentPrompt(false)}
        />
      )}

      {/* LinkedInInstallDialog removed in cleanup 5.3 — it was only ever opened by
          startLinkedInImport's always-true "extension not installed" guard, and its Import Now
          action called straight back into that same function. A user could reach it, install
          nothing that would help, and loop. */}

      <AnimatePresence>
        {filtersOpen && (
          <FiltersPanel
            open={filtersOpen} onClose={() => setFiltersOpen(false)} onApply={applyPendingFilters}
            categories={categories}
            role={pendingFilters.roleFilter}         setRole={value => stageFilter("roleFilter", value)}
            location={pendingFilters.locationFilter} setLocation={value => stageFilter("locationFilter", value)}
            workType={pendingFilters.workType}       setWorkType={value => stageFilter("workType", value)}
            employmentTypePrefs={pendingFilters.employmentTypePrefs} setEmploymentTypePrefs={value => stageFilter("employmentTypePrefs", value)}
            catFilter={pendingFilters.catFilter}     setCatFilter={value => stageFilter("catFilter", value)}
            srcFilter={pendingFilters.srcFilter}     setSrcFilter={value => stageFilter("srcFilter", value)}
            minYoe={pendingFilters.minYoe}           setMinYoe={value => stageFilter("minYoe", value)}
            maxYoe={pendingFilters.maxYoe}           setMaxYoe={value => stageFilter("maxYoe", value)}
            maxApplicants={pendingFilters.maxApplicants} setMaxApplicants={value => stageFilter("maxApplicants", value)}
            visitedFilter={pendingFilters.visitedFilter} setVisitedFilter={value => stageFilter("visitedFilter", value)}
            ageFilter={pendingFilters.ageFilter}     setAgeFilter={value => stageFilter("ageFilter", value)}
            salaryMin={pendingFilters.salaryMin}     setSalaryMin={value => stageFilter("salaryMin", value)}
            salaryMax={pendingFilters.salaryMax}     setSalaryMax={value => stageFilter("salaryMax", value)}
            workModels={pendingFilters.workModels}   setWorkModels={value => stageFilter("workModels", value)}
            experienceLevels={pendingFilters.experienceLevels} setExperienceLevels={value => stageFilter("experienceLevels", value)}
            skillsInclude={pendingFilters.skillsInclude} setSkillsInclude={value => stageFilter("skillsInclude", value)}
            sponsorFriendly={pendingFilters.sponsorFriendly} setSponsorFriendly={value => stageFilter("sponsorFriendly", value)}
            sourcesInclude={pendingFilters.sourcesInclude || []} setSourcesInclude={value => stageFilter("sourcesInclude", value)}
            sourcesExclude={pendingFilters.sourcesExclude || []} setSourcesExclude={value => stageFilter("sourcesExclude", value)}
            tiersInclude={pendingFilters.tiersInclude || []}   setTiersInclude={value => stageFilter("tiersInclude", value)}
            tiersExclude={pendingFilters.tiersExclude || []}   setTiersExclude={value => stageFilter("tiersExclude", value)}
            facetCounts={facetCounts}
            onReset={resetPendingFilters}
          />
        )}
      </AnimatePresence>

      {/* â"€â"€ Unified toolbar â€" hidden when dock is active (scrollProgress â‰¥ 0.5) â"€â"€ */}
      {/* Row A: tabs | filters | sort | local-search | job count */}
      {/* Row B (wraps): search input | Search | resume upload */}
      {scrollProgress < 0.5 && <div style={{
        background:theme.surface, borderBottom:`1px solid ${theme.border}`,
        padding:"10px 20px", display:"flex", alignItems:"center", gap:8,
        flexShrink:0, flexWrap:"wrap",
      }}>

        {/* â"€â"€ Row A â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */}
        {/* Board tabs — superseded by TopBar Pill 2 */}
        {false && (
        <div style={{ display:"flex", flexShrink:0, overflow:"hidden",
                      border:`2px solid ${theme.borderStrong}`, borderRadius:2 }}>
          {boardTabs.map(([id,lbl], idx) => (
            <button key={id} onClick={() => setBoardTab(id)}
              style={{
                padding:"6px 16px", border:"none", cursor:"pointer",
                fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                fontSize:13, letterSpacing:"0.08em", textTransform:"uppercase",
                background: boardTab===id ? theme.accent : theme.surface,
                color: boardTab===id ? "#0f0f0f" : theme.text,
                transition:"background 0.15s",
                borderRight: idx === boardTabs.length - 1 ? "none" : `2px solid ${theme.borderStrong}`,
              }}>
              {lbl}
            </button>
          ))}
        </div>
        )}
        {/* Filters button â€" always visible, bold outline */}
        <button
          onClick={() => filtersOpen ? setFiltersOpen(false) : openFilterPanel()}
          style={{
            display:"inline-flex", alignItems:"center", gap:6, flexShrink:0,
            background: filtersOpen ? theme.accent : theme.surface,
            border: `2px solid ${theme.borderStrong}`,
            borderRadius:2, padding:"6px 16px",
            fontFamily:"'Barlow Condensed',sans-serif",
            fontWeight:800, fontSize:13, letterSpacing:"0.08em", textTransform:"uppercase",
            cursor:"pointer", color: filtersOpen ? "#0f0f0f" : theme.text,
            transition:"background 0.15s",
          }}>
          Filters
        </button>

        {/* FE-3: "New in 24h" — reuses ageFilter (buildParams already derives posted_after
            from it; server.js's legacy ageSql AND jobQuery.js's richFilters both key off the
            same value), so this is a pure UI toggle with no new query path. */}
        <button
          onClick={() => setAgeFilter(ageFilter === "1d" ? "" : "1d")}
          title="Show only jobs posted in the last 24 hours"
          style={{
            display:"inline-flex", alignItems:"center", gap:6, flexShrink:0,
            background: ageFilter === "1d" ? theme.accent : theme.surface,
            border: `2px solid ${theme.borderStrong}`,
            borderRadius:2, padding:"6px 16px",
            fontFamily:"'Barlow Condensed',sans-serif",
            fontWeight:800, fontSize:13, letterSpacing:"0.08em", textTransform:"uppercase",
            cursor:"pointer", color: ageFilter === "1d" ? "#0f0f0f" : theme.text,
            transition:"background 0.15s",
          }}>
          New in 24h
        </button>

        {/* FE-3: tracked search — save the profile's current committed filter set, or
            apply/clear whatever's already saved for the active profile. */}
        <button
          onClick={saveTrackedSearch}
          disabled={!activeDomainProfile}
          title="Save this filter set to the active profile"
          style={{
            display:"inline-flex", alignItems:"center", gap:6, flexShrink:0,
            background: theme.surface,
            border: `1px solid ${theme.border}`,
            borderRadius:2, padding:"6px 14px",
            fontFamily:"'DM Sans',system-ui",
            fontWeight:700, fontSize:12,
            cursor: activeDomainProfile ? "pointer" : "not-allowed",
            color: activeDomainProfile ? theme.text : theme.textDim,
            opacity: activeDomainProfile ? 1 : 0.5,
          }}>
          Save Search
        </button>
        {activeDomainProfile?.tracked_search && (
          <div style={{ display:"inline-flex", alignItems:"center", gap:4, flexShrink:0 }}>
            <button
              onClick={applyTrackedSearch}
              title={activeDomainProfile.tracked_search.name || "Apply saved search"}
              style={{
                display:"inline-flex", alignItems:"center", gap:6,
                background: theme.accentMuted || theme.surface,
                border: `1px solid ${theme.accent}`,
                borderRadius: 999, padding:"5px 12px",
                fontFamily:"'DM Sans',system-ui",
                fontWeight:700, fontSize:11,
                cursor:"pointer", color: theme.accentText || theme.text,
              }}>
              {activeDomainProfile.tracked_search.name || "Saved Search"}
            </button>
            <button
              onClick={clearTrackedSearch}
              title="Remove saved search"
              style={{
                width:22, height:22, borderRadius:"50%", border:`1px solid ${theme.border}`,
                background:"transparent", color:theme.textMuted, cursor:"pointer",
                fontSize:12, lineHeight:1, flexShrink:0,
              }}>
              x
            </button>
          </div>
        )}

        {/* Sort */}
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          style={{ height:34, padding:"0 10px", borderRadius:2, flexShrink:0,
                   border:`2px solid ${theme.borderStrong}`, background:theme.surface,
                   fontSize:13, color:theme.text, outline:"none",
                   fontFamily:"'DM Sans',system-ui", cursor:"pointer" }}>
          <option value="dateDesc">Newest</option>
          <option value="dateAsc">Oldest</option>
          <option value="compHigh">Pay high to low</option>
          <option value="compLow">Pay low to high</option>
          <option value="yoeLow">Exp low to high</option>
          <option value="yoeHigh">Exp high to low</option>
          <option value="atsScore">ATS Sort</option>
        </select>

        <ProfileSelectorDropdown
          theme={theme}
          profiles={domainProfiles}
          activeProfile={activeDomainProfile}
          onActivate={activateProfileForSearch}
          onDelete={deleteDomainProfile}
          onAdd={() => setProfileWizardOpen(true)}
          title="Switch profile"
        />

        {/* Local search â€" live client-side, every keystroke */}
        <input value={localSearch} onChange={e => setLocalSearch(e.target.value)}
          onKeyDown={e => { if (e.key === "Escape") setLocalSearch(""); }}
          placeholder="Filter loaded jobs..."
          style={{ flex:"0 1 220px", minWidth:120, height:34, padding:"0 12px",
                   borderRadius:2, border:`1px solid ${theme.border}`,
                   background:theme.surface, color:theme.text,
                   fontFamily:"'DM Sans',system-ui", fontSize:13, outline:"none" }}/>
        {localSearch && (
          <button onClick={() => setLocalSearch("")}
            style={{ background:"none", border:"none", color:theme.textDim,
                     cursor:"pointer", fontSize:14, padding:"0 2px", flexShrink:0 }}>x</button>
        )}

        {/* Background loading indicator + job count */}
        <span style={{ fontSize:11, color:theme.textMuted, whiteSpace:"nowrap", flexShrink:0,
                       display:"flex", alignItems:"center", gap:5 }}>
          {bgLoading && (
            <span style={{ display:"inline-block", width:10, height:10,
                           border:`2px solid ${theme.border}`, borderTop:`2px solid ${theme.accent}`,
                           borderRadius:"50%", animation:"spin 0.7s linear infinite" }}/>
          )}
          {boardTab === "pending" ? `${displayJobs.length}` : `${totalJobs}`} job{totalJobs !== 1 ? "s" : ""}
          {localSearch && !bgLoading ? " matched" : ""}
        </span>

        {/* ATS role search + trigger — superseded by UnifiedSearchBar */}
        {false && (<>
        <div style={{ flexBasis:"100%", height:0 }}/>

        <div style={{ position:"relative", flex:1, minWidth:200 }}>
          <input value={searchInput} onChange={e=>{ setSearchInput(e.target.value); setSearchCommitted(false); }}
            onKeyDown={e => e.key==="Enter" && runSearchButton()}
            placeholder="ATS search role, e.g. ML Engineer, SWE..."
            style={{ width:"100%", height:38, paddingLeft:14, paddingRight:14,
                     borderRadius:2, border:`1px solid ${theme.border}`,
                     background:theme.surface, color:theme.text,
                     fontFamily:"'DM Sans',system-ui", fontSize:13, outline:"none",
                     boxSizing:"border-box" }}/>
          {showPreview && (
            <div style={{ position:"absolute", top:"calc(100% + 4px)", left:0,
              fontSize:10, color:theme.textMuted, background:theme.surface,
              border:`1px solid ${theme.border}`,
              borderRadius:4, padding:"4px 10px", whiteSpace:"nowrap", zIndex:10 }}>
              Will search as: <span style={{ color:theme.accentText, fontWeight:700 }}>{normalisedPreview}</span>
            </div>
          )}
        </div>

        <LucyBtn
          onClick={() => runSearchButton()}
          disabled={scraping || bgLoading}
          title={searchPhase === "local" && roleIsSet
            ? "Trigger a fresh profile-scoped scrape for this role"
            : "Apply this role to the local board first"}>
          <span aria-hidden="true">{buttonIcon}</span>
          <span>{buttonLabel}</span>
        </LucyBtn>
        </>)}
        {smartSearchError && (
          <div style={{ flexBasis:"100%", padding:"4px 0", fontSize:11, color:"#991b1b" }}>
            Error: {smartSearchError}
            <button onClick={() => setSmartSearchError("")} style={{ marginLeft:6, background:"none", border:"none", cursor:"pointer", fontSize:11, color:"#991b1b" }}>Dismiss</button>
          </div>
        )}

        {uploadError && (
          <div style={{ flexBasis:"100%", padding:"4px 0", fontSize:11, color:"#991b1b" }}>
            Error: {uploadError}
            <button onClick={() => setUploadError("")} style={{ marginLeft:6, background:"none", border:"none", cursor:"pointer", fontSize:11, color:"#991b1b" }}>Dismiss</button>
          </div>
        )}

        {/* linkedinExtensionNotice banner removed in cleanup 5.3 — it was only ever set by
            startLinkedInImport's NOT_AUTHED branch, which was unreachable past the always-false
            install guard, and its action button called the no-op extension bridge. */}

        {(applyQueue.length > 0 || applyQueueMsg || applyRuns.length > 0 || applyReviewJobs.length > 0
          || applyPending.length > 0) && (
          <div style={{ flexBasis:"100%", display:"flex", alignItems:"center", gap:8, flexWrap:"wrap",
                        padding:"8px 10px", border:`1px solid ${theme.border}`,
                        background:theme.surfaceHigh, borderRadius:6 }}>
            <strong style={{ fontSize:12, color:theme.text }}>Auto Apply</strong>
            {applyQueue.map(job => (
              <span key={job.jobId} style={{ display:"inline-flex", alignItems:"center", gap:5,
                                             padding:"3px 7px", borderRadius:4,
                                             background:theme.surface, color:theme.text, fontSize:11 }}>
                {job.company || job.title}
                <button onClick={() => removeFromApplyQueue(job.jobId)}
                  style={{ border:"none", background:"transparent", color:theme.textDim, cursor:"pointer", padding:0 }}>x</button>
              </span>
            ))}
            {/* Automation tier, applied to the queue BEFORE the run starts.
                Requirement: full-auto must never be offered for `account` or `gated`. It is not —
                and not because of a check added here. The only action on this bar posts
                mode:"auto" with no approvalMode, which the server treats as approval-required, so
                every job in every queue already takes the fill-then-hold-for-a-human path. That
                IS the semi hand-off: the human authenticates once, the resolver fills the form,
                nothing is submitted without approval. There is no full-auto control to withhold.
                `gated` additionally cannot be completed at all — a CAPTCHA or identity check is
                not something to defeat, so it is named as the user's own job rather than
                attempted. What was missing was telling the user any of this before they queued,
                which is what this line does. */}
            {(() => {
              const needsAuth = applyQueue.filter(j => j.automationTier === "account");
              const cannotAuto = applyQueue.filter(j => j.automationTier === "gated");
              if (!needsAuth.length && !cannotAuto.length) return null;
              return (
                <span style={{ flexBasis:"100%", fontSize:11, color:theme.textMuted, lineHeight:1.6 }}>
                  {needsAuth.length > 0 && (
                    <>
                      <strong style={{ color:"#854d0e" }}>{needsAuth.length}</strong> of these need
                      you to sign in to the employer's account first — autofill fills the form once
                      you have.{" "}
                    </>
                  )}
                  {cannotAuto.length > 0 && (
                    <>
                      <strong style={{ color:"#991b1b" }}>{cannotAuto.length}</strong> sit behind a
                      CAPTCHA or identity check and cannot be automated at all; you will need to
                      apply to {cannotAuto.length === 1 ? "that one" : "those"} yourself.
                    </>
                  )}
                </span>
              );
            })()}
            {applyQueue.length > 0 && (
              <>
                {/* One action, because there is one behaviour. "Run Auto Apply" sat here alongside
                    this and posted the same request — mode:"auto" with no approvalMode, which the
                    server treats as approval-required — so it did not auto-apply, and a button that
                    claims applications were sent when they are waiting for you is worse than no
                    button. Full-auto is still reachable per run via approvalMode:"auto"; nothing in
                    this UI sends it, deliberately. */}
                <button onClick={() => startApplyRun("review")}
                  disabled={applyReadiness !== null && !applyReadiness.available}
                  title={applyReadiness && !applyReadiness.available
                    ? `Autofill unavailable: ${applyReadiness.reason}`
                    : "Fills each application and holds it for your approval. Nothing is submitted until you approve it."}
                  style={{ border:"none", borderRadius:6, padding:"6px 10px",
                           background: applyReadiness && !applyReadiness.available ? (theme.surfaceHigh || "#555") : theme.accent,
                           color:"#0f0f0f", fontWeight:800,
                           cursor: applyReadiness && !applyReadiness.available ? "not-allowed" : "pointer",
                           fontSize:12, opacity: applyReadiness && !applyReadiness.available ? 0.5 : 1 }}>
                  Autofill for Review
                </button>
                {applyReadiness && !applyReadiness.available && (
                  <span style={{ fontSize:11, color: theme.textDim || theme.textMuted }}>
                    Browser unavailable: {applyReadiness.reason}
                  </span>
                )}
              </>
            )}
            {applyQueueMsg && <span style={{ fontSize:11, color:theme.accentText }}>{applyQueueMsg}</span>}
            {/* Run status summary badges */}
            {applyRuns.slice(0, 3).map(run => (
              <button key={run.id} onClick={() => loadApplyRunDetail(run.id)}
                style={{ display:"inline-flex", alignItems:"center", gap:5, border:`1px solid ${theme.border}`,
                         borderRadius:4, padding:"3px 8px", background:theme.surface,
                         color:theme.text, cursor:"pointer", fontSize:11 }}>
                <span style={{ width:6, height:6, borderRadius:"50%", flexShrink:0, background:
                  run.status === "completed" ? "#16a34a" :
                  run.status === "running"  ? theme.accent :
                  run.status === "queued"   ? "#d97706" : "#6b7280" }}/>
                {run.submittedCount}✓
                {run.heldCount > 0 && <span style={{ color:"#d97706" }}> {run.heldCount} review</span>}
                {run.failedCount > 0 && <span style={{ color:"#dc2626" }}> {run.failedCount} failed</span>}
                <span style={{ color:theme.textDim }}>↗</span>
              </button>
            ))}
            {applyReviewJobs.length > 0 && !applyQueue.length && (
              <button onClick={() => setApplyRunDetailOpen(true)}
                style={{ border:`1px solid #d97706`, borderRadius:4, padding:"3px 8px",
                         background:"#fef3c7", color:"#92400e", cursor:"pointer", fontSize:11, fontWeight:700 }}>
                {applyReviewJobs.length} need review ↗
              </button>
            )}
            {/* Awaiting approval is the highest-stakes thing on this bar — these applications are
                filled and one click from a real employer — so it gets its own CTA and does not hide
                behind "need review". */}
            {applyPending.length > 0 && !applyQueue.length && (
              <button onClick={() => { setApplyRunDetail(null); setApplyRunDetailOpen(true); }}
                style={{ border:`1px solid #2563eb`, borderRadius:4, padding:"3px 8px",
                         background:"#dbeafe", color:"#1e3a8a", cursor:"pointer", fontSize:11, fontWeight:800 }}>
                {applyPending.length} awaiting your approval ↗
              </button>
            )}
            {/* Answering is the actionable thing, so it gets its own CTA rather than hiding behind
                "need review". Accented because a hold only clears once these are answered. */}
            {applyQuestions.length > 0 && !applyQueue.length && (
              <button onClick={() => { setApplyRunDetail(null); setApplyRunDetailOpen(true); }}
                style={{ border:`1px solid ${theme.accent}`, borderRadius:4, padding:"3px 8px",
                         background:theme.accent, color:"#0f0f0f", cursor:"pointer", fontSize:11, fontWeight:800 }}>
                Answer {applyQuestions.length} question{applyQuestions.length === 1 ? "" : "s"} ↗
              </button>
            )}
          </div>
        )}

      </div>}
      {/* Hidden file input â€" always mounted so TopBar resume upload button works even when toolbar is hidden */}
      <input ref={fileRef} type="file" accept=".txt,.html,.md,.docx,.pdf"
        onChange={handleFile} style={{ display:"none" }}/>

      {/* â"€â"€ Resume Enhance modal â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */}
      {/* ── Apply Runs Review Modal ──────────────────────────────────── */}
      {applyRunDetailOpen && (
        <div
          onClick={e => { if (e.target === e.currentTarget) { setApplyRunDetailOpen(false); setApplyRunDetail(null); } }}
          style={{
            position:"fixed", inset:0, zIndex:700,
            background:"rgba(0,0,0,0.55)", display:"flex",
            alignItems:"flex-start", justifyContent:"center",
            paddingTop:48, overflowY:"auto",
          }}
        >
          <div style={{
            background:theme.modalSurface || theme.surface,
            borderRadius:8, width:"min(96vw, 820px)",
            maxHeight:"82vh", display:"flex", flexDirection:"column",
            border:`1px solid ${theme.border}`,
            boxShadow:"0 24px 64px rgba(0,0,0,0.4)",
          }}>
            {/* Header */}
            <div style={{
              padding:"16px 20px", borderBottom:`1px solid ${theme.border}`,
              display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0, gap:12,
            }}>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                             fontSize:18, letterSpacing:"0.06em", textTransform:"uppercase" }}>
                {applyRunDetail
                  ? `Apply Run #${applyRunDetail.run?.id} — ${applyRunDetail.run?.mode || "auto"}`
                  : "Jobs Needing Review"}
              </div>
              {applyRunDetail?.run && (
                <div style={{ display:"flex", gap:10, fontSize:11, flexWrap:"wrap" }}>
                  {applyRunDetail.run.submittedCount > 0 && (
                    <span style={{ color:"#16a34a", fontWeight:700 }}>✓ {applyRunDetail.run.submittedCount} submitted</span>
                  )}
                  {applyRunDetail.run.heldCount > 0 && (
                    <span style={{ color:"#d97706", fontWeight:700 }}>⏸ {applyRunDetail.run.heldCount} held</span>
                  )}
                  {applyRunDetail.run.failedCount > 0 && (
                    <span style={{ color:"#dc2626", fontWeight:700 }}>✗ {applyRunDetail.run.failedCount} failed</span>
                  )}
                  {applyRunDetail.run.startedAt && (
                    <span style={{ color:theme.textDim }}>
                      {new Date(applyRunDetail.run.startedAt).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              <button
                onClick={() => { setApplyRunDetailOpen(false); setApplyRunDetail(null); }}
                style={{ background:"transparent", border:"none", cursor:"pointer",
                          color:theme.textMuted, fontSize:20, lineHeight:1, padding:"0 4px",
                          marginLeft:"auto", flexShrink:0 }}>
                ×
              </button>
            </div>

            {/* Job list */}
            <div style={{ overflowY:"auto", flex:1, padding:"12px 20px", display:"flex", flexDirection:"column", gap:8 }}>

              {/* ── Queue-then-approve ──────────────────────────────────────────
                  These applications are already filled and have passed every gate. Approving one
                  submits it to a real employer and it cannot be recalled, so this surface is built
                  around reading before deciding: the row says how many answers were GUESSED, and
                  the detail view shows every answer with the rule that produced it, plus the exact
                  resume that will be attached. */}
              {!applyRunDetail && applyPending.length > 0 && (
                <div style={{ border:"1px solid #2563eb", borderRadius:6, padding:"12px 14px",
                              background:theme.surfaceHigh, display:"flex", flexDirection:"column", gap:10 }}>
                  <div>
                    <div style={{ fontWeight:800, fontSize:13, color:theme.text }}>
                      {applyPending.length} application{applyPending.length === 1 ? "" : "s"} waiting on you
                    </div>
                    <div style={{ fontSize:11, color:theme.textMuted, marginTop:2 }}>
                      Filled and checked, but nothing has been sent. Read one before you approve it —
                      approving submits it to the employer and cannot be undone.
                    </div>
                  </div>

                  {applyPending.map(p => {
                    const open = pendingDetail?.runJobId === p.runJobId;
                    const btn  = (bg, fg, bd) => ({
                      border:`1px solid ${bd}`, borderRadius:6, padding:"5px 10px", background:bg,
                      color:fg, fontWeight:800, fontSize:11.5,
                      cursor: pendingBusy ? "wait" : "pointer", opacity: pendingBusy ? 0.6 : 1,
                    });
                    return (
                      <div key={p.runJobId} style={{ borderTop:`1px solid ${theme.border}`, paddingTop:10,
                                                     display:"flex", flexDirection:"column", gap:6 }}>
                        <div style={{ display:"flex", alignItems:"flex-start", gap:8, flexWrap:"wrap" }}>
                          <span style={{ fontSize:12, fontWeight:700, color:theme.text, flex:1, minWidth:200 }}>
                            {p.company || "Unknown company"}
                            {p.title ? <span style={{ color:theme.textMuted, fontWeight:600 }}> — {p.title}</span> : null}
                          </span>
                          {/* A guess is the thing worth a human's attention; an exact mapping is not. */}
                          {p.guessCount > 0 && (
                            <span title="Answers matched by a fuzzy label match rather than an exact mapping. Read these."
                              style={{ fontSize:9, fontWeight:800, padding:"2px 7px", borderRadius:999,
                                       background:"#d9770622", color:"#d97706", whiteSpace:"nowrap", flexShrink:0 }}>
                              {p.guessCount} GUESSED
                            </span>
                          )}
                          <span style={{ fontSize:10, color:theme.textDim, whiteSpace:"nowrap" }}>
                            {p.answerCount} answer{p.answerCount === 1 ? "" : "s"}
                            {p.resume.atsScore != null ? ` · ATS ${p.resume.atsScore}` : ""}
                          </span>
                        </div>

                        <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
                          <button onClick={() => openPendingDetail(p.runJobId)}
                            style={btn(theme.surface, theme.text, theme.border)}>
                            {open ? "Hide" : "Review"} answers
                          </button>
                          {p.resume.available && (
                            <a href={artifactUrl(p.runJobId, "resume")} target="_blank" rel="noreferrer"
                              style={{ ...btn(theme.surface, theme.text, theme.border), textDecoration:"none" }}>
                              Resume PDF ↗
                            </a>
                          )}
                          {p.screenshotAvailable && (
                            <a href={artifactUrl(p.runJobId, "screenshot")} target="_blank" rel="noreferrer"
                              style={{ ...btn(theme.surface, theme.text, theme.border), textDecoration:"none" }}>
                              Filled form ↗
                            </a>
                          )}
                          <span style={{ flex:1 }}/>
                          <button onClick={() => decidePending([p.runJobId], false)} disabled={pendingBusy}
                            style={btn(theme.surface, "#dc2626", "#dc262655")}>
                            Reject
                          </button>
                          <button onClick={() => decidePending([p.runJobId], true)} disabled={pendingBusy}
                            style={btn("#2563eb", "#ffffff", "#2563eb")}>
                            Approve &amp; send
                          </button>
                        </div>

                        {open && (
                          <div style={{ border:`1px solid ${theme.border}`, borderRadius:6, padding:"8px 10px",
                                        background:theme.surface, display:"flex", flexDirection:"column", gap:4 }}>
                            {pendingDetail.loading ? (
                              <span style={{ fontSize:11, color:theme.textMuted }}>Loading…</span>
                            ) : (
                              <>
                                <div style={{ fontSize:10, color:theme.textMuted }}>
                                  This is exactly what will be sent. Anything marked GUESS was matched by label,
                                  not by an exact mapping.
                                </div>
                                {(pendingDetail.answers || [])
                                  .filter(a => !a.skipped && !a.policy_rejected)
                                  .map((a, i) => {
                                    const guess = a.provenance === "label_fuzzy";
                                    return (
                                      <div key={i} style={{ display:"flex", gap:8, alignItems:"baseline",
                                                            flexWrap:"wrap", fontSize:11,
                                                            borderTop: i ? `1px solid ${theme.border}` : "none",
                                                            paddingTop: i ? 4 : 0 }}>
                                        <span style={{ color:theme.textMuted, minWidth:150, flex:"0 1 auto" }}>
                                          {a.label || a.name || a.field_id}
                                        </span>
                                        <span style={{ color:theme.text, fontWeight:700, flex:1, minWidth:120,
                                                       wordBreak:"break-word" }}>
                                          {String(a.value ?? "")}
                                        </span>
                                        <span style={{ fontSize:9, fontWeight:800, padding:"1px 6px", borderRadius:999,
                                                       whiteSpace:"nowrap",
                                                       background: guess ? "#d9770622" : `${theme.border}66`,
                                                       color: guess ? "#d97706" : theme.textDim }}>
                                          {guess ? "GUESS" : (a.provenance || "").replace(/_/g, " ") || "—"}
                                        </span>
                                      </div>
                                    );
                                  })}
                                {(pendingDetail.answers || []).filter(a => !a.skipped && !a.policy_rejected).length === 0 && (
                                  <span style={{ fontSize:11, color:theme.textMuted }}>No answers recorded.</span>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", paddingTop:4 }}>
                    {/* Bulk approval is the one place a stray click could send several real
                        applications at once, so it takes two deliberate steps. */}
                    {applyPending.length > 1 && (
                      confirmApproveAll ? (
                        <>
                          <span style={{ fontSize:11, color:"#dc2626", fontWeight:700 }}>
                            Send all {applyPending.length} to their employers?
                          </span>
                          <button onClick={() => decidePending(applyPending.map(p => p.runJobId), true)}
                            disabled={pendingBusy}
                            style={{ border:"none", borderRadius:6, padding:"6px 12px", background:"#dc2626",
                                     color:"#fff", fontWeight:800, fontSize:12,
                                     cursor: pendingBusy ? "wait" : "pointer" }}>
                            Yes, send all
                          </button>
                          <button onClick={() => setConfirmApproveAll(false)} disabled={pendingBusy}
                            style={{ border:`1px solid ${theme.border}`, borderRadius:6, padding:"6px 12px",
                                     background:theme.surface, color:theme.text, fontWeight:700, fontSize:12,
                                     cursor:"pointer" }}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button onClick={() => setConfirmApproveAll(true)} disabled={pendingBusy}
                          style={{ border:`1px solid ${theme.border}`, borderRadius:6, padding:"6px 12px",
                                   background:theme.surface, color:theme.text, fontWeight:700, fontSize:12,
                                   cursor: pendingBusy ? "wait" : "pointer" }}>
                          Approve all {applyPending.length}
                        </button>
                      )
                    )}
                    {pendingMsg && (
                      <span style={{ fontSize:11, color:theme.accentText }}>{pendingMsg}</span>
                    )}
                  </div>
                </div>
              )}

              {/* ── Validation-correction loop ──────────────────────────────────
                  A hold used to end the run. These are the fields the resolver refused to fill on
                  its own; answering them is what turns the hold into a completed application. The
                  answers are stored as custom_answers, which is the only exact-by-construction
                  resolution path — so on retry they are used verbatim, never inferred. */}
              {!applyRunDetail && applyQuestions.length > 0 && (
                <div style={{ border:`1px solid ${theme.accent}`, borderRadius:6, padding:"12px 14px",
                              background:theme.surfaceHigh, display:"flex", flexDirection:"column", gap:10 }}>
                  <div>
                    <div style={{ fontWeight:800, fontSize:13, color:theme.text }}>
                      Answer {applyQuestions.length} question{applyQuestions.length === 1 ? "" : "s"}
                      {applyQuestionMeta.blockedJobs > 0 &&
                        ` to unblock ${applyQuestionMeta.blockedJobs} application${applyQuestionMeta.blockedJobs === 1 ? "" : "s"}`}
                    </div>
                    <div style={{ fontSize:11, color:theme.textMuted, marginTop:2 }}>
                      Nothing here was guessed on your behalf — these are the fields we would not fill without you.
                      {applyQuestionMeta.eligibilityCount > 0 &&
                        ` ${applyQuestionMeta.eligibilityCount} of them are attestations to the employer.`}
                    </div>
                  </div>

                  {applyQuestions.map(q => {
                    const isEligibility = !!q.eligibility;
                    const isConfirm     = q.reason === "low_confidence";
                    const value         = questionDrafts[q.question] ?? "";
                    const setValue      = v => setQuestionDrafts(prev => ({ ...prev, [q.question]: v }));
                    const inputStyle    = { width:"100%", padding:"6px 8px", fontSize:12, borderRadius:4,
                                            border:`1px solid ${theme.border}`, background:theme.surface,
                                            color:theme.text, boxSizing:"border-box" };
                    return (
                      <div key={q.question} style={{ borderTop:`1px solid ${theme.border}`, paddingTop:10,
                                                     display:"flex", flexDirection:"column", gap:5 }}>
                        <div style={{ display:"flex", alignItems:"flex-start", gap:8, flexWrap:"wrap" }}>
                          <span style={{ fontSize:12, fontWeight:700, color:theme.text, flex:1, minWidth:220 }}>
                            {q.question}
                          </span>
                          {isEligibility && (
                            <span title="Submitted to the employer as your own statement. Never inferred from your profile."
                              style={{ fontSize:9, fontWeight:800, padding:"2px 7px", borderRadius:999,
                                       background:"#dc262622", color:"#dc2626", whiteSpace:"nowrap", flexShrink:0 }}>
                              ATTESTATION
                            </span>
                          )}
                          {q.answered && (
                            <span style={{ fontSize:9, fontWeight:700, padding:"2px 7px", borderRadius:999,
                                           background:"#16a34a22", color:"#16a34a", whiteSpace:"nowrap", flexShrink:0 }}>
                              SAVED
                            </span>
                          )}
                        </div>

                        {isEligibility && (
                          <div style={{ fontSize:10, color:"#dc2626" }}>
                            You are stating this to the employer yourself. We never answer it from your profile.
                          </div>
                        )}
                        {isConfirm && (
                          <div style={{ fontSize:10, color:theme.textMuted }}>
                            We had a guess{q.proposed ? ` — "${q.proposed}"` : ""} but were not confident enough to send it.
                            Confirm or correct it.
                          </div>
                        )}

                        {Array.isArray(q.options) && q.options.length > 0 ? (
                          <select value={value} onChange={e => setValue(e.target.value)} style={inputStyle}>
                            <option value="">Select…</option>
                            {q.options.map(o => (
                              <option key={o.value} value={o.value}>{o.label || o.value}</option>
                            ))}
                          </select>
                        ) : q.type === "checkbox" || q.type === "toggle" ? (
                          <select value={value} onChange={e => setValue(e.target.value)} style={inputStyle}>
                            <option value="">Select…</option>
                            <option value="Yes">Yes</option>
                            <option value="No">No</option>
                          </select>
                        ) : q.type === "text_area" ? (
                          <textarea rows={2} value={value} onChange={e => setValue(e.target.value)} style={inputStyle}/>
                        ) : (
                          <input value={value} onChange={e => setValue(e.target.value)} style={inputStyle}/>
                        )}

                        {(q.blocking || []).length > 0 && (
                          <div style={{ fontSize:10, color:theme.textDim }}>
                            Blocks: {q.blocking.slice(0, 3).map(b => b.company || b.title || b.jobId).join(", ")}
                            {q.blocking.length > 3 ? ` +${q.blocking.length - 3} more` : ""}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", paddingTop:4 }}>
                    <button onClick={() => submitApplyAnswers(true)} disabled={answersSaving}
                      style={{ border:"none", borderRadius:6, padding:"6px 12px", background:theme.accent,
                               color:"#0f0f0f", fontWeight:800, fontSize:12,
                               cursor: answersSaving ? "wait" : "pointer", opacity: answersSaving ? 0.6 : 1 }}>
                      {answersSaving ? "Saving…" : "Save & retry"}
                    </button>
                    <button onClick={() => submitApplyAnswers(false)} disabled={answersSaving}
                      style={{ border:`1px solid ${theme.border}`, borderRadius:6, padding:"6px 12px",
                               background:theme.surface, color:theme.text, fontWeight:700, fontSize:12,
                               cursor: answersSaving ? "wait" : "pointer", opacity: answersSaving ? 0.6 : 1 }}>
                      Save only
                    </button>
                    {answersMsg && (
                      <span style={{ fontSize:11, color:theme.accentText }}>{answersMsg}</span>
                    )}
                  </div>
                </div>
              )}

              {/* Sign in once, and everything queued behind that gate is ready. The count is the
                  offer: a ten-second sign-in that releases seven applications is a different
                  product from seven separate reviews. Only shown on the cross-run view, because a
                  single run's detail is about that run. */}
              {!applyRunDetail && applyGatePortals.length > 0 && (
                <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:14 }}>
                  {applyGatePortals.map(p => (
                    <div key={p.origin} style={{
                      border:`1px solid ${theme.border}`, borderRadius:8, padding:"10px 14px",
                      background:theme.surfaceHigh, display:"flex", alignItems:"center", gap:10 }}>
                      <span style={{ fontSize:9, fontWeight:700, padding:"1px 7px", borderRadius:999,
                                     background:"#dbeafe", color:"#1e40af", whiteSpace:"nowrap" }}>
                        {p.gateReasons?.includes("captcha_required") ? "verify" : "sign in"}
                      </span>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:12.5, fontWeight:700, color:theme.text,
                                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          Sign in to {p.host} once
                        </div>
                        <div style={{ fontSize:11, color:theme.textMuted }}>
                          {p.count} application{p.count === 1 ? "" : "s"} ready · reviewed one at a time
                        </div>
                      </div>
                      <span style={{ fontSize:18, fontWeight:800, color:theme.text }}>{p.count}</span>
                    </div>
                  ))}
                </div>
              )}

              {(applyRunDetail ? applyRunDetail.jobs : applyReviewJobs).length === 0 &&
               (applyRunDetail || (applyQuestions.length === 0 && applyPending.length === 0)) && (
                <div style={{ padding:"24px 0", textAlign:"center", color:theme.textMuted, fontSize:12 }}>
                  No jobs in this run yet.
                </div>
              )}
              {(applyRunDetail ? applyRunDetail.jobs : applyReviewJobs).map(job => {
                // held_gate reads as "Sign in", not "Review" and not "Failed". The portal wants an
                // account or a CAPTCHA before it will take an application, so the next move is the
                // candidate's and it is a specific one — which is a different message from "check
                // these answers". Blue rather than amber for the same reason: nothing is wrong here.
                const statusColor = job.status === "submitted" ? "#16a34a"
                  : job.status === "held_review" ? "#d97706"
                  : job.status === "held_gate" ? "#2563eb"
                  : job.status === "failed" ? "#dc2626"
                  : job.status === "running" ? theme.accent
                  : theme.textMuted;
                const statusLabel = job.status === "submitted" ? "Submitted"
                  : job.status === "held_review" ? "Review"
                  : job.status === "held_gate" ? "Sign in"
                  : job.status === "failed" ? "Failed"
                  : job.status === "running" ? "Running"
                  : job.status === "queued" ? "Queued"
                  : job.status || "—";
                return (
                  <div key={job.id} style={{
                    border:`1px solid ${theme.border}`, borderRadius:6,
                    padding:"10px 14px", display:"flex", flexDirection:"column", gap:5,
                    background:theme.surfaceHigh,
                  }}>
                    {/* title / company / status */}
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
                      <div>
                        {/* Falls back to the job id: a posting expired by the 7-day cleanup leaves
                            the application behind, and a row identified by nothing at all is what
                            made this list unreadable. */}
                        <span style={{ fontWeight:700, fontSize:13, color:theme.text }}>
                          {job.title || job.jobId || "—"}
                        </span>
                        {job.company && (
                          <span style={{ fontSize:12, color:theme.textMuted, marginLeft:8 }}>{job.company}</span>
                        )}
                        {!job.title && job.jobId && (
                          <span style={{ fontSize:10, color:theme.textDim, marginLeft:8 }}>
                            (posting no longer on the board)
                          </span>
                        )}
                      </div>
                      <span style={{
                        fontSize:10, fontWeight:700, padding:"2px 8px",
                        borderRadius:999, background:`${statusColor}22`,
                        color:statusColor, whiteSpace:"nowrap", flexShrink:0,
                      }}>
                        {statusLabel}
                      </span>
                    </div>
                    {/* reason + ATS score */}
                    {(job.reasonCode || job.atsScore != null) && (
                      <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                        {job.reasonCode && (
                          <span style={{ fontSize:11, color:statusColor, fontWeight:600 }}>
                            {job.reasonCode.replace(/_/g, " ")}
                            {job.reasonDetail ? ` — ${job.reasonDetail}` : ""}
                          </span>
                        )}
                        {job.atsScore != null && (
                          <span style={{
                            fontSize:10, fontWeight:700, padding:"1px 6px", borderRadius:999,
                            background: job.atsScore >= 80 ? "#dcfce7" : job.atsScore >= 60 ? "#fef9c3" : "#fee2e2",
                            color: job.atsScore >= 80 ? "#166534" : job.atsScore >= 60 ? "#854d0e" : "#991b1b",
                          }}>
                            ATS {job.atsScore}
                          </span>
                        )}
                      </div>
                    )}
                    {/* timestamps */}
                    {(job.startedAt || job.finishedAt) && (
                      <div style={{ fontSize:10, color:theme.textDim }}>
                        {job.startedAt && `Started ${new Date(job.startedAt).toLocaleTimeString()}`}
                        {job.startedAt && job.finishedAt && " · "}
                        {job.finishedAt && `Finished ${new Date(job.finishedAt).toLocaleTimeString()}`}
                        {" · "}Attempts: {job.attemptCount || 1}
                      </div>
                    )}
                    {/* What was actually sent. The audit trail has recorded the resume artifact and
                        the end-of-attempt screenshot all along; nothing linked them, so there was
                        no way to tell whether a resume had even been generated. */}
                    <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
                      {job.resumeAvailable ? (
                        <a href={artifactUrl(job.id, "resume")} target="_blank" rel="noreferrer"
                          onClick={e => e.stopPropagation()}
                          style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:999,
                                   border:`1px solid ${theme.border}`, background:theme.surface,
                                   color:theme.text, textDecoration:"none", whiteSpace:"nowrap" }}>
                          Resume PDF ↗
                        </a>
                      ) : (
                        <span title="No resume artifact was recorded for this application."
                          style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:999,
                                   background:`${theme.border}55`, color:theme.textDim, whiteSpace:"nowrap" }}>
                          no resume generated
                        </span>
                      )}
                      {job.screenshotAvailable && (
                        <a href={artifactUrl(job.id, "screenshot")} target="_blank" rel="noreferrer"
                          onClick={e => e.stopPropagation()}
                          style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:999,
                                   border:`1px solid ${theme.border}`, background:theme.surface,
                                   color:theme.text, textDecoration:"none", whiteSpace:"nowrap" }}>
                          Filled form ↗
                        </a>
                      )}
                      {job.status === "submitted" && (
                        <span title={job.submitEvidence || ""}
                          style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:999,
                                   background: job.submitVerified ? "#16a34a22" : "#d9770622",
                                   color: job.submitVerified ? "#16a34a" : "#d97706", whiteSpace:"nowrap" }}>
                          {job.submitVerified ? "submission verified" : "unverified submit"}
                        </span>
                      )}
                    </div>
                    {/* apply URL */}
                    {job.applyUrl && (
                      <a href={job.applyUrl} target="_blank" rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        style={{ fontSize:10, color:theme.accent, textDecoration:"none", wordBreak:"break-all" }}>
                        {job.applyUrl.length > 90 ? job.applyUrl.slice(0, 90) + "…" : job.applyUrl}
                      </a>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Logs section — run detail only */}
            {applyRunDetail?.logs?.length > 0 && (
              <details style={{ flexShrink:0, borderTop:`1px solid ${theme.border}` }}>
                <summary style={{
                  padding:"10px 20px", fontSize:11, fontWeight:700, cursor:"pointer",
                  color:theme.textMuted, textTransform:"uppercase", letterSpacing:"0.06em",
                  userSelect:"none", listStyle:"none",
                }}>
                  ▸ Logs ({applyRunDetail.logs.length})
                </summary>
                <div style={{
                  maxHeight:200, overflowY:"auto", padding:"8px 20px 12px",
                  fontFamily:"monospace", fontSize:10, display:"flex", flexDirection:"column", gap:3,
                }}>
                  {applyRunDetail.logs.map(log => (
                    <div key={log.id} style={{
                      color: log.level === "error" ? "#dc2626" : log.level === "warn" ? "#d97706" : theme.textMuted,
                    }}>
                      <span style={{ color:theme.textDim, marginRight:6 }}>
                        {log.createdAt ? new Date(log.createdAt).toLocaleTimeString() : ""}
                      </span>
                      <span style={{
                        color: log.level === "error" ? "#dc2626" : log.level === "warn" ? "#d97706" : theme.accent,
                        marginRight:6, fontWeight:700,
                      }}>
                        [{log.event || log.level}]
                      </span>
                      {/* Which application this line is about. Without it a run's log is a list of
                          statements like "7 fields filled" with no way to tell which job or site
                          produced them. */}
                      {(log.company || log.title || log.jobId) && (
                        <span style={{ color:theme.text, marginRight:6 }}>
                          {log.company || log.title || log.jobId}
                          {log.company && log.title ? ` — ${log.title}` : ""}
                          {":"}
                        </span>
                      )}
                      {log.message}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* Footer */}
            <div style={{
              padding:"12px 20px", borderTop:`1px solid ${theme.border}`, flexShrink:0,
              display:"flex", justifyContent:"flex-end",
            }}>
              <button
                onClick={() => { setApplyRunDetailOpen(false); setApplyRunDetail(null); }}
                style={{
                  padding:"8px 20px", borderRadius:4, fontWeight:700, fontSize:12,
                  background:"transparent", color:theme.textMuted,
                  border:`1.5px solid ${theme.border}`, cursor:"pointer",
                  fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.06em",
                  textTransform:"uppercase",
                }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {enhanceModalOpen && enhanceResult && (
        <div style={{
          position:"fixed", inset:0, zIndex:600,
          background:"rgba(0,0,0,0.6)", display:"flex", alignItems:"center", justifyContent:"center",
        }}>
          <div style={{
            background:theme.modalSurface || theme.surface, borderRadius:8, width:"min(92vw, 760px)",
            maxHeight:"85vh", overflowY:"auto", padding:0,
            border:`1px solid ${theme.border}`, boxShadow:"0 24px 64px rgba(0,0,0,0.35)",
          }}>
            {/* Header */}
            <div style={{ padding:"20px 24px 16px", borderBottom:`1px solid ${theme.border}` }}>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                             fontSize:20, letterSpacing:"0.06em", textTransform:"uppercase" }}>
                Resume Enhancement
              </div>
              {enhanceResult.delta != null && (
                <div style={{ fontSize:12, color:theme.textMuted, marginTop:4 }}>
                  ATS score improved by
                  <span style={{ color: enhanceResult.delta > 0 ? "#16a34a" : "#dc2626",
                                  fontWeight:700, marginLeft:4 }}>
                    {enhanceResult.delta > 0 ? "+" : ""}{enhanceResult.delta} points
                  </span>
                  {" "}({enhanceResult.original?.atsScore ?? "-"}{" -> "}{enhanceResult.enhanced?.atsScore ?? "-"})
                </div>
              )}
            </div>
            {/* Side-by-side comparison */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:0 }}>
              <div style={{ padding:"16px 20px", borderRight:`1px solid ${theme.border}` }}>
                <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                               letterSpacing:"0.06em", color:theme.textMuted, marginBottom:8 }}>
                  Original
                </div>
                <pre style={{ fontSize:11, color:theme.text, whiteSpace:"pre-wrap",
                               wordBreak:"break-word", maxHeight:340, overflowY:"auto",
                               fontFamily:"monospace", margin:0 }}>
                  {enhanceResult.original?.text}
                </pre>
              </div>
              <div style={{ padding:"16px 20px" }}>
                <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase",
                               letterSpacing:"0.06em", color:"#16a34a", marginBottom:8 }}>
                  Enhanced
                </div>
                <pre style={{ fontSize:11, color:theme.text, whiteSpace:"pre-wrap",
                               wordBreak:"break-word", maxHeight:340, overflowY:"auto",
                               fontFamily:"monospace", margin:0 }}>
                  {enhanceResult.enhanced?.text}
                </pre>
              </div>
            </div>
            {/* Footer */}
            <div style={{ padding:"16px 24px", borderTop:`1px solid ${theme.border}`,
                           display:"flex", flexDirection:"column", gap:10, alignItems:"center" }}>
              <div style={{ display:"flex", gap:10, width:"100%", justifyContent:"center" }}>
                <button onClick={handleAdoptEnhanced}
                  style={{
                    padding:"10px 24px", borderRadius:4, fontWeight:800, fontSize:13,
                    background:theme.accent, color:"#fff", border:"none", cursor:"pointer",
                    fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.06em",
                    textTransform:"uppercase",
                  }}>
                  Adopt Enhanced Version
                </button>
                <button onClick={() => setEnhanceModalOpen(false)}
                  style={{
                    padding:"10px 24px", borderRadius:4, fontWeight:800, fontSize:13,
                    background:"transparent", color:theme.textMuted,
                    border:`1.5px solid ${theme.border}`, cursor:"pointer",
                    fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.06em",
                    textTransform:"uppercase",
                  }}>
                  Keep Original
                </button>
              </div>
              <div style={{ fontSize:10, color:theme.textDim, textAlign:"center", maxWidth:480 }}>
                This is your one-time free enhancement. Your choice here does not affect whether it has been used.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* â"€â"€ Body: responsive layout â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */}

      {/* Company reuse modal (Task 6) */}
      {companyReuseTarget && (
        <CompanyReuseModal
          company={companyReuseTarget.job.company}
          theme={theme}
          onUseExisting={() => {
            const { job, priorEntry } = companyReuseTarget;
            setCompanyReuseTarget(null);
            const key = job.jobId;
            setGenerated(p => ({ ...p, [key]: priorEntry }));
            openSandbox({ ...priorEntry, company: job.company, title: job.title });
            if (priorEntry.atsReport || priorEntry.atsScore != null) {
              openAtsPanel({ score: priorEntry.atsScore, report: priorEntry.atsReport, company: job.company, title: job.title });
            }
          }}
          onGenerateNew={() => {
            const { job, tool } = companyReuseTarget;
            setCompanyReuseTarget(null);
            generateActual(job, false, true, tool);
          }}
          onCancel={() => setCompanyReuseTarget(null)}
        />
      )}

      {/* â"€â"€ MOBILE / TABLET: single-pane + bottom nav â"€â"€ */}
      {setupBlock ? (
        <SetupGateNotice theme={theme} {...setupBlock} />
      ) : isMobile && (
        <div style={{ flex:1, minHeight:0, minWidth:0, display:"flex", flexDirection:"column", overflow:"hidden", position:"relative" }}>
          {/* Active pane */}
          <div style={{ flex:1, minHeight:0, minWidth:0, overflow:"hidden", display:"flex", flexDirection:"column" }}>
            {mobilePane === "jobs" && (
              <JobsColumn
                jobs={displayJobs} scraping={scraping} scrapeError={scrapeError}
                onClearScrapeError={() => setScrapeError("")}
                pollStatus={pollStatus}
                onRetryPoll={handlePullRefresh}
                generated={generated} loading={loading}
                applyMode={applyMode} canUseGenerate={canUseGenerate} canUseAPlusResume={canUseAPlusResume}
                theme={theme}
                totalPages={totalPages} currentPage={currentPage} isLastPage={isLastPage}
                generate={generate} openSandbox={openSandbox} exportAndTrack={exportAndTrack}
                visitUrl={visitUrl} toggleStar={toggleStar} openAtsPanel={openAtsPanel}
                goPage={goPage} onPullRefresh={handlePullRefresh}
                setMobilePane={setMobilePane} isMobile={isMobile}
                onJobSelect={handleJobSelect} selectedJobId={selectedJob?.jobId}
                activeFilterCount={activeFilterCount}
                onClearFilters={clearAllFilters}
                searchActive={!!localSearch.trim()}
                profileName={activeDomainProfile?.profile_name || null}
                cardTier={1}
              />
            )}
            {mobilePane === "editor" && (
              <SandboxPanel entry={sandbox} onClose={closeSandbox}
                onSave={saveSandboxHtml} onExport={exportAndTrack}/>
            )}
            {mobilePane === "ats" && (
              <div style={{ flex:1, minHeight:0, minWidth:0, overflowY:"auto" }}>
                <div style={{ display:"flex", borderBottom:`1px solid ${theme.border}`,
                              padding:"0 14px", flexShrink:0 }}>
                  {[["ats","ATS Report"],["history",`History${genCount>0?` (${genCount})`:""}`]].map(([id,lbl]) => (
                    <button key={id} onClick={() => setRightTab(id)}
                      style={{
                        padding:"10px 16px", border:"none", background:"transparent",
                        fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                        fontSize:13, letterSpacing:"0.06em", textTransform:"uppercase",
                        color: rightTab===id ? theme.text : theme.textDim,
                        cursor:"pointer", position:"relative",
                        borderBottom: rightTab===id ? `2px solid ${theme.accent}` : "2px solid transparent",
                      }}>
                      {lbl}
                    </button>
                  ))}
                </div>
                {rightTab === "ats" && <ATSPanel report={activeAts?.report} score={activeAts?.score} jobId={selectedJob?.jobId} resumeText={resumeText} activeProfileId={activeProfileId}/>}
                {rightTab === "history" && (
                  <HistoryList generated={generated}
                    theme={theme}
                    onOpen={e => {
                      openSandbox(e);
                      openAtsPanel({ score:e.atsScore, report:e.atsReport, company:e.company, title:e.title||e.role });
                    }}
                    onExport={exportAndTrack}/>
                )}
              </div>
            )}
          </div>
          {/* Bottom nav */}
          <div style={{ display:"flex", borderTop:`1px solid ${theme.border}`,
                        background:theme.surface, flexShrink:0 }}>
            {[
              { id:"jobs",   label:"Jobs",   icon:"Jobs" },
              { id:"editor", label:"Resume", icon:"Edit" },
              { id:"ats",    label:"ATS",    icon:"ATS" },
            ].map(({ id, label, icon }) => (
              <button key={id} onClick={() => setMobilePane(id)}
                style={{
                  flex:1, padding:"10px 0", border:"none", cursor:"pointer",
                  background:"transparent", display:"flex", flexDirection:"column",
                  alignItems:"center", gap:2,
                  color: mobilePane===id ? theme.accent : theme.textMuted,
                  fontSize:10, fontWeight:700,
                }}>
                <span style={{ fontSize:18 }}>{icon}</span>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* â"€â"€ PORTRAIT / LAPTOP + WIDE: resizable panels (react-resizable-panels) â"€â"€ */}
      {!setupBlock && (isWide || (isPortrait && !isMobile)) && (
        <div style={{ flex:1, minHeight:0, minWidth:0, overflow:"hidden", display:"flex" }}>
        <PanelGroup orientation="horizontal" style={{ flex: 1, minHeight:0, minWidth:0, overflow: "hidden" }}>

          {/* PANEL A - Jobs list (always visible, full width - detail in portal drawer) */}
          <Panel
            ref={jobsPanelRef}
            defaultSize={100}
            minSize={6}
            style={{ display: "flex", flexDirection: "column", minHeight:0, minWidth:0, overflow: "hidden" }}>
            <JobsColumn
              jobs={displayJobs} scraping={scraping} scrapeError={scrapeError}
              onClearScrapeError={() => setScrapeError("")}
              pollStatus={pollStatus}
              onRetryPoll={handlePullRefresh}
              generated={generated} loading={loading}
              applyMode={applyMode} canUseGenerate={canUseGenerate} canUseAPlusResume={canUseAPlusResume}
              theme={theme}
              totalPages={totalPages} currentPage={currentPage} isLastPage={isLastPage}
              generate={generate} openSandbox={openSandbox} exportAndTrack={exportAndTrack}
              visitUrl={visitUrl} toggleStar={toggleStar} toggleDislike={toggleDislike}
              openAtsPanel={openAtsPanel}
              goPage={goPage} onPullRefresh={handlePullRefresh}
              setMobilePane={setMobilePane} isMobile={isMobile}
              compact={false} selectedJobId={selectedJob?.jobId} onJobSelect={handleJobSelect}
              activeFilterCount={activeFilterCount}
              onClearFilters={clearAllFilters}
              searchActive={!!localSearch.trim()}
              profileName={activeDomainProfile?.profile_name || null}
              cardTier={effectiveTier}
              containerRef={jobsPanelElementRef}
            />
          </Panel>

          {/* PANEL C â€" Sandbox / Resume */}
          {/* No maxSize cap â€" CSS scale transform in SandboxPanel handles wider-than-A4 display. */}
          {sandboxOpen && (
            <>
              <ResizeHandle theme={theme} />
              <Panel
                ref={sandboxPanelRef}
                defaultSize={40}
                minSize={10}
                style={{ display: "flex", flexDirection: "column", minHeight:0, minWidth:0, overflow: "hidden",
                         borderLeft: `1px solid ${theme.border}` }}>
                <SandboxPanel entry={sandbox} onClose={closeSandbox}
                  onSave={saveSandboxHtml} onExport={exportAndTrack}/>
              </Panel>
            </>
          )}

          {/* PANEL D â€" ATS + History */}
          {rightPanelOpen && (
            <>
              <ResizeHandle theme={theme} />
              <Panel
                ref={atsPanelRef}
                defaultSize={20}
                minSize={10}
                style={{ display: "flex", flexDirection: "column", minHeight:0, minWidth:0, overflow: "hidden",
                         borderLeft: `1px solid ${theme.border}` }}>
                <div style={{ display:"flex", borderBottom:`1px solid ${theme.border}`,
                              padding:"0 14px", flexShrink:0, alignItems:"center" }}>
                  {[["ats","ATS Report"],["history",`History${genCount>0?` (${genCount})`:""}`]].map(([id,lbl]) => (
                    <button key={id} onClick={() => setRightTab(id)}
                      style={{
                        padding:"10px 16px", border:"none", background:"transparent",
                        fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                        fontSize:13, letterSpacing:"0.06em", textTransform:"uppercase",
                        color: rightTab===id ? theme.text : theme.textDim,
                        cursor:"pointer",
                        borderBottom: rightTab===id ? `2px solid ${theme.accent}` : "2px solid transparent",
                      }}>
                      {lbl}
                    </button>
                  ))}
                  <button onClick={closeAtsPanel} title="Close panel"
                    style={{ marginLeft:"auto", background:"none", border:"none", cursor:"pointer",
                             color:theme.textMuted, fontSize:16, padding:"4px 6px" }}>x</button>
                </div>
                <div style={{ flex:1, minHeight:0, minWidth:0, overflowY:"auto" }}>
                  {rightTab === "ats" && <ATSPanel report={activeAts?.report} score={activeAts?.score} jobId={selectedJob?.jobId} resumeText={resumeText} activeProfileId={activeProfileId}/>}
                  {rightTab === "history" && (
                    <HistoryList generated={generated} theme={theme}
                      onOpen={e => {
                        openSandbox(e);
                        openAtsPanel({ score:e.atsScore, report:e.atsReport, company:e.company, title:e.title||e.role });
                      }}
                      onExport={exportAndTrack}/>
                  )}
                </div>
              </Panel>
            </>
          )}

        </PanelGroup>
        </div>
      )}

      {attribution.length > 0 && (
        <div style={{ padding:"8px 16px", display:"flex", gap:12, flexWrap:"wrap" }}>
          {attribution.map(a => (
            <a key={a.name} href={a.url} target="_blank" rel="noopener noreferrer"
               style={{ fontSize:11, color:theme.textMuted, textDecoration:"none", opacity:0.7 }}>
              Jobs powered by {a.name}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// â"€â"€ Drag resize handle â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function ResizeHandle({ theme: themeProp }) {
  const { theme: t } = useTheme();
  const theme = themeProp || t;
  const [active, setActive] = useState(false);
  return (
    <PanelResizeHandle
      style={{
        width: 7, flexShrink: 0, cursor: "col-resize",
        display: "flex", alignItems: "stretch", background: "transparent",
        zIndex: 10,
      }}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
    >
      <div style={{
        width: active ? 3 : 2,
        margin: "0 auto",
        background: active ? theme.accent : theme.border,
        transition: "all 0.15s ease",
        borderRadius: 2,
      }} />
    </PanelResizeHandle>
  );
}

// â"€â"€ Jobs column (shared across layout modes) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function JobsColumn({ jobs, scraping, scrapeError, onClearScrapeError,
                      pollStatus, onRetryPoll,
                      generated, loading, applyMode, canUseGenerate, canUseAPlusResume,
                      theme, totalPages, currentPage, isLastPage,
                      generate, openSandbox, exportAndTrack,
                      visitUrl, toggleStar, toggleDislike, openAtsPanel,
                      goPage, onPullRefresh,
                      setMobilePane, isMobile,
                      compact, selectedJobId, onJobSelect,
                      activeFilterCount = 0, onClearFilters,
                      searchActive = false, profileName = null,
                      cardTier = 1, containerRef }) {
  const [pageInput, setPageInput] = useState("");
  const shouldShowEmptyState = jobs.length === 0 && !scraping;
  // An empty board has two completely different causes and only ever admitted to one of them.
  // "Search for a role above" is right when nothing is filtered; when filters ARE narrowing the
  // board it is a lie that costs the user their next move — they go and search again instead of
  // widening the filter that hid everything. It is also the exact reading that let the NULL-IN
  // outage look like an ordinary empty board for as long as it did, which is why an empty board
  // now has to say which of the two it is.
  // localSearch counts toward "filtered" here even though it is not one of the drawer's filters:
  // it narrows the board server-side exactly like they do, and an empty board caused only by a
  // stale search term used to fall through to "Search for a role above" — advice to do the very
  // thing that was hiding the jobs. onClearFilters clears the search too, so the count and the
  // button agree.
  const narrowingCount      = activeFilterCount + (searchActive ? 1 : 0);
  const emptyBecauseFiltered = shouldShowEmptyState && narrowingCount > 0;
  // Third case: nothing is narrowing the board and it is still empty. See RoleScopedEmptyState.
  const emptyBecauseRole     = shouldShowEmptyState && narrowingCount === 0 && !!profileName;
  const visiblePages = buildVisiblePageItems(currentPage, totalPages);
  useEffect(() => {
    setPageInput(String(currentPage || ""));
  }, [currentPage]);
  const commitPageJump = () => {
    if (!totalPages) return;
    const parsed = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(parsed)) return;
    const nextPage = Math.min(totalPages, Math.max(1, parsed));
    goPage(nextPage);
    setPageInput(String(nextPage));
  };
  return (
    <div ref={containerRef} style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden",
                  background: `linear-gradient(160deg, ${theme.accentMuted}55 0%, ${theme.bg} 55%)` }}>
      {shouldShowEmptyState ? (
        emptyBecauseFiltered
          ? <FilteredEmptyState theme={theme} count={narrowingCount} onClearFilters={onClearFilters}/>
          : emptyBecauseRole
            ? <RoleScopedEmptyState theme={theme} profileName={profileName}/>
            : <EmptyState theme={theme}/>
      ) : (
        <PullToRefresh onRefresh={onPullRefresh} refreshing={scraping} theme={theme}>

          {/* Scrape error banner */}
          {scrapeError && (
            <div style={{ margin:"8px 16px 0", padding:"10px 14px", borderRadius:4,
                          background:"#fee2e2", border:"1px solid #fca5a5",
                          display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <span style={{ fontSize:12, color:"#991b1b" }}>
                Error: {scrapeError}
              </span>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                {pollStatus === "error" && onRetryPoll && (
                  <button onClick={onRetryPoll}
                    style={{ background:"none", border:`1px solid #991b1b`, borderRadius:4,
                             cursor:"pointer", color:"#991b1b", fontSize:11, padding:"2px 8px",
                             fontWeight:700 }}>
                    Retry
                  </button>
                )}
                <button onClick={onClearScrapeError} style={{ background:"none", border:"none",
                  cursor:"pointer", color:"#991b1b", fontSize:14 }}>x</button>
              </div>
            </div>
          )}

          {/* Job cards â€" always rendered (even when scraping) */}
          {jobs.map(job => {
            const key = job.jobId, g = generated[key],
                  done = !!g?.html, st = loading[key];
            return (
              <JobCard
                key={key} job={job} g={g} done={done} st={st}
                applyMode={applyMode}
                canUseGenerate={canUseGenerate} canUseAPlusResume={canUseAPlusResume}
                theme={theme}
                showDislike={true}
                showApplyButton={!compact}
                compact={compact}
                selected={selectedJobId === key}
                onSelect={onJobSelect ? () => onJobSelect(job) : undefined}
                cardTier={cardTier}
                onGenerate={force => generate(job, force)}
                onAPlusResume={force => generate(job, force, "a_plus_resume")}
                onViewSandbox={() => {
                  const entry = {...g, company:g.company||job.company, title:g.title||job.title};
                  openSandbox(entry);
                  openAtsPanel(buildAtsPayload(job, g));
                }}
                onExport={() => exportAndTrack(job, getActiveArtifact(g)?.html, job.company, getActiveArtifact(g))}
                onVisit={() => visitUrl(job)}
                onStar={() => toggleStar(key)}
                onDislike={() => toggleDislike?.(key)}
                onCardClick={!onJobSelect ? () => {
                  if (done && g.html !== "__exists__") {
                    const entry = {...g, company:g.company||job.company, title:g.title||job.title};
                    openSandbox(entry);
                    openAtsPanel(buildAtsPayload(job, g));
                  } else if (job.url) {
                    visitUrl(job);
                  }
                } : undefined}
                onAts={() => {
                  if (g?.atsReport || g?.atsScore != null || job?.baseAtsReport || job?.baseAtsScore != null) {
                    openAtsPanel(buildAtsPayload(job, g));
                  }
                }}
                onResume={() => generate(job, false)}
              />
            );
          })}

          {/* Pagination controls */}
          {totalPages > 1 && (
            <div style={{ display:"flex", alignItems:"center", justifyContent:"center",
                           gap:8, padding:"16px 20px", borderTop:`1px solid ${theme.border}`, flexWrap:"wrap" }}>
              <LucyBtn onClick={() => goPage(currentPage-1)}
                        disabled={currentPage <= 1} accent={theme.surfaceHigh}>
                Prev
              </LucyBtn>
              <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", justifyContent:"center" }}>
                {visiblePages.map(item => typeof item === "string" ? (
                  <span key={item} style={{ fontSize:12, color:theme.textDim, padding:"0 4px" }}>
                    …
                  </span>
                ) : (
                  <button
                    key={item}
                    type="button"
                    onClick={() => goPage(item)}
                    aria-label={item === currentPage ? `Current page, page ${item}` : `Go to page ${item}`}
                    title={item === currentPage ? `Current page ${item}` : `Go to page ${item}`}
                    style={{
                      minWidth:32,
                      height:32,
                      borderRadius:999,
                      border:`1px solid ${item === currentPage ? theme.accent : theme.border}`,
                      background:item === currentPage ? theme.accent : theme.surface,
                      color:item === currentPage ? theme.accentText : theme.text,
                      fontSize:12,
                      fontWeight:item === currentPage ? 800 : 600,
                      cursor:item === currentPage ? "default" : "pointer",
                      padding:"0 10px",
                    }}>
                    {item}
                  </button>
                ))}
              </div>
              <LucyBtn onClick={() => goPage(currentPage+1)}
                        disabled={currentPage >= totalPages} accent={theme.surfaceHigh}>
                Next
              </LucyBtn>
              <div style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
                <span style={{ fontSize:12, color:theme.textMuted }}>Go to page</span>
                <input
                  value={pageInput}
                  onChange={e => setPageInput(e.target.value.replace(/[^\d]/g, ""))}
                  onKeyDown={e => e.key === "Enter" && commitPageJump()}
                  inputMode="numeric"
                  aria-label="Go to page"
                  style={{
                    width:64,
                    height:32,
                    borderRadius:999,
                    border:`1px solid ${theme.border}`,
                    background:theme.surface,
                    color:theme.text,
                    fontSize:12,
                    padding:"0 10px",
                    outline:"none",
                  }}
                  placeholder={String(currentPage)}
                />
                <LucyBtn onClick={commitPageJump} accent={theme.surfaceHigh} title="Go to page">
                  Go
                </LucyBtn>
              </div>
            </div>
          )}

        </PullToRefresh>
      )}
    </div>
  );
}

function buildVisiblePageItems(currentPage, totalPages) {
  if (totalPages <= 1) return [1];
  const pages = new Set([1, totalPages]);
  for (let page = currentPage - 2; page <= currentPage + 2; page += 1) {
    if (page >= 1 && page <= totalPages) pages.add(page);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const items = [];
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) items.push("ellipsis-" + page);
    items.push(page);
  });
  return items;
}

// Displays LinkedIn jobs already captured via the extension. The `onImport`/`linkedinImporting`
// props and their two "Import from LinkedIn" buttons were removed in cleanup 5.3: they drove the
// bulk saved-jobs scrape, whose bridge functions have been stubs returning false since BYO-2 and
// whose extension-side content script was deleted in v1.2.0. Clicking either only ever opened an
// "install the extension" modal that no install could satisfy. The LIST below stays — it is fed
// by the single-job capture path (/api/extension/save-job), which is live.
function EmptyState({ theme }) {
  const { theme: t } = useTheme();
  const th = theme || t;
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center",
                  justifyContent:"center", gap:16, padding:40, color:th.textDim }}>
      <div style={{ fontSize:56 }}>Search</div>
      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                    fontSize:22, letterSpacing:"0.06em", textTransform:"uppercase", color:th.text }}>
        Search for a role above
      </div>
      <div style={{ fontSize:12, textAlign:"center", color:th.textDim, maxWidth:320, lineHeight:1.8 }}>
        LinkedIn + Indeed - full-time only - deduplicated - ghost jobs filtered
      </div>
    </div>
  );
}

// â"€â"€ Empty state, filtered variant â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Says WHICH empty this is and gives the one action that resolves it. Never "no jobs available" —
// the jobs are there, the filter set is hiding them, and those are different problems with
// different fixes. Excluding every provider or every tier lands here.
function FilteredEmptyState({ theme, count, onClearFilters }) {
  const { theme: t } = useTheme();
  const th = theme || t;
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center",
                  justifyContent:"center", gap:14, padding:40, color:th.textDim }}>
      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                    fontSize:22, letterSpacing:"0.06em", textTransform:"uppercase", color:th.text,
                    textAlign:"center" }}>
        Your filters exclude all jobs
      </div>
      <div style={{ fontSize:12, textAlign:"center", color:th.textDim, maxWidth:360, lineHeight:1.8 }}>
        {count} filter{count === 1 ? " is" : "s are"} active on this board and nothing matches all
        of them. The postings are still there — widen or clear the filters to see them.
      </div>
      {onClearFilters && (
        <button type="button" onClick={onClearFilters}
          style={{ border:"none", borderRadius:6, padding:"8px 16px", background:th.accent,
                   color:"#0f0f0f", fontWeight:800, fontSize:12, cursor:"pointer" }}>
          Clear all filters
        </button>
      )}
    </div>
  );
}

// ── Empty state, role-scoped variant ────────────────────────────────────────────────────────
// The THIRD reason a board can be empty, and until now the only one with no voice of its own.
//
// /api/jobs is profile-scoped through an INNER JOIN on job_role_map.role_key, so a board with no
// filters at all and zero rows is not "search for something" — it means nothing in the shared pool
// is bucketed under THIS profile's role. Saying "Search for a role above" there sent the user off to
// run a search that could not change the answer. Naming the profile makes the actual next move
// (switch or widen the profile) findable, and it is honest whether the cause is an empty pool or a
// role with no matches: either way, nothing matches this profile's role.
function RoleScopedEmptyState({ theme, profileName }) {
  const { theme: t } = useTheme();
  const th = theme || t;
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center",
                  justifyContent:"center", gap:14, padding:40, color:th.textDim }}>
      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                    fontSize:22, letterSpacing:"0.06em", textTransform:"uppercase", color:th.text,
                    textAlign:"center" }}>
        No jobs in your profile&rsquo;s role
      </div>
      <div style={{ fontSize:12, textAlign:"center", color:th.textDim, maxWidth:380, lineHeight:1.8 }}>
        This board only shows postings matching the role of your active profile
        {profileName ? <> (<strong style={{ color:th.text }}>{profileName}</strong>)</> : null}, and
        no filters are narrowing it — nothing in the pool is classified under that role yet. Switch
        profiles, or run a search to pull in new postings.
      </div>
    </div>
  );
}

function SetupGateNotice({ theme, title, body, actionLabel, onAction }) {
  return (
    <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center",
                  padding:32, background:theme.bg }}>
      <div style={{ width:"min(92vw, 520px)", border:`1px solid ${theme.border}`,
                    background:theme.surface, borderRadius:8, padding:24,
                    boxShadow:"0 16px 40px rgba(0,0,0,0.12)" }}>
        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                      fontSize:22, letterSpacing:"0.06em", textTransform:"uppercase",
                      color:theme.text, marginBottom:8 }}>
          {title}
        </div>
        <div style={{ fontSize:13, lineHeight:1.6, color:theme.textMuted, marginBottom:18 }}>
          {body}
        </div>
        <button onClick={onAction}
          style={{ border:"none", borderRadius:6, padding:"10px 16px",
                   background:theme.accent, color:"#0f0f0f", fontWeight:800,
                   cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif",
                   letterSpacing:"0.06em", textTransform:"uppercase" }}>
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

function SearchIntentDialog({ theme, prompt, onConfirm, onCancel }) {
  return (
    <div style={{ position:"fixed", inset:0, zIndex:750, background:"rgba(0,0,0,0.48)",
                  display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div role="dialog" aria-modal="true" style={{ width:"min(92vw, 460px)",
        background:theme.modalSurface || theme.surface, border:`1px solid ${theme.border}`,
        borderRadius:8, boxShadow:"0 24px 72px rgba(0,0,0,0.32)", padding:22 }}>
        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                      fontSize:20, letterSpacing:"0.06em", textTransform:"uppercase",
                      color:theme.text, marginBottom:8 }}>
          {prompt.title}
        </div>
        <div style={{ fontSize:13, lineHeight:1.6, color:theme.textMuted, marginBottom:20 }}>
          {prompt.body}
        </div>
        <div style={{ display:"flex", justifyContent:"flex-end", gap:10, flexWrap:"wrap" }}>
          <button onClick={onCancel}
            style={{ border:`1px solid ${theme.border}`, borderRadius:6, padding:"8px 12px",
                     background:theme.surface, color:theme.text, cursor:"pointer", fontWeight:700 }}>
            {prompt.cancelLabel || "Cancel"}
          </button>
          <button onClick={onConfirm}
            style={{ border:"none", borderRadius:6, padding:"8px 12px",
                     background:theme.accent, color:"#0f0f0f", cursor:"pointer", fontWeight:800 }}>
            {prompt.confirmLabel || "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

// LinkedInInstallDialog removed in cleanup 5.3. Its only render site was gated behind
// startLinkedInImport's always-true "extension not installed" branch, and its Import Now
// button called back into that same function — an install prompt for a capability v1.2.0
// deleted from the extension, which no install could ever satisfy.

// â"€â"€ History list â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function HistoryList({ generated, onOpen, onExport, theme: themeProp }) {
  const { theme: t } = useTheme();
  const theme = themeProp || t;
  const entries = Object.entries(generated).filter(([,v]) => v?.html && v.html !== "__exists__");
  if (!entries.length) return (
    <div style={{ padding:24, color:theme.textDim, fontSize:12, textAlign:"center" }}>
      No resumes generated yet.
    </div>
  );
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
      {entries.map(([jid,v]) => {
        const letter = (v.company||"?")[0].toUpperCase();
        const colors = ["#0A66C2","#7c3aed","#0891b2","#16a34a","#dc2626","#d97706","#9333ea"];
        let hash = 0;
        for (const c of v.company||"") hash = (hash*31+c.charCodeAt(0))&0xffff;
        const bg = colors[hash%colors.length];
        return (
          <div key={jid} style={{ padding:"12px 16px", borderBottom:`1px solid ${theme.border}`,
                                   display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:32, height:32, borderRadius:8, background:bg,
                           display:"flex", alignItems:"center", justifyContent:"center",
                           fontWeight:800, fontSize:11, color:"#fff", flexShrink:0 }}>
              {letter}
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontWeight:700, fontSize:12, color:theme.text,
                             overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {v.company}
              </div>
              <div style={{ fontSize:10, color:theme.textDim, overflow:"hidden",
                             textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:3 }}>
                {v.title||v.role}
              </div>
              <ATSBadge score={v.atsScore}/>
            </div>
            <div style={{ display:"flex", gap:5, flexShrink:0 }}>
              <IconBtn bg="#0284c7" size={26} title="Open in sandbox" onClick={() => onOpen(v)}>👁</IconBtn>
              <IconBtn bg="#16a34a" size={26} title="Export PDF" onClick={() => onExport(null,v.html,v.company)}>📥</IconBtn>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// â"€â"€ Company Reuse Modal â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function CompanyReuseModal({ company, onUseExisting, onGenerateNew, onCancel, theme }) {
  return (
    <div style={{
      position:"fixed", inset:0, zIndex:1000, display:"flex",
      alignItems:"center", justifyContent:"center",
      background:"rgba(0,0,0,0.45)", backdropFilter:"blur(3px)",
    }}
    onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={{
        background:theme.surface, borderRadius:12, padding:28,
        maxWidth:380, width:"90%", boxShadow:theme.shadowLg,
        border:`1px solid ${theme.border}`,
        display:"flex", flexDirection:"column", gap:16,
      }}>
        <div style={{ fontSize:18, fontWeight:800, color:theme.text }}>
          Previously applied to {company}
        </div>
        <div style={{ fontSize:13, color:theme.textMuted, lineHeight:1.6 }}>
          You've already generated a resume for a role at <strong style={{ color:theme.text }}>{company}</strong>.
          Use your existing resume for this role, or generate a new one?
        </div>
        <div style={{ display:"flex", gap:10, flexDirection:"column" }}>
          <button onClick={onUseExisting} style={{
            padding:"10px 0", borderRadius:999, border:`2px solid ${theme.accent}`,
            background:theme.accent, color:"#0f0f0f", fontWeight:800, fontSize:13,
            cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif",
            letterSpacing:"0.06em", textTransform:"uppercase",
          }}>
            Use Existing Resume
          </button>
          <button onClick={onGenerateNew} style={{
            padding:"10px 0", borderRadius:999, border:`2px solid ${theme.border}`,
            background:"transparent", color:theme.text, fontWeight:800, fontSize:13,
            cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif",
            letterSpacing:"0.06em", textTransform:"uppercase",
          }}>
            Generate New
          </button>
          <button onClick={onCancel} style={{
            padding:"6px 0", border:"none", background:"none",
            color:theme.textMuted, fontSize:12, cursor:"pointer",
          }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
