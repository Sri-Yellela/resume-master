import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  selectCandidates, computeContentHash, columnCoverage, estimateCost,
  DEFAULT_MAX_LAST_SEEN_DAYS, ENRICHMENT_COLUMNS,
} from "../services/jobs/enrichmentSelection.js";
import {
  buildExport, toJsonl, parseJsonl, planImport, applyImport, validateColumn, SOURCE_FIELDS,
} from "../services/jobs/enrichmentTransfer.js";
import {
  openBatch, closeBatch, captureBefore, recordBatchRow, columnChanges,
  revertBatch, listBatches, getBatch, BATCH_TRACKED_COLUMNS, batchProvenanceAvailable,
} from "../services/jobs/enrichmentBatches.js";
import { mapJobRow } from "../services/jobs/mapJobRow.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = 1788800000;
const DAY = 86400;

// The schema these modules touch, matching migration 101. Kept in one helper so a column added to
// the real migration and forgotten here shows up as a failure rather than as a passing test of a
// schema that no longer exists.
function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, location TEXT, url TEXT, description TEXT,
      source TEXT, summary TEXT, normalized_title TEXT, experience_level TEXT, workplace_type TEXT,
      salary_min_usd INTEGER, salary_max_usd INTEGER, salary_period TEXT, skills_json TEXT,
      is_h1b_sponsor INTEGER, requires_work_auth INTEGER, is_clearance_required INTEGER,
      org_unit_raw TEXT, content_hash TEXT, enriched_at INTEGER, enrichment_batch_id INTEGER,
      is_active INTEGER DEFAULT 1, discovered_at INTEGER, posted_at INTEGER, scraped_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE enrichment_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, provider TEXT, model TEXT,
      started_at INTEGER NOT NULL, finished_at INTEGER,
      rows_attempted INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL DEFAULT 0,
      rows_failed INTEGER NOT NULL DEFAULT 0, rows_empty INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      est_cost_usd REAL NOT NULL DEFAULT 0, coverage_json TEXT, reverted_at INTEGER, notes TEXT
    );
    CREATE TABLE enrichment_batch_rows (
      batch_id INTEGER NOT NULL, job_id TEXT NOT NULL, before_json TEXT NOT NULL,
      filled_json TEXT, written_at INTEGER NOT NULL, PRIMARY KEY (batch_id, job_id)
    );
  `);
  return db;
}

function addJob(db, o = {}) {
  const row = {
    job_id: "j1", title: "Backend Engineer", company: "Acme", location: "Remote",
    url: "https://acme.example/j1", description: "We use Python and Go. Ship services.",
    source: "greenhouse", summary: null, normalized_title: null, experience_level: null,
    workplace_type: null, salary_min_usd: null, salary_max_usd: null, salary_period: null,
    skills_json: null, is_h1b_sponsor: null, requires_work_auth: null,
    is_clearance_required: null, org_unit_raw: null, content_hash: null, enriched_at: null,
    enrichment_batch_id: null, is_active: 1, discovered_at: NOW - 2 * DAY, posted_at: NOW - 3 * DAY,
    scraped_at: NOW - 3600, updated_at: NOW - 3600, ...o,
  };
  db.prepare(`INSERT INTO scraped_jobs (${Object.keys(row).join(",")})
              VALUES (${Object.keys(row).map(k => "@" + k).join(",")})`).run(row);
  return row;
}

// ── U1.2 — the freshness gate ───────────────────────────────────────────────────────────────────

test("U1: the freshness gate keys on scraped_at (last seen), not discovered_at", () => {
  const db = makeDb();
  // The production shape exactly: discovered a month ago, re-sighted this morning. The employer has
  // kept the posting open. Task U expected these to be stale; measurement showed 832 of 837 were
  // last seen within 24 hours. Gating on discovered_at would refuse a live posting.
  addJob(db, { job_id: "long-lived", discovered_at: NOW - 40 * DAY, scraped_at: NOW - 3600 });
  // Genuinely stale: discovered recently but not re-sighted in nine days, so the next cleanup pass
  // deletes it. Enriching this buys an artifact with no life.
  addJob(db, { job_id: "abandoned", discovered_at: NOW - 2 * DAY, scraped_at: NOW - 9 * DAY });

  const { candidates, gatedOut } = selectCandidates(db, { now: NOW });
  assert.deepEqual(candidates.map(c => c.job_id), ["long-lived"],
    "the 40-day-old but re-sighted posting IS a candidate; the abandoned one is not");
  assert.equal(gatedOut, 1, "the un-re-sighted row is reported as gated out, not silently dropped");
});

test("U1: the gate's default horizon equals runExpiredJobsCleanup's expiry horizon", () => {
  // ⛔ THE TWO SEVENS MUST MOVE TOGETHER. The gate means "never spend a token on a row the next
  // cleanup pass would delete". If server.js's cutoff changes and the gate does not, the gate
  // silently becomes an arbitrary age filter and this test is the only thing that would notice.
  // Matched with a line-ending-agnostic regex: server.js is CRLF and a \n-anchored pattern would
  // fail on a fresh clone for reasons that have nothing to do with the code.
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const m = src.match(/const cutoff = Math\.floor\(Date\.now\(\)\/1000\) - (\d+)\*24\*60\*60;/);
  assert.ok(m, "could not find runExpiredJobsCleanup's cutoff in server.js — update this test with it");
  assert.equal(Number(m[1]), DEFAULT_MAX_LAST_SEEN_DAYS,
    `expiry horizon is ${m[1]} days but the enrichment freshness gate defaults to ${DEFAULT_MAX_LAST_SEEN_DAYS}`);
});

test("U1: a null scraped_at is UNGATED rather than treated as infinitely old", () => {
  const db = makeDb();
  addJob(db, { job_id: "never-sighted", scraped_at: null });
  const { candidates } = selectCandidates(db, { now: NOW });
  assert.equal(candidates.length, 1, "a row with no recorded sighting is not known to be stale");
});

test("U1: maxLastSeenDays 0 disables the gate", () => {
  const db = makeDb();
  addJob(db, { job_id: "abandoned", scraped_at: NOW - 90 * DAY });
  assert.equal(selectCandidates(db, { now: NOW }).candidates.length, 0);
  assert.equal(selectCandidates(db, { now: NOW, maxLastSeenDays: 0 }).candidates.length, 1);
});

test("U1: the pre-filter over-counts and the hash check is what makes the answer true", () => {
  const db = makeDb();
  // The restored board's exact shape: enriched, text unchanged, but updated_at bumped by a bulk
  // touch. The pre-filter matches it; the content hash says there is nothing to do.
  const j = addJob(db, { job_id: "touched", enriched_at: NOW - 10 * DAY, updated_at: NOW - DAY });
  db.prepare("UPDATE scraped_jobs SET content_hash = ? WHERE job_id = ?")
    .run(computeContentHash(j.title, j.description), "touched");

  const sel = selectCandidates(db, { now: NOW });
  assert.equal(sel.prefilterCount, 1, "the cheap SQL limb matches it");
  assert.equal(sel.candidates.length, 0, "the content-hash comparison correctly excludes it");
});

test("U1: the dry-run cost estimate is a ceiling and calls nothing", () => {
  const db = makeDb();
  addJob(db, { job_id: "a", description: "x".repeat(4000) });
  const { candidates } = selectCandidates(db, { now: NOW });
  const est = estimateCost(candidates);
  assert.equal(est.rows, 1);
  assert.equal(est.inputTokens, 1000, "4000 chars at ~4 chars/token");
  assert.equal(est.outputTokens, 500, "priced at the max_tokens cap, so it is an upper bound");
  assert.ok(est.usd > 0 && est.usd < 0.01);
});

test("U1: estimateCost caps input at the 4000 chars buildPrompt actually sends", () => {
  // A 40k-char description does not cost 10x: buildPrompt slices to 4000. Pricing the full length
  // would overstate a 837-row backlog by an order of magnitude and the number is meant to be
  // trustworthy enough to spend against.
  const est = estimateCost([{ description: "x".repeat(40000) }]);
  assert.equal(est.inputTokens, 1000);
});

// ── U1.4 — coverage ─────────────────────────────────────────────────────────────────────────────

test("U1: columnCoverage reports per-column fill rates, not one total", () => {
  const db = makeDb();
  addJob(db, { job_id: "a", summary: "s", skills_json: '[{"skill":"Go","type":"hard"}]' });
  addJob(db, { job_id: "b" });
  const cov = columnCoverage(db);
  assert.equal(cov.total, 2);
  assert.equal(cov.columns.summary.filled, 1);
  assert.equal(cov.columns.summary.rate, 0.5);
  assert.equal(cov.columns.skills_json.filled, 1);
  assert.equal(cov.columns.workplace_type.filled, 0);
  for (const c of ENRICHMENT_COLUMNS) assert.ok(c in cov.columns, `${c} is reported`);
});

// ── U2 — export ─────────────────────────────────────────────────────────────────────────────────

test("U2: export separates source columns from the writable enrichment columns", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const { rows, meta } = buildExport(db, { maxLastSeenDays: 0 });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.job_id, "a");
  assert.deepEqual(Object.keys(r.source).sort(), [...SOURCE_FIELDS].sort());
  assert.deepEqual(Object.keys(r.enrichment).sort(), [...ENRICHMENT_COLUMNS].sort());
  assert.deepEqual(meta.writableColumns, ENRICHMENT_COLUMNS);
  assert.ok(r.source.description, "the posting text travels with the row");
});

test("U2: every exported row carries job_id AND a computable content_hash", () => {
  const db = makeDb();
  const j = addJob(db, { job_id: "a", content_hash: null });
  const { rows } = buildExport(db, { maxLastSeenDays: 0 });
  // Recomputed rather than copied from the column: an unenriched row's stored content_hash is NULL,
  // and exporting null would disable the staleness interlock for exactly the rows most likely to
  // be enriched externally.
  assert.equal(rows[0].content_hash, computeContentHash(j.title, j.description));
  assert.equal(rows[0].stored_content_hash, null);
});

test("U2: export uses the same selector as the trigger, so the two sets are identical", () => {
  const db = makeDb();
  addJob(db, { job_id: "fresh", scraped_at: NOW - 3600 });
  addJob(db, { job_id: "abandoned", scraped_at: NOW - 30 * DAY });
  const exported = buildExport(db, { maxLastSeenDays: DEFAULT_MAX_LAST_SEEN_DAYS }).rows.map(r => r.job_id);
  const selected = selectCandidates(db, { maxLastSeenDays: DEFAULT_MAX_LAST_SEEN_DAYS }).candidates.map(r => r.job_id);
  assert.deepEqual(exported, selected);
  assert.deepEqual(exported, ["fresh"]);
});

test("U2 VERIFY: export, change nothing, import — ZERO rows written", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  addJob(db, { job_id: "b", summary: "already here" });
  const jsonl = toJsonl(buildExport(db, { candidatesOnly: false, maxLastSeenDays: 0 }));

  const res = applyImport(db, jsonl);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.written, 0, "an unmodified round trip must write nothing");
  assert.equal(res.plan.rejected.length, 0);
  assert.equal(res.batchId, null, "and it must not open a batch for a no-op");
  // The board is untouched.
  assert.equal(db.prepare("SELECT enriched_at FROM scraped_jobs WHERE job_id='a'").get().enriched_at, null);
});

test("U2: the JSONL _meta header records the predicate the file was produced with", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const jsonl = toJsonl(buildExport(db, { maxLastSeenDays: 3, source: "greenhouse" }));
  const { meta, rows } = parseJsonl(jsonl);
  assert.equal(meta.maxLastSeenDays, 3);
  assert.equal(meta.source, "greenhouse");
  assert.equal(rows.length, 1, "the _meta line is not mistaken for a data row");
});

// ── U3 — import validation ──────────────────────────────────────────────────────────────────────

function exportOne(db, jobId, enrichment, over = {}) {
  const { rows } = buildExport(db, { candidatesOnly: false, maxLastSeenDays: 0, jobIds: [jobId] });
  const row = { ...rows[0], enrichment: { ...rows[0].enrichment, ...enrichment }, ...over };
  return JSON.stringify(row) + "\n";
}

test("U3: an unknown job_id is REJECTED, never inserted", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const line = JSON.stringify({
    job_id: "ghost", content_hash: "deadbeef", enrichment: { summary: "invented" },
  }) + "\n";
  const res = applyImport(db, line);
  assert.equal(res.ok, false);
  assert.equal(res.plan.rejected[0].kind, "unknown_job_id");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM scraped_jobs").get().n, 1, "no row was inserted");
});

test("U3: a changed content_hash is refused by default", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const jsonl = exportOne(db, "a", { summary: "from the old text" });
  // The posting is re-scraped with different text after the export.
  db.prepare("UPDATE scraped_jobs SET description = ? WHERE job_id = 'a'").run("Completely new text.");

  const res = applyImport(db, jsonl);
  assert.equal(res.ok, false);
  assert.equal(res.plan.rejected[0].kind, "stale");
  assert.match(res.plan.rejected[0].error, /changed since export/);
  assert.equal(db.prepare("SELECT summary FROM scraped_jobs WHERE job_id='a'").get().summary, null);

  // allowStale is the deliberate override, and it does NOT stamp content_hash — the operator has
  // just acknowledged this enrichment does not describe the current text.
  const forced = applyImport(db, jsonl, { allowStale: true });
  assert.equal(forced.ok, true, forced.reason);
  assert.equal(forced.written, 1);
  const row = db.prepare("SELECT summary, content_hash FROM scraped_jobs WHERE job_id='a'").get();
  assert.equal(row.summary, "from the old text");
  assert.equal(row.content_hash, null, "a stale-forced import must not claim to describe the new text");
});

test("U3: a row with no content_hash is refused — staleness would be unknowable", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const line = JSON.stringify({ job_id: "a", enrichment: { summary: "x" } }) + "\n";
  const res = applyImport(db, line);
  assert.equal(res.ok, false);
  assert.equal(res.plan.rejected[0].kind, "no_content_hash");
});

test("U3: a malformed batch is rejected AS A WHOLE, naming the offending rows", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  addJob(db, { job_id: "b" });
  addJob(db, { job_id: "c" });
  // Two perfectly good rows and one with free text in an enum column.
  const jsonl = exportOne(db, "a", { summary: "good" })
              + exportOne(db, "b", { experience_level: "Senior Engineer II" })
              + exportOne(db, "c", { summary: "also good" });

  const res = applyImport(db, jsonl);
  assert.equal(res.ok, false);
  assert.equal(res.written, 0, "NOTHING is written — not even the two valid rows");
  assert.equal(res.plan.rejected.length, 1);
  assert.equal(res.plan.rejected[0].jobId, "b", "the offending row is named");
  assert.match(res.plan.rejected[0].error, /experience_level must be one of/);
  // The valid rows really are untouched.
  assert.equal(db.prepare("SELECT summary FROM scraped_jobs WHERE job_id='a'").get().summary, null);
  assert.equal(db.prepare("SELECT summary FROM scraped_jobs WHERE job_id='c'").get().summary, null);
});

test("U3: enums are validated against the shared registry, not merely typed as strings", () => {
  assert.equal(validateColumn("experience_level", "senior").ok, true);
  assert.equal(validateColumn("experience_level", "Senior").ok, false, "case matters — the column is a filter key");
  assert.equal(validateColumn("experience_level", "staff").ok, false, "not in the registry");
  assert.equal(validateColumn("workplace_type", "hybrid").ok, true);
  assert.equal(validateColumn("workplace_type", "wfh").ok, false);
  assert.equal(validateColumn("salary_period", "annual").ok, true);
  assert.equal(validateColumn("salary_period", "yearly").ok, false);
});

test("U3: salary columns must be integers, and a numeric string is refused not coerced", () => {
  assert.equal(validateColumn("salary_min_usd", 120000).ok, true);
  assert.equal(validateColumn("salary_min_usd", "120000").ok, false);
  assert.equal(validateColumn("salary_min_usd", 120000.5).ok, false);
  assert.equal(validateColumn("salary_min_usd", -5).ok, false);
});

test("U3: visa flags accept 0/1/true/false/null and nothing else", () => {
  assert.deepEqual(validateColumn("is_h1b_sponsor", 1), { ok: true, value: 1 });
  assert.deepEqual(validateColumn("is_h1b_sponsor", 0), { ok: true, value: 0 });
  assert.deepEqual(validateColumn("is_h1b_sponsor", true), { ok: true, value: 1 });
  assert.deepEqual(validateColumn("is_h1b_sponsor", false), { ok: true, value: 0 });
  assert.deepEqual(validateColumn("is_h1b_sponsor", null), { ok: true, value: undefined });
  assert.equal(validateColumn("is_h1b_sponsor", "yes").ok, false);
  assert.equal(validateColumn("is_h1b_sponsor", 2).ok, false);
  assert.equal(validateColumn("is_h1b_sponsor", "").ok, false);
});

test("U3: skills_json must be a parseable array, and both stored shapes are accepted", () => {
  assert.equal(validateColumn("skills_json", "not json").ok, false);
  assert.equal(validateColumn("skills_json", '{"a":1}').ok, false, "an object is not an array");
  assert.equal(validateColumn("skills_json", 42).ok, false);
  assert.equal(validateColumn("skills_json", [{ skill: "Go" }, "Python"]).ok, true);
  assert.equal(validateColumn("skills_json", [123]).ok, false, "entries must be strings or {skill,type}");
  // An empty array carries no information and is dropped rather than written as "[]", which would
  // read as enriched-and-found-nothing and keep the row out of any later attempt.
  assert.deepEqual(validateColumn("skills_json", []), { ok: true, value: undefined });
  const v = validateColumn("skills_json", ["Go", { skill: "Kindness", type: "soft" }]);
  assert.deepEqual(JSON.parse(v.value), [
    { skill: "Go", type: "hard" }, { skill: "Kindness", type: "soft" },
  ]);
});

test("U3: an unknown enrichment column is an error, not silently dropped", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const jsonl = exportOne(db, "a", { sumary: "typo'd key" });
  const res = applyImport(db, jsonl);
  assert.equal(res.ok, false);
  assert.equal(res.plan.rejected[0].kind, "unknown_column");
  assert.match(res.plan.rejected[0].error, /sumary/);
});

test("U3: a job_id appearing twice in one file is rejected", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const jsonl = exportOne(db, "a", { summary: "first" }) + exportOne(db, "a", { summary: "second" });
  const res = applyImport(db, jsonl);
  assert.equal(res.ok, false);
  assert.equal(res.plan.rejected[0].kind, "duplicate");
});

test("U3: unparseable JSONL lines are rejected with a line number", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const jsonl = exportOne(db, "a", { summary: "ok" }) + "{not json\n";
  const res = applyImport(db, jsonl);
  assert.equal(res.ok, false);
  const parse = res.plan.rejected.find(r => r.kind === "parse");
  assert.ok(parse, "the bad line is reported");
  assert.equal(parse.line, 2);
});

test("U3: FILL NULLS ONLY by default — overwrite is required to replace a non-null", () => {
  const db = makeDb();
  addJob(db, { job_id: "a", summary: "the value ingestion wrote", experience_level: null });
  const jsonl = exportOne(db, "a", { summary: "external replacement", experience_level: "senior" });

  const additive = applyImport(db, jsonl);
  assert.equal(additive.ok, true, additive.reason);
  assert.equal(additive.written, 1);
  const afterAdditive = db.prepare("SELECT summary, experience_level FROM scraped_jobs WHERE job_id='a'").get();
  assert.equal(afterAdditive.summary, "the value ingestion wrote", "the non-null value is preserved");
  assert.equal(afterAdditive.experience_level, "senior", "the null column is filled");
  // And the skip is REPORTED, so a filler can see their value was not taken.
  assert.deepEqual(additive.plan.planned.find(p => p.jobId === "a").skippedNonNull, ["summary"]);

  const forced = applyImport(db, jsonl, { overwrite: true });
  assert.equal(forced.ok, true, forced.reason);
  assert.equal(db.prepare("SELECT summary FROM scraped_jobs WHERE job_id='a'").get().summary,
    "external replacement");
});

test("U3 VERIFY: a batch that fills nothing writes no enriched_at", () => {
  const db = makeDb();
  // Every supplied value loses to an existing non-null, so nothing is filled.
  addJob(db, { job_id: "a", summary: "existing", enriched_at: null });
  const jsonl = exportOne(db, "a", { summary: "would replace but may not" });
  const res = applyImport(db, jsonl);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.written, 0);
  const row = db.prepare("SELECT enriched_at, content_hash FROM scraped_jobs WHERE job_id='a'").get();
  // THE POISONED SHAPE: a row marked done and empty leaves the candidate set forever, because the
  // hash only changes if the title or description does.
  assert.equal(row.enriched_at, null, "no enriched_at stamp for a row nothing was written to");
  assert.equal(row.content_hash, null);
  assert.equal(selectCandidates(db, { maxLastSeenDays: 0 }).candidates.length, 1,
    "the row is still a candidate, so it can be enriched later");
});

test("U3: a successful import stamps enriched_at and content_hash, retiring the row as a candidate", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const jsonl = exportOne(db, "a", { summary: "real enrichment", experience_level: "mid" });
  const res = applyImport(db, jsonl);
  assert.equal(res.written, 1);
  const row = db.prepare("SELECT * FROM scraped_jobs WHERE job_id='a'").get();
  assert.ok(row.enriched_at, "a row that gained a value IS stamped");
  assert.equal(row.content_hash, computeContentHash(row.title, row.description));
  assert.equal(selectCandidates(db, { maxLastSeenDays: 0 }).candidates.length, 0);
});

test("U3: planImport is a pure dry run — it writes nothing", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const jsonl = exportOne(db, "a", { summary: "x", experience_level: "senior" });
  const plan = planImport(db, jsonl);
  assert.equal(plan.wouldWrite, 1);
  assert.deepEqual(plan.perColumn, { summary: 1, experience_level: 1 });
  assert.equal(plan.valid, true);
  // Nothing moved.
  const row = db.prepare("SELECT summary, enriched_at FROM scraped_jobs WHERE job_id='a'").get();
  assert.equal(row.summary, null);
  assert.equal(row.enriched_at, null);
});

test("U3: nothing is partially applied when a later row throws", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  addJob(db, { job_id: "b" });
  const jsonl = exportOne(db, "a", { summary: "first" }) + exportOne(db, "b", { summary: "second" });
  const plan = planImport(db, jsonl);
  assert.equal(plan.wouldWrite, 2);
  // Make the SECOND row's UPDATE abort, so the failure lands after the first has already been
  // written. A trigger is used rather than dropping a table because dropping one now takes the
  // graceful no-provenance path instead of throwing — which is correct behaviour, and would have
  // made this test silently stop testing atomicity.
  db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON scraped_jobs
           WHEN NEW.job_id = 'b' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
  assert.throws(() => applyImport(db, jsonl), /boom/);
  // The first row's write was rolled back with the transaction.
  assert.equal(db.prepare("SELECT summary FROM scraped_jobs WHERE job_id='a'").get().summary, null);
});

// ── U4 — batch provenance ───────────────────────────────────────────────────────────────────────

test("U4: a batch is identifiable — source, model, cost and what it filled", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const id = openBatch(db, { source: "manual", provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  const before = captureBefore(db, "a");
  db.prepare("UPDATE scraped_jobs SET summary='s', enriched_at=1, enrichment_batch_id=? WHERE job_id='a'").run(id);
  const after = captureBefore(db, "a");
  recordBatchRow(db, id, "a", before, columnChanges(before, after));
  closeBatch(db, id, { rowsAttempted: 1, rowsWritten: 1, estCostUsd: 0.0025 });

  const batch = getBatch(db, id);
  assert.equal(batch.source, "manual");
  assert.equal(batch.model, "claude-haiku-4-5-20251001");
  assert.equal(batch.rows_written, 1);
  assert.equal(batch.est_cost_usd, 0.0025);
  assert.deepEqual(batch.rows[0].filled, ["summary"]);
  assert.equal(db.prepare("SELECT enrichment_batch_id FROM scraped_jobs WHERE job_id='a'").get().enrichment_batch_id, id);
  assert.equal(listBatches(db)[0].id, id);
});

test("U4: openBatch refuses an unnamed source", () => {
  const db = makeDb();
  assert.throws(() => openBatch(db, { source: "whatever" }), /source must be one of/);
});

test("U4: columnChanges separates a FILL from a CORRECTION", () => {
  // They are not interchangeable: a correction moves no fill rate, so collapsing them makes a
  // correction-only pass indistinguishable from a pass that extracted nothing.
  const before = { summary: null, experience_level: "mid" };
  const after = { summary: "new", experience_level: "senior" };
  assert.deepEqual(columnChanges(before, after), { filled: ["summary"], corrected: ["experience_level"] });
});

test("U4 VERIFY: a batch is revertible, and the revert restores ingestion values it never wrote", () => {
  const db = makeDb();
  // experience_level came from INGESTION and predates the batch. A revert that blanket-nulled every
  // enrichment column would destroy it — the same defect as the bug that nulled 120 rows, pointed
  // the other way.
  addJob(db, { job_id: "a", experience_level: "mid", summary: null });
  const id = openBatch(db, { source: "manual" });
  const before = captureBefore(db, "a");
  db.prepare(`UPDATE scraped_jobs SET summary='batch wrote this', workplace_type='remote',
              enriched_at=999, content_hash='abc', enrichment_batch_id=? WHERE job_id='a'`).run(id);
  recordBatchRow(db, id, "a", before, columnChanges(before, captureBefore(db, "a")));
  closeBatch(db, id, { rowsAttempted: 1, rowsWritten: 1 });

  const res = revertBatch(db, id);
  assert.equal(res.ok, true);
  assert.equal(res.restored, 1);

  const row = db.prepare("SELECT * FROM scraped_jobs WHERE job_id='a'").get();
  assert.equal(row.summary, null, "what the batch wrote is gone");
  assert.equal(row.workplace_type, null);
  assert.equal(row.experience_level, "mid", "what ingestion wrote SURVIVES the revert");
  assert.equal(row.enriched_at, null, "the stamp is restored too");
  assert.equal(row.content_hash, null);
  assert.equal(row.enrichment_batch_id, null);
  // Restoring the stamps is what puts the row back in the candidate set. Reverting the values but
  // leaving it stamped would produce the poisoned shape.
  assert.equal(selectCandidates(db, { maxLastSeenDays: 0 }).candidates.length, 1);
});

test("U4: a revert keeps its own evidence and is not repeatable", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const id = openBatch(db, { source: "manual" });
  const before = captureBefore(db, "a");
  db.prepare("UPDATE scraped_jobs SET summary='x', enrichment_batch_id=? WHERE job_id='a'").run(id);
  recordBatchRow(db, id, "a", before, columnChanges(before, captureBefore(db, "a")));

  assert.equal(revertBatch(db, id).ok, true);
  const batch = getBatch(db, id);
  assert.ok(batch.reverted_at, "the batch is stamped reverted rather than deleted");
  assert.equal(batch.rows.length, 1, "the before-image rows are KEPT — the record is the point");

  const second = revertBatch(db, id);
  assert.equal(second.ok, false);
  assert.match(second.reason, /already reverted/);
});

test("U4: reverting an unknown or empty batch reports why instead of throwing", () => {
  const db = makeDb();
  assert.match(revertBatch(db, 999).reason, /no batch 999/);
  const id = openBatch(db, { source: "cron" });
  assert.match(revertBatch(db, id).reason, /no recorded rows/);
});

test("U4: an import records provenance with source 'import' and zero token cost", () => {
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const res = applyImport(db, exportOne(db, "a", { summary: "external" }), { notes: "vendor batch 3" });
  assert.equal(res.written, 1);
  const batch = getBatch(db, res.batchId);
  assert.equal(batch.source, "import");
  assert.equal(batch.provider, "external");
  assert.equal(batch.input_tokens, 0, "an import spends no tokens and must not claim to");
  assert.equal(batch.notes, "vendor batch 3");
  assert.deepEqual(batch.rows[0].filled, ["summary"]);
  // And it is revertible like any other batch.
  assert.equal(revertBatch(db, res.batchId).restored, 1);
  assert.equal(db.prepare("SELECT summary FROM scraped_jobs WHERE job_id='a'").get().summary, null);
});

test("U4 VERIFY: mapJobRow is unchanged — the board response is byte-identical", () => {
  // The whole reason the enrichment columns stayed on scraped_jobs. A row carrying the new
  // enrichment_batch_id must map to exactly the same JSON as one without it: no new key, no
  // reordering, nothing for a client to notice.
  const db = makeDb();
  addJob(db, { job_id: "a", summary: "s", experience_level: "mid", enrichment_batch_id: null });
  const withoutBatch = db.prepare("SELECT * FROM scraped_jobs WHERE job_id='a'").get();
  db.prepare("UPDATE scraped_jobs SET enrichment_batch_id = 7 WHERE job_id='a'").run();
  const withBatch = db.prepare("SELECT * FROM scraped_jobs WHERE job_id='a'").get();

  assert.equal(withBatch.enrichment_batch_id, 7, "the column really is set on the row");
  assert.equal(JSON.stringify(mapJobRow(withBatch)), JSON.stringify(mapJobRow(withoutBatch)),
    "mapJobRow must not leak enrichment_batch_id into the board contract");
  assert.equal("enrichmentBatchId" in mapJobRow(withBatch), false);
});

test("U4: BATCH_TRACKED_COLUMNS covers every enrichment column plus both stamps", () => {
  // A column added to enrichment but not to the before-image would be un-revertible, and the
  // failure would be silent — the revert would simply not restore it.
  for (const c of ENRICHMENT_COLUMNS) assert.ok(BATCH_TRACKED_COLUMNS.includes(c), `${c} is tracked`);
  assert.ok(BATCH_TRACKED_COLUMNS.includes("enriched_at"));
  assert.ok(BATCH_TRACKED_COLUMNS.includes("content_hash"));
});

test("U4: batchProvenanceAvailable requires BOTH tables AND the pointer column", () => {
  // ⛔ THIS IS THE CHECK A REAL BUG NEEDED. Enrichment was written to degrade gracefully when
  // provenance was unavailable, and openBatch duly warned and continued — but the UPDATE also
  // names scraped_jobs.enrichment_batch_id, so on a database with neither it threw a bare
  // SQLITE_ERROR instead of degrading. Two test fixtures failed that way. Checking only the tables
  // reproduces the bug, so all three are checked.
  const db = makeDb();
  assert.equal(batchProvenanceAvailable(db), true);

  const noColumn = new Database(":memory:");
  noColumn.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY);
    CREATE TABLE enrichment_batches (id INTEGER PRIMARY KEY, source TEXT, started_at INTEGER);
    CREATE TABLE enrichment_batch_rows (batch_id INTEGER, job_id TEXT, before_json TEXT, written_at INTEGER);
  `);
  assert.equal(batchProvenanceAvailable(noColumn), false, "tables present but no pointer column");

  const noTables = new Database(":memory:");
  noTables.exec("CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, enrichment_batch_id INTEGER);");
  assert.equal(batchProvenanceAvailable(noTables), false, "column present but no tables");

  assert.equal(batchProvenanceAvailable(new Database(":memory:")), false, "no scraped_jobs at all");
});

test("U3: an import still works on a database with no provenance tables", () => {
  // The degradation has to be real, not just claimed: a database predating migration 101 must still
  // be importable, without provenance and with a warning.
  const db = makeDb();
  addJob(db, { job_id: "a" });
  const jsonl = exportOne(db, "a", { summary: "external" });
  db.exec("DROP TABLE enrichment_batches");
  assert.equal(batchProvenanceAvailable(db), false);

  const res = applyImport(db, jsonl);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.written, 1, "the import still lands");
  assert.equal(res.batchId, null, "but nothing claims provenance it does not have");
  assert.equal(db.prepare("SELECT summary FROM scraped_jobs WHERE job_id='a'").get().summary, "external");
});

test("U4: migration 101 is byte-identical in both migration paths", () => {
  // The dual path is maintained by hand and is only a guarantee if the two are literally the same
  // bytes. Task T's schema diff was the first check of it against a deployed database; this is the
  // check that runs on every commit.
  const slice = (file) => {
    const s = fs.readFileSync(path.join(ROOT, file), "utf8");
    const i = s.indexOf('id: "101_enrichment_batches"');
    assert.notEqual(i, -1, `${file} does not contain migration 101`);
    const j = s.indexOf("ON scraped_jobs(enrichment_batch_id);", i);
    assert.notEqual(j, -1, `${file}'s migration 101 is truncated`);
    return s.slice(i, j);
  };
  assert.equal(slice("scripts/migrations.js"), slice("server.js"));
});
