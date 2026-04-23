// client/src/panels/ProfilePanel.jsx — Design System v4
import { useCallback, useEffect, useRef, useState } from "react";
import { api }      from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import DomainProfileWizard from "../components/DomainProfileWizard.jsx";

// ── Field normalisers ─────────────────────────────────────────
function normalisePhone(raw) {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return raw;
  return `+1 (${local.slice(0,3)}) ${local.slice(3,6)}-${local.slice(6)}`;
}
function normaliseUrl(raw) {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return "https://" + trimmed;
}
function normaliseZip(raw) {
  if (!raw) return "";
  return raw.replace(/[^\dA-Z\s-]/gi, "").trim().slice(0, 7);
}
function normaliseState(raw) {
  if (!raw) return "";
  return raw.trim().toUpperCase().slice(0, 2);
}

function splitChipText(raw) {
  return String(raw || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
}

function joinChipText(value) {
  return Array.isArray(value) ? value.join(", ") : "";
}

// ── Sub-components ─────────────────────────────────────────────
function PSec({ title, children, theme }) {
  return (
    <div style={{ marginBottom:20 }}>
      <div className="rm-section-label">{title}</div>
      <div style={{ background:theme.surface, border:`1px solid ${theme.border}`,
                    borderRadius:16, padding:"20px 24px",
                    boxShadow:theme.shadowSm }}>
        {children}
      </div>
    </div>
  );
}

const labelStyle = {
  fontSize:11, fontWeight:600, textTransform:"uppercase",
  letterSpacing:"0.05em", display:"block", marginBottom:4,
};

const PRow = ({ label, children, theme }) => (
  <div style={{ display:"flex", flexDirection:"column", marginBottom:12 }}>
    <span style={{ ...labelStyle, color:theme.textMuted }}>{label}</span>
    {children}
  </div>
);

const PHint = ({ children, theme }) => (
  <span style={{ fontSize:10, color:theme.textDim, marginTop:3, lineHeight:1.4, display:"block" }}>
    {children}
  </span>
);

export function ProfilePanel({ onOpenJobProfiles = () => {} }) {
  const { theme } = useTheme();

  const BLANK = {
    full_name:"", email:"", phone:"",
    linkedin_url:"", github_url:"",
    location:"", address_line1:"", address_line2:"",
    city:"", state:"", zip:"", country:"United States",
    gender:"", ethnicity:"", veteran_status:"", disability_status:"",
    requires_sponsorship:false, has_clearance:false,
    clearance_level:"", visa_type:"", work_auth:"",
  };

  const [form,   setForm]   = useState(BLANK);
  const [status, setStatus] = useState("");
  const [profiles, setProfiles] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState(null);
  const [profileForm, setProfileForm] = useState(null);
  const [signalsForm, setSignalsForm] = useState({
    titles: "", keywords: "", skills: "", searchTerms: "", yearsExperience: "",
  });
  const [structuredFactsForm, setStructuredFactsForm] = useState({
    citizenshipStatus: "",
    workAuthorization: "",
    requiresSponsorship: false,
    hasClearance: false,
    clearanceLevel: "",
    degreeLevel: "",
  });
  const [suggestedSignals, setSuggestedSignals] = useState({
    inactiveSkills: [],
    selectedSkills: [],
    appliedSkills: [],
    structuredFacts: [],
  });
  const [enhancementStatus, setEnhancementStatus] = useState({
    eligible: false,
    selectedCount: 0,
    threshold: 5,
    suggestedSkillCount: 0,
    structuredFactCount: 0,
    hasEnhancedDraft: false,
    history: [],
  });
  const [enhancementHistory, setEnhancementHistory] = useState([]);
  const [enhancingProfileResume, setEnhancingProfileResume] = useState(false);
  const [enhancePreview, setEnhancePreview] = useState(null);
  const [suggestionStatus, setSuggestionStatus] = useState("");
  const [resumeDraft, setResumeDraft] = useState("");
  const [resumeName, setResumeName] = useState("");
  const [profileStatus, setProfileStatus] = useState("");
  const [resumeStatus, setResumeStatus] = useState("");
  const [signalStatus, setSignalStatus] = useState("");
  const [loadingProfileAssets, setLoadingProfileAssets] = useState(false);
  const [uploadingResume, setUploadingResume] = useState(false);
  const [showProfileWizard, setShowProfileWizard] = useState(false);
  const resumeInputRef = useRef(null);

  const loadProfileAssets = useCallback(async (profileId) => {
    if (!profileId) return;
    setEnhancePreview(null);
    const [resume, signals, enhance, history] = await Promise.all([
      api(`/api/domain-profiles/${profileId}/base-resume`),
      api(`/api/domain-profiles/${profileId}/signals`),
      api(`/api/domain-profiles/${profileId}/enhance-status`),
      api(`/api/domain-profiles/${profileId}/enhancement-history`).catch(() => ({ history: [] })),
    ]);
    setResumeDraft(resume?.content || "");
    setResumeName(resume?.name || "");
    setSignalsForm({
      titles: joinChipText(signals?.titles),
      keywords: joinChipText(signals?.keywords),
      skills: joinChipText(signals?.skills),
      searchTerms: joinChipText(signals?.searchTerms),
      yearsExperience: signals?.yearsExperience ?? "",
    });
    setStructuredFactsForm({
      citizenshipStatus: signals?.structuredFacts?.citizenshipStatus || "",
      workAuthorization: signals?.structuredFacts?.workAuthorization || "",
      requiresSponsorship: !!signals?.structuredFacts?.requiresSponsorship,
      hasClearance: !!signals?.structuredFacts?.hasClearance,
      clearanceLevel: signals?.structuredFacts?.clearanceLevel || "",
      degreeLevel: signals?.structuredFacts?.degreeLevel || "",
    });
    setSuggestedSignals(signals?.suggestions || {
      inactiveSkills: [],
      selectedSkills: [],
      appliedSkills: [],
      structuredFacts: [],
    });
    setEnhancementStatus(enhance || {
      eligible: false,
      selectedCount: 0,
      threshold: 5,
      suggestedSkillCount: 0,
      structuredFactCount: 0,
      hasEnhancedDraft: false,
      history: [],
    });
    setEnhancementHistory(history?.history || enhance?.history || []);
  }, []);

  const loadProfiles = useCallback(async () => {
    try {
      const rows = await api("/api/domain-profiles");
      const next = Array.isArray(rows) ? rows : [];
      setProfiles(next);
      const active = next.find(p => p.is_active) || next[0] || null;
      setActiveProfileId(prev => (next.some(p => p.id === prev) ? prev : (active?.id ?? null)));
    } catch {}
  }, []);

  useEffect(() => {
    api("/api/profile")
      .then(d => setForm(f => ({
        ...f, ...d,
        requires_sponsorship: !!d.requires_sponsorship,
        has_clearance:        !!d.has_clearance,
      })))
      .catch(() => {});
  }, []);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  useEffect(() => {
    if (!activeProfileId) {
      setProfileForm(null);
      setResumeDraft("");
      setResumeName("");
      setSignalsForm({ titles: "", keywords: "", skills: "", searchTerms: "", yearsExperience: "" });
      setStructuredFactsForm({
        citizenshipStatus: "",
        workAuthorization: "",
        requiresSponsorship: false,
        hasClearance: false,
        clearanceLevel: "",
        degreeLevel: "",
      });
      setSuggestedSignals({ inactiveSkills: [], selectedSkills: [], appliedSkills: [], structuredFacts: [] });
      setEnhancementStatus({ eligible: false, selectedCount: 0, threshold: 5, suggestedSkillCount: 0, structuredFactCount: 0, hasEnhancedDraft: false, history: [] });
      setEnhancementHistory([]);
      return;
    }
    const selected = profiles.find(p => p.id === activeProfileId);
    if (selected) {
      setProfileForm({
        id: selected.id,
        profile_name: selected.profile_name || "",
        role_family: selected.role_family || "",
        domain: selected.domain || "",
        seniority: selected.seniority || "mid",
        target_titles: joinChipText(selected.target_titles),
        selected_keywords: joinChipText(selected.selected_keywords),
        selected_verbs: joinChipText(selected.selected_verbs),
        selected_tools: joinChipText(selected.selected_tools),
      });
    }

    setLoadingProfileAssets(true);
    loadProfileAssets(activeProfileId).catch(() => {
      setResumeDraft("");
      setResumeName("");
      setSignalsForm({ titles: "", keywords: "", skills: "", searchTerms: "", yearsExperience: "" });
    }).finally(() => setLoadingProfileAssets(false));
  }, [activeProfileId, profiles, loadProfileAssets]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const blurPhone    = () => set("phone",        normalisePhone(form.phone));
  const blurLinkedin = () => set("linkedin_url", normaliseUrl(form.linkedin_url));
  const blurGithub   = () => set("github_url",   normaliseUrl(form.github_url));
  const blurZip      = () => set("zip",          normaliseZip(form.zip));
  const blurState    = () => set("state",        normaliseState(form.state));

  const syncLocation = () => {
    if (form.city || form.state) {
      set("location", [form.city, form.state].filter(Boolean).join(", "));
    }
  };

  const save = async e => {
    e.preventDefault();
    const cleaned = {
      ...form,
      phone:        normalisePhone(form.phone),
      linkedin_url: normaliseUrl(form.linkedin_url),
      github_url:   normaliseUrl(form.github_url),
      zip:          normaliseZip(form.zip),
      state:        normaliseState(form.state),
      location:     form.city && form.state
                      ? `${form.city}, ${form.state}`
                      : (form.city || form.state || form.location || ""),
    };
    try {
      await api("/api/profile", { method:"POST", body:JSON.stringify(cleaned) });
      setForm(cleaned);
      setStatus("✓ Saved");
      setTimeout(() => setStatus(""), 3000);
    } catch { setStatus("✗ Save failed"); }
  };

  const activeProfile = profiles.find(p => p.id === activeProfileId) || null;

  const saveProfileSettings = async () => {
    if (!profileForm?.id) return;
    try {
      const updated = await api(`/api/domain-profiles/${profileForm.id}`, {
        method: "PUT",
        body: JSON.stringify({
          profile_name: profileForm.profile_name,
          role_family: profileForm.role_family,
          domain: profileForm.domain,
          seniority: profileForm.seniority,
          target_titles: splitChipText(profileForm.target_titles),
          selected_keywords: splitChipText(profileForm.selected_keywords),
          selected_verbs: splitChipText(profileForm.selected_verbs),
          selected_tools: splitChipText(profileForm.selected_tools),
        }),
      });
      setProfiles(prev => prev.map(p => (p.id === updated.id ? { ...p, ...updated } : p)));
      setProfileStatus("Saved job profile");
      setTimeout(() => setProfileStatus(""), 2500);
    } catch (e) {
      setProfileStatus(e.message || "Could not save profile");
    }
  };

  const saveSignals = async () => {
    if (!activeProfileId) return;
    try {
      await api(`/api/domain-profiles/${activeProfileId}/signals`, {
        method: "PUT",
        body: JSON.stringify({
          titles: splitChipText(signalsForm.titles),
          keywords: splitChipText(signalsForm.keywords),
          skills: splitChipText(signalsForm.skills),
          searchTerms: splitChipText(signalsForm.searchTerms),
          structuredFacts: structuredFactsForm,
          yearsExperience: signalsForm.yearsExperience === "" ? null : Number(signalsForm.yearsExperience),
        }),
      });
      setSignalStatus("Saved extracted signals");
      setTimeout(() => setSignalStatus(""), 2500);
      await loadProfileAssets(activeProfileId);
    } catch (e) {
      setSignalStatus(e.message || "Could not save signals");
    }
  };

  const refreshSignals = async () => {
    if (!activeProfileId) return;
    try {
      const next = await api(`/api/domain-profiles/${activeProfileId}/signals/refresh`, { method: "POST" });
      setSignalsForm({
        titles: joinChipText(next?.titles),
        keywords: joinChipText(next?.keywords),
        skills: joinChipText(next?.skills),
        searchTerms: joinChipText(next?.searchTerms),
        yearsExperience: next?.yearsExperience ?? "",
      });
      setStructuredFactsForm({
        citizenshipStatus: next?.structuredFacts?.citizenshipStatus || structuredFactsForm.citizenshipStatus,
        workAuthorization: next?.structuredFacts?.workAuthorization || structuredFactsForm.workAuthorization,
        requiresSponsorship: next?.structuredFacts?.requiresSponsorship ?? structuredFactsForm.requiresSponsorship,
        hasClearance: next?.structuredFacts?.hasClearance ?? structuredFactsForm.hasClearance,
        clearanceLevel: next?.structuredFacts?.clearanceLevel || structuredFactsForm.clearanceLevel,
        degreeLevel: next?.structuredFacts?.degreeLevel || structuredFactsForm.degreeLevel,
      });
      setSignalStatus("Refreshed from profile resume");
      setTimeout(() => setSignalStatus(""), 2500);
      await loadProfileAssets(activeProfileId);
    } catch (e) {
      setSignalStatus(e.message || "Could not refresh signals");
    }
  };

  const saveResume = async () => {
    if (!activeProfileId) return;
    try {
      await api(`/api/domain-profiles/${activeProfileId}/base-resume`, {
        method: "POST",
        body: JSON.stringify({ content: resumeDraft, name: resumeName || "resume.txt" }),
      });
      setResumeStatus("Saved profile resume");
      setTimeout(() => setResumeStatus(""), 2500);
      await refreshSignals();
      loadProfiles();
      await loadProfileAssets(activeProfileId);
    } catch (e) {
      setResumeStatus(e.message || "Could not save profile resume");
    }
  };

  const activateProfile = async (id) => {
    try {
      await api(`/api/domain-profiles/${id}/activate`, { method: "POST" });
      setActiveProfileId(id);
      setProfiles(prev => prev.map(p => ({ ...p, is_active: p.id === id ? 1 : 0 })));
    } catch {}
  };

  const updateSelectedSuggestions = async (nextKeys) => {
    if (!activeProfileId) return;
    try {
      const next = await api(`/api/domain-profiles/${activeProfileId}/suggestions`, {
        method: "PUT",
        body: JSON.stringify({ selectedSkillKeys: nextKeys }),
      });
      setSuggestedSignals(prev => ({
        ...prev,
        inactiveSkills: next?.inactiveSkills || [],
        selectedSkills: next?.selectedSkills || [],
        appliedSkills: next?.appliedSkills || prev.appliedSkills || [],
        structuredFacts: prev.structuredFacts,
      }));
      setEnhancementStatus(prev => ({ ...prev, ...(next?.enhancement || {}) }));
      setSuggestionStatus("Updated enhancement skill selections");
      setTimeout(() => setSuggestionStatus(""), 2500);
    } catch (e) {
      setSuggestionStatus(e.message || "Could not update suggested skills");
    }
  };

  const toggleSuggestedSkill = async (key, enabled) => {
    const current = (suggestedSignals.selectedSkills || []).map(item => item.key);
    const next = enabled
      ? [...new Set([...current, key])]
      : current.filter(item => item !== key);
    await updateSelectedSuggestions(next);
  };

  const runEnhancement = async () => {
    if (!activeProfileId || enhancingProfileResume) return;
    setEnhancingProfileResume(true);
    setResumeStatus("");
    try {
      const preview = await api(`/api/domain-profiles/${activeProfileId}/enhance`, { method: "POST" });
      setEnhancePreview(preview);
      setResumeStatus("Enhanced draft ready for review");
      await loadProfileAssets(activeProfileId);
    } catch (e) {
      setResumeStatus(e.message || "Could not enhance profile resume");
    } finally {
      setEnhancingProfileResume(false);
    }
  };

  const adoptEnhancedResume = async () => {
    if (!activeProfileId) return;
    try {
      await api(`/api/domain-profiles/${activeProfileId}/adopt-enhanced`, { method: "PATCH" });
      setEnhancePreview(null);
      setResumeStatus("Enhanced resume adopted for this profile");
      setTimeout(() => setResumeStatus(""), 2500);
      await loadProfileAssets(activeProfileId);
      await loadProfiles();
    } catch (e) {
      setResumeStatus(e.message || "Could not adopt enhanced resume");
    }
  };

  const uploadResumePdf = async (event) => {
    const file = event.target.files?.[0];
    if (!file || !activeProfileId) return;
    setUploadingResume(true);
    setResumeStatus("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const parsed = await api("/api/parse-pdf", { method: "POST", body: formData });
      setResumeDraft(parsed?.text || "");
      setResumeName(file.name);
      await api(`/api/domain-profiles/${activeProfileId}/base-resume`, {
        method: "POST",
        body: JSON.stringify({ content: parsed?.text || "", name: file.name }),
      });
      const nextSignals = await api(`/api/domain-profiles/${activeProfileId}/signals/refresh`, { method: "POST" });
      setSignalsForm({
        titles: joinChipText(nextSignals?.titles),
        keywords: joinChipText(nextSignals?.keywords),
        skills: joinChipText(nextSignals?.skills),
        searchTerms: joinChipText(nextSignals?.searchTerms),
        yearsExperience: nextSignals?.yearsExperience ?? "",
      });
      setResumeStatus("Uploaded and extracted for this profile");
      setTimeout(() => setResumeStatus(""), 2500);
      loadProfiles();
      await loadProfileAssets(activeProfileId);
    } catch (e) {
      setResumeStatus(e.message || "Could not parse resume");
    } finally {
      setUploadingResume(false);
      event.target.value = "";
    }
  };

  const selStyle = {
    width:"100%", height:40, padding:"0 12px", borderRadius:10,
    border:`1px solid ${theme.border}`, background:theme.surface,
    color:theme.text, fontSize:13, outline:"none", boxSizing:"border-box",
  };

  return (
    <div style={{ maxWidth:680, margin:"0 auto", padding:"32px 24px",
                  overflowY:"auto", height:"100%", boxSizing:"border-box" }}>
      <div style={{ fontWeight:900, fontSize:22, color:theme.text,
                    letterSpacing:"-0.5px", marginBottom:24 }}>
        Profile
      </div>
      <form onSubmit={save}>

        {/* ── Personal ── */}
        <PSec title="Personal" theme={theme}>
          <PRow label="Full Name" theme={theme}>
            <input className="rm-input" value={form.full_name || ""}
              onChange={e => set("full_name", e.target.value)}
              placeholder="First Last (or First Middle Last)"/>
            <PHint theme={theme}>Enter your name exactly as it should appear on your resume and applications.</PHint>
          </PRow>
          <PRow label="Email" theme={theme}>
            <input className="rm-input" type="email" value={form.email || ""}
              onChange={e => set("email", e.target.value)}
              placeholder="you@email.com"/>
          </PRow>
          <PRow label="Phone" theme={theme}>
            <input className="rm-input" type="tel" value={form.phone || ""}
              onChange={e => set("phone", e.target.value)}
              onBlur={blurPhone}
              placeholder="+1 (555) 000-0000 or 5550001234"/>
            <PHint theme={theme}>Any format accepted — normalised to +1 (XXX) XXX-XXXX on save.</PHint>
          </PRow>
          <PRow label="LinkedIn URL" theme={theme}>
            <input className="rm-input" value={form.linkedin_url || ""}
              onChange={e => set("linkedin_url", e.target.value)}
              onBlur={blurLinkedin}
              placeholder="linkedin.com/in/yourhandle"/>
          </PRow>
          <PRow label="GitHub URL" theme={theme}>
            <input className="rm-input" value={form.github_url || ""}
              onChange={e => set("github_url", e.target.value)}
              onBlur={blurGithub}
              placeholder="github.com/yourhandle"/>
          </PRow>
        </PSec>

        {/* ── Address ── */}
        <PSec title="Address (for autofill)" theme={theme}>
          <PRow label="Street Address" theme={theme}>
            <input className="rm-input" value={form.address_line1 || ""}
              onChange={e => set("address_line1", e.target.value)}
              placeholder="123 Main St"/>
          </PRow>
          <PRow label="Apt / Suite" theme={theme}>
            <input className="rm-input" value={form.address_line2 || ""}
              onChange={e => set("address_line2", e.target.value)}
              placeholder="Apt 4B"/>
          </PRow>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
            <PRow label="City" theme={theme}>
              <input className="rm-input" value={form.city || ""}
                onChange={e => set("city", e.target.value)}
                onBlur={syncLocation} placeholder="Boston"/>
            </PRow>
            <PRow label="State" theme={theme}>
              <input className="rm-input" value={form.state || ""}
                onChange={e => set("state", e.target.value)}
                onBlur={() => { blurState(); syncLocation(); }} placeholder="MA"/>
              <PHint theme={theme}>2-letter code</PHint>
            </PRow>
            <PRow label="ZIP" theme={theme}>
              <input className="rm-input" value={form.zip || ""}
                onChange={e => set("zip", e.target.value)}
                onBlur={blurZip} placeholder="02101"/>
            </PRow>
          </div>
          <PRow label="Country" theme={theme}>
            <select style={selStyle} value={form.country}
              onChange={e => set("country", e.target.value)}>
              <option>United States</option><option>Canada</option>
              <option>United Kingdom</option><option>India</option><option>Other</option>
            </select>
          </PRow>
        </PSec>

        {/* ── Work Auth ── */}
        <PSec title="Work Authorization" theme={theme}>
          <PRow label="Visa / Immigration Status" theme={theme}>
            <select style={selStyle} value={form.visa_type}
              onChange={e => set("visa_type", e.target.value)}>
              <option value="">Select…</option>
              <option>US Citizen</option><option>Green Card / LPR</option>
              <option>H-1B</option><option>OPT</option><option>STEM OPT</option>
              <option>TN Visa</option><option>O-1</option><option>Other</option>
            </select>
          </PRow>
          <PRow label="Work Authorization" theme={theme}>
            <select style={selStyle} value={form.work_auth}
              onChange={e => set("work_auth", e.target.value)}>
              <option value="">Select…</option>
              <option>Authorized to work in the US without sponsorship</option>
              <option>Will require sponsorship now or in the future</option>
            </select>
          </PRow>
          <label style={{ display:"flex", alignItems:"center", gap:8,
                          marginBottom:10, cursor:"pointer",
                          fontSize:13, color:theme.text }}>
            <input type="checkbox" checked={!!form.requires_sponsorship}
              onChange={e => set("requires_sponsorship", e.target.checked)}
              style={{ accentColor:theme.accent, width:16, height:16 }}/>
            Requires visa sponsorship
          </label>
          <label style={{ display:"flex", alignItems:"center", gap:8,
                          marginBottom:10, cursor:"pointer",
                          fontSize:13, color:theme.text }}>
            <input type="checkbox" checked={!!form.has_clearance}
              onChange={e => set("has_clearance", e.target.checked)}
              style={{ accentColor:theme.accent, width:16, height:16 }}/>
            Active security clearance
          </label>
          {form.has_clearance && (
            <PRow label="Clearance Level" theme={theme}>
              <select style={selStyle} value={form.clearance_level}
                onChange={e => set("clearance_level", e.target.value)}>
                <option value="">Select…</option>
                <option>Public Trust</option><option>Secret</option>
                <option>Top Secret</option><option>TS/SCI</option>
                <option>TS/SCI + Poly</option>
              </select>
            </PRow>
          )}
        </PSec>

        {/* ── EEO ── */}
        <PSec title="Voluntary Self-Identification (EEO)" theme={theme}>
          <p style={{ fontSize:12, color:theme.textMuted, lineHeight:1.6, marginBottom:14 }}>
            These fields are voluntary and used solely for EEO reporting autofill.
            They do not affect your resume or job search.
          </p>
          <PRow label="Gender" theme={theme}>
            <select style={selStyle} value={form.gender}
              onChange={e => set("gender", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>Male</option><option>Female</option>
              <option>Non-binary / third gender</option>
            </select>
          </PRow>
          <PRow label="Race / Ethnicity" theme={theme}>
            <select style={selStyle} value={form.ethnicity}
              onChange={e => set("ethnicity", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>Hispanic or Latino</option>
              <option>White (not Hispanic or Latino)</option>
              <option>Black or African American</option>
              <option>Asian</option>
              <option>Native Hawaiian or Other Pacific Islander</option>
              <option>American Indian or Alaska Native</option>
              <option>Two or more races</option>
            </select>
          </PRow>
          <PRow label="Veteran Status" theme={theme}>
            <select style={selStyle} value={form.veteran_status}
              onChange={e => set("veteran_status", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>I am a protected veteran</option>
              <option>I am not a protected veteran</option>
            </select>
          </PRow>
          <PRow label="Disability Status" theme={theme}>
            <select style={selStyle} value={form.disability_status}
              onChange={e => set("disability_status", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>Yes, I have a disability</option>
              <option>No, I do not have a disability</option>
            </select>
          </PRow>
        </PSec>

        <PSec title="Job Profiles" theme={theme}>
          <div style={{ fontSize:12, color:theme.textMuted, lineHeight:1.5, marginBottom:14 }}>
            Job profile creation, editing, switching, and deletion now live in the dedicated Job Profiles section.
            Profile-specific resume and signal editing remains below for the active profile.
          </div>
          <div style={{ fontSize:12, color:theme.textMuted, marginBottom:16 }}>
            Active profile: <strong style={{ color:theme.text }}>{activeProfile?.profile_name || "None selected"}</strong>
          </div>
          <div style={{ display:"none", flexWrap:"wrap", gap:10, marginBottom:16 }}>
            {profiles.map(profile => (
              <button
                key={profile.id}
                type="button"
                onClick={() => activateProfile(profile.id)}
                style={{
                  padding:"10px 12px",
                  borderRadius:10,
                  border:`1px solid ${profile.id === activeProfileId ? theme.accent : theme.border}`,
                  background: profile.id === activeProfileId ? `${theme.accent}22` : theme.bg,
                  color: theme.text,
                  cursor:"pointer",
                  minWidth:160,
                  textAlign:"left",
                }}
              >
                <div style={{ fontSize:13, fontWeight:700 }}>{profile.profile_name}</div>
                <div style={{ fontSize:11, color:theme.textMuted, marginTop:4 }}>
                  {profile.seniority} · {profile.has_base_resume ? "resume linked" : "resume missing"}
                </div>
              </button>
            ))}
            {profiles.length < 4 && (
              <button
                type="button"
                onClick={onOpenJobProfiles}
                style={{
                  padding:"10px 14px",
                  borderRadius:10,
                  border:`1px dashed ${theme.border}`,
                  background:theme.bg,
                  color:theme.textMuted,
                  cursor:"pointer",
                  fontWeight:700,
                }}
              >
                + Add / Edit Profiles
              </button>
            )}
          </div>
          <button type="button" className="rm-btn rm-btn-primary" onClick={onOpenJobProfiles}>
            Open Job Profiles
          </button>

          {!activeProfile && (
            <div style={{ fontSize:12, color:theme.textMuted }}>
              Create a job profile to connect a profile-specific base resume, extracted signals, titles, and search settings.
            </div>
          )}

          {false && activeProfile && profileForm && (
            <>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                <PRow label="Profile Name" theme={theme}>
                  <input className="rm-input" value={profileForm.profile_name}
                    onChange={e => setProfileForm(f => ({ ...f, profile_name: e.target.value }))}/>
                </PRow>
                <PRow label="Seniority" theme={theme}>
                  <select style={selStyle} value={profileForm.seniority}
                    onChange={e => setProfileForm(f => ({ ...f, seniority: e.target.value }))}>
                    <option value="junior">Entry Level</option>
                    <option value="mid">Mid Level</option>
                    <option value="senior">Senior</option>
                    <option value="executive">Executive / Director</option>
                  </select>
                </PRow>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                <PRow label="Role Family" theme={theme}>
                  <input className="rm-input" value={profileForm.role_family}
                    onChange={e => setProfileForm(f => ({ ...f, role_family: e.target.value }))}/>
                </PRow>
                <PRow label="Domain Key" theme={theme}>
                  <input className="rm-input" value={profileForm.domain}
                    onChange={e => setProfileForm(f => ({ ...f, domain: e.target.value }))}/>
                </PRow>
              </div>
              <PRow label="Target Titles" theme={theme}>
                <textarea className="rm-input" rows={3} value={profileForm.target_titles}
                  onChange={e => setProfileForm(f => ({ ...f, target_titles: e.target.value }))}
                  placeholder="Software Engineer, Backend Engineer, Platform Engineer"/>
                <PHint theme={theme}>Comma-separated. These titles shape search query variants and profile fit.</PHint>
              </PRow>
              <PRow label="Keywords" theme={theme}>
                <textarea className="rm-input" rows={3} value={profileForm.selected_keywords}
                  onChange={e => setProfileForm(f => ({ ...f, selected_keywords: e.target.value }))}
                  placeholder="distributed systems, APIs, cloud infrastructure"/>
              </PRow>
              <PRow label="Action Verbs" theme={theme}>
                <textarea className="rm-input" rows={2} value={profileForm.selected_verbs}
                  onChange={e => setProfileForm(f => ({ ...f, selected_verbs: e.target.value }))}
                  placeholder="Built, Designed, Automated"/>
              </PRow>
              <PRow label="Tools / Skills" theme={theme}>
                <textarea className="rm-input" rows={2} value={profileForm.selected_tools}
                  onChange={e => setProfileForm(f => ({ ...f, selected_tools: e.target.value }))}
                  placeholder="Node.js, React, PostgreSQL, AWS"/>
              </PRow>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:12 }}>
                <span style={{ fontSize:12, color:profileStatus ? theme.text : theme.textMuted }}>
                  {profileStatus || "Edit this profile any time. Changes affect only this profile."}
                </span>
                <button type="button" className="rm-btn rm-btn-primary" onClick={saveProfileSettings}>
                  Save Job Profile
                </button>
              </div>
            </>
          )}
        </PSec>

        {activeProfile && (
          <PSec title="Profile Resume and Signals" theme={theme}>
            <input
              ref={resumeInputRef}
              type="file"
              accept=".pdf"
              onChange={uploadResumePdf}
              style={{ display:"none" }}
            />
            <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:14 }}>
              <button type="button" className="rm-btn rm-btn-primary"
                onClick={() => resumeInputRef.current?.click()}>
                {uploadingResume ? "Parsing PDF..." : "Upload / Replace PDF"}
              </button>
              <button type="button" className="rm-btn"
                onClick={saveResume}
                style={{ border:`1px solid ${theme.border}`, background:theme.surfaceHigh, color:theme.text }}>
                Save Resume Text
              </button>
              <button type="button" className="rm-btn"
                onClick={refreshSignals}
                style={{ border:`1px solid ${theme.border}`, background:theme.surfaceHigh, color:theme.text }}>
                Refresh Extracted Signals
              </button>
            </div>
            <PRow label="Resume File Name" theme={theme}>
              <input className="rm-input" value={resumeName}
                onChange={e => setResumeName(e.target.value)}
                placeholder="resume.pdf"/>
            </PRow>
            <PRow label="Profile Base Resume" theme={theme}>
              <textarea className="rm-input" rows={10} value={resumeDraft}
                onChange={e => setResumeDraft(e.target.value)}
                placeholder="Upload a profile-specific PDF or paste resume text here."/>
              <PHint theme={theme}>This base resume belongs only to the selected profile and drives profile-specific ATS/search behavior.</PHint>
            </PRow>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, marginBottom:16, flexWrap:"wrap" }}>
              <div style={{ fontSize:12, color:theme.textMuted }}>
                {enhancementStatus.eligible
                  ? `Enhancement ready: ${enhancementStatus.selectedCount}/${enhancementStatus.threshold} ATS-backed additions selected.`
                  : `Select at least ${enhancementStatus.threshold} broadly useful ATS suggestions before enhancing this profile resume.`}
              </div>
              {enhancementStatus.eligible && (
                <button
                  type="button"
                  className="rm-btn rm-btn-primary"
                  onClick={runEnhancement}
                  disabled={enhancingProfileResume}
                >
                  {enhancingProfileResume ? "Enhancing..." : "Enhance Base Resume"}
                </button>
              )}
            </div>
            <div style={{ fontSize:12, color:resumeStatus ? theme.text : theme.textMuted, marginBottom:16 }}>
              {loadingProfileAssets ? "Loading profile resume..." : (resumeStatus || "Each profile keeps its own stored resume and extracted signal set.")}
            </div>

            {enhancePreview && (
              <div style={{
                border:`1px solid ${theme.border}`,
                borderRadius:12,
                padding:"14px 16px",
                marginBottom:16,
                background:theme.surfaceHigh,
              }}>
                <div style={{ display:"flex", justifyContent:"space-between", gap:12, alignItems:"center", marginBottom:10, flexWrap:"wrap" }}>
                  <div style={{ fontSize:13, fontWeight:700, color:theme.text }}>
                    Enhanced draft ready
                  </div>
                  <div style={{ fontSize:12, color:theme.textMuted }}>
                    ATS delta: {enhancePreview.delta > 0 ? "+" : ""}{enhancePreview.delta ?? 0}
                  </div>
                </div>
                <div style={{ fontSize:11, color:theme.textMuted, marginBottom:10 }}>
                  Selected additions: {(enhancePreview.selectedSkills || []).join(", ") || "No new additions"}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
                  <textarea className="rm-input" rows={8} readOnly value={enhancePreview.original?.text || ""} />
                  <textarea className="rm-input" rows={8} readOnly value={enhancePreview.enhanced?.text || ""} />
                </div>
                <div style={{ display:"flex", justifyContent:"flex-end", gap:10 }}>
                  <button type="button" className="rm-btn" onClick={() => setEnhancePreview(null)}
                    style={{ border:`1px solid ${theme.border}`, background:theme.surface, color:theme.text }}>
                    Dismiss
                  </button>
                  <button type="button" className="rm-btn rm-btn-primary" onClick={adoptEnhancedResume}>
                    Adopt Enhanced Resume
                  </button>
                </div>
              </div>
            )}

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              <PRow label="Citizenship / Status" theme={theme}>
                <input className="rm-input" value={structuredFactsForm.citizenshipStatus}
                  onChange={e => setStructuredFactsForm(f => ({ ...f, citizenshipStatus: e.target.value }))}
                  placeholder="U.S. citizen, permanent resident, etc." />
              </PRow>
              <PRow label="Work Authorization" theme={theme}>
                <input className="rm-input" value={structuredFactsForm.workAuthorization}
                  onChange={e => setStructuredFactsForm(f => ({ ...f, workAuthorization: e.target.value }))}
                  placeholder="Authorized to work without sponsorship" />
              </PRow>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", fontSize:13, color:theme.text }}>
                <input type="checkbox" checked={!!structuredFactsForm.requiresSponsorship}
                  onChange={e => setStructuredFactsForm(f => ({ ...f, requiresSponsorship: e.target.checked }))}/>
                Requires sponsorship
              </label>
              <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", fontSize:13, color:theme.text }}>
                <input type="checkbox" checked={!!structuredFactsForm.hasClearance}
                  onChange={e => setStructuredFactsForm(f => ({ ...f, hasClearance: e.target.checked }))}/>
                Active clearance
              </label>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginTop:12 }}>
              <PRow label="Clearance Level" theme={theme}>
                <input className="rm-input" value={structuredFactsForm.clearanceLevel}
                  onChange={e => setStructuredFactsForm(f => ({ ...f, clearanceLevel: e.target.value }))}
                  placeholder="Secret, TS/SCI, Public Trust" />
              </PRow>
              <PRow label="Degree Level" theme={theme}>
                <input className="rm-input" value={structuredFactsForm.degreeLevel}
                  onChange={e => setStructuredFactsForm(f => ({ ...f, degreeLevel: e.target.value }))}
                  placeholder="Bachelor's, Master's, PhD" />
              </PRow>
            </div>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              <PRow label="Extracted Titles" theme={theme}>
                <textarea className="rm-input" rows={3} value={signalsForm.titles}
                  onChange={e => setSignalsForm(f => ({ ...f, titles: e.target.value }))}/>
              </PRow>
              <PRow label="Years of Experience" theme={theme}>
                <input className="rm-input" type="number" min="0" max="50" value={signalsForm.yearsExperience}
                  onChange={e => setSignalsForm(f => ({ ...f, yearsExperience: e.target.value }))}/>
              </PRow>
            </div>
            <PRow label="Extracted Keywords" theme={theme}>
              <textarea className="rm-input" rows={4} value={signalsForm.keywords}
                onChange={e => setSignalsForm(f => ({ ...f, keywords: e.target.value }))}/>
            </PRow>
            <PRow label="Extracted Skills / Tools" theme={theme}>
              <textarea className="rm-input" rows={3} value={signalsForm.skills}
                onChange={e => setSignalsForm(f => ({ ...f, skills: e.target.value }))}/>
            </PRow>
            <div style={{ marginBottom:16 }}>
              <div style={{ ...labelStyle, color:theme.textMuted, marginBottom:8 }}>Inactive ATS-Suggested Skills</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
                {(suggestedSignals.inactiveSkills || []).length === 0 && (
                  <span style={{ fontSize:12, color:theme.textMuted }}>
                    ATS suggestions will appear here after enough scraped jobs surface recurring missing skills.
                  </span>
                )}
                {(suggestedSignals.inactiveSkills || []).map(skill => (
                  <button
                    key={skill.key}
                    type="button"
                    onClick={() => toggleSuggestedSkill(skill.key, true)}
                    style={{
                      border:`1px dashed ${theme.border}`,
                      background:theme.bg,
                      color:theme.text,
                      borderRadius:999,
                      padding:"6px 10px",
                      cursor:"pointer",
                      fontSize:12,
                    }}
                  >
                    + {skill.label} ({skill.frequency})
                  </button>
                ))}
              </div>
            </div>
            <div style={{ marginBottom:16 }}>
              <div style={{ ...labelStyle, color:theme.textMuted, marginBottom:8 }}>Selected For Enhancement</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
                {(suggestedSignals.selectedSkills || []).length === 0 && (
                  <span style={{ fontSize:12, color:theme.textMuted }}>
                    Pick broadly useful ATS suggestions here. Enhancement unlocks when you reach the threshold.
                  </span>
                )}
                {(suggestedSignals.selectedSkills || []).map(skill => (
                  <button
                    key={skill.key}
                    type="button"
                    onClick={() => toggleSuggestedSkill(skill.key, false)}
                    style={{
                      border:`1px solid ${theme.accent}`,
                      background:`${theme.accent}22`,
                      color:theme.text,
                      borderRadius:999,
                      padding:"6px 10px",
                      cursor:"pointer",
                      fontSize:12,
                    }}
                  >
                    ✓ {skill.label}
                  </button>
                ))}
              </div>
              <PHint theme={theme}>
                Structured ATS facts stay separate from skill suggestions. They should be edited in the profile facts fields above.
              </PHint>
            </div>
            {(suggestedSignals.structuredFacts || []).length > 0 && (
              <div style={{ marginBottom:16 }}>
                <div style={{ ...labelStyle, color:theme.textMuted, marginBottom:8 }}>Structured ATS Facts Seen In Target Jobs</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
                  {(suggestedSignals.structuredFacts || []).map(item => (
                    <span key={item.key} style={{
                      border:`1px solid ${theme.border}`,
                      borderRadius:999,
                      padding:"6px 10px",
                      fontSize:12,
                      color:theme.textMuted,
                      background:theme.surface,
                    }}>
                      {item.label} ({item.frequency})
                    </span>
                  ))}
                </div>
              </div>
            )}
            <PRow label="Search Terms" theme={theme}>
              <textarea className="rm-input" rows={2} value={signalsForm.searchTerms}
                onChange={e => setSignalsForm(f => ({ ...f, searchTerms: e.target.value }))}/>
              <PHint theme={theme}>These terms are used for profile-scoped search shaping and ATS basis signals.</PHint>
            </PRow>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:12 }}>
              <span style={{ fontSize:12, color:signalStatus ? theme.text : theme.textMuted }}>
                {signalStatus || suggestionStatus || "Edit extracted values when needed. They persist per profile and do not leak across profiles."}
              </span>
              <button type="button" className="rm-btn rm-btn-primary" onClick={saveSignals}>
                Save Extracted Signals
              </button>
            </div>
            {enhancementHistory.length > 0 && (
              <div style={{ marginTop:16, fontSize:12, color:theme.textMuted }}>
                {enhancementHistory.length} enhancement version{enhancementHistory.length === 1 ? "" : "s"} stored for this profile.
              </div>
            )}
          </PSec>
        )}

        <div style={{ display:"flex", justifyContent:"flex-end", alignItems:"center",
                      gap:14, marginTop:8 }}>
          {status && (
            <span style={{ fontSize:12,
              color:status.startsWith("✓") ? theme.success : theme.danger }}>
              {status}
            </span>
          )}
          <button type="submit" className="rm-btn rm-btn-primary"
            style={{ padding:"10px 28px", fontSize:14 }}>
            Save Profile
          </button>
        </div>
      </form>
      {false && showProfileWizard && (
        <DomainProfileWizard
          onComplete={(profile) => {
            setShowProfileWizard(false);
            loadProfiles().then(() => setActiveProfileId(profile?.id || null));
          }}
          onDismiss={() => setShowProfileWizard(false)}
        />
      )}
    </div>
  );
}
