import { Router } from "express";
import crypto from "crypto";
import { importedJobDedupeKey, normaliseImportedJob } from "../services/importedJobs.js";

const LINKEDIN_SOURCE_KEYS = ["linkedin", "linkedin_saved"];

function resolveSourceKey(source) {
  return String(source || "").toLowerCase() === "linkedin_saved" ? "linkedin_saved" : "linkedin";
}

function resolveSourceLabel(sourceKey) {
  return sourceKey === "linkedin_saved" ? "LinkedIn Saved Jobs" : "LinkedIn Jobs";
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function requireImportToken(db) {
  return (req, res, next) => {
    const token = req.get("X-RM-Import-Token") || req.body?.token || "";
    if (!token) return res.status(401).json({ error: "Import token required" });
    const now = Math.floor(Date.now() / 1000);
    const row = db.prepare(`
      SELECT * FROM import_extension_tokens
      WHERE token_hash=? AND consumed_at IS NULL AND expires_at > ?
      LIMIT 1
    `).get(tokenHash(token), now);
    if (!row) return res.status(401).json({ error: "Import token invalid or expired" });
    req.importToken = row;
    db.prepare("UPDATE import_extension_tokens SET last_used_at=? WHERE id=?").run(now, row.id);
    next();
  };
}

export function createImportSourcesRouter({ db, requireAuth, emitToUser }) {
  const router = Router();

  function importJobsForUser({ userId, jobs, source }) {
    const sourceKey = resolveSourceKey(source);
    const sourceLabel = resolveSourceLabel(sourceKey);
    const rawJobs = Array.isArray(jobs) ? jobs : [];
    if (!rawJobs.length) return { error: "jobs array required", status: 400 };

    const upsert = db.prepare(`
      INSERT INTO imported_jobs (
        user_id, source_key, source_label, source_platform, external_job_id, dedupe_key,
        title, company, location, job_url, apply_url, work_type, employment_type,
        compensation, posted_at, description, company_icon_url, payload_json,
        first_imported_at, last_imported_at, last_seen_at, import_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(), unixepoch(), 1, unixepoch())
      ON CONFLICT(user_id, source_key, dedupe_key) DO UPDATE SET
        source_label=excluded.source_label,
        source_platform=excluded.source_platform,
        external_job_id=COALESCE(excluded.external_job_id, imported_jobs.external_job_id),
        title=excluded.title,
        company=excluded.company,
        location=excluded.location,
        job_url=COALESCE(excluded.job_url, imported_jobs.job_url),
        apply_url=COALESCE(excluded.apply_url, imported_jobs.apply_url),
        work_type=COALESCE(excluded.work_type, imported_jobs.work_type),
        employment_type=COALESCE(excluded.employment_type, imported_jobs.employment_type),
        compensation=COALESCE(excluded.compensation, imported_jobs.compensation),
        posted_at=COALESCE(excluded.posted_at, imported_jobs.posted_at),
        description=COALESCE(excluded.description, imported_jobs.description),
        company_icon_url=COALESCE(excluded.company_icon_url, imported_jobs.company_icon_url),
        payload_json=excluded.payload_json,
        last_imported_at=unixepoch(),
        last_seen_at=unixepoch(),
        import_count=imported_jobs.import_count + 1,
        updated_at=unixepoch()
    `);
    const existedStmt = db.prepare("SELECT id FROM imported_jobs WHERE user_id=? AND source_key=? AND dedupe_key=?");

    let imported = 0;
    let duplicates = 0;
    const errors = [];

    for (const rawJob of rawJobs.slice(0, 250)) {
      const normalised = normaliseImportedJob(sourceKey, rawJob);
      if (!normalised) {
        errors.push("Skipped an invalid LinkedIn job payload.");
        continue;
      }
      const existed = existedStmt.get(userId, sourceKey, importedJobDedupeKey(sourceKey, rawJob));
      upsert.run(
        userId,
        sourceKey,
        sourceLabel,
        normalised.sourcePlatform,
        normalised.externalJobId,
        normalised.dedupeKey,
        normalised.title,
        normalised.company,
        normalised.location,
        normalised.jobUrl,
        normalised.applyUrl,
        normalised.workType,
        normalised.employmentType,
        normalised.compensation,
        normalised.postedAt,
        normalised.description,
        normalised.companyIconUrl,
        normalised.payloadJson,
      );
      if (existed) duplicates++;
      else imported++;
    }

    emitToUser?.(userId, { type: "imported_jobs_updated", sourceKey, imported, duplicates });
    return { ok: true, sourceKey, imported, duplicates, errors };
  }

  router.post("/api/import-sources/linkedin-saved/jobs", requireImportToken(db), (req, res) => {
    const result = importJobsForUser({
      userId: req.importToken.user_id,
      jobs: req.body?.jobs,
      source: "linkedin_saved",
    });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  });

  router.post("/api/jobs/import", requireAuth, (req, res) => {
    const result = importJobsForUser({
      userId: req.user.id,
      jobs: req.body?.jobs,
      source: req.body?.source || "linkedin",
    });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  });

  return router;
}
