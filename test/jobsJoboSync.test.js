import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJoboJob } from "../services/jobs/sources/jobo.js";
import { decideJoboBackfillMode } from "../services/jobs/aggregator.js";

test("normalizeJoboJob maps common field names into normalizeJob's shape", () => {
  const raw = {
    id: "req-123",
    title: "Senior Backend Engineer",
    company: "Acme Corp",
    location: "Austin, TX",
    url: "https://jobs.acme.example/req-123",
    description: "Build things.",
    is_remote: true,
    posted_at: "2026-07-01T00:00:00Z",
  };
  const job = normalizeJoboJob(raw);
  assert.equal(job.source, "jobo");
  assert.equal(job.req_id, "req-123");
  assert.equal(job.id, "jobo::req-123");
  assert.equal(job.title, "Senior Backend Engineer");
  assert.equal(job.company, "Acme Corp");
  assert.equal(job.workplace_type, "remote");
});

test("normalizeJoboJob accepts the alternate key-name variants it guards against", () => {
  const raw = {
    job_id: "req-456",
    job_title: "Data Scientist",
    company_name: "Widgets Inc",
    application_url: "https://jobs.widgets.example/456",
    is_hybrid: true,
  };
  const job = normalizeJoboJob(raw);
  assert.equal(job.req_id, "req-456");
  assert.equal(job.title, "Data Scientist");
  assert.equal(job.company, "Widgets Inc");
  assert.equal(job.workplace_type, "hybrid");
});

test("normalizeJoboJob throws when a required field is missing under every guessed key name", () => {
  const raw = { id: "req-789", someOtherField: "noise" };
  assert.throws(() => normalizeJoboJob(raw), /required/);
});

test("decideJoboBackfillMode defaults to bounded with no saved cursor and no full-backfill env", () => {
  assert.deepEqual(
    decideJoboBackfillMode({ cursor: null, fullBackfillEnv: undefined }),
    { mode: "bounded" }
  );
});

test("decideJoboBackfillMode runs the full stable_scan backfill when JOBO_FULL_BACKFILL=1", () => {
  assert.deepEqual(
    decideJoboBackfillMode({ cursor: null, fullBackfillEnv: "1" }),
    { mode: "full", resumeCursor: null }
  );
});

test("decideJoboBackfillMode resumes an in-progress full backfill regardless of the CURRENT env value", () => {
  assert.deepEqual(
    decideJoboBackfillMode({ cursor: "saved-cursor", fullBackfillEnv: undefined }),
    { mode: "full", resumeCursor: "saved-cursor" }
  );
  assert.deepEqual(
    decideJoboBackfillMode({ cursor: "saved-cursor", fullBackfillEnv: "0" }),
    { mode: "full", resumeCursor: "saved-cursor" }
  );
});
