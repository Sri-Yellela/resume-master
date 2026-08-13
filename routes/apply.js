import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { autoApply } from "../services/applyAutomation.js";
import { probeBrowserAvailability } from "../services/browserLauncher.js";
import { detectPlatformFromUrl } from "../services/platformDetector.js";
import { getAutomationReadiness, getMissingApplyPrerequisites } from "../services/integrationReadiness.js";
import { canUseAPlusResume, normalisePlanTier } from "../services/entitlements.js";

// Must match services/applyAutomation.js SCREENSHOT_DIR — screenshot_path rows are absolute paths
// written by takeScreenshot(), and this is the only directory they are ever allowed to resolve into.
const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "screenshots");

function publicApplication(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    jobId: row.job_id,
    company: row.company,
    role: row.role,
    jobUrl: row.job_url,
    source: row.source,
    location: row.location,
    applyMode: row.apply_mode,
    resumeFile: row.resume_file,
    appliedAt: row.applied_at,
    notes: row.notes,
    status: row.auto_status || "manual",
  };
}

export default function applyRoutes(app, db, requireAuth, buildAutofillPayload, generateResumeForApply, htmlToPdf, generateCoverLetterForApply) {
  // ── Manual tracking endpoints ────────────────────────────────────────────────

  app.post("/api/apply", requireAuth, (req, res) =>
    withIdempotency("/api/apply", req, res, (out) => {
    const {
      jobId,
      jobUrl,
      company = null,
      role = null,
      source = "manual",
      location = null,
      resumeFile = null,
      notes = null,
    } = req.body || {};

    if (!jobId && !jobUrl) {
      return out.status(400).json({ error: "jobId or jobUrl required" });
    }

    const resolvedJobId = String(jobId || `manual_${Date.now()}`);
    const resolvedJobUrl = String(jobUrl || "");
    const existingJob = jobId
      ? db.prepare("SELECT company, title, url, apply_url, source, location FROM scraped_jobs WHERE job_id=?").get(String(jobId))
      : null;

    db.prepare(`
      INSERT INTO job_applications
        (user_id, job_id, company, role, job_url, source, location, apply_mode, resume_file, applied_at, notes, auto_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?, unixepoch(), ?, 'manual')
      ON CONFLICT(user_id, job_id) DO UPDATE SET
        company=excluded.company,
        role=excluded.role,
        job_url=excluded.job_url,
        source=excluded.source,
        location=excluded.location,
        apply_mode='MANUAL',
        resume_file=excluded.resume_file,
        applied_at=excluded.applied_at,
        notes=excluded.notes,
        auto_status='manual'
    `).run(
      req.user.id,
      resolvedJobId,
      company || existingJob?.company || null,
      role || existingJob?.title || null,
      resolvedJobUrl || existingJob?.apply_url || existingJob?.url || null,
      source || existingJob?.source || "manual",
      location || existingJob?.location || null,
      resumeFile,
      notes,
    );

    if (jobId) {
      const profileId = db.prepare("SELECT id FROM domain_profiles WHERE user_id=? AND is_active=1 ORDER BY id DESC LIMIT 1")
        .get(req.user.id)?.id || null;
      db.prepare(`
        INSERT INTO user_jobs (user_id, job_id, domain_profile_id, applied, updated_at)
        VALUES (?, ?, ?, 1, unixepoch())
        ON CONFLICT(user_id, job_id) DO UPDATE SET applied = 1, updated_at = unixepoch()
      `).run(req.user.id, resolvedJobId, profileId);
    }

    const row = db.prepare("SELECT * FROM job_applications WHERE user_id=? AND job_id=?")
      .get(req.user.id, resolvedJobId);
    out.json({ ok: true, application: publicApplication(row) });
  }));

  app.get("/api/apply/status/:jobId", requireAuth, (req, res) => {
    const row = db.prepare("SELECT * FROM job_applications WHERE user_id=? AND job_id=?")
      .get(req.user.id, String(req.params.jobId));
    res.json({
      status: row ? "applied" : "idle",
      application: publicApplication(row),
    });
  });

  app.get("/api/apply/applications", requireAuth, (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM job_applications
      WHERE user_id=?
      ORDER BY applied_at DESC, id DESC
      LIMIT 100
    `).all(req.user.id);
    res.json({ applications: rows.map(publicApplication) });
  });

  // ── Queue infrastructure ─────────────────────────────────────────────────────

  // ── Submit guards (TASK A3) ──────────────────────────────────────────────────
  // This pipeline submits real applications under a real candidate's name and a submission cannot
  // be recalled, so every limit here is configurable and every rejection is explicit.
  const envInt = (name, dflt) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  };
  const APPLY_WORKER_LIMIT   = envInt("APPLY_WORKER_LIMIT", 2);
  const APPLY_DAILY_CAP      = envInt("APPLY_DAILY_CAP", 25);
  const APPLY_MAX_ACTIVE_RUNS = envInt("APPLY_MAX_ACTIVE_RUNS_PER_USER", 1);
  const ATS_AUTO_APPLY_THRESHOLD = 65;
  let activeWorkers = 0;

  const getSetting = (key) => {
    try { return db.prepare("SELECT value FROM app_settings WHERE key=?").get(key)?.value ?? null; }
    catch { return null; }   // table absent on an un-migrated DB: fall through to env
  };
  const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());

  /**
   * KILL SWITCH (requirement 4). Blocks all full-auto submission; semi mode keeps working.
   * The DB row wins so it can be flipped with no restart and no deploy; the env var is the
   * boot-level default. Read at request time — never cached — which is the whole point.
   */
  function fullAutoDisabled() {
    const row = getSetting("apply_full_auto_disabled");
    if (row !== null) return truthy(row);
    return truthy(process.env.APPLY_FULL_AUTO_DISABLED);
  }

  /** Applications actually submitted for this user in the trailing 24h. */
  function submittedLast24h(userId) {
    try {
      return db.prepare(`
        SELECT COUNT(*) AS n FROM apply_run_jobs
        WHERE user_id=? AND status='submitted' AND COALESCE(finished_at, 0) >= unixepoch() - 86400
      `).get(userId).n;
    } catch { return 0; }
  }

  function activeRunCount(userId) {
    try {
      return db.prepare(`
        SELECT COUNT(*) AS n FROM apply_runs WHERE user_id=? AND status IN ('queued','running')
      `).get(userId).n;
    } catch { return 0; }
  }

  // ── Idempotency (requirement 1) ──────────────────────────────────────────────
  // A retry storm must not become duplicate applications to the same employer: duplicates are
  // worse than none. Keyed per user, NOT per endpoint — a key reused against a different endpoint
  // is surfaced as a 409 rather than silently answered with the wrong body.
  function priorResponse(userId, key, endpoint) {
    if (!key) return null;
    try {
      const row = db.prepare(
        "SELECT endpoint, status_code, response_json FROM apply_idempotency WHERE user_id=? AND idem_key=?"
      ).get(userId, key);
      if (!row) return null;
      if (row.endpoint !== endpoint) return { conflict: row.endpoint };
      return { statusCode: row.status_code, body: JSON.parse(row.response_json) };
    } catch { return null; }
  }

  function recordResponse(userId, key, endpoint, statusCode, body) {
    if (!key) return;
    try {
      db.prepare(`
        INSERT OR IGNORE INTO apply_idempotency (user_id, idem_key, endpoint, status_code, response_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, key, endpoint, statusCode, JSON.stringify(body));
    } catch (e) {
      console.warn("[applyRoutes] idempotency record failed:", e.message);
    }
  }

  /**
   * Wraps a synchronous POST handler with replay protection. Handlers stay synchronous up to the
   * point they respond, so no interleaving is possible between the lookup and the record.
   */
  function withIdempotency(endpoint, req, res, handler) {
    const key = String(req.get("Idempotency-Key") || "").trim().slice(0, 200);
    const prior = priorResponse(req.user.id, key, endpoint);
    if (prior?.conflict) {
      return res.status(409).json({
        error: "Idempotency-Key was already used for a different endpoint",
        usedFor: prior.conflict,
      });
    }
    if (prior) return res.status(prior.statusCode).json({ ...prior.body, idempotentReplay: true });

    let sent = null;
    const capture = {
      status(code) { this._code = code; return this; },
      json(body) { sent = { code: this._code || 200, body }; return this; },
    };
    handler(capture);
    if (!sent) return;
    // Only a success is replayable. Replaying a 4xx would pin a transient rejection (a cap that
    // has since reset) as this key's permanent answer.
    if (sent.code >= 200 && sent.code < 300) recordResponse(req.user.id, key, endpoint, sent.code, sent.body);
    return res.status(sent.code).json(sent.body);
  }

  const BROWSER_FAILURE_CODES = [
    "browser_runtime_missing_dependency",
    "browser_binary_not_found",
    "browser_launch_failed",
  ];
  const isBrowserFailure = (reasonCode) => BROWSER_FAILURE_CODES.includes(reasonCode);

  function logEvent(runId, runJobId, userId, jobId, event, message, details = null) {
    try {
      db.prepare(`
        INSERT INTO apply_job_logs (run_id, run_job_id, user_id, job_id, event, message, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(runId, runJobId, userId, String(jobId), event, message, details ? JSON.stringify(details) : null);
    } catch (e) {
      console.warn("[applyRoutes] logEvent error:", e.message);
    }
  }

  // ── Audit persistence ────────────────────────────────────────────────────────
  // These seven were written by ONE UPDATE inside ONE try/catch, so a single missing column — an
  // un-migrated deployment, or a stale fixture — threw and silently discarded EVERY audit field
  // while the run still reported success. The columns are resolved against the live schema instead,
  // so a missing one costs only itself; it is named once per process; and the facts are written to
  // apply_job_logs as well, so the record survives even if no column exists at all.
  const AUDIT_COLUMNS = [
    "answers_json", "resume_artifact_id", "resume_ats_score",
    "screenshot_path", "submit_verified", "submit_evidence", "open_questions_json",
  ];
  let auditColumnsCache = null;

  function auditColumns() {
    if (auditColumnsCache) return auditColumnsCache;
    let present = [];
    try {
      const live = new Set(db.prepare("PRAGMA table_info(apply_run_jobs)").all().map(c => c.name));
      present = AUDIT_COLUMNS.filter(c => live.has(c));
    } catch (e) {
      console.warn("[applyRoutes] could not read apply_run_jobs schema:", e.message);
    }
    const missing = AUDIT_COLUMNS.filter(c => !present.includes(c));
    if (missing.length) {
      console.warn(
        `[applyRoutes] AUDIT DEGRADED — apply_run_jobs is missing: ${missing.join(", ")}. ` +
        `Those fields will not be queryable; run migrations (073 adds open_questions_json). ` +
        `The full payload is still recorded in apply_job_logs as an 'audit_recorded' event.`
      );
    }
    auditColumnsCache = present;
    return present;
  }

  /** Write whatever audit columns this schema actually has. Returns what was written and skipped. */
  function persistAudit(runJobId, values) {
    const cols = auditColumns();
    const skipped = AUDIT_COLUMNS.filter(c => !cols.includes(c));
    if (!cols.length) return { written: [], skipped };
    try {
      db.prepare(`UPDATE apply_run_jobs SET ${cols.map(c => `${c}=?`).join(", ")} WHERE id=?`)
        .run(...cols.map(c => values[c]), runJobId);
      return { written: cols, skipped };
    } catch (e) {
      // Unexpected (the columns were verified present). Still not fatal: the event carries the data.
      console.warn("[applyRoutes] audit persist failed:", e.message,
        "— payload retained in apply_job_logs");
      return { written: [], skipped: AUDIT_COLUMNS, error: e.message };
    }
  }

  async function processRunJob(runJob, run) {
    const { id: runJobId, run_id: runId, job_id: jobId, user_id: userId } = runJob;
    const mode = run.mode || "auto";
    // Queue-then-approve. NULL approval_mode means the run predates the flow, and those rows
    // submitted — so NULL keeps submitting rather than silently changing what old runs did.
    const approvalMode  = run.approval_mode || "auto";
    const needsApproval = mode === "auto" && approvalMode === "required";
    // 'preview' is full-auto minus the click; 'semi' opens a visible browser for a live human.
    const applyMode = mode !== "auto" ? "semi" : needsApproval ? "preview" : "full";
    // What the human approved, if this run exists because of an approval. autoApply refuses to
    // submit anything that differs from it.
    const approvedAnswers = runJob.approved_from_run_job_id
      ? parseJson(db.prepare("SELECT answers_json FROM apply_run_jobs WHERE id=? AND user_id=?")
          .get(runJob.approved_from_run_job_id, userId)?.answers_json, null)
      : null;
    let resumeTmpPath = null;
    let coverLetterTmpPath = null;
    // Which resume artifact was actually sent. The temp PDF is deleted in `finally`, so the
    // reconstructable reference is the resumes row it was rendered from (requirement 3).
    let usedArtifactId = null;
    let usedAtsScore   = null;

    const setJobStatus = (status, reasonCode = null, reasonDetail = null) => {
      db.prepare(`
        UPDATE apply_run_jobs
        SET status=?, reason_code=?, reason_detail=?, finished_at=unixepoch()
        WHERE id=?
      `).run(status, reasonCode, reasonDetail, runJobId);
    };

    try {
      db.prepare(`UPDATE apply_run_jobs SET status='running', started_at=unixepoch() WHERE id=?`).run(runJobId);

      const job = db.prepare("SELECT * FROM scraped_jobs WHERE job_id=?").get(String(jobId));
      if (!job) { setJobStatus("failed", "job_not_found", "Job not found in DB"); return; }

      const jobUrl = job.apply_url || job.url;
      if (!jobUrl) { setJobStatus("failed", "no_job_url", "Job has no apply URL"); return; }

      // v1 provider scope: only greenhouse/lever/ashby get full-auto; others fall to held_review.
      // Re-checked per job, not just at admission: a run can cross the daily cap mid-flight, and
      // the kill switch can be flipped while a run is in progress. Both HOLD the job with a
      // reasonCode — visible in /api/apply/review — rather than dropping it silently.
      if (mode === "auto" && fullAutoDisabled()) {
        logEvent(runId, runJobId, userId, jobId, "full_auto_disabled",
          "Full-auto submission is disabled; holding for manual review");
        setJobStatus("held_review", "full_auto_disabled", "Automatic submission is currently disabled");
        db.prepare(`UPDATE apply_runs SET held_count=held_count+1 WHERE id=?`).run(runId);
        return;
      }
      if (mode === "auto") {
        const usedToday = submittedLast24h(userId);
        if (usedToday >= APPLY_DAILY_CAP) {
          logEvent(runId, runJobId, userId, jobId, "daily_cap_reached",
            `Daily cap reached: ${usedToday} of ${APPLY_DAILY_CAP} in the last 24h`, { submittedLast24h: usedToday, limit: APPLY_DAILY_CAP });
          setJobStatus("held_review", "daily_cap_reached", `Daily application cap (${APPLY_DAILY_CAP}) reached`);
          db.prepare(`UPDATE apply_runs SET held_count=held_count+1 WHERE id=?`).run(runId);
          return;
        }
      }

      const V1_AUTO_PROVIDERS = new Set(["greenhouse", "lever", "ashby"]);
      if (mode === "auto") {
        const detectedProvider = detectPlatformFromUrl(jobUrl);
        if (!V1_AUTO_PROVIDERS.has(detectedProvider)) {
          logEvent(runId, runJobId, userId, jobId, "provider_review_only",
            `Provider '${detectedProvider || "unknown"}' not in v1 auto-apply scope; routing to review`);
          setJobStatus("held_review", "provider_review_only",
            `Provider ${detectedProvider || "unknown"} not supported for full-auto in v1`);
          db.prepare(`UPDATE apply_runs SET held_count=held_count+1 WHERE id=?`).run(runId);
          return;
        }
      }

      db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(userId);
      const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(userId);
      const autofillPayload = buildAutofillPayload(profile, "APPLY");

      const toolType = run.tool_type || "generate";

      const artifact = db.prepare(
        "SELECT id, ats_score, html FROM resumes WHERE user_id=? AND job_id=? ORDER BY updated_at DESC LIMIT 1"
      ).get(userId, String(jobId));

      let result;

      if (artifact?.html) {
        // CASE A: existing artifact — ATS gate, then PDF convert and apply
        usedArtifactId = artifact.id ?? null;
        usedAtsScore   = artifact.ats_score ?? null;
        const atsScore = artifact.ats_score ?? null;
        if (mode === "auto" && atsScore !== null && atsScore < ATS_AUTO_APPLY_THRESHOLD) {
          logEvent(runId, runJobId, userId, jobId, "ats_review", `ATS score ${atsScore} below threshold`, { atsScore });
          db.prepare(`UPDATE apply_run_jobs SET status='held_review', reason_code='ats_below_threshold', finished_at=unixepoch() WHERE id=?`).run(runJobId);
          db.prepare(`UPDATE apply_runs SET held_count=held_count+1 WHERE id=?`).run(runId);
          return;
        }
        // Cover letter generation runs in parallel with PDF conversion
        const clPromise = generateCoverLetterForApply(userId, jobId).then(async (cl) => {
          if (!cl?.html) {
            logEvent(runId, runJobId, userId, jobId, "cover_letter_unavailable", cl?.error || "no cover letter");
            return null;
          }
          try {
            const pdfBuf = await htmlToPdf(cl.html);
            const tmpPath = path.join(os.tmpdir(), `cl_${userId}_${jobId}_${Date.now()}.pdf`);
            writeFileSync(tmpPath, pdfBuf);
            coverLetterTmpPath = tmpPath;
            return tmpPath;
          } catch { return null; }
        }).catch(() => null);
        const pdfBuf = await htmlToPdf(artifact.html);
        resumeTmpPath = path.join(os.tmpdir(), `resume_${userId}_${jobId}_${Date.now()}.pdf`);
        writeFileSync(resumeTmpPath, pdfBuf);
        const clPath = await clPromise;
        logEvent(runId, runJobId, userId, jobId, "site_visit_started", "Opening application page in browser");
        result = await autoApply(jobUrl, autofillPayload, {
          mode: applyMode,
          jobId,
          resumePath: resumeTmpPath,
          coverLetterPath: clPath,
          approvedAnswers,
        });

      } else if (mode === "semi") {
        // CASE B: no artifact + semi (manual review) mode
        // Generation and browser run in parallel; browser starts immediately in semi mode
        // so the user can review the pre-filled form while generation completes in the background.
        logEvent(runId, runJobId, userId, jobId, "generation_started", "Starting resume generation in background");
        const genPromise = generateResumeForApply(userId, jobId, toolType).then(async (gen) => {
          if (!gen?.html) return null;
          logEvent(runId, runJobId, userId, jobId, "generation_ready", "Resume generation completed", { atsScore: gen.atsScore });
          try {
            const pdfBuf = await htmlToPdf(gen.html);
            const tmpPath = path.join(os.tmpdir(), `resume_${userId}_${jobId}_${Date.now()}.pdf`);
            writeFileSync(tmpPath, pdfBuf);
            resumeTmpPath = tmpPath;
            return tmpPath;
          } catch { return null; }
        });
        const coverLetterPathPromise = generateCoverLetterForApply(userId, jobId).then(async (cl) => {
          if (!cl?.html) {
            logEvent(runId, runJobId, userId, jobId, "cover_letter_unavailable", cl?.error || "no cover letter");
            return null;
          }
          try {
            const pdfBuf = await htmlToPdf(cl.html);
            const tmpPath = path.join(os.tmpdir(), `cl_${userId}_${jobId}_${Date.now()}.pdf`);
            writeFileSync(tmpPath, pdfBuf);
            coverLetterTmpPath = tmpPath;
            return tmpPath;
          } catch { return null; }
        }).catch(() => null);
        logEvent(runId, runJobId, userId, jobId, "site_visit_started", "Opening application page for review");
        const browserPromise = autoApply(jobUrl, autofillPayload, {
          mode: "semi",
          jobId,
          resumePathPromise: genPromise,
          coverLetterPathPromise,
        });
        const [,, applySettled] = await Promise.allSettled([genPromise, coverLetterPathPromise, browserPromise]);
        result = applySettled.status === "fulfilled" ? applySettled.value : { status: "awaiting_user", fieldsFilled: 0 };
        db.prepare(`UPDATE apply_run_jobs SET status='held_review', reason_code='manual_review', finished_at=unixepoch() WHERE id=?`).run(runJobId);
        logEvent(runId, runJobId, userId, jobId, "autofill_done", `Autofilled ${result.fieldsFilled ?? 0} fields`, { platform: result.platform });
        db.prepare(`UPDATE apply_runs SET held_count=held_count+1 WHERE id=?`).run(runId);
        return;

      } else {
        // CASE C: no artifact + auto mode
        // Browser and generation run in parallel; browser awaits resumePathPromise at the upload step,
        // so navigation and form-fill can proceed while generation runs.
        // ATS gate is embedded inside the resumePathPromise chain — it gates the PDF path, not the browser launch.
        logEvent(runId, runJobId, userId, jobId, "generation_started", "Starting resume generation in parallel with browser");
        const resumePathPromise = generateResumeForApply(userId, jobId, toolType).then(async (gen) => {
          if (gen?.error === "generation_timed_out") {
            logEvent(runId, runJobId, userId, jobId, "generation_timed_out", "Resume generation timed out — no file to upload");
            return null;
          }
          if (gen?.error) {
            logEvent(runId, runJobId, userId, jobId, "generation_failed", `Generation failed: ${gen.error}`);
            return null;
          }
          logEvent(runId, runJobId, userId, jobId, "generation_ready", "Resume generated", { atsScore: gen.atsScore });
          usedArtifactId = gen.resumeId ?? null;
          usedAtsScore   = gen.atsScore ?? null;
          const atsScore = gen.atsScore ?? 0;
          logEvent(runId, runJobId, userId, jobId, "ats_review", `ATS score: ${atsScore}`, { atsScore });
          if (atsScore < ATS_AUTO_APPLY_THRESHOLD) {
            logEvent(runId, runJobId, userId, jobId, "ats_below_threshold", `Score ${atsScore} below threshold ${ATS_AUTO_APPLY_THRESHOLD}`);
            db.prepare(`UPDATE apply_run_jobs SET status='held_review', reason_code='ats_below_threshold', finished_at=unixepoch() WHERE id=?`).run(runJobId);
            db.prepare(`UPDATE apply_runs SET held_count=held_count+1 WHERE id=?`).run(runId);
            return null;
          }
          try {
            const pdfBuf = await htmlToPdf(gen.html);
            const tmpPath = path.join(os.tmpdir(), `resume_${userId}_${jobId}_${Date.now()}.pdf`);
            writeFileSync(tmpPath, pdfBuf);
            resumeTmpPath = tmpPath;
            return tmpPath;
          } catch { return null; }
        });
        const coverLetterPathPromiseCaseC = generateCoverLetterForApply(userId, jobId).then(async (cl) => {
          if (!cl?.html) {
            logEvent(runId, runJobId, userId, jobId, "cover_letter_unavailable", cl?.error || "no cover letter");
            return null;
          }
          try {
            const pdfBuf = await htmlToPdf(cl.html);
            const tmpPath = path.join(os.tmpdir(), `cl_${userId}_${jobId}_${Date.now()}.pdf`);
            writeFileSync(tmpPath, pdfBuf);
            coverLetterTmpPath = tmpPath;
            return tmpPath;
          } catch { return null; }
        }).catch(() => null);
        logEvent(runId, runJobId, userId, jobId, "site_visit_started", "Opening application page in browser");
        const applyPromise = autoApply(jobUrl, autofillPayload, {
          mode: applyMode,
          jobId,
          resumePathPromise,
          coverLetterPathPromise: coverLetterPathPromiseCaseC,
          approvedAnswers,
        });
        const [,, applySettled] = await Promise.allSettled([resumePathPromise, coverLetterPathPromiseCaseC, applyPromise]);
        result = applySettled.status === "fulfilled" ? applySettled.value : { status: "error", fieldsFilled: 0 };
      }

      // Record final result for CASE A and CASE C (CASE B returns early above)
      const submitted = result.status === "submitted";
      const atsHeld   = result.status === "ats_held";
      // A preview holds like any other hold — the row carries the full answer set, so the review
      // endpoints serve it and the approve endpoint can release it.
      const previewed = result.status === "preview_ready";
      const finalStatus = submitted ? "submitted"
        : previewed || atsHeld || result.status === "awaiting_user" ? "held_review"
        : result.status === "error" ? "failed"
        : "held_review";
      // result.reasonCode now takes precedence so `submit_unverified` — a submit button was
      // clicked and nothing happened — is not flattened into the much milder "no_submit_button".
      const reasonCode = atsHeld ? "ats_below_threshold"
        : previewed ? "awaiting_approval"
        : result.status === "awaiting_user" ? "manual_review"
        : result.reasonCode
          || (result.status === "filled_not_submitted" ? "no_submit_button" : null);

      const fallbackUrl = isBrowserFailure(reasonCode) ? jobUrl : null;
      setJobStatus(finalStatus, reasonCode, result.reasonDetail || (fallbackUrl ? `fallbackUrl:${fallbackUrl}` : null));

      // AUDIT TRAIL (requirement 3). Everything needed to reconstruct exactly what was sent to an
      // employer and why, on the run-job row itself rather than only in the event log: the resolved
      // answers with provenance/confidence from A2, which resume artifact was used and its ATS
      // score, the screenshot, and whether the submission was actually VERIFIED (see submit_verified
      // — A1 finding N1 showed 'submitted' was previously claimed on a click alone).
      const openQuestions = Array.isArray(result.openQuestions) ? result.openQuestions : [];
      const audit = persistAudit(runJobId, {
        answers_json: Array.isArray(result.answers) && result.answers.length ? JSON.stringify(result.answers) : null,
        resume_artifact_id: usedArtifactId,
        resume_ats_score: usedAtsScore,
        screenshot_path: result.screenshotPath || null,
        submit_verified: result.submitVerified === true ? 1 : result.submitVerified === false ? 0 : null,
        submit_evidence: result.submitEvidence || null,
        // Validation-correction loop: the questions that would turn this hold into a completion.
        open_questions_json: openQuestions.length ? JSON.stringify(openQuestions) : null,
      });

      // The durable record, independent of schema state. The columns are a queryable projection of
      // this; these particular facts (which artifact, which screenshot, whether the submission was
      // actually verified) had no event of their own before, so a failed UPDATE lost them outright.
      logEvent(runId, runJobId, userId, jobId, "audit_recorded",
        `Audit recorded (${audit.written.length}/${AUDIT_COLUMNS.length} columns)`, {
          resumeArtifactId: usedArtifactId,
          resumeAtsScore:   usedAtsScore,
          screenshotPath:   result.screenshotPath || null,
          submitVerified:   result.submitVerified ?? null,
          submitEvidence:   result.submitEvidence || null,
          answerCount:      Array.isArray(result.answers) ? result.answers.length : 0,
          openQuestionCount: openQuestions.length,
          columnsWritten:   audit.written,
          ...(audit.skipped.length ? { columnsSkipped: audit.skipped } : {}),
          ...(audit.error ? { persistError: audit.error } : {}),
        });

      // Outside the persistence path on purpose: this used to sit inside the same try, so a failed
      // UPDATE also swallowed the questions the correction loop depends on.
      if (openQuestions.length) {
        logEvent(runId, runJobId, userId, jobId, "open_questions",
          `${openQuestions.length} question(s) would unblock this application`,
          { openQuestions });
      }
      logEvent(runId, runJobId, userId, jobId, "autofill_done", `Autofilled ${result.fieldsFilled ?? 0} fields`, { platform: result.platform, fallbackUrl });

      // Answer provenance (TASK A2). Persisted so that what was sent to an employer, and which
      // rule produced each value, can be reconstructed after the fact. details_json is used
      // deliberately: it needs no migration, leaving id 069 for A3's dedicated audit columns.
      // The field VALUE is recorded — auditing "was this answer correct" is impossible without it.
      if (Array.isArray(result.answers) && result.answers.length) {
        logEvent(runId, runJobId, userId, jobId, "answers_resolved",
          `Resolved ${result.answers.filter(a => !a.skipped).length} answers`, {
            answers: result.answers.map(a => ({
              field: a.label || a.name || a.field_id,
              type: a.type,
              value: a.skipped ? null : a.value,
              provenance: a.provenance,
              confidence: a.confidence,
              matched_on: a.matched_on,
              ...(a.skipped ? { skipped: true, refusals: a.refusals } : {}),
            })),
          });
      }
      if (Array.isArray(result.lowConfidence) && result.lowConfidence.length) {
        logEvent(runId, runJobId, userId, jobId, "low_confidence_hold",
          `Held: ${result.lowConfidence.length} answer(s) below the auto-submit confidence floor`,
          { lowConfidence: result.lowConfidence });
      }

      if (submitted) {
        logEvent(runId, runJobId, userId, jobId, "submitted", "Application submitted successfully");
        db.prepare(`UPDATE apply_runs SET submitted_count=submitted_count+1 WHERE id=?`).run(runId);
      } else if (finalStatus === "held_review") {
        db.prepare(`UPDATE apply_runs SET held_count=held_count+1 WHERE id=?`).run(runId);
      } else {
        db.prepare(`UPDATE apply_runs SET failed_count=failed_count+1 WHERE id=?`).run(runId);
      }

    } catch (e) {
      console.error(`[applyRoutes] processRunJob error job=${jobId}: ${e.message}`);
      const errReasonCode = e.reasonCode || (isBrowserFailure(e.reasonCode) ? e.reasonCode : "internal_error");
      const fallbackUrl = isBrowserFailure(e.reasonCode) ? (job?.apply_url || job?.url || null) : null;
      db.prepare(`UPDATE apply_run_jobs SET status='failed', reason_code=?, reason_detail=?, finished_at=unixepoch() WHERE id=?`)
        .run(errReasonCode, (e.message?.slice(0, 500) || "Unknown error") + (fallbackUrl ? ` fallbackUrl:${fallbackUrl}` : ""), runJobId);
      db.prepare(`UPDATE apply_runs SET failed_count=failed_count+1 WHERE id=?`).run(runId);
      logEvent(runId, runJobId, userId, jobId, "error", e.message?.slice(0, 500) || "Unknown error", { fallbackUrl });
    } finally {
      if (resumeTmpPath) { try { unlinkSync(resumeTmpPath); } catch {} }
      if (coverLetterTmpPath) { try { unlinkSync(coverLetterTmpPath); } catch {} }
    }
  }

  const processRun = async (run) => {
    try {
      db.prepare(`UPDATE apply_runs SET status='running', started_at=unixepoch() WHERE id=?`).run(run.id);
      const jobs = db.prepare(`SELECT * FROM apply_run_jobs WHERE run_id=? AND status='queued' ORDER BY id`).all(run.id);

      const runningJobs = [];
      for (const job of jobs) {
        while (activeWorkers >= APPLY_WORKER_LIMIT) {
          await new Promise(r => setTimeout(r, 500));
        }
        // Small jitter (1–3 s) between job launches to avoid hammering a provider.
        if (runningJobs.length > 0) {
          await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
        }
        activeWorkers++;
        const p = processRunJob(job, run)
          .catch(e => console.error(`[applyRoutes] uncaught job error job=${job.job_id}: ${e.message}`))
          .finally(() => { activeWorkers--; });
        runningJobs.push(p);
      }

      await Promise.allSettled(runningJobs);
      db.prepare(`UPDATE apply_runs SET status='completed', finished_at=unixepoch() WHERE id=?`).run(run.id);
    } catch (e) {
      console.error(`[applyRoutes] processRun error run=${run.id}: ${e.message}`);
      db.prepare(`UPDATE apply_runs SET status='failed', finished_at=unixepoch() WHERE id=?`).run(run.id);
    }
  };

  // ── Browser readiness ────────────────────────────────────────────────────────

  app.get("/api/apply/readiness", requireAuth, async (_req, res) => {
    try {
      const probe = await probeBrowserAvailability();
      if (!probe.available) {
        return res.status(503).json({ available: false, reason: probe.reasonCode || null });
      }
      res.json({ available: true, reason: null });
    } catch (e) {
      res.status(503).json({ available: false, reason: "probe_error" });
    }
  });

  // ── Queue endpoints ──────────────────────────────────────────────────────────

  /**
   * Create and dispatch a run. Extracted so the validation-correction retry goes through EXACTLY
   * the same admission control as a fresh run: the kill switch, concurrency limit, prerequisite
   * gate, duplicate filter and daily cap are implemented once and cannot drift apart.
   * Returns { status, body } — body carries `error` on refusal.
   */
  function startRun(userId, planTier, jobIds, { mode = "auto", tool = "generate", approvalMode = null,
                                                approvedFrom = null } = {}) {
    const respond = (status, body) => ({ status, body });

    // ── Three payload-contract mismatches with the client, fixed together ──────────────────────
    //
    // 1. MODE. "manual" is the client's word for the review flow (its button calls
    //    startApplyRun("manual") and its own copy says "manual review"); "semi" is the server's
    //    word and what processRunJob branches on. They were never mapped, so "manual" fell through
    //    to "auto" and autoApply ran in "full" mode — a user asking to review first got a real
    //    auto-submitted application. Accept both spellings for the one behaviour.
    const resolvedMode = (mode === "semi" || mode === "manual") ? "semi" : "auto";

    // 2. TOOL. The client sends `tool` — its convention at every other resume endpoint — while
    //    this route read only `toolType`, so the A+ selection never arrived and every run recorded
    //    tool_type='generate'. Accept both; `tool` wins. Anything unrecognised means generate.
    const resolvedTool = tool === "a_plus_resume" ? "a_plus_resume" : "generate";

    // APPROVAL. A full-auto run submits to a real employer with nobody having seen what it filled,
    // and a submission cannot be recalled — so it is now opt-in. An 'auto' run PREVIEWS by default:
    // it runs every gate, stops short of the click, and parks each job for a human decision.
    // 'semi' is exempt because it already puts a human at the browser; approving twice is friction
    // with no safety gained. 'approved' is set by the approve endpoint on the run it creates.
    const resolvedApproval = resolvedMode === "semi" ? "auto"
      : approvalMode === "auto" || approvalMode === "approved" ? approvalMode
      : "required";

    // Honouring the client's tool makes this route entitlement-bearing for the first time: while
    // the field was ignored, a BASIC user could not reach A+ generation by asking for it. Gate it
    // server-side so repairing the plumbing does not open a plan-tier bypass. Same 403 shape as
    // requireToolEntitlement in server.js, which this route cannot reach (positional signature,
    // pinned by applyPipeline.test.js).
    if (resolvedTool === "a_plus_resume" && !canUseAPlusResume(planTier)) {
      return respond(403, {
        error: "upgrade_required",
        message: "A+ Resume requires the PRO plan.",
        requiredTier: "PRO",
        planTier,
      });
    }

    // KILL SWITCH (requirement 4). Full-auto is refused outright; semi still runs, because semi
    // puts a human in front of every submit and is the mode A5 gates the first live application on.
    if (resolvedMode === "auto" && fullAutoDisabled()) {
      return respond(503, {
        error: "full_auto_disabled",
        message: "Automatic submission is currently disabled. Manual review mode is still available.",
        retryWithMode: "manual",
      });
    }

    // CONCURRENCY (requirement 2). A user may not stack runs: overlapping runs make the daily cap
    // racy and multiply browser load.
    const active = activeRunCount(userId);
    if (active >= APPLY_MAX_ACTIVE_RUNS) {
      return respond(429, {
        error: "run_already_active",
        message: `You already have ${active} run in progress. Wait for it to finish before starting another.`,
        activeRuns: active,
        limit: APPLY_MAX_ACTIVE_RUNS,
      });
    }

    // Restored server-side prerequisite gate (§5.13). A run cannot produce anything without a
    // base resume, an active profile, and the name/email the autofill fills in — so refuse before
    // queueing rather than failing per-job inside processRun. This is the missing half of a
    // contract the client still honours: JobsPanel's startApplyRun catch reads
    // `missingPrerequisites` off the error payload and renders "Setup needed in Integrations: …".
    // Deliberately narrow: getAutomationReadiness keeps gmail/google in `apply.optional` and
    // scopes linkedin to profile_import, so none of those block a run.
    const missingPrerequisites = getMissingApplyPrerequisites(getAutomationReadiness(db, userId));
    if (missingPrerequisites.length) {
      return respond(409, {
        error: "Apply prerequisites are not set up yet",
        missingPrerequisites,
      });
    }

    const duplicates = db.prepare(`
      SELECT job_id FROM apply_run_jobs
      WHERE user_id=? AND status IN ('submitted', 'running', 'queued')
    `).pluck().all(userId);
    const duplicateSet = new Set(duplicates);

    const filtered = jobIds.map(String).filter(id => !duplicateSet.has(id));
    if (filtered.length === 0)
      return respond(400, { error: "All selected jobs are already applied or in progress" });

    // DAILY CAP (requirement 2). Checked here so the caller gets a clear error rather than a run
    // that quietly holds most of its jobs. processRunJob re-checks before each submit, because a
    // long run can cross the cap after it was admitted.
    const used = submittedLast24h(userId);
    if (resolvedMode === "auto" && used + filtered.length > APPLY_DAILY_CAP) {
      return respond(429, {
        error: "daily_cap_exceeded",
        message: `Daily application cap reached: ${used} of ${APPLY_DAILY_CAP} used in the last 24h, ${filtered.length} requested.`,
        submittedLast24h: used,
        requested: filtered.length,
        limit: APPLY_DAILY_CAP,
        remaining: Math.max(0, APPLY_DAILY_CAP - used),
      });
    }

    const runResult = db.prepare(`
      INSERT INTO apply_runs (user_id, mode, tool_type, status, total_jobs, approval_mode)
      VALUES (?, ?, ?, 'queued', ?, ?)
    `).run(userId, resolvedMode, resolvedTool, filtered.length, resolvedApproval);
    const runId = runResult.lastInsertRowid;

    // approvedFrom maps job_id -> the preview run-job whose answers were approved. Carrying it on
    // the row is what lets the submitting run compare against what the human actually saw.
    const insertJob = db.prepare(`
      INSERT OR IGNORE INTO apply_run_jobs (run_id, user_id, job_id, status, approved_from_run_job_id)
      VALUES (?, ?, ?, 'queued', ?)
    `);
    db.transaction(() => {
      for (const id of filtered) insertJob.run(runId, userId, id, approvedFrom?.[id] ?? null);
    })();

    const run = db.prepare("SELECT * FROM apply_runs WHERE id=?").get(runId);
    setImmediate(() => processRun(run).catch(e => console.error("[applyRoutes] processRun:", e.message)));

    // 3. RESPONSE SHAPE. The client's success message reads `data.queued?.length`, which this
    //    route never sent — so every run reported "0 jobs started". `queued` is the accepted ids,
    //    which is also what distinguishes them from the ones dropped as duplicates above.
    //    `toolType` is echoed so the client can tell when A+ was requested but downgraded.
    return respond(202, {
      ok: true,
      runId,
      mode: run.mode,
      toolType: run.tool_type,
      queued: filtered,
      totalJobs: filtered.length,
      dailyCap: { limit: APPLY_DAILY_CAP, submittedLast24h: used, remaining: Math.max(0, APPLY_DAILY_CAP - used - filtered.length) },
    });
  }

  app.post("/api/apply/runs", requireAuth, (req, res) =>
    withIdempotency("/api/apply/runs", req, res, (out) => {
      // approvalMode:'auto' is how a caller opts OUT of review and back into full-auto. Anything
      // else — including omitting it — previews and parks for approval.
      const { jobIds = [], mode = "auto", tool, toolType, approvalMode = null } = req.body || {};
      if (!Array.isArray(jobIds) || jobIds.length === 0)
        return out.status(400).json({ error: "jobIds array required" });
      if (jobIds.length > 25)
        return out.status(400).json({ error: "Max 25 jobs per run" });
      // 'approved' is set by the approve endpoint on runs it creates; accepting it from a client
      // would let anyone submit without ever previewing.
      if (approvalMode === "approved")
        return out.status(400).json({ error: "approval_mode_reserved" });

      const r = startRun(req.user.id, normalisePlanTier(req.user?.planTier), jobIds,
        { mode, tool: tool ?? toolType, approvalMode });
      return out.status(r.status).json(r.body);
    }));

  // ── Run payload shape ────────────────────────────────────────────────────────
  // These routes returned raw DB rows: snake_case, seconds-epoch timestamps, and no join to
  // scraped_jobs at all. The client reads camelCase and renders `new Date(...)`, so every review
  // row showed a status pill and nothing else — no title, no company, no reason, no ATS score —
  // and the run chips rendered "undefined✓". Both sides were self-consistent and neither matched
  // the other, the same shape of defect as `tool` vs `toolType`.
  //
  // apply_run_jobs stores only job_id, so title/company have to come from scraped_jobs. LEFT JOIN,
  // not JOIN: a posting can be expired by the 7-day cleanup while the application that targeted it
  // remains, and losing the row entirely would be worse than showing it without a title.
  const toMs = (sec) => (sec ? Number(sec) * 1000 : null);

  const publicRun = (r) => ({
    id: r.id,
    mode: r.mode,
    toolType: r.tool_type,
    approvalMode: r.approval_mode ?? null,
    status: r.status,
    totalJobs: r.total_jobs ?? 0,
    submittedCount: r.submitted_count ?? 0,
    heldCount: r.held_count ?? 0,
    failedCount: r.failed_count ?? 0,
    createdAt: toMs(r.created_at),
    startedAt: toMs(r.started_at),
    finishedAt: toMs(r.finished_at),
  });

  const publicRunJob = (r) => ({
    id: r.id,
    runId: r.run_id,
    jobId: r.job_id,
    // Null when the posting has since expired — the row still names the job_id, so a run is never
    // anonymous even after its target is gone.
    title: r.title ?? null,
    company: r.company ?? null,
    applyUrl: r.apply_url || r.url || null,
    mode: r.mode ?? null,
    status: r.status,
    reasonCode: r.reason_code ?? null,
    reasonDetail: r.reason_detail ?? null,
    atsScore: r.resume_ats_score ?? null,
    // What the review surface needs to offer a link rather than leaving the user guessing whether
    // a resume was ever produced.
    resumeAvailable: r.resume_artifact_id != null,
    screenshotAvailable: !!r.screenshot_path,
    submitVerified: r.submit_verified === 1,
    submitEvidence: r.submit_evidence ?? null,
    startedAt: toMs(r.started_at),
    finishedAt: toMs(r.finished_at),
    createdAt: toMs(r.created_at),
  });

  const RUN_JOB_SELECT = `
    SELECT rj.*, r.mode, sj.title, sj.company, sj.apply_url, sj.url
    FROM apply_run_jobs rj
    JOIN apply_runs r ON r.id = rj.run_id
    LEFT JOIN scraped_jobs sj ON sj.job_id = rj.job_id
  `;

  app.get("/api/apply/runs", requireAuth, (req, res) => {
    const runs = db.prepare(`
      SELECT * FROM apply_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 20
    `).all(req.user.id);
    // Applications awaiting approval are also held_review, but they have their own surface with
    // their own decision. Leaving them here listed every one of them twice — once as something to
    // approve and once as a bare "needs review" row with no action on it.
    const review = db.prepare(`
      ${RUN_JOB_SELECT}
      WHERE rj.user_id=? AND rj.status='held_review'
        AND COALESCE(rj.reason_code, '') != 'awaiting_approval'
      ORDER BY rj.created_at DESC LIMIT 50
    `).all(req.user.id);
    res.json({ runs: runs.map(publicRun), review: review.map(publicRunJob) });
  });

  app.get("/api/apply/runs/:runId", requireAuth, (req, res) => {
    const run = db.prepare("SELECT * FROM apply_runs WHERE id=? AND user_id=?")
      .get(Number(req.params.runId), req.user.id);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const jobs = db.prepare(`${RUN_JOB_SELECT} WHERE rj.run_id=? ORDER BY rj.id`).all(run.id);
    // Log lines carry job_id but the panel rendered only the message, so "7 fields filled" gave no
    // indication of WHICH application or site it referred to. Joining the posting lets each line
    // name its target.
    const logs = db.prepare(`
      SELECT l.*, sj.title, sj.company
      FROM apply_job_logs l
      LEFT JOIN scraped_jobs sj ON sj.job_id = l.job_id
      WHERE l.run_id=? ORDER BY l.created_at, l.id
    `).all(run.id);
    res.json({
      run: publicRun(run),
      jobs: jobs.map(publicRunJob),
      logs: logs.map(l => ({
        id: l.id,
        jobId: l.job_id,
        title: l.title ?? null,
        company: l.company ?? null,
        level: l.level || "info",
        event: l.event,
        message: l.message,
        createdAt: toMs(l.created_at),
      })),
    });
  });

  app.get("/api/apply/review", requireAuth, (req, res) => {
    const jobs = db.prepare(`
      SELECT rj.*, r.mode, sj.title, sj.company AS sj_company, sj.url, sj.apply_url
      FROM apply_run_jobs rj
      JOIN apply_runs r ON r.id = rj.run_id
      LEFT JOIN scraped_jobs sj ON sj.job_id = rj.job_id
      WHERE rj.user_id=? AND rj.status='held_review'
      ORDER BY rj.created_at DESC LIMIT 50
    `).all(req.user.id);
    // Additive: openQuestions is parsed alongside the existing row shape, so a caller that ignores
    // it is unaffected. This is the read half of the validation-correction loop.
    res.json({ jobs: jobs.map(withOpenQuestions) });
  });

  // ── Review artifacts (read-only) ─────────────────────────────────────────────
  // A3 already persists everything needed to reconstruct what was sent to an employer — the resume
  // artifact id, the resolved answers with A2's provenance/confidence, the screenshot, and the submit
  // evidence. None of it was reachable over HTTP, so an application could not actually be reviewed,
  // before or after submission. These three endpoints serve that record. They are strictly read-only:
  // nothing here changes whether, when, or what gets submitted.
  //
  // Keyed on apply_run_jobs.id (the run job), not scraped_jobs.job_id — the audit columns live on the
  // run job, and the same posting can be attempted more than once.

  const ownedRunJob = (runJobId, userId) => {
    const id = Number(runJobId);
    if (!Number.isInteger(id) || id <= 0) return null;
    return db.prepare(`
      SELECT rj.*, r.mode, sj.title, sj.company AS sj_company
      FROM apply_run_jobs rj
      JOIN apply_runs r ON r.id = rj.run_id
      LEFT JOIN scraped_jobs sj ON sj.job_id = rj.job_id
      WHERE rj.id=? AND rj.user_id=?
    `).get(id, userId) || null;
  };

  /** The full record of one application attempt: what was answered, with what confidence, and why. */
  app.get("/api/apply/run-jobs/:runJobId/review", requireAuth, (req, res) => {
    const rj = ownedRunJob(req.params.runJobId, req.user.id);
    if (!rj) return res.status(404).json({ error: "not_found" });
    res.json({
      runJobId:  rj.id,
      runId:     rj.run_id,
      jobId:     rj.job_id,
      title:     rj.title,
      company:   rj.sj_company,
      mode:      rj.mode,
      status:    rj.status,
      reasonCode:   rj.reason_code,
      reasonDetail: rj.reason_detail,
      // Every answer with the rule that produced it. A 'label_fuzzy' answer is a guess; an
      // 'handler_exact'/'field_map_exact'/'custom_answer' one is not. That distinction is the
      // point of showing this at all.
      answers:       parseJson(rj.answers_json, []),
      openQuestions: parseJson(rj.open_questions_json, []),
      resume: {
        artifactId: rj.resume_artifact_id ?? null,
        atsScore:   rj.resume_ats_score ?? null,
        available:  rj.resume_artifact_id != null,
      },
      submission: {
        verified: rj.submit_verified === 1,
        evidence: rj.submit_evidence ?? null,
      },
      screenshotAvailable: !!rj.screenshot_path,
    });
  });

  /**
   * The resume for this attempt, as a PDF.
   *
   * IMPORTANT: this is RE-RENDERED from the stored `resumes.html`, not the archived upload — the temp
   * PDF is deleted in processRunJob's `finally`. It is a faithful reconstruction of the same source,
   * which is what the audit trail was designed around, but it is not guaranteed byte-identical to the
   * file the employer received: a different Chromium build or missing font would render differently.
   * Treat it as "the resume this application was built from", not as a forensic copy.
   */
  app.get("/api/apply/run-jobs/:runJobId/resume", requireAuth, async (req, res) => {
    const rj = ownedRunJob(req.params.runJobId, req.user.id);
    if (!rj) return res.status(404).json({ error: "not_found" });
    if (rj.resume_artifact_id == null) {
      return res.status(404).json({
        error: "no_resume_artifact",
        message: "No resume artifact was recorded for this application.",
      });
    }
    // Re-check ownership on the artifact itself rather than trusting the foreign key.
    const artifact = db.prepare("SELECT html FROM resumes WHERE id=? AND user_id=?")
      .get(rj.resume_artifact_id, req.user.id);
    if (!artifact?.html) {
      return res.status(404).json({
        error: "resume_artifact_missing",
        message: "The resume this application used is no longer stored.",
      });
    }
    try {
      const pdf = await htmlToPdf(artifact.html);
      const safe = String(rj.job_id).replace(/[^a-z0-9._-]+/gi, "_");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition",
        `${req.query.download ? "attachment" : "inline"}; filename="resume-${safe}.pdf"`);
      return res.send(pdf);
    } catch (err) {
      // PDF rendering needs a browser; on a host without one this is the same failure the apply
      // path hits, and it should read as unavailable rather than as a missing resume.
      return res.status(503).json({
        error: "pdf_render_failed",
        message: err?.message || "Could not render the resume to PDF.",
      });
    }
  });

  /** The screenshot taken at the end of the attempt — the visual proof of what the form looked like. */
  app.get("/api/apply/run-jobs/:runJobId/screenshot", requireAuth, (req, res) => {
    const rj = ownedRunJob(req.params.runJobId, req.user.id);
    if (!rj) return res.status(404).json({ error: "not_found" });
    if (!rj.screenshot_path) return res.status(404).json({ error: "no_screenshot" });
    // The value is written by our own takeScreenshot(), but serving a DB string as a filesystem path
    // is precisely the shape that becomes an arbitrary-file read if anything upstream ever changes.
    // Confine it to the screenshot directory and refuse anything else.
    const resolved = path.resolve(rj.screenshot_path);
    if (resolved !== path.resolve(SCREENSHOT_DIR) &&
        !resolved.startsWith(path.resolve(SCREENSHOT_DIR) + path.sep)) {
      return res.status(403).json({ error: "screenshot_outside_store" });
    }
    if (!existsSync(resolved)) return res.status(404).json({ error: "screenshot_missing" });
    res.setHeader("Content-Type", "image/png");
    return res.sendFile(resolved);
  });

  // ── Queue-then-approve ───────────────────────────────────────────────────────
  // An 'auto' run now previews by default: it fills the form, runs every gate, stops short of the
  // click and parks. Approving releases a job to a run that submits — and that run refuses if the
  // form no longer resolves to what was approved, because the reviewer's decision was about a
  // specific set of answers, not about the job in general.

  const AWAITING = "awaiting_approval";

  /** Jobs parked for a decision, each with the answers that are actually going to be sent. */
  app.get("/api/apply/pending", requireAuth, (req, res) => {
    const rows = db.prepare(`
      SELECT rj.id, rj.run_id, rj.job_id, rj.answers_json, rj.resume_artifact_id, rj.resume_ats_score,
             rj.screenshot_path, rj.created_at, r.mode, r.tool_type,
             sj.title, sj.company, sj.apply_url, sj.url
      FROM apply_run_jobs rj
      JOIN apply_runs r ON r.id = rj.run_id
      LEFT JOIN scraped_jobs sj ON sj.job_id = rj.job_id
      WHERE rj.user_id=? AND rj.status='held_review' AND rj.reason_code=?
      ORDER BY rj.created_at DESC, rj.id DESC LIMIT 100
    `).all(req.user.id, AWAITING);

    res.json({
      pending: rows.map(r => {
        const answers = parseJson(r.answers_json, []);
        const filled = answers.filter(a => !a.skipped && !a.policy_rejected);
        return {
          runJobId: r.id, runId: r.run_id, jobId: r.job_id,
          title: r.title, company: r.company,
          applyUrl: r.apply_url || r.url,
          createdAt: r.created_at,
          answerCount: filled.length,
          // Surfaced at list level so a reviewer can see which applications need attention without
          // opening each one. An exact mapping is not a guess; a fuzzy one is.
          guessCount: filled.filter(a => a.provenance === "label_fuzzy").length,
          resume: { artifactId: r.resume_artifact_id ?? null, atsScore: r.resume_ats_score ?? null,
                    available: r.resume_artifact_id != null },
          screenshotAvailable: !!r.screenshot_path,
        };
      }),
    });
  });

  /** The rows this user actually owns and that are actually awaiting a decision. */
  const pendingRows = (userId, runJobIds) => {
    const ids = (Array.isArray(runJobIds) ? runJobIds : [])
      .map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (ids.length === 0) return [];
    const q = ids.map(() => "?").join(",");
    return db.prepare(`
      SELECT id, job_id FROM apply_run_jobs
      WHERE user_id=? AND status='held_review' AND reason_code=? AND id IN (${q})
    `).all(userId, AWAITING, ...ids);
  };

  /**
   * Approve one or more previewed applications and submit them.
   *
   * The approved rows are superseded rather than mutated in place, exactly as the correction loop
   * does, so the preview stays in the audit trail as its own record of what was shown and when it
   * was approved. The new run carries approval_mode='approved', which is the discriminator that
   * separates a human-approved submission from a full-auto one — the thing that was missing when
   * mode was being coerced at INSERT.
   */
  app.post("/api/apply/approve", requireAuth, (req, res) =>
    withIdempotency("/api/apply/approve", req, res, (out) => {
      const rows = pendingRows(req.user.id, req.body?.runJobIds);
      const requested = Array.isArray(req.body?.runJobIds) ? req.body.runJobIds.length : 0;
      if (rows.length === 0) {
        return out.status(409).json({
          error: "no_approvable_jobs",
          message: requested
            ? "None of those applications are awaiting approval."
            : "runJobIds required.",
        });
      }

      const approvedFrom = {};
      for (const r of rows) approvedFrom[String(r.job_id)] = r.id;

      db.transaction(() => {
        const mark = db.prepare(`
          UPDATE apply_run_jobs SET approved_at=unixepoch(), status='superseded', finished_at=unixepoch()
          WHERE id=? AND user_id=? AND status='held_review'
        `);
        for (const r of rows) mark.run(r.id, req.user.id);
      })();

      const started = startRun(req.user.id, normalisePlanTier(req.user?.planTier),
        rows.map(r => String(r.job_id)), { mode: "auto", approvalMode: "approved", approvedFrom });

      if (started.status !== 202) {
        // The run was refused (cap, kill switch, concurrency). Put the approvals back so the user
        // can retry — an approval that silently evaporates is worse than one that fails loudly.
        db.transaction(() => {
          const undo = db.prepare(`
            UPDATE apply_run_jobs SET status='held_review', approved_at=NULL, finished_at=NULL
            WHERE id=? AND user_id=? AND status='superseded'
          `);
          for (const r of rows) undo.run(r.id, req.user.id);
        })();
        return out.status(started.status).json({ ...started.body, approved: [] });
      }

      return out.status(202).json({
        ok: true,
        approved: rows.map(r => r.id),
        skipped: Math.max(0, requested - rows.length),
        run: started.body,
      });
    }));

  /** Reject previewed applications. Nothing is submitted and no run is started. */
  app.post("/api/apply/reject", requireAuth, (req, res) => {
    const rows = pendingRows(req.user.id, req.body?.runJobIds);
    if (rows.length === 0) {
      return res.status(409).json({ error: "no_rejectable_jobs" });
    }
    db.transaction(() => {
      const reject = db.prepare(`
        UPDATE apply_run_jobs SET status='dismissed', reason_code='rejected', finished_at=unixepoch()
        WHERE id=? AND user_id=? AND status='held_review'
      `);
      for (const r of rows) reject.run(r.id, req.user.id);
    })();
    res.json({ ok: true, rejected: rows.map(r => r.id) });
  });

  // ── Validation-correction loop ───────────────────────────────────────────────
  // A hold used to be a dead end: missingRequired named the fields and the run stopped. The answers
  // the resolver could not supply are exactly the answers the USER has, so they are collected and
  // stored as custom_answers — the one resolution path that is exact by construction, and therefore
  // the only one safe for eligibility questions. Nothing is guessed on retry; it is answered.

  const parseJson = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };
  const withOpenQuestions = (row) => ({ ...row, openQuestions: parseJson(row.open_questions_json, []) });

  /** Every outstanding question across this user's held jobs, deduplicated by question text. */
  app.get("/api/apply/questions", requireAuth, (req, res) => {
    const rows = db.prepare(`
      SELECT rj.job_id, rj.run_id, rj.reason_code, rj.open_questions_json,
             sj.title, sj.company
      FROM apply_run_jobs rj
      LEFT JOIN scraped_jobs sj ON sj.job_id = rj.job_id
      WHERE rj.user_id=? AND rj.status='held_review' AND rj.open_questions_json IS NOT NULL
      ORDER BY rj.created_at DESC LIMIT 50
    `).all(req.user.id);

    const stored = parseJson(
      db.prepare("SELECT custom_answers FROM user_profile WHERE user_id=?").get(req.user.id)?.custom_answers,
      {},
    );
    const byQuestion = new Map();
    for (const row of rows) {
      for (const q of parseJson(row.open_questions_json, [])) {
        const key = String(q.question || "").trim().toLowerCase();
        if (!key) continue;
        if (!byQuestion.has(key)) {
          byQuestion.set(key, { ...q, answered: Object.prototype.hasOwnProperty.call(stored, q.question), blocking: [] });
        }
        byQuestion.get(key).blocking.push({ jobId: row.job_id, runId: row.run_id, title: row.title, company: row.company });
      }
    }
    const questions = [...byQuestion.values()];
    res.json({
      questions,
      // Eligibility answers are attestations to an employer. A caller should present them as such,
      // and they are the ones the resolver refuses to infer on the user's behalf.
      eligibilityCount: questions.filter(q => q.eligibility).length,
      blockedJobs: rows.length,
    });
  });

  /**
   * Save answers, and optionally retry the jobs they unblock.
   * Answers are merged into user_profile.custom_answers keyed by the EXACT question text captured
   * from the form, which is what makes them usable for eligibility fields on the next pass.
   */
  app.post("/api/apply/answers", requireAuth, (req, res) =>
    withIdempotency("/api/apply/answers", req, res, (out) => {
      // The retry goes through startRun, so it inherits the approval default too: answering the
      // questions unblocks the job, it does not authorise the submission. Pass approvalMode:'auto'
      // to answer-and-send in one step.
      const { answers = {}, retryJobIds = null, mode = "auto", approvalMode = null } = req.body || {};
      if (approvalMode === "approved")
        return out.status(400).json({ error: "approval_mode_reserved" });
      if (!answers || typeof answers !== "object" || Array.isArray(answers))
        return out.status(400).json({ error: "answers object required" });

      const entries = Object.entries(answers)
        .map(([q, a]) => [String(q).trim(), a])
        .filter(([q, a]) => q.length > 0 && a !== null && a !== undefined && String(a).trim() !== "");
      if (entries.length === 0)
        return out.status(400).json({ error: "no non-empty answers supplied" });

      db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(req.user.id);
      const existing = parseJson(
        db.prepare("SELECT custom_answers FROM user_profile WHERE user_id=?").get(req.user.id)?.custom_answers,
        {},
      );
      const merged = { ...existing };
      for (const [q, a] of entries) merged[q] = String(a);
      db.prepare("UPDATE user_profile SET custom_answers=? WHERE user_id=?")
        .run(JSON.stringify(merged), req.user.id);

      // Which held jobs are now fully answered? A job is retryable when every question it was
      // blocked on has an answer — retrying one that is still missing an answer just burns a run.
      const held = db.prepare(`
        SELECT job_id, open_questions_json FROM apply_run_jobs
        WHERE user_id=? AND status='held_review' AND open_questions_json IS NOT NULL
      `).all(req.user.id);
      const unblocked = held
        .filter(row => {
          const qs = parseJson(row.open_questions_json, []);
          return qs.length > 0 && qs.every(q => Object.prototype.hasOwnProperty.call(merged, q.question));
        })
        .map(row => row.job_id);

      const body = { ok: true, saved: entries.map(([q]) => q), unblocked };

      if (retryJobIds !== null) {
        const requested = (Array.isArray(retryJobIds) ? retryJobIds : []).map(String);
        // Only retry jobs that are actually unblocked; anything else is reported back, not queued.
        const toRetry = requested.filter(id => unblocked.includes(id));
        const skipped = requested.filter(id => !unblocked.includes(id));
        if (toRetry.length === 0) {
          return out.status(409).json({ ...body, error: "no_retryable_jobs", skipped });
        }
        // The held rows are dismissed first: leaving them held_review would keep re-offering
        // questions that have since been answered.
        const dismiss = db.prepare(`
          UPDATE apply_run_jobs SET status='superseded', finished_at=unixepoch()
          WHERE user_id=? AND job_id=? AND status='held_review'
        `);
        db.transaction(() => { for (const id of toRetry) dismiss.run(req.user.id, id); })();

        const retry = startRun(req.user.id, normalisePlanTier(req.user?.planTier), toRetry,
          { mode, tool: "generate", approvalMode });
        // A refusal is surfaced as-is: the answers were still saved, but the retry did not start,
        // and the caller needs the real reason (cap, kill switch, concurrency).
        if (retry.status !== 202) return out.status(retry.status).json({ ...body, ...retry.body, skipped });
        return out.status(202).json({ ...body, skipped, retry: retry.body });
      }

      out.json(body);
    }));

  app.post("/api/apply/close/:jobId", requireAuth, (req, res) => {
    db.prepare(`
      UPDATE apply_run_jobs SET status='dismissed', finished_at=unixepoch()
      WHERE job_id=? AND user_id=? AND status='held_review'
    `).run(String(req.params.jobId), req.user.id);
    res.json({ ok: true });
  });

  app.post("/api/apply/session/save", requireAuth, (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/apply/session/:domain", requireAuth, (_req, res) => {
    res.json({ exists: false });
  });
}
