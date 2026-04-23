import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
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
