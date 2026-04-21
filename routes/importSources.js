import { Router } from "express";
import crypto from "crypto";
import { importedJobDedupeKey, normaliseImportedJob } from "../services/importedJobs.js";

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

  router.post("/api/import-sources/linkedin-saved/token", requireAuth, (req, res) => {
    const rawToken = crypto.randomBytes(24).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (30 * 60);
    db.prepare(`
      INSERT INTO import_extension_tokens
        (token_hash, user_id, source_key, expires_at, created_at, last_used_at)
      VALUES (?, ?, 'linkedin_saved', ?, ?, ?)
    `).run(tokenHash(rawToken), req.user.id, expiresAt, now, now);
    res.json({
      ok: true,
      sourceKey: "linkedin_saved",
      token: rawToken,
      expiresAt,
      importUrl: "/api/import-sources/linkedin-saved/jobs",
      sourceLabel: "LinkedIn Saved Jobs",
    });
  });

  router.post("/api/import-sources/linkedin-saved/jobs", requireImportToken(db), (req, res) => {
    const userId = req.importToken.user_id;
    const rawJobs = Array.isArray(req.body?.jobs) ? req.body.jobs : [];
    if (!rawJobs.length) return res.status(400).json({ error: "jobs array required" });

    const upsert = db.prepare(`
      INSERT INTO imported_jobs (
        user_id, source_key, source_label, source_platform, external_job_id, dedupe_key,
        title, company, location, job_url, apply_url, work_type, employment_type,
        compensation, posted_at, description, company_icon_url, payload_json,
        first_imported_at, last_imported_at, last_seen_at, import_count, updated_at
      ) VALUES (?, ?, 'LinkedIn Saved Jobs', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(), unixepoch(), 1, unixepoch())
      ON CONFLICT(user_id, source_key, dedupe_key) DO UPDATE SET
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
    const existedStmt = db.prepare("SELECT id FROM imported_jobs WHERE user_id=? AND source_key='linkedin_saved' AND dedupe_key=?");

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const rawJob of rawJobs.slice(0, 250)) {
      const normalised = normaliseImportedJob("linkedin_saved", rawJob);
      if (!normalised) {
        skipped++;
        continue;
      }
      const existed = existedStmt.get(userId, importedJobDedupeKey("linkedin_saved", rawJob));
      upsert.run(
        userId,
        "linkedin_saved",
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
      if (existed) updated++;
      else inserted++;
    }

    emitToUser?.(userId, { type: "imported_jobs_updated", sourceKey: "linkedin_saved", inserted, updated });
    res.json({ ok: true, sourceKey: "linkedin_saved", inserted, updated, skipped });
  });

  return router;
}
