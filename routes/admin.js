// routes/admin.js — Usage analytics and limits admin API
import { Router } from "express";

export function createAdminRouter(db) {
  const router = Router();

  function requireAdmin(req, res, next) {
    if (!req.user?.isAdmin) return res.status(403).json({ error: "Admin access required" });
    next();
  }

  // Helper to get date range params
  function getRange(query) {
    const now = Math.floor(Date.now() / 1000);
    const from = query.from ? parseInt(query.from) : now - 30 * 86400;
    const to   = query.to   ? parseInt(query.to)   : now + 86400;
    return { from, to };
  }

  // ── Overview ─────────────────────────────────────────────────
  router.get("/overview", requireAdmin, (req, res) => {
    const { from, to } = getRange(req.query);
    try {
      const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
      const activeUsers = db.prepare(`
        SELECT COUNT(DISTINCT user_id) as c FROM usage_events
        WHERE created_at BETWEEN ? AND ?
      `).get(from, to).c;

      const totalResumes = db.prepare(`
        SELECT COUNT(*) as c FROM usage_events
        WHERE event_type='resume_generate' AND created_at BETWEEN ? AND ?
      `).get(from, to).c;

      const scrapeStats = db.prepare(`
        SELECT COUNT(*) as c, COALESCE(SUM(inserted_count),0) as inserted
        FROM scrape_events WHERE created_at BETWEEN ? AND ?
      `).get(from, to);

      const tokenStats = db.prepare(`
        SELECT
          COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_creation_tokens),0) as total_tokens,
          COALESCE(SUM(cost_usd),0) as total_cost
        FROM usage_events WHERE created_at BETWEEN ? AND ?
      `).get(from, to);

      const cacheSaved = db.prepare(`
        SELECT COALESCE(SUM(cost_saved_usd),0) as saved
        FROM cache_events WHERE created_at BETWEEN ? AND ?
      `).get(from, to).saved;

      const cacheStats = db.prepare(`
        SELECT
          SUM(CASE WHEN event_type='cache_hit' THEN 1 ELSE 0 END) as hits,
          COUNT(*) as total
        FROM cache_events WHERE created_at BETWEEN ? AND ?
      `).get(from, to);

      const atsStats = db.prepare(`
        SELECT
          AVG(ats_score_before) as avg_before,
          AVG(ats_score_after)  as avg_after
        FROM usage_events
        WHERE event_type='resume_generate' AND ats_score_before IS NOT NULL
          AND ats_score_after IS NOT NULL AND created_at BETWEEN ? AND ?
      `).get(from, to);

      const topEventTypes = db.prepare(`
        SELECT event_type, COUNT(*) as count, COALESCE(SUM(cost_usd),0) as cost
        FROM usage_events WHERE created_at BETWEEN ? AND ?
        GROUP BY event_type ORDER BY count DESC LIMIT 8
      `).all(from, to);

      const topModels = db.prepare(`
        SELECT model,
          COUNT(*) as count,
          COALESCE(SUM(input_tokens+output_tokens),0) as tokens,
          COALESCE(SUM(cost_usd),0) as cost
        FROM usage_events WHERE created_at BETWEEN ? AND ? AND model IS NOT NULL
        GROUP BY model ORDER BY count DESC
      `).all(from, to);

      res.json({
        totalUsers,
        activeUsers,
        totalResumes,
        totalScrapes: scrapeStats.c,
        totalJobsInserted: scrapeStats.inserted,
        totalTokensUsed: tokenStats.total_tokens,
        totalCostUsd: tokenStats.total_cost,
        totalCostSaved: cacheSaved,
        cacheHitRate: cacheStats.total > 0 ? cacheStats.hits / cacheStats.total : 0,
        avgAtsScoreBefore: atsStats.avg_before,
        avgAtsScoreAfter: atsStats.avg_after,
        avgAtsImprovement: atsStats.avg_after != null && atsStats.avg_before != null
          ? atsStats.avg_after - atsStats.avg_before : null,
        topEventTypes,
        topModels,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Per-user breakdown ────────────────────────────────────────
  router.get("/users", requireAdmin, (req, res) => {
    const { from, to } = getRange(req.query);
    const page = Math.max(1, parseInt(req.query.page || "1"));
    const pageSize = Math.min(100, parseInt(req.query.pageSize || "25"));
    const offset = (page - 1) * pageSize;
    try {
      const users = db.prepare(`
        SELECT id, username, created_at FROM users ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(pageSize, offset);

      const result = users.map(u => {
        const ev = db.prepare(`
          SELECT
            SUM(CASE WHEN event_type='resume_generate' THEN 1 ELSE 0 END) as resumes,
            SUM(CASE WHEN event_type='ats_score' THEN 1 ELSE 0 END) as ats_scores,
            SUM(CASE WHEN event_type='pdf_export' THEN 1 ELSE 0 END) as pdf_exports,
            SUM(CASE WHEN event_type='apply_automation' THEN 1 ELSE 0 END) as apply_runs,
            COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_creation_tokens),0) as total_tokens,
            COALESCE(SUM(cost_usd),0) as total_cost,
            MAX(created_at) as last_active
          FROM usage_events WHERE user_id=? AND created_at BETWEEN ? AND ?
        `).get(u.id, from, to);
        const sc = db.prepare(`
          SELECT COUNT(*) as c, COALESCE(SUM(inserted_count),0) as inserted
          FROM scrape_events WHERE user_id=? AND created_at BETWEEN ? AND ?
        `).get(u.id, from, to);
        const ce = db.prepare(`
          SELECT
            SUM(CASE WHEN event_type='cache_hit' THEN 1 ELSE 0 END) as hits,
            COUNT(*) as total,
            COALESCE(SUM(cost_saved_usd),0) as savings
          FROM cache_events WHERE user_id=? AND created_at BETWEEN ? AND ?
        `).get(u.id, from, to);
        const ats = db.prepare(`
          SELECT AVG(ats_score_before) as b, AVG(ats_score_after) as a
          FROM usage_events WHERE user_id=? AND event_type='resume_generate'
            AND ats_score_before IS NOT NULL AND created_at BETWEEN ? AND ?
        `).get(u.id, from, to);
        const limits = db.prepare("SELECT * FROM user_limits WHERE user_id=?").get(u.id);
        return {
          userId: u.id, username: u.username, createdAt: u.created_at,
          resumesGenerated: ev.resumes || 0,
          atsScores: ev.ats_scores || 0,
          jobScrapes: sc.c || 0,
          jobsInserted: sc.inserted || 0,
          pdfExports: ev.pdf_exports || 0,
          applyRuns: ev.apply_runs || 0,
          totalTokens: ev.total_tokens || 0,
          totalCost: ev.total_cost || 0,
          cacheSavings: ce.savings || 0,
          cacheHitRate: ce.total > 0 ? ce.hits / ce.total : 0,
          avgAtsScoreBefore: ats.b,
          avgAtsScoreAfter: ats.a,
          lastActiveAt: ev.last_active,
          limits: limits || null,
        };
      });
      res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── User event log ────────────────────────────────────────────
  router.get("/users/:id/events", requireAdmin, (req, res) => {
    const { from, to } = getRange(req.query);
    const userId = parseInt(req.params.id);
    const page = Math.max(1, parseInt(req.query.page || "1"));
    const pageSize = Math.min(100, parseInt(req.query.pageSize || "25"));
    const offset = (page - 1) * pageSize;
    const eventType = req.query.eventType;
    try {
      let sql = `SELECT * FROM usage_events WHERE user_id=? AND created_at BETWEEN ? AND ?`;
      const params = [userId, from, to];
      if (eventType) { sql += ` AND event_type=?`; params.push(eventType); }
      sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      params.push(pageSize, offset);
      res.json(db.prepare(sql).all(...params));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Timeseries ────────────────────────────────────────────────
  router.get("/timeseries", requireAdmin, (req, res) => {
    const { from, to } = getRange(req.query);
    const granularity = req.query.granularity || "day";
    const metric = req.query.metric || "resumes";
    const bucketSec = granularity === "month" ? 2592000 : granularity === "week" ? 604800 : 86400;
    try {
      let sql;
      if (metric === "resumes") {
        sql = `SELECT (created_at / ?) * ? as bucket, COUNT(*) as value
          FROM usage_events WHERE event_type='resume_generate' AND created_at BETWEEN ? AND ?
          GROUP BY bucket ORDER BY bucket`;
      } else if (metric === "tokens") {
        sql = `SELECT (created_at / ?) * ? as bucket,
          COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_creation_tokens),0) as value
          FROM usage_events WHERE created_at BETWEEN ? AND ?
          GROUP BY bucket ORDER BY bucket`;
      } else if (metric === "cost") {
        sql = `SELECT (created_at / ?) * ? as bucket, COALESCE(SUM(cost_usd),0) as value
          FROM usage_events WHERE created_at BETWEEN ? AND ?
          GROUP BY bucket ORDER BY bucket`;
      } else if (metric === "scrapes") {
        sql = `SELECT (created_at / ?) * ? as bucket, COALESCE(SUM(inserted_count),0) as value
          FROM scrape_events WHERE created_at BETWEEN ? AND ?
          GROUP BY bucket ORDER BY bucket`;
      } else if (metric === "jobs_inserted") {
        sql = `SELECT (created_at / ?) * ? as bucket, COALESCE(SUM(inserted_count),0) as value
          FROM scrape_events WHERE created_at BETWEEN ? AND ?
          GROUP BY bucket ORDER BY bucket`;
      } else if (metric === "cache_hit_rate") {
        sql = `SELECT (created_at / ?) * ? as bucket,
          CAST(SUM(CASE WHEN event_type='cache_hit' THEN 1 ELSE 0 END) AS REAL) / MAX(1,COUNT(*)) as value
          FROM cache_events WHERE created_at BETWEEN ? AND ?
          GROUP BY bucket ORDER BY bucket`;
      } else {
        sql = `SELECT (created_at / ?) * ? as bucket, COUNT(*) as value
          FROM usage_events WHERE created_at BETWEEN ? AND ?
          GROUP BY bucket ORDER BY bucket`;
      }
      const rows = db.prepare(sql).all(bucketSec, bucketSec, from, to);
      res.json(rows.map(r => ({ bucket: r.bucket, value: r.value || 0 })));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Cache performance ─────────────────────────────────────────
  router.get("/cache", requireAdmin, (req, res) => {
    const { from, to } = getRange(req.query);
    try {
      const overall = db.prepare(`
        SELECT
          SUM(CASE WHEN event_type='cache_hit'  THEN 1 ELSE 0 END) as hits,
          SUM(CASE WHEN event_type='cache_miss' THEN 1 ELSE 0 END) as misses,
          SUM(CASE WHEN event_type='cache_write' THEN 1 ELSE 0 END) as writes,
          COALESCE(SUM(tokens_saved),0) as total_tokens_saved,
          COALESCE(SUM(cost_saved_usd),0) as total_cost_saved,
          COUNT(*) as total
        FROM cache_events WHERE created_at BETWEEN ? AND ?
      `).get(from, to);

      const byLayer = db.prepare(`
        SELECT layer,
          SUM(CASE WHEN event_type='cache_hit' THEN 1 ELSE 0 END) as hits,
          SUM(CASE WHEN event_type='cache_miss' THEN 1 ELSE 0 END) as misses,
          COALESCE(SUM(tokens_saved),0) as tokens_saved,
          COALESCE(SUM(cost_saved_usd),0) as cost_saved
        FROM cache_events WHERE created_at BETWEEN ? AND ?
        GROUP BY layer
      `).all(from, to);

      const byDomain = db.prepare(`
        SELECT domain_module,
          COUNT(*) as calls,
          SUM(CASE WHEN event_type='cache_hit' THEN 1 ELSE 0 END) as hits,
          COALESCE(SUM(cost_saved_usd),0) as cost_saved
        FROM cache_events WHERE domain_module IS NOT NULL AND created_at BETWEEN ? AND ?
        GROUP BY domain_module ORDER BY calls DESC
      `).all(from, to);

      const recentHitRate = db.prepare(`
        SELECT CAST(SUM(CASE WHEN event_type='cache_hit' THEN 1 ELSE 0 END) AS REAL) / MAX(1,COUNT(*)) as rate
        FROM cache_events WHERE created_at >= ?
      `).get(Math.floor(Date.now()/1000) - 7*86400).rate || 0;

      res.json({
        totalCacheHits: overall.hits || 0,
        totalCacheMisses: overall.misses || 0,
        totalCacheWrites: overall.writes || 0,
        hitRate: overall.total > 0 ? (overall.hits || 0) / overall.total : 0,
        totalTokensSaved: overall.total_tokens_saved,
        totalCostSaved: overall.total_cost_saved,
        warmthScore: Math.round(recentHitRate * 100),
        byLayer, byDomain,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Limits ────────────────────────────────────────────────────
  router.get("/limits/:userId", requireAdmin, (req, res) => {
    const userId = parseInt(req.params.userId);
    const limits = db.prepare("SELECT * FROM user_limits WHERE user_id=?").get(userId);
    res.json(limits || { user_id: userId });
  });

  router.put("/limits/:userId", requireAdmin, (req, res) => {
    const userId = parseInt(req.params.userId);
    const {
      monthly_resumes, monthly_ats_scores, monthly_job_scrapes,
      monthly_pdf_exports, monthly_apply_runs, monthly_token_budget,
      daily_resumes, daily_job_scrapes, notes,
    } = req.body;
    try {
      db.prepare(`INSERT INTO user_limits (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING`).run(userId);
      db.prepare(`UPDATE user_limits SET
        monthly_resumes=?, monthly_ats_scores=?, monthly_job_scrapes=?,
        monthly_pdf_exports=?, monthly_apply_runs=?, monthly_token_budget=?,
        daily_resumes=?, daily_job_scrapes=?, notes=?,
        updated_at=unixepoch(), updated_by=?
        WHERE user_id=?`)
      .run(
        monthly_resumes ?? null, monthly_ats_scores ?? null,
        monthly_job_scrapes ?? null, monthly_pdf_exports ?? null,
        monthly_apply_runs ?? null, monthly_token_budget ?? null,
        daily_resumes ?? null, daily_job_scrapes ?? null,
        notes ?? null, req.user.id, userId
      );
      res.json(db.prepare("SELECT * FROM user_limits WHERE user_id=?").get(userId));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── CSV export ────────────────────────────────────────────────
  router.get("/export/csv", requireAdmin, (req, res) => {
    const { from, to } = getRange(req.query);
    try {
      const rows = db.prepare(`
        SELECT ue.*, u.username
        FROM usage_events ue JOIN users u ON u.id=ue.user_id
        WHERE ue.created_at BETWEEN ? AND ?
        ORDER BY ue.created_at DESC
      `).all(from, to);
      const headers = ["id","username","event_type","event_subtype","model",
        "input_tokens","output_tokens","cache_read_tokens","cache_creation_tokens",
        "cached","cost_usd","ats_score_before","ats_score_after","duration_ms",
        "job_id","company","success","error_text","created_at"];
      const csv = [
        headers.join(","),
        ...rows.map(r => headers.map(h => {
          const v = r[h];
          if (v == null) return "";
          if (typeof v === "string" && (v.includes(",") || v.includes('"') || v.includes("\n")))
            return `"${v.replace(/"/g, '""')}"`;
          return String(v);
        }).join(","))
      ].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="usage_${from}_${to}.csv"`);
      res.send(csv);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
