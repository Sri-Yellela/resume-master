import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runEnrichment, hasAnySignal } from "../services/jobs/enrichJob.js";

// Regression: docs/PIPELINE_DIAGNOSIS.md §2.2. The enrichment UPDATE assigned every column
// unconditionally from the model's output. Because the prompt deliberately instructs the model
// to answer null when a posting is silent, an ordinary correct extraction ERASED the
// normalized_title / experience_level / workplace_type / salary values that ingestion had
// already written. And since the same UPDATE stamped content_hash, the row then failed the
// candidate filter forever (the hash only changes if title/description does) — 120 production
// rows were permanently blanked and un-retryable.

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, description TEXT,
      summary TEXT, normalized_title TEXT, experience_level TEXT, workplace_type TEXT,
      salary_min_usd INTEGER, salary_max_usd INTEGER, salary_period TEXT, skills_json TEXT,
      is_h1b_sponsor INTEGER, requires_work_auth INTEGER, is_clearance_required INTEGER,
      org_unit_raw TEXT, content_hash TEXT, enriched_at INTEGER,
      is_active INTEGER DEFAULT 1, discovered_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    -- Enrichment now records usage through callModel (services/modelCall.js), so these fixtures
    -- have to carry the tracking tables. Without them every enriched job produced a tracking
    -- failure that fell through to the out-of-process sink and wrote into the real data/ directory
    -- — non-hermetic, and it hid the fact that enrichment spend was not being recorded here at all.
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      event_subtype TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0, model TEXT, cost_usd REAL DEFAULT 0,
      ats_score_before INTEGER, ats_score_after INTEGER, duration_ms INTEGER, job_id TEXT,
      company TEXT, success INTEGER NOT NULL DEFAULT 1, error_text TEXT, purpose TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS cache_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      layer TEXT, domain_module TEXT, tokens_in_cache INTEGER DEFAULT 0,
      tokens_saved INTEGER DEFAULT 0, cost_saved_usd REAL DEFAULT 0, model TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS usage_tracking_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, purpose TEXT, user_id INTEGER,
      error_text TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), source TEXT
    );
    CREATE TABLE company_technographics (
      company TEXT, skill TEXT, weight REAL, last_seen INTEGER, posting_count INTEGER,
      PRIMARY KEY (company, skill)
    );
  `);
  return db;
}

// Stands in for the Anthropic client: returns whatever JSON the test dictates.
function fakeAnthropic(payload) {
  return {
    messages: {
      create: async () => ({
        content: [{ text: JSON.stringify(payload) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  };
}

const ALL_NULL = {
  summary: null, normalizedTitle: null, experienceLevel: null, workplaceType: null,
  skillsHard: [], skillsSoft: [], salaryMinUsd: null, salaryMaxUsd: null, salaryPeriod: null,
  isH1bSponsor: null, requiresWorkAuth: null, isClearanceRequired: null, orgUnit: null,
};

test("enrichment never overwrites ingestion-populated columns with NULL", async () => {
  const db = makeDb();
  db.prepare(`
    INSERT INTO scraped_jobs (job_id, title, company, description, normalized_title, experience_level, workplace_type, salary_max_usd)
    VALUES ('j1', 'Senior Backend Engineer', 'Acme', 'Build APIs.', 'backend engineer', 'senior', 'remote', 200000)
  `).run();

  // The model finds only a summary — everything else is genuinely absent from the posting.
  const result = await runEnrichment(db, fakeAnthropic({ ...ALL_NULL, summary: "Builds APIs." }));

  const row = db.prepare(`SELECT * FROM scraped_jobs WHERE job_id = 'j1'`).get();
  assert.equal(result.enriched, 1);
  assert.equal(row.summary, "Builds APIs.", "the new signal must be written");
  assert.equal(row.normalized_title, "backend engineer", "ingestion value must survive a null extraction");
  assert.equal(row.experience_level, "senior", "ingestion value must survive a null extraction");
  assert.equal(row.workplace_type, "remote", "ingestion value must survive a null extraction");
  assert.equal(row.salary_max_usd, 200000, "ingestion value must survive a null extraction");
});

test("a non-null extraction still corrects an existing value", async () => {
  // COALESCE only protects against nulls — enrichment must remain able to improve a field.
  const db = makeDb();
  db.prepare(`
    INSERT INTO scraped_jobs (job_id, title, company, description, experience_level)
    VALUES ('j1', 'Staff Engineer', 'Acme', 'Lead the platform team.', 'mid')
  `).run();

  await runEnrichment(db, fakeAnthropic({ ...ALL_NULL, experienceLevel: "lead" }));

  const row = db.prepare(`SELECT experience_level FROM scraped_jobs WHERE job_id = 'j1'`).get();
  assert.equal(row.experience_level, "lead", "a real extraction must win over the prior value");
});

test("an all-null extraction is not stamped complete, so the row stays a candidate", async () => {
  const db = makeDb();
  db.prepare(`
    INSERT INTO scraped_jobs (job_id, title, company, description)
    VALUES ('j1', 'Engineer', 'Acme', 'Some text that yields nothing.')
  `).run();

  const result = await runEnrichment(db, fakeAnthropic(ALL_NULL));

  const row = db.prepare(`SELECT content_hash, enriched_at FROM scraped_jobs WHERE job_id = 'j1'`).get();
  assert.equal(result.enriched, 0);
  assert.equal(result.empty, 1, "an information-free pass must be counted, not reported as success");
  assert.equal(row.enriched_at, null, "stamping enriched_at here is what made rows unretryable");
  assert.equal(row.content_hash, null, "content_hash must stay null so the row remains a candidate");
});

test("rows with no description are never sent to the model", async () => {
  // There is nothing to extract from an empty posting; calling the API just buys an all-null
  // answer. This is also what greenhouse/ashby produced board-wide before the adapter fix.
  const db = makeDb();
  db.prepare(`INSERT INTO scraped_jobs (job_id, title, company, description) VALUES ('empty', 'Engineer', 'Acme', NULL)`).run();
  db.prepare(`INSERT INTO scraped_jobs (job_id, title, company, description) VALUES ('blank', 'Engineer', 'Acme', '   ')`).run();

  let calls = 0;
  const spy = {
    messages: {
      create: async () => {
        calls++;
        return { content: [{ text: JSON.stringify({ ...ALL_NULL, summary: "x" }) }], usage: {} };
      },
    },
  };
  const result = await runEnrichment(db, spy);

  assert.equal(calls, 0, "no API call may be made for a row with no text");
  assert.equal(result.enriched, 0);
});

test("skills roll up into company_technographics on a successful pass", async () => {
  const db = makeDb();
  db.prepare(`INSERT INTO scraped_jobs (job_id, title, company, description) VALUES ('j1', 'Engineer', 'Acme', 'Python and Go.')`).run();

  await runEnrichment(db, fakeAnthropic({ ...ALL_NULL, summary: "Role.", skillsHard: ["Python", "Go"] }));

  const skills = db.prepare(`SELECT skill, weight FROM company_technographics WHERE company = 'Acme' ORDER BY skill`).all();
  assert.deepEqual(skills.map(s => s.skill), ["Go", "Python"]);
  assert.ok(skills.every(s => s.weight === 1), "first sighting contributes one unit of weight");
});

test("hasAnySignal distinguishes an empty extraction from a partial one", () => {
  const empty = {
    summary: null, normalized_title: null, experience_level: null, workplace_type: null,
    salary_min_usd: null, salary_max_usd: null, salary_period: null, is_h1b_sponsor: null,
    requires_work_auth: null, is_clearance_required: null, org_unit: null, skills: [],
  };
  assert.equal(hasAnySignal(empty), false);
  // 0 and false are real, informative values — they must not read as "no signal".
  assert.equal(hasAnySignal({ ...empty, is_h1b_sponsor: 0 }), true, "an explicit false is a signal");
  assert.equal(hasAnySignal({ ...empty, salary_min_usd: 0 }), true, "a zero salary is still an extracted value");
  assert.equal(hasAnySignal({ ...empty, skills: [{ skill: "Go", type: "hard" }] }), true);
});
