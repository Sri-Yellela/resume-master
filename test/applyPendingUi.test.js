import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";

// The auto-apply surface moved OUT of JobsPanel (W5): its markup is now panels/AutoApplyPanel.jsx
// and its state and requests are contexts/AutoApplyContext.jsx, both reached from the AUTO APPLY
// tab. The assertions below are about the apply UI, not about which file holds it, so this reads
// all three. JobsPanel stays in the list because the board still owns the queue button that feeds
// the pipeline — and because an assertion that silently stopped covering anything would be worse
// than one that fails.
const jobsPanel = [
  "client/src/panels/JobsPanel.jsx",
  "client/src/panels/AutoApplyPanel.jsx",
  "client/src/contexts/AutoApplyContext.jsx",
].map(f => fs.readFileSync(f, "utf8")).join("\n");
const apiLib    = fs.readFileSync("client/src/lib/api.js", "utf8");
const serverSrc = fs.readFileSync("server.js", "utf8");

// The pending-approval surface. CONTRACT tests: every field the panel reads must exist in what the
// server really sends, and every endpoint the panel calls must really accept that shape. Both sides
// being individually self-consistent is exactly how `tool` vs `toolType` and the missing `queued`
// survived — only the pairing catches it.
//
// These applications are one click from a real employer, so the surface is also asserted on where it
// matters: a guess must be visibly distinguishable from an exact mapping, and bulk approval must not
// be a single click.

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
    CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
      full_name TEXT, email TEXT, phone TEXT, custom_answers TEXT NOT NULL DEFAULT '{}');
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
      screenshot_path TEXT, submit_verified INTEGER, submit_evidence TEXT, hidden_at INTEGER, UNIQUE(run_id, job_id));
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
    INSERT INTO scraped_jobs (job_id, title, company) VALUES ('gh1', 'Senior Engineer', 'Figma');
    INSERT INTO resumes (id, user_id, job_id, ats_score, html) VALUES (5, 1, 'gh1', 82, '<h1>Ada</h1>');
    INSERT INTO apply_runs (id, user_id, mode, approval_mode, status, total_jobs)
      VALUES (1, 1, 'auto', 'required', 'completed', 1);
    INSERT INTO apply_run_jobs (id, run_id, user_id, job_id, status, reason_code, answers_json,
      resume_artifact_id, resume_ats_score, screenshot_path)
      VALUES (1, 1, 1, 'gh1', 'held_review', 'awaiting_approval',
        '[{"name":"email","label":"Email","value":"ada@example.com","provenance":"field_map_exact","confidence":0.9},
          {"name":"legal_name","label":"Legal Name","value":"A. Lovelace","provenance":"label_fuzzy","confidence":0.3},
          {"name":"gone","label":"Skipped","value":null,"skipped":true}]',
        5, 82, '/tmp/shot.png');
  `);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
  const noop = async () => ({});
  applyRoutes(app, db, (req, _res, next) => next(), noop, noop, async () => Buffer.from("%PDF"), noop);
  const server = app.listen(0);
  return { db, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); db.close(); } };
}

// ── contract: what the panel reads is what the server sends ──────────────────

test("every pending field the panel reads exists in the real payload", async () => {
  const t = setup();
  try {
    const { pending } = await (await fetch(`${t.baseUrl}/api/apply/pending`)).json();
    assert.equal(pending.length, 1);
    const p = pending[0];
    // Each of these is read by name in the panel's pending block.
    for (const key of ["runJobId", "company", "title", "answerCount", "guessCount",
                       "resume", "screenshotAvailable"]) {
      assert.ok(key in p, `payload is missing ${key}, which the panel renders`);
    }
    assert.ok("available" in p.resume && "atsScore" in p.resume);
    assert.equal(p.answerCount, 2, "a skipped answer is not going to the employer and must not be counted");
    assert.equal(p.guessCount, 1, "the panel shows this as the reason to look closer");
  } finally { t.close(); }
});

test("the detail the panel expands carries the provenance it colours on", async () => {
  const t = setup();
  try {
    const body = await (await fetch(`${t.baseUrl}/api/apply/run-jobs/1/review`)).json();
    const shown = body.answers.filter(a => !a.skipped && !a.policy_rejected);
    assert.equal(shown.length, 2);
    assert.ok(shown.some(a => a.provenance === "label_fuzzy"),
      "the panel renders label_fuzzy as GUESS; without it every answer looks trustworthy");
    assert.ok(shown.every(a => "label" in a && "value" in a));
  } finally { t.close(); }
});

test("the panel's approve and reject bodies are the shape the endpoints accept", async () => {
  const t = setup();
  try {
    // Reject first — it does not start a run, so it leaves the DB usable for the next assertion.
    const rej = await fetch(`${t.baseUrl}/api/apply/reject`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runJobIds: [1] }),   // exactly what decidePending sends
    });
    assert.equal(rej.status, 200);
    const body = await rej.json();
    assert.ok(Array.isArray(body.rejected), "the panel counts data.rejected.length");
  } finally { t.close(); }
});

test("approve replies with the field the panel counts", async () => {
  const t = setup();
  try {
    const r = await fetch(`${t.baseUrl}/api/apply/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runJobIds: [1] }),
    });
    assert.equal(r.status, 202);
    const body = await r.json();
    assert.ok(Array.isArray(body.approved), "the panel counts data.approved.length");
  } finally { t.close(); }
});

test("a pending application is not ALSO listed as a plain 'needs review' row", async () => {
  // Caught by looking at the rendered surface, not by a unit test: pending rows are held_review, so
  // they appeared twice — once with Approve/Reject, and once as a bare row with no action on it.
  const t = setup();
  try {
    const { review } = await (await fetch(`${t.baseUrl}/api/apply/runs`)).json();
    assert.deepEqual(review, [], "awaiting_approval belongs to the approval surface only");

    // A hold for any OTHER reason must still show up there.
    t.db.prepare(`INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, reason_code)
                  VALUES (1, 1, 'gh2', 'held_review', 'incomplete_form')`).run();
    const after = await (await fetch(`${t.baseUrl}/api/apply/runs`)).json();
    assert.equal(after.review.length, 1);
    // camelCase since the runs payload was re-shaped to match what the panel actually reads.
    assert.equal(after.review[0].reasonCode, "incomplete_form");
  } finally { t.close(); }
});

// ── the surface itself ───────────────────────────────────────────────────────

test("the panel loads pending applications and offers both decisions", () => {
  assert.match(jobsPanel, /api\("\/api\/apply\/pending"\)/);
  assert.match(jobsPanel, /api\(`\/api\/apply\/\$\{approve \? "approve" : "reject"\}`/);
  assert.match(jobsPanel, /\/api\/apply\/run-jobs\/\$\{runJobId\}\/review/);
});

test("a guess is visually distinguished from an exact mapping", () => {
  // The entire reason to show a human this screen. If every answer renders identically there is
  // nothing to review, and approving becomes a rubber stamp.
  assert.match(jobsPanel, /provenance === "label_fuzzy"/);
  assert.match(jobsPanel, /GUESSED/, "the row must say how many answers were guessed");
  assert.match(jobsPanel, /guess \? "GUESS"/, "and each guessed answer must be marked in the detail");
});

test("approving is described as irreversible, not as a neutral action", () => {
  assert.match(jobsPanel, /cannot be undone/i);
  assert.match(jobsPanel, /Approve &amp; send|Approve & send/);
});

test("bulk approval takes two deliberate steps", () => {
  // One stray click must not send several real applications.
  assert.match(jobsPanel, /confirmApproveAll/);
  assert.match(jobsPanel, /Yes, send all/);
});

test("the pending surface gets its own CTA rather than hiding behind 'need review'", () => {
  // The wording moved from "N awaiting your approval" to a dedicated obstacle card when the panel
  // was reorganised around obstacles. The property is unchanged and is asserted more directly now:
  // pending approvals get their OWN card, with their own count and their own single action, rather
  // than being one of several buttons in a strip.
  assert.match(jobsPanel, /waiting for your approval/);
  assert.match(jobsPanel, /kicker="filled, checked, and not sent"/);
  assert.match(jobsPanel, /actionLabel="Review & approve"/);
  assert.match(jobsPanel, /countLabel="to approve"/);
});

// ── the artifact links must actually authenticate ────────────────────────────

test("file links carry the auth token as a query param, which requireAuth honours", () => {
  // <a href> and <img src> cannot send the header api() adds, so a plain link would 401. This is
  // the same mechanism useSyncEvents relies on for SSE.
  assert.match(jobsPanel, /authContextQuery\(\)/);
  assert.match(jobsPanel, /artifactUrl\(p\.runJobId, "resume"\)/);
  assert.match(jobsPanel, /artifactUrl\(p\.runJobId, "screenshot"\)/);
  assert.match(apiLib, /export function authContextQuery/);
  assert.match(serverSrc, /req\.query\?\.authContext/,
    "if the server stops honouring the query param, every resume link on this surface breaks");
});
