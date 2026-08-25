// client/src/panels/ATSPanel.jsx — Design System v4
// KEYWORD DATA SOURCE PRIORITY:
// 1. ats_report from generated resume (most accurate)
// 2. ats_only_reports cache (avoid redundant Haiku calls)
// 3. Fresh POST /api/jobs/:id/keywords call (base resume)
// To change keyword display format edit this component.
// To change extraction logic edit ATS_SYSTEM_PROMPT in
// server.js — it is shared between ATS scoring and keyword
// analysis.
import { useState, useEffect } from "react";
import { useTheme } from "../styles/theme.jsx";
import { api } from "../lib/api.js";
import { useSyncEvents } from "../hooks/useSyncEvents.js";
import {
  buildProfileClaimLookup,
  emitProfileSuggestionsUpdated,
  PROFILE_SUGGESTIONS_UPDATED_EVENT,
  setProfileClaim,
} from "../lib/profileSuggestions.js";
import { profileSignalKey } from "../../../shared/profileSignals.js";

export function ATSPanel({ report, score, jobId, resumeText, activeProfileId }) {
  const { theme } = useTheme();
  const [localReport, setLocalReport] = useState(null);
  const [kwLoading,   setKwLoading]   = useState(false);
  const [kwError,     setKwError]     = useState(false);
  const [addedItems,  setAddedItems]  = useState(new Set());
  const [profileSuggestions, setProfileSuggestions] = useState(null);
  const [profileSelections, setProfileSelections] = useState({ activeSkills: [], activeVerbs: [] });

  // Reset local state when the selected job changes — OR the profile does.
  //
  // addedItems is an optimistic echo of claims made in this session, and claims are PER PROFILE.
  // Keyed on jobId alone it survived a profile switch, so terms claimed on one profile rendered as
  // ticked on another that had never claimed them. Only on screen — the store was right, and a
  // reload cleared it — which is exactly the kind of wrong that gets believed.
  //
  // Keyed on the activeProfileId PROP rather than the derived clickableProfileId below: a dep array
  // is evaluated during render, and naming a const declared further down would read it in its
  // temporal dead zone. The prop is what changes when the user switches profile anyway.
  useEffect(() => {
    setLocalReport(null);
    setKwError(false);
    setAddedItems(new Set());
  }, [jobId, activeProfileId]);

  // Fetch keyword analysis when no generated-resume report exists
  useEffect(() => {
    if (report) return;              // Priority 1 — generated resume covers this
    if (!jobId || !resumeText) return;
    if (localReport || kwLoading) return;

    let cancelled = false;
    setKwLoading(true);
    setKwError(false);
    api(`/api/jobs/${jobId}/keywords`, {
      method: "POST",
      body: JSON.stringify({ resumeText }),
    })
      .then(data => { if (!cancelled) setLocalReport(data); })
      .catch(() => { if (!cancelled) setKwError(true); })
      .finally(() => { if (!cancelled) setKwLoading(false); });
    return () => { cancelled = true; };
  }, [jobId, resumeText, report]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeReport = report ?? localReport;
  const clickableProfileId = activeProfileId || activeReport?.profileId || activeReport?.domainProfileId || null;
  const loadProfileSuggestions = async (profileId) => {
    if (!profileId) {
      setProfileSuggestions(null);
      setProfileSelections({ activeSkills: [], activeVerbs: [] });
      return;
    }
    try {
      const [next, profiles] = await Promise.all([
        api(`/api/domain-profiles/${profileId}/suggestions`),
        api("/api/domain-profiles"),
      ]);
      setProfileSuggestions(next || null);
      const activeProfile = (Array.isArray(profiles) ? profiles : []).find(profile => Number(profile.id) === Number(profileId));
      setProfileSelections({
        activeSkills: activeProfile?.selected_tools || [],
        activeVerbs: activeProfile?.selected_verbs || [],
      });
    } catch {}
  };

  useEffect(() => {
    loadProfileSuggestions(clickableProfileId);
  }, [clickableProfileId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handleSuggestionsUpdated = (event) => {
      if (!clickableProfileId) return;
      if (Number(event.detail?.profileId) !== Number(clickableProfileId)) return;
      if (event.detail?.suggestions) setProfileSuggestions(event.detail.suggestions);
      else loadProfileSuggestions(clickableProfileId);
    };
    window.addEventListener(PROFILE_SUGGESTIONS_UPDATED_EVENT, handleSuggestionsUpdated);
    return () => window.removeEventListener(PROFILE_SUGGESTIONS_UPDATED_EVENT, handleSuggestionsUpdated);
  }, [clickableProfileId]); // eslint-disable-line react-hooks/exhaustive-deps

  useSyncEvents({
    profile_switched: () => {
      if (clickableProfileId) loadProfileSuggestions(clickableProfileId);
    },
  });

  /**
   * The candidate claiming, or withdrawing, a term (AG2).
   *
   * Reversible. The old handler wrote straight into domain_profiles.selected_tools and there was
   * no un-add anywhere in the product, so a misclick was permanent — and a permanent "yes" is not
   * an opt-in. A term already written by that old path (status 'applied') still reads as claimed,
   * because it was a claim; it just cannot be taken back here, which is what `locked` marks.
   */
  const toggleClaim = async (kind, label, claimed) => {
    if (!clickableProfileId || !label) return;
    const key = `${kind}:${label}`;
    setAddedItems(prev => {
      const next = new Set(prev);
      if (claimed) next.add(key); else next.delete(key);
      return next;
    });
    try {
      const next = await setProfileClaim(clickableProfileId, kind, label, claimed);
      setProfileSuggestions(next || null);
      emitProfileSuggestionsUpdated(clickableProfileId, next || null);
    } catch {
      setAddedItems(prev => {
        const next = new Set(prev);
        if (claimed) next.delete(key); else next.add(key);
        return next;
      });
    }
  };

  // No base resume uploaded yet
  if (!activeReport && !resumeText && !kwLoading) {
    return (
      <div style={{ padding:24, display:"flex", flexDirection:"column",
                    alignItems:"center", justifyContent:"center", gap:12,
                    height:"100%", color:"var(--color-text-muted)", fontSize:13, textAlign:"center" }}>
        <div style={{ fontSize:40 }}>📊</div>
        <div>Add a base resume to see keyword analysis for this role.</div>
      </div>
    );
  }

  // Loading skeleton
  if (kwLoading) {
    return (
      <div style={{ padding:24, display:"flex", flexDirection:"column",
                    alignItems:"center", justifyContent:"center", gap:14,
                    height:"100%", color:"var(--color-text-muted)", fontSize:13, textAlign:"center" }}>
        <div style={{ fontSize:28, animation:"spin 1.2s linear infinite" }}>⚙️</div>
        <div style={{ color:"var(--color-text)", fontWeight:600 }}>Analysing keywords...</div>
        <div style={{ fontSize:11 }}>Checking your resume against the job description</div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:6, justifyContent:"center", marginTop:4 }}>
          {[80,60,100,75,55,90,65,85].map((w,i) => (
            <div key={i} style={{ height:22, width:w, borderRadius:4,
              background:"var(--color-surface-offset)", opacity:0.6 }}/>
          ))}
        </div>
      </div>
    );
  }

  // Error state
  if (kwError) {
    return (
      <div style={{ padding:24, display:"flex", flexDirection:"column",
                    alignItems:"center", justifyContent:"center", gap:12,
                    height:"100%", color:"var(--color-text-muted)", fontSize:13, textAlign:"center" }}>
        <div style={{ fontSize:40 }}>⚠️</div>
        <div>Could not analyse keywords — retry</div>
        <button onClick={() => { setKwError(false); setLocalReport(null); }}
          style={{ marginTop:8, padding:"6px 16px", borderRadius:6, border:"none",
                   background:"var(--color-primary)", color:"var(--color-primary-text)", cursor:"pointer",
                   fontWeight:600, fontSize:12 }}>
          Retry
        </button>
      </div>
    );
  }

  if (!activeReport) return null;

  // Strengths and improvements only ever came from the LLM scorer. Matched on the family rather
  // than one exact version string, so bumping the local report version (local_ats_v1 -> v2, and
  // whatever comes after) cannot quietly switch two sections back on for local reports.
  const isLocalReport = String(activeReport.source || "").startsWith("local_ats");

  const R = 32, cx = 40, cy = 40, stroke = 7;
  const circumference = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(100, activeReport.score ?? score ?? 0));
  const scoreColor = pct >= 80 ? "#22c55e" : pct >= 60 ? "var(--color-warning)" : "#ef4444";
  // AG2. CLAIMED, not merely suggested. The old lookup unioned every status, so a term the
  // scrape-time aggregator had written unprompted rendered as an already-added chip the user could
  // not click — an auto-opt-in the user never made. Only what the candidate said counts here.
  const claimLookup = buildProfileClaimLookup(profileSuggestions || {});
  // Terms already written into the profile's own lists. Those are claims too, made through the
  // old one-way path or typed in by hand, but there is no un-add for them so they show as locked.
  const lockedSkillLookup = new Set((profileSelections.activeSkills || []).map(profileSignalKey).filter(Boolean));
  const lockedVerbLookup = new Set((profileSelections.activeVerbs || []).map(profileSignalKey).filter(Boolean));
  // Provenance: what the base resume already evidences. The scorer has already decided this — a
  // term is in `matched` precisely because it found it in the resume — so nothing is re-derived.
  const evidencedLookup = new Set([
    ...(activeReport.tier1_matched || []),
    ...(activeReport.action_verbs_matched || []),
  ].map(profileSignalKey).filter(Boolean));

  return (
    // No scroller and no height:100% of its own any more. This used to be handed a fixed-height
    // react-resizable-panels column and had to scroll itself; it is now rendered inside
    // PanelShell's body (see AtsReportPanel), which is the scroll container. Keeping overflowY:auto
    // here would nest a second scrollbar inside the first, and height:100% would clip the report to
    // the panel body's height instead of letting it extend and scroll.
    <div style={{ padding:"16px 16px", display:"flex", flexDirection:"column", gap:14 }}>

      {/* Score card — shown when a score is available */}
      {activeReport.score != null && (
        <div style={{ background:"var(--color-surface)", border:`1px solid ${"var(--color-border)"}`,
                      borderRadius:16, padding:"16px", display:"flex", alignItems:"center", gap:16 }}>
          <div style={{ position:"relative", width:80, height:80, flexShrink:0 }}>
            <svg width={80} height={80} viewBox="0 0 80 80">
              <circle cx={cx} cy={cy} r={R} fill="none" stroke={"var(--color-surface-offset)"} strokeWidth={stroke}/>
              <circle cx={cx} cy={cy} r={R} fill="none" stroke={scoreColor} strokeWidth={stroke}
                strokeLinecap="round" strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - pct / 100)}
                transform={`rotate(-90 ${cx} ${cy})`}
                style={{ transition:"stroke-dashoffset 0.8s ease-out" }}/>
            </svg>
            <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center",
                          justifyContent:"center", fontWeight:900, fontSize:22, color:scoreColor }}>
              {activeReport.score ?? score ?? "—"}
            </div>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:12, color:"var(--color-text-muted)", fontStyle:"italic",
                          lineHeight:1.6, marginBottom:8 }}>
              {activeReport.verdict || activeReport.experience?.summary || "Deterministic local ATS match against this profile."}
            </div>
            {activeReport.best_possible_score != null && (
              <div style={{ fontSize:11, padding:"6px 10px", borderRadius:8,
                            background: pct === activeReport.best_possible_score ? "#0a1f0a" : "var(--color-surface-offset)",
                            color: pct === activeReport.best_possible_score ? "#22c55e" : "var(--color-text-muted)",
                            border:`1px solid ${pct === activeReport.best_possible_score ? "color-mix(in srgb, #22c55e 20%, transparent)" : "var(--color-border)"}` }}>
                {pct === activeReport.best_possible_score
                  ? "✓ Max achievable score for your profile"
                  : <>
                      <span style={{ fontWeight:700 }}>Best possible: {activeReport.best_possible_score}</span>
                      {activeReport.best_possible_reason && <span> — {activeReport.best_possible_reason}</span>}
                    </>
                }
              </div>
            )}
          </div>
        </div>
      )}

      {/* Skills matched */}
      {activeReport.tier1_matched?.length > 0 && (
        <TagSection title="✓ Skills Matched"
          subtitle="This job asked for these, and your resume already evidences them."
          bg={"#0a1f0a"} fg={"#22c55e"} border={"color-mix(in srgb, #22c55e 20%, transparent)"}
          items={activeReport.tier1_matched}
          evidencedLookup={evidencedLookup}/>
      )}

      {/* Skills missing */}
      {activeReport.tier1_missing?.length > 0 && (
        <TagSection title="✗ Skills Missing"
          subtitle="This job asked for these and your resume does not show them. Claim any that are true of you."
          bg={"#1f0a0a"} fg={"#ef4444"} border={"color-mix(in srgb, #ef4444 20%, transparent)"}
          items={activeReport.tier1_missing}
          onToggleClaim={clickableProfileId ? (item, claimed) => toggleClaim("skill", item, claimed) : null}
          pendingItems={addedItems}
          claimedLookup={claimLookup}
          lockedLookup={lockedSkillLookup}
          evidencedLookup={evidencedLookup}
          kind="skill"
          theme={theme}/>
      )}

      {/* Action verbs matched */}
      {activeReport.action_verbs_matched?.length > 0 && (
        <TagSection title="⚡ Verbs Matched"
          subtitle="Your resume already uses this job's language for these."
          bg={"#0a1525"} fg={"#38bdf8"} border={"color-mix(in srgb, #38bdf8 20%, transparent)"}
          items={activeReport.action_verbs_matched}
          kind="action_verb"
          evidencedLookup={evidencedLookup}/>
      )}

      {/* Action verbs missing */}
      {activeReport.action_verbs_missing?.length > 0 && (
        <TagSection title="⚠ Verbs Missing"
          subtitle="This job's language for work you may already have done. Claim the ones that describe you."
          bg={"#1f1500"} fg={"var(--color-warning)"} border={"color-mix(in srgb, var(--color-warning) 20%, transparent)"}
          items={activeReport.action_verbs_missing}
          onToggleClaim={clickableProfileId ? (item, claimed) => toggleClaim("action_verb", item, claimed) : null}
          pendingItems={addedItems}
          claimedLookup={claimLookup}
          lockedLookup={lockedVerbLookup}
          evidencedLookup={evidencedLookup}
          kind="action_verb"
          theme={theme}/>
      )}

      {activeReport.experience && (
        <ListSection title="Experience Fit" items={[activeReport.experience.summary]} color={activeReport.experience.fit ? "#22c55e" : "var(--color-warning)"} theme={theme}/>
      )}

      {activeReport.hard_constraint_misses?.length > 0 && (
        <TagSection title="Profile Facts Missing"
          bg={"#1f0a0a"} fg={"#ef4444"} border={"color-mix(in srgb, #ef4444 20%, transparent)"}
          items={activeReport.hard_constraint_misses}/>
      )}

      {/* Strengths */}
      {!isLocalReport && activeReport.strengths?.length > 0 && (
        <ListSection title="💪 Strengths" items={activeReport.strengths} color={"#22c55e"} theme={theme}/>
      )}

      {/* Improvements */}
      {!isLocalReport && activeReport.improvements?.length > 0 && (
        <ListSection title="🔧 Improvements" items={activeReport.improvements} color={"var(--color-primary)"} theme={theme}/>
      )}
    </div>
  );
}

/**
 * A row of terms, each of which the candidate may CLAIM (AG2).
 *
 * THE COPY IS THE FEATURE. Clicking one of these asserts "I have this" — it is the candidate
 * making a claim they will have to defend in an interview, which is the only direction this can
 * safely run. So the chip must never read as "add this to improve your score": that invites
 * someone to tick things because a number goes up, and the number is not the thing being decided.
 * Hence "is true of you" / "You claimed this", and a line saying in plain words that claiming does
 * not move the score. It does not: claims are deliberately kept out of the scoring basis, so a
 * claim cannot flatter its own number.
 *
 * NOTHING IS PRE-SELECTED. `claimedLookup` holds only what the person actually claimed.
 */
function TagSection({
  title,
  subtitle = null,
  bg,
  fg,
  border,
  items,
  onToggleClaim = null,
  pendingItems = new Set(),
  claimedLookup = { skillKeys: new Set(), verbKeys: new Set() },
  lockedLookup = new Set(),
  evidencedLookup = new Set(),
  kind = "skill",
  theme,
}) {
  const claimedKeys = kind === "action_verb" ? claimedLookup.verbKeys : claimedLookup.skillKeys;
  return (
    <div>
      <div className="rm-section-label" style={{ color:fg }}>{title}</div>
      {subtitle && (
        <div style={{ fontSize:11, color:"var(--color-text-muted)", marginBottom:6, lineHeight:1.5 }}>
          {subtitle}
        </div>
      )}
      <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
        {items.map(k => {
          const itemKey = profileSignalKey(k);
          const locked = lockedLookup.has(itemKey);
          const claimed = locked || claimedKeys.has(itemKey) || pendingItems.has(`${kind}:${k}`);
          const evidenced = evidencedLookup.has(itemKey);
          const interactive = !!onToggleClaim && !locked;
          const provenance = evidenced
            ? "Your resume already shows this"
            : claimed
              ? "You claimed this — the job description asked for it"
              : "This job asked for it. Your resume does not show it.";
          return (
          <button key={k} type="button" className="rm-badge"
            onClick={interactive ? () => onToggleClaim(k, !claimed) : undefined}
            disabled={!interactive}
            aria-pressed={interactive ? claimed : undefined}
            title={interactive
              ? (claimed
                  ? `You claimed "${k}". Click to withdraw it.`
                  : `Claim "${k}" — only if it is true of you. It informs future resumes; it does not change this score.`)
              : provenance}
            style={{
              background:claimed ? "#0a1f0a" : bg,
              color:claimed ? "#22c55e" : fg,
              border:`1px solid ${claimed ? "color-mix(in srgb, #22c55e 20%, transparent)" : border}`,
              cursor:interactive ? "pointer" : "default",
            }}>
            {claimed ? `✓ ${k}` : k}
          </button>
        )})}
      </div>
      {onToggleClaim && (
        <div style={{ fontSize:10, color:"var(--color-text-muted)", marginTop:6, fontStyle:"italic" }}>
          Claiming a term says it is true of you. It is used in resumes generated from now on, and
          never rewrites one you already have. It does not change this score.
        </div>
      )}
    </div>
  );
}

function ListSection({ title, items, color, theme }) {
  return (
    <div>
      <div className="rm-section-label" style={{ color }}>{title}</div>
      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        {items.map((t,i) => (
          <div key={i} style={{ display:"flex", gap:8, fontSize:12,
                                 color:"var(--color-text-muted)", lineHeight:1.6 }}>
            <span style={{ color, flexShrink:0, fontWeight:700 }}>·</span>
            <span>{t}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
