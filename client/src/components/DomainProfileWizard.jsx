// client/src/components/DomainProfileWizard.jsx
// Multi-step wizard for creating a domain profile.
// Used as: blocking overlay (existing users, domain_profile_complete=0)
//      and: dismissible modal (new profile from job board "+" button)
//
// Props:
//   onComplete(profile) — called after profile saved to API
//   onDismiss()         — if provided, shows an X button; if null, wizard is blocking
//   bannerText          — optional string shown at top (for existing user re-engagement)

import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

const STEPS = ["Domain", "Level", "Titles", "Keywords", "Save"];

function arrayField(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return String(value).split(",").map(v => v.trim()).filter(Boolean);
}

// ── Chip component ────────────────────────────────────────────
function Chip({ label, selected, onToggle }) {
  const { theme } = useTheme();
  return (
    <button
      type="button"
      onClick={() => onToggle(label)}
      style={{
        padding: "4px 12px", borderRadius: 999, border: "none",
        fontSize: 12, fontWeight: 600, cursor: "pointer",
        background: selected ? theme.accent : theme.surfaceHigh,
        color:      selected ? "#0f0f0f"    : theme.textMuted,
        transition: "all 0.12s",
        userSelect: "none",
      }}
    >
      {selected ? "✓ " : ""}{label}
    </button>
  );
}

// ── ChipAddInput — type + add a custom chip ───────────────────
function ChipAddInput({ placeholder, onAdd }) {
  const { theme } = useTheme();
  const [val, setVal] = useState("");
  const submit = () => {
    const v = val.trim();
    if (v) { onAdd(v); setVal(""); }
  };
  return (
    <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
      <input
        value={val} onChange={e => setVal(e.target.value)}
        onKeyDown={e => e.key === "Enter" && submit()}
        placeholder={placeholder}
        style={{
          flex: 1, padding: "4px 10px", borderRadius: 6,
          border: `1px solid ${theme.border}`, background: theme.bg,
          color: theme.text, fontSize: 12, outline: "none",
        }}
      />
      <button type="button" onClick={submit} style={{
        padding: "4px 12px", borderRadius: 6, border: "none",
        background: theme.accent, color: "#0f0f0f",
        fontSize: 12, fontWeight: 700, cursor: "pointer",
      }}>+</button>
    </div>
  );
}

// ── Step indicator ────────────────────────────────────────────
function StepIndicator({ current, total }) {
  const { theme } = useTheme();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 28 }}>
      {Array.from({ length: total }, (_, i) => (
        <div key={i} style={{
          width: i < current ? 28 : 8,
          height: 4, borderRadius: 2,
          background: i < current ? theme.accent
                    : i === current - 1 ? theme.accent
                    : theme.border,
          transition: "all 0.2s",
        }}/>
      ))}
      <span style={{ fontSize: 11, color: theme.textMuted, marginLeft: 4 }}>
        {current} of {total}
      </span>
    </div>
  );
}

// ── Main wizard ───────────────────────────────────────────────
export default function DomainProfileWizard({
  onComplete,
  onDismiss,
  bannerText,
  initialDomainKey = null,
  mode = "create",
  initialProfile = null,
}) {
  const { theme } = useTheme();
  const isEditMode = mode === "edit" && !!initialProfile?.id;
  const [step,       setStep]       = useState(1);
  const [domains,    setDomains]    = useState([]);
  const [domainKey,  setDomainKey]  = useState(initialProfile?.domain || null);
  const [domainMeta, setDomainMeta] = useState(null);
  const [seniority,  setSeniority]  = useState(initialProfile?.seniority || "mid");
  const [titles,     setTitles]     = useState(() => new Set(arrayField(initialProfile?.target_titles)));
  const [keywords,   setKeywords]   = useState(() => new Set(arrayField(initialProfile?.selected_keywords)));
  const [verbs,      setVerbs]      = useState(() => new Set(arrayField(initialProfile?.selected_verbs)));
  const [tools,      setTools]      = useState(() => new Set(arrayField(initialProfile?.selected_tools)));
  const [industries, setIndustries] = useState(new Set());
  const [otherRoleTitle, setOtherRoleTitle] = useState("");
  const [otherRoleFamily, setOtherRoleFamily] = useState("");
  const [otherWorkPreference, setOtherWorkPreference] = useState("");
  const [otherNotes, setOtherNotes] = useState("");
  const [aiChips,    setAiChips]    = useState(null);
  const [loadingAi,  setLoadingAi]  = useState(false);
  const [profileName, setProfileName] = useState(initialProfile?.profile_name || "");
  const [saving,        setSaving]        = useState(false);
  const [error,         setError]         = useState("");
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [domainsError,   setDomainsError]   = useState(false);
  const isOtherProfile = domainKey === "other_profile_request";

  // Load domain list on mount
  const loadDomains = () => {
    setLoadingDomains(true);
    setDomainsError(false);
    api("/api/domain-profiles/metadata")
      .then(list => { setDomains(Array.isArray(list) ? list : []); setLoadingDomains(false); })
      .catch(() => { setLoadingDomains(false); setDomainsError(true); });
  };
  useEffect(() => { loadDomains(); }, []);

  useEffect(() => {
    if (initialDomainKey && !domainKey) setDomainKey(initialDomainKey);
  }, [initialDomainKey, domainKey]);

  useEffect(() => {
    if (!isEditMode) return;
    setDomainKey(initialProfile?.domain || "general");
    setSeniority(initialProfile?.seniority || "mid");
    setProfileName(initialProfile?.profile_name || "");
    setTitles(new Set(arrayField(initialProfile?.target_titles)));
    setKeywords(new Set(arrayField(initialProfile?.selected_keywords)));
    setVerbs(new Set(arrayField(initialProfile?.selected_verbs)));
    setTools(new Set(arrayField(initialProfile?.selected_tools)));
  }, [isEditMode, initialProfile?.id]);

  // When domain is selected, fetch its metadata and pre-select all chips
  useEffect(() => {
    if (!domainKey) return;
    api(`/api/domain-profiles/metadata/${domainKey}`).then(meta => {
      setDomainMeta(meta);
      if (isEditMode) {
        setTitles(prev => prev.size ? prev : new Set(meta.requestOnly ? [] : meta.suggestedTitles));
        setKeywords(prev => prev.size ? prev : new Set(meta.keywords));
        setVerbs(prev => prev.size ? prev : new Set(meta.actionVerbs));
        setTools(prev => prev.size ? prev : new Set(meta.tools));
        setProfileName(prev => prev || (meta.requestOnly ? "" : meta.label));
        setAiChips(null);
        return;
      }
      setTitles(new Set(meta.requestOnly ? [] : meta.suggestedTitles));
      setKeywords(new Set(meta.keywords));
      setVerbs(new Set(meta.actionVerbs));
      setTools(new Set(meta.tools));
      setProfileName(meta.requestOnly ? "" : meta.label);
      setIndustries(new Set());
      setOtherRoleTitle("");
      setOtherRoleFamily("");
      setOtherWorkPreference("");
      setOtherNotes("");
      setAiChips(null);
    }).catch(() => {});
  }, [domainKey, isEditMode]);

  const toggleSet = useCallback((setter, value) => {
    setter(prev => {
      const next = new Set(prev);
      next.has(value) ? next.delete(value) : next.add(value);
      return next;
    });
  }, []);

  const addToSet = useCallback((setter, value) => {
    setter(prev => new Set([...prev, value]));
  }, []);

  const loadAiChips = async () => {
    if (!domainKey || !domainMeta) return;
    setLoadingAi(true);
    try {
      const result = await api("/api/domain-profiles/generate-chips", {
        method: "POST",
        body: JSON.stringify({
          domain:            domainKey,
          roleFamily:        domainMeta.roleFamily,
          existingKeywords:  [...keywords],
          existingVerbs:     [...verbs],
          existingTools:     [...tools],
        }),
      });
      setAiChips(result);
      // Auto-add to selections
      result.keywords.forEach(k => addToSet(setKeywords, k));
      result.verbs.forEach(v    => addToSet(setVerbs,    v));
      result.tools.forEach(t    => addToSet(setTools,    t));
    } catch { /* silent — user can retry */ }
    finally { setLoadingAi(false); }
  };

  const save = async () => {
    if (!profileName.trim()) { setError("Profile name is required"); return; }
    if (isOtherProfile && !otherRoleTitle.trim()) {
      setError("Desired role title is required");
      return;
    }
    setSaving(true); setError("");
    try {
      if (!isEditMode && isOtherProfile) {
        await api("/api/domain-profiles/requests", {
          method: "POST",
          body: JSON.stringify({
            desired_title: otherRoleTitle.trim(),
            role_family: otherRoleFamily.trim(),
            target_titles: [...new Set([otherRoleTitle.trim(), ...titles].filter(Boolean))],
            skills: [...keywords],
            tools: [...tools],
            industries: [...industries],
            keywords: [...keywords],
            seniority,
            work_preference: otherWorkPreference.trim(),
            notes: otherNotes.trim(),
          }),
        });
      }
      const profile = await api(
        isEditMode ? `/api/domain-profiles/${initialProfile.id}` : "/api/domain-profiles",
        {
        method: isEditMode ? "PUT" : "POST",
        body: JSON.stringify({
          profile_name:      profileName.trim(),
          role_family:       isOtherProfile ? "general" : (domainMeta?.roleFamily || initialProfile?.role_family || "general"),
          domain:            isOtherProfile ? "general" : (domainKey || initialProfile?.domain || "general"),
          seniority,
          target_titles:     isOtherProfile
            ? [...new Set([otherRoleTitle.trim(), ...titles].filter(Boolean))]
            : [...titles],
          selected_keywords: isOtherProfile
            ? [...new Set([...keywords, otherRoleFamily.trim()].filter(Boolean))]
            : [...keywords],
          selected_verbs:    [...verbs],
          selected_tools:    [...tools],
        }),
      });
      onComplete(profile);
    } catch(e) {
      setError(e.message || "Failed to save profile");
    } finally { setSaving(false); }
  };

  const canNext = () => {
    if (step === 1) return !!domainKey;
    if (step === 2) return !!seniority;
    if (step === 3 && isOtherProfile) return !!otherRoleTitle.trim();
    return true;
  };

  const SENIORITY_OPTIONS = [
    { id: "junior",    label: "Entry Level",       sub: "0–2 years" },
    { id: "mid",       label: "Mid Level",          sub: "3–5 years" },
    { id: "senior",    label: "Senior",             sub: "6–10 years" },
    { id: "executive", label: "Executive / Director", sub: "10+ years" },
  ];

  return (
    /* OVERLAY — covers viewport, centres modal, never clips children */
    <div style={{
      position: "fixed",
      inset: 0,
      backgroundColor: "rgba(0,0,0,0.65)",
      backdropFilter: "blur(4px)",
      WebkitBackdropFilter: "blur(4px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
      pointerEvents: "auto",
      padding: "16px",
    }}>

      {/* MODAL CONTAINER — flex column, height capped at 90vh */}
      <div style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        boxShadow: theme.shadowXl,
        borderRadius: 12,
        width: "100%",
        maxWidth: 680,
        maxHeight: "90vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        zIndex: 1001,
        position: "relative",
      }}>

        {/* HEADER — never scrolls, never shrinks */}
        <div style={{
          flexShrink: 0,
          padding: "20px 24px 16px",
          borderBottom: `1px solid ${theme.border}`,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 20, color: theme.text,
                          fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: "-0.5px" }}>
              {isEditMode ? "Edit Job Search Profile" : "Create Your Job Search Profile"}
            </div>
            {bannerText && (
              <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 4, maxWidth: 480 }}>
                {bannerText}
              </div>
            )}
          </div>
          {onDismiss && (
            <button type="button" onClick={onDismiss} style={{
              background: "none", border: "none", cursor: "pointer",
              color: theme.textMuted, fontSize: 18, padding: "0 4px", lineHeight: 1, flexShrink: 0,
            }}>✕</button>
          )}
        </div>

        {/* PROGRESS — never scrolls, never shrinks */}
        <div style={{ flexShrink: 0, padding: "12px 24px 0" }}>
          <StepIndicator current={step} total={STEPS.length} />
        </div>

        {/* BODY — the ONLY scrolling element; minHeight:0 is critical */}
        <div style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "0 24px 16px",
        }}>

          {/* ── STEP 1: Domain ── */}
          {step === 1 && (
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6, color: theme.text }}>
                What type of roles are you targeting?
              </div>
              <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 20 }}>
                Select the domain that best fits your career focus, including software, firmware, embedded, systems, and specialist engineering roles. You can add up to 4 profiles total.
              </div>
              {loadingDomains ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "24px 0",
                              color: theme.textMuted, fontSize: 13 }}>
                  <div style={{ width: 18, height: 18, border: `2px solid ${theme.border}`,
                                borderTop: `2px solid ${theme.accent}`, borderRadius: "50%",
                                animation: "spin 0.8s linear infinite", flexShrink: 0 }}/>
                  Loading domains…
                </div>
              ) : domainsError ? (
                <div style={{ padding: "20px 0" }}>
                  <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 12 }}>
                    Could not load domain options.
                  </div>
                  <button type="button" onClick={loadDomains} style={{
                    padding: "6px 16px", borderRadius: 6, border: `1px solid ${theme.border}`,
                    background: theme.bg, color: theme.text, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  }}>Retry</button>
                </div>
              ) : (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
                    {domains.map(d => (
                      <button type="button" key={d.key} onClick={() => setDomainKey(d.key)} style={{
                        padding: "14px 16px", borderRadius: 8, cursor: "pointer",
                        border: `2px solid ${domainKey === d.key ? theme.accent : theme.border}`,
                        background: domainKey === d.key ? theme.accent + "18" : theme.bg,
                        textAlign: "left", transition: "all 0.15s",
                      }}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: theme.text, marginBottom: 4 }}>
                          {d.label}
                        </div>
                        <div style={{ fontSize: 11, color: theme.textMuted, lineHeight: 1.4 }}>
                          {(d.exampleTitles || []).join(" · ")}
                        </div>
                      </button>
                    ))}
                  </div>
                  {!domainKey && domains.length > 0 && (
                    <div style={{ marginTop: 12, fontSize: 11, color: theme.textMuted, fontStyle: "italic" }}>
                      Select a domain above to continue.
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── STEP 2: Seniority ── */}
          {step === 2 && (
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6, color: theme.text }}>
                What level are you targeting?
              </div>
              <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 20 }}>
                This shapes which title variants appear in your job search.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {SENIORITY_OPTIONS.map(opt => (
                  <button type="button" key={opt.id} onClick={() => setSeniority(opt.id)} style={{
                    padding: "16px 20px", borderRadius: 8, cursor: "pointer",
                    border: `2px solid ${seniority === opt.id ? theme.accent : theme.border}`,
                    background: seniority === opt.id ? theme.accent + "18" : theme.bg,
                    textAlign: "left", display: "flex", alignItems: "center", gap: 16,
                    transition: "all 0.15s",
                  }}>
                    <div style={{
                      width: 16, height: 16, borderRadius: "50%",
                      border: `2px solid ${seniority === opt.id ? theme.accent : theme.border}`,
                      background: seniority === opt.id ? theme.accent : "transparent",
                      flexShrink: 0,
                    }}/>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: theme.text }}>{opt.label}</div>
                      <div style={{ fontSize: 12, color: theme.textMuted }}>{opt.sub}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── STEP 3: Target titles ── */}
          {step === 3 && (
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6, color: theme.text }}>
                Which roles are you open to?
              </div>
              <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 20 }}>
                {isOtherProfile
                  ? "Tell us the role you want supported and any title aliases we should search for."
                  : "All pre-selected. Deselect any that don't fit. We'll search for all selected titles."}
              </div>
              {isOtherProfile && (
                <div style={{ display: "grid", gap: 12, marginBottom: 18 }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: theme.textMuted, marginBottom: 4 }}>
                      Desired role title
                    </div>
                    <input
                      value={otherRoleTitle}
                      onChange={e => {
                        const value = e.target.value;
                        setOtherRoleTitle(value);
                        if (!profileName.trim() || profileName.startsWith("Other: ")) {
                          setProfileName(value ? `Other: ${value}` : "");
                        }
                      }}
                      placeholder="e.g. Robotics Controls Engineer"
                      style={{
                        width: "100%", padding: "9px 12px", borderRadius: 8,
                        border: `1px solid ${theme.border}`, background: theme.bg,
                        color: theme.text, fontSize: 13, outline: "none",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: theme.textMuted, marginBottom: 4 }}>
                      Broad role family or category
                    </div>
                    <input
                      value={otherRoleFamily}
                      onChange={e => setOtherRoleFamily(e.target.value)}
                      placeholder="e.g. robotics, controls, technical writing, research engineering"
                      style={{
                        width: "100%", padding: "9px 12px", borderRadius: 8,
                        border: `1px solid ${theme.border}`, background: theme.bg,
                        color: theme.text, fontSize: 13, outline: "none",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                </div>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {[...titles].concat(
                  (domainMeta?.suggestedTitles || []).filter(t => !titles.has(t))
                ).map(t => (
                  <Chip key={t} label={t} selected={titles.has(t)}
                    onToggle={() => toggleSet(setTitles, t)} />
                ))}
              </div>
              <ChipAddInput placeholder="Add a custom title…" onAdd={v => addToSet(setTitles, v)} />
            </div>
          )}

          {/* ── STEP 4: Keywords / Tools / Verbs ── */}
          {step === 4 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6, color: theme.text }}>
                  Select your skills and keywords
                </div>
                <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 16 }}>
                  These drive your job search and resume generation. All pre-selected.
                </div>
              </div>
              {[
                { label: "Keywords", set: keywords, setter: setKeywords,
                  base: domainMeta?.keywords || [], ai: aiChips?.keywords || [],
                  placeholder: "Add a keyword…" },
                { label: "Tools & Technologies", set: tools, setter: setTools,
                  base: domainMeta?.tools || [], ai: aiChips?.tools || [],
                  placeholder: "Add a tool…" },
                { label: "Action Verbs", set: verbs, setter: setVerbs,
                  base: domainMeta?.actionVerbs || [], ai: aiChips?.verbs || [],
                  placeholder: "Add a verb…" },
              ].map(({ label, set, setter, base, ai, placeholder }) => (
                <div key={label}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: theme.textMuted,
                                textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                    {label}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {[...new Set([...base, ...ai])].map(chip => (
                      <Chip key={chip} label={chip} selected={set.has(chip)}
                        onToggle={() => toggleSet(setter, chip)} />
                    ))}
                  </div>
                  <ChipAddInput placeholder={placeholder} onAdd={v => addToSet(setter, v)} />
                </div>
              ))}
              {isOtherProfile && (
                <>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: theme.textMuted,
                                  textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                      Preferred Industries / Domains
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {[...industries].map(chip => (
                        <Chip key={chip} label={chip} selected={industries.has(chip)}
                          onToggle={() => toggleSet(setIndustries, chip)} />
                      ))}
                    </div>
                    <ChipAddInput placeholder="Add an industry or domain..." onAdd={v => addToSet(setIndustries, v)} />
                  </div>
                  <div style={{ display: "grid", gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: theme.textMuted, marginBottom: 4 }}>
                        Location / work preference
                      </div>
                      <input
                        value={otherWorkPreference}
                        onChange={e => setOtherWorkPreference(e.target.value)}
                        placeholder="e.g. remote, hybrid in Austin, open to relocation"
                        style={{
                          width: "100%", padding: "9px 12px", borderRadius: 8,
                          border: `1px solid ${theme.border}`, background: theme.bg,
                          color: theme.text, fontSize: 13, outline: "none",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: theme.textMuted, marginBottom: 4 }}>
                        Notes for support
                      </div>
                      <textarea
                        value={otherNotes}
                        onChange={e => setOtherNotes(e.target.value)}
                        placeholder="Anything we should know about this role, titles, tools, or search support."
                        rows={3}
                        style={{
                          width: "100%", padding: "9px 12px", borderRadius: 8,
                          border: `1px solid ${theme.border}`, background: theme.bg,
                          color: theme.text, fontSize: 13, outline: "none",
                          boxSizing: "border-box", resize: "vertical",
                        }}
                      />
                    </div>
                  </div>
                </>
              )}
              <button
                type="button"
                onClick={loadAiChips}
                disabled={loadingAi}
                style={{
                  alignSelf: "flex-start", padding: "6px 16px", borderRadius: 6,
                  border: `1px solid ${theme.border}`, background: theme.bg,
                  color: theme.text, fontSize: 12, fontWeight: 600,
                  cursor: loadingAi ? "default" : "pointer", opacity: loadingAi ? 0.6 : 1,
                }}
              >
                {loadingAi ? "Loading suggestions…" : "Load more AI suggestions"}
              </button>
            </div>
          )}

          {/* ── STEP 5: Name + save ── */}
          {step === 5 && (
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6, color: theme.text }}>
                Name this profile
              </div>
              <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 20 }}>
                {isOtherProfile
                  ? "This creates a search profile and sends your role details for support review."
                  : isEditMode
                    ? "Update the name for this search focus. Changes stay scoped to this job profile."
                    : "Give it a name that identifies this search focus. You can rename it any time."}
              </div>
              <input
                value={profileName}
                onChange={e => setProfileName(e.target.value)}
                maxLength={60}
                placeholder="e.g. Software Engineering"
                style={{
                  width: "100%", padding: "10px 14px", borderRadius: 8,
                  border: `1.5px solid ${theme.border}`, background: theme.bg,
                  color: theme.text, fontSize: 15, fontWeight: 600,
                  outline: "none", boxSizing: "border-box",
                }}
              />
              <div style={{
                marginTop: 20, padding: "14px 16px", borderRadius: 8,
                background: theme.bg, border: `1px solid ${theme.border}`,
                display: "flex", flexDirection: "column", gap: 6,
              }}>
                <div style={{ fontSize: 12, color: theme.textMuted }}>
                  <strong style={{ color: theme.text }}>Domain:</strong> {domainMeta?.label || domainKey}
                </div>
                {isOtherProfile && (
                  <div style={{ fontSize: 12, color: theme.textMuted }}>
                    <strong style={{ color: theme.text }}>Requested role:</strong> {otherRoleTitle || "Not set"}
                  </div>
                )}
                <div style={{ fontSize: 12, color: theme.textMuted }}>
                  <strong style={{ color: theme.text }}>Seniority:</strong>{" "}
                  {["junior","mid","senior","executive"].includes(seniority)
                    ? { junior: "Entry Level", mid: "Mid Level", senior: "Senior", executive: "Executive / Director" }[seniority]
                    : seniority}
                </div>
                <div style={{ fontSize: 12, color: theme.textMuted }}>
                  <strong style={{ color: theme.text }}>Titles:</strong>{" "}
                  {[...titles].slice(0,5).join(", ")}{titles.size > 5 ? ` +${titles.size-5} more` : ""}
                </div>
                <div style={{ fontSize: 12, color: theme.textMuted }}>
                  <strong style={{ color: theme.text }}>Keywords selected:</strong>{" "}
                  {keywords.size} · Tools: {tools.size} · Verbs: {verbs.size}
                </div>
              </div>
              {error && (
                <div style={{ marginTop: 12, fontSize: 12, color: "#dc2626", fontWeight: 600 }}>{error}</div>
              )}
            </div>
          )}
        </div>

        {/* FOOTER — never scrolls, never shrinks */}
        <div style={{
          flexShrink: 0,
          borderTop: `1px solid ${theme.border}`,
          padding: "16px 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: theme.surface,
        }}>
          <button
            type="button"
            onClick={() => setStep(s => Math.max(1, s - 1))}
            disabled={step === 1}
            style={{
              padding: "8px 20px", borderRadius: 6, border: `1px solid ${theme.border}`,
              background: "transparent", color: step === 1 ? theme.textMuted : theme.text,
              fontSize: 13, fontWeight: 600, cursor: step === 1 ? "default" : "pointer",
              opacity: step === 1 ? 0.4 : 1,
            }}
          >
            Back
          </button>

          <span style={{ fontSize: 12, color: theme.textMuted }}>
            {step} of {STEPS.length}
          </span>

          {step < STEPS.length ? (
            <button
              type="button"
              onClick={() => canNext() && setStep(s => s + 1)}
              disabled={!canNext()}
              style={{
                padding: "8px 28px", borderRadius: 6, border: "none",
                background: canNext() ? theme.accent : theme.surfaceHigh,
                color: canNext() ? "#0f0f0f" : theme.textMuted,
                fontSize: 13, fontWeight: 700,
                cursor: canNext() ? "pointer" : "default",
              }}
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              onClick={save}
              disabled={saving || !profileName.trim() || (isOtherProfile && !otherRoleTitle.trim())}
              style={{
                padding: "8px 28px", borderRadius: 6, border: "none",
                background: (saving || !profileName.trim() || (isOtherProfile && !otherRoleTitle.trim())) ? theme.surfaceHigh : theme.accent,
                color: (saving || !profileName.trim() || (isOtherProfile && !otherRoleTitle.trim())) ? theme.textMuted : "#0f0f0f",
                fontSize: 13, fontWeight: 700,
                cursor: (saving || !profileName.trim() || (isOtherProfile && !otherRoleTitle.trim())) ? "default" : "pointer",
              }}
            >
              {saving ? "Saving..." : isEditMode ? "Save Profile" : "Create Profile"}
            </button>
          )}
        </div>

      </div>
    </div>
  );
}
