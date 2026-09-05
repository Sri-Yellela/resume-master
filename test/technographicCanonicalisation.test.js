// G3 — canonicalising the company stack layer.
//
// WHAT WAS DILUTED, MEASURED: 412 of company_technographics' 8690 rows are the same skill for the
// same company under a different spelling. OpenAI stores "Infrastructure-as-Code" SIX ways. Each
// row carries a fraction of the evidence, so the stack ranks every fragment below skills that
// happen to have one spelling — which is what FE-4's STACK block renders.
//
// ⛔ AND IT IS NOT THE DILUTION THE TASK PREDICTED. G3's example was "Postgres" vs "PostgreSQL".
// Measured: `postgres`, `k8s` and `js` are ABSENT from this corpus — only the canonical spellings
// appear, because enrichJob's extraction already emits them. The real dilution is CASE AND
// PUNCTUATION, which needs no synonym table at all: normalisation alone accounts for 386 of the
// 412, and G1's confirmed synonyms for the remaining 26.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { canonicalSkillKey, mergeStackRows } from "../services/kb/technographics.js";
import { normaliseAtsTerm } from "../services/localAtsScorer.js";

const row = (skill, weight, posting_count = 1, last_seen = 1000) =>
  ({ company: "Acme", skill, weight, posting_count, last_seen });

// ── THE KEY ─────────────────────────────────────────────────────────────────────────────────────

test("case and punctuation variants collapse without any synonym table", () => {
  // The six real OpenAI spellings. This is 386 of the 412 merges and it costs nothing.
  const spellings = ["Infrastructure-as-Code", "infrastructure-as-code", "Infrastructure as code",
                     "Infrastructure as Code", "Infrastructure-as-code", "infrastructure as code"];
  const keys = new Set(spellings.map(s => canonicalSkillKey(s)));
  assert.equal(keys.size, 1, `six spellings produced ${keys.size} keys: ${[...keys].join(" | ")}`);
});

test("plural variants collapse too", () => {
  assert.equal(canonicalSkillKey("code review"), canonicalSkillKey("code reviews"));
  assert.equal(canonicalSkillKey("data pipeline"), canonicalSkillKey("data pipelines"));
});

test("a confirmed synonym merges what normalisation cannot", () => {
  const syn = new Map([["mentoring", ["mentorship"]], ["mentorship", ["mentoring"]]]);
  assert.notEqual(canonicalSkillKey("mentoring"), canonicalSkillKey("mentorship"),
    "these are different words — normalisation alone must NOT merge them");
  assert.equal(canonicalSkillKey("mentoring", syn), canonicalSkillKey("mentorship", syn));
});

test("the key does not depend on which variant is seen first", () => {
  // Resolved to the lexicographically smallest member. Encounter-order assignment would make the
  // same company's stack collapse differently depending on row order.
  const syn = new Map([["mentoring", ["mentorship"]], ["mentorship", ["mentoring"]]]);
  assert.equal(canonicalSkillKey("mentorship", syn), canonicalSkillKey("mentoring", syn));
});

test("⛔ synonym expansion is ONE HOP here too", () => {
  // a~b and b~c must not merge a and c. Chaining would collapse terms no reviewer ever compared,
  // and a merged stack entry is a claim about what a company works on.
  const syn = new Map([
    ["alpha", ["beta"]],
    ["beta", ["alpha", "gamma"]],
    ["gamma", ["beta"]],
  ]);
  assert.notEqual(canonicalSkillKey("alpha", syn), canonicalSkillKey("gamma", syn));
});

test("it reuses the scorer's normaliser rather than defining a second one", () => {
  // Requirement 1: build once, use twice. A separate vocabulary here would let a company's stack
  // and a candidate's match disagree about what a skill is.
  assert.equal(canonicalSkillKey("Code Reviews"), normaliseAtsTerm("Code Reviews"));
  const src = fs.readFileSync("services/kb/technographics.js", "utf8");
  assert.match(src, /import \{ normaliseAtsTerm \}/);
  assert.ok(!/function normalise[A-Z]/.test(src), "no second normaliser may be defined here");
});

// ── REQUIREMENT 3: CONFIDENCE IS THE MERGED EVIDENCE ────────────────────────────────────────────

test("⛔ weight SUMS across variants — it is not the strongest variant's", () => {
  // Requirement 3, and it is the whole point. Six spellings seen once each are six postings' worth
  // of evidence; taking the MAX would report one, which is the dilution this exists to fix moved
  // one level up.
  const merged = mergeStackRows([
    row("Infrastructure-as-Code", 3), row("infrastructure as code", 2), row("Infrastructure as Code", 1),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].weight, 6, "3 + 2 + 1, not max(3,2,1)");
});

test("posting_count sums and last_seen takes the most recent", () => {
  const merged = mergeStackRows([
    row("code review", 1, 4, 500), row("Code Reviews", 1, 7, 900),
  ]);
  assert.equal(merged[0].postingCount, 11);
  assert.equal(merged[0].lastSeen, 900, "the freshest sighting governs decay, not the oldest");
});

test("provenance survives: every variant that was merged is reported", () => {
  // A merged row is a claim about a company. The surface has to be able to disclose what was
  // collapsed rather than presenting six postings' evidence as one tidy entry.
  const merged = mergeStackRows([row("Problem-solving", 2), row("problem solving", 1)]);
  assert.deepEqual(merged[0].variants, ["Problem-solving", "problem solving"]);
});

test("the DISPLAY name is the heaviest variant's own spelling, not the key", () => {
  // The key is lowercased and stemmed, so rendering it would print "infrastructure as code" and
  // turn "code reviews" into "code review" on the company card.
  const merged = mergeStackRows([row("infrastructure as code", 1), row("Infrastructure as Code", 5)]);
  assert.equal(merged[0].skill, "Infrastructure as Code");
  assert.equal(merged[0].key, normaliseAtsTerm("Infrastructure as Code"));
});

test("the display name is stable when weights tie", () => {
  // Ties break on the raw string, so the company card does not change wording between runs for no
  // reason. The two spellings must be genuine VARIANTS — the first version of this test used two
  // unrelated strings, which land in different groups and made the assertion vacuous.
  const a = mergeStackRows([row("code review", 2), row("Code Review", 2)]);
  const b = mergeStackRows([row("Code Review", 2), row("code review", 2)]);
  assert.equal(a.length, 1, "these must be one group, or the test is not testing a tie");
  assert.equal(a[0].skill, b[0].skill);
});

// ── THE ROWS THEMSELVES ARE NOT TOUCHED ─────────────────────────────────────────────────────────

test("⛔ nothing writes a merge back into company_technographics", () => {
  // The board that produced this table was deleted by retention (cleanup_log id 85), so
  // skills_json survives on 5 postings and the table CANNOT BE REBUILT. The raw variants are now
  // the only record of what each posting said. Merging in place would trade irreplaceable
  // provenance for a display fix.
  for (const f of ["services/kb/technographics.js", "services/kb/companyProfile.js"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(!/(INSERT INTO|UPDATE|DELETE FROM)\s+company_technographics/i.test(src),
      `${f} must not write the stack table — the merge is a read-time concern`);
  }
});

test("the write path de-dups on the CANONICAL key, so no NEW variants accumulate", () => {
  // This is where the 412 came from: the de-dup keyed on the exact spelling, so one posting listing
  // both "problem-solving" and "problem solving" incremented two rows AND counted itself twice.
  const src = fs.readFileSync("services/jobs/enrichJob.js", "utf8");
  assert.match(src, /const key = canonicalSkillKey\(skill, synonyms\)/);
  assert.match(src, /seen\.has\(key\)/);
  // But the RAW spelling is still what is stored — it is the provenance.
  assert.match(src, /upsertStmt\.run\(\{ company, skill,/,
    "the stored skill must remain the raw one; only the de-dup decision is canonical");
});

// ── THE SURFACE ─────────────────────────────────────────────────────────────────────────────────

test("getStack merges, and the posting floor is computed over merged groups", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE company_technographics (company TEXT, skill TEXT, weight REAL, last_seen INTEGER, posting_count INTEGER);
    CREATE TABLE company_org_units (company TEXT, org_unit TEXT, confidence REAL, status TEXT);
    CREATE TABLE company_hiring_signals (company TEXT);
  `);
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare("INSERT INTO company_technographics VALUES (?,?,?,?,?)");
  ins.run("Acme", "Infrastructure-as-Code", 3, now, 3);
  ins.run("Acme", "infrastructure as code", 2, now, 2);
  ins.run("Acme", "Python", 4, now, 4);

  const merged = mergeStackRows(
    db.prepare("SELECT skill, weight, last_seen, posting_count FROM company_technographics WHERE company='Acme'").all());
  assert.equal(merged.length, 2, "the two IaC spellings are one skill");
  const iac = merged.find(m => /infrastructure/i.test(m.skill));
  assert.equal(iac.weight, 5, "3 + 2 — which now OUTRANKS Python at 4");
  assert.equal(Math.max(...merged.map(m => m.postingCount)), 5,
    "the floor rises with the merge: at least 5 postings contributed, not 4");
  db.close();
});

test("the stack surface discloses a merge rather than hiding it", () => {
  const src = fs.readFileSync("services/kb/companyProfile.js", "utf8");
  assert.match(src, /mergedFrom/, "a merged entry must be able to say what it merged");
  assert.match(src, /mergeStackRows/);
  assert.match(src, /loadConfirmedSynonyms/, "CONFIRMED only — proposals must not reach a KB surface");
});
