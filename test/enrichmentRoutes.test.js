import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import { createEnrichmentRouter } from "../routes/enrichment.js";
import { computeContentHash } from "../services/jobs/enrichmentSelection.js";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function setup({ isAdmin = true, anthropic = null } = {}) {
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
  const ins = db.prepare(`INSERT INTO scraped_jobs
    (job_id, title, company, description, source, is_active, discovered_at, scraped_at, updated_at)
    VALUES (@job_id, @title, 'Acme', @description, 'greenhouse', 1, @discovered_at, @scraped_at, @scraped_at)`);
  ins.run({ job_id: "fresh", title: "Backend Engineer", description: "We use Python.", discovered_at: NOW - 2 * DAY, scraped_at: NOW - 3600 });
  ins.run({ job_id: "abandoned", title: "Data Analyst", description: "SQL work.", discovered_at: NOW - 2 * DAY, scraped_at: NOW - 30 * DAY });

  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use((req, _res, next) => { req.user = { id: 1, username: "admin", isAdmin }; next(); });
  const requireAdmin = (req, res, next) =>
    req.user?.isAdmin ? next() : res.status(403).json({ error: "Admin access required" });
  app.use("/api/admin/enrichment", createEnrichmentRouter(db, requireAdmin, { anthropic }));
  const server = app.listen(0);
  return { db, server, base: `http://127.0.0.1:${server.address().port}/api/admin/enrichment` };
}

const get = (base, p) => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() }));
const post = (base, p, body) => fetch(base + p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
}).then(async r => ({ status: r.status, body: await r.json() }));

test("routes: every enrichment route is admin-gated", async () => {
  // /run spends real money per row and /export returns the whole board's posting text. Neither is a
  // per-user resource, and both were unreachable by any means before this router existed.
  const { server, base } = setup({ isAdmin: false });
  try {
    for (const [method, p] of [["GET", "/candidates"], ["GET", "/export"], ["GET", "/coverage"],
                               ["GET", "/batches"], ["POST", "/run"], ["POST", "/import"]]) {
      const r = method === "GET" ? await get(base, p) : await post(base, p, {});
      assert.equal(r.status, 403, `${method} ${p} must be admin-gated`);
    }
  } finally { server.close(); }
});

test("routes: GET /candidates reports the pre-filter and the real count separately", async () => {
  const { db, server, base } = setup();
  try {
    // The restored board's shape: enriched, text unchanged, updated_at bumped by a bulk touch.
    db.prepare("UPDATE scraped_jobs SET enriched_at = ?, content_hash = ?, updated_at = ? WHERE job_id='fresh'")
      .run(NOW - 10 * DAY, computeContentHash("Backend Engineer", "We use Python."), NOW - DAY);
    const { body } = await get(base, "/candidates");
    assert.equal(body.prefilterCount, 1, "the cheap SQL limb still matches it");
    assert.equal(body.candidates, 0, "the content-hash comparison excludes it");
    assert.equal(body.gatedOut, 1, "and the stale row is reported as gated, not silently dropped");
    assert.equal(body.estimate.usd, 0);
  } finally { server.close(); }
});

test("routes: GET /candidates quotes a cost CEILING and calls nothing", async () => {
  const { server, base } = setup();
  try {
    const { body } = await get(base, "/candidates");
    assert.equal(body.wouldSend, 1, "only the re-sighted posting");
    assert.deepEqual(body.jobIds, ["fresh"]);
    assert.equal(body.estimateIsCeiling, true);
    assert.ok(body.estimate.usd > 0);
    assert.equal(body.freshnessGateDays, 7);
    assert.ok(body.coverage.columns.summary, "per-column coverage travels with the answer");
  } finally { server.close(); }
});

test("routes: POST /run is a DRY RUN unless apply is true", async () => {
  // A client that forgets a flag must not spend money. anthropic is null here, so if the route ever
  // tried to run it would 503 rather than silently no-op — either way it must not report success.
  const { server, base } = setup();
  try {
    const { status, body } = await post(base, "/run", {});
    assert.equal(status, 200);
    assert.equal(body.applied, false);
    assert.equal(body.dryRun, true);
    assert.equal(body.plan.wouldSend, 1);
    assert.ok(body.plan.estimate.usd > 0);
    assert.match(body.note, /no model was called/);
  } finally { server.close(); }
});

test("routes: POST /run with apply refuses when no client is configured", async () => {
  // runEnrichment degrades to a logged no-op without a client, so "I ran it" could otherwise
  // quietly mean "it skipped".
  const { server, base } = setup({ anthropic: null });
  try {
    const { status, body } = await post(base, "/run", { apply: true });
    assert.equal(status, 503);
    assert.match(body.error, /silently skip rather than fail/);
  } finally { server.close(); }
});

test("routes: POST /run bounds a manual pass and says it capped the request", async () => {
  // An HTTP handler running 837 sequential model calls is killed by a proxy timeout partway
  // through, and the operator would not know how far it got.
  const { server, base } = setup();
  try {
    const { body } = await post(base, "/run", { limit: 5000 });
    assert.equal(body.plan.limitApplied, 100);
    assert.equal(body.plan.limitCappedAt, 100);
  } finally { server.close(); }
});

test("routes: POST /run rejects a nonsense limit rather than defaulting", async () => {
  const { server, base } = setup();
  try {
    assert.equal((await post(base, "/run", { limit: 0 })).status, 400);
    assert.equal((await post(base, "/run", { limit: -3 })).status, 400);
    assert.equal((await post(base, "/run", { limit: "many" })).status, 400);
  } finally { server.close(); }
});

test("routes: POST /run reports coverage and warns when no column gained", async () => {
  // The A2 failure mode: HTTP 200, success:true, a clean usage row, and a NULL extraction 49 times
  // in 50. A stub that answers with one real field proves the coverage delta is computed from the
  // database rather than from the call count.
  const anthropic = { messages: { create: async () => ({
    content: [{ text: JSON.stringify({
      summary: "A backend role.", normalizedTitle: null, experienceLevel: null, workplaceType: null,
      skillsHard: [], skillsSoft: [], salaryMinUsd: null, salaryMaxUsd: null, salaryPeriod: null,
      isH1bSponsor: null, requiresWorkAuth: null, isClearanceRequired: null, orgUnit: null,
    }) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }) } };
  const { db, server, base } = setup({ anthropic });
  db.exec(`CREATE TABLE company_technographics (company TEXT, skill TEXT, weight REAL,
           last_seen INTEGER, posting_count INTEGER, PRIMARY KEY (company, skill));`);
  try {
    const { body } = await post(base, "/run", { apply: true, jobIds: ["fresh"] });
    assert.equal(body.applied, true);
    assert.equal(body.enriched, 1);
    assert.equal(body.coverageClimbed, true);
    assert.equal(body.warning, null);
    const summary = body.coverage.find(c => c.column === "summary");
    assert.equal(summary.delta, 1);
    // The visa columns are reported but excluded from the verdict, and the response says so.
    const h1b = body.coverage.find(c => c.column === "is_h1b_sponsor");
    assert.equal(h1b.sourceSilent, true);
    assert.match(body.visaColumnsNote, /source material, not a failure/);
    assert.ok(body.batchId, "the pass is attributable to a batch");
  } finally { server.close(); }
});

test("routes: GET /export returns JSONL with source and enrichment separated", async () => {
  const { server, base } = setup();
  try {
    const res = await fetch(base + "/export");
    // express appends "; charset=utf-8", so match the type rather than the whole header.
    assert.match(res.headers.get("content-type"), /^application\/x-ndjson\b/);
    const lines = (await res.text()).trim().split("\n");
    const meta = JSON.parse(lines[0])._meta;
    assert.ok(meta, "a _meta header records the predicate the file was produced with");
    const row = JSON.parse(lines[1]);
    assert.equal(row.job_id, "fresh");
    assert.ok(row.content_hash, "content_hash is on every row — it is the staleness interlock");
    assert.ok(row.source.description);
    assert.ok("summary" in row.enrichment);
    assert.equal("description" in row.enrichment, false, "source text is not a writable column");
  } finally { server.close(); }
});

test("routes: POST /import is a dry run by default and writes nothing", async () => {
  const { db, server, base } = setup();
  try {
    const jsonl = await fetch(base + "/export").then(r => r.text());
    const rows = jsonl.trim().split("\n").slice(1).map(l => JSON.parse(l));
    rows[0].enrichment.summary = "external";
    const payload = rows.map(r => JSON.stringify(r)).join("\n");

    const dry = await post(base, "/import", { jsonl: payload });
    assert.equal(dry.body.applied, false);
    assert.equal(dry.body.dryRun, true);
    assert.equal(dry.body.plan.wouldWrite, 1);
    assert.deepEqual(dry.body.plan.perColumn, { summary: 1 });
    assert.equal(db.prepare("SELECT summary FROM scraped_jobs WHERE job_id='fresh'").get().summary, null);

    const applied = await post(base, "/import", { jsonl: payload, apply: true });
    assert.equal(applied.body.applied, true);
    assert.equal(applied.body.written, 1);
    assert.equal(db.prepare("SELECT summary FROM scraped_jobs WHERE job_id='fresh'").get().summary, "external");
  } finally { server.close(); }
});

test("routes: POST /import returns 422 and writes NOTHING for a malformed file", async () => {
  const { db, server, base } = setup();
  try {
    const jsonl = await fetch(base + "/export").then(r => r.text());
    const rows = jsonl.trim().split("\n").slice(1).map(l => JSON.parse(l));
    rows[0].enrichment.summary = "would be fine";
    rows[0].enrichment.experience_level = "Staff Engineer III";   // free text in an enum column
    const payload = rows.map(r => JSON.stringify(r)).join("\n");

    const { status, body } = await post(base, "/import", { jsonl: payload, apply: true });
    // 422, not 400: the REQUEST is well-formed and the PAYLOAD is not, and that distinction matters
    // to whoever has to fix the file.
    assert.equal(status, 422);
    assert.equal(body.written, 0);
    assert.equal(body.plan.rejected[0].jobId, "fresh");
    assert.match(body.plan.rejected[0].error, /experience_level must be one of/);
    assert.equal(db.prepare("SELECT summary FROM scraped_jobs WHERE job_id='fresh'").get().summary, null,
      "the valid column on the same row is not written either");
  } finally { server.close(); }
});

test("routes: POST /import requires a jsonl body", async () => {
  const { server, base } = setup();
  try {
    assert.equal((await post(base, "/import", {})).status, 400);
  } finally { server.close(); }
});

test("routes: batch provenance is listable, inspectable and revertible", async () => {
  const { db, server, base } = setup();
  try {
    const jsonl = await fetch(base + "/export").then(r => r.text());
    const rows = jsonl.trim().split("\n").slice(1).map(l => JSON.parse(l));
    rows[0].enrichment.summary = "external";
    const payload = rows.map(r => JSON.stringify(r)).join("\n");
    const { body: imported } = await post(base, "/import", { jsonl: payload, apply: true });
    const id = imported.batchId;

    const list = await get(base, "/batches");
    assert.equal(list.body.batches[0].id, id);
    assert.equal(list.body.batches[0].source, "import");

    const one = await get(base, `/batches/${id}`);
    assert.deepEqual(one.body.columnsFilled, { summary: 1 });

    // Revert is dry by default, like every other writing route.
    const dry = await post(base, `/batches/${id}/revert`, {});
    assert.equal(dry.body.applied, false);
    assert.equal(dry.body.recordedRows, 1);
    assert.equal(db.prepare("SELECT summary FROM scraped_jobs WHERE job_id='fresh'").get().summary, "external");

    const applied = await post(base, `/batches/${id}/revert`, { apply: true });
    assert.equal(applied.body.restored, 1);
    assert.equal(db.prepare("SELECT summary FROM scraped_jobs WHERE job_id='fresh'").get().summary, null);

    // A second revert is a conflict, not a silent success.
    assert.equal((await post(base, `/batches/${id}/revert`, { apply: true })).status, 409);
  } finally { server.close(); }
});

test("routes: an unknown batch is a 404", async () => {
  const { server, base } = setup();
  try {
    assert.equal((await get(base, "/batches/999")).status, 404);
    assert.equal((await post(base, "/batches/999/revert", { apply: true })).status, 404);
  } finally { server.close(); }
});
