// ── TASK AC4: run history, date-driven and on demand ─────────────────────────────────────────
//
// The panel's history was a small expandable list of the last 20 RUNS. This replaces it with the
// question a candidate actually has: what did I put into auto-apply on this day, and how did each
// one end.
//
// Four things are asserted here, and the first is the one the requirement is strictest about:
//
//   1. THE MAPPING IS TOTAL. "Map every existing terminal status into exactly one group and report
//      the mapping. No status may be unmapped or double-mapped." Asserted against the statuses
//      routes/apply.js ACTUALLY WRITES, read out of the source — not against a list maintained in a
//      comment, which is how a status added later goes missing from a view that claims to be
//      complete.
//   2. The queries are date-scoped and user-scoped on the SERVER.
//   3. Abort is safe: it claims the row atomically, refuses a race it lost, and voids the packet.
//   4. Delete is a soft hide, and a pending row is stopped before it is hidden.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";
import {
  requestAbort, isAbortRequested, clearAbort, ABORT_FLAG_TTL_MS,
} from "../services/applyAutomation.js";
import {
  OUTCOME, OUTCOME_STATUSES, OUTCOME_LABELS, outcomeGroupFor, isAbortable,
} from "../shared/applyOutcomeGroups.js";

const applySource = fs.readFileSync("routes/apply.js", "utf8");
const read = (f) => fs.readFileSync(f, "utf8");
const panel   = read("client/src/panels/AutoApplyPanel.jsx");
const sections= read("client/src/panels/AutoApplyPanelSections.jsx");
const ctx     = read("client/src/contexts/AutoApplyContext.jsx");
const dbPanel = read("client/src/panels/DatabasePanel.jsx");
// AD1: the Database panel's chrome, extracted so the Auto Apply panel can adopt this layout by
// rendering it rather than by copying the markup.
const controls = read("client/src/components/ui/PanelControls.jsx");
const dateCalendar   = read("client/src/components/ui/DateCalendar.jsx");
const shadcnCalendar = read("client/src/components/ui/calendar.jsx");
const applyRoute = applySource;
const automation = read("services/applyAutomation.js");

// 2023-11-14 22:13:20 UTC. Chosen so that a negative UTC offset (the Americas) puts it on the
// PREVIOUS local day — which is the timezone bug the endpoint exists to not have.
const T = 1700000000;
const DAY = 86400;

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
    CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
      full_name TEXT, email TEXT, phone TEXT, custom_answers TEXT);
    CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, profile_name TEXT,
      role_family TEXT, domain TEXT, is_active INTEGER DEFAULT 0);
    CREATE TABLE user_integrations (user_id INTEGER, provider TEXT, status TEXT, account_email TEXT,
      updated_at INTEGER, last_checked_at INTEGER);
    CREATE TABLE profile_base_resumes (profile_id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT,
      content TEXT, enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
    CREATE TABLE base_resume (user_id INTEGER PRIMARY KEY, name TEXT, content TEXT,
      enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT, url TEXT,
      apply_url TEXT, source TEXT, location TEXT);
    CREATE TABLE resumes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, job_id TEXT,
      apply_mode TEXT, ats_score INTEGER, html TEXT, updated_at INTEGER);
    CREATE TABLE apply_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT,
      approval_mode TEXT, tool_type TEXT, status TEXT, total_jobs INTEGER, held_count INTEGER DEFAULT 0,
      submitted_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()), started_at INTEGER, finished_at INTEGER);
    CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER,
      approved_at INTEGER, approved_from_run_job_id INTEGER, job_id TEXT, status TEXT, reason_code TEXT,
      reason_detail TEXT, started_at INTEGER, finished_at INTEGER, created_at INTEGER DEFAULT (unixepoch()),
      answers_json TEXT, open_questions_json TEXT, resume_artifact_id INTEGER, resume_ats_score INTEGER,
      screenshot_path TEXT, submit_verified INTEGER, submit_evidence TEXT,
      hidden_at INTEGER, UNIQUE(run_id, job_id));
    CREATE TABLE apply_gate_packets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, run_id INTEGER,
      run_job_id INTEGER, job_id TEXT, apply_url TEXT, expected_origin TEXT, gate_reason TEXT,
      answers_json TEXT, resume_artifact_id INTEGER, token_hash TEXT, expires_at INTEGER,
      consumed_at INTEGER, exchange_attempts INTEGER DEFAULT 0, created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
      user_id INTEGER, job_id TEXT, level TEXT, event TEXT, message TEXT, details_json TEXT,
      created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE job_applications (user_id INTEGER, job_id TEXT, company TEXT, role TEXT, job_url TEXT,
      source TEXT, location TEXT, apply_mode TEXT, resume_file TEXT, applied_at INTEGER, notes TEXT,
      auto_status TEXT, UNIQUE(user_id, job_id));
    CREATE TABLE user_jobs (user_id INTEGER, job_id TEXT, domain_profile_id INTEGER, applied INTEGER DEFAULT 0,
      updated_at INTEGER, UNIQUE(user_id, job_id));
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE apply_idempotency (user_id INTEGER NOT NULL, idem_key TEXT NOT NULL, endpoint TEXT NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 200, response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, idem_key));

    INSERT INTO users (id, username) VALUES (1, 'u1'), (2, 'u2');
    INSERT INTO scraped_jobs (job_id, title, company, apply_url) VALUES
      ('j-sub',  'Staff Engineer',   'OpenAI',    'https://boards.greenhouse.io/openai/1'),
      ('j-held', 'Research Engineer','Anthropic', 'https://job-boards.greenhouse.io/anthropic/2'),
      ('j-run',  'Infra Engineer',   'Stripe',    'https://stripe.com/jobs/3'),
      ('j-fail', 'Frontend Engineer','Figma',     'https://figma.com/jobs/4'),
      ('j-other','Other Person Job', 'Notion',    'https://notion.so/jobs/5');
    INSERT INTO apply_runs (id, user_id, mode, status, total_jobs, created_at)
      VALUES (1, 1, 'auto', 'completed', 6, ${T}), (2, 2, 'auto', 'completed', 1, ${T});
  `);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
  const noop = async () => ({});
  applyRoutes(app, db, (req, _res, next) => next(), noop, noop, noop, noop);
  const server = app.listen(0);
  return { db, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); db.close(); } };
}

const addJob = (db, o) => db.prepare(`
  INSERT INTO apply_run_jobs (id, run_id, user_id, job_id, status, reason_code, created_at, hidden_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(o.id, o.runId ?? 1, o.userId ?? 1, o.jobId, o.status, o.reasonCode ?? null,
       o.createdAt ?? T, o.hiddenAt ?? null);

// ── Requirement 3: the mapping is TOTAL ──────────────────────────────────────────────────────

test("AC4: every status the SERVER WRITES lands in exactly one group", () => {
  // Read out of routes/apply.js rather than listed here. A status added by a later change appears
  // in this set automatically and fails the test until it is mapped — which is the only version of
  // this check that keeps working.
  const written = new Set();
  for (const m of applySource.matchAll(/status\s*=\s*'([a-z_]+)'/g)) written.add(m[1]);
  for (const m of applySource.matchAll(/SET status='([a-z_]+)'/g)) written.add(m[1]);
  for (const m of applySource.matchAll(/setJobStatus\("([a-z_]+)"/g)) written.add(m[1]);
  for (const m of applySource.matchAll(/finalStatus = \w+ \? "([a-z_]+)"/g)) written.add(m[1]);
  // Statuses that appear in the source as COMPARISONS against other tables, not as writes to
  // apply_run_jobs. Named individually so the exclusion is auditable rather than a loose filter.
  for (const notARunJobStatus of ["manual", "completed", "queued_x"]) written.delete(notARunJobStatus);

  const mapped = Object.values(OUTCOME_STATUSES).flat();
  assert.equal(new Set(mapped).size, mapped.length, `a status is DOUBLE-mapped: ${mapped.join(", ")}`);

  for (const status of written) {
    const hits = Object.entries(OUTCOME_STATUSES).filter(([, ss]) => ss.includes(status));
    assert.equal(hits.length, 1,
      `status '${status}' is written by routes/apply.js but maps to ${hits.length} groups ` +
      `(mapped: ${mapped.join(", ")})`);
  }
  // And the reverse: nothing is mapped that the server cannot produce, so the partition does not
  // quietly accumulate statuses that no longer exist.
  for (const status of mapped) {
    assert.ok(written.has(status),
      `'${status}' is mapped but routes/apply.js never writes it — a stale entry in the partition`);
  }
});

test("AC4: the three groups, and what each one means", () => {
  assert.deepEqual(OUTCOME_STATUSES[OUTCOME.COMPLETED], ["submitted"]);
  assert.deepEqual(OUTCOME_STATUSES[OUTCOME.PENDING], ["queued", "running", "held_review", "held_gate"]);
  assert.deepEqual(OUTCOME_STATUSES[OUTCOME.ABORTED], ["failed", "dismissed", "superseded", "cancelled"]);
  // ABORTED is "ended without being sent", not "failed": three of its four members are not
  // failures, and calling the group Failed would repeat the flattening this whole line of work
  // has been undoing.
  assert.equal(OUTCOME_LABELS[OUTCOME.ABORTED].label, "Aborted");
  assert.match(OUTCOME_LABELS[OUTCOME.ABORTED].note, /ended without being sent/);
});

test("AC4: a dead posting is ABORTED — the one non-status input, applied as an override", () => {
  // Requirement 3 lists "dead posting" under ABORTED. It is not a status: it is a held row whose
  // posting the 7-day cleanup removed, so the join comes back empty. Applied AFTER the status map,
  // which is what stops it double-mapping.
  assert.equal(outcomeGroupFor({ status: "held_review", title: "x", company: "y" }), OUTCOME.PENDING);
  assert.equal(outcomeGroupFor({ status: "held_review", title: null, company: null }), OUTCOME.ABORTED);
  assert.equal(outcomeGroupFor({ status: "held_gate", postingGone: true }), OUTCOME.ABORTED);
  // A SUBMITTED application whose posting was later cleaned up is still submitted. The posting
  // going away does not un-send it, and filing it as aborted would tell a candidate an application
  // never went out when it did.
  assert.equal(outcomeGroupFor({ status: "submitted", title: null, company: null }), OUTCOME.COMPLETED);
  // An already-aborted row is not moved again.
  assert.equal(outcomeGroupFor({ status: "failed", title: null, company: null }), OUTCOME.ABORTED);
});

test("AC4: an unknown status is ABORTED, never dropped and never left pending", () => {
  // The honest reading of a terminal state nobody has described: nothing was sent, and we do not
  // know what happened. It is also the reading that cannot mislead — it never claims a submission,
  // and it never leaves a row in a queue the user is expected to work through.
  assert.equal(outcomeGroupFor({ status: "a_status_from_the_future", title: "x" }), OUTCOME.ABORTED);
  assert.equal(outcomeGroupFor({}), OUTCOME.ABORTED);
});

test("AC4: only pending rows are abortable", () => {
  for (const s of OUTCOME_STATUSES[OUTCOME.PENDING]) assert.ok(isAbortable({ status: s }), s);
  for (const s of [...OUTCOME_STATUSES[OUTCOME.COMPLETED], ...OUTCOME_STATUSES[OUTCOME.ABORTED]]) {
    assert.ok(!isAbortable({ status: s }), `${s} must not offer an abort`);
  }
});

// ── Requirement 5: date-scoped and user-scoped, on the server ────────────────────────────────

test("AC4: one date returns that date's applications, in three groups", async () => {
  const t = setup();
  try {
    addJob(t.db, { id: 1, jobId: "j-sub",  status: "submitted",   createdAt: T });
    addJob(t.db, { id: 2, jobId: "j-held", status: "held_review", createdAt: T + 60 });
    addJob(t.db, { id: 3, jobId: "j-run",  status: "running",     createdAt: T + 120 });
    addJob(t.db, { id: 4, jobId: "j-fail", status: "failed",      createdAt: T + 180 });
    // Another day entirely — must not appear. Run 2, because UNIQUE(run_id, job_id) means the same
    // posting attempted again is a new RUN, which is also the shape a real re-run takes.
    addJob(t.db, { id: 5, jobId: "j-sub",  runId: 2, status: "submitted", createdAt: T + DAY * 3 });

    const r = await (await fetch(`${t.baseUrl}/api/apply/history?date=2023-11-14&tzOffset=0`)).json();
    assert.equal(r.total, 4, "the query is not scoped to the requested date");
    assert.deepEqual(r.completed.map(j => j.jobId), ["j-sub"]);
    assert.deepEqual(r.pending.map(j => j.jobId).sort(), ["j-held", "j-run"]);
    assert.deepEqual(r.aborted.map(j => j.jobId), ["j-fail"]);
    // Every row lands in exactly one group — the partition, at the payload level.
    const all = [...r.completed, ...r.pending, ...r.aborted].map(j => j.id);
    assert.equal(new Set(all).size, all.length, "a row appears in two groups");
  } finally { t.close(); }
});

test("AC4: another user's applications are never returned", async () => {
  const t = setup();
  try {
    addJob(t.db, { id: 1, jobId: "j-sub",   status: "submitted", createdAt: T });
    addJob(t.db, { id: 2, jobId: "j-other", status: "submitted", createdAt: T, userId: 2, runId: 2 });
    const r = await (await fetch(`${t.baseUrl}/api/apply/history?date=2023-11-14&tzOffset=0`)).json();
    assert.equal(r.total, 1);
    assert.equal(r.completed[0].jobId, "j-sub");
  } finally { t.close(); }
});

test("AC4: the day boundary is the USER'S day, not UTC's", async () => {
  const t = setup();
  try {
    // 2023-11-14 22:13:20 UTC is 2023-11-14 17:13 in Boston (UTC-5, offset +300) and
    // 2023-11-15 03:43 in Kolkata (UTC+5:30, offset -330). Without the offset a user in the second
    // group picks the day they remember queueing and is told nothing happened.
    addJob(t.db, { id: 1, jobId: "j-sub", status: "submitted", createdAt: T });
    const boston = await (await fetch(`${t.baseUrl}/api/apply/history?date=2023-11-14&tzOffset=300`)).json();
    assert.equal(boston.total, 1, "a Boston user cannot find the day they queued it");
    const kolkataWrongDay = await (await fetch(`${t.baseUrl}/api/apply/history?date=2023-11-14&tzOffset=-330`)).json();
    assert.equal(kolkataWrongDay.total, 0, "the offset is being ignored");
    const kolkata = await (await fetch(`${t.baseUrl}/api/apply/history?date=2023-11-15&tzOffset=-330`)).json();
    assert.equal(kolkata.total, 1, "a Kolkata user cannot find the day they queued it");
  } finally { t.close(); }
});

test("AC4: an empty date is a NORMAL state, not an error and not a spinner", async () => {
  const t = setup();
  try {
    const res = await fetch(`${t.baseUrl}/api/apply/history?date=2019-01-01&tzOffset=0`);
    assert.equal(res.status, 200, "an empty date must not be an error");
    const r = await res.json();
    // Shaped identically to a day with results, so the client renders emptiness from DATA rather
    // than from the absence of it — which is what turns an empty day into a permanent spinner.
    assert.deepEqual(r, { date: "2019-01-01", total: 0, counts: { completed: 0, pending: 0, aborted: 0 },
                          completed: [], pending: [], aborted: [] });
  } finally { t.close(); }
});

// ── TASK AD1: ONE GROUP PER REQUEST ──────────────────────────────────────────────────────────
//
// The three outcome groups became SUB-TABS, and AD1 requirement 3 is explicit: "Switching sub-tabs
// with a date selected refetches for that tab; it must not load all three."

/** One day holding every group, including the two the vocabulary only learned about in AC4. */
const seedOneOfEach = (db) => {
  db.exec(`INSERT INTO scraped_jobs (job_id, title, company, apply_url) VALUES
    ('j-dismissed',  'Design Engineer',  'Notion',  'https://notion.so/jobs/6'),
    ('j-superseded', 'Platform Engineer','Vercel',  'https://vercel.com/careers/7'),
    ('j-cancelled',  'SRE',              'Datadog', 'https://datadog.avature.net/8')`);
  addJob(db, { id: 1, jobId: "j-sub",         status: "submitted",   createdAt: T });
  addJob(db, { id: 2, jobId: "j-held",        status: "held_review", createdAt: T + 60 });
  addJob(db, { id: 3, jobId: "j-run",         status: "running",     createdAt: T + 120 });
  addJob(db, { id: 4, jobId: "j-fail",        status: "failed",      createdAt: T + 180 });
  addJob(db, { id: 5, jobId: "j-dismissed",   status: "dismissed",   createdAt: T + 240 });
  addJob(db, { id: 6, jobId: "j-superseded",  status: "superseded",  createdAt: T + 300 });
  addJob(db, { id: 7, jobId: "j-cancelled",   status: "cancelled",   createdAt: T + 360 });
  // NOT in scraped_jobs — the 7-day cleanup removed the posting. By STATUS this row is PENDING; in
  // reality there is no form left to open, so the override files it under ABORTED. It is here
  // because it is the one row a "filter on the group's statuses" query would get wrong.
  addJob(db, { id: 8, jobId: "j-gone",        status: "held_gate",   createdAt: T + 420 });
};
const DATE = "2023-11-14";

test("AD1: ?group returns ONLY that group's rows, and never the other two", async () => {
  const t = setup();
  try {
    seedOneOfEach(t.db);
    for (const [group, expected] of [
      ["completed", ["j-sub"]],
      ["pending",   ["j-held", "j-run"]],
      // The dead posting is here by the OVERRIDE, not by its status — which is exactly why the
      // query cannot simply filter on the group's statuses and stop there.
      ["aborted",   ["j-fail", "j-dismissed", "j-superseded", "j-cancelled", "j-gone"]],
    ]) {
      const r = await (await fetch(
        `${t.baseUrl}/api/apply/history?date=${DATE}&tzOffset=0&group=${group}`)).json();
      assert.equal(r.group, group);
      assert.deepEqual(r.jobs.map(j => j.jobId).sort(), expected.slice().sort(),
        `group=${group} returned the wrong rows`);
      // The other groups' KEYS are absent entirely: a client that asked for one tab must not be
      // able to render another tab's rows out of the same response by accident.
      for (const other of ["completed", "pending", "aborted"]) {
        assert.equal(r[other], undefined, `group=${group} still shipped the ${other} rows`);
      }
    }
  } finally { t.close(); }
});

test("AD1: the counts are for ALL THREE groups and for the SELECTED DATE", async () => {
  // Requirement 4 asks for a decision and for it to be stated. DATE-SCOPED, because these are
  // outcome states of ONE entity rather than entity types — a run-job moves between the tabs as it
  // progresses, so a global number would change under the reader for reasons unrelated to what they
  // are looking at. And a global count needs a query at render, which requirement 3 forbids.
  const t = setup();
  try {
    seedOneOfEach(t.db);
    const r = await (await fetch(
      `${t.baseUrl}/api/apply/history?date=${DATE}&tzOffset=0&group=completed`)).json();
    assert.deepEqual(r.counts, { completed: 1, pending: 2, aborted: 5 });
    assert.equal(r.jobs.length, 1, "the counts came at the cost of loading all three after all");
    // `total` is the DAY's total in both shapes. Scoping it to the asked-for group would make an
    // empty COMPLETED tab on a busy day claim the day itself was empty — which is the difference
    // between requirement 7's "no applications on this date" and its "nothing completed".
    assert.equal(r.total, 8);
    // A different day is a different set of counts, which is what proves they are not global.
    const other = await (await fetch(
      `${t.baseUrl}/api/apply/history?date=2019-01-01&tzOffset=0&group=pending`)).json();
    assert.deepEqual(other.counts, { completed: 0, pending: 0, aborted: 0 });
    assert.equal(other.total, 0);
  } finally { t.close(); }
});

test("AD1: the counts apply the dead-posting override, exactly as the rows do", async () => {
  // A GROUP BY status would put the dead posting in PENDING and the tab that renders it in ABORTED,
  // so the pill and its contents would disagree — a "1" over an empty list. The aggregate reads the
  // same partition the rows do, which is why it selects the join's emptiness rather than counting.
  const t = setup();
  try {
    addJob(t.db, { id: 1, jobId: "j-gone", status: "held_review", createdAt: T });
    const r = await (await fetch(
      `${t.baseUrl}/api/apply/history?date=${DATE}&tzOffset=0&group=aborted`)).json();
    assert.deepEqual(r.counts, { completed: 0, pending: 0, aborted: 1 });
    assert.equal(r.jobs.length, 1);
    assert.equal(r.jobs[0].postingGone, true);
  } finally { t.close(); }
});

test("AD1: an unrecognised group is refused, never silently answered with everything", async () => {
  // Falling back to "all three" on a typo'd tab name would ship the whole day to a client that
  // asked for a slice of it — requirement 3's violation, committed invisibly.
  const t = setup();
  try {
    for (const bad of ["Completed", "failed", "all", "held_review"]) {
      const res = await fetch(`${t.baseUrl}/api/apply/history?date=${DATE}&tzOffset=0&group=${bad}`);
      assert.equal(res.status, 400, `group='${bad}' was accepted`);
    }
  } finally { t.close(); }
});

test("AD1: a group request still hides soft-deleted rows and still scopes to the user", async () => {
  // The two guards that matter most, re-asserted on the NEW code path rather than assumed to have
  // been inherited by it. A WHERE clause present on the rows query and missing from the counts
  // aggregate is exactly the shape of mistake this endpoint could now make, and it would surface as
  // a tab pill that counts applications the user has removed.
  const t = setup();
  try {
    addJob(t.db, { id: 1, jobId: "j-held", status: "held_review", createdAt: T });
    addJob(t.db, { id: 2, jobId: "j-run",  status: "running",     createdAt: T + 60 });
    addJob(t.db, { id: 3, jobId: "j-other", userId: 2, runId: 2, status: "held_review", createdAt: T });
    t.db.prepare("UPDATE apply_run_jobs SET hidden_at=unixepoch() WHERE job_id='j-held'").run();
    const r = await (await fetch(
      `${t.baseUrl}/api/apply/history?date=${DATE}&tzOffset=0&group=pending`)).json();
    assert.deepEqual(r.jobs.map(j => j.jobId), ["j-run"]);
    assert.equal(r.counts.pending, 1, "the counts read a different WHERE clause from the rows");
    assert.equal(r.total, 1);
  } finally { t.close(); }
});

test("AC4: a malformed date is refused rather than silently answered", async () => {
  const t = setup();
  try {
    for (const bad of ["", "yesterday", "2023-13-99x", "2023/11/14"]) {
      const res = await fetch(`${t.baseUrl}/api/apply/history?date=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `'${bad}' was accepted`);
    }
  } finally { t.close(); }
});

test("AC4: the month marker agrees with the day query about what a day is", async () => {
  const t = setup();
  try {
    // A marker on a day the day-query returns nothing for is worse than no marker: it sends the
    // user to an empty screen and makes the feature untrustworthy. Same offset, same boundary.
    addJob(t.db, { id: 1, jobId: "j-sub",  status: "submitted", createdAt: T });
    addJob(t.db, { id: 2, jobId: "j-held", status: "held_review", createdAt: T + DAY * 2 });
    const r = await (await fetch(`${t.baseUrl}/api/apply/history/months/2023-11?tzOffset=300`)).json();
    for (const [day, n] of Object.entries(r.days)) {
      const d = await (await fetch(`${t.baseUrl}/api/apply/history?date=${day}&tzOffset=300`)).json();
      assert.equal(d.total, n, `the marker says ${n} on ${day} and the day query says ${d.total}`);
    }
    assert.ok(Object.keys(r.days).length >= 2, `expected two marked days, got ${JSON.stringify(r.days)}`);
  } finally { t.close(); }
});

test("AC4: hidden rows are gone from the history AND from the panel's own feeds", async () => {
  const t = setup();
  try {
    addJob(t.db, { id: 1, jobId: "j-sub",  status: "submitted",   createdAt: T });
    addJob(t.db, { id: 2, jobId: "j-held", status: "held_review", createdAt: T, hiddenAt: T + 1 });
    const h = await (await fetch(`${t.baseUrl}/api/apply/history?date=2023-11-14&tzOffset=0`)).json();
    assert.equal(h.total, 1, "a hidden row still appears in the history");
    // A "delete" that leaves the row on the main panel has not deleted anything the user can see.
    const runs = await (await fetch(`${t.baseUrl}/api/apply/runs`)).json();
    assert.ok(!runs.review.some(r => r.id === 2), "a hidden row still appears in NEEDS REVIEW");
    assert.equal(runs.statusCounts.held_review, undefined,
      "statusCounts still counts a hidden row");
  } finally { t.close(); }
});

// ── Requirement 4: ABORT ─────────────────────────────────────────────────────────────────────

test("AC4: aborting a pending run-job cancels it and voids its packet", async () => {
  const t = setup();
  try {
    addJob(t.db, { id: 1, jobId: "j-run", status: "running", createdAt: T });
    t.db.prepare(`INSERT INTO apply_gate_packets (id, user_id, run_id, run_job_id, job_id, apply_url,
      expected_origin, gate_reason, answers_json, token_hash, expires_at, created_at)
      VALUES (1, 1, 1, 1, 'j-run', 'u', 'https://stripe.com', 'login_required', '{}', 'h', 9999999999, ?)`).run(T);

    const res = await fetch(`${t.baseUrl}/api/apply/run-jobs/1/abort`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "cancelled");
    assert.equal(body.packetsVoided, 1, "the prepared handoff was left live for a stopped application");

    const row = t.db.prepare("SELECT * FROM apply_run_jobs WHERE id=1").get();
    assert.equal(row.status, "cancelled");
    assert.equal(row.reason_code, "user_aborted");
    assert.ok(row.finished_at, "an aborted row has no end time");
    // A voided packet drops out of the handoff queue, the portal batches and the token mint.
    assert.ok(t.db.prepare("SELECT consumed_at FROM apply_gate_packets WHERE id=1").get().consumed_at);
  } finally { t.close(); }
});

test("AC4: an abort that loses the race is REFUSED, and says what actually happened", async () => {
  const t = setup();
  try {
    // The application was submitted between the panel rendering the button and the click landing.
    // Reporting success here would tell a candidate their application was stopped when it is at
    // this moment sitting in an employer's inbox.
    addJob(t.db, { id: 1, jobId: "j-sub", status: "submitted", createdAt: T });
    const res = await fetch(`${t.baseUrl}/api/apply/run-jobs/1/abort`, { method: "POST" });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "not_abortable");
    assert.equal(body.status, "submitted");
    assert.match(body.message, /cannot be recalled/);
    assert.equal(t.db.prepare("SELECT status FROM apply_run_jobs WHERE id=1").get().status, "submitted",
      "a submitted application was overwritten as cancelled");
  } finally { t.close(); }
});

test("AC4: the abort claim is ONE statement, so it cannot lose a check-then-write race", () => {
  // better-sqlite3 is synchronous, so a single UPDATE with the guard in its WHERE clause is one
  // atomic decision. A read-then-write would lose exactly the race the guard exists to win: the
  // worker finishing between the SELECT and the UPDATE.
  assert.match(applySource,
    /UPDATE apply_run_jobs\s*\n\s*SET status='cancelled'[\s\S]{0,300}?WHERE id=\? AND user_id=\? AND status IN \(/);
  // And the worker's own terminal write declines to overwrite a cancelled row — the other half of
  // the same guard. Without it, closing the browser makes the run throw and the catch records
  // 'failed' over the user's deliberate stop, with a Retry button on it.
  assert.match(applySource, /SET status=\?, reason_code=\?, reason_detail=\?, finished_at=unixepoch\(\)\s*\n\s*WHERE id=\? AND status != 'cancelled'/);
});

test("AC4: a run-job belonging to someone else cannot be aborted or hidden", async () => {
  const t = setup();
  try {
    addJob(t.db, { id: 9, jobId: "j-other", status: "running", userId: 2, runId: 2, createdAt: T });
    assert.equal((await fetch(`${t.baseUrl}/api/apply/run-jobs/9/abort`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${t.baseUrl}/api/apply/run-jobs/9`, { method: "DELETE" })).status, 404);
    assert.equal(t.db.prepare("SELECT status FROM apply_run_jobs WHERE id=9").get().status, "running");
  } finally { t.close(); }
});

// ── Requirement 4: DELETE is a SOFT HIDE ─────────────────────────────────────────────────────

test("AC4: deleting is a soft hide — a submitted application's evidence survives", async () => {
  const t = setup();
  try {
    addJob(t.db, { id: 1, jobId: "j-sub", status: "submitted", createdAt: T });
    t.db.prepare("INSERT INTO apply_job_logs (run_id, run_job_id, user_id, job_id, event, message) VALUES (1,1,1,'j-sub','submitted','sent')").run();

    const body = await (await fetch(`${t.baseUrl}/api/apply/run-jobs/1`, { method: "DELETE" })).json();
    assert.equal(body.softHide, true, "the response must say what delete actually did");
    assert.equal(body.abortedFirst, false);

    const row = t.db.prepare("SELECT * FROM apply_run_jobs WHERE id=1").get();
    assert.ok(row, "a submitted application was HARD deleted — the evidence a candidate needs when an interview lands");
    assert.ok(row.hidden_at);
    assert.equal(row.status, "submitted", "hiding changed the outcome it records");
    // The original event survives. The count is >= 1 rather than == 1 because the hide writes
    // its own audit line — which is the point: a hide is recorded, a cascade DELETE is not.
    assert.ok(t.db.prepare("SELECT COUNT(*) n FROM apply_job_logs WHERE run_job_id=1 AND event='submitted'").get().n === 1,
      "the audit trail cascaded away with the row");
    assert.ok(t.db.prepare("SELECT COUNT(*) n FROM apply_job_logs WHERE run_job_id=1 AND event='run_job_hidden'").get().n === 1,
      "the hide left no record of itself");

    // Gone from the user's view, both surfaces.
    const h = await (await fetch(`${t.baseUrl}/api/apply/history?date=2023-11-14&tzOffset=0`)).json();
    assert.equal(h.total, 0);
    // And restorable, which is the whole argument for soft over hard.
    t.db.prepare("UPDATE apply_run_jobs SET hidden_at=NULL WHERE id=1").run();
    const back = await (await fetch(`${t.baseUrl}/api/apply/history?date=2023-11-14&tzOffset=0`)).json();
    assert.equal(back.completed.length, 1);
  } finally { t.close(); }
});

test("AC4: deleting a PENDING application stops it first, rather than hiding a live run", async () => {
  const t = setup();
  try {
    // "Remove this" must not mean "stop looking at it while its browser carries on filling a real
    // employer's form."
    addJob(t.db, { id: 1, jobId: "j-run", status: "running", createdAt: T });
    t.db.prepare(`INSERT INTO apply_gate_packets (id, user_id, run_id, run_job_id, job_id, apply_url,
      expected_origin, gate_reason, answers_json, token_hash, expires_at, created_at)
      VALUES (1, 1, 1, 1, 'j-run', 'u', 'https://stripe.com', 'login_required', '{}', 'h', 9999999999, ?)`).run(T);

    const body = await (await fetch(`${t.baseUrl}/api/apply/run-jobs/1`, { method: "DELETE" })).json();
    assert.equal(body.abortedFirst, true);
    const row = t.db.prepare("SELECT * FROM apply_run_jobs WHERE id=1").get();
    assert.equal(row.status, "cancelled", "a running application was hidden while it kept going");
    assert.ok(row.hidden_at);
    assert.ok(t.db.prepare("SELECT consumed_at FROM apply_gate_packets WHERE id=1").get().consumed_at,
      "the packet for a removed application was left live");
  } finally { t.close(); }
});

// ── Requirement 2: nothing is preloaded ──────────────────────────────────────────────────────

test("AC4: the history endpoint has no default date — it cannot be called without asking", () => {
  // An endpoint with a sensible default invites a caller to hit it on mount, which is exactly what
  // requirement 2 forbids. There is no "recent", no implicit today: a request with no date is a 400.
  assert.match(applySource, /const range = dayRangeUtc\(req\.query\.date, req\.query\.tzOffset\);\s*\n\s*if \(!range\) return res\.status\(400\)/);
  assert.ok(!/req\.query\.date \|\| /.test(applySource), "the history endpoint defaults its date");
});

// ── AC4 on the CLIENT: on demand, and the calendar reused rather than rebuilt ────────────────

test("AC4 requirement 2: nothing loads until a date is selected", () => {
  // "ON DEMAND, NOT PRELOADED — this is explicit. Nothing loads until a date is selected. The
  // panel's initial render issues no history query."
  //
  // The real proof is a network check, and scripts/abPanelUi.mjs makes it: it records every /api/*
  // path the page requested on load and asserts none of them starts with /api/apply/history. What
  // is asserted HERE is the structural reason that stays true — because a loader effect added later
  // would break requirement 2 silently, and a source check names the thing not to add.
  //
  // Every other feed in the context is loaded by a useEffect on `user`. The history must not be.
  assert.match(ctx, /const \[historyDate, setHistoryDate\] = useState\(null\)/);
  assert.match(ctx, /const \[history, setHistory\] = useState\(null\)/);

  // ── AH6 NARROWED THIS REQUIREMENT, AND IT IS WORTH SAYING WHICH PART ────────────────────────
  //
  // AC4 forbade a loader effect outright. AH6 adds exactly one: a mount that asks
  // /api/apply/history/latest — a DATE, never rows — and opens on that day if there is one. The
  // rule AC4 was protecting is unchanged and is what is asserted now: no day's applications are
  // shipped to a panel that did not ask for a day, and there is still no implicit TODAY.
  //
  // Why the change was right: AC4's inversion left the panel on a blank board with "pick a date",
  // and the commonest reason to open Auto Apply is to see what happened on the last run, which is
  // almost never today. The panel was making the reader answer a question it could answer itself.
  // A user with NO runs still gets AC4's resting state exactly as it was — that case is driven by
  // scripts/abPanelUi.mjs, and the AH6 default by scripts/ah6RecentRunDefault.mjs.
  const loaderEffects = [...ctx.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/g)]
    .filter(m => /loadHistory\b/.test(m[1]));
  assert.equal(loaderEffects.length, 1,
    "exactly one effect may load the history — AH6's latest-date bootstrap, and nothing else");
  const bootstrap = loaderEffects[0][1];
  assert.match(bootstrap, /\/api\/apply\/history\/latest/,
    "the one loader effect must ask for a DATE, not for a day's rows");
  assert.match(bootstrap, /if \(cancelled \|\| !date\) return;/,
    "no date means no history call at all — AC4's resting state, untouched");
  assert.match(bootstrap, /\{ auto: true \}/,
    "a date the panel chose must be marked as such, so the UI can say why it is on screen");

  // The prohibition that has NOT changed: there is no implicit today anywhere.
  assert.ok(!/loadHistory\(\s*new Date\(\)|loadHistory\(\s*today/.test(ctx),
    "the history defaults to today somewhere — AH6 defaults to the LAST RUN, never to today");
});

test("AC4 -> AD1: 'not asked yet', 'nothing happened' and 'nothing in this tab' are THREE states", () => {
  // Collapsing them is how requirement 7's "no applications on this date" becomes a permanent
  // spinner: the panel cannot tell an unasked question from an empty answer. AD1 adds a THIRD,
  // because the sub-tabs made it possible to be looking at an empty tab on a busy day — "you queued
  // nothing that day" and "you queued six things and none of them are pending" are different
  // answers to the question being asked, and one sentence for both would be wrong for one of them.
  //
  // A FOURTH exists and is not one of the three: a search that matched nothing. A filtered listing
  // saying "nothing pending" while six things are pending would be a lie.
  assert.match(panel, /\{!historyDate && !historyLoading && \(/);
  assert.match(panel, /Pick a date to see the applications you added to auto-apply that day/);
  assert.match(panel, /\{historyDate && history !== null && history\.total === 0 && \(/);
  assert.match(panel, /No applications on \{localDateLabel\(history\.date\)\}/);
  assert.match(panel, /history\.total > 0 && listedJobs\.length === 0 && \(/);
  assert.match(panel, /Nothing \$\{OUTCOME_LABELS\[historyGroup\]\.label\.toLowerCase\(\)\}/);
  assert.match(panel, /matches “\$\{search\.trim\(\)\}”/);
  // Each one is identifiable in the DOM, so scripts/abPanelUi.mjs can assert WHICH emptiness was
  // reported rather than just that the page was empty — which is what it was really checking before.
  for (const kind of ["no-date", "empty-date", "no-match", "empty-tab"]) {
    assert.ok(new RegExp(`data-rm-empty=(\"${kind}\"|\{)`).test(panel),
      `the "${kind}" empty state is not identifiable in the DOM`);
  }
});

test("AC4 -> AD1: the DATABASE PANEL'S calendar — and now its whole CHROME — is reused, not rebuilt", () => {
  // AC4's requirement was "REUSE that widget rather than building a second date picker", and it was
  // met by extracting DateCalendar. AD1 widens the same requirement to the whole layout — the
  // sub-tab row, the search box and the date filter — with the same reasoning: a second
  // implementation that looks identical today drifts the first time either side is touched.
  //
  // RE-PINNED, NOT RELAXED. The two Auto Apply assertions that named DateCalendar and DockPortal
  // directly now name the extracted CONTROL that contains both, because that is the unit both
  // panels render; asserting the inner pieces at the panel would fail for a refactor that made the
  // reuse stronger, which is the opposite of what this test is for.
  assert.match(controls, /import \{ DateCalendar \} from "\.\/DateCalendar\.jsx"/);
  assert.match(controls, /import \{ DockPortal \} from "\.\.\/DockPortal\.jsx"/);
  for (const [name, src] of [["DatabasePanel", dbPanel], ["AutoApplyPanel", panel]]) {
    assert.match(src, /import \{ PanelSubTabs, PanelSearch, DateFilterButton \} from "\.\.\/components\/ui\/PanelControls\.jsx"/,
      `${name} does not render the shared chrome`);
    assert.match(src, /<PanelSubTabs/, `${name} has its own tab row again`);
    assert.match(src, /<PanelSearch/,  `${name} has its own search box again`);
    assert.match(src, /<DateFilterButton/, `${name} has its own date filter again`);
  }
  // DatabasePanel's per-ROW date cell still renders DateCalendar directly — a table cell is not a
  // filter pill and has no button to share — so exactly one direct call site remains there, and
  // the panel's own local calendar is still gone.
  assert.equal((dbPanel.match(/<DateCalendar theme=\{theme\}/g) || []).length, 1);
  assert.ok(!/^function Calendar\(\{ value, onChange, onClose, theme \}\)/m.test(dbPanel),
    "DatabasePanel still holds its own calendar — the extraction is a copy");
  // The Auto Apply panel writes NEITHER any more: no bare DateCalendar, no hand-assembled portal.
  assert.ok(!/<DateCalendar/.test(panel),
    "the Auto Apply panel hand-assembles the calendar again instead of rendering the shared control");
  assert.ok(!/<DockPortal/.test(panel),
    "the Auto Apply panel hand-assembles the popover again instead of rendering the shared control");
  // And the same portal treatment, because the reason it is portalled has not changed: an
  // absolutely-positioned popover inside a scrolling column is CLIPPED by it, and clipping is
  // resolved before stacking, so no z-index can fix it.
  assert.match(controls, /<DockPortal anchorRect=\{rect\} theme=\{theme\}/);
  // The layoutId is a PROP, not a literal shared by both panels — two surfaces animating one
  // underline between them is a coupling this extraction exists to avoid.
  assert.match(controls, /<motion\.div layoutId=\{layoutId\}/);
  assert.match(dbPanel, /layoutId="db-tab-underline"/);
  assert.match(panel, /layoutId="apply-outcome-underline"/);
});

test("AC4: the shadcn calendar.jsx was not clobbered by a case-insensitive filename", () => {
  // A REAL HAZARD, not a hypothetical: this project is developed on Windows, where writing
  // components/ui/Calendar.jsx silently OVERWRITES the unrelated components/ui/calendar.jsx that
  // already exists (a shadcn DayPicker wrapper), and git reports the loss as a modification to the
  // lowercase path rather than as a new file. It happened once while building this; the distinct
  // name is what prevents it, and this asserts both files still exist and are different things.
  assert.match(shadcnCalendar, /from "react-day-picker"/);
  assert.match(dateCalendar, /export function DateCalendar/);
  assert.ok(!/react-day-picker/.test(dateCalendar));
});

test("AC4: the calendar's date string and the server's day boundary agree", () => {
  // The picker returns a LOCAL date; created_at is UTC seconds. Without the offset a run queued at
  // 8pm in Boston lands on the next UTC day, so the user picks the day they remember and is told
  // nothing happened. Every history request carries the browser's own getTimezoneOffset().
  assert.match(ctx, /const tzOffset = \(\) => new Date\(\)\.getTimezoneOffset\(\)/);
  // RE-PINNED FOR AD1: the request grew a `group`, because the three outcome groups are sub-tabs and
  // a tab switch must refetch ONE of them. The date and the offset are unchanged and are still what
  // this test is about.
  assert.match(ctx, /\/api\/apply\/history\?date=\$\{encodeURIComponent\(date\)\}&group=\$\{encodeURIComponent\(wanted\)\}&tzOffset=\$\{tzOffset\(\)\}/);
  assert.match(ctx, /\/api\/apply\/history\/months\/\$\{encodeURIComponent\(month\)\}\?tzOffset=\$\{tzOffset\(\)\}/);
  // And the LABEL is built from the parts rather than through new Date(iso), which parses a
  // YYYY-MM-DD as UTC midnight and renders the previous day west of Greenwich — the panel was
  // telling users "No applications on 8/10" for a date they had just clicked on.
  assert.match(panel, /const localDateLabel = \(iso\) => \{/);
  assert.ok(!/new Date\(history\.date\)\.toLocaleDateString/.test(panel));
  assert.ok(!/new Date\(historyDate\)\.toLocaleDateString/.test(panel));
});

test("AC4 requirement 7: markers are fetched on OPENING the picker, never on render", () => {
  // Requirement 7 permits a marker only if it does not violate requirement 2. Requirement 2's words
  // are "the panel's initial render issues no history query" — and opening the calendar is an
  // action the user took, so the marker fetch is inside the rule rather than an exception to it.
  // RE-PINNED FOR AD1. The open/closed state moved INTO the extracted DateFilterButton with the
  // rest of the control, so the panel no longer writes `if (opening)` — it passes an `onOpen`
  // callback that the control fires when the popover opens. Same rule, same moment, one place.
  assert.match(controls, /if \(opening\) onOpen\?\.\(value\)/);
  assert.match(panel, /onOpen=\{\(value\) => \{[\s\S]{0,400}?loadHistoryMonth\(/);
  assert.match(panel, /onMonth=\{loadHistoryMonth\}/);
  assert.match(panel, /markers=\{historyMarkers\}/);
  // Opt-in, still: the Database panel passes no markers, so nothing is dotted there. That is what
  // "unchanged for its own use" means at the source level; the browser check proves it renders.
  assert.ok(!/markers=/.test(dbPanel),
    "the Database panel started passing markers — its calendar is no longer unchanged for its own use");
  // Failing to get markers must not break the picker — they are a convenience, not the feature.
  assert.match(ctx, /catch \{ \/\* markers are a convenience/);
});

test("AC4 requirement 4: the abort button's presence is the SERVER's decision", () => {
  // The client must not re-derive abortability: the button's presence and the endpoint's guard have
  // to agree, and two copies of that rule is how a button appears for something the server refuses.
  // RE-PINNED FOR AD1: HistoryRow is gone — the dated listing is the panel's body now, so abort and
  // remove live on the two rows that body renders. The RULE is untouched and is asserted on both:
  // the flag comes from the response, never re-derived here.
  assert.match(sections, /\{job\.abortable && onAbort && \(/);
  assert.match(sections, /\{onAbort && app\.rows\?\.some\(r => r\.abortable\) && \(/);
  assert.ok(!/status === "running" \|\| .*status === "queued"/.test(sections),
    "the row is re-deriving which applications can be aborted");
  assert.match(applyRoute, /abortable: OUTCOME_STATUSES\[OUTCOME\.PENDING\]\.includes\(r\.status\)/);
  // A GROUPED application aborts and hides EVERY run-job it holds. Stopping only the newest attempt
  // leaves the application in PENDING after telling the user it stopped; hiding only the newest
  // makes the row come back on the next fetch wearing an earlier attempt's face, which is exactly
  // the "does not return on refetch" AD1 asks to verify.
  assert.match(panel, /const abortApplication = \(app\) => abortRunJob\(\(app\.rows \|\| \[\]\)\.filter\(r => r\.abortable\)\.map\(r => r\.id\)\)/);
  assert.match(panel, /const hideApplication  = \(app\) => hideRunJob\(\(app\.rows \|\| \[\]\)\.map\(r => r\.id\)\)/);
  assert.match(ctx, /const ids = Array\.isArray\(runJobId\) \? runJobId : \[runJobId\];/);
});

test("AC4: the confirmation survives the refresh that follows it", () => {
  // loadHistory clears historyMsg on entry, so setting the confirmation BEFORE the reload wiped it
  // a few hundred milliseconds later — and the one sentence a user most needs after stopping an
  // application ("Nothing was submitted") flashed and went. Both handlers set it after.
  for (const handler of ["abortRunJob", "hideRunJob"]) {
    const body = ctx.slice(ctx.indexOf(`const ${handler} = useCallback`));
    const reload = body.indexOf("await Promise.all([loadHistory(historyDate)");
    const message = body.indexOf("setHistoryMsg(", body.indexOf("try {"));
    assert.ok(reload > 0 && message > reload,
      `${handler} sets its confirmation before the reload that clears it`);
  }
});

// ── AC4: the abort FLAG's lifecycle ──────────────────────────────────────────────────────────
//
// "Must be safe mid-flight: a run being aborted while its browser is filling must terminate
// cleanly, must NOT submit, and must release/void its packet."
//
// The database side of that is tested above. This is the in-process side, and it exists because the
// first version of it had a race that no DB assertion could have caught.

test("AC4: the abort flag outlives browser.close(), so the run's own catch can still read it", async () => {
  // THE RACE THIS PINS. requestAbort resolves as soon as the Chromium process is gone, but the run
  // that was awaiting a page operation is still unwinding through its catch. The first version
  // cleared the flag in the endpoint, chained off requestAbort — so by the time the catch ran, the
  // flag was gone, classifyRuntimeError attributed the "Target closed" to the browser, and a
  // deliberate stop was recorded as a failure with a Retry button on it.
  await requestAbort("job-1");
  assert.equal(isAbortRequested("job-1"), true,
    "the flag was gone before the aborted run could read it");
  // Still set an unwind later.
  await new Promise(r => setTimeout(r, 20));
  assert.equal(isAbortRequested("job-1"), true);
  clearAbort("job-1");
  assert.equal(isAbortRequested("job-1"), false);
});

test("AC4: the flag is retired by the RUN, not by the endpoint that raised it", () => {
  // processRunJob's `finally` is the point at which the run has genuinely finished unwinding and
  // recorded itself. The endpoint must not clear, or it loses the race above.
  assert.match(applySource, /clearAbort\(jobId\);\s*\n\s*\}/,
    "processRunJob no longer retires the abort flag — it will cancel the job's NEXT run too");
  assert.ok(!/requestAbort\([^)]*\)\s*\n?\s*\.then\(\(\) => clearAbort/.test(applySource),
    "the endpoint clears the flag off requestAbort again — that is the race");
});

test("AC4: an abort expires, so one stop cannot silently cancel every future run of that job", () => {
  // The key is the POSTING, and the same posting is routinely re-queued. A permanent flag would
  // make one abort cancel every future attempt and say nothing about why. The TTL is the backstop
  // for the case where no run was in flight to clear it in its finally.
  assert.ok(ABORT_FLAG_TTL_MS >= 60_000 && ABORT_FLAG_TTL_MS <= 15 * 60_000,
    `the abort TTL is ${ABORT_FLAG_TTL_MS}ms — long enough to outlive an unwind, short enough not to reach a re-run`);
});

test("AC4: the LAST thing before the submit click is the abort check", () => {
  // The submit guarantee, and its exact limit. Everything above the checkpoint is reading and
  // filling; everything below can send an application to a real employer. An abort observed at the
  // checkpoint returns without a click. An abort arriving AFTER the click has dispatched cannot be
  // recalled by anything — that window is one statement wide, and it is stated rather than implied.
  const submitBlock = automation.slice(
    automation.indexOf("if (isAbortRequested(jobId)) {", automation.indexOf("PREVIEW STOP")),
    automation.indexOf('inProgress.set(String(jobId), { status: "submitting", browser });') + 60);
  assert.match(submitBlock, /aborted before submit/);
  assert.match(submitBlock, /return \{ \.\.\.abortedResult\(totalFilled\)/);
  // Nothing between the check and the submit marker may click, navigate or type.
  const between = submitBlock.slice(submitBlock.indexOf("}"), submitBlock.indexOf("inProgress.set"));
  assert.ok(!/\.click\(|\.type\(|\.goto\(|\.evaluate\(/.test(between),
    `something acts between the abort check and the submit gate: ${between.trim().slice(0, 120)}`);
});

test("AC4: an aborted run reports cancelled, never error — nothing went wrong", () => {
  // `status: "error"` would send it down classifyRuntimeError and out as a failure. The pipeline's
  // own mapping then makes it `cancelled`, which outranks every other outcome, so an aborted run
  // can never be filed as held-for-review either.
  assert.match(automation, /function abortedResult\(fieldsFilled = 0\) \{[\s\S]{0,300}?status: "cancelled"/);
  assert.match(automation, /reasonCode: "user_aborted"/);
  assert.match(automation, /submitEvidence: "aborted_before_submit"/);
  assert.match(applySource, /const cancelled = result\.status === "cancelled";/);
  assert.match(applySource, /const finalStatus = cancelled \? "cancelled"/);
  // And it is not counted as held or failed — a run's stored counters would otherwise misreport it.
  assert.match(applySource, /\} else if \(cancelled\) \{/);
});

test("AC4: a job cancelled before dispatch never opens a browser", () => {
  // processRun snapshots the queued rows before it starts launching them, so a job aborted in that
  // window is still in its list — and would otherwise fill a real employer's form after the user
  // stopped it.
  assert.match(applySource, /const beforeStart = db\.prepare\("SELECT status FROM apply_run_jobs WHERE id=\?"\)\.get\(runJobId\);/);
  assert.match(applySource, /if \(beforeStart\?\.status === "cancelled"\) \{[\s\S]{0,300}?return;/);
  // And the "running" write itself declines to resurrect a cancelled row.
  assert.match(applySource, /SET status='running', started_at=unixepoch\(\) WHERE id=\? AND status != 'cancelled'/);
});
