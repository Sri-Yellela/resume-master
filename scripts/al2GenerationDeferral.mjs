// AL2 — generation is deferred from QUEUE to APPROVAL. Real-run verification.
//
// The claim is a NEGATIVE and a COUNT, which is why this exists rather than another unit test:
// queueing must invoke the generator ZERO times, and approving must invoke it EXACTLY ONCE.
// A source assertion can show the call is absent from a branch; it cannot show which branch a real
// run takes. The generator here is a counting stub, so the count is the evidence.
//
// WHY IT IS NOT COVERED BY a9ApprovalFlow: that harness seeds a `resumes` row per job, so every
// run takes CASE A (a current artifact, nothing to generate) and the deferral branch is never
// entered. This one deliberately seeds NO artifact, which is the state a freshly swiped job is in.
//
//   1. queue          — 0 generations, the free base band is recorded, the row awaits approval
//   2. the surface    — /api/apply/pending carries the band and says generation was deferred
//   3. approve        — EXACTLY 1 generation, and the application reaches the ATS
//   4. the toggle ON  — generate_at_queue restores the old behaviour: 1 generation AT QUEUE
//
// ⚠ WHAT THIS DOES NOT PROVE: the base-resume SCORER itself. scoreBaseResumeForApply lives in
// server.js (it needs the profile, signal and term-weight loaders that hang off the app), so it is
// injected here as a stub with the real return shape. This harness proves the pipeline CALLS it,
// PERSISTS what it returns, and SURFACES it. The scorer's own arithmetic is covered by
// test/localAtsScorer.test.js and the band mapping by test/atsBandSurfaces.test.js.
//
// Requires: node scripts/fakeAts.js
// Usage:    A1_RESUME=/path/to/any.pdf node scripts/al2GenerationDeferral.mjs
import express from "express";
import Database from "better-sqlite3";
import fs from "node:fs";
import applyRoutes from "../routes/apply.js";
import { ATS_BAND } from "../shared/atsBands.js";

const ATS = "http://localhost:4599";
const RESUME_PDF = process.env.A1_RESUME;
if (!RESUME_PDF || !fs.existsSync(RESUME_PDF)) {
  console.error("Set A1_RESUME to an existing PDF path."); process.exit(1);
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'BASIC');
  CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, profile_name TEXT,
    role_family TEXT, domain TEXT, is_active INTEGER DEFAULT 0,
    generate_at_queue INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
    full_name TEXT, email TEXT, phone TEXT, custom_answers TEXT);
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
    corrections_json TEXT, gate_review_json TEXT,
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
  INSERT INTO user_profile (user_id, first_name, last_name, full_name, email, phone)
    VALUES (1, 'Ada', 'Lovelace', 'Ada Lovelace', 'ada@example.com', '+1 555 0100');
  INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
    VALUES (10, 1, 'r.txt', 'Kubernetes, Python, distributed systems, observability tooling', unixepoch());
  INSERT INTO user_integrations (user_id, provider, status) VALUES (1, 'google', 'connected');
`);

const APPLY_URL = `${ATS}/ashby?ats=jobs.ashbyhq.com`;
// NO `resumes` ROW. That absence is the point: it is the state a job is in the moment it is
// swiped, and it is what routes the run through the deferral branch instead of CASE A.
for (const id of ["def1", "def2"]) {
  db.prepare(`INSERT OR IGNORE INTO scraped_jobs (job_id, title, company, url, apply_url, source, location, description)
              VALUES (?, 'Platform Engineer', 'FakeCo', ?, ?, 'ashby', 'Remote',
                      'We run Kubernetes and Python. You will own observability tooling.')`)
    .run(id, APPLY_URL, APPLY_URL);
}

const buildAutofillPayload = () => ({
  field_map: {
    first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace",
    email: "ada@example.com", phone: "+1 555 0100", location: "Boston, MA",
    website_url: "https://ada.dev", available_start_date: "2026-09-01",
  },
  handler_map: {},
  custom_answers: { "I am authorized to work without sponsorship": "yes" },
});

// THE COUNTER. This is the evidence for the whole task.
let generations = 0;
const countingGenerator = async (userId, jobId) => {
  generations++;
  const id = db.prepare(`INSERT INTO resumes (user_id, job_id, apply_mode, ats_score, html, updated_at)
                         VALUES (?, ?, 'TAILORED', 80, '<html><body>tailored</body></html>', unixepoch())`)
    .run(userId, jobId).lastInsertRowid;
  return { html: "<html><body>tailored</body></html>", atsScore: 80, resumeId: id };
};

const baseAtsStub = () => ({
  score: 31, band: ATS_BAND.MODERATE, scorable: true, declineReasons: [],
  matched: ["kubernetes", "python"], missing: ["terraform", "go"], resumeDepth: null,
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
applyRoutes(app, db, (q, r, n) => n(), buildAutofillPayload,
  countingGenerator,
  async () => fs.readFileSync(RESUME_PDF),
  async () => ({}),
  baseAtsStub);
const server = app.listen(0);
const url = `http://127.0.0.1:${server.address().port}`;

const post = (p, b) => fetch(`${url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const get  = (p) => fetch(`${url}${p}`).then(r => r.json());
const resetAts = () => fetch(`${ATS}/_reset`, { method: "POST" }).then(r => r.json());
const atsCount = () => fetch(`${ATS}/_submissions`).then(r => r.json()).then(j => j.count);

async function waitForRuns(ms = 180000) {
  const t0 = Date.now();
  for (;;) {
    if (db.prepare("SELECT COUNT(*) n FROM apply_runs WHERE status IN ('queued','running')").get().n === 0) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise(r => setTimeout(r, 1000));
  }
}

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

await resetAts();

// ── 1. QUEUEING IS FREE ──────────────────────────────────────────────────────
console.log("\n=== 1. queueing generates NOTHING ===");
const run1 = await post("/api/apply/runs", { jobIds: ["def1"], mode: "auto" }).then(r => r.json());
await waitForRuns();
const queued = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(run1.runId);

check("ZERO generations at queue time", generations === 0, `count=${generations}`);
check("nothing reached the ATS", await atsCount() === 0);
check("the job is parked awaiting approval", queued.status === "held_review" && queued.reason_code === "awaiting_approval",
  `status=${queued.status} reason=${queued.reason_code}`);
check("no resume artifact exists yet", queued.resume_artifact_id == null, `id=${queued.resume_artifact_id}`);
check("the FREE base score was recorded instead", queued.base_ats_score === 31 && queued.base_ats_json != null,
  `score=${queued.base_ats_score}`);
check("the answers that WOULD be sent are recorded", JSON.parse(queued.answers_json || "[]").length > 0,
  `${JSON.parse(queued.answers_json || "[]").length} answers`);
const deferLog = db.prepare("SELECT * FROM apply_job_logs WHERE run_job_id=? AND event='generation_deferred'").get(queued.id);
check("the run SAYS it deferred rather than silently skipping", !!deferLog, deferLog?.message || "");

// ── 2. THE APPROVAL SCREEN CAN BE READ ───────────────────────────────────────
console.log("\n=== 2. the approval screen is not blind ===");
const pending = await get("/api/apply/pending");
const row = pending.pending.find(p => p.runJobId === queued.id);
check("the row appears in the pending list", !!row);
check("it carries the base band", row?.baseAts?.band === "moderate", `band=${row?.baseAts?.band}`);
check("it says generation was deferred", row?.generationDeferred === true);
check("it reports no resume available", row?.resume?.available === false);
check("the terms behind the band are shown", (row?.baseAts?.missing || []).includes("terraform"),
  `missing=${JSON.stringify(row?.baseAts?.missing)}`);
const detail = await get(`/api/apply/run-jobs/${queued.id}/review`);
check("the review detail carries the same band", detail?.baseAts?.band === "moderate");

// ── 3. APPROVING GENERATES, EXACTLY ONCE ─────────────────────────────────────
console.log("\n=== 3. approving generates exactly once ===");
const approved = await post("/api/apply/approve", { runJobIds: [queued.id] }).then(r => r.json());
check("approve starts a run", !!approved?.run?.runId, `run=${approved?.run?.runId}`);
await waitForRuns();
check("EXACTLY ONE generation, and it happened at APPROVAL", generations === 1, `count=${generations}`);
check("exactly one submission reached the ATS", await atsCount() === 1);

// ── 4. THE TOGGLE RESTORES THE OLD BEHAVIOUR ─────────────────────────────────
console.log("\n=== 4. generate_at_queue=1 restores generate-at-queue ===");
await resetAts();
db.prepare("UPDATE domain_profiles SET generate_at_queue=1 WHERE id=10").run();
const before = generations;
const run2 = await post("/api/apply/runs", { jobIds: ["def2"], mode: "auto" }).then(r => r.json());
await waitForRuns();
const queued2 = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(run2.runId);
check("the toggle ON generates AT QUEUE", generations === before + 1, `count=${generations - before}`);
check("and it still does not submit", await atsCount() === 0);
check("and it records the artifact, not a deferred band", queued2.resume_artifact_id != null && queued2.base_ats_json == null,
  `artifact=${queued2.resume_artifact_id} base=${queued2.base_ats_json}`);

server.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
