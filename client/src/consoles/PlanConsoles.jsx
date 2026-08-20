import { useMemo } from "react";
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
  // MEMOISED ON PURPOSE — the memo is load-bearing, not an optimisation.
  //
  // consoleUser() returns a fresh object literal, so calling it inline in the JSX below gave
  // JobsPanel a NEW `user` identity on every render of this component. JobsPanel's boot effect is
  // keyed `[user]` and fetches the HARDCODED, unfiltered
  // /api/jobs?page=1&pageSize=25&sort=dateDesc, then calls setJobs() with the result — so any
  // parent re-render silently reset the board to its first-load state and discarded whatever the
  // user had filtered, searched or paged to. Measured before this fix: clicking the IMPORT button
  // (a parent-only setImportOpen, nothing to do with the board) fired one unfiltered /api/jobs and
  // reset the list. AppDashboard's scroll handler, setUiMode(scrollY > 80 ? ...), is the same
  // trigger in ordinary use, which is why this presented as "the board resets when I touch it".
  //
  // Keyed on `props.user` IDENTITY rather than on picked fields: props.user is App's `authUser`
  // state, so it is already stable across re-renders and only changes when the user genuinely is
  // replaced — at which point every field, not just the ones this wrapper reads, must propagate.
  const user = useMemo(() => consoleUser(props.user), [props.user]);
  return (
    <section style={{ flex:1, minHeight:0, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <JobsPanel {...props} user={user} consoleKind="jobs"/>
    </section>
  );
}
