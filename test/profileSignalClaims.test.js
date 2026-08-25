// AG2 — the candidate claiming a suggested ATS keyword, against a real database.
//
// The contract tests in localAtsScorer.test.js read source text and can prove the wiring exists.
// They cannot prove a claim survives a reload, that withdrawing it actually withdraws it, or that
// an auto-ingested suggestion does not read as something the user said. Those are statements about
// rows, so this builds the real schema in memory and exercises the real functions.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  CLAIM_STATUSES,
  addProfileSignalSuggestions,
  listProfileClaims,
  listProfileSignalSuggestions,
  setProfileSignalClaim,
} from "../services/profileSignalAggregator.js";

/** The two tables the claim path touches, exactly as migration 052 and 013 define them. */
function freshDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE domain_profiles (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_name TEXT,
      target_titles JSON NOT NULL DEFAULT '[]',
      selected_keywords JSON NOT NULL DEFAULT '[]',
      selected_verbs JSON NOT NULL DEFAULT '[]',
      selected_tools JSON NOT NULL DEFAULT '[]',
      updated_at INTEGER
    );
    CREATE TABLE profile_signal_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES domain_profiles(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      signal_key TEXT NOT NULL,
      signal_label TEXT NOT NULL,
      signal_kind TEXT NOT NULL,
      structured_field TEXT,
      frequency INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'inactive',
      first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      selected_at INTEGER,
      applied_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(profile_id, signal_key)
    );
    INSERT INTO users (id) VALUES (7), (8);
    INSERT INTO domain_profiles (id, user_id, profile_name) VALUES (1, 7, 'Backend'), (2, 7, 'Data');
  `);
  return db;
}

const ctx = { userId: 7, profileId: 1 };

test("AG2: a claim persists, and reading it back is the same answer", () => {
  const db = freshDb();
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });

  // A fresh read — the equivalent of a reload — sees it.
  const reloaded = listProfileSignalSuggestions(db, ctx);
  assert.deepEqual(reloaded.claimedSkills.map(s => s.label), ["Kubernetes"]);
  assert.equal(reloaded.claimedSkills[0].status, "claimed");
  assert.deepEqual(listProfileClaims(db, ctx), { skills: ["Kubernetes"], actionVerbs: [] });
});

test("AG2: three claims persist together, skills and verbs alike", () => {
  const db = freshDb();
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Terraform" });
  // Verbs were unclaimable before AG2 — syncSelectedSkillSuggestions filters to signal_kind='skill'
  // and ProfilePanel rendered inactive verbs as a non-interactive span.
  setProfileSignalClaim(db, { ...ctx, kind: "action_verb", label: "Architected" });

  const claims = listProfileClaims(db, ctx);
  assert.deepEqual(claims.skills, ["Kubernetes", "Terraform"]);
  assert.deepEqual(claims.actionVerbs, ["Architected"]);
});

test("AG2: a claim is scoped to its profile and does not follow a profile switch", () => {
  const db = freshDb();
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });

  const other = listProfileClaims(db, { userId: 7, profileId: 2 });
  assert.deepEqual(other, { skills: [], actionVerbs: [] });
  // ...and switching back finds it unchanged.
  assert.deepEqual(listProfileClaims(db, ctx).skills, ["Kubernetes"]);
});

test("AG2: a claim can be withdrawn, and withdrawing keeps the history", () => {
  const db = freshDb();
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });
  const after = setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes", claimed: false });

  assert.deepEqual(after.claimedSkills, []);
  assert.deepEqual(listProfileClaims(db, ctx).skills, []);
  // The row survives as what it was before the user touched it — the frequency history the system
  // gathered is not the user's to lose by changing their mind.
  const row = db.prepare("SELECT status, selected_at FROM profile_signal_suggestions WHERE signal_label='Kubernetes'").get();
  assert.equal(row.status, "inactive");
  assert.equal(row.selected_at, null);
});

test("AG2: a system-suggested term is NOT a claim until the candidate says so", () => {
  const db = freshDb();
  // What scrape-time aggregation does, unprompted, with no user involvement.
  addProfileSignalSuggestions(db, { ...ctx, kind: "skill", labels: ["GraphQL", "Rust"] });

  const listed = listProfileSignalSuggestions(db, ctx);
  assert.equal(listed.claimedSkills.length, 0, "nothing may be pre-selected");
  assert.deepEqual(listed.inactiveSkills.map(s => s.label).sort(), ["GraphQL", "Rust"]);
  assert.deepEqual(listProfileClaims(db, ctx), { skills: [], actionVerbs: [] });

  // The candidate then claims one of them, and only that one becomes a claim.
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Rust" });
  const after = listProfileSignalSuggestions(db, ctx);
  assert.deepEqual(after.claimedSkills.map(s => s.label), ["Rust"]);
  assert.deepEqual(after.inactiveSkills.map(s => s.label), ["GraphQL"]);
});

test("AG2: claiming does not write the profile's scored term lists", () => {
  const db = freshDb();
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });
  setProfileSignalClaim(db, { ...ctx, kind: "action_verb", label: "Architected" });

  // buildRuntimeAtsBasis folds selected_tools/selected_keywords into the text the report scores the
  // resume against. A claim landing there would raise the candidate's own score on their say-so,
  // which is the "tick this to go up" incentive the feature must not create.
  const profile = db.prepare("SELECT selected_tools, selected_verbs, selected_keywords FROM domain_profiles WHERE id=1").get();
  assert.equal(profile.selected_tools, "[]");
  assert.equal(profile.selected_verbs, "[]");
  assert.equal(profile.selected_keywords, "[]");
});

test("AG2: a claim on a term seen only once is still shown", () => {
  const db = freshDb();
  // frequency 1 is below ATS_SIGNAL_PROMOTION_THRESHOLD, which decides whether the system is
  // confident enough to SUGGEST. It has no business hiding an answer the candidate gave.
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });
  db.prepare("UPDATE profile_signal_suggestions SET frequency = 1 WHERE signal_label='Kubernetes'").run();

  assert.deepEqual(listProfileSignalSuggestions(db, ctx).claimedSkills.map(s => s.label), ["Kubernetes"]);
});

test("AG2: a term applied through the old one-way path still reads as a claim", () => {
  const db = freshDb();
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });
  db.prepare("UPDATE profile_signal_suggestions SET status='applied' WHERE signal_label='Kubernetes'").run();

  // It was the user clicking an ATS chip, which was them asserting the skill just the same.
  assert.ok(CLAIM_STATUSES.has("applied"));
  assert.deepEqual(listProfileClaims(db, ctx).skills, ["Kubernetes"]);

  // But it is not withdrawable here: it also lives in domain_profiles.selected_tools, and removing
  // it from only one of the two stores would leave them disagreeing.
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes", claimed: false });
  assert.deepEqual(listProfileClaims(db, ctx).skills, ["Kubernetes"]);
});

test("AG2: an empty or whitespace label is not a claim", () => {
  const db = freshDb();
  for (const label of ["", "   ", null, undefined]) {
    setProfileSignalClaim(db, { ...ctx, kind: "skill", label });
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM profile_signal_suggestions").get().n, 0);
});

test("AG2: claiming the same term twice is idempotent", () => {
  const db = freshDb();
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });
  const first = db.prepare("SELECT selected_at FROM profile_signal_suggestions WHERE signal_label='Kubernetes'").get();
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });

  assert.equal(db.prepare("SELECT COUNT(*) n FROM profile_signal_suggestions").get().n, 1);
  const second = db.prepare("SELECT selected_at FROM profile_signal_suggestions WHERE signal_label='Kubernetes'").get();
  assert.equal(second.selected_at, first.selected_at, "the original claim time is kept");
});
