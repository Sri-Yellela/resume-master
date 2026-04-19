import JobsPanel from "../panels/JobsPanel.jsx";
import { useTheme } from "../styles/theme.jsx";

function toolModeForPlan(planTier) {
  const tier = String(planTier || "BASIC").toUpperCase();
  if (tier === "PRO") return "CUSTOM_SAMPLER";
  if (tier === "PLUS") return "TAILORED";
  return "SIMPLE";
}

function consoleUser(user) {
  return { ...user, applyMode: toolModeForPlan(user?.planTier) };
}

function ConsoleFrame({ title, eyebrow, description, children }) {
  const { theme } = useTheme();
  return (
    <section style={{ flex:1, minHeight:0, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <div style={{
        background:theme.surface, borderBottom:`1px solid ${theme.border}`,
        padding:"10px 20px", flexShrink:0,
      }}>
        <div style={{
          fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
          fontSize:18, letterSpacing:"0.06em", textTransform:"uppercase",
          color:theme.text,
        }}>
          {title}
        </div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:8, alignItems:"center", marginTop:3 }}>
          <span style={{ fontSize:11, fontWeight:800, color:theme.accentText, textTransform:"uppercase", letterSpacing:"0.06em" }}>
            {eyebrow}
          </span>
          <span style={{ fontSize:12, color:theme.textMuted }}>{description}</span>
        </div>
      </div>
      <div style={{ flex:1, minHeight:0, display:"flex", flexDirection:"column", overflow:"hidden" }}>
        {children}
      </div>
    </section>
  );
}

export function JobsConsole(props) {
  return (
    <ConsoleFrame
      title="Jobs"
      eyebrow="Shared console"
      description="ATS Search, ATS Sort, saved jobs, and upgrade-gated resume tools all run from one console."
    >
      <JobsPanel {...props} user={consoleUser(props.user)} consoleKind="jobs"/>
    </ConsoleFrame>
  );
}
