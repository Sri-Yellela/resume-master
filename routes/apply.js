import os from "os";
import path from "path";
import { writeFileSync, unlinkSync } from "fs";
import { autoApply } from "../services/applyAutomation.js";
import { probeBrowserAvailability } from "../services/browserLauncher.js";
import { detectPlatformFromUrl } from "../services/platformDetector.js";

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

  app.post("/api/apply", requireAuth, (req, res) => {
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
      return res.status(400).json({ error: "jobId or jobUrl required" });
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
    res.json({ ok: true, application: publicApplication(row) });
  });

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

  const APPLY_WORKER_LIMIT = 2;
  const ATS_AUTO_APPLY_THRESHOLD = 65;
  let activeWorkers = 0;

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
      const reasonCode = atsHeld ? "ats_below_threshold"
        : result.status === "awaiting_user" ? "manual_review"
        : result.status === "filled_not_submitted" ? "no_submit_button"
        : result.reasonCode || null;

      setJobStatus(finalStatus, reasonCode, result.reasonDetail || null);
      logEvent(runId, runJobId, userId, jobId, "autofill_done", `Autofilled ${result.fieldsFilled ?? 0} fields`, { platform: result.platform });

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
      db.prepare(`UPDATE apply_run_jobs SET status='failed', reason_code='internal_error', reason_detail=?, finished_at=unixepoch() WHERE id=?`)
        .run(e.message?.slice(0, 500) || "Unknown error", runJobId);
      db.prepare(`UPDATE apply_runs SET failed_count=failed_count+1 WHERE id=?`).run(runId);
      logEvent(runId, runJobId, userId, jobId, "error", e.message?.slice(0, 500) || "Unknown error");
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
      res.json({ available: probe.available, reason: probe.reasonCode || null });
    } catch (e) {
      res.json({ available: false, reason: "probe_error" });
    }
  });

  // ── Queue endpoints ──────────────────────────────────────────────────────────

  app.post("/api/apply/runs", requireAuth, (req, res) => {
    const { jobIds = [], mode = "auto", toolType } = req.body || {};
    if (!Array.isArray(jobIds) || jobIds.length === 0)
      return res.status(400).json({ error: "jobIds array required" });
    if (jobIds.length > 25)
      return res.status(400).json({ error: "Max 25 jobs per run" });

    const duplicates = db.prepare(`
      SELECT job_id FROM apply_run_jobs
      WHERE user_id=? AND status IN ('submitted', 'running', 'queued')
    `).pluck().all(req.user.id);
    const duplicateSet = new Set(duplicates);

    const filtered = jobIds.map(String).filter(id => !duplicateSet.has(id));
    if (filtered.length === 0)
      return res.status(400).json({ error: "All selected jobs are already applied or in progress" });

    const runResult = db.prepare(`
      INSERT INTO apply_runs (user_id, mode, tool_type, status, total_jobs)
      VALUES (?, ?, ?, 'queued', ?)
    `).run(req.user.id, mode === "semi" ? "semi" : "auto", toolType || "generate", filtered.length);
    const runId = runResult.lastInsertRowid;

    const insertJob = db.prepare(`
      INSERT OR IGNORE INTO apply_run_jobs (run_id, user_id, job_id, status)
      VALUES (?, ?, ?, 'queued')
    `);
    db.transaction(() => { for (const id of filtered) insertJob.run(runId, req.user.id, id); })();

    const run = db.prepare("SELECT * FROM apply_runs WHERE id=?").get(runId);
    setImmediate(() => processRun(run).catch(e => console.error("[applyRoutes] processRun:", e.message)));

    res.status(202).json({ ok: true, runId, mode: run.mode, totalJobs: filtered.length });
  });

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
