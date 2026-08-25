import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { artifactCurrency, currencySentence, modeForTool } from "../services/resumeCurrency.js";
import { buildBlanks } from "../services/applyAutomation.js";

/**
 * TASK AH5 — reuse what already exists, and say what was filled.
 *
 * The end-to-end proof is scripts/ah5ReuseAndFillLog.mjs, which drives the real route and a real
 * browser and counts the generator's own invocations. These pin the two rules it depends on.
 *
 * WHAT THE DIAGNOSIS FOUND, which is not what the report assumed: queueing a job that already has a
 * resume does NOT regenerate it, and never did — CASE A has always reused. What it lacked was any
 * notion of whether the stored artifact was still the RIGHT one, and generateResumeForApply ran a
 * second, differently-written query for the same decision. So the real defect was the opposite of
 * the reported one: an artifact built for another job profile, or from a base resume the candidate
 * had since replaced, went to an employer with nothing saying so.
 */

function dbWith({ artifactProfile = 10, activeProfile = 10, baseUpdated = 1000, artifactUpdated = 2000,
                  applyMode = "TAILORED", html = "<html>x</html>" } = {}) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE resumes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, job_id TEXT,
      apply_mode TEXT, ats_score INTEGER, html TEXT, domain_profile_id INTEGER, updated_at INTEGER);
    CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, is_active INTEGER DEFAULT 0);
    CREATE TABLE profile_base_resumes (profile_id INTEGER PRIMARY KEY, user_id INTEGER, updated_at INTEGER);
  `);
  db.prepare("INSERT INTO domain_profiles (id,user_id,is_active) VALUES (10,1,?)").run(activeProfile === 10 ? 1 : 0);
  db.prepare("INSERT INTO domain_profiles (id,user_id,is_active) VALUES (11,1,?)").run(activeProfile === 11 ? 1 : 0);
  db.prepare("INSERT INTO profile_base_resumes (profile_id,user_id,updated_at) VALUES (?,1,?)")
    .run(activeProfile, baseUpdated);
  if (html) {
    db.prepare(`INSERT INTO resumes (user_id,job_id,apply_mode,ats_score,html,domain_profile_id,updated_at)
                VALUES (1,'j1',?,84,?,?,?)`).run(applyMode, html, artifactProfile, artifactUpdated);
  }
  return db;
}
const currency = (db, tool = "generate") => artifactCurrency(db, { userId: 1, jobId: "j1", tool });

// ── the currency rule ────────────────────────────────────────────────────────────────────────

test("an artifact for this job, tool and profile, newer than the base resume, is current", () => {
  const r = currency(dbWith());
  assert.equal(r.current, true);
  assert.equal(r.reason, "reused");
  assert.match(currencySentence(r), /nothing was regenerated/);
});

test("no artifact is not an error — it is the ordinary first run", () => {
  const r = currency(dbWith({ html: null }));
  assert.equal(r.current, false);
  assert.equal(r.reason, "no_artifact");
  assert.match(currencySentence(r), /No resume existed for this job yet/);
});

test("a different TOOL invalidates it", () => {
  // A Generate artifact is not an A+ Resume artifact, and sending one where the other was asked
  // for is a silent substitution.
  const r = currency(dbWith(), "a_plus_resume");
  assert.equal(r.current, false);
  assert.equal(r.reason, "different_tool");
  assert.equal(modeForTool("a_plus_resume"), "CUSTOM_SAMPLER");
  assert.equal(modeForTool("generate"), "TAILORED");
});

test("a different PROFILE invalidates it", () => {
  const r = currency(dbWith({ artifactProfile: 11, activeProfile: 10 }));
  assert.equal(r.current, false);
  assert.equal(r.reason, "different_profile");
  assert.match(r.detail, /built for job profile 11/);
});

test("a base resume edited AFTER the artifact invalidates it", () => {
  // The candidate rewriting their base resume is them saying "this is who I am now". An artifact
  // built before that no longer reflects it, and reusing it silently is the worse failure.
  const r = currency(dbWith({ artifactUpdated: 1000, baseUpdated: 5000 }));
  assert.equal(r.current, false);
  assert.equal(r.reason, "base_resume_changed");
  assert.match(currencySentence(r), /base resume was edited after/);
});

test("an artifact generated at the same moment as the base-resume edit is still current", () => {
  // The comparison is `<`, not `<=`. A generation triggered BY the edit lands on the same second,
  // and treating that as stale would regenerate every artifact immediately after every edit.
  const r = currency(dbWith({ artifactUpdated: 3000, baseUpdated: 3000 }));
  assert.equal(r.current, true);
});

test("an artifact from before migration 091 is usable, and says its provenance is unverified", () => {
  // The alternative is regenerating every artifact in the database on the next queue — a real cost
  // imposed to fix a record-keeping gap.
  const r = currency(dbWith({ artifactProfile: null }));
  assert.equal(r.current, true);
  assert.equal(r.reason, "reused_unknown_profile");
  assert.match(currencySentence(r), /job profile was not recorded/);
});

test("an un-migrated database degrades instead of refusing to apply", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE resumes (id INTEGER PRIMARY KEY, user_id INTEGER, job_id TEXT,
             apply_mode TEXT, ats_score INTEGER, html TEXT, updated_at INTEGER);`);
  db.prepare("INSERT INTO resumes VALUES (1,1,'j1','TAILORED',80,'<p>x</p>',2000)").run();
  const r = artifactCurrency(db, { userId: 1, jobId: "j1", tool: "generate" });
  assert.equal(r.current, true, "a missing column must not stop an application");
  assert.equal(r.reason, "reused_unknown_profile");
});

test("the tool -> apply_mode mapping has exactly one definition", () => {
  // Two copies would drift the first time a third tool is added, and the currency rule would then
  // quietly stop matching anything.
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /function legacyModeForTool\(tool\) \{\s*\n\s*return modeForTool\(tool\);/);
  assert.doesNotMatch(server, /function legacyModeForTool[\s\S]{0,120}a_plus_resume" \? "CUSTOM_SAMPLER"/);
});

test("both reuse sites go through the one rule, so they cannot drift apart again", () => {
  const route = fs.readFileSync("routes/apply.js", "utf8");
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(route, /import \{ artifactCurrency, currencySentence \} from "\.\.\/services\/resumeCurrency\.js"/);
  assert.match(server, /import \{ artifactCurrency, currencySentence, modeForTool \} from "\.\/services\/resumeCurrency\.js"/);
  assert.match(route, /const currency = artifactCurrency\(db, \{ userId, jobId, tool: toolType \}\)/);
  assert.match(server, /const currency = artifactCurrency\(db, \{ userId, jobId, tool \}\)/);
  // The second, rule-less query CASE A used to run must be gone.
  assert.doesNotMatch(route,
    /SELECT id, ats_score, html FROM resumes WHERE user_id=\? AND job_id=\? ORDER BY updated_at DESC/);
});

test("the decision is logged either way — reuse is a claim the run makes out loud", () => {
  const route = fs.readFileSync("routes/apply.js", "utf8");
  assert.match(route, /currency\.current \? "resume_reused" : "resume_regenerating"/);
  assert.match(route, /currencySentence\(currency\)/);
});

// ── the fill log's blank half ────────────────────────────────────────────────────────────────

const field = (over = {}) => ({ field_id: "f", name: "f", label: "F", type: "text",
  is_required: false, current_value: "", ...over });

test("a filled field is not a blank", () => {
  const blanks = buildBlanks({ fields: [field({ current_value: "Ada" })], resolvedAnswers: [] });
  assert.deepEqual(blanks, []);
});

test("a refusal reads as low confidence, and carries what the policy objected to", () => {
  const blanks = buildBlanks({
    fields: [field({ field_id: "s", label: "Sponsorship?" })],
    resolvedAnswers: [{ field_id: "s", skipped: true, refusals: ["sponsorship:unknown_sponsorship_need"] }],
  });
  assert.equal(blanks[0].reason, "low_confidence");
  assert.match(blanks[0].detail, /unknown_sponsorship_need/);
});

test("a declined guess reads as low confidence too — both are the policy saying no", () => {
  const blanks = buildBlanks({
    fields: [field({ field_id: "g", label: "Guessy" })],
    resolvedAnswers: [],
    rejectedAnswers: [{ field: "Guessy", provenance: "label_fuzzy", confidence: 0.4 }],
  });
  assert.equal(blanks[0].reason, "low_confidence");
  assert.match(blanks[0].detail, /declined a label_fuzzy guess \(confidence 0\.4\)/);
});

test("an ELIGIBILITY question says only you can answer it", () => {
  // buildAnswers emits nothing at all for an eligibility field the profile cannot answer — no
  // value and no refusal — so without this these fell through to "we did not recognise the field".
  // Measured on the fixture form, that mislabelled both of Greenhouse's eligibility questions.
  for (const label of [
    "Do you now or in the future require sponsorship for work authorization?",
    "Are you legally authorized to work in the country of employment?",
  ]) {
    const [b] = buildBlanks({ fields: [field({ label, is_required: true })], resolvedAnswers: [] });
    assert.equal(b.reason, "needs_you", label);
    assert.match(b.detail, /only you can answer this/);
  }
});

test("a field the resolver never saw is unmatched; one it saw and could not fill is not", () => {
  const [unmatched] = buildBlanks({ fields: [field({ field_id: "x", label: "Mystery" })], resolvedAnswers: [] });
  assert.equal(unmatched.reason, "unmatched");

  const [noAnswer] = buildBlanks({
    fields: [field({ field_id: "y", label: "Portfolio" })],
    resolvedAnswers: [{ field_id: "y", skipped: true }],
  });
  assert.equal(noAnswer.reason, "no_answer");

  // The resolver had a value, policy allowed it, and the field is STILL empty. That is our bug
  // rather than the candidate's missing data, and folding it into no_answer would hide it in the
  // one record built to expose it.
  const [failed] = buildBlanks({
    fields: [field({ field_id: "z", label: "Phone" })],
    resolvedAnswers: [{ field_id: "z", value: "+1 555", provenance: "field_map_exact" }],
  });
  assert.equal(failed.reason, "fill_failed");
});

test("OPTIONAL blanks are in the record — the gates only ever look at required ones", () => {
  // This is what makes the log the form's actual state rather than a gate's opinion of it.
  const blanks = buildBlanks({
    fields: [field({ field_id: "a", label: "Salary", is_required: false }),
             field({ field_id: "b", label: "Name", is_required: true })],
    resolvedAnswers: [],
  });
  assert.equal(blanks.length, 2);
  assert.deepEqual(blanks.map(b => b.required), [false, true]);
});

test("both run paths emit blanks, and the audit persists them", () => {
  const automation = fs.readFileSync("services/applyAutomation.js", "utf8");
  // The unattended completeness gate...
  assert.match(automation, /blanks:\s+buildBlanks\(\{ fields: postFillFields, resolvedAnswers, rejectedAnswers \}\)/);
  // ...and semi, which is the mode this task is about.
  assert.match(automation, /semiBlanks\s+= buildBlanks\(\{ fields: semiFields, resolvedAnswers, rejectedAnswers \}\)/);
  const route = fs.readFileSync("routes/apply.js", "utf8");
  assert.match(route, /"blanks_json",/);
  assert.equal((route.match(/blanks_json: Array\.isArray\(result\.blanks\)/g) || []).length, 2,
    "both the semi audit and the main audit must write it");
});

test("the fill log composes what is already stored and keeps nothing of its own", () => {
  const route = fs.readFileSync("routes/apply.js", "utf8");
  const ep = route.slice(route.indexOf('app.get("/api/apply/run-jobs/:runJobId/fill-log"'));
  assert.match(ep, /parseJson\(rj\.answers_json, \[\]\)/);
  assert.match(ep, /parseJson\(rj\.blanks_json, null\)/);
  assert.match(ep, /parseJson\(rj\.corrections_json, \[\]\)/);
  // null and [] are different answers: "we never looked at the form" vs "nothing is empty".
  assert.match(ep, /blanks,/);
  assert.doesNotMatch(ep.slice(0, ep.indexOf("res.json")), /INSERT INTO|UPDATE /);
});

test("the hold NAMES its missing fields, on the row the panel already renders", () => {
  const route = fs.readFileSync("routes/apply.js", "utf8");
  // Twice: on the per-attempt review, and on publicRunJob, so the panel needs no second request.
  assert.equal((route.match(/\.filter\(b => b\?\.required\)\.map\(b => b\.label \|\| b\.field\)/g) || []).length, 2);
  const sections = fs.readFileSync("client/src/panels/AutoApplyPanelSections.jsx", "utf8");
  assert.match(sections, /job\.missingRequired\?\.length > 0/);
  assert.match(sections, /Still yours to answer/);
});

test("the fill log is fetched ON REQUEST, not with every row", () => {
  const sections = fs.readFileSync("client/src/panels/AutoApplyPanelSections.jsx", "utf8");
  assert.match(sections, /function FillLog\(\{ runJobId, theme \}\)/);
  assert.match(sections, /status: "idle"/);
  assert.match(sections, /api\(`\/api\/apply\/run-jobs\/\$\{runJobId\}\/fill-log`\)/);
  assert.match(sections, /What was filled/);
  // Every reason the record can carry needs words a human reads.
  for (const r of ["low_confidence", "needs_you", "no_answer", "unmatched", "fill_failed"]) {
    assert.match(sections, new RegExp(`${r}:`), r);
  }
});

test("migration 091 is byte-identical in both migration sources", () => {
  const grab = (file) => {
    const s = fs.readFileSync(file, "utf8");
    const i = s.indexOf("091_fill_log_and_artifact_provenance");
    return s.slice(s.lastIndexOf("    {", i), s.indexOf("    },", i) + 6);
  };
  assert.equal(grab("server.js"), grab("scripts/migrations.js"));
  assert.match(grab("server.js"), /ALTER TABLE apply_run_jobs ADD COLUMN blanks_json TEXT/);
  assert.match(grab("server.js"), /ALTER TABLE resumes ADD COLUMN domain_profile_id INTEGER/);
});

test("the artifact records which profile built it, or the rule has nothing to check", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /INSERT INTO resumes \(user_id,job_id,company,role,category,apply_mode,html,ats_score,ats_report,ats_cache_key,ats_prompt_version,domain_profile_id/);
  assert.match(server, /domain_profile_id=excluded\.domain_profile_id/);
  assert.match(server, /activeDomainProfile\?\.id \?\? null/);
});
