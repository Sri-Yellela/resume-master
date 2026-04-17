import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

const PLAN_LABELS = {
  BASIC: "Basic",
  PLUS: "Plus",
  PRO: "Pro",
};

const PLAN_COPY = {
  BASIC: "Simple Apply and local job matching.",
  PLUS: "Tailored resumes and resume enhancement.",
  PRO: "Custom Sampler workflows.",
};

export function PlansPanel({ user, onUserChange }) {
  const { theme } = useTheme();
  const [plan, setPlan] = useState(null);
  const [status, setStatus] = useState("");

  const load = () => api("/api/plans").then(setPlan).catch(e => setStatus(e.message));
  useEffect(() => { load(); }, []);

  const requestUpgrade = async () => {
    if (!plan?.nextPlan) return;
    setStatus("");
    try {
      await api("/api/plans/request-upgrade", {
        method:"POST",
        body:JSON.stringify({ requestedTier: plan.nextPlan }),
      });
      setStatus("Upgrade request sent.");
      load();
    } catch(e) { setStatus(e.message); }
  };

  const current = plan?.planTier || user?.planTier || "BASIC";
  const next = plan?.nextPlan;

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
          {[current, next].filter(Boolean).map(tier => (
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
              {tier === next && !plan?.pendingRequest && (
                <button onClick={requestUpgrade}
                  style={{ marginTop:14, border:"none", borderRadius:6, padding:"9px 14px",
                           background:theme.accent, color:"#0f0f0f", cursor:"pointer",
                           fontWeight:800 }}>
                  Request upgrade
                </button>
              )}
              {tier === next && plan?.pendingRequest && (
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
