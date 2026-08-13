// Validation-correction loop — end-to-end proof that a hold becomes a completion.
//
// Drives the real chain against scripts/fakeAts.js:
//   1. run a job that HOLDS (greenhouse: sponsorship + work-auth + "how did you hear about us?")
//   2. read the questions the hold produced      GET  /api/apply/questions
//   3. answer them                               POST /api/apply/answers  { answers, retryJobIds }
//   4. the retry resolves them as custom_answer and SUBMITS
//
// The point: the eligibility answers are never inferred. The resolver refuses to guess them (A2),
// the loop asks, and the retry uses the user's own words.
//
// Requires: node scripts/fakeAts.js
// Usage:    A1_RESUME=/path/to/any.pdf node scripts/a6CorrectionLoop.mjs
import express from "express";
import Database from "better-sqlite3";
import fs from "node:fs";
import applyRoutes from "../routes/apply.js";

const ATS = "http://localhost:4599";
const RESUME_PDF = process.env.A1_RESUME;
if (!RESUME_PDF || !fs.existsSync(RESUME_PDF)) {
  console.error("Set A1_RESUME to an existing PDF path."); process.exit(1);
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'BASIC');
  CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, profile_name TEXT,
    role_family TEXT, domain TEXT, is_active INTEGER DEFAULT 0);
  CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
    full_name TEXT, email TEXT, phone TEXT, custom_answers TEXT NOT NULL DEFAULT '{}');
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
    open_questions_json TEXT, UNIQUE(run_id, job_id));
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
`);

// The greenhouse flow is the one that holds: its step 2 asks a sponsorship question the resolver
// refuses to infer, plus a free-text question with no standard mapping.
const APPLY_URL = `${ATS}/greenhouse?ats=boards.greenhouse.io`;
db.prepare(`INSERT INTO scraped_jobs (job_id, title, company, url, apply_url, source, location)
            VALUES ('gh1', 'Senior Engineer', 'FakeCo', ?, ?, 'greenhouse', 'Remote')`).run(APPLY_URL, APPLY_URL);
db.prepare(`INSERT INTO resumes (user_id, job_id, apply_mode, ats_score, html, updated_at)
            VALUES (1, 'gh1', 'TAILORED', 80, '<html><body>resume</body></html>', unixepoch())`).run();

// What the real buildAutofillPayload would emit, reading custom_answers live from the DB so the
// loop's saved answers are picked up on the retry exactly as they would be in production.
const buildAutofillPayload = () => ({
  field_map: {
    first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace", name: "Ada Lovelace",
    email: "ada@example.com", phone: "+1 555 0100", linkedin: "https://linkedin.com/in/ada",
    location: "Boston, MA", years_experience: "8", start_date: "2026-09-01",
    // Present and realistic — and the A1 trap condition: the resolver must REFUSE to answer the
    // sponsorship question from it, and the loop must then ask.
    work_authorization: "Yes",
  },
  handler_map: {},
  custom_answers: (() => {
    try { return JSON.parse(db.prepare("SELECT custom_answers FROM user_profile WHERE user_id=1").get().custom_answers || "{}"); }
    catch { return {}; }
  })(),
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
applyRoutes(app, db, (q, r, n) => n(), buildAutofillPayload,
  async () => ({ error: "not_needed" }),
  async () => fs.readFileSync(RESUME_PDF),
  async () => ({}));
const server = app.listen(0);
const url = `http://127.0.0.1:${server.address().port}`;

const post = (p, b) => fetch(`${url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const get  = (p) => fetch(`${url}${p}`).then(r => r.json());
const resetAts = () => fetch(`${ATS}/_reset`, { method: "POST" }).then(r => r.json());
const atsCount = () => fetch(`${ATS}/_submissions`).then(r => r.json()).then(j => j.count);
const submissions = () => fetch(`${ATS}/_submissions`).then(r => r.json()).then(j => j.submissions);

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

console.log("\n=== 1. first run HOLDS (the dead end the loop exists to fix) ===");
const first = await post("/api/apply/runs", { jobIds: ["gh1"], mode: "auto", approvalMode: "auto" }).then(r => r.json());
await waitForRuns();
const held = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(first.runId);
check("job is held_review", held.status === "held_review", "status=" + held.status + " reason=" + held.reason_code);
// Either gate is a legitimate first hold. With step-scoped approval the run escalates BEFORE
// typing anything when an early step contains a guess in a required field, so a form whose first
// step has a low-confidence field reports low_confidence_answers rather than reaching the later
// step that would have reported incomplete_form.
check("hold reason is a recognised gate",
  ["incomplete_form", "low_confidence_answers"].includes(held.reason_code), held.reason_code);
check("no submission reached the ATS", (await atsCount()) === 0);
check("open questions were persisted", !!held.open_questions_json);

console.log("\n=== 2. the hold is now an answerable question set ===");
const firstQs = await get("/api/apply/questions");
console.log(JSON.stringify(firstQs.questions.map(q => ({ q: q.question, type: q.type, reason: q.reason, eligibility: q.eligibility })), null, 2));
check("questions are exposed", firstQs.questions.length >= 1, firstQs.questions.length + " questions");
check("the blocked job is named", firstQs.questions.every(q => q.blocking?.some(b => b.jobId === "gh1")));
check("all questions start unanswered", firstQs.questions.every(q => q.answered === false));

console.log("\n=== 3. answer, retry, repeat — until nothing is open ===");
// A real LOOP: a hold can surface a SECOND round of questions, because the incomplete_form gate
// fires before the low-confidence gate — a low-confidence field only becomes visible once the form
// is otherwise complete.
const answerFor = (q) => {
  if (/require sponsorship/i.test(q.question)) return "No";
  if (/legally authorized/i.test(q.question))  return "Yes";
  if (/hear about us/i.test(q.question))       return "Your engineering blog";
  // A low_confidence question is a CONFIRMATION: accepting the proposal is the answer.
  if (q.reason === "low_confidence" && q.proposed) return q.proposed;
  return q.options?.length ? q.options[0].value : "N/A";
};

const seen = new Map();
let round = 0, lastRetryRunId = null;
for (; round < 4; round++) {
  const open = await get("/api/apply/questions");
  if (open.questions.length === 0) break;
  for (const q of open.questions) seen.set(q.question, q);
  const answers = Object.fromEntries(open.questions.map(q => [q.question, answerFor(q)]));
  console.log("  round " + (round + 1) + ": answering " + open.questions.length + " — " +
    open.questions.map(q => q.question.slice(0, 44) + " [" + q.reason + "]").join("; "));
  const res = await post("/api/apply/answers", { answers, retryJobIds: ["gh1"], mode: "auto", approvalMode: "auto" });
  const rbody = await res.json();
  if (res.status !== 202) { check("round " + (round + 1) + " retry started", false, JSON.stringify(rbody)); break; }
  lastRetryRunId = rbody.retry?.runId ?? lastRetryRunId;
  await waitForRuns();
}
check("the loop converged in a small number of rounds", round >= 1 && round <= 3, round + " round(s)");

// Asserted over the UNION of questions seen, not one round: which round surfaces which question is
// an ordering detail of the gates, but every one of them must have been asked at some point.
const all = [...seen.values()];
// Asserted as an invariant rather than a count. Which eligibility questions get ASKED shrinks as the
// label maps improve: with the merged maps, "Are you legally authorized to work…" now resolves from
// the canonical work_authorization key (the guard permits a canonical key for its own class), so it
// is answered rather than asked. Sponsorship must ALWAYS be asked — it is not derivable from work
// authorization, which is the entire A1 trap.
check("the sponsorship attestation was asked, and flagged as an attestation",
  all.some(q => /require sponsorship/i.test(q.question) && q.eligibility === "sponsorship"),
  JSON.stringify(all.map(q => [q.question.slice(0, 40), q.eligibility])));
const sp = all.find(q => /require sponsorship/i.test(q.question));
check("the sponsorship question was asked, with its select options", (sp?.options || []).length === 2, JSON.stringify(sp?.options));
check("and it explained that the resolver REFUSED rather than had nothing",
  (sp?.refusals || []).some(r => /eligibility_class/.test(r)), JSON.stringify(sp?.refusals));
// One answer per question actually asked. How MANY get asked depends on how much the resolver can
// legitimately resolve on its own, which improves as the label maps do — so this is tied to the
// questions seen, not to a fixed count.
const persisted = Object.keys(JSON.parse(db.prepare("SELECT custom_answers FROM user_profile WHERE user_id=1").get().custom_answers));
check("every question asked was persisted to custom_answers",
  persisted.length === seen.size && persisted.length > 0, `${persisted.length} saved / ${seen.size} asked`);
check("no superseded hold is still offered for review",
  db.prepare("SELECT COUNT(*) n FROM apply_run_jobs WHERE job_id='gh1' AND status='held_review'").get().n === 0);

console.log("\n=== 4. the retry COMPLETES ===");
const retried = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(lastRetryRunId);
check("job is submitted", retried?.status === "submitted", "status=" + retried?.status + " reason=" + retried?.reason_code);
check("submission verified with evidence", retried?.submit_verified === 1, retried?.submit_evidence || "");
const n = await atsCount();
check("EXACTLY ONE submission reached the ATS", n === 1, "count=" + n);

const recorded = (await submissions())[0]?.fields || {};
console.log("recorded answers:", JSON.stringify({
  requires_sponsorship: recorded["job_application[requires_sponsorship]"],
  legally_authorized:   recorded["job_application[legally_authorized]"],
  hear_about_us:        recorded["job_application[hear_about_us]"],
  legal_name:           recorded["job_application[legal_name]"],
}));
check("sponsorship submitted as the USER answered it, not inferred", recorded["job_application[requires_sponsorship]"] === "No");
check("work authorization submitted as the USER answered it", recorded["job_application[legally_authorized]"] === "Yes");
check("the free-text question was submitted", recorded["job_application[hear_about_us]"] === "Your engineering blog");

const provenance = JSON.parse(retried?.answers_json || "[]");
// answers_json stores the RAW answer objects (label/name/field_id + matched_on + refusals);
// the answers_resolved log event stores a normalised {field,...} shape. Read the raw keys here.
const spAnswer = provenance.find(a => /require sponsorship/i.test(a.label || a.name || ""));
check("audit trail records it as custom_answer, never a guess", spAnswer?.provenance === "custom_answer", JSON.stringify(spAnswer));
// A guess must not be SUBMITTED. It may still appear in the audit flagged policy_rejected — that is
// the step policy recording "left blank on purpose", a different fact from "never saw it".
const submittedGuesses = provenance.filter(a => a.provenance === "label_fuzzy" && !a.policy_rejected);
check("nothing SUBMITTED was a low-confidence guess", submittedGuesses.length === 0,
  JSON.stringify(submittedGuesses.map(a => a.label || a.name)));
// The optional-guess drop is asserted directly in test/applyAnswerPolicy.test.js. It is no longer
// reproducible on THIS fixture: fixing the in-page tokenMatch escape bug means greenhouse's
// "Preferred Name" now resolves through the label map as field_map_exact instead of being a 0.3
// guess, so there is nothing left for the policy to drop here. Better resolution, fewer questions —
// which is the point. Recorded as an observation rather than a requirement.
const droppedGuesses = provenance.filter(a => a.policy_rejected);
console.log(`  (optional guesses dropped by the step policy on this fixture: ${droppedGuesses.length})`);

console.log("\n=== 5. no questions remain ===");
const after = await get("/api/apply/questions");
if (after.questions.length) console.log("REMAINING:", JSON.stringify(after.questions.map(q => ({ q: q.question, reason: q.reason })), null, 2));
check("the question queue is empty", after.questions.length === 0, after.questions.length + " left");


server.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exitCode = failures === 0 ? 0 : 1;
