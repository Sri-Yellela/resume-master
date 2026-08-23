// client/src/panels/JobsPanel.jsx â€" Lucy Brand, shared job pool
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { api, printResume, dislikeJob, authHeaders, authContextQuery } from "../lib/api.js";
import { TileGrid } from "../components/ui/TileCard.jsx";
import { GENERATE_TOOL, A_PLUS_TOOL, TOOL_LABELS, normalizeTool } from "../lib/applyTools.js";
import { useAutoApply } from "../contexts/AutoApplyContext.jsx";
import { useTheme } from "../styles/theme.jsx";
import { useViewport } from "../hooks/useViewport.js";
import JobCard from "../components/JobCard.jsx";
import JobDetailPanel from "../components/JobDetailPanel.jsx";
import SandboxPanel from "./SandboxPanel.jsx";
import AtsReportPanel from "./AtsReportPanel.jsx";
import { PanelScrim, PanelDock, PANEL_TOP_INSET, PANEL_BOTTOM_INSET } from "../components/PanelShell.jsx";
import { usePanelHost } from "../hooks/usePanelHost.js";
import { useBoardLock } from "../hooks/useBoardLock.js";
import DomainProfileWizard from "../components/DomainProfileWizard.jsx";
import ProfileSelectorDropdown from "../components/ProfileSelectorDropdown.jsx";
import { useSyncEvents } from "../hooks/useSyncEvents.js";
import { useAppScroll } from "../contexts/AppScrollContext.jsx";
import { useJobBoard } from "../contexts/JobBoardContext.jsx";
import { Z } from "../styles/zLayers.js";
import { toast } from "../hooks/use-toast.js";
import ROLE_ALIAS_MAP from "../../../data/ROLE_ALIAS_MAP.json";
// The filter option contract. Every option list below renders FROM these tables — see
// shared/jobFilterOptions.js for why they are not literals here any more.
import {
  EXPERIENCE_LEVELS, WORK_MODELS, EMPLOYMENT_TYPES, SOURCES, AUTOMATION_TIERS,
  POSTING_AGE, VISITED, ageDaysMap,
} from "../../../shared/jobFilterOptions.js";
import CompanyIcon from "../components/ui/CompanyIcon.jsx";

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
// The ageFilter -> days mapping, DERIVED rather than restated. It used to be a literal here and a
// second literal in server.js's AGE_MAP, which is two copies of one definition; both now read the
// shared POSTING_AGE table, so "past week" cannot come to mean two different things.
const AGE_DAYS_MAP = ageDaysMap();

function ago(ts) {
  if (!ts) return "-";
  const d = Date.now() - new Date(ts).getTime();
  if (d < 3600000)  return `${Math.floor(d/60000)}m`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h`;
  return `${Math.floor(d/86400000)}d`;
}

// â"€â"€ LinkedIn "in" logo (inline SVG) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Moved to client/src/lib/applyTools.js so AutoApplyContext can build the same apply-run request
// from the same constants — two copies of a wire value is how a client and a server drift apart.

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

// Every one of the five option lists this file used to declare is now a reference to the shared
// contract. They were all correct — that is exactly why they are dangerous as copies: nothing
// fails when one of them is edited and the others are not, and the board simply stops matching.
const EMP_TYPE_OPTIONS = EMPLOYMENT_TYPES.options;

// jobQuery.js's work_models dimension (sj.workplace_type — the Task-5 ENRICHMENT column). This is
// now the only work-location control: the legacy single-select over sj.work_type was removed because
// no write path populates that column, and this one filters the column enrichment actually fills.
const WORK_MODEL_OPTIONS = WORK_MODELS.options;

// FE-2: jobQuery.js's experience_levels dimension (sj.experience_level — the profile-bridge's
// derived default; an explicit selection here overrides it, per server.js's per-key merge). Shared
// with the search bar's Experience select, which is the pairing W1 had to correct by hand.
const EXPERIENCE_LEVEL_OPTIONS = EXPERIENCE_LEVELS.options;

// Provider (scraped_jobs.source) options for the include/exclude control. The comment here used to
// say this list "mirrors the vocabulary the writers actually emit ... deliberately NOT an import of
// the server module" — and it did not mirror it. It offered `LinkedIn`, which no writer emits (the
// extension writes `linkedin_extension`), and omitted workday, smartrecruiters, workable and
// recruitee, which are all registered aggregator plugins. Deliberately not importing the vocabulary
// is precisely how it came to be wrong. It is imported now. The counts beside each still come from
// jobQuery.js's `sources` facet at runtime, so a provider with 0 rows shows "(0)" rather than being
// silently absent.
const SOURCE_OPTIONS = SOURCES.options;

// Automation tier. Order is decreasing confidence; the hints travel with the values in the shared
// table, because a tier without its explanation is the control that reads as either a promise or a
// warning. services/jobs/automationTier.js's AUTOMATION_TIERS is derived from the same table.
const TIER_OPTIONS = AUTOMATION_TIERS.options;

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
    companySponsors: false,
    // Provider + automation-tier include/exclude. Empty arrays are the default-off state: buildParams
    // emits nothing at all for them, which is what keeps the default querystring byte-identical.
    sourcesInclude: [],
    sourcesExclude: [],
    tiersInclude: [],
    tiersExclude: [],
  };
}

// â"€â"€ Filters panel (collapsible) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// The filters drawer's nav clearance.
//
// It used to be `position: fixed; inset: 0; zIndex: 500` — a raw number belonging to no tier, and
// full-height. TopBar is Z.NAV (1500), so the top 46px of the drawer sat UNDER it. Measured at
// 1440x900 with the drawer open: the panel ran 0 -> 900, its header 24 -> 54, and its close button
// was a 9px-wide box at x 1411-1420, y 26-53 — overlapping the avatar at 1389-1419, y 8-38. A
// hit-test at the close button's own centre (1416, 40) returned a nav <div>, not the button. So the
// control was not merely cramped: it was unclickable across its upper half.
//
// The fix is the one client/src/styles/zLayers.js prescribes, not a bigger number. Its rule 2 says
// "a raw bump is not a fix — the question is which TIER it belongs to", and 500 belonged to no tier.
//
// Y2 REVISED WHICH TIER. The first fix put this drawer on MODAL_SCRIM / MODAL — the panels' own
// tiers — which cleared the nav but left the relative order of TWO different drawers an accident of
// render order: open a JD panel while the filters drawer is up and which one won was undefined.
// It now has its own tier, DRAWER_SCRIM / DRAWER, between the search surface and the panels: it
// covers the search bar and the top bar, and a JD/PDF/ATS panel covers it.
//
// The nav clearance itself is no longer LOAD-BEARING for reachability — the bar is at Z.NAV (250),
// below this drawer, so it cannot occlude the close control whatever the geometry. The inset stays
// for the independent reason it was chosen: PanelShell parity.
//
// The insets are PanelShell's OWN CONSTANTS now, imported rather than copied. They were the
// literals 80 and 16 here and 80 and 16 there — two numbers that had to agree, with a test reading
// one out of the other's source to check. Importing them makes "the filters drawer and the
// JD/PDF/ATS dock share a top edge" true by construction. And the top one is no longer a number at
// all: it is `calc(var(--app-chrome-height) + 34px)`, so it tracks the bar's measured height (Y4).
const FILTER_DRAWER_TOP = PANEL_TOP_INSET;
const FILTER_DRAWER_BOTTOM = PANEL_BOTTOM_INSET;

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
  companySponsors, setCompanySponsors,
  sourcesInclude, setSourcesInclude,
  sourcesExclude, setSourcesExclude,
  tiersInclude, setTiersInclude,
  tiersExclude, setTiersExclude,
  facetCounts,
  onReset,
  // Moved in from the control row (W4). Neither is new and neither changed: "New in 24h" is still
  // the same ageFilter toggle, and the tracked-search trio is still saveTrackedSearch /
  // applyTrackedSearch / clearTrackedSearch.
  onSaveSearch, onApplySearch, onClearSearch, trackedSearch, canSaveSearch,
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
  // PORTALLED TO document.body, which is what makes the drawer inertable — see the note on
  // FILTER_DRAWER_TOP above and useBoardLock. This drawer rendered inside JobsPanel, i.e. inside
  // <main>, i.e. inside [data-app-shell]. useBoardLock inerts the shell's CHILDREN, so inerting the
  // app to protect the drawer would have inerted the drawer along with it — the subtree it was
  // supposed to be the exception to. PanelScrim and PanelDock are portalled for the neighbouring
  // reason (a fixed element is still clipped by an ancestor transform and still confined to an
  // ancestor's stacking context); this one adds a third: a modal surface must not be a descendant of
  // the thing it makes inert.
  return createPortal(
    <div data-filters-drawer="" style={{
      position:"fixed", inset:0, zIndex:Z.DRAWER_SCRIM,
      // `stretch`, not `flex-start`: the panel's height now comes from this container's padding
      // (see FILTER_DRAWER_TOP below), so it must fill the padded box rather than hug its content.
      display:"flex", alignItems:"stretch", justifyContent:"flex-end",
      // The nav clearance lives on the SCRIM as padding, so the dim still covers the full viewport
      // — including behind the top bar — while the panel inside it starts below the nav. A scrim
      // that stopped at the nav would leave an undimmed strip across the top of a modal surface.
      padding:`${FILTER_DRAWER_TOP} 0 ${FILTER_DRAWER_BOTTOM}px`,
      background:"rgba(0,0,0,0.42)",
      isolation:"isolate",
    }}
    onClick={e => { if(e.target===e.currentTarget) onClose(); }}>
      <motion.div
        initial={{ x:360 }} animate={{ x:0 }} exit={{ x:360 }}
        transition={{ type:"tween", duration:0.22 }}
        style={{
          width:320, height:"100%", zIndex:Z.DRAWER,
          background:theme.modalSurface || "#111827",
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
          {/* A real hit target. With no padding this was the width of the glyph alone — measured at
              9x27px, under the 24x24 minimum, and easy to miss even once it stopped being covered
              by the nav. Square, centred, and the same 6px radius the drawer's other controls use.
              `aria-label` because "x" is not a name. */}
          <button onClick={onClose} aria-label="Close filters" title="Close filters"
            style={{ width:28, height:28, flexShrink:0, borderRadius:6,
                     display:"flex", alignItems:"center", justifyContent:"center",
                     background:"none", border:"none",
                     cursor:"pointer", fontSize:18, lineHeight:1, color:theme.textMuted,
                     transition:"background 0.15s, color 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.background = theme.surfaceHigh || "rgba(255,255,255,0.08)";
                                 e.currentTarget.style.color = theme.text; }}
            onMouseLeave={e => { e.currentTarget.style.background = "none";
                                 e.currentTarget.style.color = theme.textMuted; }}>x</button>
        </div>

        {/* ── Quick filters and saved searches ──────────────────────────────────────────
            Both moved here from the control row that W4 removes. "New in 24h" toggles the STAGED
            ageFilter, like every other control in this panel, so it now takes effect on Apply
            rather than instantly — that is the panel's staging model, not a change to the filter.
            The saved-search trio keeps its own semantics exactly: Save captures the currently
            COMMITTED filter set (buildParams' querystring), which is what is on screen, not the
            edits being staged above it. */}
        <div>
          <div style={labelStyle}>Quick</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            <button type="button"
              onClick={() => setAgeFilter(ageFilter === "1d" ? "" : "1d")}
              title="Show only jobs posted in the last 24 hours"
              style={{
                padding:"6px 12px", borderRadius:999, fontSize:11, fontWeight:700, cursor:"pointer",
                border:`1px solid ${ageFilter === "1d" ? theme.accent : theme.border}`,
                background: ageFilter === "1d" ? theme.accentMuted : "transparent",
                color: ageFilter === "1d" ? (theme.accentText || theme.text) : theme.textMuted,
                textTransform:"uppercase", letterSpacing:"0.06em",
              }}>
              New in 24h
            </button>
            <button type="button"
              onClick={onSaveSearch}
              disabled={!canSaveSearch}
              title="Save the filter set currently applied to the board"
              style={{
                padding:"6px 12px", borderRadius:999, fontSize:11, fontWeight:700,
                border:`1px solid ${theme.border}`, background:"transparent",
                color: canSaveSearch ? theme.text : theme.textDim,
                cursor: canSaveSearch ? "pointer" : "not-allowed",
                opacity: canSaveSearch ? 1 : 0.5,
              }}>
              Save Search
            </button>
          </div>
          {trackedSearch && (
            <div style={{ display:"flex", alignItems:"center", gap:4, marginTop:6 }}>
              <button type="button" onClick={onApplySearch}
                title={trackedSearch.name || "Apply saved search"}
                style={{
                  flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                  padding:"5px 12px", borderRadius:999, fontSize:11, fontWeight:700, cursor:"pointer",
                  border:`1px solid ${theme.accent}`, background:theme.accentMuted || theme.surface,
                  color:theme.accentText || theme.text,
                }}>
                {trackedSearch.name || "Saved Search"}
              </button>
              <button type="button" onClick={onClearSearch} title="Remove saved search"
                aria-label="Remove saved search"
                style={{
                  width:22, height:22, borderRadius:"50%", border:`1px solid ${theme.border}`,
                  background:"transparent", color:theme.textMuted, cursor:"pointer",
                  fontSize:12, lineHeight:1, flexShrink:0,
                }}>
                x
              </button>
            </div>
          )}
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
          {/* Rendered from POSTING_AGE, which also owns the days each key means — so the option
              the user picks and the `posted_after` timestamp derived from it cannot disagree. */}
          <select value={ageFilter} onChange={e=>setAgeFilter(e.target.value)} style={selStyle}>
            {POSTING_AGE.options.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
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
              {VISITED.options.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
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

        {/* X3: the COMPANY-level filter, deliberately a second control rather than a mode of the one
            above. That one reads what the POSTING said about work authorisation; this reads what the
            EMPLOYER filed with the Department of Labor. Two claims from two sources, and collapsing
            them into one tickbox would make it impossible to say which one hid a job.

            The label says what it DOES — hides companies with no filings — not "sponsors only". The
            filter cannot confirm that a company sponsors, and a label promising that would be the
            exact overclaim the company view's copy is written to avoid. */}
        <div>
          <button type="button" onClick={() => setCompanySponsors(!companySponsors)}
            style={{
              display:"flex", alignItems:"center", gap:8, width:"100%",
              padding:"8px 10px", borderRadius:4, cursor:"pointer",
              border:`1px solid ${companySponsors ? theme.accent : theme.border}`,
              background: companySponsors ? theme.accentMuted : "transparent",
              color: companySponsors ? theme.accentText : theme.text,
            }}>
            <span style={{
              width:16, height:16, borderRadius:3, flexShrink:0,
              border:`1px solid ${companySponsors ? theme.accent : theme.border}`,
              background: companySponsors ? theme.accent : "transparent",
            }}/>
            <span style={{ fontSize:12, fontWeight:600 }}>Hide employers with no H-1B filings</span>
          </button>
          <div style={{ fontSize:10, color:theme.textMuted, marginTop:5, lineHeight:1.45 }}>
            From US Department of Labor LCA disclosure data. Removes only employers we matched
            confidently and that filed nothing in the quarters we hold — a company we could not
            identify stays on the board.
          </div>
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
    </div>,
    document.body
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
  const { scrollToTopRef } = useAppScroll();
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
        style={{ flex:1, overflowY:"auto", paddingTop:4, paddingBottom:8 }}>
        {children}
      </div>
    </div>
  );
}



// DEFAULT SIZES (canonical, do not edit inline):
// The percentage-split rules that used to be documented here (A=100 alone, A=30 with one panel,
// A=6 with two or more, plus a bonus for the resume column) described getPanelDefaults, which is
// gone: the PDF and ATS surfaces are popup panels rendered through PanelShell, so the board is the
// only column left and simply keeps the full width. Panel widths are per-type, dragged on the panel
// and persisted across sessions by PanelShell.
// -- Card tier — driven by open-panel count, not pixel width ------
// Still driven by how many panels are open, which is still what decides how much room the board's
// cards have — the panels overlay it now rather than taking columns from it, so a wide panel over a
// narrow board is the same legibility problem it always was.
// Tier 1 (full layout):  board alone, or board + one panel
// Tier 3 (condensed):    board + two panels (the side-by-side maximum)
// Tier 2 (medium):       only reached by manual drag — ResizeObserver overrides Tier 1 -> 2 when
//                        the board is dragged to 180-279px. Tier 3 always wins over pixels.
function getCardTier(panelBVisible, panelCVisible, panelDVisible) {
  const extraPanels = [panelBVisible, panelCVisible, panelDVisible].filter(Boolean).length;
  if (extraPanels === 0) return 1; // A only — full width
  if (extraPanels === 1) return 1; // A+B — still 30%, full layout
  return 3;                        // A+B+C or A+B+C+D — 6%, condensed
}

// getPanelDefaults removed — see the note where the rebalancing effect used to be.

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
  const { mode: vpMode, w: vpWidth } = useViewport();
  const navigate = useNavigate();
  const { scrollToTopRef } = useAppScroll();
  const isWide     = vpMode === "wide";
  const isMobile   = vpMode === "mobile" || vpMode === "tablet";
  const isPortrait = vpMode === "portrait" || vpMode === "laptop";

  // The mobile pane switch is GONE. It had three values, "jobs" | "editor" | "ats", and only the
  // first still renders anything: the editor and ats panes were deleted when the PDF sandbox and the
  // ATS report became popup panels. Nothing sets it any more (see openSandbox / the bottom nav), so
  // holding it as state would be holding a constant, and reading it would be gating the board on a
  // value that can no longer change. The board is what the mobile branch renders; the panels overlay
  // it full-screen on a narrow viewport, which is usePanelHost's fallback.

  // Tracks jobs disliked in this browser session — survives filter/sort refetches
  // but is cleared on page reload (so server exclusions take effect on next login)
  const sessionDislikedRef = useRef(new Map()); // jobId ? job object

  // Job data
  const [jobs,        setJobs]        = useState([]);
  const [totalJobs,   setTotalJobs]   = useState(0);
  const [totalPages,  setTotalPages]  = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  // Profile→Board Bridge disclosure. `curation` is the server's { total, demoted, rankedKeys }
  // block, present ONLY when the bridge actually demoted something; `curateOff` is the user's
  // escape, which sends ?curate=off and turns the ranking off for that request. The bridge used to
  // EXCLUDE on these dimensions, which is how an imported job that WAS present read as missing; it
  // ranks now, so the disclosure is about position rather than about a withheld remainder.
  const [curation,    setCuration]    = useState(null);
  const [curateOff,   setCurateOff]   = useState(false);
  // The server's own word for WHY a board came back empty ('cache_empty' today). Without it the
  // client has to guess, and it guessed wrong: an empty pool rendered as "nothing matches your
  // profile's role", sending the user to change a profile that was never the problem.
  const [boardReason, setBoardReason] = useState(null);

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
    barFilters, liveSearchTick,
    filterPanelOpen, setFilterPanelOpen, setActiveFilterCount,
  } = useJobBoard();

  // Open / close sandbox — panel size rebalancing handled by useEffect below.
  //
  // NO `setMobilePane` HERE ANY MORE, and that is a fix rather than a tidy-up. These three used to
  // switch the mobile board to the "editor" / "ats" pane, from when those panes rendered the sandbox
  // and the ATS report inline. Both panes were deleted when the surfaces became popup panels, which
  // left the mobile branch rendering JobsColumn for `mobilePane === "jobs"` and NOTHING for the other
  // two values — so the switch pointed at a pane that no longer existed. Observed at 880x700 and
  // 600x900 before this change:
  // pressing Generate opened the panel over a COMPLETELY EMPTY board, and because closeAtsPanel
  // never reset the pane, closing the panels left the board still empty until the user found the
  // bottom-nav "Jobs" button. On a narrow viewport the panel is a full-screen overlay (see
  // usePanelHost's fallback) and the board simply stays where it is underneath it.
  const openSandbox = useCallback((entry) => {
    setSandbox(entry);
    setSandboxOpen(true);
  }, []);

  const closeSandbox = useCallback(() => {
    setSandboxOpen(false);
  }, []);

  const openAtsPanel = useCallback((atsData) => {
    if (atsData) setActiveAts(atsData);
    setRightPanelOpen(true);
    setRightTab("ats");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── The panel host ──────────────────────────────────────────────────────────────────────────
  // JD, PDF and ATS are peers in one ordered set. The host does not own their open/closed state —
  // that still lives where it always did (selectedJob in JobBoardContext, sandboxOpen and
  // rightPanelOpen here), set by the same dozen call sites as before, including the generate flow's
  // own openSandbox(). It observes them, orders them by focus, tiles them, and evicts the least
  // recently focused when one more opens than will fit. See hooks/usePanelHost.js for why eviction
  // rather than refusal.
  //
  // THE ORDER OF THIS ARRAY IS A PRIORITY, later = higher, and the host reads it when only ONE
  // panel fits (see the eviction note in hooks/usePanelHost.js). Seven call sites open the PDF
  // sandbox and the ATS report together — the generate flow, the reuse flow, the cached-artifact
  // flow, the card's eye button, the JD panel's Regen and Preview, the history list — and at
  // capacity 1 exactly one of them can be on screen. Which one was previously decided by whichever
  // setState ran first, which for the generate flow meant the sandbox (opened immediately as a
  // skeleton) lost its slot to the report that arrived with the response seconds later.
  //
  // [jd, ats, pdf]: the resume outranks its report, which outranks the job description it was
  // generated from. Above capacity 1 nothing here applies — eviction is still by focus recency —
  // and JD open on its own is unaffected either way.
  const panelDescriptors = useMemo(() => ([
    { id: "jd",  open: !!selectedJob,   close: () => setSelectedJob(null) },
    { id: "ats", open: rightPanelOpen,  close: () => setRightPanelOpen(false) },
    { id: "pdf", open: sandboxOpen,     close: () => { setSandboxOpen(false); setSandbox(null); } },
  ]), [selectedJob, sandboxOpen, rightPanelOpen, setSelectedJob]);
  const {
    visible: visiblePanels, dockWidth, focusPanel,
    beginResize, resizeBy, endResize,
    openCount: openPanelCount, fullScreenMode: panelsFullScreen,
  } = usePanelHost(panelDescriptors, vpWidth);
  const panelProps = useCallback((id) => {
    const p = visiblePanels.find(v => v.id === id);
    if (!p) return null;
    return {
      slot: p.slot, width: p.width, focused: p.focused, fullScreen: p.fullScreen,
      resizeMode: p.resizeMode,
      onFocus: () => focusPanel(id),
      onResizeStart: beginResize,
      onResize: (delta) => resizeBy(id, delta),
      onResizeEnd: endResize,
    };
  }, [visiblePanels, focusPanel, beginResize, resizeBy, endResize]);

  // While any panel OR THE FILTERS DRAWER is open the board is inert and the page is frozen at its
  // current scroll offset, which is restored exactly on close. See hooks/useBoardLock.js — a scrim
  // alone stopped neither the Tab key nor the wheel.
  //
  // The drawer was missing from this condition, and a scrim was all it ever had. Measured with only
  // the drawer open: the top bar behind it was dimmed and pointer-unreachable (the scrim covers it,
  // Z.DRAWER_SCRIM 600 over Z.NAV 250) and still fully TAB-REACHABLE, so focus walked out of the
  // open drawer into controls the user could not see. pointer-events is not a focus trap; `inert`
  // is, and it is the same mechanism the panels have always used.
  // filterPanelOpen, not the `filtersOpen` alias — the alias is declared ~130 lines below this call
  // and reading it here would be a temporal-dead-zone ReferenceError on every render.
  useBoardLock(openPanelCount > 0 || filterPanelOpen);

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
  // The auto-apply pipeline's state moved to contexts/AutoApplyContext.jsx, and its surface to
  // panels/AutoApplyPanel.jsx on its own tab (W5). The board keeps exactly one thing: the ability
  // to put a job IN the queue, which is what the card's queue button does. Everything else it used
  // to own — runs, review queues, held-gate batches, questions, pending approvals, per-run detail —
  // is on that tab, unchanged.
  const { addToApplyQueue } = useAutoApply();

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

  // Panel resize refs (react-resizable-panels imperative API). Only the board column is a
  // resizable Panel now, so detailPanelRef / atsPanelRef / the "have defaults been applied" and
  // "what was visible last render" bookkeeping went with the rebalancing effect that used them.
  const jobsPanelRef    = useRef(null);
  const detailPanelElementRef = useRef(null);

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
  // The filters panel's open state lives in JobBoardContext, because the control that opens it is
  // now the icon beside IMPORT (App.jsx's BoardControlIcons), which is rendered above this panel.
  // Only the TRIGGER moved: the panel, its staged pendingFilters, its facet counts and its
  // apply/reset flow are all still here and unchanged.
  const filtersOpen = filterPanelOpen;
  const setFiltersOpen = setFilterPanelOpen;

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
  // Both are reached only from the search bar's Domain and Status selects. They are ordinary
  // committed filter state like every neighbour here — they feed buildParams and appear in the
  // refetch effect's dep array, so test/jobsBoardParamContract.test.js covers them the same way it
  // covers the rest, by derivation rather than by being listed anywhere.
  const [domainFilter,  setDomainFilter]  = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  // FE-2: Task-4 filter vocabulary + the profile-bridge visa preference override.
  const [salaryMin,      setSalaryMin]      = useState("");
  const [salaryMax,      setSalaryMax]      = useState("");
  const [workModels,     setWorkModels]     = useState([]);
  const [experienceLevels,setExperienceLevels]= useState([]);
  const [skillsInclude,  setSkillsInclude]  = useState([]);
  const [sponsorFriendly,setSponsorFriendly]= useState(false);
  // X3: the COMPANY-level H-1B filter, separate from the posting-level toggle above because it is
  // a different claim from a different source. Default off — see the drawer copy for what it does.
  const [companySponsors,setCompanySponsors]= useState(false);
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
  // Same device, same reason, for the live half of the search bar's double-click: that effect is
  // declared above handleSearch and is keyed on a click counter, so it cannot close over the
  // function directly without capturing whichever render happened to be current when the tick last
  // changed — the stale-closure bug documented on the debounced-search effect.
  const handleSearchRef = useRef(null);

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
    companySponsors,
    sourcesInclude,
    sourcesExclude,
    tiersInclude,
    tiersExclude,
  }), [
    roleFilter, locationFilter, workType, employmentTypePrefs,
    catFilter, srcFilter, minYoe, maxYoe, maxApplicants, visitedFilter, ageFilter,
    salaryMin, salaryMax, workModels, experienceLevels, skillsInclude, sponsorFriendly,
    companySponsors, sourcesInclude, sourcesExclude, tiersInclude, tiersExclude,
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
    setCompanySponsors(!!next.companySponsors);
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
    }).length
    // Plus the two committed filters the DRAWER does not own, and which are therefore not in its
    // snapshot: the search bar's Domain and Status > Applied controls. They narrow the board just
    // as much as anything above, and since this number is now also the icon's badge — the only
    // at-a-glance explanation for a narrow board — leaving them out would let the board be
    // filtered while the badge said it was not.
    + (domainFilter ? 1 : 0)
    + (appliedFilter ? 1 : 0);
  }, [activeFilterSnapshot, domainFilter, appliedFilter]);

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

  // "Show all N" / "Use my profile" — the way out of, and back into, profile curation. Only
  // curateOff is set here: it is in the refetch effect's dep array, so flipping it re-runs the board
  // by itself. Page 1 because the uncurated board is a different, longer result set and holding the
  // old offset would land the user in the middle of it.
  const toggleCuration = useCallback(() => {
    setCurateOff(prev => !prev);
    setCurrentPage(1);
  }, []);

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

  // The panel-size rebalancing effect that lived here is gone, along with getPanelDefaults and the
  // sandbox/ats/detail Panel refs it drove. It redistributed react-resizable-panels PERCENTAGES
  // across the board/detail/sandbox/ats columns whenever one opened or closed — three triple-RAF
  // .resize() calls to work around the library not having committed its layout yet. None of that has
  // anything left to act on: the JD, PDF and ATS surfaces are popup panels now, and the board is the
  // only remaining column, so it simply keeps 100%. Panel widths are per-type, dragged on the panel
  // itself and persisted by PanelShell.
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
      // Every callback here is unconditional now. Six of them used to read
      // `isImported ? undefined : ...`, and `isImported` HAD NO DEFINITION — so this effect threw
      // `ReferenceError: isImported is not defined` the instant a job was selected, and the JD
      // drawer never opened at all. Not a regression from the panel work: `isImportedBoardJob()`
      // and the `const isImported = ...` line that called it were both deleted in 190258a ("one
      // capture, two triggers"), which converged the extension's two capture paths, and these six
      // references were left behind.
      //
      // Restoring the guard would be wrong, not just unnecessary. It tested
      // `boardSource in [linkedin, linkedin_saved, linkedin_extension] && importedJobId != null`,
      // i.e. a row in the `imported_jobs` table — the surface that same convergence removed. Every
      // capture now lands in scraped_jobs and is indistinguishable from a crawled row, so the
      // predicate is unconditionally false and the actions it disabled (sandbox, export, star, ATS,
      // resume, queue) are all valid for any board job.
      onGenerate: (force) => generate(selectedJob, force),
      onViewSandbox: () => {
        const e2 = { ...g2, company: g2?.company || selectedJob.company, title: g2?.title || selectedJob.title };
        openSandbox(e2); openAtsPanel(buildAtsPayload(selectedJob, g2));
      },
      onExport: () => exportAndTrack(selectedJob, getActiveArtifact(g2)?.html, selectedJob.company, getActiveArtifact(g2)),
      onVisit: () => visitUrl(selectedJob),
      onStar: () => toggleStar(selectedJob.jobId, selectedJob),
      onDislike: () => toggleDislike?.(selectedJob.jobId, selectedJob),
      onAts: () => openAtsPanel(buildAtsPayload(selectedJob, g2)),
      onResume: () => generate(selectedJob, false),
      onQueueApply: addToApplyQueue,
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
    // sj.bucket_domain (the search bar's Domain select). Not sj.category, which nothing writes —
    // see the note where the drawer's Category control was removed.
    if (domainFilter)         p.set("domain",        domainFilter);
    // uj.applied (the search bar's Status > Applied). Only ever "1"; cleared back to "" otherwise,
    // so the default querystring is unchanged.
    if (appliedFilter)        p.set("applied",       appliedFilter);
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
    // X3: company-level H-1B evidence, and the narrowest filter on the board — it removes only
    // companies whose employer name we matched with high confidence and that filed nothing in the
    // quarters of DOL data we hold. Unmatched and ambiguous companies survive it by construction.
    if (companySponsors)         p.set("company_sponsorship", "1");
    // "Show everything in my role" — turns off the profile-derived defaults for this request only
    // (server.js's ?curate=off). Emitted solely when the user has asked for it, so the default
    // querystring is unchanged.
    if (curateOff)               p.set("curate", "off");
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
      minYoe, maxYoe, maxApplicants, visitedFilter, ageFilter, domainFilter, appliedFilter,
      boardTab, localSearch,
      salaryMin, salaryMax, workModels, experienceLevels, skillsInclude, sponsorFriendly,
      sourcesInclude, sourcesExclude, tiersInclude, tiersExclude, curateOff]);

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

  // Staging on open. This used to be openFilterPanel(), called by the FILTERS button that W4
  // removes — the icon that replaced it only flips the shared flag, because App.jsx has no access
  // to pendingFilters or the facet fetch and should not. So the work moved to an effect on the
  // flag, which means it runs however the panel was opened and cannot be bypassed by a second
  // trigger added later.
  //
  // Keyed on the transition into `true`, not on every render while open, or restaging would wipe
  // the edits being made in the panel on any unrelated re-render.
  useEffect(() => {
    if (!filtersOpen) return;
    setPendingFilters(activeFilterSnapshot());
    fetchFacets();
  }, [filtersOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Publish the count upward so the filter icon (App.jsx's BoardControlIcons, above this panel)
  // can show its badge. JobsPanel is the only place that can count it — the committed filter set
  // lives here — and it is the SAME activeFilterCount the empty-board notice already uses, so the
  // badge and the notice can never disagree about how narrow the board is.
  useEffect(() => { setActiveFilterCount(activeFilterCount); }, [activeFilterCount, setActiveFilterCount]);

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
      // Absent whenever the bridge hid nothing (and on ?curate=off), so this clears itself as soon
      // as the board stops being narrowed — the notice can never outlive the condition it describes.
      setCuration(d.curation || null);
      setBoardReason(d.reason || null);
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
      // Fifth time, and added in the same commit that introduces them — see the note below.
      domainFilter, appliedFilter,
      // FE-2's Task-4 params (salaryMin/Max, workModels, experienceLevels, skillsInclude,
      // sponsorFriendly) feed the SAME buildParams()/fetchJobs() call as the legacy filters
      // above — they were missing from this list, so changing ONLY one of them (leaving every
      // legacy filter untouched) would build the right querystring but never actually refetch.
      salaryMin, salaryMax, workModels, experienceLevels, skillsInclude, sponsorFriendly,
      companySponsors,
      // Same failure, third time this file has been at risk of it: a new filter that feeds
      // buildParams but is missing HERE builds a correct querystring that is never sent, so the
      // control looks dead. FE-3 fixed it for FE-2's params; these four are added in the same
      // commit that introduces them precisely so there is no fourth time. Verified by changing
      // only a provider pill and watching a request fire.
      sourcesInclude, sourcesExclude, tiersInclude, tiersExclude,
      // Fourth time. curateOff feeds buildParams (?curate=off), so it belongs here for exactly the
      // reason the four above do — without it, "Show all N" would build the right querystring and
      // never send it, and the control would look dead.
      curateOff,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- The search bar's params land here ------------------------------------------------------
  //
  // UnifiedSearchBar publishes { query, location, experience, domain, status }; this maps that onto
  // the board's ALREADY-EXISTING committed filter state, so the bar reaches /api/jobs through
  // buildParams like every other control and adds no second param builder. Each of the five is set
  // unconditionally, including back to its empty value — clearing a control in the bar has to clear
  // the board, and a truthy-only assignment would strand the previous value.
  //
  // Mapping, and why each target:
  //   query      -> localSearch     the server ORs it across title/company/description. It is the
  //                                 same state the collapsed pill's "Filter jobs…" input and the
  //                                 board's own "Filter loaded jobs" box already write, so all
  //                                 three search inputs are one filter rather than three.
  //   location   -> locationFilter  LIKE sj.location.
  //   experience -> experienceLevels  the array the FILTERS drawer's own pills write. Shared state,
  //                                 so the bar and the drawer cannot disagree about what "Senior"
  //                                 means, and whichever was touched last is what is on screen.
  //   domain     -> domainFilter    sj.bucket_domain.
  //   status     -> boardTab / ageFilter / appliedFilter, below.
  //
  // `status` is the one that fans out, because it is three unrelated dimensions in one select:
  //   "starred" is the Saved tab (boardTab), "new" is the same 24h window the NEW IN 24H pill sets
  //   (ageFilter), and "applied" is uj.applied. Each is reset when status moves off it, so
  //   switching from Starred to New leaves the board on New alone and not on both.
  //
  // NOT in the dep array: every setter, and boardTab. The setters are stable; boardTab is written
  // here, and including it would make this effect re-run on a tab change made from the pill or the
  // board and stamp the bar's stale status back over it.
  useEffect(() => {
    const { query = "", location = "", experience = "", domain = "", status = "" } = barFilters || {};
    setLocalSearch(query);
    setLocationFilter(location);
    // Identity-preserving, and it has to be. A bare `experience ? [experience] : []` allocates a
    // FRESH array on every apply, so even when the Experience select has not been touched React
    // sees a new value, and `experienceLevels` is in the refetch effect's dep array — which fired a
    // second, redundant /api/jobs alongside the debounced one the keyword search already sends.
    // Measured: one click on Search produced two identical requests for
    // `localSearch=software+engineer`. Returning `prev` unchanged collapses that back to one.
    setExperienceLevels(prev => {
      const next = experience ? [experience] : [];
      const same = prev.length === next.length && prev.every((v, i) => v === next[i]);
      return same ? prev : next;
    });
    setDomainFilter(domain);
    setBoardTab(status === "starred" ? "saved" : "all");
    setAgeFilter(status === "new" ? "1d" : "");
    setAppliedFilter(status === "applied" ? "1" : "");
  }, [barFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  // The LIVE half of the bar's double-click. The first click only commits the filters above (a
  // re-query of what we already hold); the second additionally goes out through handleSearch, which
  // is the same path CHECK FOR NEW JOBS uses — including its "create a profile" / "upload a base
  // resume" guards, so an unconfigured account gets the existing message rather than a silent no-op.
  //
  // Keyed on a counter, not on barFilters, so searching the same terms twice runs twice. The mount
  // skip is the same hazard the debounced-search effect documents below: at tick 0 nobody has
  // clicked anything, and firing a live aggregator search on every board mount is exactly the
  // unrequested request that effect exists to avoid.
  const liveSearchReady = useRef(false);
  useEffect(() => {
    if (!liveSearchReady.current) { liveSearchReady.current = true; return; }
    const q = (barFilters?.query || "").trim();
    if (!q) return;
    handleSearchRef.current?.(q);
  }, [liveSearchTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSearchPhase("idle");
  }, [activeProfileKey, searchInput]);

  // Curation is a property of the ACTIVE profile, so opting out of one profile's curation must not
  // silently carry into the next — that would be a hidden filter state surviving the thing it was
  // scoped to, which is the failure mode this whole notice exists to remove.
  useEffect(() => {
    setCurateOff(false);
  }, [activeProfileKey]);

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
    setDomainFilter(p.get("domain") || "");
    setAppliedFilter(p.get("applied") || "");
    setLocalSearch(p.get("localSearch") || "");
    if (p.get("sort")) setSortBy(p.get("sort"));
    setSalaryMin(p.get("salary_min_usd") || "");
    setSalaryMax(p.get("salary_max_usd") || "");
    setWorkModels(p.get("work_models") ? p.get("work_models").split(",") : []);
    setExperienceLevels(p.get("experience_levels") ? p.get("experience_levels").split(",") : []);
    setSkillsInclude(p.get("skills_include") ? p.get("skills_include").split(",") : []);
    setSponsorFriendly(p.get("sponsorship_friendly") === "1");
    setCompanySponsors(p.get("company_sponsorship") === "1");
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
  handleSearchRef.current = handleSearch;

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
    // pinDock() was here. It set AppScrollContext's `pinned`, whose only reader was the top bar's
    // collapse — which never ran, because the progress it interpolated was permanently 0. With that
    // reader gone the flag was write-only, so the whole pin/unpin trio went with it.
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

  // Panel sizing: the board is the only react-resizable-panels column. The JD, PDF and ATS panels
  // are popups mounted at the end of this component and sized by PanelShell (drag + persisted
  // per-type width), not by percentage redistribution.

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
            open={filtersOpen} onClose={() => setFilterPanelOpen(false)} onApply={applyPendingFilters}
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
            companySponsors={pendingFilters.companySponsors} setCompanySponsors={value => stageFilter("companySponsors", value)}
            sourcesInclude={pendingFilters.sourcesInclude || []} setSourcesInclude={value => stageFilter("sourcesInclude", value)}
            sourcesExclude={pendingFilters.sourcesExclude || []} setSourcesExclude={value => stageFilter("sourcesExclude", value)}
            tiersInclude={pendingFilters.tiersInclude || []}   setTiersInclude={value => stageFilter("tiersInclude", value)}
            tiersExclude={pendingFilters.tiersExclude || []}   setTiersExclude={value => stageFilter("tiersExclude", value)}
            facetCounts={facetCounts}
            onReset={resetPendingFilters}
            onSaveSearch={saveTrackedSearch}
            onApplySearch={applyTrackedSearch}
            onClearSearch={clearTrackedSearch}
            trackedSearch={activeDomainProfile?.tracked_search || null}
            canSaveSearch={!!activeDomainProfile}
          />
        )}
      </AnimatePresence>

      {/* Unified toolbar. The `scrollProgress < 0.5` guard that used to wrap this is gone: it
          hid the toolbar once the top bar collapsed into a pill, and the progress it read was
          permanently 0 — so the condition was always true and the toolbar was always shown.
          Rendering it unconditionally is what has always happened. */}
      {/* Row A: tabs | filters | sort | local-search | job count */}
      {/* Row B (wraps): search input | Search | resume upload */}
      <div style={{
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
        {/* ── The control ROW is gone (W4). Nothing in it was deleted; every control MOVED. ──
            FILTERS, NEW IN 24H, Save Search and the saved-search chip -> the filters panel, opened
              by the icon beside IMPORT (App.jsx's BoardControlIcons).
            Sort ("Newest") -> the sort icon beside it, same seven options, same values.
            "Filter loaded jobs" -> REMOVED as redundant: it wrote `localSearch`, which is the
              same state the main search bar's keyword field now writes, so it was a second input
              for one filter. It is still reachable from the collapsed pill when scrolled.
            Profile selector -> REMOVED as redundant here: TopBar's own profile menu and the
              collapsed pill both already carry one, and this was the third.
            What stays visible is the result count and the active-filter indicator, because with
            the filters behind an icon those are the only things that can explain a narrow board. */}

        {/* Active-filter indicator. The count badge on the icon is the at-a-glance signal; this is
            the same fact in words, and it stays visible when the bar has collapsed to the pill and
            the badge has scrolled away with it. */}
        {activeFilterCount > 0 && (
          <button
            onClick={() => setFiltersOpen(true)}
            title="Open filters"
            style={{
              display:"inline-flex", alignItems:"center", gap:6, flexShrink:0,
              background: theme.accentMuted || theme.surface,
              border:`1px solid ${theme.accent}`, borderRadius:999,
              padding:"4px 12px", cursor:"pointer",
              fontFamily:"'DM Sans',system-ui", fontWeight:700, fontSize:11,
              color: theme.accentText || theme.text,
            }}>
            {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"} active
          </button>
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

      </div>
      {/* Hidden file input â€" always mounted so TopBar resume upload button works even when toolbar is hidden */}
      <input ref={fileRef} type="file" accept=".txt,.html,.md,.docx,.pdf"
        onChange={handleFile} style={{ display:"none" }}/>

      {/* â"€â"€ Resume Enhance modal â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */}
      {/* Z.MODAL_SCRIM below, not the literal 600 this modal carried. 600 is Y2's DRAWER_SCRIM, so
          this modal and the filters drawer's scrim were at the SAME z and their order was decided by
          render order — the exact accident the named scale exists to remove. A resume-enhance modal
          is a focused takeover and belongs above the drawer, which is what MODAL_SCRIM gives it. */}
      {enhanceModalOpen && enhanceResult && (
        <div style={{
          position:"fixed", inset:0, zIndex:Z.MODAL_SCRIM,
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
          {/* The board. Unconditional now — there is no pane to switch away to. */}
          <div style={{ flex:1, minHeight:0, minWidth:0, overflow:"hidden", display:"flex", flexDirection:"column" }}>
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
              isMobile={isMobile}
              onJobSelect={handleJobSelect} selectedJobId={selectedJob?.jobId}
              activeFilterCount={activeFilterCount}
              onClearFilters={clearAllFilters}
              searchActive={!!localSearch.trim()}
              profileName={activeDomainProfile?.profile_name || null}
              curation={curation}
              curateOff={curateOff}
              onToggleCurate={toggleCuration}
              boardReason={boardReason}
              cardTier={1}
            />
            {/* The mobile "editor" pane is gone: the PDF sandbox is a popup panel now and renders
                full-screen on a narrow viewport (usePanelHost's fallback), so a second inline copy
                of it would be a divergent implementation of the same surface. */}
            {/* Likewise the mobile "ats" pane — AtsReportPanel renders full-screen on narrow
                viewports through the shared primitive. */}
          </div>
          {/* Bottom nav.
              Resume and ATS now OPEN THE PANEL that owns each surface instead of switching to a
              pane. They used to call setMobilePane("editor"/"ats"), and those panes were deleted
              when the surfaces became popup panels — so both buttons emptied the board and showed
              nothing in its place. The tab still shows the resume and still shows the report; the
              surface it reaches is the full-screen panel rather than a second inline copy of it.
              Disabled when there is nothing to show yet, which is honest about a resume that has
              not been generated instead of opening an empty sandbox. */}
          <div style={{ display:"flex", borderTop:`1px solid ${theme.border}`,
                        background:theme.surface, flexShrink:0 }}>
            {[
              { id:"jobs",   label:"Jobs",   icon:"Jobs", active: !sandboxOpen && !rightPanelOpen,
                enabled: true,          onPress: () => { closeSandbox(); closeAtsPanel(); } },
              { id:"editor", label:"Resume", icon:"Edit", active: sandboxOpen,
                enabled: !!sandbox,     onPress: () => openSandbox(sandbox) },
              { id:"ats",    label:"ATS",    icon:"ATS",  active: rightPanelOpen,
                enabled: !!activeAts,   onPress: () => openAtsPanel(null) },
            ].map(({ id, label, icon, active, enabled, onPress }) => (
              <button key={id} onClick={onPress} disabled={!enabled}
                title={enabled ? undefined : `No ${label.toLowerCase()} yet — generate a resume first`}
                style={{
                  flex:1, padding:"10px 0", border:"none",
                  cursor: enabled ? "pointer" : "not-allowed",
                  background:"transparent", display:"flex", flexDirection:"column",
                  alignItems:"center", gap:2,
                  opacity: enabled ? 1 : 0.4,
                  color: active ? theme.accent : theme.textMuted,
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
              isMobile={isMobile}
              compact={false} selectedJobId={selectedJob?.jobId} onJobSelect={handleJobSelect}
              activeFilterCount={activeFilterCount}
              onClearFilters={clearAllFilters}
              searchActive={!!localSearch.trim()}
              profileName={activeDomainProfile?.profile_name || null}
              curation={curation}
              curateOff={curateOff}
              onToggleCurate={toggleCuration}
              boardReason={boardReason}
              cardTier={effectiveTier}
              containerRef={jobsPanelElementRef}
            />
          </Panel>

          {/* PANEL C (sandbox) and PANEL D (ATS) are gone from this layout on purpose. They were
              react-resizable-panels columns wedged into the region below the search bar, which is
              why they were cramped and why they sat BEHIND the JD drawer instead of beside it. Both
              are now popup panels rendered through PanelShell — peers of the JD drawer — mounted at
              the bottom of this component. The board keeps the full width of the layout, which is
              also what stops it being squeezed down to a few hundred pixels when they are open. */}
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

      {/* ── The popup panel group: JD, PDF and ATS as peers, inside ONE overlay surface ────────
          All three render through PanelShell and are laid out by one host, so "replace" and
          "side by side" are properties of the set rather than of any one panel.

          The dock is what makes the tiling INTERNAL. Panels are its flex children, so they lay out
          against each other and against nothing else — the board cannot be a party to it. It is
          also what gives the group outer bounds to keep still: before it, each panel was
          independently right-anchored to the viewport, and dragging one wider pushed its neighbour
          off the left edge of the screen rather than resizing against it.

          ONE scrim for the whole group: two stacked 45% scrims compound to ~70% and the board stops
          being visible behind them, which would break the "dims but does not hide" property exactly
          when a second panel opens. Clicking it closes the focused panel — the same gesture the JD
          drawer's own backdrop has always had. The dock is always mounted, and is an empty
          pointer-events:none box when nothing is open, so AnimatePresence still gets to play the
          last panel's exit instead of having its container yanked mid-animation. */}
      <PanelScrim show={openPanelCount > 0} onClick={() => {
        const focused = visiblePanels.find(p => p.focused);
        panelDescriptors.find(d => d.id === focused?.id)?.close?.();
      }}/>
      <PanelDock width={dockWidth} fullScreen={panelsFullScreen && openPanelCount > 0}>
        <AnimatePresence>
          {panelProps("jd")  && <JobDetailPanel key="panel-jd" {...panelProps("jd")}/>}
          {panelProps("pdf") && (
            <SandboxPanel key="panel-pdf" {...panelProps("pdf")}
              entry={sandbox} onClose={closeSandbox}
              onSave={saveSandboxHtml} onExport={exportAndTrack}/>
          )}
          {panelProps("ats") && (
            <AtsReportPanel key="panel-ats" {...panelProps("ats")}
              onClose={closeAtsPanel}
              theme={theme} activeAts={activeAts}
              rightTab={rightTab} setRightTab={setRightTab} genCount={genCount}
              jobId={selectedJob?.jobId} resumeText={resumeText} activeProfileId={activeProfileId}
              historyContent={
                <HistoryList generated={generated} theme={theme}
                  onOpen={e => {
                    openSandbox(e);
                    openAtsPanel({ score:e.atsScore, report:e.atsReport, company:e.company, title:e.title||e.role });
                  }}
                  onExport={exportAndTrack}/>
              }/>
          )}
        </AnimatePresence>
      </PanelDock>
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
                      isMobile,
                      compact, selectedJobId, onJobSelect,
                      activeFilterCount = 0, onClearFilters,
                      searchActive = false, profileName = null,
                      curation = null, curateOff = false, onToggleCurate, boardReason = null,
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
  // Fourth case, and it has to be checked FIRST: the shared pool itself is empty, so no profile,
  // role or filter is responsible. The server says so explicitly (reason:'cache_empty'). Before it
  // did, this fell through to RoleScopedEmptyState and told the user nothing matched their
  // profile's role — advice to go and edit a profile that was never the cause. Worse, this is the
  // case that used to silently serve a global Adzuna feed instead (see server.js), so an empty pool
  // has a history of showing the user anything except the truth.
  const emptyBecauseNoPool   = shouldShowEmptyState && boardReason === "cache_empty";
  // Third case: nothing is narrowing the board and it is still empty. See RoleScopedEmptyState.
  const emptyBecauseRole     = shouldShowEmptyState && !emptyBecauseNoPool && narrowingCount === 0 && !!profileName;
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
      {/* Rendered OUTSIDE the empty/non-empty branch on purpose: the bridge can narrow a board to a
          short list or to nothing at all, and both need to say so. Left inside the non-empty branch
          it would go silent in the very case where the user has least to go on. */}
      <CurationNotice theme={theme} curation={curation} curateOff={curateOff} onToggleCurate={onToggleCurate}/>
      {shouldShowEmptyState ? (
        emptyBecauseNoPool
          ? <NoPoolEmptyState theme={theme}/>
          : emptyBecauseFiltered
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

          {/* ── AE5: TWO LISTINGS PER ROW ────────────────────────────────────────────────────
              One full-width listing per row is why the board read as oversized: a card whose
              content is a 48px logo, two lines of text and a chip row was being given 1200px to
              put them in, so the eye travelled the whole width for every listing and half of it
              was empty.

              TileGrid is the Database / Auto Apply card idiom, imported rather than reimplemented —
              `repeat(auto-fill, minmax(430px, 1fr))`, the same min and gap AutoApplyPanel's company
              tiles use. auto-fill is what makes the stacking automatic and honest: two equal columns
              wherever two 430px columns fit, one below that, and no breakpoint to keep in sync with
              the panel's chrome. The cards keep their own tier logic (JobCard measures its container
              and drops to tier 2/3 when it gets narrow), so a single column on a phone is the
              condensed layout it always was.

              The horizontal margin moved off the card and onto this wrapper: a per-card margin
              inside a grid cell insets each cell separately, which puts 32px of nothing between the
              two columns on top of the gap. */}
          <TileGrid min={430} gap={14} maxColumns={2} style={{ padding: "0 16px 8px" }}>
          {jobs.map(job => {
            const key = job.jobId, g = generated[key],
                  done = !!g?.html, st = loading[key];
            return (
              <JobCard
                key={key} job={job} g={g} done={done} st={st}
                applyMode={applyMode}
                canUseGenerate={canUseGenerate} canUseAPlusResume={canUseAPlusResume}
                theme={theme}
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
                // AE5: the card's thumbs-down became Queue Auto, which JobCard reads off the
                // AutoApply context itself — the same way ApplyStateChip in that file already does,
                // so the queue action needs no plumbing through this component. `onDislike` is still
                // passed: JobDetailPanel's "Pass" action is where the pass list is driven from now,
                // and the dimmed rendering of an already-passed job is unchanged.
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
          </TileGrid>

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
// ── Curation disclosure ─────────────────────────────────────────────────────────────────────
// The board is ORDERED by default from the active profile (services/jobs/profileFilterBridge.js
// derives q, skills_include, experience_levels and sponsorship_friendly for any dimension the user
// did not set explicitly). It used to be NARROWED by them, and this banner used to say so.
//
// That is the wording change X2 requires. A derived filter now ranks instead of excluding, so
// "Showing 210 of 241" became false in the one way that matters — all 241 are on the board, and a
// user told 31 were missing would go looking somewhere else for rows that are simply further down.
// The banner reports `demoted` now: how many rows sorted below the ones matching the profile.
//
// The reason it exists at all is unchanged. Ordering applied silently is still ordering the user
// cannot account for, and the same imported Quora posting that read as missing under the old regime
// (a New Grad req against a 3-years profile) would now read as inexplicably buried. Say the number,
// name the dimensions, and keep one control that turns the whole thing off.
const CURATION_KEY_LABELS = {
  q:                    "role keywords",
  skills_include:       "skills",
  experience_levels:    "experience level",
  sponsorship_friendly: "sponsorship",
  company_sponsorship:  "company H-1B filings",
};

function CurationNotice({ theme, curation, curateOff, onToggleCurate }) {
  const { theme: t } = useTheme();
  const th = theme || t;
  // Nothing to disclose unless the bridge actually demoted rows. When the user has switched curation
  // off we keep a way back on, so the state is never a one-way door they cannot see they are in.
  if (!curation && !curateOff) return null;

  // `rankedKeys` is the current field; `derivedKeys` was its name while these dimensions still
  // excluded. Both are read so a client and server that ship out of step still name the reason
  // instead of silently rendering a bare number.
  const reasons = (curation?.rankedKeys || curation?.derivedKeys || [])
    .map(k => CURATION_KEY_LABELS[k] || k)
    .join(", ");

  return (
    <div style={{ margin:"8px 16px 0", padding:"8px 12px", borderRadius:4,
                  background:`${th.accentMuted}66`, border:`1px solid ${th.accentMuted}`,
                  display:"flex", alignItems:"center", justifyContent:"space-between", gap:12,
                  flexWrap:"wrap" }}>
      <span style={{ fontSize:11.5, color:th.text, lineHeight:1.6 }}>
        {curateOff ? (
          <>Showing <strong>everything in your role</strong>, unsorted — your profile is not ordering these.</>
        ) : (
          <>
            Sorted for your profile
            {reasons ? <> ({reasons})</> : null} — all <strong>{curation.total}</strong> jobs are here,
            with <strong>{curation.demoted}</strong> further down.
          </>
        )}
      </span>
      <button type="button" onClick={onToggleCurate}
        style={{ border:`1px solid ${th.text}`, borderRadius:4, padding:"3px 10px",
                 background:"transparent", color:th.text, fontWeight:700, fontSize:11,
                 cursor:"pointer", whiteSpace:"nowrap" }}>
        {/* "Show all N" was the way past a filter that hid rows. Nothing is hidden now, so the
            control is about the ORDER: keep it, because a user who disagrees with the ranking still
            needs a way out, but stop promising rows that were never withheld. */}
        {curateOff ? "Use my profile" : "Don't sort for me"}
      </button>
    </div>
  );
}

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

// ── Empty state, empty-pool variant ─────────────────────────────────────────────────────────
// The FOURTH reason a board can be empty, and the one that used to be answered with a lie.
//
// When scraped_jobs holds no active rows, /api/jobs used to fall through to a live global
// aggregator query — not profile-scoped, not filtered, not even the user's own Saved tab. On a real
// run with an empty cache and an ENGINEERING profile, the default board, the Saved tab, and every
// filter all returned the same 6,213,918-row feed led by "Occupational Therapist". That is the
// reported "the same set of listings renders regardless of search or filters".
//
// The server now says `cache_empty` instead. This states it plainly and points at the one thing
// that actually resolves it — nothing the user can fix by editing a profile or clearing a filter.
function NoPoolEmptyState({ theme }) {
  const { theme: t } = useTheme();
  const th = theme || t;
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center",
                  justifyContent:"center", gap:14, padding:40, color:th.textDim }}>
      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                    fontSize:22, letterSpacing:"0.06em", textTransform:"uppercase", color:th.text,
                    textAlign:"center" }}>
        No jobs have been collected yet
      </div>
      <div style={{ fontSize:12, textAlign:"center", color:th.textDim, maxWidth:380, lineHeight:1.8 }}>
        This is not your profile and not your filters — the shared job pool itself is empty, so there
        is nothing for any board to show. It refills on the next scheduled crawl. You can also add a
        posting yourself with <strong>Import</strong>.
      </div>
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
