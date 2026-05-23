import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

function StatusPill({ status, healthy, theme }) {
  const color = healthy ? "#16a34a" : status === "missing" || status === "not_connected" ? "#dc2626" : "#d97706";
  return (
    <span style={{ display:"inline-flex", alignItems:"center", border:`1px solid ${color}55`,
      background:`${color}14`, color, borderRadius:6, padding:"3px 7px", fontSize:11, fontWeight:800 }}>
      {healthy ? "Active" : String(status || "pending").replace(/_/g, " ")}
    </span>
  );
}

function Section({ title, subtitle, status, children, theme }) {
  const resolvedStatus = status || { healthy: false, status: "missing" };
  return (
    <section style={{ border:`1px solid ${"var(--color-border)"}`, background:"var(--color-surface)",
      borderRadius:8, padding:18, display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:12 }}>
        <div>
          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
            fontSize:18, letterSpacing:"0.06em", textTransform:"uppercase", color:"var(--color-text)" }}>
            {title}
          </div>
          <div style={{ fontSize:12, color:"var(--color-text-muted)", lineHeight:1.5, marginTop:2 }}>{subtitle}</div>
        </div>
        <StatusPill theme={theme} status={resolvedStatus.status} healthy={resolvedStatus.healthy}/>
      </div>
      {children}
    </section>
  );
}

export function IntegrationsPanel() {
  const { theme } = useTheme();
  const [status, setStatus] = useState(null);
  const [msg, setMsg] = useState("");

  const load = () => api("/api/integrations/status").then(setStatus).catch(e => setMsg(e.message));
  useEffect(() => { load(); }, []);

  const startOAuth = (provider) => {
    const readiness = status?.oauth?.[provider];
    if (readiness && !readiness.configured) {
      setMsg(`${provider === "linkedin" ? "LinkedIn" : "Google"} OAuth is not configured by the app operator: ${readiness.missing.join(", ")} missing.`);
      return;
    }
    if (provider === "linkedin") {
      window.location.href = "/auth/linkedin";
      return;
    }
    window.location.href = `/api/auth/oauth/${provider}/start?mode=link&returnTo=${encodeURIComponent("/app/integrations")}`;
  };

  const disconnectProvider = async (provider) => {
    await api(`/api/integrations/${provider}`, { method:"DELETE" });
    setMsg(`${provider === "gmail" ? "Gmail" : provider === "linkedin" ? "LinkedIn" : "Google"} disconnected.`);
    load();
  };

  const buttonStyle = { border:"none", borderRadius:6, background:"var(--color-primary)", color:"#0f0f0f",
    padding:"8px 12px", cursor:"pointer", fontWeight:800, fontSize:12 };
  const secondaryButton = { ...buttonStyle, background:"var(--color-surface-offset)", color:"var(--color-text)", border:`1px solid ${"var(--color-border)"}` };
  const oauthSectionStatus = (provider, userStatus) => {
    const operator = status?.oauth?.[provider];
    if (operator && !operator.configured) return { healthy:false, status:operator.status || "not_configured" };
    return userStatus;
  };
  const oauthHelp = (provider) => {
    const operator = status?.oauth?.[provider];
    if (!operator) return null;
    if (!operator.configured) return `${provider === "linkedin" ? "LinkedIn" : "Google"} OAuth is not configured: ${operator.missing.join(", ")} missing.`;
    if (operator.warnings?.length) return `Configured with warnings: ${operator.warnings.join(", ")}.`;
    return "OAuth app configuration is ready.";
  };

  if (!status) {
    return <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", color:"var(--color-text-muted)" }}>Loading integrations...</div>;
  }

  return (
    <div style={{ flex:1, overflowY:"auto", background:"var(--color-bg)", padding:"28px 24px 44px" }}>
      <div style={{ maxWidth:980, margin:"0 auto", display:"flex", flexDirection:"column", gap:16 }}>
        <div>
          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:28,
            fontWeight:800, letterSpacing:"0.06em", textTransform:"uppercase", color:"var(--color-text)" }}>
            Integrations
          </div>
          <div style={{ color:"var(--color-text-muted)", fontSize:13, lineHeight:1.6 }}>
            Manage official data providers and profile import connections.
          </div>
        </div>

        {msg && <div style={{ border:`1px solid ${"var(--color-border)"}`, background:"var(--color-surface-offset)",
          color:"var(--color-text)", borderRadius:6, padding:"9px 12px", fontSize:12 }}>{msg}</div>}

        <Section theme={theme} title="LinkedIn Profile Import"
          subtitle="Import your name and email to pre-fill your resume."
          status={oauthSectionStatus("linkedin", status.linkedin)}>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
            <button onClick={() => startOAuth("linkedin")} disabled={status.oauth?.linkedin?.configured === false} style={buttonStyle}>
              {status.linkedin?.identityLinked ? "Import Again" : "Import from LinkedIn"}
            </button>
            {status.linkedin?.identityLinked && <button onClick={() => disconnectProvider("linkedin")} style={secondaryButton}>Disconnect</button>}
            <span style={{ color:status.oauth?.linkedin?.configured === false ? "#ef4444" : "var(--color-text-muted)", fontSize:12 }}>
              {status.linkedin?.identityLinked ? "Profile imported" : oauthHelp("linkedin")}
            </span>
          </div>
        </Section>

        <Section theme={theme} title="Job Feed"
          subtitle="Official API providers for job search results."
          status={{
            healthy: (status.jobSources || []).some(s => s.configured),
            status:  (status.jobSources || []).some(s => s.configured) ? "configured" : "missing",
          }}>
          <div style={{ fontSize:12, color:"var(--color-text-muted)" }}>
            {(status.jobSources || []).some(s => s.configured)
              ? `Job search active — ${(status.jobSources || []).filter(s => s.configured).length} provider(s) configured.`
              : "No job feed providers configured. Contact the app operator."}
          </div>
        </Section>

        <Section theme={theme} title="Resume and Profile" subtitle="Manual application tracking and resume tools depend on local profile readiness."
          status={{ healthy:status.resume?.healthy && status.profile?.healthy, status:status.resume?.healthy && status.profile?.healthy ? "ready" : "missing_setup" }}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(220px, 1fr))", gap:10 }}>
            <div style={{ background:"var(--color-surface-offset)", borderRadius:6, padding:10 }}>
              <strong>Base resume</strong><br/><span style={{ color:"var(--color-text-muted)" }}>{status.resume?.name || status.resume?.status}</span>
            </div>
            <div style={{ background:"var(--color-surface-offset)", borderRadius:6, padding:10 }}>
              <strong>Active profile</strong><br/><span style={{ color:"var(--color-text-muted)" }}>{status.profile?.activeProfileName || status.profile?.status}</span>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
