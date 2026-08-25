// SCRAPING — SCHEDULED FOR REMOVAL AFTER MIGRATION
// client/src/components/JobCard.jsx — shared expandable job card
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../styles/theme.jsx";
import CompanyViewModal from "./CompanyViewModal.jsx";
import { useAutoApply } from "../contexts/AutoApplyContext.jsx";
import { boardApplicationChip } from "../lib/applyObstacles.js";
import { api } from "../lib/api.js";
import { jobDetailHref } from "../lib/jobUrl.js";
import CompanyIcon from "./ui/CompanyIcon.jsx";

// AH2: a job's title is a LINK to that job's own address.
//
// The detail panel used to be React state and nothing else — there was no URL that named a job, so
// no card could offer "open in a new tab" and no two job details could be on screen at once. Now
// that /app/jobs?job=<id> resolves a specific posting, the title carries it, and the browser's own
// affordances (ctrl/cmd-click, middle-click, the context menu) work with no extra icon on an
// already dense card.
//
// A PLAIN left-click is deliberately not handled: it only suppresses the browser's navigation and
// then keeps bubbling to the card's own onClick, so opening a detail in the current tab behaves
// exactly as it did. A MODIFIED click stops there — the browser is opening a new tab, and selecting
// the job in THIS tab too would be a second thing the user did not ask for.
function JobTitleLink({ job, isLoggedOut, style, children }) {
  const href = jobDetailHref(job.jobId || job.id);
  if (isLoggedOut || !href) return <div style={style}>{children}</div>;
  return (
    <a href={href}
      title={`${job.title} — ctrl/cmd-click to open in a new tab`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) { e.stopPropagation(); return; }
        e.preventDefault();
      }}
      style={{ color: "inherit", textDecoration: "none", display: "block", ...style }}>
      {children}
    </a>
  );
}

// ── Helpers ─────────────────────────────────────────────────────
// Compute elapsed time since posting.
// postedAt is stored as ISO date (e.g. "2024-03-15") after O1 normalization.
// fallbackTs is scraped_at (Unix seconds) — used when postedAt is absent.
function ago(postedAt, scrapedAt) {
  let ms = postedAt ? new Date(postedAt).getTime() : NaN;
  if (isNaN(ms) || ms <= 0) {
    // Fall back to scraped_at (Unix seconds → ms)
    ms = scrapedAt != null ? Number(scrapedAt) * 1000 : NaN;
  }
  if (isNaN(ms) || ms <= 0) return "—";
  const d = Date.now() - ms;
  if (d < 0) return "—";
  if (d < 3600000)  return `${Math.floor(d / 60000)}m`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h`;
  return `${Math.floor(d / 86400000)}d`;
}

// ── LinkedIn "in" logo ──────────────────────────────────────────
function LinkedInLogo({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-label="LinkedIn" role="img">
      <rect width="20" height="20" rx="3" fill="#0A66C2"/>
      <text x="4" y="15" fontFamily="Georgia,serif" fontWeight="900" fontSize="13" fill="#fff">in</text>
    </svg>
  );
}

function PlatformLogo({ platform, size = 16, theme }) {
  const p = (platform || "").toLowerCase();
  if (p === "linkedin") return <LinkedInLogo size={size}/>;
  return <span style={{ fontSize: size * 0.6, color: "var(--color-text-muted)" }}>◆</span>;
}

// ── Company icon ────────────────────────────────────────────────

// ── Work badge ──────────────────────────────────────────────────
function WorkBadge({ t, theme }) {
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
    <span style={{ background:"var(--color-surface-offset)", color:"var(--color-text-muted)", padding:"2px 8px",
                   borderRadius:999, fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
      {t || "Onsite"}
    </span>
  );
}

// ── Visa/sponsorship badge (FE-1) ────────────────────────────────
// null must render nothing — null means "no signal," never "does not sponsor."
function VisaBadge({ isH1bSponsor, requiresWorkAuth }) {
  if (isH1bSponsor === 1 || isH1bSponsor === true) {
    return (
      <span style={{ background:"#dcfce7", color:"#166534", padding:"2px 8px",
                     borderRadius:999, fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
        Sponsors H-1B
      </span>
    );
  }
  if (requiresWorkAuth === 1 || requiresWorkAuth === true) {
    return (
      <span style={{ background:"var(--color-surface-offset)", color:"var(--color-text-muted)",
                     padding:"2px 8px", borderRadius:999, fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
        US work auth req.
      </span>
    );
  }
  return null;
}

// ── Application-state chip (board <-> pipeline) ───────────────────
// Renders nothing for a job with no application, which is almost all of them — the board must not
// grow a column of empty chips. Reads the join AutoApplyContext already computes from feeds it has
// loaded, so this costs no extra request and cannot disagree with the Auto Apply panel.
function ApplyStateChip({ jobId }) {
  const { applyStateByJobId } = useAutoApply();
  const chip = boardApplicationChip(applyStateByJobId?.[jobId]);
  if (!chip) return null;
  return (
    <span title={chip.title}
      style={{ background: `${chip.color}22`, color: chip.color, padding: "2px 8px",
               borderRadius: 999, fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>
      {chip.label}
    </span>
  );
}

// ── Automation tier chip ─────────────────────────────────────────
// What the candidate will face at the apply destination, known before they queue instead of
// mid-run (services/jobs/automationTier.js; the runtime counterpart is applyAutomation.js's
// classifyFlowState, which only answers once a run is already holding).
//
// `direct` renders NOTHING, and that is the point: it is the default and the overwhelming
// majority of the board, so a chip on it would be noise on every card while telling the user
// nothing they did not already assume. Chip only what changes their expectation.
//
// null and 'unknown' are the SAME rendering, because they mean the same thing to a user — nobody
// has established what this destination demands. It is worded as an open question, never as
// "one-click" and never as "needs an account"; a company careers page might be either, and saying
// so honestly is the whole point of keeping `unknown` out of `manual`.
//
// Sizes match the badges it sits beside in this row (WorkBadge/VisaBadge/NewPill: radius 999,
// 10px, 700) rather than MetaChips' own 11px, so the row reads as one set.
const TIER_CHIP = {
  guest:   { label:"Guest apply",  bg:"#f0f9ff", fg:"#0284c7",
             title:"An account is offered but a guest path exists — autofill can usually complete this." },
  account: { label:"Account req.", bg:"#fef9c3", fg:"#854d0e",
             title:"This employer requires a self-service account. You sign in once; the resolver fills the form." },
  gated:   { label:"Login + check", bg:"#fee2e2", fg:"#991b1b",
             title:"Account plus a CAPTCHA or identity check — this one cannot be automated. Apply here yourself." },
  unknown: { label:"Apply path?",  bg:"var(--color-surface-offset)", fg:"var(--color-text-muted)",
             title:"We have not established what this destination asks for. It may apply cleanly, or may need an account." },
};

function TierChip({ tier }) {
  if (tier === "direct") return null;                 // the default — see note above
  const s = TIER_CHIP[tier] || TIER_CHIP.unknown;     // null/unrecognised read as unknown
  return (
    <span title={s.title}
      style={{ background:s.bg, color:s.fg, padding:"2px 8px",
               borderRadius:999, fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
      {s.label}
    </span>
  );
}

// ── NEW pill (FE-1) — discoveredAt is unix seconds ───────────────
function isNewJob(discoveredAt) {
  if (!discoveredAt) return false;
  const ms = Number(discoveredAt) * 1000;
  return Number.isFinite(ms) && Date.now() - ms < 24 * 3600 * 1000;
}

function NewPill() {
  return (
    <span style={{ fontSize:9, fontWeight:800, color:"#16a34a", background:"#dcfce733",
                   padding:"1px 6px", borderRadius:999, whiteSpace:"nowrap", letterSpacing:"0.03em" }}>
      NEW
    </span>
  );
}

// ── Closed pill — a saved job whose listing has expired ──────────
// Only ever rendered on the Saved tab, because that is the only board that returns is_active = 0
// rows. runExpiredJobsCleanup used to hard-DELETE an expired starred job seven days on, taking the
// user's own star with it, so a saved posting simply ceased to exist. It is now retired instead
// (is_active = 0) and kept — and a kept row has to SAY it is closed, or the list quietly promises
// the user they can still apply.
function ClosedPill() {
  return (
    <span title="This listing was not seen again for 7 days, so it is probably filled or withdrawn. Kept here because you saved it."
          style={{ fontSize:9, fontWeight:800, color:"#b45309", background:"#fef3c733",
                   padding:"1px 6px", borderRadius:999, whiteSpace:"nowrap", letterSpacing:"0.03em" }}>
      NO LONGER LISTED
    </span>
  );
}

// ── Skill chips (FE-1) — expanded/detail surfaces only ───────────
function SkillChips({ skills, max = 5 }) {
  if (!skills?.length) return null;
  return (
    <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
      {skills.slice(0, max).map((s, i) => (
        <span key={i} style={{ fontSize:10, color:"var(--color-text-muted)",
                                background:"var(--color-surface-offset)", padding:"2px 7px",
                                borderRadius:4, border:"1px solid var(--border-glass)" }}>
          {s}
        </span>
      ))}
    </div>
  );
}

// ── ATS badge ───────────────────────────────────────────────────
function ATSBadge({ score, onClick }) {
  if (score == null) return null;
  const bg = score >= 80 ? "#dcfce7" : score >= 60 ? "#fef9c3" : "#fee2e2";
  const fg = score >= 80 ? "#166534" : score >= 60 ? "#854d0e" : "#991b1b";
  return (
    <span onClick={onClick ? e => { e.stopPropagation(); onClick(); } : undefined}
      style={{ background:bg, color:fg, padding:"2px 8px", borderRadius:999,
               fontSize:10, fontWeight:700, cursor:onClick?"pointer":"default",
               border:onClick?`1px solid ${fg}33`:"none" }}>
      ATS {score}
    </span>
  );
}

// ── Plain description renderer ───────────────────────────────────
function DescriptionText({ text, theme, truncate = true, maxChars = 1200 }) {
  if (!text) return null;
  const shouldTruncate = truncate && Number.isFinite(maxChars);
  const trimmed = shouldTruncate ? text.slice(0, maxChars) : text;
  return (
    <p style={{ fontSize:11, color:"var(--color-text-muted)", lineHeight:1.7, margin:0, whiteSpace:"pre-wrap" }}>
      {trimmed}
      {shouldTruncate && text.length > maxChars && <span style={{ color:"var(--color-text-faint)" }}> … (truncated)</span>}
    </p>
  );
}

// ── Icon button ─────────────────────────────────────────────────
function IconBtn({
  bg,
  onClick,
  title,
  children,
  disabled = false,
  size = 28,
  theme,
  active = false,
  activeBg = null,
  activeColor = null,
}) {
  const [hov, setHov] = useState(false);
  const preview = hov && !disabled;
  const resolvedActiveBg = activeBg || `${bg}22`;
  const resolvedActiveColor = activeColor || bg;
  return (
    <button title={title} disabled={disabled} onClick={onClick}
      onMouseEnter={() => !disabled && setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width:size, height:size, borderRadius:999,
        background: disabled
          ? "var(--color-surface-offset)"
          : active
            ? resolvedActiveBg
            : preview
              ? `${bg}18`
              : "var(--color-surface-offset)",
        border:`1px solid ${disabled
          ? "var(--color-border)"
          : active
            ? `${bg}55`
            : preview
              ? `${bg}44`
              : "var(--color-border)"}`,
        display:"flex", alignItems:"center", justifyContent:"center",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize:12,
        color: disabled
          ? "var(--color-text-muted)"
          : active
            ? resolvedActiveColor
            : preview
              ? bg
              : "var(--color-text-muted)",
        opacity: disabled ? 0.4 : 1,
        transition:"all 0.15s ease", flexShrink:0,
        transform: active ? "scale(1.08)" : preview ? "scale(1.08)" : "scale(1)",
        boxShadow: active ? `0 0 0 1px ${bg}22` : "none",
      }}>
      {children}
    </button>
  );
}

function ToggleIconBtn({ active, activeLabel, inactiveLabel, activeChildren, inactiveChildren, ...props }) {
  return (
    <IconBtn
      {...props}
      active={active}
      title={active ? activeLabel : inactiveLabel}
    >
      {active ? activeChildren : inactiveChildren}
    </IconBtn>
  );
}

// ── Main JobCard ─────────────────────────────────────────────────
export default function JobCard({
  job,
  theme: themeProp,
  isLoggedOut = false,
  showApplyButton = true,
  g,                  // generated resume entry
  done,               // has generated resume
  st,                 // loading state string
  applyMode,
  canUseGenerate = applyMode !== "SIMPLE",
  canUseAPlusResume = false,
  onGenerate,
  onAPlusResume,
  onViewSandbox,
  onExport,
  onVisit,
  onStar,
  onDislike,
  onCardClick,
  onAts,
  onResume,
  onSelect,           // split-view: select this card (replaces expand)
  selected,           // split-view: this card is selected
  compact,            // split-view: tighter layout
  cardTier = 1,       // 1=full, 2=medium (manual resize), 3=condensed (3+ panels open)
}) {
  const { theme: ctxTheme } = useTheme();
  const theme = themeProp ?? ctxTheme;
  const navigate = useNavigate();

  const [hov,      setHov]      = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showCompanyView, setShowCompanyView] = useState(false);

  // Local STAR state — used when onStar is not provided (e.g. rendered from LandingPage with no
  // parent managing state). The matching `disliked` state went with the thumbs-down (AE5): it
  // existed only to drive that button's fill, and keeping a write-only copy of a flag whose one
  // remaining reader is `job.disliked` below would be a second source of truth for it.
  const [starred,  setStarred]  = useState(job._user?.starred  ?? job.starred  ?? false);

  // Sync if job prop changes (e.g. parent re-fetches)
  useEffect(() => {
    setStarred(job._user?.starred  ?? job.starred  ?? false);
  }, [job._user, job.starred]);

  // Persist interact (star/dislike) when no parent callback provided.
  //
  // Goes through api() rather than a bare fetch. This was the ONE /api call site in the client that
  // sent only `credentials: "include"` and no X-RM-Auth-Context header, so it was authenticated by
  // the connect.sid cookie alone. The cookie is shared by every tab in a browser profile while the
  // auth-context token is per tab, so whenever those two disagreed — two accounts open in one
  // browser — starring a job in one tab wrote the star onto the OTHER account, silently. Every
  // other call site already routes through api(); this one was the hole.
  //
  // Sends the jobId, which the card always has. It used to send the URL plus title/company/source;
  // the endpoint keyed the row on the URL — where every other writer of user_jobs uses a job_id —
  // and discarded the other three entirely. It still accepts a URL and resolves it, for a caller
  // that only has one, but there is no reason for this caller to be that one.
  async function interact(patch) {
    try {
      await api("/api/jobs/interact", {
        method: "PATCH",
        body: JSON.stringify({
          jobId: job.jobId || job.id,
          url: job.url || job.applyUrl,
          ...patch,
        }),
      });
    } catch (e) {
      // Kept as a warn rather than surfaced: a star is not worth a toast. But the endpoint 500'd on
      // EVERY call for its whole life and this line is why nobody noticed, so the failure is now
      // loud in the console rather than a bare object.
      console.warn(`[JobCard] interact failed for ${job.jobId || job.id}: ${e.message}`);
    }
  }

  // Fallback handlers used when parent doesn't provide callbacks
  const handleStar = onStar ?? (() => {
    const next = !starred;
    setStarred(next);
    // Still clears `disliked` SERVER-side: starring a job you had passed on has to un-pass it, and
    // that is the flag the board query filters on.
    interact({ starred: next, ...(next ? { disliked: false } : {}) });
  });

  // ── AE5: QUEUE AUTO REPLACES THE THUMBS-DOWN ────────────────────────────────────────────────
  // Read straight off the AutoApply context, the same way ApplyStateChip above does, so the action
  // the card most needs does not have to be threaded through JobsPanel's board component. `queued`
  // is the queue's own membership, so the button reports state rather than firing blindly twice.
  //
  // WHAT HAPPENED TO DISLIKE. It was checked before it was moved, and it is NOT merely a UI
  // preference: `uj.disliked = 0` is a WHERE clause on the board query, the poll query and the
  // facet counts (server.js), and routes/adminDb.js reports "disliked" as a reason a job was
  // filtered out. It is the pass list. So it is not dropped — JobDetailPanel's "Pass" action drives
  // exactly the same PATCH, and this card still renders a passed job dimmed and greyscaled. What
  // changed is which of the two gets the scarce slot on a listing: one of these hides a job, the
  // other applies to it, and only one of them is why the user is on this board.
  const { addToApplyQueue, applyQueue } = useAutoApply();
  const queueKey = job.jobId || job.id;
  const queued = (applyQueue || []).some(item => item.jobId === queueKey);
  const canQueue = !!(job.applyUrl || job.url) && !!queueKey;
  const handleQueue = () => { if (!queued) addToApplyQueue?.({ ...job, jobId: queueKey }); };

  const frostedBg = hov ? "rgba(28,28,28,0.88)" : "rgba(17,17,17,0.55)";
  const frostedBlur = hov ? "blur(20px) saturate(2)" : "blur(12px) saturate(1.6)";
  const frostedOverlay = "linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(200,200,200,0.02) 100%)";

  const hasDesc    = !!(job.description || job.descriptionHtml);
  // Only `generate` needs its own flag here. There is no dedicated A+ Resume button on this card —
  // nor on JobDetailPanel's action bar, which carried an identical orphan — so the companion flag
  // that used to sit here was computed and never read (§5.14 removed both). A+ itself is live:
  // JobsPanel selects that tool by apply_mode/plan tier, it simply has no button of its own on
  // either surface. Removing the flag changes nothing: while a job is in the a_plus_resume state,
  // `st` is still truthy, so the `disabled={!!st}` / `cursor:st ? …` guards below keep disabling
  // this card's buttons exactly as before.
  const generateLoading = st === "generate";
  const hasSalary  = job.salaryMin != null || job.salaryMax != null;
  const salaryStr  = hasSalary
    ? [job.salaryMin, job.salaryMax].filter(Boolean).map(v =>
        `${job.salaryCurrency || "$"}${(v/1000).toFixed(0)}k`
      ).join("→")
    : null;

  const yoeStr = job.expRaw
    ? job.expRaw
    : job.minYearsExp != null
      ? (job.maxYearsExp != null ? `${job.minYearsExp}→${job.maxYearsExp}y` : `${job.minYearsExp}y+`)
      : null;

  const handleCardClick = (e) => {
    if (e.target.closest("a") || e.target.closest("button")) return;
    if (isLoggedOut) {
      const url = job.url || job.applyUrl;
      if (url) window.open(url, "_blank", "noreferrer");
      return;
    }
    if (onSelect) { onSelect(); return; }
    if (onCardClick) { onCardClick(); return; }
    setExpanded(prev => !prev);
  };

  // RESPONSIVE TIERS: driven by open-panel count (see getCardTier in JobsPanel.jsx).
  // Tier 1 (full layout):   A alone or A+B — cardTier=1
  // Tier 2 (medium):        manual drag to 180-279px — cardTier=2
  // Tier 3 (condensed):     3+ panels open (A at 10%) — cardTier=3
  // To change tier triggers, edit getCardTier() in JobsPanel.jsx.
  const tier = cardTier;

  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      role={isLoggedOut ? "link" : undefined}
      tabIndex={isLoggedOut ? 0 : undefined}
      aria-label={isLoggedOut ? `${job.title} at ${job.company} — view job` : undefined}
      onKeyDown={isLoggedOut ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const url = job.url || job.applyUrl; if (url) window.open(url, "_blank", "noreferrer"); } } : undefined}
      style={{
        background: frostedBg,
        backdropFilter: frostedBlur,
        WebkitBackdropFilter: frostedBlur,
        border: selected
          ? "1px solid var(--color-primary)"
          : hov
            ? "1px solid color-mix(in srgb, var(--color-primary) 40%, transparent)"
            : "1px solid var(--border-glass)",
        borderRadius: 4,
        // AE5: the 16px side margin moved onto the listing GRID. Inside a grid cell a per-card
        // margin insets each cell separately, so the two columns ended up with 32px of nothing
        // between them on top of the gap. The bottom margin went too — the grid owns the gap now,
        // and keeping both stacked them.
        margin: 0,
        boxShadow: hov
          ? "0 0 0 2px var(--color-primary), 0 8px 24px color-mix(in srgb, var(--color-primary) 27%, transparent)"
          : "var(--shadow-sm)",
        transform: hov ? "translateY(-3px) scale(1.008)" : "translateY(0) scale(1)",
        transition: "all 0.2s ease", position: "relative",
        opacity: job.disliked ? 0.3 : job.visited ? 0.75 : 1,
        filter: job.disliked ? "grayscale(0.7)" : "none",
        overflow: "hidden",
        cursor: isLoggedOut ? "pointer" : undefined,
      }}>

      {/* ── Frosted glass overlay (gradient + noise texture) ── */}
      <div aria-hidden style={{
        position:"absolute", inset:0, pointerEvents:"none", borderRadius:"inherit", zIndex:0,
        background: frostedOverlay,
      }}/>
      <div aria-hidden style={{
        position:"absolute", inset:0, pointerEvents:"none", borderRadius:"inherit", zIndex:2,
        opacity: 0.12, mixBlendMode: "overlay",
        backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`,
        backgroundSize:"160px 160px",
      }}/>

      {/* ── TIER_3_CONTENT: condensed narrow mode (< 180px) ── */}
      {tier === 3 && (
        <div onClick={handleCardClick}
          title={`${job.company} — ${job.title}`}
          style={{ padding:"10px 8px 10px", display:"flex", flexDirection:"column",
                   alignItems:"center", gap:5, cursor:"pointer", position:"relative", zIndex:1,
                   minHeight:72 }}>
          {/* Logo — fades in as tier changes */}
          <div style={{ opacity:1, transition:"opacity 0.15s ease 0.05s" }}>
            <CompanyIcon company={job.company} iconUrl={job.companyIconUrl} size={32}/>
          </div>
          {/* Company name */}
          <span style={{ fontSize:10, fontWeight:700, color:"var(--color-text)", textAlign:"center",
                         overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                         width:"100%", maxWidth:110,
                         opacity:1, transition:"opacity 0.15s ease 0.05s" }}>
            {job.company}
          </span>
          {/* Resume badge — only if a resume has been generated */}
          {done && (
            <span style={{
              fontSize:9, fontWeight:700, padding:"2px 6px", borderRadius:999,
              background:"var(--color-primary-muted)", color:"var(--color-primary-text)",
              border:"1px solid color-mix(in srgb, var(--color-primary) 27%, transparent)", whiteSpace:"nowrap",
              opacity:1, transition:"opacity 0.2s ease 0.22s",
            }}>
              ✓ Resume
            </span>
          )}
        </div>
      )}

      {/* ── Tier 2: condensed two-row (180→279px) ── */}
      {tier === 2 && (
        <div onClick={handleCardClick}
          style={{ padding:"10px 12px", display:"flex", alignItems:"center", gap:10,
                   cursor:"pointer", position:"relative", zIndex:1,
                   opacity:1, transition:"opacity 0.15s ease" }}>
          <CompanyIcon company={job.company} iconUrl={job.companyIconUrl} size={36}/>
          <div style={{ flex:1, minWidth:0 }}>
            {/* Row 1: company + age + ATS + star + dislike */}
            <div style={{ display:"flex", alignItems:"center", gap:4, marginBottom:3 }}>
              <span style={{ fontWeight:700, fontSize:12, color:"var(--color-text)",
                              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1, minWidth:0 }}>
                {job.company}
              </span>
              <span style={{ fontSize:10, color:"#16a34a", fontWeight:600, flexShrink:0 }}>{ago(job.postedAt, job.scrapedAt)}</span>
              {!isLoggedOut && (g?.atsScore != null || job?.baseAtsScore != null) && <ATSBadge score={g?.atsScore ?? job?.baseAtsScore} onClick={onAts}/>}
              {!isLoggedOut && (
                <ToggleIconBtn
                  bg="#f59e0b"
                  size={28}
                  theme={theme}
                  active={starred}
                  activeLabel="Remove from saved"
                  inactiveLabel="Save job"
                  onClick={e => { e.stopPropagation(); handleStar(); }}
                  activeChildren="★"
                  inactiveChildren="☆"
                />
              )}
              {!isLoggedOut && canQueue && (
                <IconBtn bg="#16a34a" theme={theme} active={queued} size={28}
                  title={queued ? "Already in the auto-apply queue" : "Add to auto-apply queue"}
                  disabled={queued}
                  onClick={e => { e.stopPropagation(); handleQueue(); }}>
                  {queued ? "✓" : "⚡"}
                </IconBtn>
              )}
            </div>
            {/* Row 2: job title */}
            <JobTitleLink job={job} isLoggedOut={isLoggedOut}
              style={{ fontSize:11, color:"var(--color-text-muted)",
                       overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {job.title}
            </JobTitleLink>
          </div>
        </div>
      )}

      {/* ── Tier 1: full layout (>= 280px) — unchanged ── */}
      {tier === 1 && (
        <div onClick={handleCardClick}
          style={{ padding: compact ? "10px 14px" : "14px 18px", display:"flex", alignItems:"center", gap:14, cursor:"pointer", position:"relative", zIndex:1 }}>

          {/* Company icon */}
          <CompanyIcon company={job.company} iconUrl={job.companyIconUrl} size={48}/>

          {/* Center info */}
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
              <span onClick={e => { e.stopPropagation(); setShowCompanyView(true); }}
                title={`View ${job.company}'s KB profile`}
                style={{ fontWeight:700, fontSize:14, color:"var(--color-text)", cursor:"pointer",
                              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {job.company}
              </span>
              {job.alreadyApplied && (
                <span title="Applied" style={{ fontSize:10, color:"#16a34a", fontWeight:700 }}>✓APPLIED</span>
              )}
              {!job.alreadyApplied && job.companyAppliedBefore && (
                <span title="Applied to this company before" style={{ fontSize:10, color:"#d97706" }}>↩prev</span>
              )}
              {job.visited && (
                <span style={{ fontSize:9, color:"var(--color-text-faint)", background:"var(--color-surface-offset)",
                                padding:"1px 6px", borderRadius:999 }}>visited</span>
              )}
            </div>
            <JobTitleLink job={job} isLoggedOut={isLoggedOut}
              style={{ fontSize:12, color:"var(--color-text-muted)", marginBottom:6,
                       overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {job.title}
            </JobTitleLink>
            <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
              <WorkBadge t={job.workType} theme={theme}/>
              {/* Explicit `=== false`: isActive is absent on live-search results, and absent must
                  not read as closed. Ahead of the NEW pill because "closed" outranks "recent". */}
              {job.isActive === false && <ClosedPill/>}
              {/* A closed listing is never new, whatever discoveredAt says — the two pills side by
                  side ("NO LONGER LISTED" + "NEW") is a contradiction the user has to resolve, and
                  the closed state is the one that changes what they can do about it. */}
              {job.isActive !== false && isNewJob(job.discoveredAt) && <NewPill/>}
              <VisaBadge isH1bSponsor={job.isH1bSponsor} requiresWorkAuth={job.requiresWorkAuth}/>
              {/* THE BOARD AND THE PIPELINE STOP BEING SEPARATE WORLDS. A card gave no hint that
                  you had already applied to it, that it was queued, or that it was stuck waiting on
                  you — so the only way to know was to open the other tab and read a list of runs.
                  The label comes from lib/applyObstacles.js, the same vocabulary the Auto Apply
                  panel uses, so the two cannot describe one application differently. */}
              <ApplyStateChip jobId={job.jobId || job.id}/>
              <TierChip tier={job.automationTier}/>
              <span style={{ display:"flex", alignItems:"center", gap:4 }}>
                <PlatformLogo platform={job.sourcePlatform || job.source} size={16} theme={theme}/>
              </span>
              {job.location && (
                <span style={{ fontSize:10, color:"var(--color-text-faint)" }}>{job.location}</span>
              )}
              {yoeStr && (
                <span style={{ fontSize:10, color:"var(--color-text-faint)" }}>{yoeStr} exp</span>
              )}
              {salaryStr && (
                <span style={{ fontSize:10, color:"#16a34a", fontWeight:700 }}>{salaryStr}</span>
              )}
              {!salaryStr && job.compensation && (
                <span style={{ fontSize:10, color:"#16a34a", fontWeight:700 }}>{job.compensation}</span>
              )}
              {job.applicantCount != null && (
                <span style={{ fontSize:10, color:"var(--color-text-faint)" }}>
                  {job.applicantCount > 200 ? "200+ applicants" : `${job.applicantCount} applicants`}
                </span>
              )}
              {job.source_label && (
                <span style={{
                  fontSize: 9, color: "var(--color-text-faint)",
                  background: "var(--color-surface-offset)", padding: "1px 6px", borderRadius: 999,
                }}>
                  {job.source_label}
                </span>
              )}
              {job.via && (
                <span style={{
                  fontSize: 9, color: "var(--color-text-faint)",
                  background: "var(--color-surface-offset)", padding: "1px 6px", borderRadius: 999,
                }}>
                  {job.via}
                </span>
              )}
            </div>
          </div>

          {/* Right side */}
          <div style={{ display:"flex", alignItems:"center", gap:5, flexShrink:0 }}>
            {isLoggedOut && hov && (
              <span style={{ fontSize:13, color:"var(--color-primary-text)", fontWeight:700, opacity:0.85 }}>↗</span>
            )}
            <span style={{ fontSize:11, color:"#16a34a", fontWeight:600 }}>{ago(job.postedAt, job.scrapedAt)}</span>

            {!isLoggedOut && (g?.atsScore != null || job?.baseAtsScore != null) && (
              <ATSBadge score={g?.atsScore ?? job?.baseAtsScore} onClick={onAts}/>
            )}
            {!isLoggedOut && done && (
              <span onClick={onResume ? e => { e.stopPropagation(); onResume(); } : undefined}
                style={{ background:"#e8f6fb", color:"#1a6a8a", padding:"2px 8px",
                         borderRadius:999, fontSize:10, fontWeight:700, cursor:"pointer",
                         border:"1px solid #A8D8EA44", display:"inline-flex", alignItems:"center", gap:3 }}>
                {st==="loading" ? "⏳" : "📄"} Resume
              </span>
            )}

            {/* Star */}
            {!isLoggedOut && (
              <ToggleIconBtn
                bg="#f59e0b"
                size={30}
                theme={theme}
                active={starred}
                activeLabel="Remove from saved"
                inactiveLabel="Save job"
                onClick={e => { e.stopPropagation(); handleStar(); }}
                activeChildren="★"
                inactiveChildren="☆"
              />
            )}

            {/* Queue Auto — AE5. Where the thumbs-down was. A listing has room for a handful of
                controls and this is the one that moves an application forward; Pass lives on
                JobDetailPanel, which is one click away and is where you decide you do NOT want a
                job. Green matches JobDetailPanel's own "Queue Auto" so the two read as one action. */}
            {!isLoggedOut && canQueue && (
              <IconBtn bg="#16a34a" theme={theme} active={queued}
                title={queued ? "Already in the auto-apply queue" : "Add to auto-apply queue"}
                disabled={queued}
                onClick={e => { e.stopPropagation(); handleQueue(); }}>
                {queued ? "✓" : "⚡"}
              </IconBtn>
            )}
            {/* Generate */}
            {!isLoggedOut && canUseGenerate && onGenerate && showApplyButton && (
              <IconBtn bg="var(--color-primary)" title={done ? "Regenerate" : "Generate resume"}
                disabled={!!st} theme={theme} active={done && !generateLoading}
                onClick={e => { e.stopPropagation(); onGenerate(done && g?.html !== "__exists__"); }}>
                {generateLoading ? "⏳" : done ? "↻" : "✦"}
              </IconBtn>
            )}

            {/* View sandbox */}
            {!isLoggedOut && done && g?.html !== "__exists__" && showApplyButton && (
              <IconBtn bg="#0284c7" title="View in sandbox" theme={theme}
                onClick={e => { e.stopPropagation(); onViewSandbox?.(); }}>
                👁
              </IconBtn>
            )}

            {/* Visit URL */}
            {!isLoggedOut && onVisit && showApplyButton && job.url && (
              <IconBtn bg="var(--color-primary)" title="Open job listing" theme={theme}
                onClick={e => { e.stopPropagation(); onVisit(); }}>
                ↗
              </IconBtn>
            )}
          </div>
        </div>
      )}

      {/* ── Expanded section ──────────────────────────────────── */}
      {expanded && (
        <div style={{
          borderTop: "1px solid var(--border-glass)",
          padding: "12px 18px 16px",
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          {/* Description */}
          {job.description && (
            <DescriptionText text={job.description} theme={theme} truncate={false}/>
          )}

          {/* Skill chips (FE-1) — expanded surface only, never on the collapsed card */}
          <SkillChips skills={job.skills}/>

          {/* Extra meta row */}
          <div style={{ display:"flex", flexWrap:"wrap", gap:8, alignItems:"center", paddingTop:4 }}>
            {job.source_label && (
              <span style={{
                fontSize: 11, color: "var(--color-text-faint)",
                background: "var(--color-surface-offset)", padding: "2px 8px",
                borderRadius: 9999, border: "1px solid var(--border-glass)",
              }}>
                {job.source_label}
              </span>
            )}
            {job.via && (
              <span style={{
                fontSize: 11, color: "var(--color-text-faint)",
                background: "var(--color-surface-offset)", padding: "2px 8px",
                borderRadius: 9999, border: "1px solid var(--border-glass)",
              }}>
                {job.via}
              </span>
            )}
            {salaryStr && (
              <span style={{ fontSize:11, color:"#16a34a", fontWeight:700, background:"#dcfce733",
                              padding:"2px 8px", borderRadius:4 }}>
                💰 {salaryStr}
              </span>
            )}
            {yoeStr && (
              <span style={{ fontSize:11, color:"var(--color-text-muted)", background:"var(--color-surface-offset)",
                              padding:"2px 8px", borderRadius:4 }}>
                🎓 {yoeStr} exp required
              </span>
            )}
            {job.applicantCount != null && (
              <span style={{ fontSize:11, color:"var(--color-text-muted)", background:"var(--color-surface-offset)",
                              padding:"2px 8px", borderRadius:4 }}>
                👥 {job.applicantCount > 200 ? "200+" : job.applicantCount} applicants
              </span>
            )}
            {!isLoggedOut && showApplyButton !== false && (job.applyUrl || job.url) && (
              <a href={job.applyUrl || job.url} target="_blank" rel="noreferrer"
                onClick={e => e.stopPropagation()}
                style={{ fontSize:11, color:"var(--color-primary-text)", fontWeight:700,
                          textDecoration:"underline", background:"var(--color-primary-muted)",
                          padding:"2px 8px", borderRadius:4 }}>
                Apply directly ↗
              </a>
            )}
          </div>

          {/* Recruiter section — coming soon */}
          {!isLoggedOut && canUseGenerate && showApplyButton && (
            <div style={{ display:"flex", flexWrap:"wrap", gap:8, alignItems:"center" }}>
              {canUseGenerate && onGenerate && (
                <button onClick={e => { e.stopPropagation(); onGenerate(done && g?.html !== "__exists__"); }}
                  disabled={!!st}
                  style={{ border:"none", borderRadius:6, padding:"8px 12px",
                           background:"var(--color-primary)", color:"#0f0f0f", cursor:st ? "not-allowed" : "pointer",
                           fontSize:12, fontWeight:800 }}>
                  {generateLoading ? "Generating..." : done ? "Regenerate" : "Generate"}
                </button>
              )}
            </div>
          )}

          {/* FE-6: was a "Recruiter (coming soon)" stub implying auto-contact/LinkedIn
              reach-out — replaced with a real link into the Recruiter KB-reference +
              consistency-check surface (companies/roles only, no outreach or scraping). */}
          {!isLoggedOut && (
            <div style={{
              borderTop: "1px dashed var(--border-glass)",
              paddingTop: 8, marginTop: 4,
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <span style={{ fontSize:10, color:"var(--color-text-faint)", fontWeight:700,
                              textTransform:"uppercase", letterSpacing:"0.06em" }}>
                Recruiter
              </span>
              <button
                onClick={e => { e.stopPropagation(); navigate(`/app/recruiter?company=${encodeURIComponent(job.company)}`); }}
                title={`Open ${job.company}'s KB reference in Recruiter view`}
                style={{ fontSize:10, padding:"1px 8px", borderRadius:999, fontWeight:700,
                         background:"var(--color-surface-offset)", color:"var(--color-primary-text)",
                         border:"1px solid var(--color-primary)", cursor:"pointer",
                         whiteSpace:"nowrap", letterSpacing:"0.04em" }}>
                View company KB →
              </button>
            </div>
          )}
        </div>
      )}
      {showCompanyView && (
        <CompanyViewModal company={job.company} onClose={() => setShowCompanyView(false)} />
      )}
    </div>
  );
}
