// Run the job-enrichment pass against the real Anthropic client.
//
// Enrichment normally rides two triggers: the scheduled pipeline, and a background pass after a
// single-URL import. scripts/importJobUrls.mjs deliberately passes NO client — a bulk refill should
// fail loudly rather than quietly spend credits on a URL that falls through to the model path — so
// rows imported that way land with the ATS's own fields and none of the derived ones. This is how
// you fill those in afterwards, on purpose.
//
// Model: services/jobs/enrichJob.js pins claude-haiku-4-5-20251001, one call per posting capped at
// max_tokens 500. THIS SPENDS REAL API CREDITS. --dry-run prints the work and the estimate first.
//
// Usage:
//   node scripts/runEnrichment.mjs --dry-run     # what would run, and roughly what it costs
//   node scripts/runEnrichment.mjs               # one batch (ENRICH_BATCH_SIZE = 25)
//   node scripts/runEnrichment.mjs --all         # repeat until no candidates remain
import "dotenv/config";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runEnrichment } from "../services/jobs/enrichJob.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const ALL = argv.includes("--all");

// Claude Haiku 4.5 list price, for the estimate only — the run reports actual tokens.
const USD_PER_INPUT_MTOK = 1.00;
const USD_PER_OUTPUT_MTOK = 5.00;

const db = new Database(path.join(ROOT, "data", "resume_master.db"));

const pending = () => db.prepare(`
  SELECT COUNT(*) n FROM scraped_jobs
  WHERE is_active = 1 AND description IS NOT NULL AND TRIM(description) != ''
    AND (enriched_at IS NULL OR content_hash IS NULL OR updated_at > enriched_at)
`).get().n;

const coverage = () => db.prepare(`
  SELECT COUNT(*) total,
         SUM(enriched_at IS NOT NULL) enriched,
         SUM(skills_json IS NOT NULL) with_skills,
         SUM(experience_level IS NOT NULL) with_level
  FROM scraped_jobs WHERE is_active = 1
`).get();

const before = coverage();
const candidates = pending();
console.log(`board: ${before.total} active rows — ${before.enriched ?? 0} enriched, ` +
            `${before.with_skills ?? 0} with skills, ${before.with_level ?? 0} with experience level`);
console.log(`candidates needing enrichment: ${candidates}`);

if (candidates === 0) { console.log("Nothing to do."); process.exit(0); }

// The estimate is deliberately rough and stated as such: it prices the descriptions we are about to
// send, at ~4 chars/token, plus the max_tokens ceiling for output. Actual tokens are reported below.
const chars = db.prepare(`
  SELECT COALESCE(SUM(LENGTH(description)), 0) c FROM scraped_jobs
  WHERE is_active = 1 AND description IS NOT NULL AND TRIM(description) != ''
    AND (enriched_at IS NULL OR content_hash IS NULL OR updated_at > enriched_at)
`).get().c;
const estIn = chars / 4;
const estOut = candidates * 500;   // the cap, so this is a ceiling not a guess
const estUsd = (estIn / 1e6) * USD_PER_INPUT_MTOK + (estOut / 1e6) * USD_PER_OUTPUT_MTOK;
console.log(`rough estimate: ~${Math.round(estIn / 1000)}K input + up to ${Math.round(estOut / 1000)}K ` +
            `output tokens ≈ $${estUsd.toFixed(3)} at Haiku 4.5 list price (ceiling, not a quote)`);

if (DRY) { console.log("\n--dry-run: nothing sent."); process.exit(0); }

const key = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || "";
if (!key) {
  // runEnrichment degrades to a logged no-op without a client; fail here instead, so "I ran it"
  // can never quietly mean "it skipped".
  console.error("No ANTHROPIC_KEY (or ANTHROPIC_API_KEY). Refusing to run — enrichment would " +
                "silently skip rather than fail.");
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: key });

let pass = 0;
for (;;) {
  pass++;
  const remaining = pending();
  if (remaining === 0) break;
  console.log(`\n── pass ${pass} — ${remaining} remaining ─────────────────────────`);
  // recordRun: this is a real enrichment pass, so it belongs in the pipeline_runs history.
  const res = await runEnrichment(db, anthropic, { recordRun: true });
  console.log(`enriched=${res.enriched} failed=${res.failed} empty=${res.empty} skipped=${res.skipped}`);
  if (!ALL) break;
  // No progress means another pass would loop forever on the same rows.
  if (res.enriched === 0) { console.log("no progress this pass — stopping"); break; }
}

const after = coverage();
console.log(`\nboard: ${after.total} active rows — ${after.enriched ?? 0} enriched ` +
            `(+${(after.enriched ?? 0) - (before.enriched ?? 0)}), ` +
            `${after.with_skills ?? 0} with skills, ${after.with_level ?? 0} with experience level`);
console.log(`still pending: ${pending()}`);
