// AL2 — generation is deferred from QUEUE to APPROVAL, and the approval screen gets a free band.
//
// THE COST THIS EXISTS TO STOP: generation is ~$0.04 on Sonnet and fired when a job was QUEUED.
// A swipe is about a second, so five idle minutes of swiping was ~60 jobs and ~$2.40 — spent by a
// gesture that decided nothing, on applications the user had not seen and had not agreed to send.
//
// A USER CANNOT APPROVE BLIND, so the deferral is only half of it. The other half is that the
// approval screen shows a real fit BAND computed against the BASE resume by the deterministic
// scorer — no model call, no artifact, no network. That number is also more honest than the one it
// replaces: the old score was computed against the GENERATED resume, so the preview flattered
// exactly the thing it was asking the user to pay for. A base-resume band is a floor.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";
import { at, lastAt } from "../test-support/sourceAnchors.js";
import { ATS_BAND } from "../shared/atsBands.js";

const applyRoute = fs.readFileSync("routes/apply.js", "utf8");

function setup() {
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

  /** A previewed row parked for approval, with the free base score AL2 records instead of a resume. */
  const parkDeferred = ({ jobId = "gh1", baseAts = null } = {}) => {
    const runId = db.prepare(`INSERT INTO apply_runs (user_id, mode, approval_mode, status, total_jobs)
      VALUES (1, 'auto', 'required', 'completed', 1)`).run().lastInsertRowid;
    return db.prepare(`
      INSERT INTO apply_run_jobs (run_id, user_id, job_id, status, reason_code, answers_json,
                                  base_ats_score, base_ats_json)
      VALUES (?, 1, ?, 'held_review', 'awaiting_approval', ?, ?, ?)
    `).run(runId, jobId, JSON.stringify([{ name: "email", value: "a@b.c", provenance: "handler_exact" }]),
           baseAts?.score ?? null, baseAts ? JSON.stringify(baseAts) : null).lastInsertRowid;
  };

  return {
    db, baseUrl, parkDeferred,
    get: (p) => fetch(`${baseUrl}${p}`).then(r => r.json()),
    close: () => { server.close(); db.close(); },
  };
}

// ── THE BRANCH ──────────────────────────────────────────────────────────────────────────────────
//
// processRunJob needs a real browser, so these read the branch as source — the same approach
// test/applyPipeline.test.js already takes for CASE B and CASE C, and for the same reason.

const caseD = applyRoute.slice(at(applyRoute, "CASE D:"), at(applyRoute, "CASE C: no artifact"));

test("the deferred branch calls NO generator — not for the resume, not for the cover letter", () => {
  // The whole point. A right-swipe must be free, and the cover letter is a model call too:
  // deferring the resume while still generating a letter would leave most of the cost in place.
  assert.doesNotMatch(caseD, /generateResumeForApply/,
    "the deferred preview must not generate a resume — that spend is what waits for approval");
  assert.doesNotMatch(caseD, /generateCoverLetterForApply/,
    "the cover letter is a model call too; deferring only the resume leaves most of the cost");
  assert.match(caseD, /generation_deferred/, "the run must SAY it deferred, not silently skip");
});

test("the deferred branch does NOT pass resumePathPromise — the trap that would break the queue", () => {
  // autoApply treats 'preview' as UNATTENDED and holds on
  //   isUnattended && resumePathPromise && !effectiveResumePath
  // with status 'ats_held' / 'resume_unavailable'. Passing Promise.resolve(null) — the obvious way
  // to express "no resume yet" — therefore turns EVERY deferred preview into a hold that the
  // approve endpoint cannot release, because only 'awaiting_approval' rows are approvable.
  // Nothing would ever reach the approval screen, and the failure would look like a browser bug.
  // CODE ONLY. The branch's comment explains this trap by name, so a raw scan of the region
  // matches its own warning and fails — which is exactly the false positive that teaches people to
  // delete the assertion rather than the defect.
  const caseDCode = caseD.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(caseDCode, /resumePathPromise/,
    "passing resumePathPromise on the deferred path makes every preview an 'ats_held' dead end");
  assert.doesNotMatch(caseDCode, /coverLetterPathPromise/);
});

test("the deferred branch records the free base score before opening the browser", () => {
  assert.match(caseD, /scoreBaseResumeForApply/);
  assert.match(caseD, /base_ats_score=\?, base_ats_json=\?/,
    "the score and the terms behind it must both persist — a bare number cannot be checked");
  assert.ok(at(caseD, "scoreBaseResumeForApply") < at(caseD, "site_visit_started"),
    "score first: the browser may fail, and the free signal is what the approval screen needs");
});

test("ONLY the preview path defers — semi and full-auto are untouched", () => {
  const decision = applyRoute.slice(at(applyRoute, "const generateAtQueue"),
                                    at(applyRoute, "const deferGeneration") + 200);
  assert.match(decision, /needsApproval && !generateAtQueue/,
    "deferral is gated on a human being due to approve; semi has a human AT the browser already, " +
    "and approval_mode 'auto'/'approved' will never see an approval screen");
});

// ── THE TOGGLE ──────────────────────────────────────────────────────────────────────────────────

test("generate_at_queue defaults to OFF", () => {
  const t = setup();
  try {
    const row = t.db.prepare("SELECT generate_at_queue FROM domain_profiles WHERE id=10").get();
    assert.equal(row.generate_at_queue, 0,
      "the default must be the cheap side — a user who never finds this setting is never charged " +
      "for an application they have not approved");
  } finally { t.close(); }
});

test("the toggle coerces to OFF on anything that is not an explicit affirmative", () => {
  // It decides whether queueing SPENDS MONEY, so a malformed request must fail towards not
  // spending. Same coercion and same direction as include_summary (AI1).
  const src = fs.readFileSync("routes/domainProfiles.js", "utf8");
  const block = src.slice(at(src, "if (updates.generate_at_queue !== undefined)"),
                          at(src, "// JSON-encode array fields"));
  assert.match(block, /=== true \|\| .*=== 1 \|\| .*=== "true"\) \? 1 : 0/);
  assert.match(fs.readFileSync("routes/domainProfiles.js", "utf8"),
    /"include_summary", "generate_at_queue"\]/, "it must be on the update allow-list to be settable");
});

// ── THE APPROVAL SCREEN ─────────────────────────────────────────────────────────────────────────

test("the pending list carries the base band, so approval is not blind", async () => {
  const t = setup();
  try {
    t.parkDeferred({ baseAts: {
      score: 47, band: ATS_BAND.STRONG, scorable: true, declineReasons: [],
      matched: ["python", "kubernetes"], missing: ["terraform"], resumeDepth: null,
    }});
    const { pending } = await t.get("/api/apply/pending");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].baseAts.band, "strong");
    assert.equal(pending[0].baseAts.score, 47);
    assert.deepEqual(pending[0].baseAts.missing, ["terraform"]);
    assert.equal(pending[0].resume.available, false, "nothing has been generated yet");
    assert.equal(pending[0].generationDeferred, true,
      "'not generated yet' and 'generation failed' look identical from resume.available alone, " +
      "and they need opposite responses from the user");
  } finally { t.close(); }
});

test("a DECLINED base score renders as its own state, never as a low score", async () => {
  // scoreAtsLocally returns null with decline_reasons when there is too little signal to judge.
  // Coercing that to 0 would render the most honest answer the engine gives as its worst grade.
  const t = setup();
  try {
    t.parkDeferred({ baseAts: {
      score: null, band: ATS_BAND.NOT_ENOUGH_SIGNAL, scorable: false,
      declineReasons: ["job_description_too_short"], matched: [], missing: [],
    }});
    const { pending } = await t.get("/api/apply/pending");
    assert.equal(pending[0].baseAts.score, null, "null must survive as null");
    assert.equal(pending[0].baseAts.band, "not_enough_signal");
    assert.equal(pending[0].baseAts.scorable, false);
    assert.deepEqual(pending[0].baseAts.declineReasons, ["job_description_too_short"]);
  } finally { t.close(); }
});

test("a row that predates the deferral reports null, not a fabricated band", async () => {
  const t = setup();
  try {
    t.parkDeferred({ baseAts: null });
    const { pending } = await t.get("/api/apply/pending");
    assert.equal(pending[0].baseAts, null,
      "no recorded score is a THIRD state, distinct from a decline and from a low score");
    assert.equal(pending[0].generationDeferred, false);
  } finally { t.close(); }
});

test("the review detail serves the FULL term lists; the list surface caps them", async () => {
  const t = setup();
  try {
    const matched = Array.from({ length: 30 }, (_, i) => `skill${i}`);
    const runJobId = t.parkDeferred({ baseAts: {
      score: 31, band: ATS_BAND.MODERATE, scorable: true, declineReasons: [],
      matched, missing: [], resumeDepth: null,
    }});
    const { pending } = await t.get("/api/apply/pending");
    assert.equal(pending[0].baseAts.matched.length, 12, "a list row showing 30 terms is not read");
    assert.equal(pending[0].baseAts.matchedCount, 30, "but the true count must still be stated");

    const detail = await t.get(`/api/apply/run-jobs/${runJobId}/review`);
    assert.equal(detail.baseAts.matched.length, 30,
      "the detail screen is where a user checks the number rather than just reading it");
    assert.equal(detail.generationDeferred, true);
  } finally { t.close(); }
});

// ── THE QUEUE CAP ───────────────────────────────────────────────────────────────────────────────

test("the queue cap no longer claims each queued application generates a resume", () => {
  // Requirement 4 said REPORT the cap, do not change it — and the number is unchanged. But its
  // user-facing message asserted a reason that is now false on the deferred path, and a limit that
  // explains itself with a false reason is worse than a bare number.
  const capBlock = applyRoute.slice(at(applyRoute, "error: \"queue_cap_exceeded\""),
                                    at(applyRoute, "error: \"queue_cap_exceeded\"") + 900);
  assert.doesNotMatch(capBlock, /Each queued application generates a resume/,
    "queueing no longer generates anything on the default path");
  assert.match(capBlock, /opened and previewed/);
  assert.match(applyRoute, /APPLY_DAILY_QUEUE_CAP", 40\)/,
    "the LIMIT itself must not have been changed unilaterally — that is the owner's call");
});

test("both caps stay surfaceable in the run payload", () => {
  // Requirement 5. A limit the client cannot render is a limit the user discovers by hitting it.
  const resp = applyRoute.slice(lastAt(applyRoute, "return respond(202, {", at(applyRoute, "queueCap:")),
                                at(applyRoute, "queueCap:") + 400);
  assert.match(resp, /dailyCap: \{ limit:/);
  assert.match(resp, /queueCap:/);
  assert.match(resp, /remaining:/);
});

// ── MIGRATION ───────────────────────────────────────────────────────────────────────────────────

test("migration 097 is byte-identical in both runners and only ADDS", () => {
  const grab = (file) => {
    const s = fs.readFileSync(file, "utf8");
    const i = s.indexOf(`id: "097_generation_deferred_to_approval"`);
    assert.ok(i > 0, `097 missing from ${file}`);
    return s.slice(lastAt(s, "{", i), at(s, "\n    },", i))
      .replace(/\r\n/g, "\n").replace(/^\s+/gm, "");
  };
  const sql = grab("scripts/migrations.js");
  assert.equal(sql, grab("server.js"),
    "the boot-time runner and the CLI runner must apply the same DDL");
  assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\b|\bUPDATE\b/i);
  for (const col of ["generate_at_queue", "base_ats_score", "base_ats_json"]) {
    assert.match(sql, new RegExp(`ADD COLUMN ${col}`), `097 must add ${col}`);
  }
});

test("097 defaults generate_at_queue OFF for every EXISTING profile", async () => {
  // The column is NOT NULL DEFAULT 0, so profiles created before this migration must come out of
  // it with generation deferred — the cheap side. A default of 1 would silently charge every
  // existing user for applications they had not approved.
  const { MIGRATIONS } = await import("../scripts/migrations.js");
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) {
    if (m.id === "097_generation_deferred_to_approval") break;
    db.exec(m.sql);
  }
  db.prepare("INSERT INTO users (id,username,password_hash) VALUES (1,'ada','x')").run();
  // domain_profiles carries NOT NULL columns with no default from earlier migrations; supply the
  // ones the schema requires so this test is about 097 and not about an unrelated insert.
  const cols = db.prepare("PRAGMA table_info(domain_profiles)").all()
    .filter(c => c.notnull && c.dflt_value == null && c.name !== "id");
  const names = cols.map(c => c.name);
  const vals  = cols.map(c => (c.name === "user_id" ? 1 : c.type === "INTEGER" ? 0 : "x"));
  db.prepare(`INSERT INTO domain_profiles (id, ${names.join(",")}) VALUES (5, ${names.map(() => "?").join(",")})`)
    .run(...vals);

  db.exec(MIGRATIONS.find(m => m.id === "097_generation_deferred_to_approval").sql);

  assert.equal(db.prepare("SELECT generate_at_queue FROM domain_profiles WHERE id=5").pluck().get(), 0);
  db.close();
});

// ── THE SURFACES ────────────────────────────────────────────────────────────────────────────────

test("the approval row does NOT read the band off the absent tailored resume", () => {
  // ⛔ THE AJ2 SHAPE, AND THE REASON THIS TEST EXISTS. Job.matchScore was null on every row, and a
  // client implementing the contract exactly as written rendered "Not enough signal" on 100% of
  // jobs. Deferring generation recreates the same setup here: `resume.atsScore` is null on every
  // waiting row, so a panel that bands off it alone prints "No signal" for all of them and the
  // approval screen becomes useless — while looking like a scorer problem.
  const panel = fs.readFileSync("client/src/panels/AutoApplyPanel.jsx", "utf8");
  const row = panel.slice(at(panel, "{p.answerCount} answer"), at(panel, "{p.answerCount} answer") + 700);
  assert.match(row, /p\.generationDeferred/,
    "the row must branch on whether anything has been generated yet");
  assert.match(row, /p\.baseAts\?\.band/, "and read the BASE band when nothing has");
  assert.match(row, /base resume/, "and say which resume the band is of");
});

test("the approval row explains the missing resume and shows the terms behind the band", () => {
  const panel = fs.readFileSync("client/src/panels/AutoApplyPanel.jsx", "utf8");
  assert.match(panel, /approving is what/,
    "an absent Resume PDF button must say WHY — 'not yet' and 'failed' need opposite responses");
  assert.match(panel, /Not yet covered:/,
    "a band nobody can check is a number to be trusted rather than read");
  assert.match(panel, /tailoring can only improve it/,
    "the base band is a FLOOR, and the copy has to say so or it reads as a verdict");
});

test("the generate-at-queue toggle states the COST, not the schedule", () => {
  const panel = fs.readFileSync("client/src/panels/JobProfilesPanel.jsx", "utf8");
  assert.match(panel, /Generate resumes at queue time/);
  // Sits with the other per-profile resume settings, exactly as include_summary does.
  assert.ok(panel.indexOf("Include a summary section") < panel.indexOf("Generate resumes at queue time"),
    "it belongs beside the profile's other resume settings");
  assert.match(panel, /\$0\.04 each, spent whether or not you go on to approve it/,
    "turning this on makes queueing spend money; the copy must say that, not describe timing");
  assert.match(panel, /Queueing is free/);
});

// ── THE COMPLETENESS GATE ───────────────────────────────────────────────────────────────────────

test("a deferred document is excluded from the completeness gate, but not from the record", () => {
  // ⛔ FOUND BY scripts/al2GenerationDeferral.mjs, NOT BY ANY UNIT TEST. A deferred preview reaches
  // the form with no resume ON PURPOSE. The gate checks required FILE inputs (A1 finding N2 — a
  // form with no resume used to pass and then be silently unsubmittable), so the row held as
  // 'incomplete_form' instead of 'awaiting_approval'. Only 'awaiting_approval' rows are
  // approvable, so EVERY deferred preview was a dead end and the whole flow was broken — while the
  // run history blamed the employer's form.
  const auto = fs.readFileSync("services/applyAutomation.js", "utf8");
  const gate = auto.slice(at(auto, "const deferredDoc ="), at(auto, "const missingRequired ="));
  assert.match(gate, /documentsDeferred && f\.type === 'file'/,
    "the exemption must be scoped to FILE inputs — every other required field is still the " +
    "candidate's to answer and must still hold the run");
  // It must be OPT-IN. A default-on exemption would silently restore the pre-A1 defect, where a
  // form with no resume passed the gate and the browser then refused to submit it.
  assert.match(auto, /documentsDeferred\s*=\s*false/,
    "the flag must default to false, or a normal run stops checking for a missing resume");
  // And the blanks are still built from the UNFILTERED field list, so nothing is hidden.
  assert.match(auto, /blanks:\s*buildBlanks\(\{ fields: postFillFields/,
    "the excluded fields must still be reported — excluded from the GATE, not from the record");
});

test("only the deferred preview sets documentsDeferred", () => {
  const setters = [...applyRoute.matchAll(/documentsDeferred:\s*true/g)];
  assert.equal(setters.length, 1,
    "exactly one call site may claim its documents are deferred: the preview that deferred them");
  // And it is inside CASE D.
  assert.ok(setters[0].index > at(applyRoute, "CASE D:") &&
            setters[0].index < at(applyRoute, "CASE C: no artifact"),
    "documentsDeferred is set outside the deferred branch — an approved run must carry a real resume");
});
