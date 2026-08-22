// ── The four surfaces of the Auto Apply panel ────────────────────────────────────────────────
//
// Extracted from AutoApplyPanel.jsx so the restructure is readable: the panel used to be one strip
// of status badges plus a modal, organised around RUNS. A run is an implementation detail — nobody
// thinks "run 47" — so it is organised around the only thing a user can act on: the OBSTACLE.
//
// Every row here names an obstacle and an action. Never a status code. The vocabulary lives in
// lib/applyObstacles.js, which the board's own chip reads too, so the two surfaces cannot describe
// the same application differently.
import { useTheme } from "../styles/theme.jsx";
import { describeApplication, PREREQUISITE_LABELS } from "../lib/applyObstacles.js";

export function SectionHeading({ children, count, note, theme }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
      <h3 style={{ margin: 0, fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 800,
                   fontSize: 15, letterSpacing: "0.08em", textTransform: "uppercase",
                   color: theme.text }}>
        {children}
      </h3>
      {count != null && (
        <span style={{ fontSize: 12, fontWeight: 700, color: theme.textMuted }}>{count}</span>
      )}
      {note && <span style={{ fontSize: 11, color: theme.textDim }}>{note}</span>}
      <div style={{ flex: 1, height: 1, background: theme.border }} />
    </div>
  );
}

/**
 * ONE obstacle, ONE action, and the count of what the action unblocks.
 *
 * The count is the whole argument for this shape: "Sign in to Workday once → 4 applications ready"
 * is a ten-second job that releases four applications. Four separate rows saying "held: login
 * required" is the same information priced as four jobs.
 */
export function ObstacleCard({
  theme, tone = "#d97706", kicker, headline, detail, count, countLabel,
  actionLabel, onAction, secondaryLabel, onSecondary, hero = false,
}) {
  return (
    <div style={{
      border: `1px solid ${hero ? tone : theme.border}`,
      borderLeft: `3px solid ${tone}`,
      borderRadius: 8,
      padding: hero ? "14px 16px" : "11px 14px",
      background: hero ? `${tone}0f` : theme.surfaceHigh,
      display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
    }}>
      {count != null && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
                      minWidth: 46, flexShrink: 0 }}>
          <span style={{ fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 800,
                         fontSize: hero ? 30 : 24, lineHeight: 1, color: tone }}>
            {count}
          </span>
          {countLabel && (
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
                           textTransform: "uppercase", color: theme.textDim, textAlign: "center" }}>
              {countLabel}
            </span>
          )}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 220 }}>
        {kicker && (
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.08em",
                        textTransform: "uppercase", color: tone, marginBottom: 3 }}>
            {kicker}
          </div>
        )}
        <div style={{ fontSize: hero ? 14 : 13, fontWeight: 700, color: theme.text, lineHeight: 1.4 }}>
          {headline}
        </div>
        {detail && (
          <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 3, lineHeight: 1.5 }}>
            {detail}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        {secondaryLabel && (
          <button onClick={onSecondary}
            style={{ border: `1px solid ${theme.border}`, borderRadius: 6, padding: "7px 12px",
                     background: theme.surface, color: theme.text, fontWeight: 700, fontSize: 11.5,
                     cursor: "pointer", whiteSpace: "nowrap" }}>
            {secondaryLabel}
          </button>
        )}
        {actionLabel && (
          <button onClick={onAction}
            style={{ border: "none", borderRadius: 6, padding: "8px 14px", background: tone,
                     color: "#ffffff", fontWeight: 800, fontSize: 11.5, cursor: "pointer",
                     whiteSpace: "nowrap" }}>
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One application, described by its obstacle rather than its status.
 *
 * `variant` picks how much evidence to show: SUBMITTED needs the date, the resume that went out and
 * the screenshot, because that is what a user reaches for when an interview lands. STOPPED needs the
 * plain-language reason and a retry ONLY where retrying can work.
 */
export function ApplicationRow({ job, theme, variant, artifactUrl, onRetry, onOpenRun }) {
  const d = describeApplication(job);
  const when = job.finishedAt || job.startedAt || job.createdAt;
  // Protective vs broken is the distinction the old UI lost by calling both "failed".
  const tone = variant === "submitted" ? "#16a34a"
    : variant === "inFlight" ? "#2563eb"
    : d.protective ? "#6b7280" : "#dc2626";

  const chip = (bg, fg, text, title) => (
    <span title={title} style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                                 background: bg, color: fg, whiteSpace: "nowrap" }}>{text}</span>
  );
  const link = (href, text) => (
    <a href={href} target="_blank" rel="noreferrer"
      style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
               border: `1px solid ${theme.border}`, background: theme.surface, color: theme.text,
               textDecoration: "none", whiteSpace: "nowrap" }}>{text}</a>
  );

  return (
    <div style={{ border: `1px solid ${theme.border}`, borderLeft: `3px solid ${tone}`,
                  borderRadius: 6, padding: "9px 12px", background: theme.surfaceHigh,
                  display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: theme.text }}>
          {job.company || "Unknown company"}
        </span>
        <span style={{ fontSize: 11.5, color: theme.textMuted, flex: 1, minWidth: 120 }}>
          {job.title || job.jobId || "—"}
        </span>
        {when && (
          <span style={{ fontSize: 10, color: theme.textDim, whiteSpace: "nowrap" }}>
            {new Date(when).toLocaleDateString()} {new Date(when).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>

      {/* THE OBSTACLE, as a sentence. This replaces the status pill that used to say "Failed". */}
      {variant !== "submitted" && (
        <div style={{ fontSize: 11.5, color: theme.text, lineHeight: 1.5 }}>
          {d.obstacle}
          {/* A detail that merely repeats the obstacle reads as a stutter ("You rejected this one —
              You rejected this one"), which happens whenever reason_detail restates reason_code. */}
          {d.detail && d.detail !== d.obstacle && (
            <span style={{ color: theme.textMuted }}> — {d.detail}</span>
          )}
        </div>
      )}
      {variant !== "submitted" && d.action && (
        <div style={{ fontSize: 11, color: theme.textMuted }}>→ {d.action}</div>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {/* EVIDENCE. What a user needs when an interview lands: when it went, which resume, and a
            picture of the form as submitted. */}
        {variant === "submitted" && (
          job.submitVerified
            ? chip("#16a34a22", "#16a34a", "confirmed by the site", job.submitEvidence || "")
            : chip("#d9770622", "#d97706", "sent, not confirmed",
                   "We clicked submit and the page did not show a confirmation. Check the screenshot.")
        )}
        {job.resumeAvailable
          ? link(artifactUrl(job.id, "resume"), variant === "submitted" ? "The resume that went out ↗" : "Resume PDF ↗")
          : variant === "submitted"
            ? chip(`${theme.border}55`, theme.textDim, "no resume recorded")
            : null}
        {job.screenshotAvailable && link(artifactUrl(job.id, "screenshot"),
          variant === "submitted" ? "Screenshot of the form ↗" : "Filled form ↗")}
        {job.atsScore != null && chip(
          job.atsScore >= 80 ? "#dcfce7" : job.atsScore >= 60 ? "#fef9c3" : "#fee2e2",
          job.atsScore >= 80 ? "#166534" : job.atsScore >= 60 ? "#854d0e" : "#991b1b",
          `ATS ${job.atsScore}`)}
        {job.applyUrl && link(job.applyUrl, "The posting ↗")}

        <span style={{ flex: 1 }} />

        {/* RETRY ONLY WHERE RETRY IS MEANINGFUL. A missing browser binary and a login wall both
            "failed"; offering Retry on the first is a lie, so it is not offered. */}
        {variant === "stopped" && d.retryable && onRetry && (
          <button onClick={() => onRetry(job)}
            style={{ border: `1px solid ${theme.border}`, borderRadius: 6, padding: "4px 10px",
                     background: theme.surface, color: theme.text, fontWeight: 700, fontSize: 11,
                     cursor: "pointer" }}>
            Retry
          </button>
        )}
        {variant === "stopped" && !d.retryable && (
          <span style={{ fontSize: 10, color: theme.textDim }}>retrying will not change this</span>
        )}
        {onOpenRun && job.runId && (
          <button onClick={() => onOpenRun(job.runId)}
            style={{ border: "none", background: "transparent", color: theme.textDim,
                     fontSize: 10, cursor: "pointer", textDecoration: "underline" }}>
            details
          </button>
        )}
      </div>
    </div>
  );
}

/** The prerequisites, as obstacles, surfaced BEFORE queueing rather than as a 409 after. */
export function PrerequisiteCards({ missing, queuedCount, theme, onGo }) {
  if (!missing?.length) return null;
  return missing.map((key) => {
    const p = PREREQUISITE_LABELS[key] || { obstacle: key.replace(/_/g, " "), action: "Fix it", to: "profile" };
    return (
      <ObstacleCard
        key={key}
        theme={theme}
        tone="#dc2626"
        kicker="blocks every application"
        headline={p.obstacle}
        // ONE blocking item with a fix, not N separate failures. This is computed by the server's
        // prerequisite gate, which used to only speak when a run was already refused.
        detail={queuedCount > 0
          ? `${p.action} — unblocks the ${queuedCount} job${queuedCount === 1 ? "" : "s"} you have queued.`
          : `${p.action}. Nothing can be applied to until this is set.`}
        count={queuedCount || null}
        countLabel={queuedCount ? "blocked" : null}
        actionLabel="Fix this"
        onAction={() => onGo(p.to)}
      />
    );
  });
}
