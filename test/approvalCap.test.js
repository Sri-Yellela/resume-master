// TASK Q — THE CAP MOVED AND NOTHING FOLLOWED IT.
//
// AL2 deferred generation from queue time to approval time. Correct change, and it left a hole:
//
//   APPLY_DAILY_QUEUE_CAP (40) was sized to bound MODEL SPEND. Its own comment said so — "at two
//   model calls per queued job (resume + cover letter), 40 is already ~80 calls a day". After the
//   deferral, CASE D calls no model at all, so those 40 previews cost $0 and the cap bounds a free
//   action.
//
//   The spend moved to POST /api/apply/approve, which starts a run with approval_mode='approved'.
//   That run has no artifact, so it takes CASE C and calls generateResumeForApply AND
//   generateCoverLetterForApply. ~$0.04 per approval.
//
//   queuedLast24h EXCLUDES approval_mode='approved' — deliberately, and correctly, for what it was
//   written to measure. The result is that the ONLY action that spends money is the only one no
//   counter counts. Nothing broke; the cost walked out from under the guard.
//
// ── WHAT THESE TESTS ASSERT ────────────────────────────────────────────────────────────────────
//
// Not that a constant exists — that the ceiling BINDS, through the real endpoint, over real rows,
// and that the free action is left alone. Each test injects the state the cap is supposed to catch.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";
import { at } from "../test-support/sourceAnchors.js";

const applyRoute = fs.readFileSync("routes/apply.js", "utf8");

/** `env` is applied BEFORE applyRoutes is called, because the caps are read once at wiring
 * time. Restored in close(), so a cap set for one test cannot leak into the next. */
function setup(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = String(v); }

  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
    CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
      full_name TEXT, email TEXT, phone TEXT, custom_answers TEXT);
    CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, profile_name TEXT,
      role_family TEXT, domain TEXT, is_active INTEGER DEFAULT 0,
      generate_at_queue INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE user_integrations (user_id INTEGER, provider TEXT, status TEXT, account_email TEXT,
      updated_at INTEGER, last_checked_at INTEGER);
    CREATE TABLE profile_base_resumes (profile_id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT,
      content TEXT, enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
    CREATE TABLE base_resume (user_id INTEGER PRIMARY KEY, name TEXT, content TEXT,
      enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT, url TEXT,
      apply_url TEXT, source TEXT, location TEXT, description TEXT);
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
      base_ats_score INTEGER, base_ats_json TEXT,
      screenshot_path TEXT, submit_verified INTEGER, submit_evidence TEXT, blanks_json TEXT,
      fields_discovered INTEGER, hidden_at INTEGER, UNIQUE(run_id, job_id));
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

    INSERT INTO users (id, username) VALUES (1, 'u1');
    INSERT INTO domain_profiles (id, user_id, profile_name, is_active) VALUES (10, 1, 'SWE', 1);
    INSERT INTO user_profile (user_id, first_name, last_name, email) VALUES (1, 'Ada', 'Lovelace', 'ada@example.com');
    INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
      VALUES (10, 1, 'r.txt', 'real resume text', unixepoch());
  `);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
  const noop = async () => ({});
  applyRoutes(app, db, (req, _res, next) => next(), noop, noop, noop, noop, () => null);
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  /** A previewed row parked for approval — what CASE D leaves behind. */
  const park = (jobId) => {
    db.prepare("INSERT OR IGNORE INTO scraped_jobs (job_id,title,company,url) VALUES (?,?,?,?)")
      .run(jobId, "Engineer", "Acme", `https://acme.test/${jobId}`);
    const runId = db.prepare(`INSERT INTO apply_runs (user_id, mode, approval_mode, status, total_jobs)
      VALUES (1, 'auto', 'required', 'completed', 1)`).run().lastInsertRowid;
    return db.prepare(`
      INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, reason_code, answers_json)
      VALUES (?, 1, ?, 'held_review', 'awaiting_approval', '[]')
    `).run(runId, jobId).lastInsertRowid;
  };

  /** N approvals already spent today, exactly as the approve endpoint records them. */
  const spendApprovals = (n) => {
    for (let i = 0; i < n; i++) {
      const runId = db.prepare(`INSERT INTO apply_runs (user_id, mode, approval_mode, status, total_jobs)
        VALUES (1, 'auto', 'approved', 'completed', 1)`).run().lastInsertRowid;
      db.prepare(`INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, created_at)
        VALUES (?, 1, ?, 'submitted', unixepoch())`).run(runId, `spent-${i}`);
    }
  };

  /** N previews already opened today — free, and counted only by the queue cap. */
  const spendQueue = (n) => {
    for (let i = 0; i < n; i++) {
      const runId = db.prepare(`INSERT INTO apply_runs (user_id, mode, approval_mode, status, total_jobs)
        VALUES (1, 'auto', 'required', 'completed', 1)`).run().lastInsertRowid;
      db.prepare(`INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, created_at)
        VALUES (?, 1, ?, 'held_review', unixepoch())`).run(runId, `q-${i}`);
    }
  };

  const post = (p, body) => fetch(`${baseUrl}${p}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
  }).then(async r => ({ status: r.status, body: await r.json() }));

  return {
    db, park, spendApprovals, spendQueue, post,
    get: (p) => fetch(`${baseUrl}${p}`).then(r => r.json()),
    close: () => {
      server.close(); db.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    },
  };
}

// ── 1. THE CAP BINDS ────────────────────────────────────────────────────────

test("approving past the daily approval cap is refused, and says how much is left", async () => {
  const t = setup({ APPLY_DAILY_APPROVAL_CAP: 3 });
  try {
    t.spendApprovals(3);
    const id = t.park("gh-new");

    const { status, body } = await t.post("/api/apply/approve", { runJobIds: [id] });

    assert.equal(status, 429, "⛔ the fourth approval must be refused, not silently generated");
    assert.equal(body.error, "approval_cap_exceeded");
    assert.equal(body.limit, 3);
    assert.equal(body.approvedLast24h, 3);
    assert.equal(body.remaining, 0, "requirement: the error CARRIES remaining");
    assert.match(body.message, /generates a tailored resume and cover letter/,
      "it must name the cost it is protecting — the queue cap's old message explained itself with " +
      "a cost that was no longer incurred, and this one must not acquire the opposite problem");
  } finally { t.close(); }
});

test("a refused approval leaves the row approvable — an approval must never evaporate", async () => {
  const t = setup({ APPLY_DAILY_APPROVAL_CAP: 1 });
  try {
    t.spendApprovals(1);
    const id = t.park("gh-new");

    const { status } = await t.post("/api/apply/approve", { runJobIds: [id] });
    assert.equal(status, 429);

    // /approve marks rows superseded BEFORE calling startRun and undoes that on a non-202. If the
    // undo did not cover this new refusal shape, the user would lose the application entirely: not
    // submitted, not pending, not visible anywhere.
    const row = t.db.prepare("SELECT status, reason_code, approved_at FROM apply_run_jobs WHERE id=?").get(id);
    assert.equal(row.status, "held_review", "the preview must come back");
    assert.equal(row.reason_code, "awaiting_approval", "and still be approvable");
    assert.equal(row.approved_at, null);
    const { pending } = await t.get("/api/apply/pending");
    assert.equal(pending.length, 1, "and still be on the approval screen");
  } finally { t.close(); }
});

test("the cap counts RUN-JOBS, not approve calls — one request for eight is eight", async () => {
  // The shape that would make the cap report a limit and enforce nothing: counting requests bounds
  // the wrong thing by however many ids a caller batches.
  const t = setup({ APPLY_DAILY_APPROVAL_CAP: 5 });
  try {
    const ids = ["a", "b", "c", "d", "e", "f"].map(j => t.park(j));
    const { status, body } = await t.post("/api/apply/approve", { runJobIds: ids });
    assert.equal(status, 429, "six in one request must exceed a cap of five");
    assert.equal(body.requested, 6);
  } finally { t.close(); }
});

test("under the cap, approving proceeds exactly as before", async () => {
  const t = setup({ APPLY_DAILY_APPROVAL_CAP: 5 });
  try {
    t.spendApprovals(2);
    const id = t.park("gh-ok");
    const { status, body } = await t.post("/api/apply/approve", { runJobIds: [id] });
    assert.equal(status, 202, "the guard must not become the normal outcome");
    assert.deepEqual(body.approved, [id]);
    assert.equal(body.run.approvalCap.limit, 5);
    // AFTER this run's own row, exactly as queueCap already reports itself. The client renders
    // "what is left now", and a figure that excluded the approval just made would tell a user they
    // have one more than they do — which is the number they would act on.
    assert.equal(body.run.approvalCap.approvedLast24h, 3, "2 already spent, plus the one just approved");
    assert.equal(body.run.approvalCap.remaining, 2);
  } finally { t.close(); }
});

// ── 2. THE FREE ACTION IS LEFT ALONE ────────────────────────────────────────

test("queueing past the OLD queue cap is not what stops a user — the free action stays free", async () => {
  // Requirement 2: "a cap on a free action is friction with no benefit". The queue cap is kept as a
  // preview/session limit (previews open real browsers against real employers) but it must not be
  // what a user meets while doing something that costs nothing, and it must not be conflated with
  // the spend cap. Here the SPEND budget is exhausted and queueing still works.
  const t = setup({ APPLY_DAILY_QUEUE_CAP: 40, APPLY_DAILY_APPROVAL_CAP: 2 });
  try {
    t.spendApprovals(2);                       // no approvals left at all
    t.db.prepare("INSERT INTO scraped_jobs (job_id,title,company,url) VALUES ('j9','E','Acme','https://a.test/9')").run();

    const { status, body } = await t.post("/api/apply/runs", { jobIds: ["j9"] });
    assert.equal(status, 202, "⛔ an exhausted SPEND budget must not block a free preview");
    assert.equal(body.approvalCap.remaining, 0,
      "but the user must be told, on the way in, that they cannot act on it yet");
  } finally { t.close(); }
});

test("the queue cap still bounds previews, and its message no longer claims a cost", async () => {
  const t = setup({ APPLY_DAILY_QUEUE_CAP: 2 });
  try {
    t.spendQueue(2);
    t.db.prepare("INSERT INTO scraped_jobs (job_id,title,company,url) VALUES ('j9','E','Acme','https://a.test/9')").run();
    const { status, body } = await t.post("/api/apply/runs", { jobIds: ["j9"] });
    assert.equal(status, 429);
    assert.equal(body.error, "queue_cap_exceeded");
    assert.doesNotMatch(body.message, /generat/i,
      "queueing generates nothing on the deferred path; a limit that explains itself with a false " +
      "reason is worse than a bare number");
    assert.match(body.message, /opened and previewed/);
  } finally { t.close(); }
});

// ── 3. SURFACEABLE, NOT DISCOVERED BY BEING REFUSED (requirement 3) ─────────

test("all three caps ride on the run payload, each with limit and remaining", async () => {
  const t = setup();
  try {
    t.db.prepare("INSERT INTO scraped_jobs (job_id,title,company,url) VALUES ('j1','E','Acme','https://a.test/1')").run();
    const { body } = await t.post("/api/apply/runs", { jobIds: ["j1"] });
    for (const [name, used] of [["dailyCap", "submittedLast24h"], ["queueCap", "queuedLast24h"], ["approvalCap", "approvedLast24h"]]) {
      assert.ok(body[name], `${name} must be reported`);
      assert.equal(typeof body[name].limit, "number", `${name}.limit`);
      assert.equal(typeof body[name].remaining, "number", `${name}.remaining`);
      assert.equal(typeof body[name][used], "number", `${name}.${used}`);
    }
  } finally { t.close(); }
});

test("the approval screen carries the budget that decides how much of it can be acted on", async () => {
  const t = setup({ APPLY_DAILY_APPROVAL_CAP: 4 });
  try {
    t.spendApprovals(3);
    t.park("p1"); t.park("p2"); t.park("p3");
    const data = await t.get("/api/apply/pending");
    assert.equal(data.pending.length, 3);
    // The state the user most needs told BEFORE selecting all three: more waiting than approvable.
    assert.equal(data.approvalCap.limit, 4);
    assert.equal(data.approvalCap.remaining, 1);
  } finally { t.close(); }
});

test("the client renders the approval budget on the approval card", () => {
  const panel = fs.readFileSync("client/src/panels/AutoApplyPanel.jsx", "utf8");
  const ctx = fs.readFileSync("client/src/contexts/AutoApplyContext.jsx", "utf8");
  assert.match(ctx, /setApprovalCap\(Number\.isFinite\(data\.approvalCap\?\.remaining\)/,
    "an older server that sends no cap must leave it null, not default to a limit the client invented");
  assert.match(ctx, /applyPending, approvalCap,/, "and it must reach the panel");
  assert.match(panel, /approvalCap\.remaining === 0/, "the exhausted state needs its own sentence");
  assert.match(panel, /approvals left today/);
  assert.match(panel, /approvalCap\.remaining < applyPending\.length/,
    "more waiting than approvable is the state worth naming — it is what a user needs before " +
    "selecting all of them");
});

// ── 4. THE THREE CAPS DO NOT MAKE EACH OTHER UNREACHABLE (requirement 4) ────

test("the default caps are ordered so every one of them can actually bind", () => {
  // queue >= approval >= submission is the pipeline's own order: a submission needs an approval, an
  // approval needs a preview. Read from the source rather than restated, so a change to a default
  // has to come past this.
  const num = (name) => {
    const m = new RegExp(`envInt\\("${name}", (\\d+)\\)`).exec(applyRoute);
    assert.ok(m, `${name} default not found`);
    return Number(m[1]);
  };
  const queue = num("APPLY_DAILY_QUEUE_CAP");
  const approval = num("APPLY_DAILY_APPROVAL_CAP");
  const submission = num("APPLY_DAILY_CAP");

  assert.ok(queue >= approval, `queue ${queue} must be >= approval ${approval}, or no approval cap is reachable`);
  assert.ok(approval >= submission, `approval ${approval} must be >= submission ${submission}, or APPLY_DAILY_CAP is dead code`);
  assert.equal(submission, 25, "APPLY_DAILY_CAP is unaffected by this task — requirement 4");
  assert.equal(queue, 40, "and the queue LIMIT itself is unchanged; only its stated meaning moved");
});

test("a misordered override is reported, once, rather than silently disabling a cap", () => {
  // ⛔ INJECTED. All three are env-overridable, so the ordering above is a property of the DEFAULTS
  // and not of any given deployment. A queue cap of 1 makes both caps below it unreachable; that
  // must not be a silent no-op.
  const t = setup({ APPLY_DAILY_QUEUE_CAP: 1, APPLY_DAILY_APPROVAL_CAP: 30, APPLY_DAILY_CAP: 25 });
  try {
    const warned = [];
    const real = console.warn;
    console.warn = (m) => warned.push(String(m));
    try {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
      const noop = async () => ({});
      applyRoutes(app, t.db, (req, _res, next) => next(), noop, noop, noop, noop, () => null);
    } finally { console.warn = real; }

    const ordering = warned.filter(m => /CAP ORDERING/.test(m));
    assert.equal(ordering.length, 1, "exactly the one broken relation is reported");
    assert.match(ordering[0], /unreachable/);
    assert.match(ordering[0], /APPLY_DAILY_QUEUE_CAP \(1\)/);
  } finally { t.close(); }
});

test("a correctly ordered configuration says nothing — the warning must not become noise", () => {
  const t = setup({ APPLY_DAILY_QUEUE_CAP: 40, APPLY_DAILY_APPROVAL_CAP: 30, APPLY_DAILY_CAP: 25 });
  try {
    const warned = [];
    const real = console.warn;
    console.warn = (m) => warned.push(String(m));
    try {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
      const noop = async () => ({});
      applyRoutes(app, t.db, (req, _res, next) => next(), noop, noop, noop, noop, () => null);
    } finally { console.warn = real; }
    assert.equal(warned.filter(m => /CAP ORDERING/.test(m)).length, 0);
  } finally { t.close(); }
});

// ── 5. THE COUNTERS PARTITION THE WORK ──────────────────────────────────────

test("queuedLast24h and approvedLast24h partition every run-job — nothing falls between them", () => {
  // The hole this task closed was exactly a gap between two counters: one excluded
  // approval_mode='approved', and nothing else counted it. They must remain complements.
  const queued = applyRoute.slice(at(applyRoute, "function queuedLast24h(userId)"),
                                  at(applyRoute, "function approvedLast24h(userId)"));
  const approved = applyRoute.slice(at(applyRoute, "function approvedLast24h(userId)"),
                                    at(applyRoute, "function activeRunCount(userId)"));
  assert.match(queued, /!= 'approved'/, "the queue counter excludes approved runs");
  assert.match(approved, /= 'approved'/, "and the approval counter is exactly that complement");
  for (const src of [queued, approved]) {
    assert.match(src, /rj\.created_at, 0\) >= unixepoch\(\) - 86400/,
      "both must window on created_at — a job that generated and then held cost the same as one " +
      "that submitted, so status must not decide whether it counted");
  }
});

test("the approval cap is enforced in startRun, not only in the approve endpoint", () => {
  // /approve is not the only caller: the answers/retry path reaches startRun with approvalMode too.
  // A cap installed at one of two doors is a cap on one of two doors.
  const fn = applyRoute.slice(at(applyRoute, "function startRun(userId, planTier, jobIds"),
                              at(applyRoute, 'app.post("/api/apply/runs"'));
  assert.match(fn, /approval_cap_exceeded/);
  assert.match(fn, /if \(resolvedApproval === "approved"\)/,
    "gated on the branch the queue cap skips, which is where the spend now is");
  assert.ok(at(fn, "approval_cap_exceeded") < at(fn, "INSERT INTO apply_runs"),
    "refused before the run row is written, or the refusal leaves a run behind");
});
