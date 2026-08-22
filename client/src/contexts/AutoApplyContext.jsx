import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import { api, authContextQuery } from "../lib/api.js";
import { A_PLUS_TOOL, GENERATE_TOOL } from "../lib/applyTools.js";

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
