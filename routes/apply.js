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

export default function applyRoutes(app, db, requireAuth, buildAutofillPayload) {

  // ── POST /api/apply ───────────────────────────────────────────
  app.post("/api/apply", requireAuth, async (req, res) => {
    const { jobId, jobUrl, mode = "semi", resumeFile } = req.body;
    if (!jobUrl) return res.status(400).json({ error: "jobUrl required" });

    // Build autofill payload from stored profile using shared server-side builder.
    // This gives full field coverage (40+ variants), phone/URL normalization,
    // CUSTOM_SAMPLER location stripping, and EEO dropdown fields.
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
              INSERT INTO user_jobs (user_id, job_id, applied, updated_at)
              VALUES (?, ?, 1, unixepoch())
              ON CONFLICT(user_id, job_id) DO UPDATE SET applied = 1, updated_at = unixepoch()
            `).run(req.user.id, String(jobId));
          }
        }
        return res.json({ ok: true, ...result });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    } else {
      // Semi mode: launch and return immediately
      autoApply(jobUrl, autofillData, {
        mode: "semi", resumePath, jobId: jobIdStr, storageStatePath,
      }).catch(e => console.error("[apply semi]", e.message));

      return res.json({
        ok: true,
        status: "semi_launched",
        jobId: jobIdStr,
        message: "Browser launched with form pre-filled. Review fields and submit manually.",
      });
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
