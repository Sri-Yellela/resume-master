import os from "os";
import path from "path";
import { writeFileSync, unlinkSync } from "fs";
import { autoApply } from "../services/applyAutomation.js";
import { probeBrowserAvailability } from "../services/browserLauncher.js";
import { detectPlatformFromUrl } from "../services/platformDetector.js";
import { getAutomationReadiness, getMissingApplyPrerequisites } from "../services/integrationReadiness.js";
import { canUseAPlusResume, normalisePlanTier } from "../services/entitlements.js";

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

  async function processRunJob(runJob, run) {
    const { id: runJobId, run_id: runId, job_id: jobId, user_id: userId } = runJob;
    const mode = run.mode || "auto";
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
          mode: mode === "auto" ? "full" : "semi",
          jobId,
          resumePath: resumeTmpPath,
          coverLetterPath: clPath,
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
          mode: "full",
          jobId,
          resumePathPromise,
          coverLetterPathPromise: coverLetterPathPromiseCaseC,
        });
        const [,, applySettled] = await Promise.allSettled([resumePathPromise, coverLetterPathPromiseCaseC, applyPromise]);
        result = applySettled.status === "fulfilled" ? applySettled.value : { status: "error", fieldsFilled: 0 };
      }

      // Record final result for CASE A and CASE C (CASE B returns early above)
      const submitted = result.status === "submitted";
      const atsHeld   = result.status === "ats_held";
      const finalStatus = submitted ? "submitted"
        : atsHeld || result.status === "awaiting_user" ? "held_review"
        : result.status === "error" ? "failed"
        : "held_review";
      // result.reasonCode now takes precedence so `submit_unverified` — a submit button was
      // clicked and nothing happened — is not flattened into the much milder "no_submit_button".
      const reasonCode = atsHeld ? "ats_below_threshold"
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
      try {
        db.prepare(`
          UPDATE apply_run_jobs
          SET answers_json=?, resume_artifact_id=?, resume_ats_score=?,
              screenshot_path=?, submit_verified=?, submit_evidence=?
          WHERE id=?
        `).run(
          Array.isArray(result.answers) && result.answers.length ? JSON.stringify(result.answers) : null,
          usedArtifactId,
          usedAtsScore,
          result.screenshotPath || null,
          result.submitVerified === true ? 1 : result.submitVerified === false ? 0 : null,
          result.submitEvidence || null,
          runJobId,
        );
      } catch (e) {
        console.warn("[applyRoutes] audit persist failed:", e.message);
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

  app.post("/api/apply/runs", requireAuth, (req, res) =>
    withIdempotency("/api/apply/runs", req, res, (out) => {
    const { jobIds = [], mode = "auto", tool, toolType } = req.body || {};
    if (!Array.isArray(jobIds) || jobIds.length === 0)
      return out.status(400).json({ error: "jobIds array required" });
    if (jobIds.length > 25)
      return out.status(400).json({ error: "Max 25 jobs per run" });

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
    const resolvedTool = (tool ?? toolType) === "a_plus_resume" ? "a_plus_resume" : "generate";

    // Honouring the client's tool makes this route entitlement-bearing for the first time: while
    // the field was ignored, a BASIC user could not reach A+ generation by asking for it. Gate it
    // server-side so repairing the plumbing does not open a plan-tier bypass. Same 403 shape as
    // requireToolEntitlement in server.js, which this route cannot reach (positional signature,
    // pinned by applyPipeline.test.js).
    const planTier = normalisePlanTier(req.user?.planTier);
    if (resolvedTool === "a_plus_resume" && !canUseAPlusResume(planTier)) {
      return out.status(403).json({
        error: "upgrade_required",
        message: "A+ Resume requires the PRO plan.",
        requiredTier: "PRO",
        planTier,
      });
    }

    // KILL SWITCH (requirement 4). Full-auto is refused outright; semi still runs, because semi
    // puts a human in front of every submit and is the mode A5 gates the first live application on.
    if (resolvedMode === "auto" && fullAutoDisabled()) {
      return out.status(503).json({
        error: "full_auto_disabled",
        message: "Automatic submission is currently disabled. Manual review mode is still available.",
        retryWithMode: "manual",
      });
    }

    // CONCURRENCY (requirement 2). A user may not stack runs: overlapping runs make the daily cap
    // racy and multiply browser load.
    const active = activeRunCount(req.user.id);
    if (active >= APPLY_MAX_ACTIVE_RUNS) {
      return out.status(429).json({
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
    const missingPrerequisites = getMissingApplyPrerequisites(getAutomationReadiness(db, req.user.id));
    if (missingPrerequisites.length) {
      return out.status(409).json({
        error: "Apply prerequisites are not set up yet",
        missingPrerequisites,
      });
    }

    const duplicates = db.prepare(`
      SELECT job_id FROM apply_run_jobs
      WHERE user_id=? AND status IN ('submitted', 'running', 'queued')
    `).pluck().all(req.user.id);
    const duplicateSet = new Set(duplicates);

    const filtered = jobIds.map(String).filter(id => !duplicateSet.has(id));
    if (filtered.length === 0)
      return out.status(400).json({ error: "All selected jobs are already applied or in progress" });

    // DAILY CAP (requirement 2). Checked here so the caller gets a clear error rather than a run
    // that quietly holds most of its jobs. processRunJob re-checks before each submit, because a
    // long run can cross the cap after it was admitted.
    const used = submittedLast24h(req.user.id);
    if (resolvedMode === "auto" && used + filtered.length > APPLY_DAILY_CAP) {
      return out.status(429).json({
        error: "daily_cap_exceeded",
        message: `Daily application cap reached: ${used} of ${APPLY_DAILY_CAP} used in the last 24h, ${filtered.length} requested.`,
        submittedLast24h: used,
        requested: filtered.length,
        limit: APPLY_DAILY_CAP,
        remaining: Math.max(0, APPLY_DAILY_CAP - used),
      });
    }

    const runResult = db.prepare(`
      INSERT INTO apply_runs (user_id, mode, tool_type, status, total_jobs)
      VALUES (?, ?, ?, 'queued', ?)
    `).run(req.user.id, resolvedMode, resolvedTool, filtered.length);
    const runId = runResult.lastInsertRowid;

    const insertJob = db.prepare(`
      INSERT OR IGNORE INTO apply_run_jobs (run_id, user_id, job_id, status)
      VALUES (?, ?, ?, 'queued')
    `);
    db.transaction(() => { for (const id of filtered) insertJob.run(runId, req.user.id, id); })();

    const run = db.prepare("SELECT * FROM apply_runs WHERE id=?").get(runId);
    setImmediate(() => processRun(run).catch(e => console.error("[applyRoutes] processRun:", e.message)));

    // 3. RESPONSE SHAPE. The client's success message reads `data.queued?.length`, which this
    //    route never sent — so every run reported "0 jobs started". `queued` is the accepted ids,
    //    which is also what distinguishes them from the ones dropped as duplicates above.
    //    `toolType` is echoed so the client can tell when A+ was requested but downgraded.
    out.status(202).json({
      ok: true,
      runId,
      mode: run.mode,
      toolType: run.tool_type,
      queued: filtered,
      totalJobs: filtered.length,
      dailyCap: { limit: APPLY_DAILY_CAP, submittedLast24h: used, remaining: Math.max(0, APPLY_DAILY_CAP - used - filtered.length) },
    });
  }));

  app.get("/api/apply/runs", requireAuth, (req, res) => {
    const runs = db.prepare(`
      SELECT * FROM apply_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 20
    `).all(req.user.id);
    const review = db.prepare(`
      SELECT rj.*, r.mode FROM apply_run_jobs rj
      JOIN apply_runs r ON r.id = rj.run_id
      WHERE rj.user_id=? AND rj.status='held_review'
      ORDER BY rj.created_at DESC LIMIT 50
    `).all(req.user.id);
    res.json({ runs, review });
  });

  app.get("/api/apply/runs/:runId", requireAuth, (req, res) => {
    const run = db.prepare("SELECT * FROM apply_runs WHERE id=? AND user_id=?")
      .get(Number(req.params.runId), req.user.id);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const jobs = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=? ORDER BY id").all(run.id);
    const logs = db.prepare("SELECT * FROM apply_job_logs WHERE run_id=? ORDER BY created_at").all(run.id);
    res.json({ run, jobs, logs });
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
    res.json({ jobs });
  });

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
