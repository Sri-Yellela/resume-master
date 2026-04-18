import JobsPanel from "../panels/JobsPanel.jsx";
import { useTheme } from "../styles/theme.jsx";

function consoleUser(user, applyMode) {
  return { ...user, applyMode, allowedModes: [applyMode] };
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

export function SimpleApplyConsole(props) {
  return (
    <ConsoleFrame
      title="Simple Apply Console"
      eyebrow="Basic"
      description="ATS Search fetches listings, ATS Sort orders saved scores, and Set Role uses the local pool first."
    >
      <JobsPanel {...props} user={consoleUser(props.user, "SIMPLE")} consoleKind="simple-apply"/>
    </ConsoleFrame>
  );
}

export function TailoredConsole(props) {
  return (
    <ConsoleFrame
      title="Tailored Console"
      eyebrow="Plus"
      description="Generate tailored resumes from selected jobs. Console changes are handled from Plans."
    >
      <JobsPanel {...props} user={consoleUser(props.user, "TAILORED")} consoleKind="tailored"/>
    </ConsoleFrame>
  );
}

export function CustomSamplerConsole(props) {
  return (
    <ConsoleFrame
      title="Custom Sampler Console"
      eyebrow="Pro"
      description="Use the full custom sampler workflow for JD-driven resume generation."
    >
      <JobsPanel {...props} user={consoleUser(props.user, "CUSTOM_SAMPLER")} consoleKind="custom-sampler"/>
    </ConsoleFrame>
  );
}
