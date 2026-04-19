// routes/apply.js — REST API for Playwright apply automation
// POST /api/apply                  — trigger automation
// GET  /api/apply/status/:jobId    — poll in-progress status
// POST /api/apply/close/:jobId     — close semi-auto browser
// POST /api/apply/session/save     — save storageState for a portal domain
// GET  /api/apply/session/:domain  — check if saved session exists

import path from "path";
import fs   from "fs";
import { fileURLToPath } from "url";
import { autoApply, getApplyStatus, closeSemiBrowser } from "../services/applyAutomation.js";
import { detectPlatformFromUrl } from "../services/platformDetector.js";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, "..", "data", "sessions");
fs.mkdirSync(SESSION_DIR, { recursive: true });

function sessionPath(userId, domain) {
  const safe = domain.replace(/[^a-z0-9._-]/gi, "_");
  return path.join(SESSION_DIR, `${userId}_${safe}.json`);
}

const ATS_AUTO_APPLY_THRESHOLD = 80;
const APPLY_WORKER_LIMIT = 2;
let activeApplyWorkers = 0;
const queuedRunIds = new Set();

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

export default function applyRoutes(app, db, requireAuth, buildAutofillPayload) {
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
        SUM(CASE WHEN status IN ('queued','preparing','generating_resume','ats_review','applying') THEN 1 ELSE 0 END) as active
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

  const processRunJob = async (jobRow, run) => {
    const job = db.prepare("SELECT * FROM scraped_jobs WHERE job_id=?").get(jobRow.job_id);
    if (!job) return failRunJob(jobRow, "job_not_found", "Job is no longer available in the local pool.");
    const jobUrl = job.apply_url || job.url;
    if (!jobUrl) return holdRunJob(jobRow, "missing_apply_url", "No apply URL is available for this job.");

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

    db.prepare("UPDATE apply_run_jobs SET status='generating_resume' WHERE id=?").run(jobRow.id);
    const artifact = findResumeArtifact(run.user_id, job.job_id, run.tool_type);
    if (!artifact?.html) {
      return holdRunJob(jobRow, "resume_required", "Generate a resume for this job before auto-apply can submit.", { toolType: run.tool_type });
    }
    const resumeFile = applyResumeFileName(job.job_id, artifact.id);
    db.prepare("UPDATE apply_run_jobs SET resume_id=?, resume_file=? WHERE id=?").run(artifact.id, resumeFile, jobRow.id);
    logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id, event: "resume_reused", message: "Using existing generated resume.", details: { resumeId: artifact.id } });

    const atsScore = artifact.ats_score ?? job.ats_score ?? null;
    db.prepare("UPDATE apply_run_jobs SET status='ats_review', ats_score=? WHERE id=?").run(atsScore, jobRow.id);
    logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id, event: "ats_checked", message: `ATS score ${atsScore ?? "unavailable"}.`, details: { atsScore } });
    if (atsScore == null) return holdRunJob(jobRow, "ats_missing", "ATS score is unavailable; review before sending.", { atsScore });
    if (atsScore < ATS_AUTO_APPLY_THRESHOLD) {
      return holdRunJob(jobRow, "ats_below_threshold", `ATS ${atsScore} is below the auto-submit threshold of ${ATS_AUTO_APPLY_THRESHOLD}.`, { atsScore, threshold: ATS_AUTO_APPLY_THRESHOLD });
    }

    db.prepare("UPDATE apply_run_jobs SET status='applying' WHERE id=?").run(jobRow.id);
    logApplyEvent({ runId: run.id, runJobId: jobRow.id, userId: run.user_id, jobId: job.job_id, event: "applying", message: "Launching automation." });
    const result = await autoApply(jobUrl, autofillData, {
      mode: run.mode === "manual" ? "semi" : "full",
      jobId: `${run.id}_${job.job_id}`,
      storageStatePath: getStorageStatePath(run.user_id, jobUrl),
    });

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
    if (result.status === "filled_not_submitted") {
      return holdRunJob(jobRow, "submit_button_missing", "Fields were filled but no safe submit button was found.", result);
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

  // ── POST /api/apply ───────────────────────────────────────────
  app.post("/api/apply/runs", requireAuth, (req, res) => {
    const rawJobIds = Array.isArray(req.body?.jobIds) ? req.body.jobIds : [];
    const jobIds = [...new Set(rawJobIds.map(id => String(id || "").trim()).filter(Boolean))].slice(0, 25);
    if (!jobIds.length) return res.status(400).json({ error: "jobIds required" });
    const mode = req.body?.mode === "manual" ? "manual" : "auto";
    const toolType = req.body?.tool === "a_plus_resume" ? "a_plus_resume" : "generate";

    const duplicates = db.prepare(`
      SELECT arj.job_id
      FROM apply_run_jobs arj
      JOIN apply_runs ar ON ar.id = arj.run_id
      WHERE arj.user_id=? AND arj.job_id IN (${jobIds.map(() => "?").join(",")})
        AND arj.status IN ('queued','preparing','generating_resume','ats_review','applying')
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

    // Build autofill payload from stored profile using shared server-side builder.
    // This gives full field coverage (40+ variants), phone/URL normalization,
    // A+ location stripping and EEO dropdown fields.
    db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(req.user.id);
    const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(req.user.id) || {};
    const autofillData = buildAutofillPayload(profile, req.user.applyMode);

    // Session state
    let storageStatePath = null;
    try {
      const domain = new URL(jobUrl).hostname;
      const sp = sessionPath(req.user.id, domain);
      if (fs.existsSync(sp)) storageStatePath = sp;
    } catch {}

    // Resume file path
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

        // Persist to job_applications
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
      // Semi mode: AWAIT the launch + fill so errors reach the client.
      // Fire-and-forget swallowed every error silently (browser never opened,
      // client always got "launched" anyway). Awaiting keeps the request open
      // for ~5-15s while Playwright launches and fills — client shows ⏳ already.
      try {
        const result = await autoApply(jobUrl, autofillData, {
          mode: "semi", resumePath, jobId: jobIdStr, storageStatePath,
        });
        if (result.status === "error") {
          return res.status(500).json({ ok: false, status: "error", error: result.error || "Automation failed" });
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
