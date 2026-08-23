import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../styles/theme.jsx";
import { useAutoApply } from "../contexts/AutoApplyContext.jsx";
import { Z } from "../styles/zLayers.js";
import {
  groupByApplication, groupByCompany, splitByFault, resolutionPlan,
} from "../lib/applyObstacles.js";
import {
  SectionHeading, ObstacleCard, ApplicationRow, PrerequisiteCards, ApplicationObstacleCard,
  CompanyHeading, AttemptRow, CompanyTile, CompanyApplicationRow, HistoryGroup,
} from "./AutoApplyPanelSections.jsx";
// AC3: the company tier is now a TILE in the ManageJobProfiles idiom, and TileGrid is what makes it
// sit several-to-a-row at desktop width and stack when there is no room. Extracted from that panel,
// which renders the same components — see the note at the top of TileCard.jsx.
import { TileGrid } from "../components/ui/TileCard.jsx";
// AC4: the Database panel's own calendar, extracted rather than reimplemented, and the portal it
// has always been rendered inside. Reuse, not a second date picker.
import { DateCalendar } from "../components/ui/DateCalendar.jsx";
import { DockPortal } from "../components/DockPortal.jsx";
import { OUTCOME } from "../../../shared/applyOutcomeGroups.js";

// ============================================================
// AutoApplyPanel — the auto-apply pipeline, on its own tab
// ============================================================
// This is the strip that used to sit between the search bar and the postings, plus the review modal
// it opened, MOVED here whole. Run status, the review queue, the held-gate batches, the question
// queue, the pending-approval queue and the per-run detail are all present and all unchanged —
// nothing was dropped or simplified on the way, and no request, guard or ordering differs. The
// state now lives in AutoApplyContext so that this panel and the board can both reach it.
//
// Two consequences of the move, both deliberate:
//
//   - The strip's outer condition is gone. It existed to keep an EMPTY pipeline from taking up room
//     above the postings; on its own tab there is nothing to crowd, and a tab that renders blank
//     when you open it is worse than one that says the queue is empty.
//   - flexBasis:"100%" is dropped from the container: it made the strip span the toolbar's flex
//     row, and there is no row here.
//
// The board keeps a count badge on this tab (AutoApplyContext's needsAttentionCount) so that
// "3 need review" is still discoverable without opening it.
// ============================================================
export function AutoApplyPanel() {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const {
    // setApplyQueueMsg was USED by retryJob below and never destructured, so every Retry click threw
    // a ReferenceError before it reached the queue — the same "handler wired to nothing" class as
    // W1's no-op callbacks. The context has exported it all along.
    applyQueue = [], applyQueueMsg, setApplyQueueMsg,
    applyRuns = [], applyReviewJobs = [], applyGatePortals = [],
    applyHandoffPackets = [], handoffPacketFor, openHandoff, handoffMsg, setHandoffMsg,
    applyInFlight = [], applySubmitted = [], applyStopped = [], applyGatedJobs = [],
    applyPrereqMissing = [],
    applyRunDetailOpen, setApplyRunDetailOpen,
    applyRunDetail, setApplyRunDetail,
    applyReviewScope, setApplyReviewScope,
    applyReadiness,
    applyQuestions = [], applyQuestionMeta,
    questionDrafts, setQuestionDrafts,
    answersSaving, answersMsg,
    applyPending = [], pendingDetail, pendingBusy, pendingMsg,
    confirmApproveAll, setConfirmApproveAll,
    addToApplyQueue, removeFromApplyQueue, loadApplyRunDetail,
    submitApplyAnswers, openPendingDetail, decidePending,
    artifactUrl, startApplyRun,
    // AC4: the dated run history. Nothing here is populated until loadHistory is called with a
    // date the user picked — there is no loader effect anywhere behind it.
    historyDate, history, historyLoading, historyMsg, historyMarkers, historyBusyId,
    loadHistory, loadHistoryMonth, abortRunJob, hideRunJob,
  } = useAutoApply();

  const nothingYet =
    !applyQueue.length && !applyQueueMsg && !applyRuns.length &&
    !applyReviewJobs.length && !applyPending.length && !applyQuestions.length &&
    // The four cross-run feeds count too: a user whose only applications are SUBMITTED used to be
    // told "Nothing queued" over the top of their own sent applications.
    !applyInFlight.length && !applySubmitted.length && !applyStopped.length &&
    !applyPrereqMissing.length;

  // ── Grouping ────────────────────────────────────────────────────────────────────────────────
  //
  // The panel is organised by OBSTACLE, so the first job here is to turn flat lists of applications
  // into a small number of things a human can act on. Two questions are being answered per obstacle:
  // what is in the way, and how many applications does clearing it release.
  //
  // Questions split by REASON rather than being one queue: "confirm a guess" and "make a statement
  // to an employer" are different acts with different stakes, and the second is an attestation the
  // system will never answer on the user's behalf.
  const confirmQuestions = applyQuestions.filter(q => q.reason === "low_confidence" && !q.eligibility);
  const attestQuestions  = applyQuestions.filter(q => q.eligibility);
  const otherQuestions   = applyQuestions.filter(q => q.reason !== "low_confidence" && !q.eligibility);

  // ── AB2: ONE CARD PER APPLICATION ───────────────────────────────────────────────────────────
  //
  // This used to be `heldByObstacle`, a Map keyed on the obstacle SENTENCE. The server returns one
  // row per RUN-JOB, so a job held, re-run and held again for a different reason is three rows — and
  // keying on the sentence scattered that one application across three cards, each reporting
  // "1 APPLICATION". Three cards, one job, and counts that looked correct while the panel overstated
  // the work by 3x.
  //
  // The obstacle grouping is NOT gone; it moved to where it is true. See the rule in
  // applyObstacles.js: group by obstacle when one action unblocks many (the portal batches below,
  // which are the most differentiated thing in the product and are untouched), and by application
  // when many obstacles block one (this).
  const heldApplications = groupByApplication(applyReviewJobs);

  // ── AB4: OUTCOME, THEN COMPANY, THEN APPLICATION ────────────────────────────────────────────
  //
  // The company tier. A user applying to seven OpenAI roles wants them together; flat
  // reverse-chronological order interleaved them with everything else and made the one fact that
  // matters when a recruiter calls — which employer this is — invisible.
  const heldByCompany      = groupByCompany(heldApplications);
  const submittedByCompany = groupByCompany(applySubmitted);
  // PROBLEMS holds both terminal kinds, separated. "We protected you" and "this failed" need
  // different affordances and produce different feelings; the old STOPPED section put both under one
  // heading, which is the flattening this work has been undoing throughout.
  const stoppedSplit = splitByFault(applyStopped);
  const brokeByCompany          = groupByCompany(stoppedSplit.broke);
  const heldOnPurposeByCompany  = groupByCompany(stoppedSplit.held);

  const needsYouCount =
    applyGatePortals.reduce((n, p) => n + (p.count || 0), 0) +
    // APPLICATIONS, not rows. The old sum counted every held run-job, so one application held three
    // times added 3 to the number on the tab and in this heading.
    applyQuestions.length + applyPending.length + heldApplications.length +
    applyPrereqMissing.length;

  // ── AC1: OPEN IS SCOPED TO THE CARD ─────────────────────────────────────────────────────────
  //
  // A scope is { label, jobIds, rowIds, only }. `only` narrows to one FACET of the popup, for the
  // cards that are inherently about a queue rather than about one job — a portal batch, the question
  // queue, the approvals queue. Every card opens the popup on the thing it is standing for.
  const openScoped = (s) => { setApplyRunDetail(null); setApplyReviewScope(s); setApplyRunDetailOpen(true); };

  /**
   * THE UNSCOPED ENTRY POINT, AND THE ONLY ONE (requirement: "Review all" is the ONLY unscoped path).
   *
   * It is named `openEverything` rather than `openReview` on purpose, and that rename IS the fix for
   * the class of defect described below — not decoration.
   *
   * WHAT WENT WRONG, PRECISELY. AB3 (679ddac) did not regress and it did not leave a scope ignored
   * downstream. It was a HALF-FIX. AB3 rewrote every call site whose SHAPE was `onAction={openReview}`
   * or `onDetails={() => openReview()}` into a scoped call, and it left one call site alone — the one
   * whose shape was different, because its `openReview` sat in the fallback arm of a ternary:
   *
   *     onResolve={resumable ? () => openHandoff(packet, app) : openReview}
   *                                                             ^^^^^^^^^^ never rewritten
   *
   * So Details was scoped and OPEN was not, on the same card. Open only reaches that arm when the
   * application has no usable handoff packet — which is exactly the OpenAI card in the bug report,
   * and exactly the case the fixtures did not cover.
   *
   * THE MECHANISM, NAMED. This is the third appearance in this codebase of "a handler wired to the
   * wrong thing" (the no-op onSearch callbacks; the three hardcoded tab lists). Every instance has
   * the same cause: a fix applied by REWRITING THE CALL SITES THAT MATCHED A PATTERN, while the
   * wrong handler stayed in scope as a bare, zero-argument callable that any call site could still
   * name. A pattern-matched fix covers the shapes the author happened to look at; the identifier
   * covers every shape. So the unscoped handler is renamed away from the word every card's control
   * uses, the card's non-resumable arm now passes the SCOPED handler, and two assertions below hold
   * it: a source assertion that no card-level prop names the unscoped handler, and a real-browser
   * assertion in scripts/abPanelUi.mjs that CLICKS Open on a packet-less card and reads back what
   * the popup contains.
   *
   * The source assertion alone would not have caught this — test/applyObstacleSurfaces.test.js
   * asserted `!/onAction={openReview}/`, the exact string AB3 had just replaced, and
   * test/applyHeldResumable.test.js asserted the broken ternary VERBATIM. A test pinned the defect
   * in place. That is why the browser assertion exists.
   */
  const openEverything = () => openScoped(null);

  /** ONE application, with its full set of blocking reasons. */
  const openApplicationReview = (app) => openScoped({
    jobIds: app.jobId != null ? [String(app.jobId)] : [],
    // A row with no jobId can only be identified by its run-job ids, so both are carried and the
    // modal matches on either. Without this an unidentifiable application would scope to nothing and
    // the popup would come up empty.
    rowIds: (app.rows || []).map(r => r.id),
    label: [app.company, app.title].filter(Boolean).join(" — ") || app.jobId || "This application",
  });

  /**
   * ONE COMPANY's applications (AC3). The tile's footer action.
   *
   * Scoped like every other entry point, and for the reason AC1 exists: the tile is a triage
   * surface, so its one control has to open the thing it stands for. A company is several
   * applications, so the scope carries all of their ids — which is what makes this different from
   * `openEverything`, and the difference is the whole point.
   */
  const openCompanyReview = (company, items) => openScoped({
    jobIds: items.filter(a => a.jobId != null).map(a => String(a.jobId)),
    rowIds: items.flatMap(a => (a.rows || []).map(r => r.id)),
    label: company || "Postings no longer on the board",
  });

  /** One PORTAL's applications — the batch is the point here, so the scope is the batch. */
  const openPortalReview = (p) => openScoped({
    jobIds: (applyHandoffPackets || [])
      .filter(k => k.expectedOrigin === p.origin).map(k => String(k.jobId)),
    rowIds: [],
    label: `${p.host} — ${p.count} application${p.count === 1 ? "" : "s"}`,
  });

  /** One facet of the queue: the questions, or the approvals. */
  const openFacet = (only, label) => openScoped({ jobIds: [], rowIds: [], only, label });

  const closeReview = () => { setApplyRunDetailOpen(false); setApplyRunDetail(null); setApplyReviewScope(null); };

  // The scope, applied. A run detail is its own scope and outranks this — opening "Run 9" is a
  // question about that run, not about one application.
  const scope = applyRunDetail ? null : applyReviewScope;
  // A facet scope says nothing about WHICH jobs, so it does not filter by job at all.
  const byJob = scope && (scope.jobIds?.length || scope.rowIds?.length);
  const inScope = (jobId, rowId) => !byJob
    || (jobId != null && scope.jobIds.includes(String(jobId)))
    || (rowId != null && scope.rowIds.includes(rowId));
  const facet = (name) => !scope?.only || scope.only === name;

  // A scope names specific applications, so it has to be able to show them whichever feed they came
  // from. Gated jobs live in their own feed and have only ever been visible as a portal BATCH — so
  // scoping to a portal and then filtering `review` alone would open an empty popup. The unscoped
  // view is left as it was: there the batches above already stand for these rows, and listing them
  // twice is what the batching exists to avoid.
  const reviewPool = byJob
    ? [...applyReviewJobs, ...applyGatedJobs].filter((j, i, a) => a.findIndex(x => x.id === j.id) === i)
    : applyReviewJobs;
  const scopedReviewJobs = facet("applications") ? reviewPool.filter(j => inScope(j.jobId, j.id)) : [];
  const scopedPending    = facet("pending")      ? applyPending.filter(p => inScope(p.jobId, p.runJobId)) : [];
  // A question is in scope when it blocks this application. Questions are deduplicated across jobs
  // by the server, so one question can block several — it belongs to every one of them.
  const scopedQuestions  = facet("questions")
    ? applyQuestions.filter(q => !byJob || (q.blocking || []).some(b => inScope(b.jobId, null)))
    : [];

  // ── AC2: THE MODAL, AS COMPANY → APPLICATION → PROBLEMS ─────────────────────────────────────
  //
  // The same two functions the panel's own sections use, applied to whichever rows the popup is
  // showing. That is the point of requirement 1: "the card summary already does this correctly; the
  // modal must match it" — so this is not a second grouping, it is the same one.
  //
  // A RUN DETAIL is grouped too, not left as a flat list. The old code branched here and rendered
  // run-job rows raw for a run, which meant one job attempted twice inside one run read as two
  // applications on that surface while reading as one everywhere else. The per-attempt rows are
  // preserved underneath each application, so nothing about a run has become less visible.
  const modalApplications = groupByApplication(applyRunDetail ? applyRunDetail.jobs : scopedReviewJobs);
  const modalCompanies    = groupByCompany(modalApplications);

  // Which applications have their attempt list expanded. Keyed by the application key, so opening
  // one does not open another's, and the state outlives the popup rather than dying with it —
  // reopening the same application remembers what you were reading.
  const [openAttempts, setOpenAttempts] = useState({});

  /**
   * A YYYY-MM-DD rendered as the day the USER picked.
   *
   * `new Date("2026-08-11")` is parsed as UTC MIDNIGHT — so west of Greenwich toLocaleDateString
   * renders the 10th, and the panel told the user "No applications on 8/10" for a date they had
   * just clicked on. Constructed from the parts instead: no conversion, so nothing to get wrong.
   */
  const localDateLabel = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return iso || "";
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString();
  };

  // The history calendar popover. Local, because it is chrome — which date is SELECTED lives in
  // the context (the fetch is there), but whether the picker happens to be open is nobody else's
  // business. Anchored by rect and portalled, the same treatment the Database panel gives it: the
  // panel scrolls, and an absolutely-positioned popover inside a scrolling column is clipped by it.
  const historyCalRef = useRef(null);
  const [historyCalOpen, setHistoryCalOpen] = useState(false);
  const [historyCalRect, setHistoryCalRect] = useState(null);

  /**
   * AC2 requirement 2: this application's problems, with the CO-RESOLVABLE ones lifted out.
   *
   * Everything it needs is already computed by the server and already in this panel's hands —
   * `applyGatePortals` is GET /api/apply/gate-packets' own per-origin grouping (the unit an
   * activeTab grant is scoped to), and `applyQuestions` is GET /api/apply/questions' own cross-job
   * deduplication. resolutionPlan CONSUMES both rather than re-deriving either; see the table there
   * for exactly which holds can share one crossing and which cannot.
   */
  const planFor = (app) => resolutionPlan(app, {
    portals: applyGatePortals, packets: applyHandoffPackets, questions: applyQuestions,
  });

  /** What an amortised action does when pressed. One per group KIND, and there are only two. */
  const resolveGroup = (item, app) => {
    if (item.kind !== "group") return;
    if (item.origin) {
      // The portal batch. Cross it via this application's own packet when there is one — that puts
      // the user on the real form with the answers already prepared — and fall back to the batch
      // view, which is what the panel's own portal card opens.
      const packet = handoffPacketFor?.(app.primary?.row) || handoffPacketFor?.(app);
      const portal = applyGatePortals.find(p => p.origin === item.origin);
      if (packet && !packet.stale && !packet.postingGone) openHandoff(packet, app);
      else if (portal) openPortalReview(portal);
      return;
    }
    // The shared question. Its answer is stored by exact question text and reused on every form
    // that asks it, so the questions facet is where it is answered — for all of them at once.
    if (item.question) openFacet("questions", item.question);
  };

  // No per-job retry endpoint exists — the only way to try again is a new run — so "Retry" puts the
  // job back on the queue and says so, rather than pretending to re-dispatch it.
  const retryJob = (job) => {
    addToApplyQueue({ jobId: job.jobId, company: job.company, title: job.title });
    setApplyQueueMsg(`${job.company || "Job"} is back on the queue — press Autofill for Review to try again.`);
  };
  // The remedy for a STALE or unpreparable handoff (AB1 requirement 5): a fresh run, which produces
  // a fresh packet. Same mechanism as retryJob — there is no per-job re-dispatch endpoint, so it
  // says what it actually did rather than implying the application resumed by itself.
  const rerunJob = (job) => {
    addToApplyQueue({ jobId: job.jobId, company: job.company, title: job.title });
    setHandoffMsg(null);
    setApplyQueueMsg(`${job.company || "Job"} is queued for a fresh run — press Autofill for Review to prepare new answers.`);
  };

  /**
   * AB4 requirement 5: a missing resume is a PROBLEM WITH A ONE-CLICK FIX, and it was left as text —
   * a dead "no resume generated" chip with a tooltip.
   *
   * The click puts the job back on the queue, because the run is what generates a resume: the
   * pipeline's CASE C generates one in parallel with the browser and gates the upload on it. There is
   * no way to reach the board's own generator for a specific job from here — JobsPanel has no
   * deep-link — so using the pipeline's own generation path is both the shortest honest fix and the
   * one that produces a resume tailored the same way an auto-apply run would.
   *
   * The message says what actually happened rather than implying a resume now exists.
   */
  const generateResume = (job) => {
    addToApplyQueue({ jobId: job.jobId, company: job.company, title: job.title });
    setApplyQueueMsg(
      `${job.company || "Job"} is queued — the next run generates a resume for it before it applies. ` +
      `Press Autofill for Review to start.`);
  };

  return (
    <div style={{ padding: "24px 20px", maxWidth: 1100, margin: "0 auto",
                  display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <h2 style={{ margin: 0, fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 800,
                     fontSize: 26, letterSpacing: "0.06em", textTransform: "uppercase",
                     color: theme.text }}>
          Auto Apply
        </h2>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: theme.textMuted, lineHeight: 1.6 }}>
          Applications are filled and held for your approval. Nothing is submitted until you approve
          it. Queue jobs from the board.
        </p>
      </div>

      {/* Empty is a real state and is said plainly, rather than the tab rendering blank. */}
      {nothingYet && (
        <div style={{ padding: "28px 20px", border: `1px dashed ${theme.border}`, borderRadius: 8,
                      color: theme.textMuted, fontSize: 13, textAlign: "center" }}>
          Nothing queued. Add jobs from the board and they will appear here.
        </div>
      )}

      {/* ── READY TO START ───────────────────────────────────────────────────────────────────
          The client-side queue: jobs picked on the board that have not been dispatched yet. This is
          the old strip's first half, unchanged in behaviour — same single action posting the same
          mode:"auto" with no approvalMode, which the server treats as approval-required. */}
      {applyQueue.length > 0 && (
        <>
          <SectionHeading theme={theme} count={applyQueue.length} note="picked on the board, not started yet">
            Ready to start
          </SectionHeading>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                        padding: "10px 12px", border: `1px solid ${theme.border}`,
                        background: theme.surfaceHigh, borderRadius: 8 }}>
            {applyQueue.map(job => (
              <span key={job.jobId} style={{ display: "inline-flex", alignItems: "center", gap: 5,
                                             padding: "3px 7px", borderRadius: 4,
                                             background: theme.surface, color: theme.text, fontSize: 11 }}>
                {job.company || job.title}
                <button onClick={() => removeFromApplyQueue(job.jobId)}
                  style={{ border: "none", background: "transparent", color: theme.textDim,
                           cursor: "pointer", padding: 0 }}>x</button>
              </span>
            ))}
            {/* Automation tier, applied to the queue BEFORE the run starts. Requirement: full-auto is
                never offered for `account` or `gated`, and it is not — the only action here posts
                mode:"auto" with no approvalMode, so every job takes the fill-then-hold path. `gated`
                additionally cannot be completed at all; a CAPTCHA is named as the user's own job
                rather than attempted. Said BEFORE queueing, which is what was missing. */}
            {(() => {
              const needsAuth = applyQueue.filter(j => j.automationTier === "account");
              const cannotAuto = applyQueue.filter(j => j.automationTier === "gated");
              if (!needsAuth.length && !cannotAuto.length) return null;
              return (
                <span style={{ flexBasis: "100%", fontSize: 11, color: theme.textMuted, lineHeight: 1.6 }}>
                  {needsAuth.length > 0 && (
                    <>
                      <strong style={{ color: "#854d0e" }}>{needsAuth.length}</strong> of these need
                      you to sign in to the employer&rsquo;s account first — autofill fills the form once
                      you have.{" "}
                    </>
                  )}
                  {cannotAuto.length > 0 && (
                    <>
                      <strong style={{ color: "#991b1b" }}>{cannotAuto.length}</strong> sit behind a
                      CAPTCHA or identity check and cannot be automated at all; you will need to
                      apply to {cannotAuto.length === 1 ? "that one" : "those"} yourself.
                    </>
                  )}
                </span>
              );
            })()}
            <span style={{ flex: 1 }} />
            <button onClick={() => startApplyRun("review")}
              disabled={applyReadiness !== null && !applyReadiness.available}
              title={applyReadiness && !applyReadiness.available
                ? `Autofill unavailable: ${applyReadiness.reason}`
                : "Fills each application and holds it for your approval. Nothing is submitted until you approve it."}
              style={{ border: "none", borderRadius: 6, padding: "8px 14px",
                       background: applyReadiness && !applyReadiness.available ? (theme.surfaceHigh || "#555") : theme.accent,
                       color: "#0f0f0f", fontWeight: 800,
                       cursor: applyReadiness && !applyReadiness.available ? "not-allowed" : "pointer",
                       fontSize: 12, opacity: applyReadiness && !applyReadiness.available ? 0.5 : 1 }}>
              Autofill for Review
            </button>
            {applyReadiness && !applyReadiness.available && (
              <span style={{ fontSize: 11, color: theme.textDim || theme.textMuted }}>
                Browser unavailable: {applyReadiness.reason}
              </span>
            )}
          </div>
        </>
      )}
      {applyQueueMsg && (
        <span style={{ fontSize: 11.5, color: theme.accentText }}>{applyQueueMsg}</span>
      )}

      {/* ── IN FLIGHT ────────────────────────────────────────────────────────────────────────
          NOT one of AB4's three outcome sections, and deliberately placed ABOVE them rather than
          made a fourth. A queued or running application has no outcome yet — it is neither
          submitted, nor waiting on the user, nor broken — so filing it under any of the three would
          be a claim about it that is not true, and dropping it would lose a capability. It reads as
          progress, which is what it is: small, self-clearing, and out of the way. */}
      {applyInFlight.length > 0 && (
        <>
          <SectionHeading theme={theme} count={applyInFlight.length} note="nothing to do — these clear themselves">
            In flight
          </SectionHeading>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {applyInFlight.map(job => (
              <ApplicationRow key={job.id} job={job} theme={theme} variant="inFlight"
                artifactUrl={artifactUrl} onOpenRun={loadApplyRunDetail} />
            ))}
          </div>
        </>
      )}

      {/* ── 1. NEEDS REVIEW ──────────────────────────────────────────────────────────────────
          The first of AB4's three outcome sections, and first on the page: it is the only one where
          anything is waiting on a human. Inside it, both halves of the grouping rule — per-portal
          batches where one action unblocks many, per-application cards where many obstacles block
          one — then a company tier over the cards. */}
      {needsYouCount > 0 && (
        <>
          <SectionHeading theme={theme} count={needsYouCount} note="each of these is one action">
            Needs review
          </SectionHeading>

          {/* THE DELIBERATE "REVIEW ALL" (AB3 requirement 3). This view is still reachable — it is
              genuinely useful for working through a queue in one sitting — but it is now its own
              control, rather than being what every row's Open did. */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: -6 }}>
            <button onClick={openEverything}
              title="Every application needing review, in one list."
              style={{ border: `1px solid ${theme.border}`, borderRadius: 6, padding: "4px 10px",
                       background: "transparent", color: theme.textMuted, fontWeight: 700,
                       fontSize: 11, cursor: "pointer" }}>
              Review all {needsYouCount} →
            </button>
          </div>

          {/* Prerequisites first: they block EVERY application, so clearing anything else is wasted
              effort until they are done. */}
          {/* The count is what the jobs are blocked FROM, so it has to include applications already
              dispatched and sitting queued — not just the client-side basket. With only
              applyQueue.length the card read "Your profile has no email address" with no number
              beside six jobs that were blocked on exactly that. */}
          <PrerequisiteCards missing={applyPrereqMissing}
            queuedCount={applyQueue.length + applyInFlight.length}
            theme={theme} onGo={(tab) => navigate(`/app/${tab}`)} />

          {/* THE PORTAL AMORTISATION, and the most differentiated thing in the product: one sign-in
              releases every application queued behind that portal. Rendered as the hero because
              "sign in once -> 4 ready" is a ten-second job priced as one, where the same thing shown
              as four held rows is priced as four. */}
          {applyGatePortals.map(p => {
            const isCaptcha = p.gateReasons?.includes("captcha_required");
            return (
              <ObstacleCard
                key={p.origin}
                theme={theme}
                hero={!isCaptcha}
                tone={isCaptcha ? "#dc2626" : "#2563eb"}
                kicker={isCaptcha ? "cannot be automated" : "one sign-in clears all of these"}
                headline={isCaptcha
                  ? `${p.host} is behind a CAPTCHA or identity check`
                  : `Sign in to ${p.host} once → ${p.count} application${p.count === 1 ? "" : "s"} ready`}
                detail={isCaptcha
                  ? "We do not defeat identity checks. Open these and apply yourself."
                  : "Everything queued behind this portal continues as soon as you are signed in. Each one is still reviewed by you before it is sent."}
                count={p.count}
                countLabel={p.count === 1 ? "application" : "applications"}
                actionLabel={isCaptcha ? "Open them" : "Sign in"}
                onAction={() => openPortalReview(p)}
              />
            );
          })}

          {/* Low-confidence answers: the resolver HAS a value and would not send it. */}
          {confirmQuestions.length > 0 && (
            <ObstacleCard
              theme={theme} tone="#d97706"
              kicker="we guessed, and would not send a guess"
              headline={`${confirmQuestions.length} answer${confirmQuestions.length === 1 ? "" : "s"} need${confirmQuestions.length === 1 ? "s" : ""} confirmation`}
              detail={applyQuestionMeta.blockedJobs > 0
                ? `Confirming them unblocks ${applyQuestionMeta.blockedJobs} application${applyQuestionMeta.blockedJobs === 1 ? "" : "s"}. Each one is pre-filled with our guess — accepting it is the answer.`
                : "Each one is pre-filled with our guess — accepting it is the answer."}
              count={confirmQuestions.length}
              countLabel="to confirm"
              actionLabel="Confirm answers"
              onAction={() => openFacet("questions", "Answers to confirm")}
            />
          )}

          {/* Attestations are a different act: a statement the user makes to an employer. Never
              inferred from the profile, so never grouped with the guesses above. */}
          {attestQuestions.length > 0 && (
            <ObstacleCard
              theme={theme} tone="#dc2626"
              kicker="only you can state these"
              headline={`${attestQuestions.length} question${attestQuestions.length === 1 ? "" : "s"} you must answer yourself`}
              detail="These are statements to the employer — work authorisation, sponsorship, disability status. We never answer them from your profile."
              count={attestQuestions.length}
              countLabel="attestations"
              actionLabel="Answer"
              onAction={() => openFacet("questions", "Questions only you can answer")}
            />
          )}

          {otherQuestions.length > 0 && (
            <ObstacleCard
              theme={theme} tone="#d97706"
              kicker="the form asked for something we do not have"
              headline={`${otherQuestions.length} field${otherQuestions.length === 1 ? "" : "s"} we would not fill without you`}
              detail="Answering these turns the hold into a completed application. Saved answers are reused verbatim, never re-inferred."
              count={otherQuestions.length}
              countLabel="to answer"
              actionLabel="Answer"
              onAction={() => openFacet("questions", "Fields we would not fill without you")}
            />
          )}

          {/* Filled and one click from a real employer — the highest-stakes item on the panel. */}
          {applyPending.length > 0 && (
            <ObstacleCard
              theme={theme} tone="#2563eb" hero
              kicker="filled, checked, and not sent"
              headline={`${applyPending.length} application${applyPending.length === 1 ? "" : "s"} waiting for your approval`}
              detail="Read one before you approve it — approving submits it to the employer and cannot be undone."
              count={applyPending.length}
              countLabel="to approve"
              actionLabel="Review & approve"
              onAction={() => openFacet("pending", "Applications waiting for your approval")}
            />
          )}

          {/* ── AC3: ONE TILE PER COMPANY, IN THE JOB PROFILES IDIOM ────────────────────────
              This was a company HEADING followed by full-width application cards, one per row down
              the whole page — so four employers took four screens and no two could be compared. The
              tile is a TRIAGE surface: employer, how many applications, how much is in the way, and
              held-on-purpose vs broke, several to a row. The problem SENTENCES are one click away in
              the modal, which AC2 restructured into company → application → problems for this. */}
          <TileGrid min={430} gap={14}>
            {heldByCompany.map(({ company, items }) => {
              const toResolve = items.reduce((n, a) => n + a.reasons.length, 0);
              // One broken application is enough to stop calling the whole tile deliberate — the
              // same rule groupByApplication uses within one application, one tier up.
              const allProtective = items.every(a => a.protective);
              const allGone = items.every(a => a.postingGone);
              const tone = allGone ? "#6b7280" : allProtective ? "#d97706" : "#dc2626";
              return (
                <CompanyTile
                  key={`held-${company}`}
                  company={company}
                  count={items.length}
                  section="needsReview"
                  tone={tone}
                  theme={theme}
                  // A tile of applications whose postings the cleanup removed is not "held on
                  // purpose" — nothing is holding them, there is nothing left to hold. Its own
                  // state, at tile level, the same way each row states it.
                  pillText={allGone ? "posting gone" : allProtective ? "held on purpose" : "needs you"}
                  meta={`${items.length} application${items.length === 1 ? "" : "s"} · ${toResolve} thing${toResolve === 1 ? "" : "s"} to resolve`}
                  footer={
                    <button onClick={() => openCompanyReview(company, items)}
                      title={`Everything in the way of ${company || "these applications"}, in one list.`}
                      style={{ border: `1px solid ${theme.border}`, borderRadius: 6, padding: "6px 12px",
                               background: theme.surface, color: theme.text, fontWeight: 700,
                               fontSize: 11.5, cursor: "pointer" }}>
                      Review all {items.length} →
                    </button>
                  }
                >
                  {items.map(app => {
                    const packet = handoffPacketFor?.(app.primary.row) || handoffPacketFor?.(app);
                    const resumable = !!packet && !packet.postingGone && !packet.stale && !app.postingGone;
                    return (
                      <CompanyApplicationRow
                        key={app.key}
                        app={app}
                        theme={theme}
                        artifactUrl={artifactUrl}
                        packet={packet}
                        onRerun={rerunJob}
                        // THE AC1 DEFECT, FIXED. The fallback arm was `openReview` — the unscoped
                        // "everything" handler — so Open on a packet-less card listed every
                        // application needing review. It passes the SCOPED handler, invoked as
                        // onResolve(app), so Open and Details scope to the same one application by
                        // construction.
                        onResolve={resumable ? () => openHandoff(packet, app) : openApplicationReview}
                        resolveLabel={resumable ? "Open & fill" : "Open"}
                        resolveTitle={resumable
                          ? `Opens the application in your own browser and fills it with the ${packet.answerCount} answer${packet.answerCount === 1 ? "" : "s"} we already resolved. You review and submit.`
                          : "Open this application's review — only this one"}
                        onDetails={() => openApplicationReview(app)}
                        // AB4 requirement 5: "no resume was generated" was a dead text chip on a
                        // PROBLEM with an obvious fix. It gets the button.
                        onGenerateResume={app.primary?.row?.resumeAvailable ? null : generateResume}
                      />
                    );
                  })}
                </CompanyTile>
              );
            })}
          </TileGrid>

          {/* The handoff happens in ANOTHER TAB, so the panel has to say what to expect there. A
              refusal (stale answers, a posting that is gone) is reported in the same place, because
              the alternative is a click that appears to do nothing. */}
          {handoffMsg && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10,
                          border: `1px solid ${handoffMsg.kind === "open" ? "#2563eb" : theme.border}`,
                          borderLeft: `3px solid ${handoffMsg.kind === "open" ? "#2563eb" : "#d97706"}`,
                          borderRadius: 8, padding: "10px 14px", background: theme.surfaceHigh }}>
              <span style={{ fontSize: 11.5, color: theme.text, lineHeight: 1.6, flex: 1 }}>
                {handoffMsg.text}
              </span>
              <button onClick={() => setHandoffMsg(null)}
                style={{ border: "none", background: "transparent", color: theme.textDim,
                         cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px" }}>×</button>
            </div>
          )}
        </>
      )}

      {/* ── 2. SUBMITTED ─────────────────────────────────────────────────────────────────────
          What a user reaches for when an interview lands: the date, the EXACT resume that went out,
          and the screenshot of the form as submitted. Grouped by company, because that is the
          question being asked at that moment — a recruiter from OpenAI has called, and the seven
          OpenAI applications need to be together. */}
      {applySubmitted.length > 0 && (
        <>
          <SectionHeading theme={theme} count={applySubmitted.length} note="what went out, and the proof">
            Submitted
          </SectionHeading>
          {/* The same tile, so the page reads as one system rather than as a tiled section above a
              listed one. The rows INSIDE are the existing ApplicationRow, untouched: a submitted
              application's evidence — the date, the exact resume that went out, the screenshot,
              whether the site confirmed it — is what a user reaches for when an interview lands,
              and compacting that would be trading away the thing the section exists for. */}
          <TileGrid min={430} gap={14}>
            {submittedByCompany.map(({ company, items }) => (
              <CompanyTile
                key={`sub-${company}`}
                company={company}
                count={items.length}
                section="submitted"
                tone="#16a34a"
                theme={theme}
                pillText="sent"
                meta={`${items.length} application${items.length === 1 ? "" : "s"} · ${items.filter(j => j.submitVerified).length} confirmed by the site`}
              >
                {items.map(job => (
                  <ApplicationRow key={job.id} job={job} theme={theme} variant="submitted"
                    artifactUrl={artifactUrl} onOpenRun={loadApplyRunDetail} />
                ))}
              </CompanyTile>
            ))}
          </TileGrid>
        </>
      )}

      {/* ── 3. PROBLEMS ──────────────────────────────────────────────────────────────────────
          Things that BROKE, kept distinct from things we deliberately held — the distinction this
          whole line of work exists to preserve. "We protected you" and "this failed" need different
          affordances and produce different feelings, and the old STOPPED section put both under one
          heading. Both live here, because both are terminal and neither is waiting on a decision,
          but they are separated and labelled inside it. */}
      {applyStopped.length > 0 && (
        <>
          <SectionHeading theme={theme} count={applyStopped.length} note="why, in plain language">
            Problems
          </SectionHeading>

          {brokeByCompany.length > 0 && (
            <>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.08em",
                            textTransform: "uppercase", color: "#dc2626", marginTop: 4 }}>
                These broke — {stoppedSplit.broke.length} application{stoppedSplit.broke.length === 1 ? "" : "s"}
              </div>
              <TileGrid min={430} gap={14}>
                {brokeByCompany.map(({ company, items }) => (
                  <CompanyTile
                    key={`broke-${company}`}
                    company={company}
                    count={items.length}
                    section="broke"
                    tone="#dc2626"
                    theme={theme}
                    pillText="did not complete"
                    meta={`${items.length} application${items.length === 1 ? "" : "s"} · nothing was sent`}
                  >
                    {items.map(job => (
                      <ApplicationRow key={job.id} job={job} theme={theme} variant="stopped"
                        artifactUrl={artifactUrl} onRetry={retryJob} onOpenRun={loadApplyRunDetail}
                        // Requirement 5: a missing resume is a problem with an obvious fix, so it gets
                        // a button instead of the dead "no resume generated" chip it used to be.
                        onGenerateResume={job.resumeAvailable ? null : generateResume} />
                    ))}
                  </CompanyTile>
                ))}
              </TileGrid>
            </>
          )}

          {heldOnPurposeByCompany.length > 0 && (
            <>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.08em",
                            textTransform: "uppercase", color: "#d97706", marginTop: 8 }}>
                Held on purpose — {stoppedSplit.held.length} application{stoppedSplit.held.length === 1 ? "" : "s"}
              </div>
              <div style={{ fontSize: 11, color: theme.textMuted, marginTop: -2 }}>
                Nothing went wrong with these. The pipeline stopped them, or you did.
              </div>
              <TileGrid min={430} gap={14}>
                {heldOnPurposeByCompany.map(({ company, items }) => (
                  <CompanyTile
                    key={`held-stop-${company}`}
                    company={company}
                    count={items.length}
                    section="heldOnPurpose"
                    tone="#d97706"
                    theme={theme}
                    pillText="held on purpose"
                    meta={`${items.length} application${items.length === 1 ? "" : "s"} · nothing went wrong`}
                  >
                    {items.map(job => (
                      <ApplicationRow key={job.id} job={job} theme={theme} variant="stopped"
                        artifactUrl={artifactUrl} onRetry={retryJob} onOpenRun={loadApplyRunDetail}
                        onGenerateResume={job.resumeAvailable ? null : generateResume} />
                    ))}
                  </CompanyTile>
                ))}
              </TileGrid>
            </>
          )}
        </>
      )}

      {/* ── AC4: RUN HISTORY, DATE-DRIVEN AND ON DEMAND ─────────────────────────────────────
          This was a <details> holding chips for the last 20 RUNS. A run is an implementation detail
          — nobody thinks "run 47" — and twenty of them is neither all of the history nor a useful
          window on it. It is the same record, asked the question a candidate actually has: what did
          I put into auto-apply on this day, and how did each one end.

          REQUIREMENT 2 IS WHY THERE IS NO EFFECT BEHIND THIS. Nothing loads until a date is
          selected; the panel's initial render issues no history query. `history === null` means
          "you have not asked yet" and an empty payload means "nothing happened that day" — two
          different states, rendered differently, because collapsing them is how requirement 6's
          "no applications on this date" becomes a permanent spinner.

          The per-run detail the old chips opened is NOT lost: loadApplyRunDetail is still reachable
          from every application row's `details` link, which is where a question about a specific
          run actually starts. */}
      <SectionHeading theme={theme} note="pick a date to see what you queued that day">
        Run history
      </SectionHeading>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div ref={historyCalRef} style={{ position: "relative" }}>
          <button
            onClick={() => {
              const opening = !historyCalOpen;
              setHistoryCalRect(historyCalRef.current?.getBoundingClientRect() || null);
              setHistoryCalOpen(opening);
              // Requirement 7's markers, fetched when the calendar is OPENED — an action the user
              // took — never on the panel's initial render. See loadHistoryMonth for the tradeoff
              // and how to remove it if an owner would rather have no query at all before a pick.
              if (opening) {
                const d = historyDate ? new Date(historyDate) : new Date();
                loadHistoryMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
              }
            }}
            style={{ display: "flex", alignItems: "center", gap: 6,
                     background: historyDate ? theme.accentMuted : theme.surfaceHigh,
                     color: historyDate ? theme.accentText : theme.textMuted,
                     border: `1px solid ${theme.border}`, borderRadius: 999,
                     padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
            📅 {historyDate ? `Date: ${localDateLabel(historyDate)}` : "Pick a date"}
          </button>
          <AnimatePresence>
            {historyCalOpen && historyCalRect && (
              <DockPortal anchorRect={historyCalRect} theme={theme}
                onClose={() => setHistoryCalOpen(false)} style={{ minWidth: 260, padding: 0 }}>
                <motion.div key="history-cal"
                  initial={{ opacity: 0, scale: 0.96, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: -4 }}
                  transition={{ duration: 0.15 }}>
                  {/* THE DATABASE PANEL'S OWN CALENDAR, extracted rather than reimplemented — same
                      component, same DockPortal treatment, same interaction. `markers` is the one
                      thing added, and it is optional, so the Database panel renders as before. */}
                  <DateCalendar theme={theme}
                    value={historyDate || ""}
                    markers={historyMarkers}
                    onMonth={loadHistoryMonth}
                    onChange={(iso) => loadHistory(iso)}
                    onClose={() => setHistoryCalOpen(false)} />
                </motion.div>
              </DockPortal>
            )}
          </AnimatePresence>
        </div>
        {historyDate && (
          <button onClick={() => loadHistory(null)}
            style={{ border: "none", background: "transparent", color: theme.textDim,
                     fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>
            Clear
          </button>
        )}
        {historyLoading && (
          <span style={{ fontSize: 11, color: theme.textMuted }}>Loading…</span>
        )}
        {historyMsg && (
          <span style={{ fontSize: 11.5, color: theme.accentText }}>{historyMsg}</span>
        )}
      </div>

      {/* NOT YET ASKED. The resting state, and it is deliberately not a spinner and not a default
          day's results — requirement 2 forbids the second and the first would be a lie. */}
      {history === null && !historyLoading && (
        <div style={{ padding: "18px 20px", border: `1px dashed ${theme.border}`, borderRadius: 8,
                      color: theme.textMuted, fontSize: 12, textAlign: "center" }}>
          Pick a date to see the applications you added to auto-apply that day.
          {Object.keys(historyMarkers).length > 0 && " Dates with activity are dotted in the calendar."}
        </div>
      )}

      {/* AN EMPTY DATE IS A NORMAL STATE (requirement 6) — not an error, not a spinner. */}
      {history !== null && history.total === 0 && (
        <div style={{ padding: "18px 20px", border: `1px dashed ${theme.border}`, borderRadius: 8,
                      color: theme.textMuted, fontSize: 12, textAlign: "center" }}>
          No applications on {localDateLabel(history.date)}.
        </div>
      )}

      {history !== null && history.total > 0 && (
        <TileGrid min={330} gap={12}>
          {/* All THREE groups, always, even at zero: "0 completed" on a day where four applications
              broke is information, and hiding the group makes the reader count sections to work out
              what is missing. The order is the order of the requirement. */}
          {[OUTCOME.COMPLETED, OUTCOME.PENDING, OUTCOME.ABORTED].map(group => (
            <HistoryGroup
              key={group}
              group={group}
              jobs={history[group] || []}
              theme={theme}
              busyId={historyBusyId}
              onAbort={abortRunJob}
              onHide={hideRunJob}
              artifactUrl={artifactUrl}
            />
          ))}
        </TileGrid>
      )}

      {/* ── Apply Runs Review Modal ──────────────────────────────────── */}
      {applyRunDetailOpen && (
        <div
          onClick={e => { if (e.target === e.currentTarget) closeReview() }}
          style={{
            // Named tier rather than the literal 700 it carried. Same class as JobsPanel's
            // resume-enhance modal: a focused takeover over the app, above the filters drawer.
            position:"fixed", inset:0, zIndex:Z.MODAL_SCRIM,
            background:"rgba(0,0,0,0.55)", display:"flex",
            alignItems:"flex-start", justifyContent:"center",
            paddingTop:48, overflowY:"auto",
          }}
        >
          <div style={{
            background:theme.modalSurface || theme.surface,
            borderRadius:8, width:"min(96vw, 820px)",
            maxHeight:"82vh", display:"flex", flexDirection:"column",
            border:`1px solid ${theme.border}`,
            boxShadow:"0 24px 64px rgba(0,0,0,0.4)",
          }}>
            {/* Header */}
            <div style={{
              padding:"16px 20px", borderBottom:`1px solid ${theme.border}`,
              display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0, gap:12,
            }}>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                             fontSize:18, letterSpacing:"0.06em", textTransform:"uppercase" }}>
                {/* The popup SAYS what it is about. It used to be titled "Jobs Needing Review"
                    whichever row you opened it from, which is the honest name for a popup that was
                    always showing all of them. */}
                {applyRunDetail
                  ? `Apply Run #${applyRunDetail.run?.id} — ${applyRunDetail.run?.mode || "auto"}`
                  : scope ? scope.label
                  : "Every application needing review"}
              </div>
              {applyRunDetail?.run && (
                <div style={{ display:"flex", gap:10, fontSize:11, flexWrap:"wrap", alignItems:"center" }}>
                  {/* THE RUN'S OWN STATUS. It used to live on the dot of the run-history chip that
                      AC4's dated view replaced — and the chip was the only place a run said whether
                      it had finished, so removing the list would have quietly dropped that. It
                      belongs here anyway: this is the run's detail, and "is this run still going"
                      is the first thing to know when reading one. */}
                  <span style={{ fontWeight:700, padding:"1px 7px", borderRadius:999,
                                 whiteSpace:"nowrap",
                                 background: applyRunDetail.run.status === "completed" ? "#16a34a22"
                                   : applyRunDetail.run.status === "running" ? `${theme.accent}22`
                                   : applyRunDetail.run.status === "queued" ? "#d9770622" : "#6b728022",
                                 color: applyRunDetail.run.status === "completed" ? "#16a34a"
                                   : applyRunDetail.run.status === "running" ? theme.accent
                                   : applyRunDetail.run.status === "queued" ? "#d97706" : theme.textMuted }}>
                    {applyRunDetail.run.status || "—"}
                  </span>
                  {applyRunDetail.run.submittedCount > 0 && (
                    <span style={{ color:"#16a34a", fontWeight:700 }}>✓ {applyRunDetail.run.submittedCount} submitted</span>
                  )}
                  {applyRunDetail.run.heldCount > 0 && (
                    <span style={{ color:"#d97706", fontWeight:700 }}>⏸ {applyRunDetail.run.heldCount} held</span>
                  )}
                  {applyRunDetail.run.failedCount > 0 && (
                    <span style={{ color:"#dc2626", fontWeight:700 }}>✗ {applyRunDetail.run.failedCount} failed</span>
                  )}
                  {applyRunDetail.run.startedAt && (
                    <span style={{ color:theme.textDim }}>
                      {new Date(applyRunDetail.run.startedAt).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              <button
                onClick={() => closeReview()}
                style={{ background:"transparent", border:"none", cursor:"pointer",
                          color:theme.textMuted, fontSize:20, lineHeight:1, padding:"0 4px",
                          marginLeft:"auto", flexShrink:0 }}>
                ×
              </button>
            </div>

            {/* Job list */}
            <div style={{ overflowY:"auto", flex:1, padding:"12px 20px", display:"flex", flexDirection:"column", gap:8 }}>

              {/* ── Queue-then-approve ──────────────────────────────────────────
                  These applications are already filled and have passed every gate. Approving one
                  submits it to a real employer and it cannot be recalled, so this surface is built
                  around reading before deciding: the row says how many answers were GUESSED, and
                  the detail view shows every answer with the rule that produced it, plus the exact
                  resume that will be attached. */}
              {!applyRunDetail && scopedPending.length > 0 && (
                <div style={{ border:"1px solid #2563eb", borderRadius:6, padding:"12px 14px",
                              background:theme.surfaceHigh, display:"flex", flexDirection:"column", gap:10 }}>
                  <div>
                    <div style={{ fontWeight:800, fontSize:13, color:theme.text }}>
                      {scopedPending.length} application{scopedPending.length === 1 ? "" : "s"} waiting on you
                    </div>
                    <div style={{ fontSize:11, color:theme.textMuted, marginTop:2 }}>
                      Filled and checked, but nothing has been sent. Read one before you approve it —
                      approving submits it to the employer and cannot be undone.
                    </div>
                  </div>

                  {scopedPending.map(p => {
                    const open = pendingDetail?.runJobId === p.runJobId;
                    const btn  = (bg, fg, bd) => ({
                      border:`1px solid ${bd}`, borderRadius:6, padding:"5px 10px", background:bg,
                      color:fg, fontWeight:800, fontSize:11.5,
                      cursor: pendingBusy ? "wait" : "pointer", opacity: pendingBusy ? 0.6 : 1,
                    });
                    return (
                      <div key={p.runJobId} style={{ borderTop:`1px solid ${theme.border}`, paddingTop:10,
                                                     display:"flex", flexDirection:"column", gap:6 }}>
                        <div style={{ display:"flex", alignItems:"flex-start", gap:8, flexWrap:"wrap" }}>
                          <span style={{ fontSize:12, fontWeight:700, color:theme.text, flex:1, minWidth:200 }}>
                            {p.company || "Unknown company"}
                            {p.title ? <span style={{ color:theme.textMuted, fontWeight:600 }}> — {p.title}</span> : null}
                          </span>
                          {/* A guess is the thing worth a human's attention; an exact mapping is not. */}
                          {p.guessCount > 0 && (
                            <span title="Answers matched by a fuzzy label match rather than an exact mapping. Read these."
                              style={{ fontSize:9, fontWeight:800, padding:"2px 7px", borderRadius:999,
                                       background:"#d9770622", color:"#d97706", whiteSpace:"nowrap", flexShrink:0 }}>
                              {p.guessCount} GUESSED
                            </span>
                          )}
                          <span style={{ fontSize:10, color:theme.textDim, whiteSpace:"nowrap" }}>
                            {p.answerCount} answer{p.answerCount === 1 ? "" : "s"}
                            {p.resume.atsScore != null ? ` · ATS ${p.resume.atsScore}` : ""}
                          </span>
                        </div>

                        <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
                          <button onClick={() => openPendingDetail(p.runJobId)}
                            style={btn(theme.surface, theme.text, theme.border)}>
                            {open ? "Hide" : "Review"} answers
                          </button>
                          {p.resume.available && (
                            <a href={artifactUrl(p.runJobId, "resume")} target="_blank" rel="noreferrer"
                              style={{ ...btn(theme.surface, theme.text, theme.border), textDecoration:"none" }}>
                              Resume PDF ↗
                            </a>
                          )}
                          {/* Evidence, not a route. This application's way forward is Approve & send
                              below — the server submits it — so the screenshot is here to be read
                              before deciding, never to be submitted from. */}
                          {p.screenshotAvailable && (
                            <a href={artifactUrl(p.runJobId, "screenshot")} target="_blank" rel="noreferrer"
                              title="A picture of the form as we filled it. Read it before you approve."
                              style={{ ...btn(theme.surface, theme.textMuted, theme.border), textDecoration:"none" }}>
                              What we filled ↗
                            </a>
                          )}
                          <span style={{ flex:1 }}/>
                          <button onClick={() => decidePending([p.runJobId], false)} disabled={pendingBusy}
                            style={btn(theme.surface, "#dc2626", "#dc262655")}>
                            Reject
                          </button>
                          <button onClick={() => decidePending([p.runJobId], true)} disabled={pendingBusy}
                            style={btn("#2563eb", "#ffffff", "#2563eb")}>
                            Approve &amp; send
                          </button>
                        </div>

                        {open && (
                          <div style={{ border:`1px solid ${theme.border}`, borderRadius:6, padding:"8px 10px",
                                        background:theme.surface, display:"flex", flexDirection:"column", gap:4 }}>
                            {pendingDetail.loading ? (
                              <span style={{ fontSize:11, color:theme.textMuted }}>Loading…</span>
                            ) : (
                              <>
                                <div style={{ fontSize:10, color:theme.textMuted }}>
                                  This is exactly what will be sent. Anything marked GUESS was matched by label,
                                  not by an exact mapping.
                                </div>
                                {(pendingDetail.answers || [])
                                  .filter(a => !a.skipped && !a.policy_rejected)
                                  .map((a, i) => {
                                    const guess = a.provenance === "label_fuzzy";
                                    return (
                                      <div key={i} style={{ display:"flex", gap:8, alignItems:"baseline",
                                                            flexWrap:"wrap", fontSize:11,
                                                            borderTop: i ? `1px solid ${theme.border}` : "none",
                                                            paddingTop: i ? 4 : 0 }}>
                                        <span style={{ color:theme.textMuted, minWidth:150, flex:"0 1 auto" }}>
                                          {a.label || a.name || a.field_id}
                                        </span>
                                        <span style={{ color:theme.text, fontWeight:700, flex:1, minWidth:120,
                                                       wordBreak:"break-word" }}>
                                          {String(a.value ?? "")}
                                        </span>
                                        <span style={{ fontSize:9, fontWeight:800, padding:"1px 6px", borderRadius:999,
                                                       whiteSpace:"nowrap",
                                                       background: guess ? "#d9770622" : `${theme.border}66`,
                                                       color: guess ? "#d97706" : theme.textDim }}>
                                          {guess ? "GUESS" : (a.provenance || "").replace(/_/g, " ") || "—"}
                                        </span>
                                      </div>
                                    );
                                  })}
                                {(pendingDetail.answers || []).filter(a => !a.skipped && !a.policy_rejected).length === 0 && (
                                  <span style={{ fontSize:11, color:theme.textMuted }}>No answers recorded.</span>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", paddingTop:4 }}>
                    {/* Bulk approval is the one place a stray click could send several real
                        applications at once, so it takes two deliberate steps. */}
                    {scopedPending.length > 1 && (
                      confirmApproveAll ? (
                        <>
                          <span style={{ fontSize:11, color:"#dc2626", fontWeight:700 }}>
                            Send all {scopedPending.length} to their employers?
                          </span>
                          <button onClick={() => decidePending(scopedPending.map(p => p.runJobId), true)}
                            disabled={pendingBusy}
                            style={{ border:"none", borderRadius:6, padding:"6px 12px", background:"#dc2626",
                                     color:"#fff", fontWeight:800, fontSize:12,
                                     cursor: pendingBusy ? "wait" : "pointer" }}>
                            Yes, send all
                          </button>
                          <button onClick={() => setConfirmApproveAll(false)} disabled={pendingBusy}
                            style={{ border:`1px solid ${theme.border}`, borderRadius:6, padding:"6px 12px",
                                     background:theme.surface, color:theme.text, fontWeight:700, fontSize:12,
                                     cursor:"pointer" }}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button onClick={() => setConfirmApproveAll(true)} disabled={pendingBusy}
                          style={{ border:`1px solid ${theme.border}`, borderRadius:6, padding:"6px 12px",
                                   background:theme.surface, color:theme.text, fontWeight:700, fontSize:12,
                                   cursor: pendingBusy ? "wait" : "pointer" }}>
                          Approve all {scopedPending.length}
                        </button>
                      )
                    )}
                    {pendingMsg && (
                      <span style={{ fontSize:11, color:theme.accentText }}>{pendingMsg}</span>
                    )}
                  </div>
                </div>
              )}

              {/* ── Validation-correction loop ──────────────────────────────────
                  A hold used to end the run. These are the fields the resolver refused to fill on
                  its own; answering them is what turns the hold into a completed application. The
                  answers are stored as custom_answers, which is the only exact-by-construction
                  resolution path — so on retry they are used verbatim, never inferred. */}
              {!applyRunDetail && scopedQuestions.length > 0 && (
                <div style={{ border:`1px solid ${theme.accent}`, borderRadius:6, padding:"12px 14px",
                              background:theme.surfaceHigh, display:"flex", flexDirection:"column", gap:10 }}>
                  <div>
                    <div style={{ fontWeight:800, fontSize:13, color:theme.text }}>
                      Answer {scopedQuestions.length} question{scopedQuestions.length === 1 ? "" : "s"}
                      {applyQuestionMeta.blockedJobs > 0 &&
                        ` to unblock ${applyQuestionMeta.blockedJobs} application${applyQuestionMeta.blockedJobs === 1 ? "" : "s"}`}
                    </div>
                    <div style={{ fontSize:11, color:theme.textMuted, marginTop:2 }}>
                      Nothing here was guessed on your behalf — these are the fields we would not fill without you.
                      {applyQuestionMeta.eligibilityCount > 0 &&
                        ` ${applyQuestionMeta.eligibilityCount} of them are attestations to the employer.`}
                    </div>
                  </div>

                  {scopedQuestions.map(q => {
                    const isEligibility = !!q.eligibility;
                    const isConfirm     = q.reason === "low_confidence";
                    const value         = questionDrafts[q.question] ?? "";
                    const setValue      = v => setQuestionDrafts(prev => ({ ...prev, [q.question]: v }));
                    const inputStyle    = { width:"100%", padding:"6px 8px", fontSize:12, borderRadius:4,
                                            border:`1px solid ${theme.border}`, background:theme.surface,
                                            color:theme.text, boxSizing:"border-box" };
                    return (
                      <div key={q.question} style={{ borderTop:`1px solid ${theme.border}`, paddingTop:10,
                                                     display:"flex", flexDirection:"column", gap:5 }}>
                        <div style={{ display:"flex", alignItems:"flex-start", gap:8, flexWrap:"wrap" }}>
                          <span style={{ fontSize:12, fontWeight:700, color:theme.text, flex:1, minWidth:220 }}>
                            {q.question}
                          </span>
                          {isEligibility && (
                            <span title="Submitted to the employer as your own statement. Never inferred from your profile."
                              style={{ fontSize:9, fontWeight:800, padding:"2px 7px", borderRadius:999,
                                       background:"#dc262622", color:"#dc2626", whiteSpace:"nowrap", flexShrink:0 }}>
                              ATTESTATION
                            </span>
                          )}
                          {q.answered && (
                            <span style={{ fontSize:9, fontWeight:700, padding:"2px 7px", borderRadius:999,
                                           background:"#16a34a22", color:"#16a34a", whiteSpace:"nowrap", flexShrink:0 }}>
                              SAVED
                            </span>
                          )}
                        </div>

                        {isEligibility && (
                          <div style={{ fontSize:10, color:"#dc2626" }}>
                            You are stating this to the employer yourself. We never answer it from your profile.
                          </div>
                        )}
                        {isConfirm && (
                          <div style={{ fontSize:10, color:theme.textMuted }}>
                            We had a guess{q.proposed ? ` — "${q.proposed}"` : ""} but were not confident enough to send it.
                            Confirm or correct it.
                          </div>
                        )}

                        {Array.isArray(q.options) && q.options.length > 0 ? (
                          <select value={value} onChange={e => setValue(e.target.value)} style={inputStyle}>
                            <option value="">Select…</option>
                            {q.options.map(o => (
                              <option key={o.value} value={o.value}>{o.label || o.value}</option>
                            ))}
                          </select>
                        ) : q.type === "checkbox" || q.type === "toggle" ? (
                          <select value={value} onChange={e => setValue(e.target.value)} style={inputStyle}>
                            <option value="">Select…</option>
                            <option value="Yes">Yes</option>
                            <option value="No">No</option>
                          </select>
                        ) : q.type === "text_area" ? (
                          <textarea rows={2} value={value} onChange={e => setValue(e.target.value)} style={inputStyle}/>
                        ) : (
                          <input value={value} onChange={e => setValue(e.target.value)} style={inputStyle}/>
                        )}

                        {(q.blocking || []).length > 0 && (
                          <div style={{ fontSize:10, color:theme.textDim }}>
                            Blocks: {q.blocking.slice(0, 3).map(b => b.company || b.title || b.jobId).join(", ")}
                            {q.blocking.length > 3 ? ` +${q.blocking.length - 3} more` : ""}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", paddingTop:4 }}>
                    <button onClick={() => submitApplyAnswers(true)} disabled={answersSaving}
                      style={{ border:"none", borderRadius:6, padding:"6px 12px", background:theme.accent,
                               color:"#0f0f0f", fontWeight:800, fontSize:12,
                               cursor: answersSaving ? "wait" : "pointer", opacity: answersSaving ? 0.6 : 1 }}>
                      {answersSaving ? "Saving…" : "Save & retry"}
                    </button>
                    <button onClick={() => submitApplyAnswers(false)} disabled={answersSaving}
                      style={{ border:`1px solid ${theme.border}`, borderRadius:6, padding:"6px 12px",
                               background:theme.surface, color:theme.text, fontWeight:700, fontSize:12,
                               cursor: answersSaving ? "wait" : "pointer", opacity: answersSaving ? 0.6 : 1 }}>
                      Save only
                    </button>
                    {answersMsg && (
                      <span style={{ fontSize:11, color:theme.accentText }}>{answersMsg}</span>
                    )}
                  </div>
                </div>
              )}

              {/* Sign in once, and everything queued behind that gate is ready. The count is the
                  offer: a ten-second sign-in that releases seven applications is a different
                  product from seven separate reviews. Only shown on the cross-run view, because a
                  single run's detail is about that run. */}
              {/* A portal batch is BY DEFINITION about several applications, so it has no place in a
                  popup scoped to one. Shown only on the review-everything view. */}
              {!applyRunDetail && !scope && applyGatePortals.length > 0 && (
                <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:14 }}>
                  {applyGatePortals.map(p => (
                    <div key={p.origin} style={{
                      border:`1px solid ${theme.border}`, borderRadius:8, padding:"10px 14px",
                      background:theme.surfaceHigh, display:"flex", alignItems:"center", gap:10 }}>
                      <span style={{ fontSize:9, fontWeight:700, padding:"1px 7px", borderRadius:999,
                                     background:"#dbeafe", color:"#1e40af", whiteSpace:"nowrap" }}>
                        {p.gateReasons?.includes("captcha_required") ? "verify" : "sign in"}
                      </span>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:12.5, fontWeight:700, color:theme.text,
                                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          Sign in to {p.host} once
                        </div>
                        <div style={{ fontSize:11, color:theme.textMuted }}>
                          {p.count} application{p.count === 1 ? "" : "s"} ready · reviewed one at a time
                        </div>
                      </div>
                      <span style={{ fontSize:18, fontWeight:800, color:theme.text }}>{p.count}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* The guard reads the SCOPED feeds, not the whole ones: a popup scoped to one
                  application whose questions and approvals belong to other jobs would otherwise
                  render nothing at all and say nothing about it. */}
              {modalApplications.length === 0 &&
               (applyRunDetail || (scopedQuestions.length === 0 && scopedPending.length === 0)) && (
                <div style={{ padding:"24px 0", textAlign:"center", color:theme.textMuted, fontSize:12 }}>
                  {applyRunDetail ? "No jobs in this run yet."
                    : scope ? `Nothing left to resolve on ${scope.label}.`
                    : "Nothing is waiting on you."}
                </div>
              )}

              {/* ── AC2: COMPANY → APPLICATION → PROBLEMS ────────────────────────────────────
                  The modal was a FLAT LIST OF PROBLEM-CARDS built from run-job rows. Two problems
                  on one job rendered as two entries; a dead posting for an unrelated job sat
                  between them wearing a "Review" pill and leading nowhere; and nothing on screen
                  said which application was which.

                  Requirement 1 says the modal must match the card summary, which already gets this
                  right — so the modal does not re-describe it. It renders the SAME
                  ApplicationObstacleCard the panel does, under the SAME CompanyHeading, grouped by
                  the SAME groupByApplication / groupByCompany. There is one renderer, so the two
                  surfaces cannot disagree about how many applications there are.

                  The per-ATTEMPT rows the modal used to show at the top level are not lost: they
                  are passed as children and sit behind each application's own disclosure. */}
              {modalCompanies.map(({ company, items }) => (
                <div key={`modal-${company}`} style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  <CompanyHeading company={company} count={items.length} theme={theme} />
                  {items.map(app => {
                    const packet = handoffPacketFor?.(app.primary?.row) || handoffPacketFor?.(app);
                    const resumable = !!packet && !packet.postingGone && !packet.stale && !app.postingGone;
                    const attemptsOpen = !!openAttempts[app.key];
                    return (
                      <ApplicationObstacleCard
                        key={app.key}
                        app={app}
                        theme={theme}
                        artifactUrl={artifactUrl}
                        packet={packet}
                        onRerun={rerunJob}
                        // Same wiring as the panel's cards, and for the same reason (AC1): the
                        // scoped handler, never the unscoped one. Inside a popup already scoped to
                        // this application it re-scopes to itself, which is a no-op — but a no-op
                        // is the correct behaviour, and reaching for `openEverything` here would
                        // reintroduce exactly the defect AC1 removed, one surface along.
                        onResolve={resumable ? () => openHandoff(packet, app) : openApplicationReview}
                        resolveLabel={resumable ? "Open & fill" : "Open"}
                        resolveTitle={resumable
                          ? `Opens the application in your own browser and fills it with the ${packet.answerCount} answer${packet.answerCount === 1 ? "" : "s"} we already resolved. You review and submit.`
                          : "Open this application's review — only this one"}
                        // AC2 requirement 2. The co-resolvable problems, lifted out and counted.
                        plan={planFor(app)}
                        onGroupAction={(item) => resolveGroup(item, app)}
                        // In the panel this opens the popup. Inside the popup there is nothing
                        // further to open, so it toggles the attempts — and says which it is.
                        detailsLabel={`${attemptsOpen ? "Hide" : "Show"} ${app.rows.length} attempt${app.rows.length === 1 ? "" : "s"}`}
                        onDetails={() => setOpenAttempts(o => ({ ...o, [app.key]: !o[app.key] }))}
                        onGenerateResume={app.primary?.row?.resumeAvailable ? null : generateResume}
                      >
                        {attemptsOpen && (
                          <div style={{ display:"flex", flexDirection:"column", gap:6,
                                        borderTop:`1px solid ${theme.border}`, paddingTop:8 }}>
                            <div style={{ fontSize:9, fontWeight:800, letterSpacing:"0.08em",
                                          textTransform:"uppercase", color:theme.textDim }}>
                              Every attempt at this application
                            </div>
                            {app.rows.map(row => (
                              <AttemptRow key={row.id} job={row} theme={theme}
                                artifactUrl={artifactUrl} packetFor={handoffPacketFor}
                                onHandoff={openHandoff} onRerun={rerunJob} />
                            ))}
                          </div>
                        )}
                      </ApplicationObstacleCard>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Logs section — run detail only */}
            {applyRunDetail?.logs?.length > 0 && (
              <details style={{ flexShrink:0, borderTop:`1px solid ${theme.border}` }}>
                <summary style={{
                  padding:"10px 20px", fontSize:11, fontWeight:700, cursor:"pointer",
                  color:theme.textMuted, textTransform:"uppercase", letterSpacing:"0.06em",
                  userSelect:"none", listStyle:"none",
                }}>
                  ▸ Logs ({applyRunDetail.logs.length})
                </summary>
                <div style={{
                  maxHeight:200, overflowY:"auto", padding:"8px 20px 12px",
                  fontFamily:"monospace", fontSize:10, display:"flex", flexDirection:"column", gap:3,
                }}>
                  {applyRunDetail.logs.map(log => (
                    <div key={log.id} style={{
                      color: log.level === "error" ? "#dc2626" : log.level === "warn" ? "#d97706" : theme.textMuted,
                    }}>
                      <span style={{ color:theme.textDim, marginRight:6 }}>
                        {log.createdAt ? new Date(log.createdAt).toLocaleTimeString() : ""}
                      </span>
                      <span style={{
                        color: log.level === "error" ? "#dc2626" : log.level === "warn" ? "#d97706" : theme.accent,
                        marginRight:6, fontWeight:700,
                      }}>
                        [{log.event || log.level}]
                      </span>
                      {/* Which application this line is about. Without it a run's log is a list of
                          statements like "7 fields filled" with no way to tell which job or site
                          produced them. */}
                      {(log.company || log.title || log.jobId) && (
                        <span style={{ color:theme.text, marginRight:6 }}>
                          {log.company || log.title || log.jobId}
                          {log.company && log.title ? ` — ${log.title}` : ""}
                          {":"}
                        </span>
                      )}
                      {log.message}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* Footer */}
            <div style={{
              padding:"12px 20px", borderTop:`1px solid ${theme.border}`, flexShrink:0,
              display:"flex", justifyContent:"flex-end",
            }}>
              <button
                onClick={() => closeReview()}
                style={{
                  padding:"8px 20px", borderRadius:4, fontWeight:700, fontSize:12,
                  background:"transparent", color:theme.textMuted,
                  border:`1.5px solid ${theme.border}`, cursor:"pointer",
                  fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.06em",
                  textTransform:"uppercase",
                }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default AutoApplyPanel;
