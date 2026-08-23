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
import { describeApplication, attemptStatusChip, PREREQUISITE_LABELS } from "../lib/applyObstacles.js";
import { TileCard, TilePill } from "../components/ui/TileCard.jsx";

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
 * The COMPANY tier of AB4's hierarchy: outcome -> company -> application.
 *
 * Quieter than SectionHeading on purpose — it is a tier below it, and two headings competing for the
 * same weight is how a hierarchy stops reading as one. The count is the point for an employer with
 * several roles, which is the case this tier exists to make visible.
 */
export function CompanyHeading({ company, count, theme }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
      <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.04em",
                     textTransform: "uppercase", color: theme.textMuted }}>
        {/* A posting removed by the cleanup leaves an application with no employer. Said plainly,
            rather than rendered as a blank heading. */}
        {company || "Posting no longer on the board"}
      </span>
      {count > 1 && (
        <span style={{ fontSize: 9, fontWeight: 800, padding: "1px 6px", borderRadius: 999,
                       background: `${theme.border}66`, color: theme.textDim, whiteSpace: "nowrap" }}>
          {count} roles
        </span>
      )}
      <div style={{ flex: 1, height: 1, background: theme.border, opacity: 0.5 }} />
    </div>
  );
}

/**
 * ONE APPLICATION, with every obstacle blocking it listed inside (TASK AB2).
 *
 * The counterpart to ObstacleCard, and the other half of the grouping rule in applyObstacles.js:
 * ObstacleCard is for one action that unblocks MANY applications, this is for many obstacles
 * blocking ONE. The panel previously had only the first, and used it for both — so an application
 * with three problems became three cards, each claiming to be "1 APPLICATION".
 *
 * Company and role are the headline, never "One application". A card that names neither leaves the
 * user unable to tell which job it is about, which is the one thing they need to know first.
 *
 * ── AC2: THE MODAL RENDERS THIS SAME COMPONENT ────────────────────────────────────────────────
 *
 * The modal used to be a flat list of problem-cards built from run-job rows by its own inline JSX —
 * two problems on one job rendered as two entries, and a dead posting for a different job sat
 * alongside them with a Review pill and nothing to click. AC2 requirement 1 says the modal must
 * MATCH the card summary, which already gets this right. So it is not re-described there; the modal
 * renders this component under a company tier, and the two surfaces cannot drift apart because
 * there is only one of them.
 *
 * Three optional props carry what the modal needs and the panel does not:
 *
 *   plan          resolutionPlan(app, …) — the problem list with CO-RESOLVABLE ones lifted out and
 *                 counted. When absent the flat reason list renders exactly as before, so the
 *                 panel's own cards are unchanged.
 *   onGroupAction called with a plan item when its amortised action is pressed.
 *   children      rendered at the foot of the card. The modal puts the per-ATTEMPT rows there —
 *                 the run-job detail this component collapses — so grouping loses nothing.
 */
export function ApplicationObstacleCard({
  app, theme, artifactUrl, onResolve, resolveLabel, resolveTitle, onDetails, onRerun, packet,
  onGenerateResume, plan = null, onGroupAction, detailsLabel, children,
}) {
  const many = app.reasons.length > 1;
  const tone = app.postingGone ? "#6b7280" : app.protective ? "#d97706" : "#dc2626";
  const stale = packet?.stale;

  return (
    // The data-* hooks are for scripts/abPanelUi.mjs, which counts cards in a real browser. AB2 is a
    // defect of how many cards one application produces, so the check has to be able to say WHICH
    // application a card belongs to — and matching on an inline-style substring to find the card
    // boundary is the kind of assertion that silently stops covering anything.
    <div data-rm-card="application"
         data-rm-job={app.jobId || ""}
         data-rm-company={app.company || ""}
         data-rm-obstacles={app.reasons.length}
         style={{ border: `1px solid ${theme.border}`, borderLeft: `3px solid ${tone}`,
                  borderRadius: 8, padding: "12px 14px", background: theme.surfaceHigh,
                  display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.08em",
                        textTransform: "uppercase", color: tone, marginBottom: 3 }}>
            {app.postingGone ? "the posting is gone"
              : stale ? "prepared too long ago"
              : app.protective ? "held on purpose" : "did not complete"}
          </div>
          {/* THE APPLICATION, named. */}
          <div style={{ fontSize: 14, fontWeight: 800, color: theme.text, lineHeight: 1.35 }}>
            {app.company || "Unknown company"}
            {app.title && <span style={{ color: theme.textMuted, fontWeight: 600 }}> — {app.title}</span>}
            {!app.title && app.jobId && (
              <span style={{ fontSize: 10, color: theme.textDim, fontWeight: 600 }}> · {app.jobId}</span>
            )}
          </div>
          {/* "1 application, 3 things to resolve" — the honest count. Three cards each saying
              "1 APPLICATION" made three jobs' worth of work out of one. */}
          <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>
            One application · {app.reasons.length} thing{many ? "s" : ""} to resolve
            {app.attempts > 1 && ` · ${app.attempts} attempts`}
            {app.when ? ` · ${new Date(app.when).toLocaleDateString()}` : ""}
          </div>
        </div>
        {/* The count is of OBSTACLES here, not applications: this card IS one application, and a
            big "1" beside it was the number that made three cards look like three jobs. */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
                      minWidth: 46, flexShrink: 0 }}>
          <span style={{ fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 800,
                         fontSize: 28, lineHeight: 1, color: tone }}>{app.reasons.length}</span>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
                         textTransform: "uppercase", color: theme.textDim, textAlign: "center" }}>
            to resolve
          </span>
        </div>
      </div>

      {/* EVERY obstacle, inside the one card. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5,
                    borderTop: `1px solid ${theme.border}`, paddingTop: 7 }}>
        {plan
          // ── AC2 requirement 2: CO-RESOLVABLE PROBLEMS, GROUPED ──────────────────────────────
          // An amortised item is not a bullet with a bigger font. It is a different OFFER — one
          // action, a count of what it releases — so it is rendered as the offer, and the count is
          // the part that carries the argument. resolutionPlan decides which items qualify; see the
          // table there for what can and cannot share one crossing (a CAPTCHA cannot, and is
          // excluded by name even though the server groups it by origin like a sign-in does).
          ? plan.map((item) => item.kind === "group" ? (
            <div key={item.key} data-rm-plan="group" data-rm-unblocks={item.unblocks}
              style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                       border: `1px solid #2563eb55`, borderLeft: "3px solid #2563eb",
                       borderRadius: 6, padding: "8px 10px", background: `${theme.surface}` }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
                            minWidth: 34, flexShrink: 0 }}>
                <span style={{ fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 800,
                               fontSize: 20, lineHeight: 1, color: "#2563eb" }}>{item.unblocks}</span>
                <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.06em",
                               textTransform: "uppercase", color: theme.textDim }}>unblocked</span>
              </div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.08em",
                              textTransform: "uppercase", color: "#2563eb", marginBottom: 2 }}>
                  one action, {item.unblocks} applications
                </div>
                <div style={{ fontSize: 11.5, color: theme.text, lineHeight: 1.45 }}>
                  {item.headline}
                </div>
                {item.detail && (
                  <div style={{ fontSize: 10.5, color: theme.textMuted, lineHeight: 1.45 }}>
                    {item.detail}
                  </div>
                )}
              </div>
              {item.action && onGroupAction && (
                <button onClick={() => onGroupAction(item)}
                  style={{ border: "none", borderRadius: 6, padding: "6px 11px", background: "#2563eb",
                           color: "#fff", fontWeight: 800, fontSize: 11, cursor: "pointer",
                           whiteSpace: "nowrap", flexShrink: 0 }}>
                  {item.action}
                </button>
              )}
            </div>
          ) : (
            // Its own problem, and only its own. No count — a "1" beside every line is the number
            // that made three cards look like three jobs, and it would do the same here.
            <div key={item.key} data-rm-plan="single"
                 style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", marginTop: 6, flexShrink: 0,
                             background: item.protective ? "#d97706" : "#dc2626" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11.5, color: theme.text, lineHeight: 1.45 }}>
                  {item.headline}
                  {item.detail && <span style={{ color: theme.textMuted }}> — {item.detail}</span>}
                </div>
                {item.action && (
                  <div style={{ fontSize: 10.5, color: theme.textMuted }}>→ {item.action}</div>
                )}
              </div>
            </div>
          ))
          : app.reasons.map((r, i) => (
            <div key={`${r.code}-${i}`} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", marginTop: 6, flexShrink: 0,
                             background: r.protective ? "#d97706" : "#dc2626" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11.5, color: theme.text, lineHeight: 1.45 }}>
                  {r.obstacle}
                  {r.detail && r.detail !== r.obstacle && (
                    <span style={{ color: theme.textMuted }}> — {r.detail}</span>
                  )}
                </div>
                {r.action && (
                  <div style={{ fontSize: 10.5, color: theme.textMuted }}>→ {r.action}</div>
                )}
              </div>
            </div>
          ))}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {app.primary?.row?.resumeAvailable ? (
          <a href={artifactUrl(app.primary.row.id, "resume")} target="_blank" rel="noreferrer"
            style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                     border: `1px solid ${theme.border}`, background: theme.surface,
                     color: theme.text, textDecoration: "none", whiteSpace: "nowrap" }}>
            Resume PDF ↗
          </a>
        ) : onGenerateResume && !app.postingGone
             && app.reasons.some(r => r.resumeBlocked) ? (
          // Requirement 5. No resume means this application cannot be submitted, which is a problem
          // with an obvious fix — so it is a button, not the dead chip it used to be. Offered only
          // when a missing resume is one of the reasons this application is held, and withheld when
          // the posting is gone: there would be nothing to tailor a resume to.
          <button onClick={() => onGenerateResume(app)}
            title="Queues this job so the next run generates a tailored resume for it before it applies."
            style={{ fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 999,
                     border: "none", background: "#2563eb", color: "#fff", cursor: "pointer",
                     whiteSpace: "nowrap" }}>
            Generate a resume
          </button>
        ) : null}
        {app.primary?.row?.screenshotAvailable && (
          <a href={artifactUrl(app.primary.row.id, "screenshot")} target="_blank" rel="noreferrer"
            title="A picture of the form as we filled it. Evidence — it cannot be submitted from here."
            style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                     border: `1px solid ${theme.border}`, background: theme.surface,
                     color: theme.textMuted, textDecoration: "none", whiteSpace: "nowrap" }}>
            What we filled ↗
          </a>
        )}
        {app.atsScore != null && (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                         background: app.atsScore >= 80 ? "#dcfce7" : app.atsScore >= 60 ? "#fef9c3" : "#fee2e2",
                         color: app.atsScore >= 80 ? "#166534" : app.atsScore >= 60 ? "#854d0e" : "#991b1b" }}>
            ATS {app.atsScore}
          </span>
        )}
        {app.applyUrl && (
          <a href={app.applyUrl} target="_blank" rel="noreferrer"
            style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                     border: `1px solid ${theme.border}`, background: theme.surface,
                     color: theme.text, textDecoration: "none", whiteSpace: "nowrap" }}>
            The posting ↗
          </a>
        )}

        <span style={{ flex: 1 }} />

        {/* A posting that no longer exists gets no action, and says why. There is no form to open
            and no run that would find one. */}
        {app.postingGone ? (
          <span style={{ fontSize: 10, color: theme.textDim }}>
            posting gone — cannot be resumed
          </span>
        ) : stale && onRerun ? (
          <button onClick={() => onRerun(app)}
            title="These answers were prepared too long ago to fill safely. A fresh run prepares new ones."
            style={{ border: `1px solid ${theme.border}`, borderRadius: 6, padding: "6px 12px",
                     background: theme.surface, color: theme.text, fontWeight: 700, fontSize: 11.5,
                     cursor: "pointer", whiteSpace: "nowrap" }}>
            Run it again
          </button>
        ) : onResolve ? (
          <button onClick={() => onResolve(app)} title={resolveTitle}
            style={{ border: "none", borderRadius: 6, padding: "7px 13px", background: tone,
                     color: "#ffffff", fontWeight: 800, fontSize: 11.5, cursor: "pointer",
                     whiteSpace: "nowrap" }}>
            {resolveLabel || "Open"}
          </button>
        ) : null}
        {onDetails && (
          <button onClick={() => onDetails(app)}
            style={{ border: `1px solid ${theme.border}`, borderRadius: 6, padding: "6px 11px",
                     background: theme.surface, color: theme.text, fontWeight: 700, fontSize: 11.5,
                     cursor: "pointer", whiteSpace: "nowrap" }}>
            {/* In the panel this opens the scoped popup and reads "Details". In the modal there is
                nothing further to open, so it toggles the per-ATTEMPT rows and says so — the label
                is the caller's because the two mean different things. */}
            {detailsLabel || "Details"}
          </button>
        )}
      </div>
      {/* The per-attempt rows, when the caller supplies them. Collapsing run-jobs into one
          application is only honest if the attempts remain reachable. */}
      {children}
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
export function ApplicationRow({ job, theme, variant, artifactUrl, onRetry, onOpenRun, onGenerateResume }) {
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
    // Same reason as the card's hooks: scripts/abPanelUi.mjs has to be able to say which ROW a
    // control belongs to, and finding a row boundary by inline-style substring does not work — React
    // does not serialise the style attribute in a form that survives that kind of matching.
    <div data-rm-card="row"
         data-rm-job={job.jobId || ""}
         data-rm-variant={variant || ""}
         style={{ border: `1px solid ${theme.border}`, borderLeft: `3px solid ${tone}`,
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
            // On a SUBMITTED application there is nothing to fix — it already went out, and a
            // Generate button here would offer to change something that has been sent.
            ? chip(`${theme.border}55`, theme.textDim, "no resume recorded")
            // AB4 requirement 5: a missing resume is a problem with a one-click fix, so it gets the
            // button rather than the dead chip it used to be — but ONLY where the resume is what is
            // actually wrong. `d.resumeBlocked` is that test. Keyed on resumeAvailable alone, the
            // button appeared beside "the apply browser is not installed on the server", which the
            // row correctly says needs an operator and which no resume will fix.
            : onGenerateResume && d.resumeBlocked
              ? (
                <button onClick={() => onGenerateResume(job)}
                  title="Queues this job so the next run generates a tailored resume for it before it applies."
                  style={{ fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 999,
                           border: "none", background: "#2563eb", color: "#fff", cursor: "pointer",
                           whiteSpace: "nowrap" }}>
                  Generate a resume
                </button>
              )
              : null}
        {/* EVIDENCE (AB1 requirement 4). For a SUBMITTED application this is proof of what went out.
            For a held one it is a picture of a form in a browser that has since closed — so it is
            named as evidence rather than as a link that looks like it reopens the application. It
            never was that, and presenting it as that is what made a hold look finishable when the
            only way onward was to redo the whole thing by hand. */}
        {job.screenshotAvailable && link(artifactUrl(job.id, "screenshot"),
          variant === "submitted" ? "Screenshot of the form ↗" : "What we filled ↗")}
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

/**
 * ONE ATTEMPT at one application — a single apply_run_jobs row (TASK AC2).
 *
 * This is the modal's old flat list item, MOVED here whole and otherwise unchanged. Every control
 * it carried is still on it: the status pill, the obstacle sentence from the shared vocabulary, the
 * ATS chip, the timestamps and attempt counter, the resume artifact, the "What we filled"
 * screenshot, the submission-verified chip, the Open & fill / Run it again route, the posting-gone
 * state, and the apply URL.
 *
 * WHAT CHANGED IS WHERE IT SITS, NOT WHAT IT IS. The modal used to render these rows at the top
 * level, so a job held, re-run and held again was three entries and a dead posting for a different
 * job sat between them. They are now nested inside the application they are attempts AT, behind
 * that application's own disclosure. The server returns one row per RUN-JOB and always has; that
 * is the right unit for "what happened on attempt 2" and the wrong unit for "what is in my way".
 *
 * Collapsing without this would lose the audit trail, which is the one thing a user needs when an
 * interview lands — so the attempts stay, one click away, rather than being summarised out.
 */
export function AttemptRow({ job, theme, artifactUrl, packetFor, onHandoff, onRerun }) {
  // The status pill's words and colour come from the shared vocabulary, not from a chain of
  // ternaries here. They used to be written inline in the modal — a second copy of a mapping the
  // rest of the app already had — and that is precisely the drift applyObstacles.js exists to stop:
  // this surface said "Failed" while the panel behind it said "This one did not complete".
  const { label: statusLabel, color: statusColor } = attemptStatusChip(job.status, theme.accent);

  return (
    <div data-rm-card="attempt" data-rm-job={job.jobId || ""} style={{
      border: `1px solid ${theme.border}`, borderRadius: 6,
      padding: "8px 11px", display: "flex", flexDirection: "column", gap: 5,
      background: theme.surface,
    }}>
      {/* which attempt, and how it ended */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 10.5, color: theme.textMuted }}>
          {job.startedAt && `Started ${new Date(job.startedAt).toLocaleString()}`}
          {job.startedAt && job.finishedAt && " · "}
          {job.finishedAt && `Finished ${new Date(job.finishedAt).toLocaleTimeString()}`}
          {(job.startedAt || job.finishedAt) && " · "}Attempts: {job.attemptCount || 1}
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: "2px 8px",
          borderRadius: 999, background: `${statusColor}22`,
          color: statusColor, whiteSpace: "nowrap", flexShrink: 0,
        }}>
          {statusLabel}
        </span>
      </div>

      {/* The obstacle SENTENCE, from the shared vocabulary, plus the score. This line used to be
          `job.reasonCode.replace(/_/g, " ")` — a raw code with its underscores swapped for spaces,
          so the modal said "ats below threshold" while the panel behind it said "Resume scored
          below your ATS threshold" for the same row. applyObstacles.js exists precisely so the two
          cannot disagree. */}
      {(job.reasonCode || job.atsScore != null) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {job.reasonCode && (() => {
            const d = describeApplication(job);
            return (
              <span style={{ fontSize: 11, color: statusColor, fontWeight: 600 }}>
                {d.obstacle}
                {d.detail && d.detail !== d.obstacle ? ` — ${d.detail}` : ""}
              </span>
            );
          })()}
          {job.atsScore != null && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 999,
              background: job.atsScore >= 80 ? "#dcfce7" : job.atsScore >= 60 ? "#fef9c3" : "#fee2e2",
              color: job.atsScore >= 80 ? "#166534" : job.atsScore >= 60 ? "#854d0e" : "#991b1b",
            }}>
              ATS {job.atsScore}
            </span>
          )}
        </div>
      )}

      {/* What was actually sent on THIS attempt. The audit trail has recorded the resume artifact
          and the end-of-attempt screenshot all along; nothing linked them, so there was no way to
          tell whether a resume had even been generated. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {job.resumeAvailable ? (
          <a href={artifactUrl(job.id, "resume")} target="_blank" rel="noreferrer"
            onClick={e => e.stopPropagation()}
            style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                     border: `1px solid ${theme.border}`, background: theme.surfaceHigh,
                     color: theme.text, textDecoration: "none", whiteSpace: "nowrap" }}>
            Resume PDF ↗
          </a>
        ) : (
          <span title="No resume artifact was recorded for this attempt."
            style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                     background: `${theme.border}55`, color: theme.textDim, whiteSpace: "nowrap" }}>
            no resume on this attempt
          </span>
        )}
        {/* EVIDENCE, NOT THE ROUTE (AB1 requirement 4). This is a screenshot of a form in a browser
            that closed when the run ended — it shows what we filled and it cannot be submitted. It
            used to be the only thing offered for a held application, which is why a hold was a dead
            end. Labelled for what it is; the resume action below is what continues the application. */}
        {job.screenshotAvailable && (
          <a href={artifactUrl(job.id, "screenshot")} target="_blank" rel="noreferrer"
            onClick={e => e.stopPropagation()}
            title="A picture of the form as we filled it. Evidence — it cannot be submitted from here."
            style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                     border: `1px solid ${theme.border}`, background: theme.surfaceHigh,
                     color: theme.textMuted, textDecoration: "none", whiteSpace: "nowrap" }}>
            What we filled ↗
          </a>
        )}
        {/* THE ROUTE. Present on every held attempt that has a prepared packet, so the list is not
            just readable but finishable. */}
        {(() => {
          if (!["held_review", "held_gate"].includes(job.status)) return null;
          const packet = packetFor?.(job);
          if (!packet) return null;
          // A posting that no longer exists is a STATE, not a disabled button (requirement 6).
          // There is no form to open and no run that would find one, so nothing is offered —
          // saying so is the whole affordance.
          if (packet.postingGone) {
            return (
              <span title="This posting was removed from the board. There is no application left to finish; the record of the attempt stays here."
                style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                         background: `${theme.border}55`, color: theme.textDim, whiteSpace: "nowrap" }}>
                posting gone — cannot be resumed
              </span>
            );
          }
          const stale = packet.stale;
          return (
            <button
              onClick={e => { e.stopPropagation(); if (stale) onRerun?.(job); else onHandoff?.(packet, job); }}
              title={stale
                ? "These answers were prepared too long ago to fill safely. A fresh run prepares new ones."
                : "Opens the real application in your own browser and fills it with the answers we prepared. You review and submit."}
              style={{ fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 999,
                       border: stale ? `1px solid ${theme.border}` : "none",
                       background: stale ? theme.surfaceHigh : "#2563eb",
                       color: stale ? theme.text : "#fff", cursor: "pointer",
                       whiteSpace: "nowrap" }}>
              {stale ? "Run it again" : "Open & fill ↗"}
            </button>
          );
        })()}
        {job.status === "submitted" && (
          <span title={job.submitEvidence || ""}
            style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                     background: job.submitVerified ? "#16a34a22" : "#d9770622",
                     color: job.submitVerified ? "#16a34a" : "#d97706", whiteSpace: "nowrap" }}>
            {job.submitVerified ? "submission verified" : "unverified submit"}
          </span>
        )}
      </div>

      {/* apply URL */}
      {job.applyUrl && (
        <a href={job.applyUrl} target="_blank" rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          style={{ fontSize: 10, color: theme.accent, textDecoration: "none", wordBreak: "break-all" }}>
          {job.applyUrl.length > 90 ? job.applyUrl.slice(0, 90) + "…" : job.applyUrl}
        </a>
      )}
    </div>
  );
}

// ── AC3: THE COMPANY CARD, IN THE JOB PROFILES IDIOM ─────────────────────────────────────────
//
// The company tier used to be a HEADING followed by full-width application cards — one per row,
// down the whole page, so four employers took four screens and nothing could be compared. The
// ManageJobProfiles panel had already solved this shape: a bordered tile with a title and a status
// pill, a compact metadata line, an inset sub-block for the state that matters, and a footer action
// row, several to a row in an auto-fill grid.
//
// So that primitive was EXTRACTED from JobProfilesPanel into components/ui/TileCard.jsx and both
// panels render it. Not cloned — JobProfilesPanel was refactored onto it in the same change, and
// scripts/abPanelUi.mjs drives that panel to prove its cards are unchanged. A "reuse" that leaves
// two implementations behind is a clone with extra steps, and it drifts within a month.
//
// WHAT MOVED, AND WHERE IT WENT. The tile is a TRIAGE surface: which employer, how many
// applications, how much is in the way, and whether it was held on purpose or broke — requirement
// 4's "triage without opening anything". The full problem SENTENCES moved into the review modal,
// which AC2 restructured into company -> application -> problems for exactly this. Every control
// survives: the artifact chips and the resolve action stay on the compact row, and Open/Details
// lead to the modal that now carries the rest.

/**
 * ONE APPLICATION, compact, inside a company tile (AC3 requirement 2: "role + count to resolve").
 *
 * Keeps ApplicationObstacleCard's data hooks so the real-browser checks can still ask which
 * application a row is for and how many problems it has — the AB2 defect was about exactly that
 * count, and an assertion that silently stopped covering it would be worse than one that fails.
 */
export function CompanyApplicationRow({
  app, theme, artifactUrl, packet, onResolve, resolveLabel, resolveTitle, onDetails, onRerun,
  onGenerateResume,
}) {
  const tone = app.postingGone ? "#6b7280" : app.protective ? "#d97706" : "#dc2626";
  const stale = packet?.stale;
  const chip = {
    fontSize: 9.5, fontWeight: 700, padding: "2px 7px", borderRadius: 999,
    border: `1px solid ${theme.border}`, background: theme.surface, color: theme.text,
    textDecoration: "none", whiteSpace: "nowrap",
  };

  return (
    <div data-rm-card="application"
         data-rm-job={app.jobId || ""}
         data-rm-company={app.company || ""}
         data-rm-obstacles={app.reasons.length}
         style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ width: 5, height: 5, borderRadius: "50%", flexShrink: 0, background: tone }} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: theme.text, flex: 1, minWidth: 0,
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {app.title || app.jobId || "Unknown role"}
        </span>
        {/* The count, at row level. AC3 requirement 4 — a user triages on this without opening
            anything, and the problems themselves are one click away in the modal. */}
        <span style={{ fontSize: 10, fontWeight: 800, color: tone, whiteSpace: "nowrap", flexShrink: 0 }}>
          {app.reasons.length} to resolve
        </span>
      </div>
      <div style={{ fontSize: 10, color: theme.textDim, paddingLeft: 13 }}>
        {/* HELD ON PURPOSE vs BROKEN, at card level. Requirement 4 again: the distinction this whole
            line of work exists to preserve must survive the compaction, not only the modal. */}
        <span style={{ color: tone, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {app.postingGone ? "the posting is gone"
            : stale ? "prepared too long ago"
            : app.protective ? "held on purpose" : "did not complete"}
        </span>
        {app.attempts > 1 && ` · ${app.attempts} attempts`}
        {app.when ? ` · ${new Date(app.when).toLocaleDateString()}` : ""}
      </div>

      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", paddingLeft: 13 }}>
        {app.primary?.row?.resumeAvailable ? (
          <a href={artifactUrl(app.primary.row.id, "resume")} target="_blank" rel="noreferrer" style={chip}>
            Resume PDF ↗
          </a>
        ) : onGenerateResume && !app.postingGone && app.reasons.some(r => r.resumeBlocked) ? (
          // AB4 requirement 5, unchanged: a missing resume is a problem with a one-click fix, so it
          // is a button — and only where a missing resume is actually what is wrong.
          <button onClick={() => onGenerateResume(app)}
            title="Queues this job so the next run generates a tailored resume for it before it applies."
            style={{ ...chip, border: "none", background: "#2563eb", color: "#fff", fontWeight: 800,
                     cursor: "pointer" }}>
            Generate a resume
          </button>
        ) : null}
        {app.primary?.row?.screenshotAvailable && (
          <a href={artifactUrl(app.primary.row.id, "screenshot")} target="_blank" rel="noreferrer"
            title="A picture of the form as we filled it. Evidence — it cannot be submitted from here."
            style={{ ...chip, color: theme.textMuted }}>
            What we filled ↗
          </a>
        )}
        {app.atsScore != null && (
          <span style={{ ...chip, border: "none",
                         background: app.atsScore >= 80 ? "#dcfce7" : app.atsScore >= 60 ? "#fef9c3" : "#fee2e2",
                         color: app.atsScore >= 80 ? "#166534" : app.atsScore >= 60 ? "#854d0e" : "#991b1b" }}>
            ATS {app.atsScore}
          </span>
        )}
        {app.applyUrl && (
          <a href={app.applyUrl} target="_blank" rel="noreferrer" style={chip}>The posting ↗</a>
        )}

        <span style={{ flex: 1 }} />

        {/* A posting that no longer exists gets no action and says why — requirement 6, and AC2
            requirement 4. There is no form to open and no run that would find one. */}
        {app.postingGone ? (
          <span style={{ fontSize: 9.5, color: theme.textDim, whiteSpace: "nowrap" }}>
            posting gone — cannot be resumed
          </span>
        ) : stale && onRerun ? (
          <button onClick={() => onRerun(app)}
            title="These answers were prepared too long ago to fill safely. A fresh run prepares new ones."
            style={{ ...chip, fontWeight: 800, cursor: "pointer" }}>
            Run it again
          </button>
        ) : onResolve ? (
          <button onClick={() => onResolve(app)} title={resolveTitle}
            style={{ ...chip, border: "none", background: tone, color: "#fff", fontWeight: 800,
                     cursor: "pointer" }}>
            {resolveLabel || "Open"}
          </button>
        ) : null}
        {onDetails && (
          <button onClick={() => onDetails(app)}
            title="Everything in this application's way, with its actions and its attempts."
            style={{ ...chip, fontWeight: 700, cursor: "pointer" }}>
            Details
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * ONE COMPANY, as a tile in the Job Profiles idiom (AC3).
 *
 * @param {string}   company   the employer, or "" for applications whose posting was cleaned up
 * @param {Array}    items     what to list inside — grouped applications, or raw rows
 * @param {function} children  the rendered list
 * @param {string}   section   which outcome section this tile belongs to, for the DOM checks
 * @param {string}   tone      the state colour: held on purpose, broke, submitted
 * @param {node}     pillText  the status chip's text
 * @param {node}     meta      the compact metadata line
 * @param {node}     footer    the action row
 */
export function CompanyTile({
  company, count, section, tone, pillText, meta, footer, theme, children,
}) {
  return (
    <TileCard
      tone={tone}
      data={{ tile: "company", company: company || "", section, apps: count }}
      // A posting removed by the 7-day cleanup leaves an application with no employer. Said
      // plainly, rather than rendered as a blank tile title — the same sentence CompanyHeading used.
      title={company || "Posting no longer on the board"}
      pill={pillText ? <TilePill tone={tone}>{pillText}</TilePill> : null}
      meta={meta}
      // No `body`: the profile card's body is a summary line above the inset, and a company tile's
      // summary IS the metadata line. An empty body would only add the 36px min-height reserved for
      // one, which is what made the old full-width cards wasteful in the first place.
      body={null}
      inset={
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {children}
        </div>
      }
      footer={footer}
    />
  );
}
