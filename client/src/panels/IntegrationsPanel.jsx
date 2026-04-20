import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

function StatusPill({ status, healthy, theme }) {
  const color = healthy ? "#16a34a" : status === "missing" || status === "not_connected" ? "#dc2626" : "#d97706";
  return (
    <span style={{ display:"inline-flex", alignItems:"center", border:`1px solid ${color}55`,
      background:`${color}14`, color, borderRadius:6, padding:"3px 7px", fontSize:11, fontWeight:800 }}>
      {healthy ? "Ready" : status.replace(/_/g, " ")}
    </span>
  );
}

function Section({ title, subtitle, status, children, theme }) {
  return (
    <section style={{ border:`1px solid ${theme.border}`, background:theme.surface,
      borderRadius:8, padding:18, display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:12 }}>
        <div>
          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
            fontSize:18, letterSpacing:"0.06em", textTransform:"uppercase", color:theme.text }}>
            {title}
          </div>
          <div style={{ fontSize:12, color:theme.textMuted, lineHeight:1.5, marginTop:2 }}>{subtitle}</div>
        </div>
        <StatusPill theme={theme} status={status.status} healthy={status.healthy}/>
      </div>
      {children}
    </section>
  );
}

export function IntegrationsPanel() {
  const { theme } = useTheme();
  const [status, setStatus] = useState(null);
  const [apifyToken, setApifyToken] = useState("");
  const [gmailEmail, setGmailEmail] = useState("");
  const [linkedinCookies, setLinkedinCookies] = useState("");
  const [msg, setMsg] = useState("");

  const load = () => api("/api/integrations/status").then(setStatus).catch(e => setMsg(e.message));
  useEffect(() => { load(); }, []);

  const saveApify = async () => {
    await api("/api/integrations/apify-token", { method:"PATCH", body:JSON.stringify({ token:apifyToken.trim() }) });
    setApifyToken(""); setMsg("Apify token saved."); load();
  };
  const clearApify = async () => {
    await api("/api/integrations/apify-token", { method:"DELETE" });
    setMsg("Apify token cleared."); load();
  };
  const connectProvider = async (provider, accountEmail) => {
    await api(`/api/integrations/${provider}`, {
      method:"POST",
      body:JSON.stringify({
        accountEmail: accountEmail.trim(),
        scopes: provider === "gmail" ? ["gmail.readonly", "verification_email_lookup"] : ["google_login_session"],
        metadata: { configuredFrom: "integrations_panel" },
      }),
    });
    setMsg(`${provider === "gmail" ? "Gmail" : provider === "linkedin" ? "LinkedIn" : "Google"} connection saved.`);
    if (provider === "gmail") setGmailEmail("");
    load();
  };
  const disconnectProvider = async (provider) => {
    await api(`/api/integrations/${provider}`, { method:"DELETE" });
    setMsg(`${provider === "gmail" ? "Gmail" : provider === "linkedin" ? "LinkedIn" : "Google"} disconnected.`);
    load();
  };
  const startOAuth = (provider) => {
    const readiness = status?.oauth?.[provider];
    if (readiness && !readiness.configured) {
      setMsg(`${provider === "linkedin" ? "LinkedIn" : "Google"} OAuth is not configured by the app operator: ${readiness.missing.join(", ")} missing.`);
      return;
    }
    window.location.href = `/api/auth/oauth/${provider}/start?mode=link&returnTo=${encodeURIComponent("/app/integrations")}`;
  };
  const saveLinkedIn = async () => {
    await api("/api/linkedin/cookies", { method:"POST", body:JSON.stringify({ cookies:linkedinCookies.trim() }) });
    setLinkedinCookies(""); setMsg("LinkedIn session saved."); load();
  };
  const clearLinkedIn = async () => {
    await api("/api/linkedin/cookies", { method:"DELETE" });
    setMsg("LinkedIn session cleared."); load();
  };

  const inputStyle = { height:36, border:`1px solid ${theme.border}`, borderRadius:6,
    background:theme.surfaceHigh, color:theme.text, padding:"0 10px", outline:"none", fontSize:13, flex:1 };
  const buttonStyle = { border:"none", borderRadius:6, background:theme.accent, color:"#0f0f0f",
    padding:"8px 12px", cursor:"pointer", fontWeight:800, fontSize:12 };
  const secondaryButton = { ...buttonStyle, background:theme.surfaceHigh, color:theme.text, border:`1px solid ${theme.border}` };
  const oauthSectionStatus = (provider, userStatus) => {
    const operator = status.oauth?.[provider];
    if (operator && !operator.configured) return { healthy:false, status:operator.status || "not_configured" };
    return userStatus;
  };
  const oauthHelp = (provider) => {
    const operator = status.oauth?.[provider];
    if (!operator) return null;
    if (!operator.configured) return `${provider === "linkedin" ? "LinkedIn" : "Google"} OAuth is not configured: ${operator.missing.join(", ")} missing.`;
    if (operator.warnings?.length) return `Configured with warnings: ${operator.warnings.join(", ")}.`;
    return "OAuth app configuration is ready.";
  };
  const oauthButtonStyle = (provider) => {
    const configured = status.oauth?.[provider]?.configured !== false;
    return { ...buttonStyle, opacity:configured ? 1 : 0.55, cursor:configured ? "pointer" : "not-allowed" };
  };

  if (!status) {
    return <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", color:theme.textMuted }}>Loading integrations...</div>;
  }

  return (
    <div style={{ flex:1, overflowY:"auto", background:theme.bg, padding:"28px 24px 44px" }}>
      <div style={{ maxWidth:980, margin:"0 auto", display:"flex", flexDirection:"column", gap:16 }}>
        <div>
          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:28,
            fontWeight:800, letterSpacing:"0.06em", textTransform:"uppercase", color:theme.text }}>
            Integrations
          </div>
          <div style={{ color:theme.textMuted, fontSize:13, lineHeight:1.6 }}>
            Connect search, login, email verification, and apply automation prerequisites in one place.
          </div>
        </div>

        {msg && <div style={{ border:`1px solid ${theme.border}`, background:theme.surfaceHigh,
          color:theme.text, borderRadius:6, padding:"9px 12px", fontSize:12 }}>{msg}</div>}

        <Section theme={theme} title="Automation Readiness"
          subtitle="Auto Apply and Manual Apply require a base resume, active job profile, and profile contact fields. Login connectors are used when a portal needs them."
          status={{ healthy:status.apply.ready, status:status.apply.ready ? "ready" : "missing_setup" }}>
          <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
            {(status.apply.missing.length ? status.apply.missing : ["core_ready"]).map(item => (
              <span key={item} style={{ padding:"5px 8px", borderRadius:6, background:theme.surfaceHigh,
                color:status.apply.ready ? "#16a34a" : "#dc2626", fontSize:12, fontWeight:700 }}>
                {item.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        </Section>

        <Section theme={theme} title="Apify" subtitle="Required for LinkedIn job search and manual refresh."
          status={status.apify}>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <input type="password" value={apifyToken} onChange={e => setApifyToken(e.target.value)}
              onKeyDown={e => e.key === "Enter" && saveApify()} placeholder="apify_api_..." style={inputStyle}/>
            <button onClick={saveApify} style={buttonStyle}>Save Token</button>
            {status.apify.connected && <button onClick={clearApify} style={secondaryButton}>Clear</button>}
          </div>
        </Section>

        <Section theme={theme} title="Gmail" subtitle="Used for verification email and OTP retrieval during account creation flows."
          status={status.gmail}>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <input value={gmailEmail} onChange={e => setGmailEmail(e.target.value)}
              placeholder={status.gmail.accountEmail || "gmail account email"} style={inputStyle}/>
            <button onClick={() => connectProvider("gmail", gmailEmail)} disabled={!gmailEmail.trim()} style={buttonStyle}>Connect Gmail</button>
            {status.gmail.connected && <button onClick={() => disconnectProvider("gmail")} style={secondaryButton}>Disconnect</button>}
          </div>
        </Section>

        <Section theme={theme} title="Google Login" subtitle="OAuth-linked Google account metadata for portals that offer Continue with Google."
          status={oauthSectionStatus("google", status.google)}>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <button onClick={() => startOAuth("google")} disabled={status.oauth?.google?.configured === false} style={oauthButtonStyle("google")}>
              {status.google.connected ? "Reconnect Google" : "Connect Google"}
            </button>
            {status.google.connected && <button onClick={() => disconnectProvider("google")} style={secondaryButton}>Disconnect</button>}
            <span style={{ color:theme.textMuted, fontSize:12, alignSelf:"center" }}>
              {status.google.accountEmail || (status.google.identityLinked ? "Google identity linked" : "Not connected")}
            </span>
            <span style={{ color:status.oauth?.google?.configured === false ? theme.danger : theme.textMuted, fontSize:12, alignSelf:"center" }}>
              {oauthHelp("google")}
            </span>
          </div>
        </Section>

        <Section theme={theme} title="LinkedIn" subtitle="OAuth-linked LinkedIn identity plus optional encrypted cookie/session capture for LinkedIn-related automation."
          status={oauthSectionStatus("linkedin", status.linkedin)}>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <button onClick={() => startOAuth("linkedin")} disabled={status.oauth?.linkedin?.configured === false} style={oauthButtonStyle("linkedin")}>
              {status.linkedin.identityLinked ? "Reconnect LinkedIn Login" : "Connect LinkedIn Login"}
            </button>
            <input value={linkedinCookies} onChange={e => setLinkedinCookies(e.target.value)}
              placeholder="Paste exported LinkedIn cookies/session JSON" style={inputStyle}/>
            <button onClick={saveLinkedIn} disabled={!linkedinCookies.trim()} style={buttonStyle}>Save Session</button>
            {status.linkedin.identityLinked && <button onClick={() => disconnectProvider("linkedin")} style={secondaryButton}>Unlink Login</button>}
            {status.linkedin.connected && <button onClick={clearLinkedIn} style={secondaryButton}>Clear</button>}
            <span style={{ color:theme.textMuted, fontSize:12, alignSelf:"center" }}>
              {status.linkedin.accountEmail || (status.linkedin.identityLinked ? "LinkedIn identity linked" : "Login not connected")}
            </span>
            <span style={{ color:status.oauth?.linkedin?.configured === false ? theme.danger : theme.textMuted, fontSize:12, alignSelf:"center" }}>
              {oauthHelp("linkedin")}
            </span>
          </div>
        </Section>

        <Section theme={theme} title="Resume and Profile" subtitle="Search defaults, ATS sorting, resume generation, and autofill depend on these local prerequisites."
          status={{ healthy:status.resume.healthy && status.profile.healthy, status:status.resume.healthy && status.profile.healthy ? "ready" : "missing_setup" }}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(220px, 1fr))", gap:10 }}>
            <div style={{ background:theme.surfaceHigh, borderRadius:6, padding:10 }}>
              <strong>Base resume</strong><br/><span style={{ color:theme.textMuted }}>{status.resume.name || status.resume.status}</span>
            </div>
            <div style={{ background:theme.surfaceHigh, borderRadius:6, padding:10 }}>
              <strong>Active profile</strong><br/><span style={{ color:theme.textMuted }}>{status.profile.activeProfileName || status.profile.status}</span>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
