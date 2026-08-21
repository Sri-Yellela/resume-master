import { useTheme } from "../styles/theme.jsx";
import { useAutoApply } from "../contexts/AutoApplyContext.jsx";
import { Z } from "../styles/zLayers.js";

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
  const {
    applyQueue = [], applyQueueMsg,
    applyRuns = [], applyReviewJobs = [], applyGatePortals = [],
    applyRunDetailOpen, setApplyRunDetailOpen,
    applyRunDetail, setApplyRunDetail,
    applyReadiness,
    applyQuestions = [], applyQuestionMeta,
    questionDrafts, setQuestionDrafts,
    answersSaving, answersMsg,
    applyPending = [], pendingDetail, pendingBusy, pendingMsg,
    confirmApproveAll, setConfirmApproveAll,
    removeFromApplyQueue, loadApplyRunDetail,
    submitApplyAnswers, openPendingDetail, decidePending,
    artifactUrl, startApplyRun,
  } = useAutoApply();

  const nothingYet =
    !applyQueue.length && !applyQueueMsg && !applyRuns.length &&
    !applyReviewJobs.length && !applyPending.length && !applyQuestions.length;

  return (
    <div style={{ padding: "24px 20px", maxWidth: 1100, margin: "0 auto",
                  display: "flex", flexDirection: "column", gap: 16 }}>
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

          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap",
                        padding:"8px 10px", border:`1px solid ${theme.border}`,
                        background:theme.surfaceHigh, borderRadius:6 }}>
            <strong style={{ fontSize:12, color:theme.text }}>Auto Apply</strong>
            {applyQueue.map(job => (
              <span key={job.jobId} style={{ display:"inline-flex", alignItems:"center", gap:5,
                                             padding:"3px 7px", borderRadius:4,
                                             background:theme.surface, color:theme.text, fontSize:11 }}>
                {job.company || job.title}
                <button onClick={() => removeFromApplyQueue(job.jobId)}
                  style={{ border:"none", background:"transparent", color:theme.textDim, cursor:"pointer", padding:0 }}>x</button>
              </span>
            ))}
            {/* Automation tier, applied to the queue BEFORE the run starts.
                Requirement: full-auto must never be offered for `account` or `gated`. It is not —
                and not because of a check added here. The only action on this bar posts
                mode:"auto" with no approvalMode, which the server treats as approval-required, so
                every job in every queue already takes the fill-then-hold-for-a-human path. That
                IS the semi hand-off: the human authenticates once, the resolver fills the form,
                nothing is submitted without approval. There is no full-auto control to withhold.
                `gated` additionally cannot be completed at all — a CAPTCHA or identity check is
                not something to defeat, so it is named as the user's own job rather than
                attempted. What was missing was telling the user any of this before they queued,
                which is what this line does. */}
            {(() => {
              const needsAuth = applyQueue.filter(j => j.automationTier === "account");
              const cannotAuto = applyQueue.filter(j => j.automationTier === "gated");
              if (!needsAuth.length && !cannotAuto.length) return null;
              return (
                <span style={{ flexBasis:"100%", fontSize:11, color:theme.textMuted, lineHeight:1.6 }}>
                  {needsAuth.length > 0 && (
                    <>
                      <strong style={{ color:"#854d0e" }}>{needsAuth.length}</strong> of these need
                      you to sign in to the employer's account first — autofill fills the form once
                      you have.{" "}
                    </>
                  )}
                  {cannotAuto.length > 0 && (
                    <>
                      <strong style={{ color:"#991b1b" }}>{cannotAuto.length}</strong> sit behind a
                      CAPTCHA or identity check and cannot be automated at all; you will need to
                      apply to {cannotAuto.length === 1 ? "that one" : "those"} yourself.
                    </>
                  )}
                </span>
              );
            })()}
            {applyQueue.length > 0 && (
              <>
                {/* One action, because there is one behaviour. "Run Auto Apply" sat here alongside
                    this and posted the same request — mode:"auto" with no approvalMode, which the
                    server treats as approval-required — so it did not auto-apply, and a button that
                    claims applications were sent when they are waiting for you is worse than no
                    button. Full-auto is still reachable per run via approvalMode:"auto"; nothing in
                    this UI sends it, deliberately. */}
                <button onClick={() => startApplyRun("review")}
                  disabled={applyReadiness !== null && !applyReadiness.available}
                  title={applyReadiness && !applyReadiness.available
                    ? `Autofill unavailable: ${applyReadiness.reason}`
                    : "Fills each application and holds it for your approval. Nothing is submitted until you approve it."}
                  style={{ border:"none", borderRadius:6, padding:"6px 10px",
                           background: applyReadiness && !applyReadiness.available ? (theme.surfaceHigh || "#555") : theme.accent,
                           color:"#0f0f0f", fontWeight:800,
                           cursor: applyReadiness && !applyReadiness.available ? "not-allowed" : "pointer",
                           fontSize:12, opacity: applyReadiness && !applyReadiness.available ? 0.5 : 1 }}>
                  Autofill for Review
                </button>
                {applyReadiness && !applyReadiness.available && (
                  <span style={{ fontSize:11, color: theme.textDim || theme.textMuted }}>
                    Browser unavailable: {applyReadiness.reason}
                  </span>
                )}
              </>
            )}
            {applyQueueMsg && <span style={{ fontSize:11, color:theme.accentText }}>{applyQueueMsg}</span>}
            {/* Run status summary badges */}
            {applyRuns.slice(0, 3).map(run => (
              <button key={run.id} onClick={() => loadApplyRunDetail(run.id)}
                style={{ display:"inline-flex", alignItems:"center", gap:5, border:`1px solid ${theme.border}`,
                         borderRadius:4, padding:"3px 8px", background:theme.surface,
                         color:theme.text, cursor:"pointer", fontSize:11 }}>
                <span style={{ width:6, height:6, borderRadius:"50%", flexShrink:0, background:
                  run.status === "completed" ? "#16a34a" :
                  run.status === "running"  ? theme.accent :
                  run.status === "queued"   ? "#d97706" : "#6b7280" }}/>
                {run.submittedCount}✓
                {run.heldCount > 0 && <span style={{ color:"#d97706" }}> {run.heldCount} review</span>}
                {run.failedCount > 0 && <span style={{ color:"#dc2626" }}> {run.failedCount} failed</span>}
                <span style={{ color:theme.textDim }}>↗</span>
              </button>
            ))}
            {applyReviewJobs.length > 0 && !applyQueue.length && (
              <button onClick={() => setApplyRunDetailOpen(true)}
                style={{ border:`1px solid #d97706`, borderRadius:4, padding:"3px 8px",
                         background:"#fef3c7", color:"#92400e", cursor:"pointer", fontSize:11, fontWeight:700 }}>
                {applyReviewJobs.length} need review ↗
              </button>
            )}
            {/* Awaiting approval is the highest-stakes thing on this bar — these applications are
                filled and one click from a real employer — so it gets its own CTA and does not hide
                behind "need review". */}
            {applyPending.length > 0 && !applyQueue.length && (
              <button onClick={() => { setApplyRunDetail(null); setApplyRunDetailOpen(true); }}
                style={{ border:`1px solid #2563eb`, borderRadius:4, padding:"3px 8px",
                         background:"#dbeafe", color:"#1e3a8a", cursor:"pointer", fontSize:11, fontWeight:800 }}>
                {applyPending.length} awaiting your approval ↗
              </button>
            )}
            {/* Answering is the actionable thing, so it gets its own CTA rather than hiding behind
                "need review". Accented because a hold only clears once these are answered. */}
            {applyQuestions.length > 0 && !applyQueue.length && (
              <button onClick={() => { setApplyRunDetail(null); setApplyRunDetailOpen(true); }}
                style={{ border:`1px solid ${theme.accent}`, borderRadius:4, padding:"3px 8px",
                         background:theme.accent, color:"#0f0f0f", cursor:"pointer", fontSize:11, fontWeight:800 }}>
                Answer {applyQuestions.length} question{applyQuestions.length === 1 ? "" : "s"} ↗
              </button>
            )}
          </div>

      {/* ── Apply Runs Review Modal ──────────────────────────────────── */}
      {applyRunDetailOpen && (
        <div
          onClick={e => { if (e.target === e.currentTarget) { setApplyRunDetailOpen(false); setApplyRunDetail(null); } }}
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
                {applyRunDetail
                  ? `Apply Run #${applyRunDetail.run?.id} — ${applyRunDetail.run?.mode || "auto"}`
                  : "Jobs Needing Review"}
              </div>
              {applyRunDetail?.run && (
                <div style={{ display:"flex", gap:10, fontSize:11, flexWrap:"wrap" }}>
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
                onClick={() => { setApplyRunDetailOpen(false); setApplyRunDetail(null); }}
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
              {!applyRunDetail && applyPending.length > 0 && (
                <div style={{ border:"1px solid #2563eb", borderRadius:6, padding:"12px 14px",
                              background:theme.surfaceHigh, display:"flex", flexDirection:"column", gap:10 }}>
                  <div>
                    <div style={{ fontWeight:800, fontSize:13, color:theme.text }}>
                      {applyPending.length} application{applyPending.length === 1 ? "" : "s"} waiting on you
                    </div>
                    <div style={{ fontSize:11, color:theme.textMuted, marginTop:2 }}>
                      Filled and checked, but nothing has been sent. Read one before you approve it —
                      approving submits it to the employer and cannot be undone.
                    </div>
                  </div>

                  {applyPending.map(p => {
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
                          {p.screenshotAvailable && (
                            <a href={artifactUrl(p.runJobId, "screenshot")} target="_blank" rel="noreferrer"
                              style={{ ...btn(theme.surface, theme.text, theme.border), textDecoration:"none" }}>
                              Filled form ↗
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
                    {applyPending.length > 1 && (
                      confirmApproveAll ? (
                        <>
                          <span style={{ fontSize:11, color:"#dc2626", fontWeight:700 }}>
                            Send all {applyPending.length} to their employers?
                          </span>
                          <button onClick={() => decidePending(applyPending.map(p => p.runJobId), true)}
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
                          Approve all {applyPending.length}
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
              {!applyRunDetail && applyQuestions.length > 0 && (
                <div style={{ border:`1px solid ${theme.accent}`, borderRadius:6, padding:"12px 14px",
                              background:theme.surfaceHigh, display:"flex", flexDirection:"column", gap:10 }}>
                  <div>
                    <div style={{ fontWeight:800, fontSize:13, color:theme.text }}>
                      Answer {applyQuestions.length} question{applyQuestions.length === 1 ? "" : "s"}
                      {applyQuestionMeta.blockedJobs > 0 &&
                        ` to unblock ${applyQuestionMeta.blockedJobs} application${applyQuestionMeta.blockedJobs === 1 ? "" : "s"}`}
                    </div>
                    <div style={{ fontSize:11, color:theme.textMuted, marginTop:2 }}>
                      Nothing here was guessed on your behalf — these are the fields we would not fill without you.
                      {applyQuestionMeta.eligibilityCount > 0 &&
                        ` ${applyQuestionMeta.eligibilityCount} of them are attestations to the employer.`}
                    </div>
                  </div>

                  {applyQuestions.map(q => {
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
              {!applyRunDetail && applyGatePortals.length > 0 && (
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

              {(applyRunDetail ? applyRunDetail.jobs : applyReviewJobs).length === 0 &&
               (applyRunDetail || (applyQuestions.length === 0 && applyPending.length === 0)) && (
                <div style={{ padding:"24px 0", textAlign:"center", color:theme.textMuted, fontSize:12 }}>
                  No jobs in this run yet.
                </div>
              )}
              {(applyRunDetail ? applyRunDetail.jobs : applyReviewJobs).map(job => {
                // held_gate reads as "Sign in", not "Review" and not "Failed". The portal wants an
                // account or a CAPTCHA before it will take an application, so the next move is the
                // candidate's and it is a specific one — which is a different message from "check
                // these answers". Blue rather than amber for the same reason: nothing is wrong here.
                const statusColor = job.status === "submitted" ? "#16a34a"
                  : job.status === "held_review" ? "#d97706"
                  : job.status === "held_gate" ? "#2563eb"
                  : job.status === "failed" ? "#dc2626"
                  : job.status === "running" ? theme.accent
                  : theme.textMuted;
                const statusLabel = job.status === "submitted" ? "Submitted"
                  : job.status === "held_review" ? "Review"
                  : job.status === "held_gate" ? "Sign in"
                  : job.status === "failed" ? "Failed"
                  : job.status === "running" ? "Running"
                  : job.status === "queued" ? "Queued"
                  : job.status || "—";
                return (
                  <div key={job.id} style={{
                    border:`1px solid ${theme.border}`, borderRadius:6,
                    padding:"10px 14px", display:"flex", flexDirection:"column", gap:5,
                    background:theme.surfaceHigh,
                  }}>
                    {/* title / company / status */}
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
                      <div>
                        {/* Falls back to the job id: a posting expired by the 7-day cleanup leaves
                            the application behind, and a row identified by nothing at all is what
                            made this list unreadable. */}
                        <span style={{ fontWeight:700, fontSize:13, color:theme.text }}>
                          {job.title || job.jobId || "—"}
                        </span>
                        {job.company && (
                          <span style={{ fontSize:12, color:theme.textMuted, marginLeft:8 }}>{job.company}</span>
                        )}
                        {!job.title && job.jobId && (
                          <span style={{ fontSize:10, color:theme.textDim, marginLeft:8 }}>
                            (posting no longer on the board)
                          </span>
                        )}
                      </div>
                      <span style={{
                        fontSize:10, fontWeight:700, padding:"2px 8px",
                        borderRadius:999, background:`${statusColor}22`,
                        color:statusColor, whiteSpace:"nowrap", flexShrink:0,
                      }}>
                        {statusLabel}
                      </span>
                    </div>
                    {/* reason + ATS score */}
                    {(job.reasonCode || job.atsScore != null) && (
                      <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                        {job.reasonCode && (
                          <span style={{ fontSize:11, color:statusColor, fontWeight:600 }}>
                            {job.reasonCode.replace(/_/g, " ")}
                            {job.reasonDetail ? ` — ${job.reasonDetail}` : ""}
                          </span>
                        )}
                        {job.atsScore != null && (
                          <span style={{
                            fontSize:10, fontWeight:700, padding:"1px 6px", borderRadius:999,
                            background: job.atsScore >= 80 ? "#dcfce7" : job.atsScore >= 60 ? "#fef9c3" : "#fee2e2",
                            color: job.atsScore >= 80 ? "#166534" : job.atsScore >= 60 ? "#854d0e" : "#991b1b",
                          }}>
                            ATS {job.atsScore}
                          </span>
                        )}
                      </div>
                    )}
                    {/* timestamps */}
                    {(job.startedAt || job.finishedAt) && (
                      <div style={{ fontSize:10, color:theme.textDim }}>
                        {job.startedAt && `Started ${new Date(job.startedAt).toLocaleTimeString()}`}
                        {job.startedAt && job.finishedAt && " · "}
                        {job.finishedAt && `Finished ${new Date(job.finishedAt).toLocaleTimeString()}`}
                        {" · "}Attempts: {job.attemptCount || 1}
                      </div>
                    )}
                    {/* What was actually sent. The audit trail has recorded the resume artifact and
                        the end-of-attempt screenshot all along; nothing linked them, so there was
                        no way to tell whether a resume had even been generated. */}
                    <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
                      {job.resumeAvailable ? (
                        <a href={artifactUrl(job.id, "resume")} target="_blank" rel="noreferrer"
                          onClick={e => e.stopPropagation()}
                          style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:999,
                                   border:`1px solid ${theme.border}`, background:theme.surface,
                                   color:theme.text, textDecoration:"none", whiteSpace:"nowrap" }}>
                          Resume PDF ↗
                        </a>
                      ) : (
                        <span title="No resume artifact was recorded for this application."
                          style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:999,
                                   background:`${theme.border}55`, color:theme.textDim, whiteSpace:"nowrap" }}>
                          no resume generated
                        </span>
                      )}
                      {job.screenshotAvailable && (
                        <a href={artifactUrl(job.id, "screenshot")} target="_blank" rel="noreferrer"
                          onClick={e => e.stopPropagation()}
                          style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:999,
                                   border:`1px solid ${theme.border}`, background:theme.surface,
                                   color:theme.text, textDecoration:"none", whiteSpace:"nowrap" }}>
                          Filled form ↗
                        </a>
                      )}
                      {job.status === "submitted" && (
                        <span title={job.submitEvidence || ""}
                          style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:999,
                                   background: job.submitVerified ? "#16a34a22" : "#d9770622",
                                   color: job.submitVerified ? "#16a34a" : "#d97706", whiteSpace:"nowrap" }}>
                          {job.submitVerified ? "submission verified" : "unverified submit"}
                        </span>
                      )}
                    </div>
                    {/* apply URL */}
                    {job.applyUrl && (
                      <a href={job.applyUrl} target="_blank" rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        style={{ fontSize:10, color:theme.accent, textDecoration:"none", wordBreak:"break-all" }}>
                        {job.applyUrl.length > 90 ? job.applyUrl.slice(0, 90) + "…" : job.applyUrl}
                      </a>
                    )}
                  </div>
                );
              })}
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
                onClick={() => { setApplyRunDetailOpen(false); setApplyRunDetail(null); }}
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
