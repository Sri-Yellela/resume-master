import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

const PLAN_LABELS = {
  BASIC: "Basic",
  PLUS: "Plus",
  PRO: "Pro",
};

const PLAN_COPY = {
  BASIC: "Simple Apply with ATS Search and ATS Sort.",
  PLUS: "Tailored resumes and resume enhancement.",
  PRO: "Custom Sampler workflows.",
};

export function PlansPanel({ user, onUserChange }) {
  const { theme } = useTheme();
  const [plan, setPlan] = useState(null);
  const [status, setStatus] = useState("");

  const load = () => api("/api/plans").then(d => {
    setPlan(d);
    if (d?.planTier && d?.applyMode && onUserChange) {
      onUserChange(u => u ? ({ ...u, planTier:d.planTier, applyMode:d.applyMode, allowedModes:d.allowedModes || [d.applyMode] }) : u);
    }
  }).catch(e => setStatus(e.message));
  useEffect(() => { load(); }, []);

  const requestPlanChange = async (tier) => {
    if (!tier) return;
    setStatus("");
    try {
      await api("/api/plans/request-upgrade", {
        method:"POST",
        body:JSON.stringify({ requestedTier: tier }),
      });
      setStatus("Plan change request sent.");
      load();
    } catch(e) { setStatus(e.message); }
  };

  const current = plan?.planTier || user?.planTier || "BASIC";
  const changeOptions = plan?.changeOptions || (plan?.nextPlan ? [plan.nextPlan] : []);

  return (
    <div style={{ flex:1, overflowY:"auto", padding:24, background:theme.bg }}>
      <div style={{ maxWidth:760 }}>
        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                      fontSize:24, letterSpacing:"0.06em", textTransform:"uppercase",
                      marginBottom:8 }}>
          Plans
        </div>
        <div style={{ color:theme.textMuted, marginBottom:20 }}>
          Current plan: <strong style={{ color:theme.text }}>{PLAN_LABELS[current]}</strong>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(190px, 1fr))", gap:12 }}>
          {[current, ...changeOptions].filter(Boolean).map(tier => (
            <div key={tier} style={{
              border:`1px solid ${tier === current ? theme.accent : theme.border}`,
              background:theme.surface,
              borderRadius:8,
              padding:16,
            }}>
              <div style={{ fontWeight:800, fontSize:16 }}>{PLAN_LABELS[tier]}</div>
              <div style={{ color:theme.textMuted, fontSize:12, lineHeight:1.5, marginTop:6 }}>
                {PLAN_COPY[tier]}
              </div>
              {tier === current && (
                <div style={{ marginTop:12, fontSize:11, color:theme.accentText, fontWeight:700 }}>
                  Active
                </div>
              )}
              {tier !== current && !plan?.pendingRequest && (
                <button onClick={() => requestPlanChange(tier)}
                  style={{ marginTop:14, border:"none", borderRadius:6, padding:"9px 14px",
                           background:theme.accent, color:"#0f0f0f", cursor:"pointer",
                           fontWeight:800 }}>
                  Request {tier === "BASIC" ? "downgrade" : "change"}
                </button>
              )}
              {tier !== current && plan?.pendingRequest?.requested_tier === tier && (
                <div style={{ marginTop:12, fontSize:11, color:theme.warning, fontWeight:700 }}>
                  Request pending
                </div>
              )}
            </div>
          ))}
        </div>

        {status && <div style={{ marginTop:16, color:theme.textMuted }}>{status}</div>}
      </div>
    </div>
  );
}
