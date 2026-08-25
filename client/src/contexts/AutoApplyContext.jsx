import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { api, authContextQuery } from "../lib/api.js";
import { A_PLUS_TOOL, GENERATE_TOOL } from "../lib/applyTools.js";
// AD1: the outcome partition, shared with routes/apply.js so the sub-tab a request asks for and the
// group the server files a row under cannot disagree.
import { OUTCOME } from "../../../shared/applyOutcomeGroups.js";

// ============================================================
// AutoApplyContext — the auto-apply pipeline's whole state, lifted out of JobsPanel
// ============================================================
// The pipeline used to live inside JobsPanel and render as a strip above the postings. W5 moves the
// SURFACE to its own tab; this moves the STATE, because the tab is a sibling of the board, not a
// child, and two siblings cannot share component-local state.
//
// Everything here was moved VERBATIM out of JobsPanel — the same state, the same handlers, the same
// effects, the same requests in the same order. That is deliberate and is the point of the task:
// this is placement, not behaviour. The one thing that genuinely had to change is that the polling
// and loading effects now live above the board, which means they keep running while the user is on
// another tab — and they must, or a run started from the board would stop reporting the moment you
// navigated to look at it.
//
// The board keeps exactly one thing: addToApplyQueue, called by a job card. Everything else it used
// to own is here.
// ============================================================

const AutoApplyContext = createContext(null);

export function AutoApplyProvider({ user, canUseAPlusResume = false, children }) {
  const [applyQueue, setApplyQueue] = useState([]);
  const [applyRuns, setApplyRuns] = useState([]);
  const [applyReviewJobs, setApplyReviewJobs] = useState([]); // held_review items across all runs
  // Gated jobs, grouped by the portal you have to sign in to. One crossing releases the whole group,
  // which is a different offer from N separate reviews — see TASK G5.
  const [applyGatePortals, setApplyGatePortals] = useState([]);
  // ── The prepared packets themselves, per application (TASK AB1) ─────────────────────────────
  // Only the portal GROUPING was ever read. The individual packets were fetched and thrown away,
  // which was survivable while the only packets were gate crossings — a batch is all you need to
  // act on those. It stopped being survivable when held reviews started carrying packets too: a
  // held review is one application's obstacle, and the thing that resumes it is its OWN packet.
  const [applyHandoffPackets, setApplyHandoffPackets] = useState([]);
  // What the user is told after a handoff is started. The fill happens in ANOTHER TAB, by the
  // extension, so without this the click looks like it did nothing.
  const [handoffMsg, setHandoffMsg] = useState(null); // { kind, text }
  const [applyQueueMsg, setApplyQueueMsg] = useState("");
  const [applyRunDetailOpen, setApplyRunDetailOpen] = useState(false);
  const [applyRunDetail, setApplyRunDetail] = useState(null); // { run, jobs, logs }
  // ── WHAT THE REVIEW POPUP IS ABOUT (TASK AB3) ───────────────────────────────────────────────
  // Clicking Open on one row used to list the problems of EVERY application. Not because the popup
  // ignored a scope it had been given — it was never given one. openReview took no arguments, every
  // card passed the same bare function, and the modal rendered the full cross-run feeds. There was
  // no scoping concept anywhere in the path.
  //
  //   null            every application. The "Review all" control, which stays — but as a
  //                   deliberate, separate entry point rather than as what every row's Open does.
  //   { jobId, ... }  ONE application.
  const [applyReviewScope, setApplyReviewScope] = useState(null);
  const [applyReadiness, setApplyReadiness] = useState(null); // null=unknown, {available,reason}
  // Validation-correction loop. A held run used to be a dead end; these are the questions that would
  // turn it into a completion, deduplicated across jobs by GET /api/apply/questions.
  const [applyQuestions, setApplyQuestions] = useState([]);
  const [applyQuestionMeta, setApplyQuestionMeta] = useState({ eligibilityCount: 0, blockedJobs: 0 });
  const [questionDrafts, setQuestionDrafts] = useState({});   // question text -> answer
  const [answersSaving, setAnswersSaving] = useState(false);
  const [answersMsg, setAnswersMsg] = useState("");
  // Queue-then-approve. An auto run now fills the form, runs every gate and STOPS; these are the
  // applications waiting on a decision. Approving them submits to a real employer and cannot be
  // undone, which is why the detail view shows every answer with the rule that produced it.
  const [applyPending, setApplyPending] = useState([]);
  const [pendingDetail, setPendingDetail] = useState(null); // { runJobId, answers, resume, ... }
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingMsg, setPendingMsg] = useState("");
  const [confirmApproveAll, setConfirmApproveAll] = useState(false);
  // ── The cross-run feeds the obstacle-first panel is built on ────────────────────────────────
  // A run is an implementation detail, so the panel cannot be organised around one. These are every
  // application in flight / sent / stopped, whichever run produced it. `gated` was already returned
  // by GET /api/apply/runs and NOTHING read it — the individual gated jobs were invisible, only
  // their portal grouping was shown.
  const [applyInFlight, setApplyInFlight] = useState([]);
  const [applySubmitted, setApplySubmitted] = useState([]);
  const [applyStopped, setApplyStopped] = useState([]);
  const [applyGatedJobs, setApplyGatedJobs] = useState([]);
  // Missing apply prerequisites, read BEFORE queueing rather than discovered as a 409 afterwards.
  // The server has computed this all along (getMissingApplyPrerequisites) and the only way to see it
  // was to try to start a run and fail.
  const [applyPrereqMissing, setApplyPrereqMissing] = useState([]);

  const addToApplyQueue = useCallback((job) => {
    if (!job?.jobId) return;
    setApplyQueue(prev => prev.some(item => item.jobId === job.jobId) ? prev : [...prev, job]);
    setApplyQueueMsg(`${job.company || "Job"} queued for auto apply.`);
    setTimeout(() => setApplyQueueMsg(""), 3000);
  }, []);

  const removeFromApplyQueue = useCallback((jobId) => {
    setApplyQueue(prev => prev.filter(item => item.jobId !== jobId));
  }, []);

  const loadApplyRuns = useCallback(async () => {
    try {
      const data = await api("/api/apply/runs");
      setApplyRuns(Array.isArray(data.runs) ? data.runs : []);
      setApplyReviewJobs(Array.isArray(data.review) ? data.review : []);
      setApplyGatedJobs(Array.isArray(data.gated) ? data.gated : []);
      setApplyInFlight(Array.isArray(data.inFlight) ? data.inFlight : []);
      setApplySubmitted(Array.isArray(data.submitted) ? data.submitted : []);
      setApplyStopped(Array.isArray(data.stopped) ? data.stopped : []);
    } catch {}
    // Prerequisites, so "add your email address -> unblocks N applications" can be shown BEFORE the
    // user queues anything. Its own try: a failure here must not blank the pipeline.
    try {
      const st = await api("/api/integrations/status");
      setApplyPrereqMissing(Array.isArray(st?.apply?.missing) ? st.apply.missing : []);
    } catch { setApplyPrereqMissing([]); }
    // Separate call: the grouping lives with the packets, and a failure here must not blank the runs
    // list that the rest of this panel is built on.
    try {
      const gates = await api("/api/apply/gate-packets");
      setApplyGatePortals(Array.isArray(gates.portals) ? gates.portals : []);
      setApplyHandoffPackets(Array.isArray(gates.packets) ? gates.packets : []);
    } catch { setApplyGatePortals([]); setApplyHandoffPackets([]); }
  }, []);

  const loadApplyRunDetail = useCallback(async (runId) => {
    try {
      const data = await api(`/api/apply/runs/${runId}`);
      setApplyRunDetail(data);
      setApplyRunDetailOpen(true);
    } catch {}
  }, []);

  const loadApplyQuestions = useCallback(async () => {
    try {
      const data = await api("/api/apply/questions");
      const questions = Array.isArray(data.questions) ? data.questions : [];
      setApplyQuestions(questions);
      setApplyQuestionMeta({
        eligibilityCount: data.eligibilityCount || 0,
        blockedJobs: data.blockedJobs || 0,
      });
      // A low_confidence question is a CONFIRMATION, not a blank: the resolver already has a value it
      // was not confident enough to submit, so seed the field with it. Accepting it is the answer.
      setQuestionDrafts(prev => {
        const next = { ...prev };
        for (const q of questions) {
          if (next[q.question] === undefined) next[q.question] = q.proposed ?? "";
        }
        return next;
      });
    } catch {}
  }, []);

  /**
   * Save the drafted answers, optionally retrying whatever they unblock.
   *
   * retryJobIds is the union of every job the answered questions block; the SERVER decides which of
   * those are actually retryable (it only retries a job once every question blocking it is answered)
   * and reports the rest as `skipped`. Sending the union rather than guessing keeps that authority
   * in one place.
   */
  const submitApplyAnswers = useCallback(async (retry) => {
    const answers = {};
    for (const q of applyQuestions) {
      const v = questionDrafts[q.question];
      if (v !== undefined && String(v).trim() !== "") answers[q.question] = String(v).trim();
    }
    if (Object.keys(answers).length === 0) {
      setAnswersMsg("Answer at least one question first.");
      return;
    }
    const blocked = [...new Set(
      applyQuestions
        .filter(q => answers[q.question] !== undefined)
        .flatMap(q => (q.blocking || []).map(b => b.jobId))
    )];

    setAnswersSaving(true);
    setAnswersMsg("");
    try {
      const data = await api("/api/apply/answers", {
        method: "POST",
        body: JSON.stringify({
          answers,
          ...(retry ? { retryJobIds: blocked, mode: "auto" } : {}),
        }),
      });
      const saved = data.saved?.length || 0;
      const started = data.retry?.queued?.length || 0;
      setAnswersMsg(
        started
          ? `Saved ${saved} answer${saved === 1 ? "" : "s"} — retrying ${started} application${started === 1 ? "" : "s"}.`
          : `Saved ${saved} answer${saved === 1 ? "" : "s"}.` +
            (data.unblocked?.length ? ` ${data.unblocked.length} ready to retry.` : "")
      );
      await Promise.all([loadApplyQuestions(), loadApplyRuns()]);
    } catch (e) {
      // The answers are saved even when a retry is refused (cap spent, kill switch, run in flight),
      // so say so rather than implying the input was lost. api.js now surfaces the server's sentence.
      const stillSaved = e.payload?.saved?.length || 0;
      setAnswersMsg(
        (stillSaved ? `Saved ${stillSaved} answer${stillSaved === 1 ? "" : "s"}, but the retry did not start: ` : "") +
        (e.message || "Could not save answers.")
      );
      if (stillSaved) await Promise.all([loadApplyQuestions(), loadApplyRuns()]);
    } finally {
      setAnswersSaving(false);
    }
  }, [applyQuestions, questionDrafts, loadApplyQuestions, loadApplyRuns]);

  // ── Queue-then-approve ─────────────────────────────────────────────────────
  const loadApplyPending = useCallback(async () => {
    try {
      const data = await api("/api/apply/pending");
      setApplyPending(Array.isArray(data.pending) ? data.pending : []);
    } catch {}
  }, []);

  /**
   * The full record of one previewed application: every answer with the rule that produced it.
   * Loaded on demand rather than with the list — this is what you read before deciding, and the
   * list is only meant to tell you which ones need attention.
   */
  const openPendingDetail = useCallback(async (runJobId) => {
    if (pendingDetail?.runJobId === runJobId) { setPendingDetail(null); return; }
    setPendingDetail({ runJobId, loading: true });
    try {
      const data = await api(`/api/apply/run-jobs/${runJobId}/review`);
      setPendingDetail({ ...data, runJobId, loading: false });
    } catch (e) {
      setPendingDetail(null);
      setPendingMsg(e.message || "Could not load that application.");
    }
  }, [pendingDetail]);

  /**
   * Approve (submit) or reject the given applications.
   * Approving is the one irreversible action on this surface, so the outcome is always reported
   * from the server's reply rather than assumed — a refused run (cap, kill switch, another run in
   * flight) leaves the approval in place to retry, and the user needs to be told that, not shown a
   * success message for something that did not happen.
   */
  const decidePending = useCallback(async (runJobIds, approve) => {
    if (!runJobIds.length) return;
    setPendingBusy(true);
    setPendingMsg("");
    try {
      const data = await api(`/api/apply/${approve ? "approve" : "reject"}`, {
        method: "POST",
        body: JSON.stringify({ runJobIds }),
      });
      const n = (approve ? data.approved : data.rejected)?.length || 0;
      setPendingMsg(approve
        ? `Submitting ${n} application${n === 1 ? "" : "s"}.`
        : `Rejected ${n} application${n === 1 ? "" : "s"}. Nothing was sent.`);
      setPendingDetail(null);
      setConfirmApproveAll(false);
      await Promise.all([loadApplyPending(), loadApplyRuns()]);
    } catch (e) {
      setPendingMsg(e.message || (approve ? "Could not submit." : "Could not reject."));
      await loadApplyPending();
    } finally {
      setPendingBusy(false);
    }
  }, [loadApplyPending, loadApplyRuns]);

  // ── The held-review handoff (TASK AB1) ──────────────────────────────────────────────────────
  //
  // A held application's packet, found by run-job first and by job second. Two keys because they
  // answer different questions: a row in the panel IS a run-job, so that is the exact match; but a
  // job re-run after a hold produces a new run-job, and the packet prepared for the previous attempt
  // is still the one that can be resumed.
  const handoffPacketFor = useCallback((job) => {
    if (!job) return null;
    const fresh = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
    const byRunJob = applyHandoffPackets.filter(p => p.runJobId != null && p.runJobId === job.id);
    if (byRunJob.length) return byRunJob.sort(fresh)[0];
    const byJob = applyHandoffPackets.filter(p => String(p.jobId) === String(job.jobId));
    return byJob.length ? byJob.sort(fresh)[0] : null;
  }, [applyHandoffPackets]);

  /**
   * Resume a held application in the user's OWN browser.
   *
   * This is the whole of AB1's fix on the client, and it is deliberately not a link to a screenshot.
   * The filled DOM died with the Puppeteer context that produced it, so there is nothing to reopen;
   * what survives is the PACKET, and the extension can replay it into a live form under an activeTab
   * grant. So: open the real apply URL, and say what happens next — because the fill happens in
   * another tab, in another process, and a click that appears to do nothing reads as a broken button.
   *
   * The two states that cannot be resumed are refused HERE rather than opening a tab that will fail:
   *   postingGone  there is nothing to open. Requirement 6.
   *   stale        the answers have gone off. The server refuses the mint too (410 packet_stale);
   *                this is the same refusal said before the user has walked to another tab for it.
   */
  const openHandoff = useCallback((packet, job) => {
    const label = [job?.company, job?.title].filter(Boolean).join(" — ") || "This application";
    if (!packet) {
      setHandoffMsg({ kind: "no_packet", text:
        `${label} has no prepared answers to resume — it was held before the form was reached. Run it again to prepare them.` });
      return;
    }
    if (packet.postingGone) {
      setHandoffMsg({ kind: "gone", text:
        `The posting for ${label} is no longer on the board, so there is no form left to open. Nothing was lost — the record of the attempt stays here.` });
      return;
    }
    if (packet.stale) {
      const days = Math.floor((packet.ageMs || 0) / 86400000);
      setHandoffMsg({ kind: "stale", text:
        `${label} was prepared ${days} day${days === 1 ? "" : "s"} ago and the posting may have changed since. Run it again to prepare fresh answers rather than filling old ones.` });
      return;
    }
    let host = packet.expectedOrigin;
    try { host = new URL(packet.expectedOrigin).host; } catch {}
    window.open(packet.applyUrl, "_blank", "noopener,noreferrer");
    setHandoffMsg({ kind: "open", text:
      `Opened ${host} in a new tab. Click the Resume Master extension there and the form fills with the ` +
      `${packet.answerCount} answer${packet.answerCount === 1 ? "" : "s"} we prepared, each labelled with where it came from. ` +
      `You review it and you submit it — we never submit on that page.` });
  }, []);


  // ── TASK AC4: THE DATED RUN HISTORY, LOADED ON DEMAND ───────────────────────────────────────
  //
  // REQUIREMENT 2 IS THE CONSTRAINT THIS STATE IS SHAPED AROUND: "ON DEMAND, NOT PRELOADED — this is
  // explicit. Nothing loads until a date is selected. The panel's initial render issues no history
  // query."
  //
  // So there is deliberately NO effect here. Every other feed in this file is loaded by a
  // useEffect on `user` — that is what makes the panel work when you open it, and it is exactly
  // what must not happen for the history. `historyDate` starts null, `history` starts null, and the
  // only thing that fills them is loadHistory(), which nothing calls until the user picks a date.
  //
  // `null` vs `{ ... }` is a real distinction and both are rendered differently: null is "you have
  // not asked yet", an empty payload is "nothing happened on that day" (requirement 6). Collapsing
  // them into one falsy state is how "no applications on this date" becomes a permanent spinner.
  //
  // ── TASK AH6: WHICH DAY, WORKED OUT RATHER THAN ASKED FOR ─────────────────────────────────
  //
  // AD1's inversion was right that the panel must not silently ship a day's applications you never
  // asked for. It was wrong about what to do instead: it opened on a blank board with "pick a
  // date", and the commonest reason to open Auto Apply is to see what happened on the last run —
  // which is almost never today. The panel was making the reader answer a question it could
  // answer itself.
  //
  // So the mount asks ONE cheap question — what is the date of your most recent activity — and it
  // returns a DATE, not a listing. If there is one, that day is selected and loaded through the
  // ordinary loadHistory path, so there is still exactly one way a day's rows arrive. If there is
  // none, AD1's resting state is exactly right and is what still renders: a user with no runs has
  // no most-recent day, and inventing today for them would be the empty board all over again.
  //
  // `historyAuto` records that the panel chose the date rather than the user. The control row reads
  // it to say WHY this day is on screen, which is the difference between a default and a surprise.
  const [historyAuto, setHistoryAuto] = useState(false);

  // ── TASK AD1: THE SUB-TAB IS PART OF THE QUERY ────────────────────────────────────────────
  //
  // AD1 turns the three outcome groups into sub-tabs and makes the rule explicit: "Switching
  // sub-tabs with a date selected refetches for that tab; it must not load all three." So the
  // active group lives beside the active date and both are sent — a tab switch is a fetch, and a
  // fetch is for exactly one group.
  //
  // PENDING IS THE DEFAULT (requirement 5). It is the only tab where anything is waiting on a
  // human, and burying it behind COMPLETED would repeat the mistake AB4 fixed by putting NEEDS
  // REVIEW first. Note that defaulting the TAB costs nothing at render: no date is selected, so
  // there is still no query — requirement 3 is about what is fetched, not about what is selected.
  const [historyDate, setHistoryDate] = useState(null);   // "YYYY-MM-DD", or null before any pick
  const [historyGroup, setHistoryGroup] = useState(OUTCOME.PENDING);
  const [history, setHistory] = useState(null);           // the payload, or null before any pick
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyMsg, setHistoryMsg] = useState("");
  const [historyMarkers, setHistoryMarkers] = useState({}); // "YYYY-MM-DD" -> count
  const [historyBusyId, setHistoryBusyId] = useState(null); // the run-job an action is running on

  // The browser's own offset, sent with every history request. Without it the server's day boundary
  // is UTC's, and an application queued at 8pm in Boston lands on the next day — so the user picks
  // the date they remember and is told nothing happened. Read per call rather than once: a laptop
  // can cross a timezone, or DST, between one query and the next.
  const tzOffset = () => new Date().getTimezoneOffset();

  /**
   * One day's applications, for ONE outcome group. The ONLY thing that populates the history.
   *
   * @param {string} date  "YYYY-MM-DD"
   * @param {string} [group] one of OUTCOME; defaults to whichever sub-tab is active
   */
  const loadHistory = useCallback(async (date, group, { auto = false } = {}) => {
    const wanted = group || historyGroup;
    if (group) setHistoryGroup(group);
    // AH6: the "your most recent activity" label describes a choice the PANEL made. The moment the
    // user picks a day themselves it stops being true, so the flag is cleared on every load that
    // did not come from the mount.
    setHistoryAuto(auto);
    if (!date) { setHistoryDate(null); setHistory(null); setHistoryMsg(""); return; }
    setHistoryDate(date);
    setHistoryLoading(true);
    setHistoryMsg("");
    try {
      // ONE group's rows. `counts` comes back for all three so the sub-tab numbers are right
      // without fetching the other two tabs' contents — see the endpoint for why that aggregate is
      // not the same thing as loading all three.
      const data = await api(
        `/api/apply/history?date=${encodeURIComponent(date)}&group=${encodeURIComponent(wanted)}&tzOffset=${tzOffset()}`);
      setHistory(data);
    } catch (e) {
      // The date stays selected on a failure. Clearing it would bounce the user back to "pick a
      // date" and lose what they asked for, which reads as the click having done nothing.
      setHistory(null);
      setHistoryMsg(e.message || "Could not load that date.");
    } finally {
      setHistoryLoading(false);
    }
  }, [historyGroup]);

  /**
   * AH6: open on the day something last happened.
   *
   * ONE request, and it returns a date rather than a listing — so the thing AD1 forbade (shipping a
   * day's applications nobody asked for) still cannot happen by accident, and the thing it cost
   * (landing on a blank board) does not.
   *
   * Runs once per signed-in user, and only while nothing is selected: a remount that already has a
   * date must not drag the reader back to the most recent day they were not looking at.
   */
  const bootstrappedFor = useRef(null);
  // The live value of historyDate, for the async bootstrap to read without re-running on it.
  const historyDateRef = useRef(null);
  useEffect(() => { historyDateRef.current = historyDate; }, [historyDate]);
  useEffect(() => {
    if (!user?.id) return;
    if (bootstrappedFor.current === user.id) return;
    bootstrappedFor.current = user.id;
    let cancelled = false;
    (async () => {
      try {
        const { date } = await api(`/api/apply/history/latest?tzOffset=${tzOffset()}`);
        // No runs at all: AD1's resting state is the right answer and is left exactly as it was.
        // Inventing today for a user with no history is the blank board with extra steps.
        if (cancelled || !date) return;
        // A date the USER picked while this was in flight outranks the one it was about to choose
        // for them. Read through a ref rather than a state updater: an updater that calls
        // loadHistory is not pure, and React double-invokes updaters in development.
        if (historyDateRef.current) return;
        loadHistory(date, undefined, { auto: true });
      } catch { /* the panel still works; it just opens on the resting state */ }
    })();
    return () => { cancelled = true; };
  }, [user?.id, loadHistory]);

  /**
   * Switch sub-tab (AD1 requirement 3).
   *
   * With a date selected this refetches THAT tab and nothing else. With no date selected it changes
   * the selection and issues no request at all — which is requirement 3's other half: the calendar
   * is primary navigation, so a tab with no date behind it has nothing to show and nothing to ask
   * for. Clearing `history` on the switch is deliberate: leaving the previous tab's rows on screen
   * under a new heading is worse than an honest empty state for the few hundred milliseconds the
   * refetch takes.
   */
  const selectHistoryGroup = useCallback((group) => {
    setHistoryGroup(group);
    if (historyDate) loadHistory(historyDate, group);
    else setHistory(null);
  }, [historyDate, loadHistory]);

  /**
   * Which days in a month have anything on them (requirement 7).
   *
   * CALLED WHEN THE CALENDAR IS OPENED, never on mount — that is what keeps it inside requirement 2,
   * whose words are "the panel's initial render issues no history query". Opening the picker is an
   * action the user took. It is a count-per-day aggregate over one month, no rows and no joins, so
   * it is cheap in a way that fetching the month's runs would not be.
   *
   * THE TRADEOFF, for the owner: if no query at all before a date is picked is preferred, deleting
   * the two loadHistoryMonth calls in AutoApplyPanel removes it entirely and leaves the picker
   * working — blind, but working. Nothing else depends on the markers.
   */
  const loadHistoryMonth = useCallback(async (month) => {
    if (!month) return;
    try {
      const data = await api(`/api/apply/history/months/${encodeURIComponent(month)}?tzOffset=${tzOffset()}`);
      // Merged rather than replaced, so paging back and forth does not re-clear months already
      // fetched and make the dots flicker.
      setHistoryMarkers(prev => ({ ...prev, ...(data.days || {}) }));
    } catch { /* markers are a convenience; failing to get them must not break the picker */ }
  }, []);

  /**
   * ABORT one pending application (requirement 4).
   *
   * The server does the work and owns the decision — including refusing an abort that lost its race
   * with a submit, which comes back 409 with the status it actually reached. That refusal is
   * SURFACED rather than swallowed: telling a candidate their application was stopped when it is at
   * that moment in an employer's inbox is the worst thing this surface could do.
   */
  const abortRunJob = useCallback(async (runJobId) => {
    // AD1: ONE ID OR MANY, and the reason is the company -> application tier the listing now uses.
    // A grouped application is every attempt at one posting, and several of those attempts can be
    // abortable at once — a job held in run 7 and held again in run 8 is two live PENDING rows.
    // Stopping only the newest would leave the application sitting in PENDING having been told it
    // was stopped, which is the worst thing this surface can say. One reload and one message for
    // the whole application, because "stop this application" is one act to the person doing it.
    const ids = Array.isArray(runJobId) ? runJobId : [runJobId];
    if (!ids.length) return;
    setHistoryBusyId(ids[0]);
    setHistoryMsg("");
    try {
      for (const id of ids) await api(`/api/apply/run-jobs/${id}/abort`, { method: "POST" });
      // Both surfaces: the row leaves PENDING in the history, and it leaves the panel's own feeds.
      await Promise.all([loadHistory(historyDate), loadApplyRuns(), loadApplyPending()]);
      // AFTER the reload, not before. loadHistory clears historyMsg on entry — so setting the
      // confirmation first wiped it a few hundred milliseconds later, and the one sentence the user
      // most needs to read after stopping an application ("nothing was submitted") flashed and went.
      setHistoryMsg("Stopped. Nothing was submitted, and the prepared answers were voided.");
    } catch (e) {
      setHistoryMsg(e.message || "Could not stop that application.");
      await loadHistory(historyDate);
    } finally {
      setHistoryBusyId(null);
    }
  }, [historyDate, loadHistory, loadApplyRuns, loadApplyPending]);

  /**
   * REMOVE one application from the user's view (requirement 4's delete).
   *
   * A SOFT HIDE, and the copy says so rather than implying an erasure that did not happen — the
   * server never hard-deletes, because a submitted application is evidence that reached a real
   * employer and that record is what the candidate needs when an interview lands.
   */
  const hideRunJob = useCallback(async (runJobId) => {
    // One id or many, for the same reason as abortRunJob above — and here it is load-bearing for
    // AD1's "soft-delete hides a row and it does not return on refetch": hiding only the newest
    // attempt leaves the application's older attempts in the feed, so the row the user removed
    // reappears on the next fetch wearing an earlier attempt's face.
    const ids = Array.isArray(runJobId) ? runJobId : [runJobId];
    if (!ids.length) return;
    setHistoryBusyId(ids[0]);
    setHistoryMsg("");
    try {
      const results = [];
      for (const id of ids) results.push(await api(`/api/apply/run-jobs/${id}`, { method: "DELETE" }));
      const r = { abortedFirst: results.some(x => x?.abortedFirst) };
      await Promise.all([loadHistory(historyDate), loadApplyRuns(), loadApplyPending()]);
      // After the reload, for the same reason as abortRunJob above.
      setHistoryMsg(r.abortedFirst
        ? "Stopped and removed from your history. Nothing was submitted."
        : "Removed from your history. The record is kept — nothing that reached an employer is erased.");
    } catch (e) {
      setHistoryMsg(e.message || "Could not remove that application.");
    } finally {
      setHistoryBusyId(null);
    }
  }, [historyDate, loadHistory, loadApplyRuns, loadApplyPending]);

  // The resume and screenshot are served as files, so they cannot carry the auth header api() adds.
  // authContextQuery is the query-param form of the same token, which requireAuth also honours
  // (server.js: `req.query?.authContext`) — the mechanism useSyncEvents already relies on for SSE.
  const artifactUrl = useCallback((runJobId, kind) => {
    const qs = authContextQuery();
    return `/api/apply/run-jobs/${runJobId}/${kind}${qs ? `?${qs}` : ""}`;
  }, []);

  useEffect(() => {
    if (user) { loadApplyRuns(); loadApplyQuestions(); loadApplyPending(); }
  }, [user, loadApplyRuns, loadApplyQuestions, loadApplyPending]);

  // A run does its work in the background, and nothing refreshed this panel — so progress and the
  // final result never appeared until the page was reloaded, which read as "it did nothing".
  // Polls only while a run is actually in flight, and stops as soon as none are, so an idle board
  // costs no requests.
  const runInFlight = applyRuns.some(r => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!user || !runInFlight) return;
    const id = setInterval(() => {
      loadApplyRuns();
      loadApplyPending();
      // The open run-detail modal is a snapshot; refresh it too or it freezes mid-run.
      if (applyRunDetailOpen && applyRunDetail?.run?.id) loadApplyRunDetail(applyRunDetail.run.id);
    }, 4000);
    return () => clearInterval(id);
  }, [user, runInFlight, applyRunDetailOpen, applyRunDetail?.run?.id,
      loadApplyRuns, loadApplyPending, loadApplyRunDetail]);

  useEffect(() => {
    if (!user) return;
    api("/api/apply/readiness").then(d => setApplyReadiness(d)).catch(() => setApplyReadiness({ available: false, reason: "probe_error" }));
  }, [user]);

  /**
   * @param intent "review" — fill, run every gate, stop before submitting, and park each
   *                          application for a human decision (the approval flow).
   *               "auto"   — the same today: mode:"auto" without approvalMode means the server
   *                          defaults to approval-required. Full-auto is opt-in per run via
   *                          approvalMode:"auto", which nothing in this UI sends.
   *
   * "review" replaces the old mode:"manual" (semi) path. Semi's promise — a visible browser you
   * review the filled form in and submit from — cannot be kept in production: applyAutomation
   * launches headless whenever the host is not Windows, so on Railway the form is filled in an
   * invisible container browser and the link here points at an untouched apply URL. The approval
   * flow keeps the same promise in a way that works remotely: the server fills and verifies, then
   * shows every resolved answer with its provenance, the resume PDF and a screenshot of the filled
   * form, and submits only when you approve.
   */
  const startApplyRun = useCallback(async (intent = "auto") => {
    if (!applyQueue.length) return;
    // Both paths post mode:"auto" and omit approvalMode, so the server's approval-required default
    // applies. They are deliberately the same request today — see the note above.
    const mode = intent === "review" ? "auto" : intent;
    try {
      const data = await api("/api/apply/runs", {
        method: "POST",
        body: JSON.stringify({ jobIds: applyQueue.map(job => job.jobId), mode, tool: canUseAPlusResume ? A_PLUS_TOOL : GENERATE_TOOL }),
      });
      setApplyQueue([]);
      const n = data.queued?.length || 0;
      setApplyQueueMsg(
        `${n} job${n === 1 ? "" : "s"} queued — nothing is sent until you approve each one.`,
      );
      loadApplyRuns();
    } catch(e) {
      const missing = e.payload?.missingPrerequisites;
      setApplyQueueMsg(missing?.length
        ? `Setup needed in Integrations: ${missing.join(", ")}.`
        : (e.message || "Could not start apply run."));
    }
  }, [applyQueue, canUseAPlusResume, loadApplyRuns]);

  // Ordered least-to-most current: a job that was stopped and has been re-queued should read as
  // queued, not stopped.
  const applyStateByJobId = useMemo(() => {
    const map = {};
    for (const list of [applyStopped, applySubmitted, applyReviewJobs, applyGatedJobs, applyInFlight]) {
      for (const j of list) if (j?.jobId) map[j.jobId] = { status: j.status, reasonCode: j.reasonCode };
    }
    return map;
  }, [applyStopped, applySubmitted, applyReviewJobs, applyGatedJobs, applyInFlight]);

  return (
    <AutoApplyContext.Provider value={{
      applyQueue, setApplyQueue,
      applyRuns, applyReviewJobs, applyGatePortals,
      applyHandoffPackets, handoffPacketFor, openHandoff, handoffMsg, setHandoffMsg,
      applyInFlight, applySubmitted, applyStopped, applyGatedJobs,
      applyPrereqMissing,
      // ── The board's own view of the pipeline ────────────────────────────────────────────────
      // The board and the pipeline were separate worlds: a card gave no hint that you had already
      // applied to it, queued it, or that it was stuck waiting on you. This is the join, done here
      // from feeds already loaded rather than by widening GET /api/jobs — so it costs no request.
      // Later feeds win, which is the right precedence: what a job is DOING now outranks what it
      // last finished as.
      applyStateByJobId,
      applyQueueMsg, setApplyQueueMsg,
      applyRunDetailOpen, setApplyRunDetailOpen,
      applyRunDetail, setApplyRunDetail,
      applyReviewScope, setApplyReviewScope,
      applyReadiness,
      applyQuestions, applyQuestionMeta,
      questionDrafts, setQuestionDrafts,
      answersSaving, answersMsg,
      applyPending, pendingDetail, pendingBusy, pendingMsg,
      confirmApproveAll, setConfirmApproveAll,
      addToApplyQueue, removeFromApplyQueue,
      loadApplyRuns, loadApplyRunDetail, loadApplyQuestions, loadApplyPending,
      submitApplyAnswers, openPendingDetail, decidePending,
      artifactUrl, runInFlight, startApplyRun,
      // AC4: the dated run history. Deliberately no loader effect anywhere above — nothing here is
      // populated until loadHistory is called with a date the user picked.
      // AD1: `historyGroup` is the active SUB-TAB, and selectHistoryGroup is the only way to change
      // it — so a tab switch is always one refetch of one group, never three.
      historyDate, historyGroup, history, historyLoading, historyMsg, setHistoryMsg,
      // AH6: true when the PANEL chose this day, so the control row can say why it is on screen.
      historyAuto,
      historyMarkers, historyBusyId,
      loadHistory, selectHistoryGroup, loadHistoryMonth, abortRunJob, hideRunJob,
      // The single number the JOBS-adjacent chrome needs: how many things are waiting on a human.
      // A review queue nobody sees is worse than a cluttered board, so this is what puts a count on
      // the AUTO APPLY tab. Summed here rather than in the tab so the badge and the panel can never
      // disagree about what "needs attention" means.
      needsAttentionCount: applyPending.length + applyReviewJobs.length + applyQuestions.length,
    }}>
      {children}
    </AutoApplyContext.Provider>
  );
}

export function useAutoApply() {
  return useContext(AutoApplyContext) || {};
}
