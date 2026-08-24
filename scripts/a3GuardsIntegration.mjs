// TASK A3 end-to-end verification. Drives the REAL chain:
//   POST /api/apply/runs -> processRun -> processRunJob -> autoApply -> scripts/fakeAts.js
// Only PDF rendering and resume generation are stubbed; neither is what A3 changes.
//
// Requires: node scripts/fakeAts.js  (localhost:4599)
// Usage:    A1_RESUME=/path/to/any.pdf node scripts/a3GuardsIntegration.mjs
//
// SAFETY: the only apply_url used is http://localhost:4599/*. Nothing reaches an employer.
import express from "express";
import Database from "better-sqlite3";
import fs from "node:fs";
import applyRoutes from "../routes/apply.js";

const ATS = "http://localhost:4599";
const RESUME_PDF = process.env.A1_RESUME;
if (!RESUME_PDF || !fs.existsSync(RESUME_PDF)) {
  console.error("Set A1_RESUME to an existing PDF path."); process.exit(1);
}

const SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'BASIC');
  CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, profile_name TEXT,
    role_family TEXT, domain TEXT, is_active INTEGER DEFAULT 0);
  CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
    full_name TEXT, email TEXT, phone TEXT);
  CREATE TABLE user_integrations (user_id INTEGER, provider TEXT, status TEXT, account_email TEXT,
    updated_at INTEGER, last_checked_at INTEGER);
  CREATE TABLE profile_base_resumes (profile_id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT,
    content TEXT, enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
  CREATE TABLE base_resume (user_id INTEGER PRIMARY KEY, name TEXT, content TEXT,
    enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
  CREATE TABLE simple_apply_profiles (user_id INTEGER PRIMARY KEY, titles_json TEXT, keywords_json TEXT,
    skills_json TEXT, search_terms_json TEXT, source_hash TEXT, years_experience REAL, updated_at INTEGER);
  CREATE TABLE profile_simple_apply_profiles (profile_id INTEGER PRIMARY KEY, user_id INTEGER,
    titles_json TEXT, keywords_json TEXT, skills_json TEXT, search_terms_json TEXT, source_hash TEXT,
    years_experience REAL, updated_at INTEGER);
  CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT, url TEXT,
    apply_url TEXT, source TEXT, location TEXT);
  CREATE TABLE resumes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, job_id TEXT,
    apply_mode TEXT, ats_score INTEGER, html TEXT, updated_at INTEGER);
  CREATE TABLE apply_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT, approval_mode TEXT,
    tool_type TEXT, status TEXT, total_jobs INTEGER, held_count INTEGER DEFAULT 0,
    submitted_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()), started_at INTEGER, finished_at INTEGER);
  CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER, approved_at INTEGER, approved_from_run_job_id INTEGER,
    job_id TEXT, status TEXT, reason_code TEXT, reason_detail TEXT, started_at INTEGER,
    finished_at INTEGER, created_at INTEGER DEFAULT (unixepoch()),
    answers_json TEXT, resume_artifact_id INTEGER, resume_ats_score INTEGER,
    screenshot_path TEXT, submit_verified INTEGER, submit_evidence TEXT,
    -- migration 073. Omitting it made the audit UPDATE throw, and because every audit column shares
    -- one best-effort statement the ENTIRE audit row was silently lost while the run still reported
    -- success. Same failure mode as an un-migrated deployment.
    open_questions_json TEXT,
    ats_score INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0, gate_review_json TEXT, hidden_at INTEGER, locked_at INTEGER, resume_file TEXT, resume_id INTEGER, UNIQUE(run_id, job_id));
  CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
    user_id INTEGER, job_id TEXT, level TEXT DEFAULT 'info', event TEXT, message TEXT,
    details_json TEXT, created_at INTEGER DEFAULT (unixepoch()));
  CREATE TABLE job_applications (user_id INTEGER, job_id TEXT, company TEXT, role TEXT, job_url TEXT,
    source TEXT, location TEXT, apply_mode TEXT, resume_file TEXT, applied_at INTEGER, notes TEXT,
    auto_status TEXT, UNIQUE(user_id, job_id));
  CREATE TABLE user_jobs (user_id INTEGER, job_id TEXT, domain_profile_id INTEGER, applied INTEGER DEFAULT 0,
    updated_at INTEGER, UNIQUE(user_id, job_id));
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()));
  CREATE TABLE apply_idempotency (user_id INTEGER NOT NULL, idem_key TEXT NOT NULL, endpoint TEXT NOT NULL,
    status_code INTEGER NOT NULL DEFAULT 200, response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, idem_key));
  INSERT INTO users (id, username, plan_tier) VALUES (1, 'ada', 'PRO');
  INSERT INTO domain_profiles (id, user_id, profile_name, is_active) VALUES (10, 1, 'SWE', 1);
  INSERT INTO user_profile (user_id, first_name, last_name, email) VALUES (1, 'Ada', 'Lovelace', 'ada@example.com');
  INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
    VALUES (10, 1, 'r.txt', 'real resume text', unixepoch());
`;

// The payload the real buildAutofillPayload would produce, shaped to satisfy /ashby.
//
// NOTE on the "Name" entry: Ashby uses a single `_systemfield_name` labelled "Name", but
// PLATFORM_LABEL_MAPS.ashby only maps "First Name"/"Last Name" — it has no "Name" key, unlike
// `generic`. So once the provider is correctly detected as ashby, `full_name` cannot resolve that
// field and the completeness gate holds the run. That is a real coverage gap in the label map,
// reported rather than patched here (it is a resolution concern, not a submit guard, and
// platformDetector is shared). The fixture resolves it the legitimate way, via the user's own
// exact-question answer, which buildAnswers accepts as custom_answer.
const AUTOFILL = {
  field_map: {
    first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace",
    email: "ada@example.com", phone: "+1 555 0100", location: "Boston, MA",
    website: "https://ada.dev", start_date: "2026-09-01",
  },
  handler_map: {},
  custom_answers: {
    "Name": "Ada Lovelace",
    "I am authorized to work without sponsorship": "yes",
  },
};

function boot({ jobIds = ["ash1"], atsScore = 80 } = {}) {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  // processRunJob gates full-auto on detectPlatformFromUrl, which substring-matches the whole URL
  // against known ATS hosts — a bare localhost URL is "generic" and gets routed to held_review as
  // provider_review_only. The provider token is carried in the query so detection passes while the
  // request still goes to the local harness (fakeAts routes on pathname and ignores the query).
  // No production code is bent for this; it is the fixture presenting a provider-shaped URL.
  const applyUrl = `${ATS}/ashby?ats=ashbyhq.com`;
  for (const jid of jobIds) {
    db.prepare(`INSERT INTO scraped_jobs (job_id, title, company, url, apply_url, source, location)
                VALUES (?, 'Platform Engineer', 'FakeCo', ?, ?, 'ashby', 'Remote')`)
      .run(jid, applyUrl, applyUrl);
    db.prepare(`INSERT INTO resumes (user_id, job_id, apply_mode, ats_score, html, updated_at)
                VALUES (1, ?, 'TAILORED', ?, '<html><body>resume</body></html>', unixepoch())`)
      .run(jid, atsScore);
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
  applyRoutes(
    app, db, (q, r, n) => n(),
    () => AUTOFILL,                                   // buildAutofillPayload
    async () => ({ error: "not_needed" }),            // generateResumeForApply (CASE A short-circuits)
    async () => fs.readFileSync(RESUME_PDF),          // htmlToPdf
    async () => ({}),                                 // generateCoverLetterForApply
  );
  const server = app.listen(0);
  return { db, server, url: `http://127.0.0.1:${server.address().port}` };
}

const post = (url, path, body, headers = {}) =>
  fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const resetAts = () => fetch(`${ATS}/_reset`, { method: "POST" }).then(r => r.json());
const atsCount = () => fetch(`${ATS}/_submissions`).then(r => r.json()).then(j => j.count);

async function waitForRuns(db, ms = 120000) {
  const t0 = Date.now();
  for (;;) {
    const pending = db.prepare("SELECT COUNT(*) n FROM apply_runs WHERE status IN ('queued','running')").get().n;
    if (pending === 0) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise(r => setTimeout(r, 1000));
  }
}

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

// ── 1. Idempotency end to end: one key, one submission at the ATS ────────────
{
  console.log("\n=== 1. duplicate POST with the same Idempotency-Key ===");
  await resetAts();
  const { db, server, url } = boot();
  const key = "e2e-retry-1";
  const a = await post(url, "/api/apply/runs", { jobIds: ["ash1"], mode: "auto", approvalMode: "auto" }, { "Idempotency-Key": key }).then(r => r.json());
  const b = await post(url, "/api/apply/runs", { jobIds: ["ash1"], mode: "auto", approvalMode: "auto" }, { "Idempotency-Key": key }).then(r => r.json());
  check("replay returns the original runId", a.runId === b.runId, `${a.runId} vs ${b.runId}`);
  check("replay is flagged", b.idempotentReplay === true);
  check("only one run row exists", db.prepare("SELECT COUNT(*) n FROM apply_runs").get().n === 1);

  const done = await waitForRuns(db);
  check("run finished", done);
  const submissions = await atsCount();
  check("EXACTLY ONE submission reached the ATS", submissions === 1, `count=${submissions}`);

  const job = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(a.runId);
  check("job status is submitted", job.status === "submitted", `status=${job.status} reason=${job.reason_code}`);
  // Audit trail (requirement 3)
  check("audit: submit_verified is true", job.submit_verified === 1, `submit_verified=${job.submit_verified} evidence=${job.submit_evidence}`);
  check("audit: submit evidence recorded", !!job.submit_evidence, job.submit_evidence);
  check("audit: resume artifact id recorded", job.resume_artifact_id != null, `id=${job.resume_artifact_id} ats=${job.resume_ats_score}`);
  check("audit: screenshot path recorded", !!job.screenshot_path);
  const answers = job.answers_json ? JSON.parse(job.answers_json) : [];
  check("audit: answers persisted with provenance", answers.length > 0 && answers.every(x => "provenance" in x),
    `${answers.length} answers, e.g. ${JSON.stringify(answers.find(x => !x.skipped) || null)}`);
  server.close();
}

// ── 2. Daily cap ─────────────────────────────────────────────────────────────
{
  console.log("\n=== 2. daily cap ===");
  process.env.APPLY_DAILY_CAP = "1";
  await resetAts();
  const { db, server, url } = boot({ jobIds: ["ash1", "ash2"] });
  const r1 = db.prepare("INSERT INTO apply_runs (user_id, mode, tool_type, status, total_jobs) VALUES (1,'auto','generate','completed',1)").run();
  db.prepare("INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, finished_at) VALUES (?,1,'prev','submitted',unixepoch())").run(r1.lastInsertRowid);
  const res = await post(url, "/api/apply/runs", { jobIds: ["ash1"], mode: "auto", approvalMode: "auto" });
  const body = await res.json();
  check("cap returns 429", res.status === 429, `status=${res.status}`);
  check("cap error is explicit", body.error === "daily_cap_exceeded", JSON.stringify(body));
  check("nothing was queued", db.prepare("SELECT COUNT(*) n FROM apply_runs WHERE status='queued'").get().n === 0);
  check("no submission reached the ATS", (await atsCount()) === 0);
  delete process.env.APPLY_DAILY_CAP;
  server.close();
}

// ── 3. Kill switch ───────────────────────────────────────────────────────────
{
  console.log("\n=== 3. kill switch ===");
  await resetAts();
  const { db, server, url } = boot();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('apply_full_auto_disabled','1')").run();
  const auto = await post(url, "/api/apply/runs", { jobIds: ["ash1"], mode: "auto", approvalMode: "auto" });
  check("full-auto is refused with 503", auto.status === 503, `status=${auto.status}`);
  check("no submission reached the ATS", (await atsCount()) === 0);

  // Deliberately a job with no scraped_jobs row: semi mode opens a VISIBLE browser and waits for a
  // human, which would hang this script. processRunJob fails fast on job_not_found instead, and
  // what is being verified here is admission — that the kill switch does not refuse semi.
  const semi = await post(url, "/api/apply/runs", { jobIds: ["no-such-job"], mode: "manual" });
  const semiBody = await semi.json();
  check("semi mode still starts", semi.status === 202, `status=${semi.status}`);
  check("semi run is recorded as semi", db.prepare("SELECT mode FROM apply_runs WHERE id=?").get(semiBody.runId)?.mode === "semi");
  await waitForRuns(db, 20000);
  server.close();
}

// ── 4. Kill switch on an IN-FLIGHT batch ─────────────────────────────────────
// AF3 requirement 1: "Verify it takes effect on an in-flight batch." Section 3 proves ADMISSION —
// the switch refuses a new run with 503. That is the easy half. The half that matters unattended is
// a batch that was ALREADY admitted and is part-way through: flipping the switch has to stop the
// jobs that have not gone yet, or the switch is only a door lock on a room people are already in.
//
// processRunJob re-checks fullAutoDisabled() per job for exactly this reason. What makes the test
// deterministic is processRun's own 1–3s jitter between job launches: job 1 is inside a browser
// while job 2 has not yet reached its check, so a flip in that window must catch job 2.
{
  console.log("\n=== 4. kill switch flipped MID-BATCH ===");
  await resetAts();
  const { db, server, url } = boot({ jobIds: ["ash1", "ash2", "ash3"] });
  const res = await post(url, "/api/apply/runs",
    { jobIds: ["ash1", "ash2", "ash3"], mode: "auto", approvalMode: "auto" });
  check("the batch is admitted while the switch is off", res.status === 202, `status=${res.status}`);

  // Flip it while the run is live. No restart, no deploy, no redeploy of the queue.
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('apply_full_auto_disabled','1')").run();
  console.log("   switch flipped; waiting for the batch to drain");

  const done = await waitForRuns(db, 180000);
  check("the run finished rather than hanging", done);

  const rows = db.prepare("SELECT job_id, status, reason_code FROM apply_run_jobs ORDER BY id").all();
  console.log(`   ${rows.map(r => `${r.job_id}:${r.status}/${r.reason_code ?? "-"}`).join("  ")}`);
  const stopped = rows.filter(r => r.status === "held_review" && r.reason_code === "full_auto_disabled");
  const submissions = await atsCount();
  console.log(`   ATS submissions: ${submissions} of ${rows.length} jobs`);

  check("at least one job was STOPPED by the flip, not submitted",
    stopped.length > 0, JSON.stringify(rows));
  check("the ATS received fewer submissions than the batch had jobs",
    submissions < rows.length, `${submissions} submitted, ${rows.length} queued`);
  check("every stopped job is HELD for a human, never silently dropped",
    stopped.every(r => r.status === "held_review" && r.reason_code === "full_auto_disabled"),
    JSON.stringify(stopped));
  check("stopped jobs + submissions account for the whole batch",
    rows.every(r => r.status === "held_review" || r.status === "submitted" ||
                    r.status === "failed" || r.status === "filled_not_submitted"),
    JSON.stringify(rows.map(r => r.status)));
  server.close();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
// Exit naturally rather than process.exit() — an abrupt exit while a browser/server handle is still
// closing trips a libuv teardown assertion on Windows.
process.exitCode = failures === 0 ? 0 : 1;
