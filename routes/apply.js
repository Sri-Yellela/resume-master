// routes/apply.js — REST API for Playwright apply automation
// POST /api/apply                  — trigger automation (legacy single-job)
// POST /api/apply/runs             — create a queued apply run (multi-job)
// GET  /api/apply/runs             — list runs + held-review queue
// GET  /api/apply/runs/:runId      — run detail + per-job logs
// GET  /api/apply/review           — held-review items across all runs
// GET  /api/apply/status/:jobId    — poll in-progress status (legacy)
// POST /api/apply/close/:jobId     — close semi-auto browser
// POST /api/apply/session/save     — save storageState for a portal domain
// GET  /api/apply/session/:domain  — check if saved session exists

import path from "path";
import fs   from "fs";
import os   from "os";
import { fileURLToPath } from "url";
import { autoApply, getApplyStatus, closeSemiBrowser } from "../services/applyAutomation.js";
import { detectPlatformFromUrl } from "../services/platformDetector.js";
import { getAutomationReadiness, getLinkedInStatus, getMissingApplyPrerequisites, requiresLinkedInSession } from "../services/integrationReadiness.js";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, "..", "data", "sessions");
fs.mkdirSync(SESSION_DIR, { recursive: true });

function sessionPath(userId, domain) {
  const safe = domain.replace(/[^a-z0-9._-]/gi, "_");
  return path.join(SESSION_DIR, `${userId}_${safe}.json`);
}

const ATS_AUTO_APPLY_THRESHOLD = 65;
const APPLY_WORKER_LIMIT = 2;
let activeApplyWorkers = 0;
const queuedRunIds = new Set();

// Timeout (ms) the apply worker waits for an in-flight generation to finish
// before declaring it stalled and proceeding without a resume artifact.
const GENERATION_WAIT_TIMEOUT_MS = 120_000;

function selectedApplyModeForTool(toolType) {
  return toolType === "a_plus_resume" ? "CUSTOM_SAMPLER" : "TAILORED";
}

function publicRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    toolType: row.tool_type,
    status: row.status,
    totalJobs: row.total_jobs,
    submittedCount: row.submitted_count,
    heldCount: row.held_count,
    failedCount: row.failed_count,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

function publicRunJob(row) {
  return {
    id: row.id,
    runId: row.run_id,
    jobId: row.job_id,
    company: row.company,
    title: row.title,
    applyUrl: row.apply_url || row.url,
    status: row.status,
    reasonCode: row.reason_code,
    reasonDetail: row.reason_detail,
    atsScore: row.ats_score,
    resumeId: row.resume_id,
    resumeFile: row.resume_file,
    attemptCount: row.attempt_count,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

export default function applyRoutes(app, db, requireAuth, buildAutofillPayload, generateResumeForApply, htmlToPdf) {
  const logApplyEvent = ({ runId, runJobId, userId, jobId, level = "info", event, message, details }) => {
    db.prepare(`
      INSERT INTO apply_job_logs (run_id, run_job_id, user_id, job_id, level, event, message, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId || null, runJobId || null, userId, jobId || null, level, event, message || null,
      details ? JSON.stringify(details) : null);
  };

  const updateRunCounts = (runId) => {
    const counts = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as submitted,
        SUM(CASE WHEN status = 'held_review' THEN 1 ELSE 0 END) as held,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status IN (
          'queued','preparing','generation_started','ats_review','applying',
          'site_visit_started','autofill_started','waiting_for_resume'
        ) THEN 1 ELSE 0 END) as active
      FROM apply_run_jobs WHERE run_id = ?
    `).get(runId);
    const status = counts.active > 0 ? "running" : "complete";
    db.prepare(`
      UPDATE apply_runs
      SET total_jobs=?, submitted_count=?, held_count=?, failed_count=?,
          status=?, finished_at=CASE WHEN ? = 'complete' THEN unixepoch() ELSE finished_at END
      WHERE id=?
    `).run(counts.total || 0, counts.submitted || 0, counts.held || 0, counts.failed || 0, status, status, runId);
  };

  const holdRunJob = (jobRow, reasonCode, reasonDetail, details = {}) => {
    db.prepare(`
      UPDATE apply_run_jobs
      SET status='held_review', reason_code=?, reason_detail=?, finished_at=unixepoch(), locked_at=NULL
      WHERE id=?
    `).run(reasonCode, reasonDetail, jobRow.id);
    logApplyEvent({
      runId: jobRow.run_id, runJobId: jobRow.id, userId: jobRow.user_id, jobId: jobRow.job_id,
      level: reasonCode === "ats_below_threshold" ? "warn" : "info",
      event: "held_review", message: reasonDetail, details: { reasonCode, ...details },
    });
  };

  const failRunJob = (jobRow, reasonCode, reasonDetail, details = {}) => {
    db.prepare(`
      UPDATE apply_run_jobs
      SET status='failed', reason_code=?, reason_detail=?, finished_at=unixepoch(), locked_at=NULL
      WHERE id=?
    `).run(reasonCode, reasonDetail, jobRow.id);
    logApplyEvent({
      runId: jobRow.run_id, runJobId: jobRow.id, userId: jobRow.user_id, jobId: jobRow.job_id,
      level: "error", event: "failed", message: reasonDetail, details: { reasonCode, ...details },
    });
  };

  const findResumeArtifact = (userId, jobId, toolType) => {
    const preferredMode = selectedApplyModeForTool(toolType);
    return db.prepare(`
      SELECT id, apply_mode, ats_score, html
      FROM resumes
      WHERE user_id=? AND job_id=?
      ORDER BY CASE WHEN apply_mode = ? THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1
    `).get(userId, jobId, preferredMode);
  };

  const applyResumeFileName = (jobId, resumeId) => {
    return `resume_${String(jobId).replace(/[^a-z0-9_-]/gi, "_")}_${resumeId || "generated"}.pdf`;
  };

  const getStorageStatePath = (userId, jobUrl) => {
    try {
      const domain = new URL(jobUrl).hostname;
      const sp = sessionPath(userId, domain);
      return fs.existsSync(sp) ? sp : null;
    } catch { return null; }
  };

  // ── processRunJob ──────────────────────────────────────────────────────────
  // Execution order (parallel where indicated):
  //
  // 1. Job / URL / LinkedIn guard checks (fast, sync)
  // 2. Build autofill payload + required-field check
  // 3a. If artifact EXISTS → ATS check → apply (existing behaviour)
  // 3b. If NO artifact + MANUAL mode → parallel: start generation + start browser immediately
  //       Browser fills what it can; after both settle, update artifact info
  // 3c. If NO artifact + AUTO mode  → generate first (preserves ATS gate), then apply
  //       Status: generation_started → ats_review → applying → done
  const processRunJob = async (jobRow, run) => {
    const job = db.prepare("SELECT * FROM scraped_jobs WHERE job_id=?").get(jobRow.job_id);
    if (!job) return failRunJob(jobRow, "job_not_found", "Job is no longer available in the local pool.");
    const jobUrl = job.apply_url || job.url;
    if (!jobUrl) return holdRunJob(jobRow, "missing_apply_url", "No apply URL is available for this job.");
    if (requiresLinkedInSession(jobUrl) && !getLinkedInStatus(db, run.user_id).healthy) {
      return holdRunJob(jobRow, "linkedin_session_required", "Connect LinkedIn in Integrations before automating LinkedIn applications.", { integration: "linkedin" });
    }

    db.prepare("UPDATE apply_run_jobs SET status='preparing', started_at=COALESCE(started_at, unixepoch()), attempt_count=attempt_count+1 WHERE id=?").run(jobRow.id);
    logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id, event: "preparing", message: "Preparing application." });

    const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(run.user_id) || {};
    const autofillData = buildAutofillPayload(profile, selectedApplyModeForTool(run.tool_type));
    const missing = [];
    if (!autofillData.field_map?.email) missing.push("email");
    if (!autofillData.field_map?.first_name || !autofillData.field_map?.last_name) missing.push("name");
    if (missing.length) {
      return holdRunJob(jobRow, "missing_user_info", `Missing required profile data: ${missing.join(", ")}.`, { missing });
    }

    // ── Resume artifact resolution ─────────────────────────────────────────
    const existingArtifact = findResumeArtifact(run.user_id, job.job_id, run.tool_type);

    if (existingArtifact?.html) {
      // ── CASE A: artifact already exists — ATS gate + browser (original behaviour) ──
      db.prepare("UPDATE apply_run_jobs SET status='ats_review', resume_id=?, resume_file=?, ats_score=? WHERE id=?")
        .run(existingArtifact.id, applyResumeFileName(job.job_id, existingArtifact.id),
          existingArtifact.ats_score ?? null, jobRow.id);
      logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id,
        event: "resume_reused", message: "Using existing generated resume.",
        details: { resumeId: existingArtifact.id } });

      const atsScore = existingArtifact.ats_score ?? job.ats_score ?? null;
      logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id,
        event: "ats_checked", message: `ATS score ${atsScore ?? "unavailable"}.`, details: { atsScore } });
      if (atsScore != null && atsScore < ATS_AUTO_APPLY_THRESHOLD) {
        return holdRunJob(jobRow, "ats_below_threshold", `ATS ${atsScore} is below the auto-submit threshold of ${ATS_AUTO_APPLY_THRESHOLD}.`, { atsScore, threshold: ATS_AUTO_APPLY_THRESHOLD });
      }

      db.prepare("UPDATE apply_run_jobs SET status='applying' WHERE id=?").run(jobRow.id);
      logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id, event: "applying", message: "Launching automation." });

      // Convert existing HTML artifact to a temp PDF for upload
      let pdfPath = null;
      if (htmlToPdf && existingArtifact.html) {
        try {
          const pdfBuf = await htmlToPdf(existingArtifact.html);
          pdfPath = path.join(os.tmpdir(), `apply_resume_${run.user_id}_${job.job_id}_${Date.now()}.pdf`);
          fs.writeFileSync(pdfPath, pdfBuf);
        } catch (e) {
          logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id,
            level: "warn", event: "pdf_conversion_failed",
            message: `PDF conversion failed: ${e.message}. Proceeding without resume upload.`,
            details: { error: e.message } });
        }
      }

      const result = await autoApply(jobUrl, autofillData, {
        mode: run.mode === "manual" ? "semi" : "full",
        jobId: `${run.id}_${job.job_id}`,
        storageStatePath: getStorageStatePath(run.user_id, jobUrl),
        resumePath: pdfPath,
      });
      if (pdfPath) try { fs.unlinkSync(pdfPath); } catch {}
      return _handleAutomationResult(jobRow, run, job, result, existingArtifact.id);

    } else if (run.mode === "manual") {
      // ── CASE B: no artifact + MANUAL mode ─────────────────────────────────
      // Launch generation AND the browser in parallel.
      // Manual mode never auto-submits so ATS gating is not needed here.
      // The browser stays open for user review regardless of resume availability.
      db.prepare("UPDATE apply_run_jobs SET status='generation_started' WHERE id=?").run(jobRow.id);
      logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id,
        event: "generation_started",
        message: "No existing resume found — generation started in parallel with site preparation.",
        details: { toolType: run.tool_type } });

      db.prepare("UPDATE apply_run_jobs SET status='site_visit_started' WHERE id=?").run(jobRow.id);
      logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id,
        event: "site_visit_started", message: "Launching browser while resume generates." });

      const artifactPromise = generateResumeForApply
        ? generateResumeForApply(run.user_id, job.job_id, run.tool_type)
        : Promise.resolve({ error: "no_generation_handler" });

      // Convert generated HTML to a temp PDF so the browser can upload it.
      // Runs in parallel — browser navigates + fills while PDF is being produced.
      // No ATS gate here: manual mode never auto-submits.
      const resumePathPromise = htmlToPdf
        ? artifactPromise.then(async genResult => {
            if (!genResult?.html || genResult.error) return null;
            try {
              const pdfBuf = await htmlToPdf(genResult.html);
              const tmpPath = path.join(os.tmpdir(), `apply_resume_${run.user_id}_${job.job_id}_${Date.now()}.pdf`);
              fs.writeFileSync(tmpPath, pdfBuf);
              return tmpPath;
            } catch { return null; }
          }).catch(() => null)
        : null;

      const automationPromise = autoApply(jobUrl, autofillData, {
        mode: "semi",
        jobId: `${run.id}_${job.job_id}`,
        storageStatePath: getStorageStatePath(run.user_id, jobUrl),
        resumePathPromise,
      });

      const [autoSettled, artifactSettled] = await Promise.allSettled([
        automationPromise,
        artifactPromise,
      ]);

      // Clean up temp PDF after apply completes
      if (resumePathPromise) resumePathPromise.then(p => { if (p) try { fs.unlinkSync(p); } catch {} }).catch(() => {});

      // Update artifact info if generation completed
      if (artifactSettled.status === "fulfilled" && artifactSettled.value?.resumeId) {
        const gen = artifactSettled.value;
        db.prepare("UPDATE apply_run_jobs SET resume_id=?, resume_file=?, ats_score=? WHERE id=?")
          .run(gen.resumeId, applyResumeFileName(job.job_id, gen.resumeId), gen.atsScore ?? null, jobRow.id);
        logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id,
          event: "generation_ready",
          message: `Resume generation completed${gen.atsScore != null ? ` (ATS: ${gen.atsScore})` : ""}.`,
          details: { resumeId: gen.resumeId, atsScore: gen.atsScore } });
      } else if (artifactSettled.status === "rejected" || artifactSettled.value?.error) {
        const genErr = artifactSettled.status === "rejected"
          ? artifactSettled.reason?.message
          : artifactSettled.value?.error;
        logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id,
          level: "warn", event: "generation_failed",
          message: `Resume generation failed (${genErr || "unknown"}). Proceeding with autofill only.`,
          details: { error: genErr } });
      }

      if (autoSettled.status === "rejected") {
        return failRunJob(jobRow, "worker_error", autoSettled.reason?.message || "Browser automation threw.");
      }
      return _handleAutomationResult(jobRow, run, job, autoSettled.value, null);

    } else {
      // ── CASE C: no artifact + AUTO mode ───────────────────────────────────
      // Two parallel tracks: generation (for ATS gate + PDF) and browser (site visit + fill).
      // The tracks couple only at the upload/submit step via resumePathPromise:
      //   - Browser navigates and fills while generation runs
      //   - resumePathPromise resolves to PDF path when generation + ATS gate passes,
      //     or null if generation failed / ATS below threshold / PDF conversion failed
      //   - autoApply awaits resumePathPromise before the first upload attempt;
      //     if null and full-auto, it skips submission (returns ats_held)
      db.prepare("UPDATE apply_run_jobs SET status='generation_started' WHERE id=?").run(jobRow.id);
      logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id,
        event: "generation_started",
        message: "No existing resume found — generating resume in parallel with site visit.",
        details: { toolType: run.tool_type } });

      if (!generateResumeForApply) {
        return holdRunJob(jobRow, "no_generation_handler",
          "Resume generation is not available in this context. Generate a resume manually and retry.", { toolType: run.tool_type });
      }

      // Generation track with timeout
      const genWithTimeout = Promise.race([
        generateResumeForApply(run.user_id, job.job_id, run.tool_type),
        new Promise((_, rej) => setTimeout(() => rej(new Error("generation_timed_out")), GENERATION_WAIT_TIMEOUT_MS)),
      ]);

      // Gate: ATS check + PDF conversion — resolves to a temp file path or null
      const resumePathPromise = genWithTimeout.then(async genResult => {
        if (!genResult?.html || genResult.error) return null;
        const score = genResult.atsScore ?? null;
        if (score != null && score < ATS_AUTO_APPLY_THRESHOLD) return null; // ATS gate
        if (!htmlToPdf) return null;
        try {
          const pdfBuf = await htmlToPdf(genResult.html);
          const tmpPath = path.join(os.tmpdir(), `apply_resume_${run.user_id}_${job.job_id}_${Date.now()}.pdf`);
          fs.writeFileSync(tmpPath, pdfBuf);
          return tmpPath;
        } catch (e) {
          console.warn(`[applyWorker] PDF conversion failed job=${job.job_id}: ${e.message}`);
          return null;
        }
      }).catch(() => null);

      // Apply track: visit site + fill + wait for resume at upload step
      db.prepare("UPDATE apply_run_jobs SET status='site_visit_started' WHERE id=?").run(jobRow.id);
      logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id,
        event: "site_visit_started", message: "Launching browser in parallel with resume generation." });

      const automationPromise = autoApply(jobUrl, autofillData, {
        mode: "full",
        jobId: `${run.id}_${job.job_id}`,
        storageStatePath: getStorageStatePath(run.user_id, jobUrl),
        resumePathPromise,
      });

      const [genSettled, autoSettled] = await Promise.allSettled([genWithTimeout, automationPromise]);

      // Clean up temp PDF after both tracks settle
      resumePathPromise.then(tmpPath => { if (tmpPath) try { fs.unlinkSync(tmpPath); } catch {} }).catch(() => {});

      // Process generation result
      const genResult = genSettled.status === "fulfilled" ? genSettled.value : null;
      const genErr = genSettled.status === "rejected"
        ? genSettled.reason?.message
        : (genResult?.error || null);

      if (genErr) {
        const reasonCode = genErr === "generation_timed_out" ? "generation_timed_out" : "generation_failed";
        return holdRunJob(jobRow, reasonCode,
          `Resume generation ${reasonCode === "generation_timed_out" ? "timed out" : "failed"}: ${genErr}.`,
          { toolType: run.tool_type, error: genErr });
      }

      if (genResult?.resumeId) {
        db.prepare("UPDATE apply_run_jobs SET resume_id=?, resume_file=?, ats_score=? WHERE id=?")
          .run(genResult.resumeId, applyResumeFileName(job.job_id, genResult.resumeId), genResult.atsScore ?? null, jobRow.id);
        logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id,
          event: "generation_ready",
          message: `Resume generated${genResult.atsScore != null ? ` (ATS: ${genResult.atsScore})` : ""}.`,
          details: { resumeId: genResult.resumeId, atsScore: genResult.atsScore } });
      }

      // ATS gate (may hold the run regardless of browser result)
      const atsScore = genResult?.atsScore ?? null;
      db.prepare("UPDATE apply_run_jobs SET status='ats_review', ats_score=? WHERE id=?").run(atsScore, jobRow.id);
      logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id,
        event: "ats_checked", message: `ATS score ${atsScore ?? "unavailable"} (post-generation).`,
        details: { atsScore } });
      if (atsScore != null && atsScore < ATS_AUTO_APPLY_THRESHOLD) {
        return holdRunJob(jobRow, "ats_below_threshold",
          `ATS ${atsScore} is below the auto-submit threshold of ${ATS_AUTO_APPLY_THRESHOLD}.`,
          { atsScore, threshold: ATS_AUTO_APPLY_THRESHOLD });
      }

      if (autoSettled.status === "rejected") {
        return failRunJob(jobRow, "worker_error", autoSettled.reason?.message || "Browser automation threw.");
      }
      return _handleAutomationResult(jobRow, run, job, autoSettled.value, genResult?.resumeId || null);
    }
  };

  // ── Shared result handler for autoApply outcome ────────────────────────────
  const _handleAutomationResult = (jobRow, run, job, result, resumeId) => {
    const resumeFile = resumeId ? applyResumeFileName(job.job_id, resumeId) : null;
    const jobUrl = job.apply_url || job.url;

    logApplyEvent({
      runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id,
      level: result.status === "error" ? "error" : "info",
      event: "automation_result",
      message: result.error || `Automation returned ${result.status}.`,
      details: { status: result.status, fieldsFilled: result.fieldsFilled, platform: result.platform, reasonCode: result.reasonCode },
    });

    if (run.mode === "manual" || result.status === "awaiting_user") {
      db.prepare(`
        UPDATE apply_run_jobs
        SET status='held_review', reason_code='manual_review', reason_detail=?, finished_at=unixepoch(), locked_at=NULL
        WHERE id=?
      `).run(`Autofilled ${result.fieldsFilled ?? 0} fields. Review and submit manually.`, jobRow.id);
      return;
    }
    if (result.status === "submitted") {
      db.prepare(`
        INSERT INTO job_applications
          (user_id, job_id, company, role, job_url, source, location, apply_mode, resume_file, applied_at, notes, auto_status, screenshot_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'AUTO', ?, unixepoch(), ?, ?, ?)
        ON CONFLICT(user_id, job_id) DO UPDATE SET
          applied_at=excluded.applied_at,
          auto_status=excluded.auto_status,
          screenshot_path=excluded.screenshot_path,
          notes=excluded.notes
      `).run(run.user_id, job.job_id, job.company, job.title, jobUrl, job.source || null, job.location || null,
        resumeFile, JSON.stringify({ runId: run.id, fieldsFilled: result.fieldsFilled }), result.status, result.screenshotPath || null);
      db.prepare(`
        INSERT INTO user_jobs (user_id, job_id, domain_profile_id, applied, updated_at)
        VALUES (?, ?, COALESCE((SELECT domain_profile_id FROM scraped_jobs WHERE job_id=?), (SELECT id FROM domain_profiles WHERE user_id=? AND is_active=1)), 1, unixepoch())
        ON CONFLICT(user_id, job_id) DO UPDATE SET applied = 1, updated_at = unixepoch()
      `).run(run.user_id, job.job_id, job.job_id, run.user_id);
      db.prepare("UPDATE apply_run_jobs SET status='submitted', finished_at=unixepoch(), locked_at=NULL WHERE id=?").run(jobRow.id);
      return;
    }
    if (result.status === "ats_held") {
      // resumePathPromise resolved to null after ATS gate — generation succeeded but PDF
      // conversion was unavailable. ATS score itself was within threshold; hold for manual review.
      return holdRunJob(jobRow, "pdf_conversion_failed",
        "Resume generated but PDF conversion failed. Apply manually.", {});
    }
    if (result.status === "filled_not_submitted") {
      return holdRunJob(jobRow, result.reasonCode || "submit_button_missing", "Fields were filled but no safe submit button was found.", result);
    }
    return failRunJob(jobRow, result.reasonCode || "automation_failed", result.error || "Application automation failed.", result);
  };

  const processRun = async (runId) => {
    const run = db.prepare("SELECT * FROM apply_runs WHERE id=?").get(runId);
    if (!run || !["queued", "running"].includes(run.status)) return;
    db.prepare("UPDATE apply_runs SET status='running', started_at=COALESCE(started_at, unixepoch()) WHERE id=?").run(runId);
    let next;
    while ((next = db.prepare(`
      SELECT * FROM apply_run_jobs
      WHERE run_id=? AND status='queued'
      ORDER BY id ASC LIMIT 1
    `).get(runId))) {
      db.prepare("UPDATE apply_run_jobs SET locked_at=unixepoch() WHERE id=? AND status='queued'").run(next.id);
      try {
        await processRunJob(next, run);
      } catch(e) {
        failRunJob(next, "worker_error", e.message);
      }
      updateRunCounts(runId);
    }
    updateRunCounts(runId);
  };

  const scheduleRun = (runId) => {
    queuedRunIds.add(Number(runId));
    setImmediate(async () => {
      if (activeApplyWorkers >= APPLY_WORKER_LIMIT) return;
      const nextRunId = queuedRunIds.values().next().value;
      if (!nextRunId) return;
      queuedRunIds.delete(nextRunId);
      activeApplyWorkers++;
      try { await processRun(nextRunId); }
      finally {
        activeApplyWorkers--;
        if (queuedRunIds.size) scheduleRun(queuedRunIds.values().next().value);
      }
    });
  };

  // ── POST /api/apply/runs ──────────────────────────────────────────────────
  app.post("/api/apply/runs", requireAuth, (req, res) => {
    const rawJobIds = Array.isArray(req.body?.jobIds) ? req.body.jobIds : [];
    const jobIds = [...new Set(rawJobIds.map(id => String(id || "").trim()).filter(Boolean))].slice(0, 25);
    if (!jobIds.length) return res.status(400).json({ error: "jobIds required" });
    const mode = req.body?.mode === "manual" ? "manual" : "auto";
    const toolType = req.body?.tool === "a_plus_resume" ? "a_plus_resume" : "generate";
    const readiness = getAutomationReadiness(db, req.user.id);
    const missingPrereqs = getMissingApplyPrerequisites(readiness);
    if (missingPrereqs.length) {
      return res.status(409).json({
        error: "Automation setup is incomplete. Open Integrations to finish setup.",
        missingPrerequisites: missingPrereqs,
        integrationsPath: "/app/integrations",
        readiness,
      });
    }

    const duplicates = db.prepare(`
      SELECT arj.job_id
      FROM apply_run_jobs arj
      JOIN apply_runs ar ON ar.id = arj.run_id
      WHERE arj.user_id=? AND arj.job_id IN (${jobIds.map(() => "?").join(",")})
        AND arj.status IN (
          'queued','preparing','generation_started','ats_review','applying',
          'site_visit_started','autofill_started','waiting_for_resume'
        )
    `).all(req.user.id, ...jobIds).map(r => r.job_id);
    const duplicateSet = new Set(duplicates);
    const queueIds = jobIds.filter(id => !duplicateSet.has(id));
    if (!queueIds.length) return res.status(409).json({ error: "All selected jobs are already queued or running.", duplicates });

    const runInfo = db.transaction(() => {
      const run = db.prepare("INSERT INTO apply_runs (user_id, mode, tool_type, status, total_jobs) VALUES (?, ?, ?, 'queued', ?)")
        .run(req.user.id, mode, toolType, queueIds.length);
      const runId = run.lastInsertRowid;
      const insertJob = db.prepare("INSERT INTO apply_run_jobs (run_id, user_id, job_id, status) VALUES (?, ?, ?, 'queued')");
      for (const jobId of queueIds) {
        insertJob.run(runId, req.user.id, jobId);
        logApplyEvent({ runId, userId: req.user.id, jobId, event: "job_queued", message: "Job queued for apply run." });
      }
      logApplyEvent({ runId, userId: req.user.id, event: "run_created", message: `${queueIds.length} job(s) queued.`, details: { mode, toolType, duplicates } });
      return { runId };
    })();

    scheduleRun(runInfo.runId);
    const row = db.prepare("SELECT * FROM apply_runs WHERE id=?").get(runInfo.runId);
    res.status(202).json({ ok: true, run: publicRun(row), queued: queueIds, duplicates });
  });

  app.get("/api/apply/runs", requireAuth, (req, res) => {
    const runs = db.prepare("SELECT * FROM apply_runs WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 20")
      .all(req.user.id).map(publicRun);
    const review = db.prepare(`
      SELECT arj.*, sj.company, sj.title, sj.url, sj.apply_url
      FROM apply_run_jobs arj
      LEFT JOIN scraped_jobs sj ON sj.job_id = arj.job_id
      WHERE arj.user_id=? AND arj.status='held_review'
      ORDER BY arj.finished_at DESC, arj.id DESC
      LIMIT 50
    `).all(req.user.id).map(publicRunJob);
    res.json({ runs, review });
  });

  app.get("/api/apply/runs/:runId", requireAuth, (req, res) => {
    const run = db.prepare("SELECT * FROM apply_runs WHERE id=? AND user_id=?").get(req.params.runId, req.user.id);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const jobs = db.prepare(`
      SELECT arj.*, sj.company, sj.title, sj.url, sj.apply_url
      FROM apply_run_jobs arj
      LEFT JOIN scraped_jobs sj ON sj.job_id = arj.job_id
      WHERE arj.run_id=? AND arj.user_id=?
      ORDER BY arj.id ASC
    `).all(run.id, req.user.id).map(publicRunJob);
    const logs = db.prepare("SELECT * FROM apply_job_logs WHERE run_id=? AND user_id=? ORDER BY created_at ASC, id ASC LIMIT 300")
      .all(run.id, req.user.id)
      .map(row => ({
        id: row.id,
        runId: row.run_id,
        runJobId: row.run_job_id,
        jobId: row.job_id,
        level: row.level,
        event: row.event,
        message: row.message,
        details: row.details_json ? JSON.parse(row.details_json) : null,
        createdAt: row.created_at,
      }));
    res.json({ run: publicRun(run), jobs, logs });
  });

  app.get("/api/apply/review", requireAuth, (req, res) => {
    const rows = db.prepare(`
      SELECT arj.*, sj.company, sj.title, sj.url, sj.apply_url
      FROM apply_run_jobs arj
      LEFT JOIN scraped_jobs sj ON sj.job_id = arj.job_id
      WHERE arj.user_id=? AND arj.status='held_review'
      ORDER BY arj.finished_at DESC, arj.id DESC
      LIMIT 100
    `).all(req.user.id).map(publicRunJob);
    res.json({ jobs: rows });
  });

  app.post("/api/apply", requireAuth, async (req, res) => {
    const { jobId, jobUrl, mode = "semi", resumeFile } = req.body;
    if (!jobUrl) return res.status(400).json({ error: "jobUrl required" });
    const readiness = getAutomationReadiness(db, req.user.id);
    const missingPrereqs = getMissingApplyPrerequisites(readiness);
    if (missingPrereqs.length) {
      return res.status(409).json({
        error: "Automation setup is incomplete. Open Integrations to finish setup.",
        missingPrerequisites: missingPrereqs,
        integrationsPath: "/app/integrations",
        readiness,
      });
    }
    if (requiresLinkedInSession(jobUrl) && !readiness.linkedin.healthy) {
      return res.status(409).json({
        error: "Connect LinkedIn in Integrations before automating LinkedIn applications.",
        missingPrerequisites: ["linkedin"],
        integrationsPath: "/app/integrations",
        readiness,
      });
    }

    db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(req.user.id);
    const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(req.user.id) || {};
    const autofillData = buildAutofillPayload(profile, req.user.applyMode);

    let storageStatePath = null;
    try {
      const domain = new URL(jobUrl).hostname;
      const sp = sessionPath(req.user.id, domain);
      if (fs.existsSync(sp)) storageStatePath = sp;
    } catch {}

    let resumePath = null;
    if (resumeFile) {
      const candidate = path.join(__dirname, "..", resumeFile);
      if (fs.existsSync(candidate)) resumePath = candidate;
    }

    const jobIdStr = String(jobId || `tmp_${Date.now()}`);

    if (mode === "full") {
      try {
        const result = await autoApply(jobUrl, autofillData, {
          mode, resumePath, jobId: jobIdStr, storageStatePath,
        });

        if (jobId) {
          try {
            db.prepare(`
              INSERT INTO job_applications
                (user_id, job_id, company, role, job_url, apply_mode, resume_file, applied_at, notes, auto_status, screenshot_path)
              SELECT ?, ?, sj.company, sj.title, sj.url, 'AUTO', ?, unixepoch(), ?, ?, ?
              FROM scraped_jobs sj WHERE sj.job_id = ?
              ON CONFLICT(user_id, job_id) DO UPDATE SET
                apply_mode      = excluded.apply_mode,
                applied_at      = excluded.applied_at,
                auto_status     = excluded.auto_status,
                screenshot_path = excluded.screenshot_path
            `).run(
              req.user.id, String(jobId), resumeFile || null,
              JSON.stringify({ automationStatus: result.status }),
              result.status, result.screenshotPath || null,
              String(jobId)
            );
          } catch (dbErr) {
            console.warn("[apply route] db persist:", dbErr.message);
          }
          if (result.status === "submitted") {
            db.prepare(`
              INSERT INTO user_jobs (user_id, job_id, domain_profile_id, applied, updated_at)
              VALUES (
                ?, ?,
                (
                  SELECT sj.domain_profile_id
                  FROM scraped_jobs sj
                  JOIN domain_profiles dp ON dp.id = sj.domain_profile_id
                  WHERE sj.job_id = ? AND dp.user_id = ?
                ),
                1, unixepoch()
              )
              ON CONFLICT(user_id, job_id) DO UPDATE SET applied = 1, updated_at = unixepoch()
            `).run(req.user.id, String(jobId), String(jobId), req.user.id);
          }
        }
        return res.json({ ok: true, ...result });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    } else {
      try {
        const result = await autoApply(jobUrl, autofillData, {
          mode: "semi", resumePath, jobId: jobIdStr, storageStatePath,
        });
        if (result.status === "error") {
          const BROWSER_FAILURE_CODES = new Set([
            "browser_runtime_missing_dependency",
            "browser_binary_not_found",
            "browser_launch_failed",
          ]);
          const isBrowserFailure = BROWSER_FAILURE_CODES.has(result.reasonCode);
          return res.status(isBrowserFailure ? 503 : 500).json({
            ok: false, status: "error",
            error: result.error || "Automation failed",
            reasonCode: result.reasonCode || "automation_failed",
            // fallbackUrl lets the client offer a direct-link fallback when browser unavailable
            ...(isBrowserFailure ? { fallbackUrl: jobUrl } : {}),
          });
        }
        const n = result.fieldsFilled ?? 0;
        return res.json({
          ok: true,
          status: "semi_launched",
          jobId: jobIdStr,
          fieldsFilled: n,
          platform: result.platform,
          message: `Browser open — ${n} field${n !== 1 ? "s" : ""} pre-filled. Review and submit manually.`,
        });
      } catch (e) {
        console.error("[apply semi]", e.message);
        return res.status(500).json({ ok: false, status: "error", error: e.message });
      }
    }
  });

  // ── GET /api/apply/status/:jobId ─────────────────────────────
  app.get("/api/apply/status/:jobId", requireAuth, (req, res) => {
    const entry = getApplyStatus(req.params.jobId);
    res.json({ status: entry ? entry.status : "idle" });
  });

  // ── POST /api/apply/close/:jobId ─────────────────────────────
  app.post("/api/apply/close/:jobId", requireAuth, async (req, res) => {
    await closeSemiBrowser(req.params.jobId);
    res.json({ ok: true });
  });

  // ── POST /api/apply/session/save ─────────────────────────────
  app.post("/api/apply/session/save", requireAuth, (req, res) => {
    const { domain, storageState } = req.body;
    if (!domain || !storageState) return res.status(400).json({ error: "domain and storageState required" });
    try {
      fs.writeFileSync(sessionPath(req.user.id, domain), JSON.stringify(storageState));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/apply/session/:domain ───────────────────────────
  app.get("/api/apply/session/:domain", requireAuth, (req, res) => {
    res.json({ exists: fs.existsSync(sessionPath(req.user.id, req.params.domain)) });
  });
}
