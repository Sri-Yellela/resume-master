import { Router } from "express";

// Old scraper sources that are no longer valid — excluded everywhere
const BLOCKED_SOURCES = `('linkedin', 'linkedin_saved')`;

export function createImportedJobsRouter(db) {
  const router = Router();

  // GET /api/imported-jobs/linkedin — jobs saved via the Chrome extension
  router.get("/linkedin", (req, res) => {
    const rows = db.prepare(`
      SELECT
        id, title, company, location, work_type, description,
        job_url, apply_url, company_icon_url, external_job_id,
        visited, starred, disliked, applied,
        last_imported_at, first_imported_at
      FROM imported_jobs
      WHERE user_id=? AND source_key='linkedin_extension' AND (disliked IS NULL OR disliked=0)
      ORDER BY last_imported_at DESC
      LIMIT 200
    `).all(req.user.id);

    res.json({
      jobs: rows.map(r => ({
        id: r.id,
        importedJobId: r.id,
        jobId: `li_ext_${r.id}`,
        boardSource: "linkedin_extension",
        title: r.title,
        company: r.company,
        location: r.location || "",
        workType: r.work_type || "",
        description: r.description || "",
        url: r.job_url || "",
        applyUrl: r.apply_url || "",
        companyIconUrl: r.company_icon_url || null,
        externalJobId: r.external_job_id || null,
        visited: !!r.visited,
        starred: !!r.starred,
        disliked: !!r.disliked,
        applied: !!r.applied,
        importedAt: r.last_imported_at,
        source: "linkedin_extension",
        sourceLabel: "LinkedIn (Extension)",
      })),
    });
  });

  router.get("/summary", (req, res) => {
    const rows = db.prepare(`
      SELECT
        source_key,
        source_label,
        COUNT(*) as total,
        MAX(last_imported_at) as last_imported_at
      FROM imported_jobs
      WHERE user_id=? AND source_key NOT IN ${BLOCKED_SOURCES} AND (disliked IS NULL OR disliked = 0)
      GROUP BY source_key, source_label
      ORDER BY source_label ASC
    `).all(req.user.id);
    res.json({
      sources: rows.map(row => ({
        sourceKey: row.source_key,
        sourceLabel: row.source_label,
        total: row.total || 0,
        lastImportedAt: row.last_imported_at || null,
      })),
    });
  });

  router.patch("/:id/visited", (req, res) => {
    const row = db.prepare(`SELECT id FROM imported_jobs WHERE id=? AND user_id=? AND source_key NOT IN ${BLOCKED_SOURCES}`).get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Imported job not found" });
    db.prepare("UPDATE imported_jobs SET visited=1, updated_at=unixepoch() WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
    res.json({ ok: true, visited: true });
  });

  router.patch("/:id/starred", (req, res) => {
    const row = db.prepare(`SELECT starred FROM imported_jobs WHERE id=? AND user_id=? AND source_key NOT IN ${BLOCKED_SOURCES}`).get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Imported job not found" });
    const starred = row.starred ? 0 : 1;
    db.prepare("UPDATE imported_jobs SET starred=?, disliked=0, updated_at=unixepoch() WHERE id=? AND user_id=?")
      .run(starred, req.params.id, req.user.id);
    res.json({ ok: true, starred: !!starred });
  });

  router.patch("/:id/disliked", (req, res) => {
    const row = db.prepare(`SELECT disliked FROM imported_jobs WHERE id=? AND user_id=? AND source_key NOT IN ${BLOCKED_SOURCES}`).get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Imported job not found" });
    const disliked = row.disliked ? 0 : 1;
    db.prepare("UPDATE imported_jobs SET disliked=?, starred=0, updated_at=unixepoch() WHERE id=? AND user_id=?")
      .run(disliked, req.params.id, req.user.id);
    res.json({ ok: true, disliked: !!disliked });
  });

  return router;
}
