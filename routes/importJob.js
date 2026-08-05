import { Router } from "express";
import { importJob, ImportInputError } from "../services/jobs/importJob.js";

// Sibling to routes/importedJobs.js, NOT an extension of it — importedJobs.js manages the
// legacy per-user `imported_jobs` table (LinkedIn-extension saved jobs). This router writes
// into the global scraped_jobs pool instead, via the same dedup/enrichment pipeline every other
// source uses. See services/jobs/importJob.js for the extraction + dedup logic.
export function createImportJobRouter(db, anthropic) {
  const router = Router();

  // POST /api/import/job — { url?, text?, html? }, at least one required.
  router.post("/job", async (req, res) => {
    const { url, text, html } = req.body || {};
    try {
      const result = await importJob({ url, text, html }, { db, anthropic });
      res.json(result);
    } catch (err) {
      if (err instanceof ImportInputError) {
        return res.status(400).json({ error: err.message });
      }
      console.error("[POST /api/import/job] Error:", err.message);
      res.status(502).json({ error: "Could not import this job. Please try again." });
    }
  });

  return router;
}
