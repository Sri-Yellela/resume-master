#!/usr/bin/env node
// scripts/u5EnrichmentTransferVerify.mjs
//
// U5 — REAL-RUN VERIFICATION OF THE ENRICHMENT ROUND TRIP, over real HTTP against the real router.
//
// WHY THIS EXISTS AND WHY IT IS NOT A node:test FILE. The unit suite already covers
// enrichmentTransfer.js's planner in isolation, and it passed while three real defects sat in the
// pipeline (see docs: "npm test cannot see pipeline defects"). What it cannot see is the part that
// broke here: the ROUTE. The raw application/x-ndjson body path, the 4mb JSON-body ceiling, the
// dry-run-then-apply gate, and above all the concurrency guard reporting a refusal as
// `applied: true` — every one of those lives in Express middleware and handler code that a direct
// call to planImport() never touches. So this harness boots the actual router on an actual socket
// and speaks HTTP to it.
//
// THE SCHEMA IS READ FROM THE REAL DATABASE, not redeclared here. A hand-copied CREATE TABLE is a
// second source of truth that passes forever against a schema the server stopped using; this reads
// sqlite_master from data/resume_master.db and creates the same tables in a temp file. The DATA is
// synthetic and deterministic, because these assertions are about exact fill deltas and the real
// board's 5 candidates cannot produce a stable one.
//
// NO MODEL IS CALLED AND NO TOKEN IS SPENT. The one test that needs enrichment in flight (the
// concurrency guard) uses a stub whose create() blocks on a gate this file opens, which is also
// the only way to hold a pass open long enough for a second request to collide with it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import Database from "better-sqlite3";

import { createEnrichmentRouter } from "../routes/enrichment.js";
import { computeContentHash } from "../services/jobs/enrichmentSelection.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const REAL_DB = path.join(ROOT, "data", "resume_master.db");

let passes = 0, fails = 0;
const pass = (m) => { passes++; console.log(`PASS ${m}`); };
const fail = (m, detail) => {
  fails++;
  console.log(`FAIL ${m}`);
  if (detail !== undefined) console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};
const check = (cond, m, detail) => (cond ? pass(m) : fail(m, detail));

// ── the harness database ────────────────────────────────────────────────────────────────────────

// The three the round trip writes to, plus the two the enrichment pass logs into. usage_events and
// pipeline_runs are not asserted on here, but without them a real run prints "FAILED TO RECORD
// USAGE — spend is happening and is not being logged", which is a genuine alarm this harness has no
// business raising falsely.
const TABLES = ["scraped_jobs", "enrichment_batches", "enrichment_batch_rows",
                "usage_events", "cache_events", "pipeline_runs"];

function makeDb() {
  if (!fs.existsSync(REAL_DB)) {
    console.log(`FAIL cannot read the real schema — ${REAL_DB} does not exist`);
    process.exit(1);
  }
  const real = new Database(REAL_DB, { readonly: true });
  const stmt = real.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`);
  // Pulled transitively: scraped_jobs carries a foreign key to domain_profiles, and SQLite
  // resolves it at prepare() time, so a temp database with only the three tables this harness
  // writes to cannot even compile an INSERT. Following REFERENCES is how the harness stays
  // correct when a future migration adds another one.
  const ddl = [];
  const seenTables = new Set();
  const collect = (t) => {
    if (seenTables.has(t)) return;
    seenTables.add(t);
    const row = stmt.get(t);
    if (!row?.sql) {
      console.log(`FAIL the real database has no table ${t} — migration 101 may not have run`);
      real.close();
      process.exit(1);
    }
    for (const m of row.sql.matchAll(/REFERENCES\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) collect(m[1]);
    ddl.push(row.sql);
  };
  for (const t of TABLES) collect(t);
  real.close();

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "u5-")), "board.db");
  const db = new Database(file);
  for (const sql of ddl) db.exec(sql);
  // Enforcement off, DDL still real. The tables above are created with their true definitions —
  // which is what makes the prepare()-time column and type checks meaningful — but this fixture
  // deliberately has no users or domain_profiles ROWS to point at, and usage logging would
  // otherwise fail an FK and print a spend-not-logged alarm that is false here. Nothing this
  // harness asserts depends on referential integrity.
  db.pragma("foreign_keys = OFF");
  return { db, file };
}

const NOW = Math.floor(Date.now() / 1000);

/** Seeds N postings with EVERY enrichment column null — the state an external filler receives. */
function seed(db, n, { prefix = "u5", enriched = false } = {}) {
  // search_query and _hash are NOT NULL with no default on the real table — supplied here rather
  // than worked around, so this harness keeps failing loudly if the real schema gains another one.
  const ins = db.prepare(`
    INSERT INTO scraped_jobs (job_id, title, company, location, url, description, source,
      search_query, _hash, is_active, discovered_at, posted_at, scraped_at, updated_at,
      skills_json, summary, experience_level, enriched_at, content_hash)
    VALUES (@job_id, @title, @company, @location, @url, @description, @source,
      @search_query, @hash, 1, @t, @t, @t, @t,
      @skills_json, @summary, @experience_level, @enriched_at, @content_hash)`);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const job_id = `${prefix}-${i}`;
    const title = `Backend Engineer ${i}`;
    const description = `Posting ${i}. We use Python, Go and Kubernetes. Ship reliable services.`;
    ins.run({
      job_id, title, company: `Acme ${i}`, location: "Remote",
      url: `https://acme.example/${job_id}`, description, source: "greenhouse", t: NOW,
      search_query: "backend engineer", hash: `${prefix}-hash-${i}`,
      skills_json: enriched ? JSON.stringify([{ skill: "Java", type: "hard" }]) : null,
      summary: enriched ? "An existing summary that must survive." : null,
      experience_level: enriched ? "senior" : null,
      enriched_at: enriched ? NOW : null,
      content_hash: enriched ? computeContentHash(title, description) : null,
    });
    ids.push(job_id);
  }
  return ids;
}

// ── the harness server ──────────────────────────────────────────────────────────────────────────

/** Boots the REAL router. requireAdmin is stubbed open; every other layer is production code. */
async function boot(db, anthropic) {
  const app = express();
  app.use(express.json({ limit: "4mb" }));          // the same global limit server.js installs
  const allowAdmin = (req, _res, next) => { req.user = { username: "u5-harness" }; next(); };
  app.use("/api/admin/enrichment", createEnrichmentRouter(db, allowAdmin, { anthropic }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

/** Uploads a JSONL file the way the admin panel does: a raw application/x-ndjson body. */
async function importJsonl(base, jsonl, { apply = false, overwrite = false, allowStale = false } = {}) {
  const qs = new URLSearchParams();
  if (apply) qs.set("apply", "1");
  if (overwrite) qs.set("overwrite", "1");
  if (allowStale) qs.set("allowStale", "1");
  const r = await fetch(`${base}/api/admin/enrichment/import?${qs}`, {
    method: "POST", headers: { "Content-Type": "application/x-ndjson" }, body: jsonl,
  });
  return { status: r.status, body: await r.json() };
}

async function exportJsonl(base, ids) {
  const qs = new URLSearchParams({ allRows: "1", format: "json" });
  for (const id of ids) qs.append("jobIds", id);
  const r = await fetch(`${base}/api/admin/enrichment/export?${qs}`);
  return r.json();
}

/** Rebuilds the JSONL a filler would return: the exported rows, with `mutate` applied to each. */
function refill(payload, mutate) {
  return payload.rows.map(row => {
    const out = { job_id: row.job_id, content_hash: row.content_hash,
                  enrichment: { ...row.enrichment } };
    mutate(out, row);
    return JSON.stringify(out);
  }).join("\n") + "\n";
}

const coverageOf = (body, column) => (body.coverage || []).find(c => c.column === column);

// ── the runs ────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const { db, file } = makeDb();
  const ids = seed(db, 20);
  const { server, base } = await boot(db, null);

  try {
    // ── 1 · export 20, change nothing, import: ZERO rows written ────────────────────────────────
    const exported = await exportJsonl(base, ids);
    check(exported.rows.length === 20, "export returns the 20 requested rows",
      `got ${exported.rows.length}`);
    check(exported.rows.every(r => r.content_hash), "every exported row carries a content_hash");

    const untouched = refill(exported, () => {});
    const noop = await importJsonl(base, untouched, { apply: true });
    check(noop.status === 200 && noop.body.written === 0,
      "UNCHANGED round trip writes ZERO rows",
      `status ${noop.status}, written ${noop.body.written}`);
    check(noop.body.batchId == null,
      "an unchanged round trip opens no batch (nothing happened, so nothing is recorded)");
    const stamped = db.prepare(
      `SELECT COUNT(*) c FROM scraped_jobs WHERE job_id LIKE 'u5-%' AND enriched_at IS NOT NULL`).get().c;
    check(stamped === 0,
      "⛔ no row was stamped enriched_at by a write-nothing import (the 120-row poisoning)",
      `${stamped} row(s) stamped`);

    // ── 2 · fill skills_json only: ONLY skills_json climbs ──────────────────────────────────────
    const skillsOnly = refill(exported, (out) => {
      out.enrichment.skills_json = [{ skill: "Python", type: "hard" }, { skill: "Go", type: "hard" }];
    });
    const dry = await importJsonl(base, skillsOnly);
    check(dry.status === 200 && dry.body.applied === false && dry.body.dryRun === true,
      "DRY RUN IS THE DEFAULT — apply must be asked for explicitly");
    check(dry.body.plan.wouldWrite === 20, "the dry run projects 20 rows to write",
      `wouldWrite ${dry.body.plan.wouldWrite}`);
    check(coverageOf(dry.body, "skills_json")?.delta === 20,
      "the dry run PROJECTS the per-column fill delta before anything is written",
      coverageOf(dry.body, "skills_json"));
    const wroteNothingYet = db.prepare(
      `SELECT COUNT(*) c FROM scraped_jobs WHERE skills_json IS NOT NULL`).get().c;
    check(wroteNothingYet === 0, "the dry run wrote NOTHING to the board", `${wroteNothingYet} rows`);

    const applied = await importJsonl(base, skillsOnly, { apply: true });
    check(applied.status === 200 && applied.body.written === 20,
      "apply writes the 20 rows", `status ${applied.status}, written ${applied.body.written}`);
    const climbed = (applied.body.coverage || []).filter(c => c.delta !== 0 && c.column !== "enriched_at");
    check(climbed.length === 1 && climbed[0].column === "skills_json" && climbed[0].delta === 20,
      "ONLY skills_json climbed — no other column was touched",
      climbed.map(c => `${c.column} ${c.delta}`).join(", ") || "nothing climbed");
    check(applied.body.warning === null,
      "a real fill raises no columnsClimbed:0 warning", applied.body.warning);
    const importBatchId = applied.body.batchId;
    check(importBatchId != null, "the import opened a batch");

    // ── 3 · a malformed batch is rejected WHOLE, naming the offending rows ──────────────────────
    const before3 = db.prepare(`SELECT COUNT(*) c FROM scraped_jobs WHERE summary IS NOT NULL`).get().c;
    const malformed = refill(exported, (out, row) => {
      out.enrichment.summary = "A valid summary for every row.";
      // 'mid level' is the exact free-text/registry mismatch this codebase shipped once.
      if (row.job_id === "u5-3")  out.enrichment.experience_level = "mid level";
      if (row.job_id === "u5-7")  out.enrichment.salary_min_usd = "120000";     // string, not int
      if (row.job_id === "u5-11") out.enrichment.is_h1b_sponsor = "yes";        // not 0/1/null
      if (row.job_id === "u5-15") out.enrichment.skills_json = { skill: "Python" }; // not an array
    });
    const bad = await importJsonl(base, malformed, { apply: true });
    check(bad.status === 422, "a malformed batch is refused with 422", `status ${bad.status}`);
    const rejectedIds = (bad.body.plan?.rejected || []).map(r => r.jobId).sort();
    check(JSON.stringify(rejectedIds) === JSON.stringify(["u5-11", "u5-15", "u5-3", "u5-7"]),
      "every offending row is NAMED, and only those rows", rejectedIds);
    const namesColumn = (bad.body.plan?.rejected || []).every(r => /experience_level|salary_min_usd|is_h1b_sponsor|skills_json/.test(r.error));
    check(namesColumn, "each rejection names the offending COLUMN, not just the row");
    const after3 = db.prepare(`SELECT COUNT(*) c FROM scraped_jobs WHERE summary IS NOT NULL`).get().c;
    check(before3 === after3 && after3 === 0,
      "⛔ NOTHING was written — not even the 16 rows that validated",
      `summary filled on ${after3} row(s)`);

    // ── 4 · a row whose content_hash changed since export is refused and reported ───────────────
    db.prepare(`UPDATE scraped_jobs SET description = ? WHERE job_id = 'u5-5'`)
      .run("REWRITTEN: this posting was edited after the export.");
    const staleFile = refill(exported, (out) => { out.enrichment.summary = "Post-export summary."; });
    const stale = await importJsonl(base, staleFile, { apply: true });
    check(stale.status === 422, "a file containing a changed posting is refused", `status ${stale.status}`);
    const staleRow = (stale.body.plan?.rejected || []).find(r => r.jobId === "u5-5");
    check(staleRow?.kind === "stale", "the changed row is reported as stale, by id", staleRow);
    check(/changed since export/.test(staleRow?.error || ""),
      "the staleness rejection explains itself", staleRow?.error);
    check((stale.body.plan?.rejected || []).length === 1,
      "only the changed row is refused — the other 19 are fine",
      `${(stale.body.plan?.rejected || []).length} rejected`);
    const staleSummary = db.prepare(`SELECT summary FROM scraped_jobs WHERE job_id='u5-5'`).get().summary;
    check(staleSummary === null, "the stale row kept its NULL summary", staleSummary);

    // ── 5 · --overwrite is required to replace a non-null value ─────────────────────────────────
    // skills_json is non-null on every row now (scenario 2 filled it).
    const clash = refill(exported, (out) => {
      out.enrichment.skills_json = [{ skill: "Rust", type: "hard" }];
    });
    // u5-5's text changed in scenario 4, so exclude it: this test is about overwrite, not staleness.
    const clashRows = clash.split("\n").filter(l => l.trim() && !l.includes('"u5-5"')).join("\n") + "\n";

    const noFlag = await importJsonl(base, clashRows, { apply: true });
    const survived = db.prepare(`SELECT skills_json FROM scraped_jobs WHERE job_id='u5-0'`).get().skills_json;
    check(noFlag.status === 200 && noFlag.body.written === 0,
      "without overwrite, a clashing file writes nothing", `written ${noFlag.body.written}`);
    check(/Python/.test(survived) && !/Rust/.test(survived),
      "⛔ the existing value SURVIVED — external data did not clobber it", survived);
    check((noFlag.body.plan?.skippedNonNull || []).length === 19,
      "every skipped column is REPORTED so the filler can see the value was not taken",
      `${(noFlag.body.plan?.skippedNonNull || []).length} reported`);

    const withFlag = await importJsonl(base, clashRows, { apply: true, overwrite: true });
    const replaced = db.prepare(`SELECT skills_json FROM scraped_jobs WHERE job_id='u5-0'`).get().skills_json;
    check(withFlag.status === 200 && withFlag.body.written === 19,
      "with overwrite armed, the same file writes 19 rows", `written ${withFlag.body.written}`);
    check(/Rust/.test(replaced), "the value was replaced only once overwrite was explicit", replaced);

    // ── 6 · the import is a batch, and reverts to the EXACT before-image ────────────────────────
    const list = await (await fetch(`${base}/api/admin/enrichment/batches?limit=20`)).json();
    const mine = list.batches.find(b => b.id === importBatchId);
    check(mine?.source === "import", "the import appears in the batch list as source='import'", mine?.source);

    // Revert the LAST batch (the overwrite), then the skills_json batch, newest first — a revert
    // replays a before-image, so reverting out of order would restore a state that never existed.
    const overwriteBatchId = withFlag.body.batchId;
    for (const id of [overwriteBatchId, importBatchId]) {
      const r = await fetch(`${base}/api/admin/enrichment/batches/${id}/revert`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply: true }),
      });
      const body = await r.json();
      check(r.status === 200 && body.applied === true, `batch #${id} reverted`, body);
    }
    const restored = db.prepare(
      `SELECT COUNT(*) c FROM scraped_jobs
       WHERE job_id LIKE 'u5-%' AND (skills_json IS NOT NULL OR enriched_at IS NOT NULL)`).get().c;
    check(restored === 0,
      "⛔ revert restored the EXACT before-image — skills_json and enriched_at are NULL again",
      `${restored} row(s) still carry import state`);

    // ── the dry run's own honesty: a file that fills nothing must say so loudly ─────────────────
    const emptyFill = refill(exported, (out) => { out.enrichment.skills_json = []; });
    const emptyDry = await importJsonl(base, emptyFill);
    check(emptyDry.body.plan.wouldWrite === 0 && emptyDry.body.columnsWouldClimb === 0,
      "a file whose every value is empty is reported as writing nothing",
      `wouldWrite ${emptyDry.body.plan.wouldWrite}`);

    // ── 10 · volume: the JSON-body shape really does fail where the raw upload succeeds ─────────
    const big = Array.from({ length: 900 }, (_, i) =>
      JSON.stringify({ job_id: `pad-${i}`, content_hash: "x".repeat(64),
        enrichment: { summary: "y".repeat(4800) } })).join("\n");
    const asJsonBody = await fetch(`${base}/api/admin/enrichment/import`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonl: big }),
    });
    check(asJsonBody.status === 413,
      "a board-sized file DOES exceed the 4mb JSON-body limit — the ceiling is real, not theoretical",
      `status ${asJsonBody.status} for ${(Buffer.byteLength(big) / 1048576).toFixed(2)}MB`);
    const asRaw = await importJsonl(base, big);
    check(asRaw.status === 200,
      "the same file uploads fine as raw application/x-ndjson — which is what the panel sends",
      `status ${asRaw.status}`);
  } finally {
    server.close();
    db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }

  // ── 7 · the concurrency guard reports SKIPPED, not applied ────────────────────────────────────
  // A separate database and server: this one needs a client, and a pass held open on purpose.
  {
    const { db, file } = makeDb();
    seed(db, 4, { prefix: "cc" });
    let release;
    const gate = new Promise(r => { release = r; });
    const anthropic = {
      messages: {
        create: async () => {
          await gate;   // hold the first pass open so the second request collides with it
          return {
            content: [{ text: JSON.stringify({ summary: "Held open by the harness." }) }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    };
    const { server, base } = await boot(db, anthropic);
    try {
      const run = () => fetch(`${base}/api/admin/enrichment/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply: true, limit: 4 }),
      }).then(async r => ({ status: r.status, body: await r.json() }));

      const first = run();
      // Give the first request time to enter runEnrichment and set the in-progress flag before the
      // second one arrives; without this the two race and the test proves nothing either way.
      await new Promise(r => setTimeout(r, 300));
      const second = await run();

      check(second.status === 409,
        "the SECOND concurrent run is refused with 409, not 200", `status ${second.status}`);
      check(second.body.applied === false,
        "⛔ a refusal does NOT report applied:true", `applied: ${second.body.applied}`);
      check(second.body.skipped === true && second.body.skippedReason === "already_running",
        "the refusal names itself: skipped, because a pass is already running", second.body);
      check(/already in flight|refused/i.test(second.body.error || ""),
        "the response explains the refusal in words, not only in a log line", second.body.error);

      release();
      const firstResult = await first;
      check(firstResult.status === 200 && firstResult.body.applied === true,
        "the FIRST run still completed normally", `status ${firstResult.status}`);
    } finally {
      release();
      await new Promise(r => setTimeout(r, 50));
      server.close();
      db.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }

  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.log(`FAIL harness threw: ${e.stack}`); process.exit(1); });
