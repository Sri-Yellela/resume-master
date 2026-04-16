// routes/adminDb.js — DB Inspector API routes for admin diagnostics
import { Router } from "express";
import fs from "fs";

export function createAdminDbRouter(db, { dbPath, scrapeJobs } = {}) {
  const router = Router();

  function requireAdmin(req, res, next) {
    if (!req.user?.isAdmin) return res.status(403).json({ error: "Admin access required" });
    next();
  }

  // ── Route 1: Scrape Monitor ───────────────────────────────────
  router.get("/scrape-monitor", requireAdmin, (req, res) => {
    try {
      const limit = Math.min(200, parseInt(req.query.limit || "50"));
      const userId = req.query.userId ? parseInt(req.query.userId) : null;

      let sql = `
        SELECT
          sj.job_id, sj.title, sj.company, sj.search_query,
          sj.employment_type, sj.work_type, sj.location,
          sj.posted_at, sj.scraped_at, sj.ghost_score, sj.ats_score,
          sj.domain_profile_id, sj.source_platform, sj.applicant_count,
          sj.min_years_exp, sj.max_years_exp,
          dp.profile_name, dp.role_family,
          dp.user_id as profile_owner_user_id,
          u.username as profile_owner_username,
          CASE
            WHEN dp.target_titles IS NULL THEN 'no_profile'
            ELSE 'check_client_side'
          END as title_relevance_status
        FROM scraped_jobs sj
        LEFT JOIN domain_profiles dp ON dp.id = sj.domain_profile_id
        LEFT JOIN users u ON u.id = dp.user_id
      `;
      const params = [];
      if (userId) {
        sql += ` WHERE dp.user_id = ?`;
        params.push(userId);
      }
      sql += ` ORDER BY sj.scraped_at DESC LIMIT ?`;
      params.push(limit);

      const jobs = db.prepare(sql).all(...params);

      const totalCount = db.prepare("SELECT COUNT(*) as c FROM scraped_jobs").get().c;
      const nullProfileCount = db.prepare(
        "SELECT COUNT(*) as c FROM scraped_jobs WHERE domain_profile_id IS NULL"
      ).get().c;
      const perProfile = db.prepare(`
        SELECT sj.domain_profile_id, dp.profile_name, dp.user_id,
          u.username, COUNT(sj.job_id) as job_count
        FROM scraped_jobs sj
        LEFT JOIN domain_profiles dp ON dp.id = sj.domain_profile_id
        LEFT JOIN users u ON u.id = dp.user_id
        GROUP BY sj.domain_profile_id
        ORDER BY job_count DESC
      `).all();
      const lastScrape = db.prepare("SELECT MAX(scraped_at) as t FROM scraped_jobs").get().t;
      const empTypes = db.prepare(`
        SELECT employment_type, COUNT(*) as count FROM scraped_jobs
        GROUP BY employment_type ORDER BY count DESC
      `).all();
      const avgAts = db.prepare(
        "SELECT AVG(ats_score) as avg FROM scraped_jobs WHERE ats_score IS NOT NULL"
      ).get().avg;

      res.json({
        jobs,
        stats: {
          total: totalCount,
          withProfile: totalCount - nullProfileCount,
          nullProfile: nullProfileCount,
          avgAtsScore: avgAts ? Math.round(avgAts) : null,
          lastScrapeAt: lastScrape,
          employmentTypes: empTypes,
          perProfile,
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 2: Schema Explorer ──────────────────────────────────
  router.get("/schema", requireAdmin, (req, res) => {
    try {
      const tableNames = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
      ).all().map(t => t.name);

      const tables = tableNames.map(name => {
        const rowCount = db.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get().c;
        const columns = db.prepare(`PRAGMA table_info("${name}")`).all();
        const indexList = db.prepare(`PRAGMA index_list("${name}")`).all();
        const indexes = indexList.map(idx => {
          const info = db.prepare(`PRAGMA index_info("${idx.name}")`).all();
          return { name: idx.name, unique: idx.unique === 1, columns: info.map(c => c.name) };
        });
        const foreignKeys = db.prepare(`PRAGMA foreign_key_list("${name}")`).all().map(fk => ({
          from: fk.from, table: fk.table, to: fk.to,
        }));
        return { name, rowCount, columns, indexes, foreignKeys };
      });

      let migrations = [];
      try { migrations = db.prepare("SELECT * FROM schema_migrations ORDER BY applied_at ASC").all(); } catch {}

      let dbSizeBytes = 0;
      if (dbPath) { try { dbSizeBytes = fs.statSync(dbPath).size; } catch {} }

      const walMode = db.prepare("PRAGMA journal_mode").get();

      res.json({ tables, migrations, dbSizeBytes, walMode: walMode?.journal_mode === "wal" });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 2b: Recent rows for a table ────────────────────────
  const ALLOWED_TABLES = new Set([
    "scraped_jobs", "user_jobs", "domain_profiles", "usage_events", "scrape_events",
    "users", "user_job_searches", "resumes", "job_applications", "schema_migrations",
    "user_limits", "cache_events",
  ]);
  router.get("/table-rows/:table", requireAdmin, (req, res) => {
    const table = req.params.table;
    if (!ALLOWED_TABLES.has(table)) return res.status(400).json({ error: "Table not allowed" });
    try {
      res.json(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid DESC LIMIT 10`).all());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 3: User Pool Inspector ─────────────────────────────
  router.get("/user-pool/:userId", requireAdmin, (req, res) => {
    const userId = parseInt(req.params.userId);
    try {
      const activeProfile = db.prepare(
        "SELECT * FROM domain_profiles WHERE user_id = ? AND is_active = 1"
      ).get(userId);

      const allProfiles = db.prepare(`
        SELECT id, profile_name, role_family, domain, is_active, created_at
        FROM domain_profiles WHERE user_id = ?
        ORDER BY is_active DESC, created_at DESC
      `).all(userId);

      const poolBreakdown = db.prepare(`
        SELECT
          uj.domain_profile_id,
          dp.profile_name,
          COUNT(*) as job_count,
          COUNT(CASE WHEN dp.user_id != ? THEN 1 END) as wrong_user_count,
          COUNT(CASE WHEN uj.domain_profile_id IS NULL THEN 1 END) as null_tag_count
        FROM user_jobs uj
        LEFT JOIN domain_profiles dp ON dp.id = uj.domain_profile_id
        WHERE uj.user_id = ?
        GROUP BY uj.domain_profile_id
      `).all(userId, userId);

      const activeId = activeProfile?.id ?? -1;
      const sampleJobs = db.prepare(`
        SELECT sj.title, sj.company, sj.search_query,
          uj.domain_profile_id,
          dp.profile_name as tagged_to_profile,
          CASE
            WHEN uj.domain_profile_id IS NULL THEN 'NULL_TAG'
            WHEN dp.user_id != ? THEN 'WRONG_USER_PROFILE'
            WHEN uj.domain_profile_id != ? THEN 'WRONG_PROFILE_FOR_USER'
            ELSE 'CORRECT'
          END as status
        FROM user_jobs uj
        JOIN scraped_jobs sj ON sj.job_id = uj.job_id
        LEFT JOIN domain_profiles dp ON dp.id = uj.domain_profile_id
        WHERE uj.user_id = ?
        ORDER BY status DESC
        LIMIT 100
      `).all(userId, activeId, userId);

      const searches = db.prepare(
        "SELECT search_query, last_scraped_at FROM user_job_searches WHERE user_id = ?"
      ).all(userId);

      res.json({ activeProfile, allProfiles, poolBreakdown, sampleJobs, searches });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 4: Job Association Trace ───────────────────────────
  router.get("/job-trace/:jobId", requireAdmin, (req, res) => {
    const jobId = req.params.jobId;
    try {
      const scrapedJob = db.prepare("SELECT * FROM scraped_jobs WHERE job_id = ?").get(jobId);
      if (!scrapedJob) return res.status(404).json({ error: "Job not found" });

      const userJobs = db.prepare(`
        SELECT uj.*, u.username, dp.profile_name,
          dp.user_id as profile_owner_user_id
        FROM user_jobs uj
        JOIN users u ON u.id = uj.user_id
        LEFT JOIN domain_profiles dp ON dp.id = uj.domain_profile_id
        WHERE uj.job_id = ?
      `).all(jobId);

      let resumes = [];
      try {
        resumes = db.prepare("SELECT * FROM resumes WHERE job_id = ?").all(jobId);
      } catch {}

      const applications = db.prepare(`
        SELECT ja.*, u.username FROM job_applications ja
        JOIN users u ON u.id = ja.user_id
        WHERE ja.job_id = ?
      `).all(jobId);

      const domainProfile = scrapedJob.domain_profile_id
        ? db.prepare(`
            SELECT dp.*, u.username as owner_username
            FROM domain_profiles dp
            JOIN users u ON u.id = dp.user_id
            WHERE dp.id = ?
          `).get(scrapedJob.domain_profile_id)
        : null;

      const hasProfile = !!scrapedJob.domain_profile_id;
      const profileOwner = domainProfile?.owner_username ?? null;
      const usersWithJob = [...new Set(userJobs.map(uj => uj.username))];
      const issues = [];

      if (!hasProfile) {
        issues.push("Job has no domain_profile_id — may appear across multiple users via NULL fallback");
      }
      for (const uj of userJobs) {
        if (domainProfile && uj.profile_owner_user_id !== uj.user_id) {
          issues.push(
            `Job tagged to ${profileOwner}'s profile but in ${uj.username}'s user_jobs with wrong profile tag`
          );
        }
      }

      res.json({
        scraped_job: scrapedJob,
        user_jobs: userJobs,
        resumes,
        applications,
        domain_profile: domainProfile,
        diagnosis: {
          hasProfile,
          profileOwner,
          usersWithJob,
          isCorrectlyIsolated: hasProfile && issues.length === 0,
          issues,
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 5: Query Simulator ──────────────────────────────────
  router.get("/simulate-jobs/:userId", requireAdmin, (req, res) => {
    const userId = parseInt(req.params.userId);
    try {
      const activeProfile = db.prepare(
        "SELECT * FROM domain_profiles WHERE user_id = ? AND is_active = 1"
      ).get(userId);

      if (!activeProfile) {
        return res.json({
          activeProfile: null,
          sessionSyncWouldAdd: 0,
          totalJobsInPool: 0,
          jobsPassingAllFilters: 0,
          sampleResults: [],
          sampleFiltered: [],
          filterReasonCounts: {},
          conditions: ["No active profile — would return empty immediately"],
          rawSql: "",
        });
      }

      const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

      const sessionSyncWouldAdd = db.prepare(`
        SELECT COUNT(*) as c FROM scraped_jobs sj
        WHERE sj.domain_profile_id = ?
        AND (
          (sj.posted_at IS NOT NULL AND sj.posted_at != ''
            AND CAST(strftime('%s', sj.posted_at) AS INTEGER) > ?)
          OR ((sj.posted_at IS NULL OR sj.posted_at = '') AND sj.scraped_at > ?)
        )
        AND sj.job_id NOT IN (
          SELECT job_id FROM user_jobs WHERE user_id = ? AND disliked = 1
        )
        AND sj.job_id NOT IN (SELECT job_id FROM user_jobs WHERE user_id = ?)
      `).get(activeProfile.id, sevenDaysAgo, sevenDaysAgo, userId, userId).c;

      const totalJobsInPool = db.prepare(
        "SELECT COUNT(*) as c FROM user_jobs WHERE user_id = ?"
      ).get(userId).c;

      const passingCount = db.prepare(`
        SELECT COUNT(*) as c FROM user_jobs uj
        JOIN scraped_jobs sj ON sj.job_id = uj.job_id
        WHERE uj.user_id = ?
        AND uj.domain_profile_id = ?
        AND ((sj.posted_at IS NOT NULL AND sj.posted_at != ''
              AND CAST(strftime('%s', sj.posted_at) AS INTEGER) > ?)
             OR ((sj.posted_at IS NULL OR sj.posted_at = '') AND sj.scraped_at > ?))
        AND (uj.disliked IS NULL OR uj.disliked = 0)
        AND (uj.applied IS NULL OR uj.applied = 0)
        AND (uj.resume_generated IS NULL OR uj.resume_generated = 0)
      `).get(userId, activeProfile.id, sevenDaysAgo, sevenDaysAgo).c;

      const sampleResults = db.prepare(`
        SELECT sj.title, sj.company, sj.search_query, uj.domain_profile_id,
          sj.posted_at, sj.scraped_at, sj.ats_score
        FROM user_jobs uj
        JOIN scraped_jobs sj ON sj.job_id = uj.job_id
        WHERE uj.user_id = ?
        AND uj.domain_profile_id = ?
        AND ((sj.posted_at IS NOT NULL AND sj.posted_at != ''
              AND CAST(strftime('%s', sj.posted_at) AS INTEGER) > ?)
             OR ((sj.posted_at IS NULL OR sj.posted_at = '') AND sj.scraped_at > ?))
        AND (uj.disliked IS NULL OR uj.disliked = 0)
        AND (uj.applied IS NULL OR uj.applied = 0)
        AND (uj.resume_generated IS NULL OR uj.resume_generated = 0)
        ORDER BY sj.scraped_at DESC LIMIT 20
      `).all(userId, activeProfile.id, sevenDaysAgo, sevenDaysAgo);

      // Get all user_jobs to classify filtered-out ones
      const allUserJobs = db.prepare(`
        SELECT sj.job_id, sj.title, sj.company, sj.search_query,
          uj.domain_profile_id, uj.disliked, uj.applied, uj.resume_generated,
          sj.posted_at, sj.scraped_at
        FROM user_jobs uj
        JOIN scraped_jobs sj ON sj.job_id = uj.job_id
        WHERE uj.user_id = ?
        LIMIT 1000
      `).all(userId);

      const sampleFiltered = [];
      const filterReasonCounts = {};

      for (const job of allUserJobs) {
        let reason = null;
        if (job.domain_profile_id !== activeProfile.id) reason = "wrong_profile";
        else if (job.applied) reason = "applied";
        else if (job.disliked) reason = "disliked";
        else if (job.resume_generated) reason = "resume_generated";
        else {
          const postedTs = job.posted_at && job.posted_at !== ""
            ? Math.floor(new Date(job.posted_at).getTime() / 1000) : null;
          const isTooOld = postedTs
            ? postedTs <= sevenDaysAgo
            : job.scraped_at <= sevenDaysAgo;
          if (isTooOld) reason = "too_old";
        }
        if (reason) {
          filterReasonCounts[reason] = (filterReasonCounts[reason] || 0) + 1;
          if (sampleFiltered.length < 20) sampleFiltered.push({ ...job, filterReason: reason });
        }
      }

      const conditions = [
        `uj.domain_profile_id = ${activeProfile.id}  — active profile: "${activeProfile.profile_name}"`,
        `posted_at or scraped_at > ${new Date(sevenDaysAgo * 1000).toISOString().slice(0, 10)}  (7 days)`,
        `uj.disliked = 0`,
        `uj.applied = 0`,
        `uj.resume_generated = 0`,
      ];

      const rawSql = `SELECT sj.*, uj.domain_profile_id, uj.disliked, uj.applied, uj.resume_generated
FROM user_jobs uj
JOIN scraped_jobs sj ON sj.job_id = uj.job_id
WHERE uj.user_id = ${userId}
  AND uj.domain_profile_id = ${activeProfile.id}
  AND ((sj.posted_at IS NOT NULL AND sj.posted_at != ''
        AND CAST(strftime('%s', sj.posted_at) AS INTEGER) > ${sevenDaysAgo})
       OR ((sj.posted_at IS NULL OR sj.posted_at = '') AND sj.scraped_at > ${sevenDaysAgo}))
  AND (uj.disliked IS NULL OR uj.disliked = 0)
  AND (uj.applied IS NULL OR uj.applied = 0)
  AND (uj.resume_generated IS NULL OR uj.resume_generated = 0)
ORDER BY sj.scraped_at DESC;`;

      res.json({
        activeProfile,
        sessionSyncWouldAdd,
        totalJobsInPool,
        jobsPassingAllFilters: passingCount,
        sampleResults,
        sampleFiltered,
        filterReasonCounts,
        conditions,
        rawSql,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Utility: Clean user pool ──────────────────────────────────
  router.post("/clean-user-pool/:userId", requireAdmin, (req, res) => {
    const userId = parseInt(req.params.userId);
    try {
      const activeProfile = db.prepare(
        "SELECT id FROM domain_profiles WHERE user_id = ? AND is_active = 1"
      ).get(userId);

      const preserved = db.prepare(
        "SELECT COUNT(*) as c FROM user_jobs WHERE user_id = ? AND applied = 1"
      ).get(userId).c;

      const result = db.prepare(`
        DELETE FROM user_jobs
        WHERE user_id = ?
        AND applied = 0
        AND (domain_profile_id IS NULL OR domain_profile_id != ?)
      `).run(userId, activeProfile?.id ?? -1);

      res.json({ removed: result.changes, preserved });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Utility: Re-tag user pool ─────────────────────────────────
  router.post("/retag-user-pool/:userId", requireAdmin, (req, res) => {
    const userId = parseInt(req.params.userId);
    try {
      const activeProfile = db.prepare(
        "SELECT id FROM domain_profiles WHERE user_id = ? AND is_active = 1"
      ).get(userId);

      if (!activeProfile) return res.json({ tagged: 0, stillNull: 0, error: "No active profile" });

      const tagged = db.prepare(`
        UPDATE user_jobs SET domain_profile_id = ?
        WHERE user_id = ? AND domain_profile_id IS NULL
        AND job_id IN (SELECT job_id FROM scraped_jobs WHERE domain_profile_id = ?)
      `).run(activeProfile.id, userId, activeProfile.id);

      const stillNull = db.prepare(
        "SELECT COUNT(*) as c FROM user_jobs WHERE user_id = ? AND domain_profile_id IS NULL"
      ).get(userId).c;

      res.json({ tagged: tagged.changes, stillNull });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Utility: Force scrape ─────────────────────────────────────
  router.post("/force-scrape", requireAdmin, async (req, res) => {
    const { userId, query } = req.body;
    if (!userId || !query) return res.status(400).json({ error: "userId and query required" });
    if (!scrapeJobs) return res.status(501).json({ error: "scrapeJobs not wired up" });
    try {
      const user = db.prepare("SELECT apify_token FROM users WHERE id=?").get(userId);
      if (!user?.apify_token) return res.status(400).json({ error: "User has no apify_token configured" });
      scrapeJobs(query, user.apify_token, {}, userId).catch(console.error);
      res.json({ ok: true, scraping: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Utility: Raw read-only query ──────────────────────────────
  router.get("/raw-query", requireAdmin, (req, res) => {
    const sql = (req.query.sql || "").trim();
    if (!sql) return res.status(400).json({ error: "sql param required" });
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|ATTACH)\b/i.test(sql)) {
      return res.status(400).json({ error: "Only SELECT queries are allowed" });
    }
    try {
      const rows = db.prepare(sql).all().slice(0, 200);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      res.json({ columns, rows, count: rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Utility: Export table as CSV ──────────────────────────────
  const EXPORT_ALLOWED = new Set([
    "scraped_jobs", "user_jobs", "domain_profiles", "usage_events", "scrape_events",
  ]);
  router.get("/export/:table", requireAdmin, (req, res) => {
    const table = req.params.table;
    if (!EXPORT_ALLOWED.has(table)) {
      return res.status(400).json({ error: "Table not allowed for export" });
    }
    try {
      const rows = db.prepare(`SELECT * FROM "${table}" LIMIT 100000`).all();
      if (!rows.length) { res.setHeader("Content-Type","text/csv"); return res.send(""); }
      const headers = Object.keys(rows[0]);
      const escape = v => {
        if (v == null) return "";
        const s = String(v);
        if (s.includes(",") || s.includes('"') || s.includes("\n"))
          return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      const csv = [headers.join(","), ...rows.map(r => headers.map(h => escape(r[h])).join(","))].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${table}.csv"`);
      res.send(csv);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
