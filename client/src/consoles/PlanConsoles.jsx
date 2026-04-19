import JobsPanel from "../panels/JobsPanel.jsx";

function toolModeForPlan(planTier) {
  const tier = String(planTier || "BASIC").toUpperCase();
  if (tier === "PRO") return "CUSTOM_SAMPLER";
  if (tier === "PLUS") return "TAILORED";
  return "SIMPLE";
}

function consoleUser(user) {
  return { ...user, applyMode: toolModeForPlan(user?.planTier) };
}

export function JobsConsole(props) {
  return (
    <section style={{ flex:1, minHeight:0, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <JobsPanel {...props} user={consoleUser(props.user)} consoleKind="jobs"/>
    </section>
  );
}
