import { Router } from "express";
import { importJob, ImportInputError } from "../services/jobs/importJob.js";
import { isPermanentModelFailure } from "../services/modelCall.js";

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
      // userId attaches the import to the person who made it (starred in user_jobs). Without it
      // the row landed in the global pool unowned: the importer had no guarantee of ever seeing
      // it again, while every other user with a matching profile did. requireAuth is applied at
      // the mount in server.js, so req.user is always present here.
      const result = await importJob({ url, text, html }, { db, anthropic, userId: req.user?.id || null });
      res.json(result);
    } catch (err) {
      if (err instanceof ImportInputError) {
        return res.status(400).json({ error: err.message });
      }
      console.error("[POST /api/import/job] Error:", err.message);

      // ⛔ DO NOT TELL A USER TO RETRY SOMETHING THAT CANNOT SUCCEED.
      // Import requires a model call, and when the balance is exhausted every attempt fails the
      // same way in about 200ms. The old blanket "Please try again" sent people into a loop that
      // could only fail, and made an unfunded account read as a flaky feature — which is exactly
      // how it was reported. 503 rather than 502: the service is unavailable, not the upstream
      // misbehaving, and `retryable` says so in a field a client can branch on instead of
      // pattern-matching prose.
      if (isPermanentModelFailure(err)) {
        return res.status(503).json({
          error: "Job capture is unavailable right now — the AI service this needs is not " +
                 "currently funded. Retrying will not help; this needs an account change.",
          retryable: false,
        });
      }
      res.status(502).json({ error: "Could not import this job. Please try again.", retryable: true });
    }
  });

  return router;
}
