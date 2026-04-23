import { useCallback, useEffect, useState } from "react";
import { api, authHeaders } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { useJobBoard } from "../contexts/JobBoardContext.jsx";
import DomainProfileWizard from "../components/DomainProfileWizard.jsx";

export function JobProfilesPanel() {
  const { theme } = useTheme();
  const { setActiveProfileId, deleteProfileCache } = useJobBoard() || {};
  const [profiles, setProfiles] = useState([]);
  const [status, setStatus] = useState("");
  const [wizardMode, setWizardMode] = useState(null);
  const [editingProfile, setEditingProfile] = useState(null);
  const [uploadingProfileId, setUploadingProfileId] = useState(null);

  const parseResumeFile = async (file) => {
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "pdf") {
      const fd = new FormData();
      fd.append("file", file);
      const response = await fetch("/api/parse-pdf", {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: fd,
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || "PDF parse failed");
      return data.text || "";
    }
    if (ext === "docx") {
      const mammoth = (await import("mammoth")).default;
      return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
    }
    return file.text();
  };

  const formatTimestamp = (value) => {
    if (!value) return "";
    try { return new Date(Number(value) * 1000).toLocaleDateString(); }
    catch { return ""; }
  };

  const loadProfiles = useCallback(async () => {
    try {
      const rows = await api("/api/domain-profiles");
      const next = Array.isArray(rows) ? rows : [];
      setProfiles(next);
      const active = next.find(p => p.is_active) || next[0];
      if (active) setActiveProfileId?.(active.id);
    } catch (e) {
      setStatus(e.message || "Could not load job profiles");
    }
  }, [setActiveProfileId]);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  const activateProfile = async (id) => {
    try {
      await api(`/api/domain-profiles/${id}/activate`, { method: "POST" });
      setProfiles(prev => prev.map(p => ({ ...p, is_active: p.id === id ? 1 : 0 })));
      setActiveProfileId?.(id);
      setStatus("Active job profile updated");
    } catch (e) {
      setStatus(e.message || "Could not activate profile");
    }
  };

  const deleteProfile = async (profile) => {
    if (!profile || profiles.length <= 1) return;
    if (!confirm(`Delete job profile "${profile.profile_name}"?`)) return;
    try {
      await api(`/api/domain-profiles/${profile.id}`, { method: "DELETE" });
      deleteProfileCache?.(profile.id);
      await loadProfiles();
      setStatus("Job profile deleted");
    } catch (e) {
      setStatus(e.message || "Could not delete profile");
    }
  };

  const openCreate = () => {
    setEditingProfile(null);
    setWizardMode("create");
  };

  const openEdit = (profile) => {
    setEditingProfile(profile);
    setWizardMode("edit");
  };

  const uploadProfileResume = async (profile, event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !profile?.id) return;
    setUploadingProfileId(profile.id);
    setStatus(`Parsing resume for ${profile.profile_name}...`);
    try {
      const text = await parseResumeFile(file);
      if (!String(text || "").trim()) throw new Error("No text was extracted from that resume");
      await api(`/api/domain-profiles/${profile.id}/base-resume`, {
        method: "POST",
        body: JSON.stringify({ content: text, name: file.name }),
      });
      await loadProfiles();
      setStatus(`Base resume updated for ${profile.profile_name}. Extracted signals were refreshed for this profile only.`);
    } catch (e) {
      setStatus(e.message || "Could not upload profile resume");
    } finally {
      setUploadingProfileId(null);
    }
  };

  const closeWizard = () => {
    setWizardMode(null);
    setEditingProfile(null);
  };

  return (
    <div style={{ flex:1, overflow:"auto", padding:"24px 28px", background:theme.bg, color:theme.text }}>
      <div style={{ maxWidth:1100, margin:"0 auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:16, marginBottom:18 }}>
          <div>
            <div className="rm-section-label">Job Profiles</div>
            <h1 style={{
              margin:"4px 0 6px",
              fontFamily:"'Barlow Condensed','DM Sans',sans-serif",
              textTransform:"uppercase",
              letterSpacing:"0.06em",
              fontSize:30,
            }}>
              Manage Job Profiles
            </h1>
            <p style={{ margin:0, color:theme.textMuted, fontSize:13, maxWidth:640, lineHeight:1.5 }}>
              Create, edit, delete, and switch profile-specific search targets. Each job profile keeps its own titles,
              skills, base resume, extracted signals, ATS basis, and search behavior.
            </p>
          </div>
          <button type="button" className="rm-btn rm-btn-primary" onClick={openCreate}>
            + Add Profile
          </button>
        </div>

        {status && (
          <div style={{ marginBottom:14, fontSize:12, color:theme.textMuted }}>
            {status}
          </div>
        )}

        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(260px, 1fr))", gap:14 }}>
          {profiles.map(profile => {
            const active = !!profile.is_active;
            return (
              <div key={profile.id} style={{
                border:`1px solid ${active ? theme.accent : theme.border}`,
                background:active ? `${theme.accent}16` : theme.surface,
                borderRadius:16,
                padding:"16px 18px",
                boxShadow:theme.shadowSm,
              }}>
                <div style={{ display:"flex", justifyContent:"space-between", gap:10, alignItems:"flex-start" }}>
                  <div>
                    <div style={{ fontWeight:800, fontSize:15 }}>{profile.profile_name}</div>
                    <div style={{ fontSize:11, color:theme.textMuted, marginTop:4 }}>
                      {profile.seniority || "mid"} | {profile.has_base_resume ? "resume linked" : "resume missing"}
                    </div>
                  </div>
                  {active && (
                    <span style={{
                      fontSize:10,
                      fontWeight:800,
                      textTransform:"uppercase",
                      color:theme.accentText,
                      background:theme.accentMuted,
                      borderRadius:999,
                      padding:"3px 8px",
                    }}>
                      Active
                    </span>
                  )}
                </div>

                <div style={{ fontSize:12, color:theme.textMuted, marginTop:12, minHeight:36, lineHeight:1.45 }}>
                  {(profile.target_titles || []).slice(0, 3).join(", ") || profile.role_family || "No target titles yet"}
                </div>

                <div style={{
                  marginTop:14,
                  border:`1px solid ${theme.border}`,
                  background:theme.surfaceHigh,
                  borderRadius:12,
                  padding:"10px 12px",
                }}>
                  <div style={{ display:"flex", justifyContent:"space-between", gap:10, alignItems:"center" }}>
                    <div>
                      <div style={{ fontSize:11, fontWeight:800, textTransform:"uppercase", letterSpacing:"0.06em", color:theme.text }}>
                        Base Resume
                      </div>
                      <div style={{ fontSize:11, color:profile.has_base_resume ? "#16a34a" : "#d97706", marginTop:3 }}>
                        {profile.has_base_resume
                          ? `Ready${profile.base_resume_updated_at ? ` · ${formatTimestamp(profile.base_resume_updated_at)}` : ""}`
                          : "Required before search, ATS, and enhancement"}
                      </div>
                      <div style={{ fontSize:10, color:theme.textMuted, marginTop:2 }}>
                        {profile.has_base_resume
                          ? "Extracted metadata ready for this profile only"
                          : "ATS scoring, new scrapes, and enhancement are blocked for this profile"}
                      </div>
                    </div>
                    <label className="rm-btn rm-btn-sm" style={{ cursor:"pointer", margin:0 }}>
                      {uploadingProfileId === profile.id
                        ? "Parsing..."
                        : profile.has_base_resume ? "Replace" : "Upload"}
                      <input
                        type="file"
                        accept=".txt,.html,.md,.docx,.pdf"
                        onChange={event => uploadProfileResume(profile, event)}
                        style={{ display:"none" }}
                        disabled={uploadingProfileId === profile.id}
                      />
                    </label>
                  </div>
                  <div style={{ marginTop:7, fontSize:10, color:theme.textMuted, lineHeight:1.4 }}>
                    Stored and extracted only for this profile. Other profiles keep their own resume, signals, ATS basis, and search readiness.
                  </div>
                </div>

                <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginTop:16 }}>
                  <button type="button" className="rm-btn rm-btn-sm" onClick={() => openEdit(profile)}>
                    Edit
                  </button>
                  <button type="button" className="rm-btn rm-btn-sm" onClick={() => activateProfile(profile.id)} disabled={active}>
                    {active ? "Active" : "Switch"}
                  </button>
                  <button
                    type="button"
                    className="rm-btn rm-btn-sm"
                    onClick={() => deleteProfile(profile)}
                    disabled={profiles.length <= 1}
                    style={{ color:profiles.length <= 1 ? theme.textMuted : "#dc2626" }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {profiles.length === 0 && (
          <div style={{
            border:`1px dashed ${theme.border}`,
            background:theme.surface,
            borderRadius:16,
            padding:"28px",
            textAlign:"center",
            color:theme.textMuted,
          }}>
            No job profiles yet. Add your first profile to unlock profile-scoped search, ATS, and resume signals.
          </div>
        )}
      </div>

      {wizardMode && (
        <DomainProfileWizard
          key={editingProfile ? `edit-${editingProfile.id}` : "create-profile"}
          mode={wizardMode}
          initialProfile={editingProfile}
          onComplete={(profile) => {
            closeWizard();
            loadProfiles().then(() => {
              if (profile?.id) setActiveProfileId?.(profile.id);
            });
          }}
          onDismiss={closeWizard}
          bannerText={wizardMode === "edit"
            ? "Use the same guided selector UI from registration. Updates stay scoped to this job profile."
            : "Use the guided selector UI from registration to create another profile."}
        />
      )}
    </div>
  );
}
