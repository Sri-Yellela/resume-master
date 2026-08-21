import { createContext, useContext, useState, useEffect, useCallback } from "react";
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
    } catch {}
    // Separate call: the grouping lives with the packets, and a failure here must not blank the runs
    // list that the rest of this panel is built on.
    try {
      const gates = await api("/api/apply/gate-packets");
      setApplyGatePortals(Array.isArray(gates.portals) ? gates.portals : []);
    } catch { setApplyGatePortals([]); }
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

  return (
    <AutoApplyContext.Provider value={{
      applyQueue, setApplyQueue,
      applyRuns, applyReviewJobs, applyGatePortals,
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
