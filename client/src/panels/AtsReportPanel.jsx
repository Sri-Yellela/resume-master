import PanelShell from "../components/PanelShell.jsx";
import { ATSPanel } from "./ATSPanel.jsx";

// ── AtsReportPanel — the ATS report + generation history, as a PEER of the JD drawer ──────────
//
// ATSPanel itself is pure content (a score dial and some tag sections) and is not touched: it had
// no overlay, no header and no close affordance of its own, because it was only ever rendered as a
// react-resizable-panels column squeezed in beside the board. Wrapping it in PanelShell is
// therefore the whole change — it gains the inset overlay, the dimming scrim, the dark-glass
// surface, both sticky regions, its own scrolling body, the close button and the modal z-tier by
// being a peer rather than by reimplementing any of it.
//
// The tab row (ATS Report / History) is the action bar — sticky region 2 — which is where the
// inline version's tabs already sat relative to its content, so the arrangement the user knows is
// preserved while the chrome around it becomes the shared one.
export default function AtsReportPanel({
  slot = 0, rightOffset = 16, focused = true, fullScreen = false, onFocus, onWidthChange, onClose,
  theme, activeAts, rightTab, setRightTab, genCount,
  jobId, resumeText, activeProfileId,
  historyContent,
}) {
  const header = (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 700, fontSize: 14, color: "var(--color-text)", overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {activeAts?.company || "ATS Report"}
      </div>
      <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 2, overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {activeAts?.title || "Match analysis"}
      </div>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--color-primary)" }}>ATS</span>
        {activeAts?.score != null && (
          <span style={{ fontSize: 10, fontWeight: 700,
                         color: activeAts.score >= 80 ? "#16a34a"
                              : activeAts.score >= 60 ? "#b45309" : "#dc2626" }}>
            Score {activeAts.score}
          </span>
        )}
      </div>
    </div>
  );

  const actions = (
    <>
      {[["ats", "ATS Report"], ["history", `History${genCount > 0 ? ` (${genCount})` : ""}`]].map(([id, lbl]) => (
        <button key={id} onClick={() => setRightTab(id)}
          style={{
            padding: "5px 12px", borderRadius: 999, cursor: "pointer",
            fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 800,
            fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase",
            background: rightTab === id ? theme.accent : "transparent",
            color: rightTab === id ? "#0f0f0f" : theme.textMuted,
            border: `1px solid ${rightTab === id ? theme.accent : theme.border}`,
          }}>
          {lbl}
        </button>
      ))}
    </>
  );

  return (
    <PanelShell
      panelId="ats"
      slot={slot} rightOffset={rightOffset} focused={focused} fullScreen={fullScreen}
      onClose={onClose} onFocus={onFocus} onWidthChange={onWidthChange}
      header={header} actions={actions}
    >
      {/* ATSPanel used to be handed height:100% inside a fixed-height column and scrolled itself.
          PanelShell's body is the scroll container now, so this wrapper only supplies a minimum
          height — a nested scroller here would double the scrollbars. */}
      <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", minWidth: 0 }}>
        {rightTab === "ats" && (
          <ATSPanel
            report={activeAts?.report}
            score={activeAts?.score}
            jobId={jobId}
            resumeText={resumeText}
            activeProfileId={activeProfileId}
          />
        )}
        {rightTab === "history" && historyContent}
      </div>
    </PanelShell>
  );
}
