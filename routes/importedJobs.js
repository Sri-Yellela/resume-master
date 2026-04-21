import { Router } from "express";
import { publicImportedJob } from "../services/importedJobs.js";

export function createImportedJobsRouter(db) {
  const router = Router();

  router.get("/summary", (req, res) => {
    const rows = db.prepare(`
      SELECT source_key, source_label, COUNT(*) as total, MAX(last_imported_at) as last_imported_at
      FROM imported_jobs
      WHERE user_id=? AND (disliked IS NULL OR disliked = 0)
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

  router.get("/linkedin-saved", (req, res) => {
    const rows = db.prepare(`
      SELECT *
      FROM imported_jobs
      WHERE user_id=? AND source_key='linkedin_saved' AND (disliked IS NULL OR disliked = 0)
      ORDER BY COALESCE(posted_at, '') DESC, last_imported_at DESC, id DESC
    `).all(req.user.id);
    res.json({ jobs: rows.map(publicImportedJob) });
  });

  router.patch("/:id/visited", (req, res) => {
    const row = db.prepare("SELECT id FROM imported_jobs WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Imported job not found" });
    db.prepare("UPDATE imported_jobs SET visited=1, updated_at=unixepoch() WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
    res.json({ ok: true, visited: true });
  });

  router.patch("/:id/starred", (req, res) => {
    const row = db.prepare("SELECT starred FROM imported_jobs WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Imported job not found" });
    const starred = row.starred ? 0 : 1;
    db.prepare("UPDATE imported_jobs SET starred=?, disliked=0, updated_at=unixepoch() WHERE id=? AND user_id=?")
      .run(starred, req.params.id, req.user.id);
    res.json({ ok: true, starred: !!starred });
  });

  router.patch("/:id/disliked", (req, res) => {
    const row = db.prepare("SELECT disliked FROM imported_jobs WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Imported job not found" });
    const disliked = row.disliked ? 0 : 1;
    db.prepare("UPDATE imported_jobs SET disliked=?, starred=0, updated_at=unixepoch() WHERE id=? AND user_id=?")
      .run(disliked, req.params.id, req.user.id);
    res.json({ ok: true, disliked: !!disliked });
  });

  return router;
}
