#!/usr/bin/env node
/**
 * TASK AH5 — queue a job that already has a resume, and show what was filled.
 * ============================================================================================
 * OBSERVED
 * "Generating a resume, then queueing that job for auto-apply, produced 'needs review — missing
 * field' with no indication of WHAT was filled or WHAT was missing."
 *
 * WHAT THE DIAGNOSIS FOUND
 *  1  IT DOES NOT REGENERATE, and did not before this task. processRunJob's CASE A has always
 *     reused an existing `resumes` row. What it had no notion of was whether that row was still the
 *     RIGHT one: the lookup was `WHERE user_id=? AND job_id=? ORDER BY updated_at DESC`, with no
 *     check of tool, profile, or whether the base resume had been rewritten since. And
 *     generateResumeForApply ran a SECOND, differently-written query for the same decision. So the
 *     real defect was the opposite of the one reported — not wasted work, but an artifact built for
 *     another profile, or from a base resume the candidate had replaced, sent to an employer with
 *     nothing saying so.
 *  2  THE MISSING FIELDS WERE ALREADY KNOWN. AE6 gave the semi path a real post-fill discovery
 *     pass, and this harness's own run prints "3 required field(s) are yours to answer" by name.
 *     They went into an apply_job_logs event. No surface reads that table, so the hold said
 *     "Required fields were left empty" and stopped there.
 *  3  THERE WAS NO RECORD OF THE BLANK HALF AT ALL. answers_json has carried the filled fields with
 *     provenance since A2; nothing held the fields that were left empty or why.
 *
 * WHAT IS ASSERTED HERE, against the REAL route and a REAL browser on scripts/fakeAts.js
 *   1  generate, then queue: the run REUSES, proven by a generator that counts its own calls
 *   2  edit the base resume, then queue: it REGENERATES, and says which of the reasons it was
 *   3  a different tool and a different profile each invalidate the artifact
 *   4  the hold NAMES its missing required fields, on the row every surface renders
 *   5  the fill log lists every filled field with provenance, and every blank with a reason
 *   6  the blanks are the ACTUAL FORM STATE — they include optional fields no gate looks at
 *
 * Requires: node scripts/fakeAts.js
 * Usage:    A1_RESUME=/path/to/any.pdf node scripts/ah5ReuseAndFillLog.mjs
 */
import express from "express";
import Database from "better-sqlite3";
import fs from "node:fs";
import applyRoutes from "../routes/apply.js";
import { artifactCurrency, currencySentence } from "../services/resumeCurrency.js";

const ATS = "http://localhost:4599";
const RESUME_PDF = process.env.A1_RESUME;
if (!RESUME_PDF || !fs.existsSync(RESUME_PDF)) {
  console.error("Set A1_RESUME to an existing PDF path."); process.exit(1);
}

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'PRO');
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
  CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT, url TEXT,
    apply_url TEXT, source TEXT, location TEXT);
  -- 091 adds domain_profile_id; the fixture carries it so the currency rule is exercised, not skipped.
  CREATE TABLE resumes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, job_id TEXT,
    company TEXT, role TEXT, apply_mode TEXT, ats_score INTEGER, html TEXT,
    domain_profile_id INTEGER, created_at INTEGER, updated_at INTEGER, UNIQUE(user_id, job_id));
  CREATE TABLE apply_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT,
    approval_mode TEXT, tool_type TEXT, status TEXT, total_jobs INTEGER, held_count INTEGER DEFAULT 0,
    submitted_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()), started_at INTEGER, finished_at INTEGER);
  CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER,
    approved_at INTEGER, approved_from_run_job_id INTEGER, job_id TEXT, status TEXT, reason_code TEXT,
    reason_detail TEXT, started_at INTEGER, finished_at INTEGER, created_at INTEGER DEFAULT (unixepoch()),
    answers_json TEXT, open_questions_json TEXT, resume_artifact_id INTEGER, resume_ats_score INTEGER,
    screenshot_path TEXT, submit_verified INTEGER, submit_evidence TEXT,
    ats_score INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0, fields_discovered INTEGER,
    corrections_json TEXT, blanks_json TEXT, gate_review_json TEXT, hidden_at INTEGER, locked_at INTEGER,
    resume_file TEXT, resume_id INTEGER, UNIQUE(run_id, job_id));
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
  INSERT INTO domain_profiles (id, user_id, profile_name, is_active) VALUES (11, 1, 'Data', 0);
  INSERT INTO user_profile (user_id, first_name, last_name, email) VALUES (1, 'Ada', 'Lovelace', 'ada@example.com');
  INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
    VALUES (10, 1, 'r.txt', 'real resume text', 1000);
`);

const APPLY_URL = `${ATS}/greenhouse?ats=boards.greenhouse.io`;
db.prepare(`INSERT INTO scraped_jobs (job_id, title, company, url, apply_url, source, location)
            VALUES ('gh1', 'Senior Engineer', 'FakeCo', ?, ?, 'greenhouse', 'Remote')`).run(APPLY_URL, APPLY_URL);

const buildAutofillPayload = () => ({
  field_map: {
    first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace",
    email: "ada@example.com", phone: "+1 555 0100", location: "Boston, MA",
    years_of_experience: "8", available_start_date: "2026-09-01",
  },
  handler_map: {},
  custom_answers: {},
});

// THE COUNTER IS THE PROOF. "No regeneration" asserted by reading a status string would pass for a
// run that regenerated and then said otherwise; a generator that counts its own invocations cannot.
let generations = 0;
const generateResumeForApply = async (userId, jobId) => {
  generations++;
  const html = `<html><body><h1>Ada Lovelace</h1><p>Generation #${generations}.</p></body></html>`;
  db.prepare(`INSERT INTO resumes (user_id,job_id,company,role,apply_mode,ats_score,html,domain_profile_id,created_at,updated_at)
              VALUES (?,?,?,?,'TAILORED',84,?,10,unixepoch(),unixepoch())
              ON CONFLICT(user_id,job_id) DO UPDATE SET html=excluded.html, updated_at=excluded.updated_at`)
    .run(userId, jobId, "FakeCo", "Senior Engineer", html);
  const row = db.prepare("SELECT id FROM resumes WHERE user_id=? AND job_id=?").get(userId, jobId);
  return { html, resumeId: row.id, atsScore: 84 };
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
applyRoutes(app, db, (q, r, n) => n(), buildAutofillPayload, generateResumeForApply,
  async () => fs.readFileSync(RESUME_PDF), async () => ({ error: "not_needed" }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const post = (p, b) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(`${base}${p}`).then(r => r.json());

async function waitForRuns(ms = 240000) {
  const t0 = Date.now();
  for (;;) {
    if (db.prepare("SELECT COUNT(*) n FROM apply_runs WHERE status IN ('queued','running')").get().n === 0) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise(r => setTimeout(r, 1000));
  }
}

console.log("=== AH5 — reuse what exists, and say what was filled ===\n");
await fetch(`${ATS}/_reset`, { method: "POST" }).catch(() => {
  console.error(`Cannot reach ${ATS} — is scripts/fakeAts.js running?`); process.exit(1);
});

// ── 1. the currency rule, stated and exercised ────────────────────────────────────────────────
console.log("── 1. WHAT COUNTS AS CURRENT ───────────────────────────────────────────────────");
db.prepare(`INSERT INTO resumes (user_id,job_id,company,role,apply_mode,ats_score,html,domain_profile_id,created_at,updated_at)
            VALUES (1,'gh1','FakeCo','Senior Engineer','TAILORED',84,'<html><body>pre-generated</body></html>',10,2000,2000)`).run();

const cur = artifactCurrency(db, { userId: 1, jobId: "gh1", tool: "generate" });
check("an artifact for this job, this tool, this profile, newer than the base resume is CURRENT",
  cur.current && cur.reason === "reused", `${cur.reason}`);
console.log(`  ${currencySentence(cur)}`);

const otherTool = artifactCurrency(db, { userId: 1, jobId: "gh1", tool: "a_plus_resume" });
check("a different TOOL invalidates it", !otherTool.current && otherTool.reason === "different_tool",
  otherTool.reason);

db.prepare("UPDATE domain_profiles SET is_active=0 WHERE id=10").run();
db.prepare("UPDATE domain_profiles SET is_active=1 WHERE id=11").run();
const otherProfile = artifactCurrency(db, { userId: 1, jobId: "gh1", tool: "generate" });
check("a different PROFILE invalidates it", !otherProfile.current && otherProfile.reason === "different_profile",
  otherProfile.reason);
db.prepare("UPDATE domain_profiles SET is_active=1 WHERE id=10").run();
db.prepare("UPDATE domain_profiles SET is_active=0 WHERE id=11").run();

db.prepare("UPDATE profile_base_resumes SET updated_at=9999 WHERE profile_id=10").run();
const staleBase = artifactCurrency(db, { userId: 1, jobId: "gh1", tool: "generate" });
check("a base resume edited AFTER it invalidates it",
  !staleBase.current && staleBase.reason === "base_resume_changed", staleBase.reason);
console.log(`  ${currencySentence(staleBase)}`);
db.prepare("UPDATE profile_base_resumes SET updated_at=1000 WHERE profile_id=10").run();

db.prepare("UPDATE resumes SET domain_profile_id=NULL WHERE job_id='gh1'").run();
const unknown = artifactCurrency(db, { userId: 1, jobId: "gh1", tool: "generate" });
check("an artifact from before the column existed is usable, and SAYS it is unverified",
  unknown.current && unknown.reason === "reused_unknown_profile", unknown.reason);
db.prepare("UPDATE resumes SET domain_profile_id=10 WHERE job_id='gh1'").run();

// ── 2. queue a job that already has a resume ──────────────────────────────────────────────────
console.log("\n── 2. GENERATE, THEN QUEUE — NO REGENERATION ───────────────────────────────────");
const before = generations;
const run1 = await post("/api/apply/runs", { jobIds: ["gh1"], mode: "manual" });
await waitForRuns();
check("the generator was NOT called — the existing resume was reused", generations === before,
  `${generations - before} generation(s)`);

const row1 = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(run1.runId);
const reuseEvent = db.prepare(
  "SELECT event, message FROM apply_job_logs WHERE run_job_id=? AND event IN ('resume_reused','resume_regenerating') ORDER BY id DESC LIMIT 1"
).get(row1.id);
check("and the run SAYS so, rather than leaving it to be inferred",
  reuseEvent?.event === "resume_reused", reuseEvent?.message || "(no event)");
check("the reused artifact is the one already on disk, not a new row",
  db.prepare("SELECT COUNT(*) n FROM resumes WHERE user_id=1 AND job_id='gh1'").get().n === 1);

// ── 3. the hold names its fields ──────────────────────────────────────────────────────────────
console.log("\n── 3. THE HOLD NAMES ITS MISSING FIELDS ────────────────────────────────────────");
check("the job is held for review", row1.status === "held_review", `${row1.status}/${row1.reason_code}`);
const review = await get(`/api/apply/run-jobs/${row1.id}/review`);
check("the review surface names the required fields still outstanding",
  Array.isArray(review.missingRequired) && review.missingRequired.length > 0,
  JSON.stringify(review.missingRequired));
const runJobs = await get(`/api/apply/runs/${run1.runId}`);
const listed = (runJobs.jobs || []).find(j => j.id === row1.id);
check("and so does the row the panel renders, without a second request",
  Array.isArray(listed?.missingRequired) && listed.missingRequired.length > 0,
  JSON.stringify(listed?.missingRequired));

// ── 4. the fill log ───────────────────────────────────────────────────────────────────────────
console.log("\n── 4. THE FILL LOG ─────────────────────────────────────────────────────────────");
const log = await get(`/api/apply/run-jobs/${row1.id}/fill-log`);
check("every filled field is listed", Array.isArray(log.filled) && log.filled.length > 0,
  `${log.filled?.length} filled`);
check("  ...each with the rule that produced it",
  log.filled.every(f => f.provenance != null),
  log.filled.slice(0, 3).map(f => `${f.label}=${JSON.stringify(f.value)} (${f.provenance})`).join("; "));
check("  ...and its confidence, where the rule has one",
  log.filled.some(f => f.confidence != null));
check("every blank is listed", Array.isArray(log.blanks) && log.blanks.length > 0,
  `${log.blanks?.length} blank`);
const REASONS = new Set(["low_confidence", "needs_you", "no_answer", "unmatched", "fill_failed"]);
check("  ...each with a reason from the closed set",
  log.blanks.every(b => REASONS.has(b.reason)),
  [...new Set(log.blanks.map(b => b.reason))].join(", "));
// The reason has to be RIGHT, not merely present. buildAnswers emits nothing at all for an
// eligibility question the profile cannot answer, so these two used to be reported as
// "we did not recognise the field" — untrue, and untrue in the direction that makes a careful
// refusal look like a parsing failure.
check("  ...and an eligibility question says only you can answer it, not that we failed to read it",
  log.blanks.filter(b => /sponsorship|legally authorized/i.test(b.label || "")).length === 2 &&
  log.blanks.filter(b => /sponsorship|legally authorized/i.test(b.label || "")).every(b => b.reason === "needs_you"),
  log.blanks.filter(b => /sponsorship|legally authorized/i.test(b.label || "")).map(b => `${b.reason}`).join(", "));
check("  ...and the required ones are marked as such",
  log.blanks.some(b => b.required === true),
  `${log.blanks.filter(b => b.required).length} required`);
// The point of item 4: the blank list is the FORM, not the gate. A gate only ever looks at
// required fields, so an optional blank in this list can only have come from the real page.
check("THE BLANKS ARE THE ACTUAL FORM STATE — optional fields no gate inspects are in the record",
  log.blanks.some(b => b.required === false),
  `${log.blanks.filter(b => !b.required).length} optional blank(s)`);
check("the log states whether anything was regenerated",
  log.resume?.reuse?.reused === true, JSON.stringify(log.resume?.reuse));
console.log(`  filled : ${log.filled.map(f => `${f.label}[${f.provenance}]`).join(", ")}`);
console.log(`  blank  : ${log.blanks.map(b => `${b.label || b.field}${b.required ? "*" : ""}[${b.reason}]`).join(", ")}`);

// A blank list that merely repeats the required-field list would pass every check above.
const requiredBlanks = log.blanks.filter(b => b.required).map(b => b.label);
check("the named missing fields and the required blanks are the same set",
  requiredBlanks.length === review.missingRequired.length &&
  requiredBlanks.every(l => review.missingRequired.includes(l)),
  `${requiredBlanks.join(" | ")} vs ${review.missingRequired.join(" | ")}`);

// ── 5. edit the base resume, queue again ──────────────────────────────────────────────────────
console.log("\n── 5. EDIT THE BASE RESUME, THEN QUEUE AGAIN — IT REBUILDS ─────────────────────");
db.prepare("UPDATE profile_base_resumes SET content='rewritten', updated_at=unixepoch()+10 WHERE profile_id=10").run();
const before2 = generations;
const run2 = await post("/api/apply/runs", { jobIds: ["gh1"], mode: "manual" });
await waitForRuns();
check("the generator WAS called this time", generations > before2, `${generations - before2} generation(s)`);
const row2 = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(run2.runId);
const regenEvent = db.prepare(
  "SELECT event, message FROM apply_job_logs WHERE run_job_id=? AND event IN ('resume_reused','resume_regenerating') ORDER BY id DESC LIMIT 1"
).get(row2.id);
check("and the run says WHY it rebuilt", regenEvent?.event === "resume_regenerating",
  regenEvent?.message || "(no event)");
check("  ...naming the base-resume edit, not just 'regenerated'",
  /base resume was edited/i.test(regenEvent?.message || ""), regenEvent?.message || "");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
server.close();
process.exit(failures === 0 ? 0 : 1);
