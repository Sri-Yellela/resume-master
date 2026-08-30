import os from "os";
import crypto from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { autoApply, requestAbort, isAbortRequested, clearAbort, normaliseText } from "../services/applyAutomation.js";
import {
  readAnswerStore, resolveForCompany, effectiveCustomAnswers, companyKey,
} from "../services/customAnswers.js";
import {
  buildGatePacket, mintPacketToken, verifyPacketToken, hashToken, originOf,
  DEFAULT_TOKEN_TTL_MS,
  handoffKind, shouldBuildPacket, packetFreshness, PACKET_STALE_MS, HANDOFF_STATUSES,
} from "../services/applyGatePacket.js";
import {
  recordFormSchema, formSchemaSummary, hostOf,
} from "../services/kb/formSchemaLayer.js";
import { probeBrowserAvailability } from "../services/browserLauncher.js";
// AH5: the one definition of "is this stored resume still the right one". Shared with server.js's
// generateResumeForApply so the two reuse sites cannot drift apart again.
import { artifactCurrency, currencySentence } from "../services/resumeCurrency.js";
import { detectPlatformFromUrl } from "../services/platformDetector.js";
import { classifyRuntimeError } from "../shared/failureAttribution.js";
import { getAutomationReadiness, getMissingApplyPrerequisites } from "../services/integrationReadiness.js";
import { canUseAPlusResume, normalisePlanTier } from "../services/entitlements.js";
// TASK AC4: the three outcome groups of the dated history. In shared/ because the panel renders
// the same partition — a copy on each side is how "COMPLETED" comes to mean two things.
import { OUTCOME, OUTCOME_STATUSES, outcomeGroupFor } from "../shared/applyOutcomeGroups.js";
// AK1: the OTHER outcome axis — what the employer did, not what our pipeline did. The two are
// deliberately separate vocabularies; see the header of shared/applicationResponse.js.
import {
  RESPONSE_OUTCOMES, RESPONSE_OUTCOME, RESPONSE_LABELS, MATURITY_DAYS,
  mergeResponse, responseBucket, isResponse,
} from "../shared/applicationResponse.js";

// Must match services/applyAutomation.js SCREENSHOT_DIR — screenshot_path rows are absolute paths
// written by takeScreenshot(), and this is the only directory they are ever allowed to resolve into.
const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "screenshots");

// ── Gate-packet token secret (TASK G1) ───────────────────────────────────────────────────────
// Read from the environment here rather than threaded through applyRoutes()' already long parameter
// list, which server.js is the only caller of — adding an eighth positional argument for this would
// be a worse trade than one module-scope constant.
//
// Falls back to SESSION_SECRET because it is the secret this deployment already has and rotating it
// invalidates gate tokens, which is the correct blast radius. In production with neither set the
// value is empty and minting REFUSES: a run then still holds as held_gate with no packet, which is a
// visible degradation. Minting on a known-weak dev secret in production would be worse than that —
// the token unlocks a home address and eligibility answers.
const GATE_TOKEN_SECRET =
  process.env.APPLY_GATE_TOKEN_SECRET ||
  process.env.SESSION_SECRET ||
  (process.env.NODE_ENV === "production" ? "" : "dev-gate-token-secret-change-me");

/** Exchange attempts allowed per user per window. The endpoint returns a home address. */
const GATE_EXCHANGE_MAX_ATTEMPTS = 20;
const GATE_EXCHANGE_WINDOW_SEC = 10 * 60;

/**
 * AK1 — the ATS score to stamp on an application, and the scorer version that produced it.
 *
 * Reads an EXISTING report rather than scoring. Three sources, most-specific first:
 *   1. resumes.ats_report      — the generated document that was actually sent
 *   2. ats_only_reports        — the report the candidate saw on the board before applying
 *   3. scraped_jobs.ats_report — the scrape-time score against the base resume
 *
 * The version is read out of the stored report's own `source` field rather than from the current
 * LOCAL_ATS_SOURCE constant. Those two differ exactly when a cached report predates a scorer
 * change, which is the case the version column exists to keep straight — stamping today's version
 * onto a report produced by an older one would be the specific lie this field is meant to prevent.
 *
 * Returns nulls when nothing has scored this job. That is left as null: see the insert site.
 */
export function capturedAtsAtApply(db, userId, jobId) {
  const empty = { score: null, version: null, report: null };
  const pick = (row) => {
    if (!row?.ats_report) return null;
    let parsed;
    try { parsed = JSON.parse(row.ats_report); } catch { return null; }
    if (!parsed || typeof parsed !== "object") return null;
    // A report the scorer DECLINED carries no score, and an application against it records that
    // honestly rather than inventing one.
    if (parsed.score == null) return null;
    return { score: parsed.score, version: parsed.source || null, report: row.ats_report };
  };
  try {
    return pick(db.prepare("SELECT ats_report FROM resumes WHERE user_id=? AND job_id=?").get(userId, jobId))
      || pick(db.prepare("SELECT ats_report FROM ats_only_reports WHERE user_id=? AND job_id=?").get(userId, jobId))
      || pick(db.prepare("SELECT ats_report FROM scraped_jobs WHERE job_id=?").get(jobId))
      || empty;
  } catch {
    // Recording an application must never fail because a score could not be found for it.
    return empty;
  }
}

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
    // AK1 provenance. Exposed as a pair because a score without the scorer that produced it cannot
    // be compared with any other score — v3 and v4 disagree by roughly 17 points on the same fit.
    atsScoreAtApply: row.ats_score_at_apply ?? null,
    atsScorerVersion: row.ats_scorer_version ?? null,
    // AK1 — the employer's half of the pair.
    responseOutcome: row.response_outcome ?? null,
    furthestStage: row.furthest_stage ?? null,
    firstResponseAt: row.first_response_at ?? null,
    outcomeAt: row.outcome_at ?? null,
    // Derived, not stored: "nothing recorded" means different things at 2 days and at 2 months, and
    // a caller that had to work that out itself would get it wrong the same way a naive query does.
    responseBucket: responseBucket(row),
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

    // AK1 — stamp the score that was true WHEN THE APPLICATION WENT OUT.
    //
    // Read from whichever report already exists rather than scoring here: this endpoint records an
    // application the candidate has already sent, so the number that matters is the one they saw,
    // and re-deriving it would answer a different question. The generated resume's report wins over
    // the scrape-time one because it describes the document actually submitted.
    //
    // NULL IS AN HONEST ANSWER AND IS LEFT AS NULL. Manual applications to jobs that were never
    // scored have no score; writing 0 would put a fabricated data point into the only dataset that
    // can ever validate this number.
    const atStamp = capturedAtsAtApply(db, req.user.id, resolvedJobId);
    db.prepare(`
      INSERT INTO job_applications
        (user_id, job_id, company, role, job_url, source, location, apply_mode, resume_file, applied_at, notes, auto_status,
         ats_score_at_apply, ats_scorer_version, ats_report_at_apply, ats_scored_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?, unixepoch(), ?, 'manual', ?, ?, ?, ?)
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
        auto_status='manual',
        -- COALESCE keeps the FIRST stamp. Re-recording an application must not overwrite the score
        -- that was true when it was actually sent with today's, which is the whole point of the
        -- column: the pair being collected is (score at the time, outcome), not (score now, outcome).
        ats_score_at_apply=COALESCE(job_applications.ats_score_at_apply, excluded.ats_score_at_apply),
        ats_scorer_version=COALESCE(job_applications.ats_scorer_version, excluded.ats_scorer_version),
        ats_report_at_apply=COALESCE(job_applications.ats_report_at_apply, excluded.ats_report_at_apply),
        ats_scored_at=COALESCE(job_applications.ats_scored_at, excluded.ats_scored_at)
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
      atStamp.score,
      atStamp.version,
      atStamp.report,
      atStamp.score == null ? null : Math.floor(Date.now() / 1000),
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

  // ── AK1: recording what the employer did ─────────────────────────────────────
  //
  // NO UI CONSUMES THIS YET. Nothing in client/src reads /api/apply/applications, so this is an
  // API-only surface today and outcomes have to be recorded by a caller. That is stated rather than
  // papered over: the alternative was building an applications view that does not exist, which is a
  // much larger piece of work than the field this completes. The data cannot be backfilled later —
  // that is the entire reason for adding it now — so the recording path exists ahead of the screen.
  app.patch("/api/apply/applications/:jobId/response", requireAuth, (req, res) => {
    const { outcome = null, respondedAt = null, source = "manual" } = req.body || {};
    if (outcome != null && !RESPONSE_OUTCOMES.includes(outcome)) {
      return res.status(400).json({
        error: `unknown outcome "${outcome}"`,
        allowed: RESPONSE_OUTCOMES,
      });
    }
    const jobId = String(req.params.jobId);
    const existing = db.prepare("SELECT * FROM job_applications WHERE user_id=? AND job_id=?")
      .get(req.user.id, jobId);
    // Scoped AND checked. A 404 for a job this user has not applied to is the same answer as for
    // one that does not exist, so the endpoint cannot be used to probe another user's history.
    if (!existing) return res.status(404).json({ error: "No application recorded for that job" });

    let merged;
    try {
      merged = mergeResponse(existing, { outcome, respondedAt, source });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    db.prepare(`
      UPDATE job_applications
         SET response_outcome=?, furthest_stage=?, first_response_at=?, outcome_at=?, outcome_source=?
       WHERE user_id=? AND job_id=?
    `).run(
      merged.response_outcome, merged.furthest_stage, merged.first_response_at,
      merged.outcome_at, merged.outcome_source, req.user.id, jobId,
    );

    const row = db.prepare("SELECT * FROM job_applications WHERE user_id=? AND job_id=?")
      .get(req.user.id, jobId);
    res.json({ ok: true, application: publicApplication(row) });
  });

  /**
   * AK1 — does the ATS score predict a response?
   *
   * The endpoint that makes the pair worth having. It exists so that the question is asked with the
   * maturity window and the scorer-version split already applied, rather than by whoever writes the
   * first ad-hoc query and forgets both.
   *
   * READ THE CAVEATS IT RETURNS. They are part of the response, not documentation:
   *   - Applications younger than MATURITY_DAYS with nothing recorded are UNRESOLVED and are in no
   *     denominator. Counting them as silence is what makes an early response rate read near zero.
   *   - Scores are grouped BY SCORER VERSION and never pooled across one. v3 and v4 disagree by
   *     roughly 17 points on the same fit, so a pooled correlation would be confident and meaningless.
   *   - `sufficient` is false until there is enough data to say anything. n is zero today.
   */
  app.get("/api/apply/response-correlation", requireAuth, (req, res) => {
    const rows = db.prepare(`
      SELECT applied_at, ats_score_at_apply, ats_scorer_version,
             response_outcome, furthest_stage, first_response_at
        FROM job_applications
       WHERE user_id=? AND ats_score_at_apply IS NOT NULL
    `).all(req.user.id);

    const byVersion = new Map();
    let unresolved = 0;
    for (const r of rows) {
      const bucket = responseBucket(r);
      if (bucket === "unresolved") { unresolved++; continue; }
      const key = r.ats_scorer_version || "unknown";
      if (!byVersion.has(key)) byVersion.set(key, { responded: [], silent: [] });
      byVersion.get(key)[bucket === "responded" ? "responded" : "silent"].push(r.ats_score_at_apply);
    }

    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const versions = [...byVersion.entries()].map(([version, g]) => {
      const n = g.responded.length + g.silent.length;
      const mr = mean(g.responded);
      const ms = mean(g.silent);
      return {
        scorerVersion: version,
        n,
        responded: g.responded.length,
        silent: g.silent.length,
        responseRate: n ? Number((g.responded.length / n).toFixed(4)) : null,
        meanScoreResponded: mr == null ? null : Number(mr.toFixed(2)),
        meanScoreSilent: ms == null ? null : Number(ms.toFixed(2)),
        // The headline: do applications that scored higher get more replies? Positive means yes.
        scoreDelta: (mr == null || ms == null) ? null : Number((mr - ms).toFixed(2)),
        // Deliberately conservative. Below this, a delta is noise and reporting it invites exactly
        // the confident-and-wrong conclusion this whole task was about avoiding.
        sufficient: g.responded.length >= 20 && g.silent.length >= 20,
      };
    });

    res.json({
      maturityDays: MATURITY_DAYS,
      totalWithScore: rows.length,
      unresolved,
      versions,
      // No caller should have to know to look for these.
      caveats: [
        `Applications younger than ${MATURITY_DAYS} days with no recorded outcome are excluded as unresolved (${unresolved} of ${rows.length}).`,
        "Scores are never pooled across scorer versions — the scale changed between them.",
        "A version with sufficient:false has too little data to support any conclusion.",
      ],
    });
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
  /**
   * The ceiling on queue attempts per 24h — the limit that bounds MODEL SPEND rather than
   * submissions. See queuedLast24h() for why APPLY_DAILY_CAP could not do this job.
   *
   * 40, not 25. It has to sit ABOVE APPLY_DAILY_CAP: every submission needs a queue first, so a
   * queue cap at or below the submission cap would make the submission cap unreachable. The 15 of
   * headroom is for the legitimate re-queues — the answers path and a retry after a hold both come
   * back through startRun and each is a fresh generation.
   *
   * It is deliberately NOT generous. At two model calls per queued job (resume + cover letter),
   * 40 is already ~80 calls a day for one user, and the cheapest way to spend money in this
   * product is to queue jobs nobody ever approves.
   */
  const APPLY_DAILY_QUEUE_CAP = envInt("APPLY_DAILY_QUEUE_CAP", 40);
  /**
   * The score at or above which an application is sent UNATTENDED. Below it the job is not
   * discarded — it becomes held_review with an early handoff, so the candidate still gets to send
   * it by hand.
   *
   * 65 -> 50, AND CONFIGURABLE. Two reasons, one of which is a correction:
   *
   * 65 was calibrated against a scorer that has since been fixed. The old ATS report mined 1-3 word
   * windows out of the job description and counted every sentence fragment it produced as a MISSING
   * skill, so the denominator was full of terms no resume could ever match and every score was
   * pushed down. Across 1291 real postings the corrected scorer gives median 48, p75 54, p90 61 —
   * and at 65 only 6% of postings could ever auto-send. A gate that holds 94% of everything is not
   * a safety threshold, it is an off switch nobody chose.
   *
   * 50 sits just above that median: roughly average-or-better matches go unattended (44%), the rest
   * queue for a human. It is a deliberate throughput decision, made by the owner with the
   * distribution in front of them, not a number inherited from a broken scale.
   *
   * ── AK1: 50 -> 30, BECAUSE THE SCALE MOVED, NOT BECAUSE THE POLICY DID ──
   *
   * The scorer was rebalanced (local_ats_v4): skills carry 70 of the 100 points instead of 50,
   * experience is graded instead of a 17-point cliff, and hard constraints only subtract — v3 paid
   * ~33 points for the mere absence of a detected problem, which is what held the floor near 30.
   * Re-measured over the same 1291 postings with a realistic engineering resume, v4 gives
   * median 28, p75 32, p90 38, max 63 — against v3's median 45.
   *
   * At 50 on the v4 scale, roughly 2% of postings could auto-send rather than the 44% the paragraph
   * above chose deliberately. That is a throughput regression rather than a safety one — the gate
   * was holding almost everything — but it is still a number that no longer means what it was set
   * to mean.
   *
   * 30 restores the STATED INTENT, unchanged: "just above the median, roughly average-or-better
   * goes unattended, the rest queue for a human". Against a v4 median of 28 and p75 of 32, 30 sits
   * exactly where 50 sat against v3's median of 45. The policy is the same policy; only the scale
   * underneath it moved.
   *
   * THIS SENDS MORE APPLICATIONS UNATTENDED THAN 50 DID, and that is the point — 50 on this scale
   * is an off switch nobody chose, which is the same failure the 65 -> 50 note above describes.
   * The owner adopted 30 explicitly after the redistribution was measured.
   *
   * RE-MEASURE BEFORE MOVING IT AGAIN. That distribution is for ONE profile and one resume, and it
   * moves with both — see the note below. The distribution and the inversion analysis behind this
   * number are in docs/ak1-ats-ranking.md.
   *
   * Configurable because the comment above says every limit here is; this one was the exception,
   * and it is the one most likely to want tuning as the scorer or the candidate's profile changes.
   * It is also candidate-specific — that distribution was measured for one profile.
   *
   * Nothing here relaxes what may be SAID: services/resumeClaimGuard.js still refuses an artifact
   * that overstates years or seniority, before it can be persisted or sent.
   *
   * NOTE ON 0: envInt only accepts n > 0, so ATS_AUTO_APPLY_THRESHOLD=0 falls back to the default
   * rather than meaning "send everything". That is the shared behaviour of every limit here and it
   * is the safe direction to be wrong in, but it does mean the gate cannot be switched off this
   * way — use the kill switch (app_settings.apply_full_auto_disabled) to stop unattended sending.
   */
  const ATS_AUTO_APPLY_THRESHOLD = envInt("ATS_AUTO_APPLY_THRESHOLD", 30);
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

  /**
   * Queue attempts that can TRIGGER GENERATION, for this user, in the trailing 24h.
   *
   * WHY THIS EXISTS ALONGSIDE submittedLast24h. APPLY_DAILY_CAP counts status='submitted', and
   * since an 'auto' run now PREVIEWS by default (approval_mode='required'), nothing reaches
   * 'submitted' until a human approves. So `used` sat at 0 essentially always and the admission
   * check read `0 + N > 25` — which 25 jobs pass, and passes again on the next run, and the next.
   * APPLY_MAX_ACTIVE_RUNS only serialises runs; it is a rate limiter, not a ceiling.
   *
   * Meanwhile processRunJob spends money per job at QUEUE time, not at submit time: a preview runs
   * generateResumeForApply AND generateCoverLetterForApply and stops short only of the click. So
   * the one cost that scales with queueing was the one cost nothing bounded.
   *
   * COUNTS ROWS, NOT SUBMISSIONS, and counts them by created_at regardless of what status they
   * reached — a job that generated and then held for review cost exactly as much as one that
   * submitted, so for this purpose they are the same event.
   *
   * EXCLUDES approval_mode='approved' RUNS. That is the run the approve endpoint creates to send an
   * already-previewed application, and it reuses the artifact the preview just generated
   * (artifactCurrency finds it current, CASE A) rather than generating again. Counting it would
   * make the normal flow cost two against the cap per application and turn this guard into a
   * refusal to submit work the user has already reviewed — the opposite of the intent.
   */
  function queuedLast24h(userId) {
    try {
      return db.prepare(`
        SELECT COUNT(*) AS n
        FROM apply_run_jobs rj
        JOIN apply_runs r ON r.id = rj.run_id
        WHERE rj.user_id=?
          AND COALESCE(r.approval_mode, '') != 'approved'
          AND COALESCE(rj.created_at, 0) >= unixepoch() - 86400
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
    // 088, AF5's campaign record. Resolved against the live schema like the rest, so a missing one
    // costs only itself.
    "fields_discovered",
    // 091, AH5's fill log. The BLANK half of what the run did — answers_json has always held the
    // filled half. Without it the record could say "7 fields filled" and nothing about the rest.
    "blanks_json",
  ];

  // corrections_json is written OUTSIDE persistAudit — the human's edits arrive after the audit row
  // is complete — so it needs its own presence check.
  let correctionsColumnCache = null;
  function canRecordCorrections() {
    if (correctionsColumnCache !== null) return correctionsColumnCache;
    let present = false;
    try {
      present = db.prepare("PRAGMA table_info(apply_run_jobs)").all().some(c => c.name === "corrections_json");
    } catch (e) {
      console.warn("[applyRoutes] could not read apply_run_jobs schema:", e.message);
    }
    if (!present) {
      console.warn(
        "[applyRoutes] CAMPAIGN RECORD DEGRADED — apply_run_jobs is missing corrections_json. " +
        "Hand corrections will not be recorded; run migrations (088 adds it). The application is unaffected."
      );
    }
    correctionsColumnCache = present;
    return present;
  }
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

  // ── Gate packets (TASK G1) ───────────────────────────────────────────────────
  // Persisted when a run observes a login wall or a CAPTCHA. The packet is everything already
  // decided, waiting for the human who will cross that gate.
  //
  // NO TOKEN IS MINTED HERE, deliberately, and this departs from §3's step ordering. A token with a
  // minutes-long TTL — which requirement 3 asks for, because it unlocks a home address and
  // eligibility answers — minted when the gate is observed would be expired long before the
  // candidate reads the notification and clicks Review. Either the TTL becomes hours, or the token is
  // minted on demand. Minting on demand is the one that keeps the short TTL meaningful, so the row is
  // created with a placeholder hash that no real token can ever match and an already-past expiry,
  // meaning "no outstanding token" until /token is called.
  const GATE_PACKET_NO_TOKEN = () => `unminted:${crypto.randomUUID()}`;

  function createGatePacket({ runId, runJobId, userId, jobId, result, autofillPayload, resumeArtifactId,
                             reasonCode, jobUrl }) {
    // Where the human has to go, most-specific first:
    //   gate.applyUrl   the URL a gate was observed at — a gated portal redirects to a sign-in on
    //                   the way, so this is not what the run was queued with.
    //   landedUrl       AB1: the URL a HELD form was actually on. A held review had neither of the
    //                   two above, which is precisely why it never got a packet and so had no route
    //                   to submission.
    //   jobUrl          the posting's own apply link, as a floor.
    const applyUrl = result.gate?.applyUrl || result.landedUrl || result.gate?.startedFrom || jobUrl || null;
    let packet;
    try {
      packet = buildGatePacket({
        resolvedAnswers: result.answers,
        autofillPayload,
        applyUrl,
        jobId, runId, runJobId,
        resumeArtifactId,
        // The row's OWN reason, not a default of "login_required": the reason is what tells the
        // panel whether this packet amortises across a portal or belongs to one application, and
        // mislabelling a held review as a login wall would put it in the wrong group and promise
        // that a sign-in clears it.
        gateReason: reasonCode || result.reasonCode || "login_required",
      });
    } catch (e) {
      // buildGatePacket refuses in exactly two cases, and both leave the run held with no packet —
      // a degraded handoff, which is the honest outcome:
      //   gate_packet_unparseable_url  no expected origin, so it could only be released by trusting
      //                                whatever page it landed on.
      //   gate_packet_no_answers       nothing to fill, so "Open & fill" would promise work that
      //                                cannot happen (AE2).
      logEvent(runId, runJobId, userId, jobId, "gate_packet_failed",
        "Could not prepare a handoff packet for this gate", { reasonCode: e.reasonCode || null, error: e.message });
      return null;
    }

    try {
      const ins = db.prepare(`
        INSERT INTO apply_gate_packets
          (user_id, run_id, run_job_id, job_id, apply_url, expected_origin, gate_reason,
           answers_json, resume_artifact_id, token_hash, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(userId, runId, runJobId, String(jobId), packet.applyUrl, packet.expectedOrigin,
             packet.gateReason, JSON.stringify(packet), resumeArtifactId, GATE_PACKET_NO_TOKEN());

      const packetId = Number(ins.lastInsertRowid);
      // Counts, origins and provenance mix — never a value, and never a token. This event is the
      // durable record that a handoff was prepared, and it lands in the same log the rest of the
      // audit trail uses.
      logEvent(runId, runJobId, userId, jobId, "gate_packet_created",
        `Handoff packet prepared: ${packet.answers.length} answer(s) ready, ${packet.unresolved.length} for you to answer`, {
          packetId,
          gateReason:      packet.gateReason,
          expectedOrigin:  packet.expectedOrigin,
          source:          packet.source,
          answerCount:     packet.answers.length,
          unresolvedCount: packet.unresolved.length,
          eligibilityCount: packet.answers.filter(a => a.eligibility).length,
          provenanceMix:   packet.answers.reduce((m, a) => { m[a.provenance ?? "none"] = (m[a.provenance ?? "none"] || 0) + 1; return m; }, {}),
          resumeArtifactId,
        });
      return { packetId, packet };
    } catch (e) {
      // Never let a packet failure change the run's outcome: the job is held either way, and a held
      // job with no packet is a degraded handoff rather than a lost application.
      logEvent(runId, runJobId, userId, jobId, "gate_packet_failed",
        "Handoff packet could not be stored", { error: e.message });
      console.warn("[applyRoutes] gate packet insert failed:", e.message);
      return null;
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
    // AH5: whether this run reused the candidate's existing resume or rebuilt it, and why. Read
    // back by the fill log, so "no regeneration happened" is a fact the surface can state rather
    // than something the candidate has to trust.
    let reuseDecision  = null;
    // Set when resume generation fails, so the run's terminal reason can name GENERATION rather
    // than inheriting whatever failed last. Resume generation runs in parallel with the browser,
    // so without this the browser's outcome silently wins the attribution race.
    let genFailure = null;

    /**
     * Write a terminal status — unless the user has ABORTED this run-job (TASK AC4).
     *
     * `AND status != 'cancelled'` is the whole guard, and it has to be in the WHERE clause rather
     * than in a read-then-write: the abort endpoint and this worker are different call stacks, and
     * a check followed by an update loses the race the guard exists to win. better-sqlite3 is
     * synchronous, so one statement is one atomic decision.
     *
     * Without it, aborting mid-flight closes the browser, the run throws, the catch writes 'failed',
     * and the row the user just stopped comes back as a failure with a Retry button on it.
     */
    const setJobStatus = (status, reasonCode = null, reasonDetail = null) => {
      db.prepare(`
        UPDATE apply_run_jobs
        SET status=?, reason_code=?, reason_detail=?, finished_at=unixepoch()
        WHERE id=? AND status != 'cancelled'
      `).run(status, reasonCode, reasonDetail, runJobId);
    };

    try {
      // Aborted between being queued and being picked up. processRun snapshots the queued rows
      // before it starts launching them, so a job cancelled in that window is still in its list —
      // and would otherwise open a browser and fill a real employer's form after the user stopped
      // it. The abort endpoint has already written 'cancelled'; this just declines to undo it.
      const beforeStart = db.prepare("SELECT status FROM apply_run_jobs WHERE id=?").get(runJobId);
      if (beforeStart?.status === "cancelled") {
        logEvent(runId, runJobId, userId, jobId, "run_job_cancelled",
          "Cancelled before it started. Nothing was opened and nothing was submitted.");
        return;
      }
      db.prepare(`UPDATE apply_run_jobs SET status='running', started_at=unixepoch() WHERE id=? AND status != 'cancelled'`).run(runJobId);

      const job = db.prepare("SELECT * FROM scraped_jobs WHERE job_id=?").get(String(jobId));
      if (!job) { setJobStatus("failed", "job_not_found", "Job not found in DB"); return; }

      const jobUrl = job.apply_url || job.url;
      if (!jobUrl) { setJobStatus("failed", "no_job_url", "Job has no apply URL"); return; }

      /**
       * Park a handoff for a hold that RETURNS EARLY, before the browser ever runs (AB1).
       *
       * Six holds below never reach the main terminal path: the provider is out of v1 scope, the
       * kill switch is on, the daily cap is spent, the resume scored under the floor, generation
       * failed. Every one of them is a held_review whose intended route is the human — and every one
       * of them used to leave the candidate a row with nothing on it but a reason, because the
       * packet was built only at the end of a browser run they never got.
       *
       * A profile-only packet is exactly the case buildGatePacket was designed for: no form was
       * reached, so it resolves the canonical question set against the profile and reports what it
       * could not answer, rather than inventing provenance. That is the same thing a login wall
       * produces, and it is enough to fill a name, an address and eligibility answers in the
       * candidate's own browser.
       *
       * Never allowed to change the outcome: the hold has already been written, and a packet failure
       * is a degraded handoff rather than a lost application.
       */
      const parkEarlyHandoff = (reasonCode) => {
        try {
          db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(userId);
          const p = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(userId);
          createGatePacket({
            runId, runJobId, userId, jobId,
            result: {}, autofillPayload: buildAutofillPayload(p, "APPLY", job?.company),
            resumeArtifactId: usedArtifactId, reasonCode, jobUrl,
          });
        } catch (e) {
          console.warn("[applyRoutes] early handoff packet failed:", e.message);
        }
      };

      // v1 provider scope: only greenhouse/lever/ashby get full-auto; others fall to held_review.
      // Re-checked per job, not just at admission: a run can cross the daily cap mid-flight, and
      // the kill switch can be flipped while a run is in progress. Both HOLD the job with a
      // reasonCode — visible in /api/apply/review — rather than dropping it silently.
      if (mode === "auto" && fullAutoDisabled()) {
        logEvent(runId, runJobId, userId, jobId, "full_auto_disabled",
          "Full-auto submission is disabled; holding for manual review");
        setJobStatus("held_review", "full_auto_disabled", "Automatic submission is currently disabled");
        db.prepare(`UPDATE apply_runs SET held_count=held_count+1 WHERE id=?`).run(runId);
        parkEarlyHandoff("full_auto_disabled");
        return;
      }
      if (mode === "auto") {
        const usedToday = submittedLast24h(userId);
        if (usedToday >= APPLY_DAILY_CAP) {
          logEvent(runId, runJobId, userId, jobId, "daily_cap_reached",
            `Daily cap reached: ${usedToday} of ${APPLY_DAILY_CAP} in the last 24h`, { submittedLast24h: usedToday, limit: APPLY_DAILY_CAP });
          setJobStatus("held_review", "daily_cap_reached", `Daily application cap (${APPLY_DAILY_CAP}) reached`);
          db.prepare(`UPDATE apply_runs SET held_count=held_count+1 WHERE id=?`).run(runId);
          parkEarlyHandoff("daily_cap_reached");
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
          parkEarlyHandoff("provider_review_only");
          return;
        }
      }

      db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(userId);
      const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(userId);
      // The employer is passed so `{company}`-templated custom answers resolve for THIS company.
      const autofillPayload = buildAutofillPayload(profile, "APPLY", job?.company);

      /**
       * AF5's correction record. A semi run returns while the browser is still open, so the human's
       * edits arrive AFTER the audit block below has already written the row — which is why this
       * writes on its own, once per reported change, last-write-wins.
       *
       * Guarded on the column existing for the same reason the override column is: an un-migrated
       * deployment must lose the campaign note, not the application.
       */
      const recordCorrections = (corrections) => {
        if (!Array.isArray(corrections) || !canRecordCorrections()) return;
        try {
          db.prepare("UPDATE apply_run_jobs SET corrections_json=? WHERE id=?")
            .run(corrections.length ? JSON.stringify(corrections) : null, runJobId);
          logEvent(runId, runJobId, userId, jobId, "corrections_observed",
            `${corrections.length} field(s) corrected by hand`,
            { corrections: corrections.map(c => ({
                field: c.field, provenance: c.provenance, confidence: c.confidence })) });
        } catch (e) {
          console.warn(`[applyRoutes] correction record failed job=${jobId}: ${e.message}`);
        }
      };

      const toolType = run.tool_type || "generate";

      /**
       * AH5: reuse what the candidate already generated — but only while it is still CURRENT.
       *
       * This used to be its own `SELECT ... FROM resumes ORDER BY updated_at DESC`, a second query
       * with no rule beside generateResumeForApply's. Both reused unconditionally, so an artifact
       * built under a different job profile, or from a base resume the candidate had since
       * rewritten, was sent to an employer with nothing saying so. services/resumeCurrency.js is
       * now the one definition; a stale artifact falls through to CASE B/C, which regenerate.
       *
       * The decision is LOGGED either way. "Queued a job I already generated for and it
       * regenerated" and "it reused a resume I had replaced" are both things the candidate can only
       * find out if the run says so.
       */
      const currency = artifactCurrency(db, { userId, jobId, tool: toolType });
      reuseDecision = { reused: currency.current, reason: currency.reason, detail: currency.detail ?? null };
      logEvent(runId, runJobId, userId, jobId,
        currency.current ? "resume_reused" : "resume_regenerating",
        currencySentence(currency), reuseDecision);
      const artifact = currency.current ? currency.artifact : null;

      let result;

      if (artifact?.html) {
        // CASE A: a current artifact — ATS gate, then PDF convert and apply
        usedArtifactId = artifact.id ?? null;
        usedAtsScore   = artifact.ats_score ?? null;
        const atsScore = artifact.ats_score ?? null;
        // AK1 — AN UNKNOWN SCORE MUST HOLD, NOT PASS.
        //
        // This gate used to read `atsScore !== null && atsScore < THRESHOLD`, so a null score fell
        // through and auto-submitted. That was already wrong for a never-scored artifact, and it
        // became actively dangerous once the scorer gained the ability to DECLINE (returning null
        // when there is too little signal to judge): the one case where the engine says "I cannot
        // tell you if this is a good fit" was the one case that skipped the gate and applied on the
        // candidate's behalf. An auto-submit gate may only open on a score it has actually seen.
        if (mode === "auto" && (atsScore === null || atsScore < ATS_AUTO_APPLY_THRESHOLD)) {
          logEvent(runId, runJobId, userId, jobId, "ats_review",
            atsScore === null
              ? "Held: no ATS score for this artifact — auto-apply does not submit on an unknown score"
              : `ATS score ${atsScore} below threshold`,
            { atsScore });
          db.prepare(`UPDATE apply_run_jobs SET status='held_review', reason_code='ats_below_threshold', finished_at=unixepoch() WHERE id=?`).run(runJobId);
          db.prepare(`UPDATE apply_runs SET held_count=held_count+1 WHERE id=?`).run(runId);
          // Held on the score before the browser ran. The candidate may well decide to send it
          // anyway, so they get a handoff rather than a dead row.
          parkEarlyHandoff("ats_below_threshold");
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
          onCorrections: recordCorrections,
        });

      } else if (mode === "semi") {
        // CASE B: no artifact + semi (manual review) mode
        // Generation and browser run in parallel; browser starts immediately in semi mode
        // so the user can review the pre-filled form while generation completes in the background.
        logEvent(runId, runJobId, userId, jobId, "generation_started", "Starting resume generation in background");
        const genPromise = generateResumeForApply(userId, jobId, toolType).then(async (gen) => {
          if (!gen?.html) {
            // Was silent: a semi run whose generation failed looked identical to one that
            // succeeded, because neither recorded anything about the resume.
            genFailure = {
              reasonCode: gen?.errorCode || "generation_failed",
              detail: gen?.errorDetail || gen?.error || "Resume generation returned no HTML",
              permanent: gen?.errorPermanent ?? null,
            };
            logEvent(runId, runJobId, userId, jobId, "generation_failed",
              gen?.errorDetail || gen?.error || "Resume generation returned no HTML");
            return null;
          }
          // CASE A and CASE C both recorded which artifact they used; this branch never did, so the
          // review surface reported "no resume generated" for a resume that generateResumeForApply
          // had in fact written to the `resumes` table. The resume existed — the link to it did not.
          usedArtifactId = gen.resumeId ?? null;
          usedAtsScore   = gen.atsScore ?? null;
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
          onCorrections: recordCorrections,
        });
        const [,, applySettled] = await Promise.allSettled([genPromise, coverLetterPathPromise, browserPromise]);
        result = applySettled.status === "fulfilled" ? applySettled.value : { status: "awaiting_user", fieldsFilled: 0 };
        db.prepare(`UPDATE apply_run_jobs SET status='held_review', reason_code='manual_review', finished_at=unixepoch() WHERE id=?`).run(runJobId);

        // This branch used to return here, before the audit block below — so a manual-review run
        // discarded everything it had just produced: the resolved answers WITH their provenance,
        // the resume artifact id, and the screenshot of the filled form. autoApply returns all
        // three; nothing read them. That is why the review surface could say "7 fields filled"
        // and then show nothing about WHICH fields, offer no resume, and offer no way to see what
        // the form looked like. The evidence was captured and thrown away.
        const semiAnswers = Array.isArray(result.answers) ? result.answers : [];
        const semiAudit = persistAudit(runJobId, {
          answers_json: semiAnswers.length ? JSON.stringify(semiAnswers) : null,
          resume_artifact_id: usedArtifactId,
          resume_ats_score: usedAtsScore,
          screenshot_path: result.screenshotPath || null,
          // Nothing was submitted — this run exists so a human can decide. Recording 0 rather than
          // null keeps "reviewed, not sent" distinguishable from "we have no idea".
          submit_verified: 0,
          submit_evidence: null,
          open_questions_json: Array.isArray(result.openQuestions) && result.openQuestions.length
            ? JSON.stringify(result.openQuestions) : null,
          // AH5: semi is the mode this task is about — the run returns with the browser open and
          // the candidate reading the form, so the record of what was left blank is the whole
          // value of the run.
          blanks_json: Array.isArray(result.blanks) ? JSON.stringify(result.blanks) : null,
          fields_discovered: Number.isFinite(result.fieldsDiscovered) ? result.fieldsDiscovered : null,
        });
        // ── AE6: SAY WHAT IS STILL THEIRS TO ANSWER ────────────────────────────────────────
        // A semi run runs neither the completeness gate nor the low-confidence gate, so the human's
        // reading of the form is the only check there is. That is a defensible product decision;
        // being SILENT about it is not. autoApply now returns `missingRequired` on a semi result —
        // an empty array meaning "we checked and nothing is outstanding", which is a different fact
        // from the field being absent — so the run's own event states the count rather than
        // reporting "Autofilled 7 fields" over a form that cannot be submitted.
        const semiMissing = Array.isArray(result.missingRequired) ? result.missingRequired : null;
        logEvent(runId, runJobId, userId, jobId, "autofill_done",
          `Autofilled ${result.fieldsFilled ?? 0} fields` +
          (semiMissing === null ? ""
            : semiMissing.length
              ? ` — ${semiMissing.length} required field${semiMissing.length === 1 ? " is" : "s are"} yours to answer`
              : " — no required field is left blank"), {
            platform: result.platform,
            answerCount: semiAnswers.length,
            // Recorded even when zero: the count is the claim, and an absent key is how this went
            // unnoticed in the first place.
            missingRequiredCount: semiMissing === null ? null : semiMissing.length,
            missingRequired: semiMissing,
            resumeArtifactId: usedArtifactId,
            screenshotPath: result.screenshotPath || null,
            columnsWritten: semiAudit.written,
          });
        db.prepare(`UPDATE apply_runs SET held_count=held_count+1 WHERE id=?`).run(runId);
        // The manual-review branch returns here, so it never reached the packet built at the end of
        // the main path — the one hold most obviously meant to be finished by a human was the one
        // with no route to finishing it. Unlike the early holds above this DID reach the form, so it
        // hands off the real resolved answers and the URL the form was actually on, not the
        // canonical profile set.
        if (shouldBuildPacket({ status: "held_review", reasonCode: "manual_review" })) {
          createGatePacket({
            runId, runJobId, userId, jobId, result, autofillPayload,
            resumeArtifactId: usedArtifactId, reasonCode: "manual_review", jobUrl,
          });
        }
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
            // Remember WHY there is no resume. Without this, the run ends with only "no resume
            // path" and the terminal status gets attributed to whatever failed last — which is
            // how an Anthropic 404 came to be reported as "browser error".
            genFailure = {
              reasonCode: gen.errorCode || "generation_failed",
              detail: gen.errorDetail || `Generation failed: ${gen.error}`,
              permanent: gen.errorPermanent ?? null,
            };
            logEvent(runId, runJobId, userId, jobId, "generation_failed",
              gen.errorDetail || `Generation failed: ${gen.error}`);
            return null;
          }
          logEvent(runId, runJobId, userId, jobId, "generation_ready", "Resume generated", { atsScore: gen.atsScore });
          usedArtifactId = gen.resumeId ?? null;
          usedAtsScore   = gen.atsScore ?? null;
          // AK1: the scorer may now DECLINE to score (null) when the posting or the resume carries
          // too little signal to judge. That is not a zero. Both outcomes hold the job for review —
          // the gate must never auto-submit on an unknown — but they are logged differently,
          // because "Score 0 below threshold" for a job that was never scored sends whoever reads
          // the run history looking for a resume problem that does not exist.
          const unscorable = gen.atsScore == null;
          const atsScore = gen.atsScore ?? 0;
          logEvent(runId, runJobId, userId, jobId, "ats_review",
            unscorable ? "ATS score: not enough signal to score" : `ATS score: ${atsScore}`,
            { atsScore: gen.atsScore ?? null });
          if (unscorable || atsScore < ATS_AUTO_APPLY_THRESHOLD) {
            logEvent(runId, runJobId, userId, jobId, "ats_below_threshold",
              unscorable
                ? "Held: not enough signal to score this posting against the resume"
                : `Score ${atsScore} below threshold ${ATS_AUTO_APPLY_THRESHOLD}`);
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
      // A generation failure is a HOLD, not a crash. The old mapping only reached "held_review"
      // via the browser's own status, so when generation died and the browser later threw for any
      // reason, the run was filed as "failed / browser error" — pointing at the one subsystem that
      // had worked. This does NOT widen the submit gate: only reason_code 'awaiting_approval' rows
      // are releasable by the approve endpoints, so a generation_failed hold can never be
      // approved into a submission.
      // A gated portal gets its OWN terminal status rather than landing in held_review's fallback,
      // which is where it used to end up: reason_code 'login_required' on a held_review row made a
      // job whose form was never reached indistinguishable, to every status='held_review' query, from
      // one that was filled and needs three answers checked. See the G1 decision in §8.
      const gated = result.status === "held_gate";
      // TASK AC4: an aborted run reports `cancelled`, and it outranks everything below it — a run
      // the user stopped is not "held for review" and not a failure. autoApply returns this only
      // from its abort checkpoints, so it can never be reached by a run that submitted.
      const cancelled = result.status === "cancelled";
      const finalStatus = cancelled ? "cancelled"
        : submitted ? "submitted"
        : genFailure ? "held_review"
        : gated ? "held_gate"
        : previewed || atsHeld || result.status === "awaiting_user" ? "held_review"
        : result.status === "error" ? "failed"
        : "held_review";
      // result.reasonCode now takes precedence so `submit_unverified` — a submit button was
      // clicked and nothing happened — is not flattened into the much milder "no_submit_button".
      //
      // `atsHeld` used to hardcode "ats_below_threshold" here, which OVERWROTE the reason
      // autoApply had already worked out. The pre-submit gate returns ats_held with
      // reasonCode "resume_unavailable" whenever there is no resume to upload — so a run whose
      // generation crashed was reported as "ATS score below threshold", a completely different
      // diagnosis pointing at the scorer instead of at the generator. The gate's own reason wins.
      //
      // A generation failure outranks all of it: when generation is why we are not submitting,
      // that is the fact worth reporting, not the browser's or the scorer's downstream symptom.
      const reasonCode = cancelled ? (result.reasonCode || "user_aborted")
        : submitted ? null
        : genFailure ? genFailure.reasonCode
        : atsHeld ? (result.reasonCode || "ats_below_threshold")
        : previewed ? "awaiting_approval"
        : result.status === "awaiting_user" ? "manual_review"
        : result.reasonCode
          || (result.status === "filled_not_submitted" ? "no_submit_button" : null);

      // Preserve the upstream failure (404 body, error type, request_id) on the row, and say
      // plainly whether a retry can ever work — "permanent" means the same call fails identically.
      const reasonDetail = genFailure ? genFailure.detail : result.reasonDetail;
      const fallbackUrl = isBrowserFailure(reasonCode) ? jobUrl : null;
      setJobStatus(finalStatus, reasonCode, reasonDetail || (fallbackUrl ? `fallbackUrl:${fallbackUrl}` : null));

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
        // AF5: the denominator for "N fields filled". Null rather than 0 when the run never got to
        // discovery — "we did not look" and "we looked and found nothing" are different facts.
        fields_discovered: Number.isFinite(result.fieldsDiscovered) ? result.fieldsDiscovered : null,
        // AH5. An EMPTY array is a real answer — "we looked at every discovered field and none is
        // empty" — and is a different fact from null, which means the run never got to look.
        blanks_json: Array.isArray(result.blanks) ? JSON.stringify(result.blanks) : null,
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

      // Park the prepared packet for the handoff. After the audit on purpose — the audit row is the
      // record of the attempt and must not depend on the packet succeeding.
      //
      // AB1: this used to read `finalStatus === "held_gate"`, and that one condition is why the
      // pipeline could not complete. A held review ended here with a screenshot and nothing else:
      // the filled DOM lives in a Puppeteer context that has already closed, so "Filled form ↗" was
      // a static picture and the apply URL beside it opened a brand-new empty application. There was
      // no route from held to submitted at all — the candidate had to redo by hand everything the
      // system had already done.
      //
      // The gated handoff is exactly the mechanism for this, so held reviews are routed through it
      // rather than given one of their own. shouldBuildPacket decides which held rows qualify.
      if (shouldBuildPacket({ status: finalStatus, reasonCode })) {
        createGatePacket({
          runId, runJobId, userId, jobId, result, autofillPayload,
          resumeArtifactId: usedArtifactId,
          reasonCode, jobUrl,
        });
      }

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
      } else if (cancelled) {
        // Counted as neither held nor failed. The run's three counters are what the run chip
        // reports, and a cancelled job is not work waiting on the user (held) nor work that broke
        // (failed) — incrementing either would misreport the run for the sake of a tidier sum.
        logEvent(runId, runJobId, userId, jobId, "run_job_cancelled",
          "You stopped this application. Nothing was submitted.");
      } else if (finalStatus === "held_review") {
        db.prepare(`UPDATE apply_runs SET held_count=held_count+1 WHERE id=?`).run(runId);
      } else {
        db.prepare(`UPDATE apply_runs SET failed_count=failed_count+1 WHERE id=?`).run(runId);
      }

    } catch (e) {
      // TASK AC4: an abort is not a crash. requestAbort closes the browser out from under whatever
      // this job was awaiting, so the throw arriving here is usually a "Target closed" — and
      // attributing it would file a deliberate stop as a browser failure with a Retry button on it.
      // The DB write below is guarded too (setJobStatus's `status != 'cancelled'`), but returning
      // early also skips the failed_count increment and the misleading error log.
      if (isAbortRequested(jobId)) {
        logEvent(runId, runJobId, userId, jobId, "run_job_cancelled",
          "You stopped this application mid-run. The browser was closed and nothing was submitted.");
        return;
      }
      console.error(`[applyRoutes] processRunJob error job=${jobId}: ${e.message}`);
      // A generation failure that happened earlier in this job outranks whatever threw here:
      // it is the reason there was nothing to submit. Otherwise attribute the throw by cause
      // rather than assuming a subsystem (the old code's second branch was unreachable — it
      // tested e.reasonCode after already returning it — and always yielded "internal_error").
      const attributed = classifyRuntimeError(e);
      const errReasonCode = genFailure ? genFailure.reasonCode : attributed.reasonCode;
      const errDetail     = genFailure ? genFailure.detail     : attributed.detail;
      const fallbackUrl = isBrowserFailure(errReasonCode) ? (job?.apply_url || job?.url || null) : null;
      // Generation failures are held for review, not filed as crashes — same rationale as the
      // main path, and still unsubmittable (only 'awaiting_approval' rows can be approved).
      const errStatus = genFailure ? "held_review" : "failed";
      db.prepare(`UPDATE apply_run_jobs SET status=?, reason_code=?, reason_detail=?, finished_at=unixepoch() WHERE id=?`)
        .run(errStatus, errReasonCode,
          (errDetail || e.message?.slice(0, 500) || "Unknown error") + (fallbackUrl ? ` fallbackUrl:${fallbackUrl}` : ""), runJobId);
      db.prepare(`UPDATE apply_runs SET ${genFailure ? "held_count=held_count+1" : "failed_count=failed_count+1"} WHERE id=?`).run(runId);
      logEvent(runId, runJobId, userId, jobId, "error", e.message?.slice(0, 500) || "Unknown error", { fallbackUrl });
    } finally {
      if (resumeTmpPath) { try { unlinkSync(resumeTmpPath); } catch {} }
      if (coverLetterTmpPath) { try { unlinkSync(coverLetterTmpPath); } catch {} }
      // TASK AC4: retire the abort flag HERE, not in the endpoint that raised it. This is the point
      // at which the run it was aimed at has genuinely finished unwinding and recorded itself, so
      // clearing is safe — and it must be cleared, because the key is the POSTING and the same
      // posting is routinely re-queued. A flag left set would silently cancel the next attempt.
      clearAbort(jobId);
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

    // QUEUE CAP. The cost gate: bounds generations, which the submission cap below does not (see
    // queuedLast24h). Checked before it because it is the limit a queue-heavy caller hits first,
    // and refused with the same explicit shape as every other limit here.
    //
    // Skipped for approval_mode='approved' — the approve endpoint is releasing work already
    // reviewed and already generated, and this guard exists to stop unreviewed generation, not to
    // stand between a human decision and the submission it authorises.
    if (resolvedApproval !== "approved") {
      const queuedUsed = queuedLast24h(userId);
      if (queuedUsed + filtered.length > APPLY_DAILY_QUEUE_CAP) {
        return respond(429, {
          error: "queue_cap_exceeded",
          message: `Daily queue limit reached: ${queuedUsed} of ${APPLY_DAILY_QUEUE_CAP} applications queued in the last 24h, ${filtered.length} requested. Each queued application generates a resume, so this limit protects your usage.`,
          queuedLast24h: queuedUsed,
          requested: filtered.length,
          limit: APPLY_DAILY_QUEUE_CAP,
          remaining: Math.max(0, APPLY_DAILY_QUEUE_CAP - queuedUsed),
        });
      }
    }

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
      // The cost budget, reported alongside the submission budget so a caller can show how much
      // generation it has left rather than discovering the ceiling by being refused at it.
      queueCap: (() => {
        const q = queuedLast24h(userId);
        return { limit: APPLY_DAILY_QUEUE_CAP, queuedLast24h: q, remaining: Math.max(0, APPLY_DAILY_QUEUE_CAP - q) };
      })(),
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
    // AH5: a hold reading "Required fields were left empty" that does not say WHICH is a hold the
    // candidate cannot act on. Named here, on the row every surface already renders, rather than
    // behind a second request.
    missingRequired: parseJson(r.blanks_json, [])
      .filter(b => b?.required).map(b => b.label || b.field).filter(Boolean),
    // Whether there is a fill log worth asking for. The log itself is on demand — it is a record
    // you go and read, not something every row should carry.
    fillLogAvailable: r.blanks_json != null || r.answers_json != null,
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
      WHERE rj.user_id=? AND rj.hidden_at IS NULL AND rj.status='held_review'
        AND COALESCE(rj.reason_code, '') != 'awaiting_approval'
      ORDER BY rj.created_at DESC LIMIT 50
    `).all(req.user.id);
    // Gated jobs used to land in `review` above, as held_review rows with reason_code
    // 'login_required'. Giving them their own terminal status took them out of that list, and leaving
    // it there would have made them silently disappear from the only place they were visible. They
    // get their own key instead of being folded back in: a gated job has nothing to review yet — its
    // form was never reached — so it needs a different offer ("sign in once") rather than the same
    // one. ADDITIVE: `runs` and `review` are unchanged, so an existing caller sees no difference.
    const gated = db.prepare(`
      ${RUN_JOB_SELECT}
      WHERE rj.user_id=? AND rj.hidden_at IS NULL AND rj.status='held_gate'
      ORDER BY rj.created_at DESC LIMIT 50
    `).all(req.user.id);
    // ── The four surfaces the panel is organised around, as a TOTAL PARTITION ──────────────────
    //
    // The panel used to be organised around RUNS, and a run is an implementation detail — "run 47"
    // is not a thing anyone thinks about. It is organised around what the user can DO now, which
    // needs cross-run feeds: every application in flight, every one submitted, every one stopped,
    // regardless of which run produced it. Only `review` and `gated` existed, so submitted and
    // stopped applications were reachable only by opening a specific run.
    //
    // PARTITIONED BY EXCLUSION, deliberately. `stopped` is "not any of the others" rather than a
    // list of failure statuses, so a status added later cannot fall through every bucket and vanish
    // from the UI — which is exactly what happened to held_gate when it was split out of
    // held_review. The partition is asserted total by statusCounts below.
    const IN_FLIGHT   = ['queued', 'running'];
    const NEEDS_YOU   = ['held_review', 'held_gate'];
    const inFlight = db.prepare(`
      ${RUN_JOB_SELECT}
      WHERE rj.user_id=? AND rj.hidden_at IS NULL AND rj.status IN (${IN_FLIGHT.map(() => '?').join(',')})
      ORDER BY rj.created_at DESC LIMIT 50
    `).all(req.user.id, ...IN_FLIGHT);
    const submitted = db.prepare(`
      ${RUN_JOB_SELECT}
      WHERE rj.user_id=? AND rj.hidden_at IS NULL AND rj.status='submitted'
      ORDER BY COALESCE(rj.finished_at, rj.created_at) DESC LIMIT 50
    `).all(req.user.id);
    const stopped = db.prepare(`
      ${RUN_JOB_SELECT}
      WHERE rj.user_id=? AND rj.hidden_at IS NULL
        AND rj.status NOT IN (${[...IN_FLIGHT, ...NEEDS_YOU].map(() => '?').join(',')})
        AND rj.status != 'submitted'
      ORDER BY COALESCE(rj.finished_at, rj.created_at) DESC LIMIT 50
    `).all(req.user.id, ...IN_FLIGHT, ...NEEDS_YOU);

    // Every status this user actually has, with its count. The client asserts nothing against it;
    // it exists so "which bucket did this land in?" is answerable from the response alone, and so
    // test/applyObstacleSurfaces.test.js can prove the four buckets sum to the total.
    const statusCounts = Object.fromEntries(
      db.prepare(`SELECT status, COUNT(*) n FROM apply_run_jobs WHERE user_id=? AND hidden_at IS NULL GROUP BY status`)
        .all(req.user.id).map(r => [r.status, r.n])
    );

    res.json({
      runs: runs.map(publicRun),
      review: review.map(publicRunJob),
      gated: gated.map(publicRunJob),
      inFlight: inFlight.map(publicRunJob),
      submitted: submitted.map(publicRunJob),
      stopped: stopped.map(publicRunJob),
      statusCounts,
    });
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
      // AH5: a hold that says "required fields were left empty" and does not say WHICH is a hold
      // the candidate cannot act on — the same defect class as the old unscoped review modal. The
      // list existed; it lived in an apply_job_logs event that no surface reads.
      missingRequired: parseJson(rj.blanks_json, [])
        .filter(b => b?.required).map(b => b.label || b.field).filter(Boolean),
      screenshotAvailable: !!rj.screenshot_path,
      fillLogAvailable: rj.blanks_json != null || rj.answers_json != null,
    });
  });

  /**
   * THE FILL LOG (AH5) — what this run put in the form, and what it did not.
   *
   * ON DEMAND, and text. AB1/AE4 removed the "What we filled" screenshot correctly: it was a dead
   * snapshot of a browser context that had already closed. What was needed instead is a record you
   * can read, and every part of it was already being written — answers_json since A2 carries each
   * filled field with the rule that produced it, fields_discovered and corrections_json since AF5,
   * blanks_json since AH5. This composes them; it stores nothing of its own, so there is no second
   * copy to drift.
   *
   * The BLANK half is read off the post-fill discovery pass, so it is the actual state of the form
   * rather than a gate's opinion of it. That matters most in semi, where neither gate runs at all:
   * a fill log built from gate output would faithfully report the same silence the gates do.
   */
  app.get("/api/apply/run-jobs/:runJobId/fill-log", requireAuth, (req, res) => {
    const rj = ownedRunJob(req.params.runJobId, req.user.id);
    if (!rj) return res.status(404).json({ error: "not_found" });

    const answers = parseJson(rj.answers_json, []);
    const blanks = parseJson(rj.blanks_json, null);
    const corrections = parseJson(rj.corrections_json, []);

    const filled = answers
      .filter(a => !a?.skipped)
      .map(a => ({
        field: a.field_id ?? a.name ?? null,
        label: a.label || a.name || a.field_id || null,
        value: a.value ?? null,
        provenance: a.provenance ?? null,
        confidence: a.confidence ?? null,
      }));

    // The reuse decision is recorded as a run event rather than a column: it is a fact about the
    // RUN, and apply_job_logs is where the run's own account of itself already lives.
    const reuse = (() => {
      try {
        const row = db.prepare(`
          SELECT event, message, details_json FROM apply_job_logs
          WHERE run_job_id=? AND event IN ('resume_reused','resume_regenerating')
          ORDER BY id DESC LIMIT 1
        `).get(rj.id);
        if (!row) return null;
        const d = parseJson(row.details_json, {}) || {};
        return { reused: row.event === "resume_reused", reason: d.reason ?? null, summary: row.message };
      } catch { return null; }
    })();

    res.json({
      runJobId: rj.id,
      jobId: rj.job_id,
      status: rj.status,
      reasonCode: rj.reason_code,
      // null means the run never reached discovery. 0 would claim it looked and found nothing.
      fieldsDiscovered: rj.fields_discovered ?? null,
      filled,
      // null and [] are different answers: "we never looked at the form" vs "we looked at every
      // field and none is empty".
      blanks,
      corrections,
      resume: {
        artifactId: rj.resume_artifact_id ?? null,
        atsScore: rj.resume_ats_score ?? null,
        reuse,
      },
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

  // ── Gated handoff: packet list, token mint, packet exchange (TASK G1) ────────
  // The server prepared everything it could and then met a gate only a human can cross. These three
  // endpoints are how what it prepared reaches the extension standing on the other side.
  //
  // Nothing here submits, and nothing here crosses a gate. See §6.

  /** Attempts in the recent window, counted from the durable log rather than process memory. */
  function gateExchangeAttempts(userId) {
    const since = Math.floor(Date.now() / 1000) - GATE_EXCHANGE_WINDOW_SEC;
    return db.prepare(`
      SELECT COUNT(*) AS c FROM apply_job_logs
      WHERE user_id=? AND event LIKE 'gate_packet_exchange%' AND created_at > ?
    `).get(userId, since).c;
  }

  /**
   * Log an exchange outcome. Every rejection reason is its OWN event (requirement 4): a forged
   * signature, an expired token, a replayed one and one belonging to another account are four
   * different facts, and only one of them means somebody is probing.
   */
  function logExchange(userId, outcome, details = {}) {
    logEvent(details.runId ?? null, details.runJobId ?? null, userId, details.jobId ?? "-",
      `gate_packet_exchange_${outcome}`, `Gate packet exchange: ${outcome}`, details);
  }

  /** Jobs held at a gate, with what is prepared for each. Grouped by portal in G5; flat here. */

  // ── TASK AC4: RUN HISTORY, DATE-DRIVEN AND ON DEMAND ─────────────────────────────────────────
  //
  // The panel's history was a small expandable list of the last 20 RUNS. A run is an implementation
  // detail — nobody thinks "run 47" — and twenty of them is neither all of the history nor a
  // useful window on it. This is the same record asked the question a candidate actually has:
  // what did I put into auto-apply on this day, and how did each one end.
  //
  // DATE-SCOPED AND USER-SCOPED ON THE SERVER (requirement 5). Explicitly not "fetch all history and
  // filter client-side": that would defeat requirement 2's on-demand loading, it would grow without
  // bound, and it would ship every application a user has ever attempted to the browser to render
  // one day of it. The index added by migration 085 — (user_id, created_at) — is the exact shape of
  // this query; the pre-existing idx_apply_run_jobs_user_status leads with status and cannot serve
  // a date range.
  //
  // WHICH DATE. `created_at` — when the application was ADDED to auto-apply, which is what the
  // requirement asks for ("the applications added to auto-apply on that date") and what a user
  // remembers doing. finished_at would scatter one afternoon's queueing across several days
  // depending on when each job happened to be picked up.
  //
  // THE TIMEZONE, which is not a detail here. created_at is unixepoch seconds, i.e. UTC. The
  // calendar hands over a LOCAL date. Without the offset, a run queued at 8pm in Boston lands on
  // the next UTC day, and the user picks the day they remember and is told nothing happened. The
  // client sends its own getTimezoneOffset(); the day boundary is computed from it. Absent or
  // malformed, it falls back to UTC — which is the old behaviour, not a crash.
  const dayRangeUtc = (dateStr, offsetMinutes) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
    if (!m) return null;
    const [, y, mo, d] = m;
    // Date.UTC of the local wall-clock midnight, then shifted by the offset to reach the real
    // instant. getTimezoneOffset() is minutes WEST of UTC (Boston in winter is +300), so local
    // midnight is that many minutes LATER in UTC — hence the addition.
    const off = Number.isFinite(Number(offsetMinutes)) ? Number(offsetMinutes) : 0;
    const startMs = Date.UTC(Number(y), Number(mo) - 1, Number(d)) + off * 60_000;
    return { start: Math.floor(startMs / 1000), end: Math.floor(startMs / 1000) + 86400 };
  };

  /**
   * THE DATE OF THE MOST RECENT ACTIVITY (AH6). One row, one MAX, no listing.
   *
   * AD1 made the panel open on nothing and ask which day you mean, and that inversion was right
   * about one thing and wrong about another. Right: the panel must not silently ship a day's worth
   * of applications you did not ask for. Wrong: it landed on a blank board with a prompt, and the
   * commonest reason to open Auto Apply is to see what happened on the last run — which was almost
   * never today. So the answer to "which day?" was one the panel could have worked out.
   *
   * This is the cheap half of that. It returns a DATE, not a listing: the caller then asks for that
   * day through the ordinary /api/apply/history path, so there is still exactly one way to load a
   * day's rows and the counts still come from the same partition as the rows.
   *
   * Keyed on created_at like the day filter itself — WHEN YOU QUEUED IT, not when it finished — so
   * "your most recent activity" means the same thing here as it does on the calendar.
   */
  app.get("/api/apply/history/latest", requireAuth, (req, res) => {
    const row = db.prepare(`
      SELECT MAX(created_at) AS latest FROM apply_run_jobs
      WHERE user_id=? AND hidden_at IS NULL
    `).get(req.user.id);
    if (!row?.latest) return res.json({ date: null });
    // Rendered in the CALLER'S day, for the same reason dayRangeUtc takes an offset: a run queued
    // at 9pm in Boston belongs to that Boston day, not to the UTC one it lands in.
    const off = Number.isFinite(Number(req.query.tzOffset)) ? Number(req.query.tzOffset) : 0;
    const local = new Date((row.latest - off * 60) * 1000);
    const date = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
    res.json({ date });
  });

  /**
   * One day's applications, in three groups — or, since AD1, ONE group of them plus the counts of
   * all three.
   *
   * Nothing here loads unless a date is asked for — there is no "recent" default and no implicit
   * today. AH6 gives the PANEL a default (the date above) but not this endpoint: a caller still has
   * to name the day it wants, so an accidental mount cannot ship a listing.
   *
   * ── TASK AD1: `group`, AND WHY THE COUNTS ARE NOT A SECOND REQUEST ─────────────────────────
   *
   * AD1 turns the three outcome groups into SUB-TABS and states the rule directly: "Switching
   * sub-tabs with a date selected refetches for that tab; it must not load all three." So the
   * endpoint learned to answer for one group. `group` is OPTIONAL and its absence keeps the
   * original three-group shape, which is what AC4's own tests read and what any other caller would
   * expect — this is additive, not a replacement.
   *
   * The counts, though, are needed for ALL THREE tabs whichever one is open, and AD1 requirement 4
   * makes them date-scoped. Two ways to get them, and only one is honest:
   *
   *   - three requests, or one request that returns every row and is then filtered — which is the
   *     "must not load all three" the requirement forbids, wearing a different hat;
   *   - one aggregate over the SAME day range that reads `status` and whether the posting join came
   *     back empty, and nothing else. No artifacts, no answers, no reasons — just enough to run
   *     outcomeGroupFor, which is the only thing that can produce these numbers correctly because
   *     the dead-posting override is not expressible as a GROUP BY status.
   *
   * It is the second. A day holds tens of run-jobs, not thousands, and this reads two columns from
   * them. The full-row SELECT — the one with the joins and the artifact probes — runs for the ONE
   * group asked for.
   */
  app.get("/api/apply/history", requireAuth, (req, res) => {
    const range = dayRangeUtc(req.query.date, req.query.tzOffset);
    if (!range) return res.status(400).json({ error: "bad_date", message: "Expected date=YYYY-MM-DD." });

    // An unrecognised group is a 400 rather than a silent fallback to "all three": a typo'd tab
    // name would otherwise ship the whole day to a client that asked for a slice of it, which is
    // the exact thing requirement 3 is trying to prevent, and it would do it invisibly.
    const asked = req.query.group ? String(req.query.group) : null;
    if (asked && !Object.prototype.hasOwnProperty.call(OUTCOME_STATUSES, asked)) {
      return res.status(400).json({
        error: "bad_group",
        message: `Expected group to be one of ${Object.keys(OUTCOME_STATUSES).join(", ")}.`,
      });
    }

    // THE COUNTS. Two columns per run-job for the day, run through the same partition the rows use,
    // so a tab's number and that tab's contents cannot disagree.
    const counts = { [OUTCOME.COMPLETED]: 0, [OUTCOME.PENDING]: 0, [OUTCOME.ABORTED]: 0 };
    const tally = db.prepare(`
      SELECT rj.status AS status, (sj.job_id IS NULL) AS postingGone
      FROM apply_run_jobs rj
      LEFT JOIN scraped_jobs sj ON sj.job_id = rj.job_id
      WHERE rj.user_id=? AND rj.hidden_at IS NULL
        AND rj.created_at >= ? AND rj.created_at < ?
    `).all(req.user.id, range.start, range.end);
    for (const t of tally) {
      counts[outcomeGroupFor({ status: t.status, postingGone: !!t.postingGone })] += 1;
    }

    const rows = db.prepare(`
      ${RUN_JOB_SELECT}
      WHERE rj.user_id=? AND rj.hidden_at IS NULL
        AND rj.created_at >= ? AND rj.created_at < ?
      ${asked
        // The status filter narrows the read, and the dead-posting override is then applied per row
        // below. PENDING has to over-fetch and drop, because a row can be PENDING by status and
        // ABORTED in reality; ABORTED has to over-fetch the PENDING statuses for the mirror reason.
        // Stated rather than hidden, because "SELECT the group's statuses" looks sufficient and is
        // not — that is precisely the bug the override exists to prevent.
        ? `AND rj.status IN (${[...OUTCOME_STATUSES[asked],
             ...(asked === OUTCOME.ABORTED ? OUTCOME_STATUSES[OUTCOME.PENDING] : [])]
             .map(() => "?").join(",")})`
        : ""}
      ORDER BY rj.created_at DESC, rj.id DESC
    `).all(req.user.id, range.start, range.end,
           ...(asked ? [...OUTCOME_STATUSES[asked],
                        ...(asked === OUTCOME.ABORTED ? OUTCOME_STATUSES[OUTCOME.PENDING] : [])]
                     : []));

    // The partition, from shared/applyOutcomeGroups.js so the panel cannot disagree with it. Each
    // row lands in exactly one group; outcomeGroupFor is total by construction (an unmapped status
    // is ABORTED rather than dropped) and asserted total by test/applyRunHistory.test.js.
    const groups = { [OUTCOME.COMPLETED]: [], [OUTCOME.PENDING]: [], [OUTCOME.ABORTED]: [] };
    for (const r of rows) {
      const pub = publicRunJob(r);
      // The dead-posting override needs to know the posting is gone, and that is the LEFT JOIN
      // coming back empty rather than anything on the run-job row.
      const group = outcomeGroupFor({ ...pub, postingGone: r.title == null && r.company == null });
      groups[group].push({
        ...pub,
        postingGone: r.title == null && r.company == null,
        // Whether THIS row can still be aborted, decided by the server. The client must not
        // re-derive it: the button's presence and the endpoint's guard have to agree, and two
        // copies of that rule is how a button appears for something the server will refuse.
        abortable: OUTCOME_STATUSES[OUTCOME.PENDING].includes(r.status),
      });
    }

    res.json({
      date: req.query.date,
      // Empty is a NORMAL state, not an error and not a spinner (requirement 6). The response is
      // shaped identically whether or not anything happened, so the client renders emptiness from
      // data rather than from the absence of it.
      //
      // `total` is the DAY's total in both shapes — it is what "nothing happened on this date"
      // means, and scoping it to the asked-for group would make an empty COMPLETED tab on a busy
      // day claim the day itself was empty. That is what `counts` is for.
      total: counts[OUTCOME.COMPLETED] + counts[OUTCOME.PENDING] + counts[OUTCOME.ABORTED],
      counts,
      ...(asked
        ? { group: asked, jobs: groups[asked] }
        : {
            completed: groups[OUTCOME.COMPLETED],
            pending:   groups[OUTCOME.PENDING],
            aborted:   groups[OUTCOME.ABORTED],
          }),
    });
  });

  /**
   * Which dates in a month have anything on them (requirement 7: dates with activity should be
   * discoverable — the user should not hunt blindly).
   *
   * THE TRADEOFF, STATED. Requirement 7 allows a calendar marker only if it does not violate
   * requirement 2. This does not: requirement 2 is that "the panel's initial render issues no
   * history query", and this fires when the user OPENS THE CALENDAR, which is an action they took.
   * The panel can be mounted, scrolled and read without ever calling it.
   *
   * It is a COUNT-PER-DAY aggregate over one month — no rows, no joins, served by the same
   * (user_id, created_at) index — so it is cheap in a way that fetching the month's runs would not
   * be. If an owner would still rather have no query at all before a date is picked, deleting the
   * `loadHistoryMonth` call in AutoApplyContext removes it and leaves the picker working blind.
   */
  app.get("/api/apply/history/months/:month", requireAuth, (req, res) => {
    const m = /^(\d{4})-(\d{2})$/.exec(String(req.params.month || ""));
    if (!m) return res.status(400).json({ error: "bad_month", message: "Expected YYYY-MM." });
    const [, y, mo] = m;
    const off = Number.isFinite(Number(req.query.tzOffset)) ? Number(req.query.tzOffset) : 0;
    const start = Math.floor((Date.UTC(Number(y), Number(mo) - 1, 1) + off * 60_000) / 1000);
    const end   = Math.floor((Date.UTC(Number(y), Number(mo), 1) + off * 60_000) / 1000);

    // Bucketed in SQL by the same local-day boundary the day query uses, so a date that is marked
    // is a date that returns rows. Two different definitions of "day" between the marker and the
    // fetch would put a dot on an empty day, which is worse than no dot.
    const rows = db.prepare(`
      SELECT strftime('%Y-%m-%d', (rj.created_at - ?) , 'unixepoch') AS day, COUNT(*) AS n
      FROM apply_run_jobs rj
      WHERE rj.user_id=? AND rj.hidden_at IS NULL
        AND rj.created_at >= ? AND rj.created_at < ?
      GROUP BY day
    `).all(off * 60, req.user.id, start, end);

    res.json({ month: req.params.month, days: Object.fromEntries(rows.map(r => [r.day, r.n])) });
  });

  /**
   * ABORT one pending run-job (requirement 4).
   *
   * THE ORDER OF THE THREE STEPS IS THE SAFETY PROPERTY, and it is:
   *
   *   1. WRITE 'cancelled' FIRST, conditionally on the row still being pending. better-sqlite3 is
   *      synchronous, so `UPDATE ... WHERE status IN (pending)` is one atomic decision — it both
   *      claims the abort and rejects it if the run finished a millisecond ago. Doing this first is
   *      what makes the worker's `AND status != 'cancelled'` guard bite: processRunJob's terminal
   *      write loses to a row already marked cancelled, so a run that completes during the abort
   *      cannot overwrite it, and one that is still going cannot be recorded as failed when its
   *      browser is closed underneath it.
   *   2. VOID THE PACKET. A prepared handoff for an application the user just stopped is a live
   *      credential-bearing artifact for work that is not happening; consumed_at is how a packet is
   *      retired everywhere else, so it drops out of GET /api/apply/gate-packets, out of the portal
   *      batches, and out of the token mint — which refuses a consumed packet.
   *   3. TELL THE BROWSER. requestAbort sets its flag and closes the Chromium process. The page,
   *      the frames and the filled DOM go with it. Every await in flight rejects; the flag in front
   *      of autoApply's catch is what keeps that from being reported as a browser failure.
   *
   * WHAT CANNOT BE PROMISED, said plainly rather than implied: an abort that arrives after the
   * submit click has dispatched cannot recall it. That window is one statement wide — autoApply
   * checks the flag immediately before the click — and the run reports what it observed rather than
   * assuming. Everything before that point is guaranteed not to submit.
   */
  app.post("/api/apply/run-jobs/:runJobId/abort", requireAuth, (req, res) => {
    const rj = ownedRunJob(req.params.runJobId, req.user.id);
    if (!rj) return res.status(404).json({ error: "not_found" });

    const PENDING = OUTCOME_STATUSES[OUTCOME.PENDING];
    // 1. Claim it. The WHERE clause is the race guard — see above.
    const claimed = db.prepare(`
      UPDATE apply_run_jobs
      SET status='cancelled', reason_code='user_aborted',
          reason_detail='You stopped this application. Nothing was submitted.',
          finished_at=unixepoch()
      WHERE id=? AND user_id=? AND status IN (${PENDING.map(() => "?").join(",")})
    `).run(rj.id, req.user.id, ...PENDING);

    if (claimed.changes === 0) {
      // It finished between the panel rendering the button and the click landing. Reported as a
      // conflict with the status it actually reached, so the UI can say what happened instead of
      // showing a generic failure for an application that may well have been submitted.
      const now = db.prepare("SELECT status FROM apply_run_jobs WHERE id=? AND user_id=?")
        .get(rj.id, req.user.id);
      return res.status(409).json({
        error: "not_abortable",
        status: now?.status ?? null,
        message: now?.status === "submitted"
          ? "This one was submitted before the abort reached it. It cannot be recalled."
          : `This application already finished (${now?.status ?? "unknown"}), so there was nothing to stop.`,
      });
    }

    // 2. Void the packet. Unconsumed packets for this run-job AND for this posting: a re-run makes
    //    a new run-job, and an older attempt's packet is still a usable handoff into the same form.
    const voided = db.prepare(`
      UPDATE apply_gate_packets SET consumed_at=unixepoch()
      WHERE user_id=? AND consumed_at IS NULL AND (run_job_id=? OR job_id=?)
    `).run(req.user.id, rj.id, String(rj.job_id));

    // 3. Stop the browser, if one is running for this posting.
    //    Fire-and-forget on purpose: browser.close() can take seconds against a hung page, and the
    //    row is ALREADY cancelled — making the user wait on Chromium to acknowledge a decision the
    //    database has recorded would turn a click into a spinner for no added guarantee.
    // The flag is NOT cleared here. requestAbort resolves as soon as the Chromium process is
    // gone, while the run that was awaiting a page operation is still unwinding through its own
    // catch — clearing it in that window makes the catch attribute a deliberate stop to the browser.
    // processRunJob's `finally` clears it once the run has actually finished; a five-minute TTL in
    // applyAutomation is the backstop for when there was no run in flight to do so.
    requestAbort(rj.job_id).catch(e => console.warn("[applyRoutes] abort:", e.message));

    logEvent(rj.run_id, rj.id, req.user.id, rj.job_id, "run_job_cancelled",
      "Aborted by the user. The browser was closed, nothing was submitted, and the prepared handoff was voided.",
      { packetsVoided: voided.changes });

    res.json({ ok: true, runJobId: rj.id, status: "cancelled", packetsVoided: voided.changes });
  });

  /**
   * HIDE one run-job from the user's own view (requirement 4's DELETE).
   *
   * IT IS A SOFT HIDE, FOR EVERYTHING, AND THAT IS THE DECISION. The requirement asks which was
   * implemented and recommends soft-hide for submitted; this goes further and soft-hides all of it.
   *
   *   A submitted application is EVIDENCE THAT REACHED A REAL EMPLOYER. That record — the date, the
   *   exact resume, the screenshot of the form as sent — is what the candidate needs when an
   *   interview lands three weeks later, and it must not be destroyable by a click made while
   *   tidying up. So submitted rows are never hard-deleted.
   *
   *   And rather than two code paths with different consequences, nothing is. Three things a DELETE
   *   would have cost, none of them obvious at the call site:
   *     - apply_job_logs.run_job_id and apply_gate_packets.run_job_id both cascade ON DELETE, so
   *       removing one run-job would silently take its whole audit trail with it.
   *     - apply_runs' submitted_count / held_count / failed_count are STORED counters. Deleting a
   *       row would leave the run claiming work that no longer exists.
   *     - A hide is reversible by an operator (`SET hidden_at=NULL`). A delete is a support ticket
   *       that cannot be answered.
   *
   * A pending application is ABORTED FIRST, not merely hidden: hiding a running job would take it
   * off the user's screen while its browser carried on filling a real employer's form. "Remove
   * this" cannot mean "stop looking at it while it continues".
   */
  app.delete("/api/apply/run-jobs/:runJobId", requireAuth, (req, res) => {
    const rj = ownedRunJob(req.params.runJobId, req.user.id);
    if (!rj) return res.status(404).json({ error: "not_found" });

    const wasPending = OUTCOME_STATUSES[OUTCOME.PENDING].includes(rj.status);
    if (wasPending) {
      const PENDING = OUTCOME_STATUSES[OUTCOME.PENDING];
      db.prepare(`
        UPDATE apply_run_jobs
        SET status='cancelled', reason_code='user_aborted',
            reason_detail='You removed this application. Nothing was submitted.',
            finished_at=unixepoch()
        WHERE id=? AND user_id=? AND status IN (${PENDING.map(() => "?").join(",")})
      `).run(rj.id, req.user.id, ...PENDING);
      db.prepare(`
        UPDATE apply_gate_packets SET consumed_at=unixepoch()
        WHERE user_id=? AND consumed_at IS NULL AND (run_job_id=? OR job_id=?)
      `).run(req.user.id, rj.id, String(rj.job_id));
      // Not cleared here either — same reason as the abort endpoint above.
      requestAbort(rj.job_id).catch(e => console.warn("[applyRoutes] abort-on-delete:", e.message));
    }

    db.prepare("UPDATE apply_run_jobs SET hidden_at=unixepoch() WHERE id=? AND user_id=?")
      .run(rj.id, req.user.id);

    logEvent(rj.run_id, rj.id, req.user.id, rj.job_id, "run_job_hidden",
      wasPending
        ? "Removed from your history. It was still pending, so it was stopped first — nothing was submitted."
        : "Removed from your history. The record is retained and can be restored by an operator.",
      { previousStatus: rj.status, aborted: wasPending });

    res.json({
      ok: true,
      runJobId: rj.id,
      hidden: true,
      // Said back to the caller so the UI can be honest about what "delete" did, rather than
      // implying an erasure that did not happen.
      softHide: true,
      abortedFirst: wasPending,
    });
  });

  /**
   * The unconsumed handoff queue.
   *
   * ?origin= — OPTIONAL, AND IT IS THE QUESTION EVERY EXTENSION CALLER ACTUALLY ASKS.
   *
   * All three extension call sites (background.js's batch continuation, gated-handoff.js's
   * portalQueueFor and its target match) fetched this list whole and immediately threw away every
   * row whose expectedOrigin was not the tab's. They ask "what is queued for THIS portal?" and were
   * answered with "the newest 100 across all of them".
   *
   * That is not merely wasteful — the cap made it WRONG. With more than 100 unconsumed packets, a
   * portal whose packets all fall outside the newest 100 comes back empty, and the extension reports
   * `batch_empty` on a batch that is not empty: it stops mid-run and the candidate is told there is
   * nothing left to do. A silent cap answering a question nobody asked.
   *
   * Filtering here puts the LIMIT on the set the caller cares about, where 100 packets for a SINGLE
   * portal is a different order of magnitude, and `total` below makes the truncation visible in
   * every case rather than leaving it to be inferred.
   */
  app.get("/api/apply/gate-packets", requireAuth, (req, res) => {
    // One local, used to build BOTH statements below, so the list and its count cannot disagree
    // about what they are scoped to — a `total` computed over a different scope than the rows would
    // be worse than no total at all.
    const origin = String(req.query.origin || "").trim();
    const where = origin ? "AND p.expected_origin = ?" : "";
    const args = origin ? [req.user.id, origin] : [req.user.id];

    const PACKET_LIST_LIMIT = 100;
    const rows = db.prepare(`
      SELECT p.id, p.job_id, p.run_id, p.run_job_id, p.apply_url, p.expected_origin, p.gate_reason,
             p.answers_json, p.resume_artifact_id, p.consumed_at, p.created_at,
             sj.title, sj.company
      FROM apply_gate_packets p
      LEFT JOIN scraped_jobs sj ON sj.job_id = p.job_id
      WHERE p.user_id=? AND p.consumed_at IS NULL ${where}
      ORDER BY p.created_at DESC LIMIT ${PACKET_LIST_LIMIT}
    `).all(...args);

    // How many there REALLY are, over the same scope and before the cap. A list that has been cut
    // must be able to say so: the previous shape was indistinguishable from a complete one, which
    // is what let the extension read a truncated answer as an empty batch. Counted rather than
    // inferred from rows.length, which cannot tell a full list from a capped one.
    const total = db.prepare(`
      SELECT COUNT(*) AS n FROM apply_gate_packets p
      WHERE p.user_id=? AND p.consumed_at IS NULL ${where}
    `).get(...args)?.n || 0;

    // ── Amortise the gate per PORTAL, not per application (TASK G5) ───────────
    // The architecture doc calls this the highest-leverage item in the design, and it is a
    // reframing rather than machinery: the same rows, grouped by the origin the candidate has to
    // authenticate against. One ten-second CAPTCHA that releases seven applications is a different
    // product from seven separate reviews.
    //
    // Grouped here rather than in the client because G0 established the unit that matters is the
    // ORIGIN — the grant survives every same-origin navigation and dies when it leaves — and the
    // origin is a stored fact on the packet, not something a UI should be re-deriving from a URL.
    //
    // ONLY GATE-CROSSING PACKETS ARE GROUPED THIS WAY (AB1/AB2). Once held reviews also carry
    // packets, grouping every packet by origin would report "sign in to boards.greenhouse.io once →
    // 4 applications ready" over four applications that each need a different answer from the
    // candidate — a promise the sign-in cannot keep. The rule the panel is built on:
    //
    //   group by OBSTACLE    when one action unblocks MANY applications  (a portal sign-in)
    //   group by APPLICATION when many obstacles block ONE application   (a held review)
    //
    // Both cases are real, so both are served: portals below, per-application packets in `packets`.
    const portals = [...rows.filter(r => handoffKind(r.gate_reason) === "gate").reduce((m, r) => {
      const g = m.get(r.expected_origin) || {
        origin: r.expected_origin,
        host: (() => { try { return new URL(r.expected_origin).host; } catch { return r.expected_origin; } })(),
        count: 0, packetIds: [], oldestAt: null, gateReasons: new Set(),
      };
      g.count++;
      g.packetIds.push(r.id);
      g.oldestAt = g.oldestAt == null ? r.created_at : Math.min(g.oldestAt, r.created_at);
      g.gateReasons.add(r.gate_reason);
      m.set(r.expected_origin, g);
      return m;
    }, new Map()).values()]
      .map(g => ({ ...g, oldestAt: toMs(g.oldestAt), gateReasons: [...g.gateReasons] }))
      // Biggest batch first: that is the one where crossing a gate once buys the most.
      .sort((a, b) => b.count - a.count);

    res.json({
      // The scope this answer was computed over, echoed so a caller can tell a filtered response
      // from a whole one without remembering what it asked for — and so a response cached or passed
      // between contexts stays self-describing.
      origin: origin || null,
      // `total` is the count over that scope BEFORE the cap; `truncated` says the list was cut.
      // Both are always present: a client that only learns about truncation when it happens has to
      // discover the field's existence at the worst possible moment.
      total,
      returned: rows.length,
      truncated: total > rows.length,
      limit: PACKET_LIST_LIMIT,
      portals,
      packets: rows.map(r => {
        const body = parseJson(r.answers_json, {});
        const createdAt = toMs(r.created_at);
        const { ageMs, stale } = packetFreshness(createdAt);
        return {
          packetId:       r.id,
          jobId:          r.job_id,
          runId:          r.run_id,
          runJobId:       r.run_job_id,
          title:          r.title ?? null,
          company:        r.company ?? null,
          applyUrl:       r.apply_url,
          expectedOrigin: r.expected_origin,
          gateReason:     r.gate_reason,
          createdAt,
          // Whether crossing this releases a batch or finishes one application. The panel groups on
          // it, so it is stated by the server rather than re-derived from the reason string twice.
          kind:           handoffKind(r.gate_reason),
          // AB1 requirement 5. A packet is a snapshot of a decision and the world moves; an old one
          // must SAY it is old rather than quietly filling three-day-old answers into a live form.
          ageMs,
          stale,
          staleAfterMs:   PACKET_STALE_MS,
          // AB1 requirement 6. The LEFT JOIN on scraped_jobs misses when the 7-day cleanup has
          // removed the posting, which is what produced rows reading "4369183334 (posting no longer
          // on the board)". A held review for a posting that no longer exists cannot be resumed at
          // all — there is nothing to open — so it is its OWN state, not a row with a broken link.
          postingGone:    r.title == null && r.company == null,
          // COUNTS ONLY on the list. The values are behind the token exchange, so opening the queue
          // does not spray a home address across every row of a list response.
          answerCount:      Array.isArray(body.answers) ? body.answers.length : 0,
          unresolvedCount:  Array.isArray(body.unresolved) ? body.unresolved.length : 0,
          resumeAvailable:  r.resume_artifact_id != null,
        };
      }),
    });
  });

  /**
   * Mint a single-use token for an unconsumed packet. This is what "click Review" calls.
   *
   * On demand rather than at gate-detection time because the TTL is minutes: a token minted when the
   * run observed the gate would be dead long before anyone read the notification. Re-minting rotates
   * the outstanding token, so an abandoned handoff leaves nothing usable behind.
   */
  app.post("/api/apply/gate-packets/:packetId/token", requireAuth, (req, res) => {
    const packetId = Number(req.params.packetId);
    if (!Number.isInteger(packetId) || packetId <= 0) return res.status(400).json({ error: "bad_packet_id" });

    const row = db.prepare("SELECT * FROM apply_gate_packets WHERE id=? AND user_id=?")
      .get(packetId, req.user.id);
    // Not-found and not-yours are the same response on purpose: distinguishing them would confirm
    // another account's packet exists.
    if (!row) return res.status(404).json({ error: "packet_not_found" });
    if (row.consumed_at != null) {
      return res.status(409).json({
        error: "packet_consumed",
        message: "This handoff was already completed. Re-queue the job to prepare a new one.",
      });
    }

    // STALE PACKETS ARE REFUSED HERE, before a token exists (AB1 requirement 5).
    //
    // Refused at the MINT rather than filtered out of the list on purpose: a packet that has gone
    // off must be able to say so. Dropping it from the list would make it vanish, which is the
    // "silently fill nothing" failure the requirement names — the candidate would click Open, watch
    // an empty form, and have no way to learn that the answers had expired. A 410 with a sentence
    // and a re-run is the honest version.
    const { ageMs, stale } = packetFreshness(toMs(row.created_at));
    if (stale) {
      const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      logEvent(row.run_id, row.run_job_id, req.user.id, row.job_id, "gate_packet_stale",
        "Handoff refused: the prepared answers are too old to fill", { packetId, ageMs });
      return res.status(410).json({
        error: "packet_stale",
        message: `This application was prepared ${days} day${days === 1 ? "" : "s"} ago and the posting may have changed. Run it again to prepare fresh answers.`,
        ageMs,
        staleAfterMs: PACKET_STALE_MS,
        // What clears it. The panel turns this into a button rather than leaving the user stuck.
        remedy: "rerun",
        jobId: row.job_id,
      });
    }

    if (!GATE_TOKEN_SECRET) {
      return res.status(503).json({
        error: "gate_token_secret_missing",
        message: "Handoff tokens cannot be issued: no server secret is configured.",
      });
    }

    const { token, tokenHash, expiresAt } = mintPacketToken({
      secret: GATE_TOKEN_SECRET, userId: req.user.id, jobId: row.job_id, packetId,
      ttlMs: DEFAULT_TOKEN_TTL_MS,
    });
    db.prepare("UPDATE apply_gate_packets SET token_hash=?, expires_at=? WHERE id=?")
      .run(tokenHash, expiresAt, packetId);

    logEvent(row.run_id, row.run_job_id, req.user.id, row.job_id, "gate_packet_token_minted",
      "Handoff token issued", { packetId, expiresAt, expectedOrigin: row.expected_origin });

    res.json({
      token,
      expiresAt: expiresAt * 1000,
      // Returned so the extension knows what to target-match BEFORE it asks for the packet, and so a
      // mismatch costs nothing: it can refuse without ever holding the answers.
      expectedOrigin: row.expected_origin,
      applyUrl: row.apply_url,
      // Where the extension fetches the resume as a blob. This route already existed for the audit
      // trail (requirement 5) and is session-authenticated, so nothing new was added for it.
      resumeUrl: row.resume_artifact_id != null && row.run_job_id != null
        ? `/api/apply/run-jobs/${row.run_job_id}/resume`
        : null,
    });
  });

  /**
   * Exchange a token for the packet, ONCE.
   *
   * Rejections are deliberately NOT collapsed into one generic 400 (requirement 4):
   *   401 token_invalid / token_malformed   signature failed or the token is not a token
   *   403 token_user_mismatch              a valid token belonging to another account
   *   409 token_consumed                   a replay
   *   410 token_expired                    past its TTL
   *   429 rate_limited
   */
  app.post("/api/apply/gate-packet/exchange", requireAuth, (req, res) => {
    const userId = req.user.id;

    // Before anything else: this endpoint returns a home address and work-authorization answers.
    const attempts = gateExchangeAttempts(userId);
    if (attempts >= GATE_EXCHANGE_MAX_ATTEMPTS) {
      logExchange(userId, "rate_limited", { attempts, limit: GATE_EXCHANGE_MAX_ATTEMPTS });
      return res.status(429).json({
        error: "rate_limited",
        message: `Too many handoff attempts (${attempts} in the last ${GATE_EXCHANGE_WINDOW_SEC / 60} minutes).`,
        retryAfterSeconds: GATE_EXCHANGE_WINDOW_SEC,
      });
    }

    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const verified = verifyPacketToken(token, { secret: GATE_TOKEN_SECRET });
    if (!verified.ok) {
      logExchange(userId, verified.reason);
      const status = verified.reason === "token_expired" ? 410
                   : verified.reason === "no_secret" ? 503
                   : 401;
      return res.status(status).json({ error: verified.reason });
    }

    const { pid, uid, jid } = verified.payload;
    // The token is bound to a user. A signature that verifies still does not entitle THIS session to
    // the packet — that is the difference between a valid token and an authorised one.
    if (uid !== userId) {
      logExchange(userId, "token_user_mismatch", { packetId: pid, tokenUserId: uid });
      return res.status(403).json({ error: "token_user_mismatch" });
    }

    const row = db.prepare("SELECT * FROM apply_gate_packets WHERE id=?").get(pid);
    if (!row || row.user_id !== userId || String(row.job_id) !== String(jid)) {
      logExchange(userId, "token_binding_mismatch", { packetId: pid, tokenJobId: jid });
      return res.status(403).json({ error: "token_binding_mismatch" });
    }
    // The hash on the row is the ONE outstanding token. An older token for the same packet verifies
    // by signature and is still refused here, which is what makes re-minting a rotation rather than
    // handing out a second key.
    if (row.token_hash !== hashToken(token)) {
      logExchange(userId, "token_superseded", { packetId: pid, jobId: row.job_id });
      return res.status(401).json({ error: "token_superseded" });
    }

    // SINGLE USE. Claimed with a conditional UPDATE, not a read-then-write: two concurrent exchanges
    // would both pass a `consumed_at IS NULL` check and both be served. Whichever UPDATE changes a
    // row is the one that won.
    const claim = db.prepare(`
      UPDATE apply_gate_packets
      SET consumed_at=unixepoch(), exchange_attempts=exchange_attempts+1
      WHERE id=? AND consumed_at IS NULL
    `).run(pid);
    if (claim.changes === 0) {
      db.prepare("UPDATE apply_gate_packets SET exchange_attempts=exchange_attempts+1 WHERE id=?").run(pid);
      logExchange(userId, "token_consumed", { packetId: pid, jobId: row.job_id, runId: row.run_id, runJobId: row.run_job_id });
      return res.status(409).json({ error: "token_consumed" });
    }

    const body = parseJson(row.answers_json, null);
    if (!body) {
      logExchange(userId, "packet_corrupt", { packetId: pid });
      return res.status(500).json({ error: "packet_corrupt" });
    }

    logExchange(userId, "released", {
      packetId: pid, jobId: row.job_id, runId: row.run_id, runJobId: row.run_job_id,
      expectedOrigin: row.expected_origin,
      answerCount: Array.isArray(body.answers) ? body.answers.length : 0,
    });

    res.json({
      packetId: pid,
      // Repeated at the top level because the extension target-matches on it before releasing
      // anything into a page (G2 requirement 3), and it must not have to dig for it.
      expectedOrigin: row.expected_origin,
      applyUrl: row.apply_url,
      gateReason: row.gate_reason,
      resumeUrl: row.resume_artifact_id != null && row.run_job_id != null
        ? `/api/apply/run-jobs/${row.run_job_id}/resume`
        : null,
      packet: body,
    });
  });

  // ── Form schema capture (TASK G4) ────────────────────────────────────────────
  // Behind a gate is a place the server can never reach. The extension is standing inside it, so the
  // form's STRUCTURE comes back here and the next candidate's packet arrives pre-mapped.
  //
  // OPT-IN, DEFAULT OFF, ENFORCED SERVER-SIDE. The extension checks the setting too, but only to
  // avoid pointless work — the refusal that matters is this one, because a client-side check is a
  // request the client can simply not make.

  /** Whether this account has turned capture on. Read by the extension before it captures. */
  app.get("/api/apply/form-schema/consent", requireAuth, (req, res) => {
    try {
      const row = db.prepare("SELECT form_schema_capture FROM users WHERE id=?").get(req.user.id);
      res.json({ enabled: row?.form_schema_capture === 1 });
    } catch {
      // Same posture as the POST below, which has always guarded this: an un-migrated deployment has
      // no column. Unguarded, this threw a 500 on EVERY handoff — the extension asks about consent
      // on its way through, so one missing migration turned a working fill into a server error in
      // the log for every single application. Not consenting is the safe answer, and capture is
      // opt-in and default off anyway.
      res.json({ enabled: false });
    }
  });

  app.post("/api/apply/form-schema/consent", requireAuth, (req, res) => {
    const enabled = req.body?.enabled === true;
    try {
      db.prepare("UPDATE users SET form_schema_capture=? WHERE id=?").run(enabled ? 1 : 0, req.user.id);
    } catch (e) {
      // An un-migrated deployment has no column. Reporting that is better than reporting success and
      // silently never capturing.
      return res.status(503).json({ error: "consent_unavailable", message: "Run migration 081." });
    }
    res.json({ ok: true, enabled });
  });

  /**
   * Receive one observation of a company's application form.
   *
   * Takes STRUCTURE ONLY, and it is this endpoint's job to make that true rather than to trust the
   * sender: normaliseCapturedFields whitelists the properties that may be stored, so a client that
   * posted values — by mistake or otherwise — cannot get them in.
   */
  app.post("/api/apply/form-schema", requireAuth, (req, res) => {
    const consent = db.prepare("SELECT form_schema_capture FROM users WHERE id=?").get(req.user.id);
    if (consent?.form_schema_capture !== 1) {
      return res.status(403).json({
        error: "capture_not_enabled",
        message: "Form schema capture is off for this account.",
      });
    }

    const applyHost = hostOf(req.body?.applyUrl) || String(req.body?.applyHost || "").toLowerCase();
    if (!applyHost) return res.status(400).json({ error: "bad_apply_host" });

    try {
      const result = recordFormSchema(db, {
        applyHost,
        company:  req.body?.company ?? null,
        platform: req.body?.platform ?? null,
        fields:   req.body?.fields,
        // Named so a schema learned by a candidate crossing a gate is distinguishable from one our
        // own crawl of a public careers page produced. Same store, same shape.
        source:   "extension_gated",
      });
      logEvent(null, null, req.user.id, req.body?.jobId ?? "-", "form_schema_captured",
        `Form schema ${result.changed ? "changed" : "corroborated"} for ${applyHost}: ` +
        `${result.fieldCount} field(s), ${result.unmappedCount} we cannot answer`,
        // Counts and identity, never the fields themselves — the log is not a second copy of the
        // store, and a form's shape belongs in one place.
        { applyHost, ...result });
      res.json({ ok: true, ...result });
    } catch (e) {
      // An empty capture is REFUSED, not stored. Persisting one would cache the absence of
      // information into the asset that is supposed to compound, and a later reader could not tell
      // "this form has no fields" from "discovery ran before the page rendered" — which is exactly
      // the failure this task was blocked on.
      const code = e.reasonCode === "form_schema_empty" ? 422 : 400;
      return res.status(code).json({ error: e.reasonCode || "capture_failed", message: e.message });
    }
  });

  /**
   * What we already know about the form behind a URL — for IMPORT and QUEUE time, which is when
   * knowing costs nothing and helps most (requirement 4).
   */
  app.get("/api/apply/form-schema", requireAuth, (req, res) => {
    const summary = formSchemaSummary(db, req.query.url || req.query.host || "");
    if (!summary) return res.json({ known: false });
    res.json(summary);
  });

  /**
   * A handoff that was released but never completed — the portal signed the candidate out partway
   * through a batch, or the tab was closed on the way (TASK G5 requirement 4).
   *
   * The token was already spent, and un-spending it would make "single use" conditional on our own
   * bookkeeping being right. So this issues a FRESH packet for the same job instead: the original row
   * stays consumed and auditable, and the new one starts with no outstanding token. Single use holds
   * absolutely; what is reopened is the handoff, not the token.
   *
   * Refused once a review has been recorded, because then the candidate did see the form and the
   * application is theirs to finish — reopening would offer a second copy of an application that is
   * already in front of them.
   */
  app.post("/api/apply/gate-packets/:packetId/reopen", requireAuth, (req, res) => {
    const packetId = Number(req.params.packetId);
    if (!Number.isInteger(packetId) || packetId <= 0) return res.status(400).json({ error: "bad_packet_id" });

    const row = db.prepare("SELECT * FROM apply_gate_packets WHERE id=? AND user_id=?")
      .get(packetId, req.user.id);
    if (!row) return res.status(404).json({ error: "packet_not_found" });
    if (row.consumed_at == null) {
      // Nothing to reopen: the packet is still usable exactly as it is.
      return res.json({ ok: true, packetId, reopened: false, reason: "still_open" });
    }

    const rj = row.run_job_id
      ? db.prepare("SELECT status, gate_review_json FROM apply_run_jobs WHERE id=? AND user_id=?")
          .get(row.run_job_id, req.user.id)
      : null;
    if (rj?.gate_review_json) {
      return res.status(409).json({
        error: "already_reviewed",
        message: "This application was already opened and reviewed. Finish it in the tab you started.",
      });
    }
    // Both handoff statuses, not just held_gate: once a held review carries a packet, reopening one
    // after an abandoned session is the same operation. Keying on held_gate alone would have made
    // every held review permanently unresumable the moment its first session was abandoned.
    if (rj && !HANDOFF_STATUSES.has(rj.status)) {
      return res.status(409).json({ error: "not_held", message: `This job is ${rj.status}, not waiting for you.` });
    }

    const ins = db.prepare(`
      INSERT INTO apply_gate_packets
        (user_id, run_id, run_job_id, job_id, apply_url, expected_origin, gate_reason,
         answers_json, resume_artifact_id, token_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(row.user_id, row.run_id, row.run_job_id, row.job_id, row.apply_url, row.expected_origin,
           row.gate_reason, row.answers_json, row.resume_artifact_id, GATE_PACKET_NO_TOKEN());

    const newId = Number(ins.lastInsertRowid);
    logEvent(row.run_id, row.run_job_id, req.user.id, row.job_id, "gate_packet_reopened",
      "Handoff reopened after an incomplete session", { from: packetId, to: newId, expectedOrigin: row.expected_origin });
    res.json({ ok: true, packetId: newId, reopened: true, from: packetId });
  });

  /**
   * What the candidate actually saw and did before submitting (TASK G3 requirement 6).
   *
   * For a gated application this is the ONLY record of human review: the submission happens in the
   * candidate's own browser, on a portal we cannot reach, so nothing else observes it. Written to its
   * own column rather than merged into answers_json — those are two claims made at different times by
   * different parties, and merging them would make it impossible to say afterwards whether a value
   * was the resolver's or the candidate's correction.
   *
   * Idempotent by overwrite: the overlay reports its state on every change, and the last report is
   * the one that describes what the candidate ended up looking at.
   */
  app.post("/api/apply/gate-review", requireAuth, (req, res) => {
    const runJobId = Number(req.body?.runJobId);
    if (!Number.isInteger(runJobId) || runJobId <= 0) return res.status(400).json({ error: "bad_run_job_id" });

    const rj = db.prepare("SELECT id, run_id, job_id FROM apply_run_jobs WHERE id=? AND user_id=?")
      .get(runJobId, req.user.id);
    if (!rj) return res.status(404).json({ error: "not_found" });

    const acknowledged = Array.isArray(req.body?.acknowledged) ? req.body.acknowledged.map(String).slice(0, 200) : [];
    // Field identity and the fact of a change, never the new value. A correction is the candidate's
    // own data and the audit question is WHAT THEY CHANGED, not what they changed it to — which is
    // already going to the employer either way.
    const edits = (Array.isArray(req.body?.edits) ? req.body.edits : []).slice(0, 200)
      .map(e => ({ field: String(e?.key ?? "").slice(0, 200), changed: true }));

    const record = {
      version: 1,
      packetId: req.body?.packetId ?? null,
      ready: req.body?.ready === true,
      acknowledgedCount: acknowledged.length,
      acknowledged,
      editedCount: edits.length,
      edits,
      recordedAt: Math.floor(Date.now() / 1000),
    };

    try {
      const cols = new Set(db.prepare("PRAGMA table_info(apply_run_jobs)").all().map(c => c.name));
      if (!cols.has("gate_review_json")) {
        // Same posture as the audit columns: an un-migrated deployment degrades to the event log
        // rather than failing the candidate's review.
        logEvent(rj.run_id, rj.id, req.user.id, rj.job_id, "gate_review_recorded",
          "Gate review recorded (event only — run migration 080)", record);
        return res.json({ ok: true, persisted: "event_only" });
      }
      db.prepare("UPDATE apply_run_jobs SET gate_review_json=? WHERE id=? AND user_id=?")
        .run(JSON.stringify(record), runJobId, req.user.id);
      logEvent(rj.run_id, rj.id, req.user.id, rj.job_id, "gate_review_recorded",
        record.ready
          ? `Candidate reviewed: ${record.acknowledgedCount} acknowledged, ${record.editedCount} corrected`
          : `Candidate review in progress: ${record.acknowledgedCount} acknowledged`,
        record);
      res.json({ ok: true, persisted: "column" });
    } catch (e) {
      console.warn("[applyRoutes] gate review persist failed:", e.message);
      res.status(500).json({ error: "persist_failed" });
    }
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

  /**
   * The answer store, read WITHOUT naming custom_answer_overrides.
   *
   * `SELECT *` rather than a column list for the same reason auditColumns() exists above: an
   * un-migrated deployment or a stale fixture would otherwise throw on the missing column and take
   * the whole endpoint down with a 500 — including the plain-answers path that worked before 087.
   * readAnswerStore treats an absent column as an empty override map, which is exactly right.
   */
  const answerStore = (userId) =>
    readAnswerStore(db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(userId) || {});

  // Whether overrides can be PERSISTED, which is a different question from whether they can be read.
  // Named once per process, loudly, because a silently dropped override would look like the store
  // simply not working.
  let overridesColumnCache = null;
  function canPersistOverrides() {
    if (overridesColumnCache !== null) return overridesColumnCache;
    let present = false;
    try {
      present = db.prepare("PRAGMA table_info(user_profile)").all().some(c => c.name === "custom_answer_overrides");
    } catch (e) {
      console.warn("[applyRoutes] could not read user_profile schema:", e.message);
    }
    if (!present) {
      console.warn(
        "[applyRoutes] PER-COMPANY ANSWERS DEGRADED — user_profile is missing custom_answer_overrides. " +
        "Per-company overrides cannot be saved; run migrations (087 adds it). Plain answers still save."
      );
    }
    overridesColumnCache = present;
    return present;
  }

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

    const store = answerStore(req.user.id);
    // Resolution is per-employer once templates exist, so it is computed per company and cached
    // rather than read off one flat map.
    const perCompany = new Map();
    const forCompany = (company) => {
      const key = companyKey(company);
      if (!perCompany.has(key)) perCompany.set(key, resolveForCompany(store, company));
      return perCompany.get(key);
    };

    const byQuestion = new Map();
    for (const row of rows) {
      const { answers: resolved, withheld } = forCompany(row.company);
      for (const q of parseJson(row.open_questions_json, [])) {
        const key = String(q.question || "").trim().toLowerCase();
        if (!key) continue;
        if (!byQuestion.has(key)) {
          byQuestion.set(key, { ...q, answered: true, blocking: [] });
        }
        const entry = byQuestion.get(key);
        // Answered means answered FOR EVERY employer still blocked on it. A template answered for
        // one company does not unblock the same question at another.
        if (!Object.prototype.hasOwnProperty.call(resolved, q.question)) entry.answered = false;
        // A motivation template deliberately produced no answer. Hand back the expanded generic
        // text as a DRAFT — a starting point the candidate edits into their own words — and say
        // which stored template it came from, so saving it can become a per-company override.
        const held = withheld.find(w => normaliseText(w.question) === normaliseText(q.question));
        if (held && !entry.draft) {
          entry.draft = held.draft;
          entry.template = held.template;
          entry.needsOwnWords = true;
        }
        entry.blocking.push({ jobId: row.job_id, runId: row.run_id, title: row.title, company: row.company });
      }
    }
    const questions = [...byQuestion.values()];
    res.json({
      questions,
      // Eligibility answers are attestations to an employer. A caller should present them as such,
      // and they are the ones the resolver refuses to infer on the user's behalf.
      eligibilityCount: questions.filter(q => q.eligibility).length,
      // The ones the system will never write for the candidate, however full the store gets.
      ownWordsCount: questions.filter(q => q.needsOwnWords).length,
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
      const { answers = {}, overrides = {}, retryJobIds = null, mode = "auto", approvalMode = null } = req.body || {};
      if (approvalMode === "approved")
        return out.status(400).json({ error: "approval_mode_reserved" });
      if (!answers || typeof answers !== "object" || Array.isArray(answers))
        return out.status(400).json({ error: "answers object required" });
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
        return out.status(400).json({ error: "overrides must be an object keyed by company" });

      const clean = (obj) => Object.entries(obj)
        .map(([q, a]) => [String(q).trim(), a])
        .filter(([q, a]) => q.length > 0 && a !== null && a !== undefined && String(a).trim() !== "");

      const entries = clean(answers);
      // A per-company override is how a motivation question gets answered at all: the generic
      // template is never submitted, so the candidate's own words for THIS employer are the only
      // thing that can resolve it. Keyed by company, then by the question as stored.
      const overrideEntries = [];
      for (const [company, byQuestion] of Object.entries(overrides)) {
        if (!byQuestion || typeof byQuestion !== "object" || Array.isArray(byQuestion)) continue;
        const key = companyKey(company);
        if (!key) continue;
        for (const [q, a] of clean(byQuestion)) overrideEntries.push([key, q, String(a)]);
      }
      if (entries.length === 0 && overrideEntries.length === 0)
        return out.status(400).json({ error: "no non-empty answers supplied" });

      db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(req.user.id);
      const prior = answerStore(req.user.id);
      const merged = { ...prior.answers };
      for (const [q, a] of entries) merged[q] = String(a);
      const mergedOverrides = {};
      for (const [c, byQ] of Object.entries(prior.overrides)) mergedOverrides[c] = { ...byQ };
      for (const [c, q, a] of overrideEntries) {
        if (!mergedOverrides[c]) mergedOverrides[c] = {};
        mergedOverrides[c][q] = a;
      }
      const overridesPersisted = canPersistOverrides();
      if (overridesPersisted) {
        db.prepare("UPDATE user_profile SET custom_answers=?, custom_answer_overrides=? WHERE user_id=?")
          .run(JSON.stringify(merged), JSON.stringify(mergedOverrides), req.user.id);
      } else {
        // Plain answers must still save. Losing them because a per-company column is missing would
        // be a worse failure than losing the overrides.
        db.prepare("UPDATE user_profile SET custom_answers=? WHERE user_id=?")
          .run(JSON.stringify(merged), req.user.id);
      }

      // Which held jobs are now fully answered? A job is retryable when every question it was
      // blocked on has an answer — retrying one that is still missing an answer just burns a run.
      //
      // Resolved PER EMPLOYER, not against the raw map: a `{company}` template answers the question
      // only once expanded for that job's company, and a motivation template answers it for nobody.
      // Checking the flat store would mark a job retryable that is still going to hold.
      // Resolved against what was actually WRITTEN, not what was asked for: if the override column
      // is missing, those answers did not persist and must not count towards unblocking a job.
      const store = { answers: merged, overrides: overridesPersisted ? mergedOverrides : prior.overrides };
      const held = db.prepare(`
        SELECT rj.job_id, rj.open_questions_json, sj.company
        FROM apply_run_jobs rj
        LEFT JOIN scraped_jobs sj ON sj.job_id = rj.job_id
        WHERE rj.user_id=? AND rj.status='held_review' AND rj.open_questions_json IS NOT NULL
      `).all(req.user.id);
      const unblocked = held
        .filter(row => {
          const qs = parseJson(row.open_questions_json, []);
          if (qs.length === 0) return false;
          const resolved = effectiveCustomAnswers(store, row.company);
          return qs.every(q => Object.prototype.hasOwnProperty.call(resolved, q.question));
        })
        .map(row => row.job_id);

      const body = {
        ok: true,
        saved: entries.map(([q]) => q),
        savedOverrides: overridesPersisted
          ? overrideEntries.map(([c, q]) => ({ company: c, question: q }))
          : [],
        unblocked,
      };

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

  /**
   * RETIRED — the server does not keep your portal sessions, deliberately.
   *
   * WHAT THESE WERE. In the server-side-Playwright era (ebeb9ae) POST /save wrote a Playwright
   * `storageState` — the cookies and localStorage of the candidate's LOGGED-IN session on an
   * employer's portal — to data/sessions/<userId>_<domain>.json in plaintext, and GET /:domain
   * reported whether that file existed. c818b9c replaced that architecture and left both as stubs.
   *
   * WHY THEY ARE NOT BEING IMPLEMENTED. A gated portal is now handled by handing the application to
   * the candidate's OWN browser: detectGate runs before any fill so a sign-in wall is never typed
   * into, no credential control is ever answered (g6CredentialGuard), and `login_required` becomes
   * a portal batch resolved by one real sign-in whose grant survives every same-origin navigation
   * (G0). The session lives where it should — in the browser the person is sitting at. Restoring
   * these would put a live authenticated session to a third party back on our disk, which is the
   * single most sensitive thing this product could hold and is exactly what that architecture
   * removed. data/sessions/ no longer exists.
   *
   * WHY 410 RATHER THAN DELETION, and rather than leaving the stubs. The stubs were the worse of
   * the three: `{ok:true}` tells a caller its session was saved when nothing was written, and
   * `{exists:false}` answers "do you have my session?" with a confident no that is true only by
   * accident. Both are the wired-to-a-no-op shape this codebase keeps finding. 410 follows the
   * /api/scrape and extension save-job precedent — a caller that still exists learns what happened
   * and what to do instead, rather than getting a 404 it reads as a bug.
   */
  const SESSION_RETIRED = {
    error: "gone",
    message: "Portal sessions are no longer stored on the server. A portal that wants you signed " +
      "in is handed to your own browser: sign in once there and every application queued behind " +
      "that portal continues.",
  };
  app.post("/api/apply/session/save", requireAuth, (_req, res) => res.status(410).json(SESSION_RETIRED));
  app.get("/api/apply/session/:domain", requireAuth, (_req, res) => res.status(410).json(SESSION_RETIRED));
}
