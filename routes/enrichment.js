// routes/enrichment.js — U1/U2/U3/U4: the admin-gated enrichment control surface.
//
// WHAT THIS ADDS THAT DID NOT EXIST. Enrichment had three triggers — the 04:00 ET cron, a
// setImmediate after cacheJobs/cacheJoboFeed, and enrichJob.js's own row selection — and all three
// were automatic. There was NO manual path, which is how 837 of ~1252 active production rows
// accumulated unenriched during the Groq 404 outage with nothing anyone could do but wait for
// tomorrow. These routes are that path.
//
// ⛔ EVERY SPENDING OR WRITING ROUTE IS DRY BY DEFAULT. POST /run and POST /import both plan the
// work, report the row count and the cost ceiling, and stop unless the body carries `apply: true`.
// The plan is produced by the SAME functions the apply path calls, so what is reported and what is
// done cannot be different sets — the failure mode this codebase keeps rediscovering.
//
// ⛔ ADMIN-GATED, AND FOR TWO DIFFERENT REASONS. /run spends real money per row. /export returns the
// entire board's posting text in one response. Neither is a per-user resource and neither should be
// reachable by an ordinary session.
//
// The routes deliberately do NOT expose anything mapJobRow would have to change. Enrichment columns
// stay on scraped_jobs; provenance is a pointer. See migration 101's comment for the cost of the
// alternative.

import { Router } from "express";
import {
  selectCandidates, estimateCost, columnCoverage, diffCoverage,
  enrichSelectionOptions, DEFAULT_MAX_LAST_SEEN_DAYS, ENRICHMENT_COLUMNS,
} from "../services/jobs/enrichmentSelection.js";
import { runEnrichment } from "../services/jobs/enrichJob.js";
import { buildExport, toJsonl, planImport, applyImport } from "../services/jobs/enrichmentTransfer.js";
import { listBatches, getBatch, revertBatch } from "../services/jobs/enrichmentBatches.js";

// A single manual pass is bounded. The cron's own batch is 25; a manual trigger may ask for more,
// but not for "everything" in one request — an HTTP handler that runs for 837 sequential model
// calls will be killed by a proxy timeout partway through, and the operator would have no idea how
// far it got. Larger backlogs are cleared by repeated calls, each of which is recorded as its own
// batch and is individually revertible.
const MAX_MANUAL_ROWS = 100;
const DEFAULT_MANUAL_ROWS = 10;

export function createEnrichmentRouter(db, requireAdmin, { anthropic = null } = {}) {
  const router = Router();
  router.use(requireAdmin);

  const readSelectionOptions = (src) => ({
    maxLastSeenDays: src.maxLastSeenDays != null
      ? Number(src.maxLastSeenDays)
      : enrichSelectionOptions().maxLastSeenDays,
    source: src.source ? String(src.source) : null,
    jobIds: Array.isArray(src.jobIds) && src.jobIds.length ? src.jobIds.map(String) : null,
  });

  // ── GET /candidates — the dry run, as a read ──────────────────────────────────────────────────
  //
  // Reports the pre-filter count AND the real candidate count separately. They differ by 250x on
  // the restored board, because a bulk `updated_at` touch moved 1247 rows whose text never changed;
  // a surface that showed only the union would quote ~$2.10 to send nothing.
  router.get("/candidates", (req, res) => {
    try {
      const opts = readSelectionOptions(req.query);
      const limit = req.query.limit != null ? Number(req.query.limit) : null;
      const sel = selectCandidates(db, opts);
      const considered = limit != null ? sel.candidates.slice(0, limit) : sel.candidates;
      res.json({
        prefilterCount: sel.prefilterCount,
        candidates: sel.totalMatched,
        gatedOut: sel.gatedOut,
        noDescription: sel.noDescription,
        freshnessGateDays: opts.maxLastSeenDays,
        wouldSend: considered.length,
        estimate: estimateCost(considered),
        estimateIsCeiling: true,
        coverage: columnCoverage(db),
        // Named so a caller can hand exactly this set to POST /run and get the priced work.
        jobIds: considered.map(r => r.job_id),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /run — the manual trigger ────────────────────────────────────────────────────────────
  router.post("/run", async (req, res) => {
    try {
      const body = req.body || {};
      const opts = readSelectionOptions(body);
      const requested = body.limit != null ? Number(body.limit) : DEFAULT_MANUAL_ROWS;
      if (!Number.isFinite(requested) || requested <= 0) {
        return res.status(400).json({ error: "limit must be a positive number" });
      }
      const limit = Math.min(requested, MAX_MANUAL_ROWS);

      const sel = selectCandidates(db, opts);
      const considered = sel.candidates.slice(0, limit);
      const estimate = estimateCost(considered);
      const plan = {
        prefilterCount: sel.prefilterCount,
        candidates: sel.totalMatched,
        gatedOut: sel.gatedOut,
        freshnessGateDays: opts.maxLastSeenDays,
        wouldSend: considered.length,
        limitApplied: limit,
        limitCappedAt: requested > MAX_MANUAL_ROWS ? MAX_MANUAL_ROWS : null,
        estimate, estimateIsCeiling: true,
        jobIds: considered.map(r => r.job_id),
      };

      // U1.3 — the dry run reports what WOULD be enriched and the estimated cost, without calling
      // anything. This is the default, so a mistyped request cannot spend money.
      if (body.apply !== true) {
        return res.json({ applied: false, dryRun: true, plan,
          note: "Nothing was sent and no model was called. POST again with apply: true to run." });
      }
      if (!considered.length) {
        return res.json({ applied: false, plan, written: 0, note: "no candidates" });
      }
      if (!anthropic) {
        // runEnrichment degrades to a logged no-op with no client. Refusing here means "I ran it"
        // can never quietly mean "it skipped".
        return res.status(503).json({ error: "No Anthropic client configured — refusing to run, " +
          "because enrichment would silently skip rather than fail.", plan });
      }

      const ids = considered.map(r => r.job_id);
      const before = columnCoverage(db, { jobIds: ids });
      const result = await runEnrichment(db, anthropic, {
        jobIds: ids,
        batchSize: considered.length,
        maxLastSeenDays: opts.maxLastSeenDays,
        batchSource: "manual",
        batchNotes: `POST /api/admin/enrichment/run by ${req.user?.username ?? "admin"}`,
        recordRun: true,
      });
      const after = columnCoverage(db, { jobIds: ids });
      const coverage = diffCoverage(before, after);

      res.json({
        applied: true, plan,
        enriched: result.enriched, failed: result.failed, empty: result.empty,
        batchId: result.batchId ?? null,
        inputTokens: result.totalInputTokens, outputTokens: result.totalOutputTokens,
        // U1.4 — COVERAGE, NOT CALL COUNTS. `enriched: 10` is compatible with ten null extractions;
        // a per-column delta is not. A2 measured a model returning HTTP 200, success:true and a
        // NULL extraction 49 times in 50, so the count alone is not evidence the pass worked.
        coverage: coverage.rows,
        columnsClimbed: coverage.climbed,
        columnsRegressed: coverage.regressed,
        coverageClimbed: coverage.climbed > 0,
        // Said in the response, not just in a log: U1.5's rule is that if coverage does not climb
        // with the count, STOP rather than scaling up.
        warning: coverage.climbed === 0 && result.enriched > 0
          ? "NO COLUMN GAINED A VALUE despite rows being stamped enriched. Do not scale this up — " +
            "check the provider and model first."
          : null,
        visaColumnsNote: "is_h1b_sponsor / requires_work_auth / is_clearance_required are expected " +
          "at or near zero and are excluded from the climbed/regressed verdict: 0 of 1261 postings " +
          "contain H-1B and 36 mention sponsorship at all. That is the source material, not a failure.",
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /export — U2, JSONL ───────────────────────────────────────────────────────────────────
  //
  // JSONL rather than CSV because CSV loses skills_json's nested shape. Admin-gated because this is
  // the entire board's text.
  router.get("/export", (req, res) => {
    try {
      const opts = readSelectionOptions(req.query);
      const payload = buildExport(db, {
        ...opts,
        candidatesOnly: req.query.allRows !== "1",
        limit: req.query.limit != null ? Number(req.query.limit) : null,
      });
      if (req.query.format === "json") return res.json(payload);
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Content-Disposition", `attachment; filename="enrichment-export.jsonl"`);
      res.send(toJsonl(payload));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /import — U3 ─────────────────────────────────────────────────────────────────────────
  //
  // Body: { jsonl: "<text>", apply?: bool, overwrite?: bool, allowStale?: bool }
  // Dry by default; a malformed file is refused AS A WHOLE and names the offending rows.
  router.post("/import", (req, res) => {
    try {
      const body = req.body || {};
      const text = typeof body.jsonl === "string" ? body.jsonl : null;
      if (!text) return res.status(400).json({ error: "body.jsonl (a JSONL string) is required" });
      const options = { overwrite: body.overwrite === true, allowStale: body.allowStale === true };

      const plan = planImport(db, text, options);
      const planSummary = {
        rowsInFile: plan.rowsInFile, matched: plan.matched, wouldWrite: plan.wouldWrite,
        unchanged: plan.unchanged, perColumn: plan.perColumn, valid: plan.valid,
        rejected: plan.rejected,
        skippedNonNull: plan.planned
          .filter(p => p.skippedNonNull.length)
          .map(p => ({ jobId: p.jobId, columns: p.skippedNonNull })),
        mode: options.overwrite ? "overwrite non-null values" : "fill NULLs only",
        allowStale: options.allowStale,
      };

      if (body.apply !== true) {
        return res.json({ applied: false, dryRun: true, plan: planSummary,
          note: "Nothing was written. POST again with apply: true to apply." });
      }
      if (!plan.valid) {
        // U3.2 — never partially apply. 422 rather than 400: the request is well-formed, the
        // PAYLOAD is not, and the distinction matters to whoever is fixing the file.
        return res.status(422).json({
          applied: false, plan: planSummary, written: 0,
          error: `${plan.rejected.length} row(s) rejected — the file is applied as a whole or not ` +
                 `at all. NOTHING was written.`,
        });
      }

      const ids = plan.planned.filter(p => p.wouldWrite).map(p => p.jobId);
      const before = columnCoverage(db, { jobIds: ids });
      const result = applyImport(db, text, {
        ...options,
        notes: `POST /api/admin/enrichment/import by ${req.user?.username ?? "admin"}`,
      });
      if (!result.ok) return res.status(422).json({ applied: false, plan: planSummary, error: result.reason });
      const coverage = ids.length ? diffCoverage(before, columnCoverage(db, { jobIds: ids })) : null;

      res.json({
        applied: true, plan: planSummary, written: result.written, batchId: result.batchId ?? null,
        coverage: coverage?.rows ?? [], columnsClimbed: coverage?.climbed ?? 0,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── U4 — provenance ──────────────────────────────────────────────────────────────────────────
  router.get("/batches", (req, res) => {
    try {
      res.json({ batches: listBatches(db, { limit: req.query.limit != null ? Number(req.query.limit) : 20 }) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get("/batches/:id", (req, res) => {
    try {
      const batch = getBatch(db, Number(req.params.id));
      if (!batch) return res.status(404).json({ error: `no batch ${req.params.id}` });
      // Per-column tallies rather than the raw row list, which for a 100-row batch is noise.
      const filled = {}, corrected = {};
      for (const r of batch.rows) {
        for (const c of r.filled) filled[c] = (filled[c] || 0) + 1;
        for (const c of r.corrected) corrected[c] = (corrected[c] || 0) + 1;
      }
      res.json({ ...batch, columnsFilled: filled, columnsCorrected: corrected });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Revert is a POST and is dry by default, like the other two writing routes.
  router.post("/batches/:id/revert", (req, res) => {
    try {
      const id = Number(req.params.id);
      const batch = getBatch(db, id);
      if (!batch) return res.status(404).json({ error: `no batch ${id}` });
      if (req.body?.apply !== true) {
        return res.json({
          applied: false, dryRun: true, batchId: id, recordedRows: batch.rows.length,
          alreadyReverted: Boolean(batch.reverted_at),
          note: "Would restore each row to its recorded prior state, including enriched_at and " +
                "content_hash — which returns the rows to the candidate set. Values that came from " +
                "INGESTION are preserved, because the revert replays a per-row before-image rather " +
                "than nulling the enrichment columns. POST again with apply: true.",
        });
      }
      const result = revertBatch(db, id);
      if (!result.ok) return res.status(409).json({ applied: false, error: result.reason });
      res.json({ applied: true, batchId: id, restored: result.restored, missing: result.missing });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /coverage — the enrichment health signal, per column ──────────────────────────────────
  router.get("/coverage", (_req, res) => {
    try {
      res.json({
        coverage: columnCoverage(db),
        columns: ENRICHMENT_COLUMNS,
        freshnessGateDefaultDays: DEFAULT_MAX_LAST_SEEN_DAYS,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
