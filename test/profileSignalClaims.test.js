// AG2 — the candidate claiming a suggested ATS keyword, against a real database.
//
// The contract tests in localAtsScorer.test.js read source text and can prove the wiring exists.
// They cannot prove a claim survives a reload, that withdrawing it actually withdraws it, or that
// an auto-ingested suggestion does not read as something the user said. Those are statements about
// rows, so this builds the real schema in memory and exercises the real functions.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../scripts/migrations.js";
import {
  CLAIM_ASSERTIONS,
  addProfileSignalSuggestions,
  buildSelectedEnhancementSkills,
  listProfileClaims,
  listProfileSignalSuggestions,
  setProfileSignalClaim,
  syncSelectedSkillSuggestions,
} from "../services/profileSignalAggregator.js";

/**
 * The real schema, built by RUNNING THE MIGRATIONS.
 *
 * This used to hand-write the two tables "exactly as migration 052 and 013 define them" — which
 * they did, right up until migration 089 split `status` into queue_state and assertion. Then the
 * copy described a table the product no longer has, and these tests would have gone on passing
 * against a schema that existed nowhere else. A transcribed schema is a second source of truth that
 * only looks correct on the day it is written.
 */
function freshDb() {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  db.exec(`
    INSERT INTO users (id, username, password_hash) VALUES (7, 'fixture7', 'x'), (8, 'fixture8', 'x');
    INSERT INTO domain_profiles (id, user_id, profile_name, role_family, domain)
      VALUES (1, 7, 'Backend', 'engineering', 'software'), (2, 7, 'Data', 'data', 'analytics');
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

test("CC4: a term APPLIED through the old one-way path is now withdrawable", () => {
  // ⛔ THIS TEST ASSERTED THE OPPOSITE UNTIL CC4, and it was honest about why: "it is not
  // withdrawable here: it also lives in domain_profiles.selected_tools, and removing it from only
  // one of the two stores would leave them disagreeing."
  //
  // That was an acknowledged omission whose effect was a ONE-WAY DOOR on the user's own assertion
  // about themselves — the one thing this feature must not have. Requirement 5 says to fix it as
  // part of unifying the stores, and unifying them is what makes it fixable: the withdrawal now
  // removes the term from BOTH, in one transaction, so the disagreement the old comment feared
  // cannot happen. The test asserts that consequence, not just the withdrawal.
  const db = freshDb();
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });
  db.prepare("UPDATE profile_signal_suggestions SET assertion='applied', status='applied' WHERE signal_label='Kubernetes'").run();
  // The legacy store, as the old 'applied' path would have left it.
  db.prepare("UPDATE domain_profiles SET selected_tools = ?, selected_keywords = ? WHERE id = ?")
    .run(JSON.stringify(["Kubernetes", "Terraform"]), JSON.stringify(["kubernetes"]), ctx.profileId);

  // It was the user clicking an ATS chip, which was them asserting the skill just the same.
  assert.ok(CLAIM_ASSERTIONS.has("applied"));
  assert.deepEqual(listProfileClaims(db, ctx).skills, ["Kubernetes"]);

  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes", claimed: false });

  assert.deepEqual(listProfileClaims(db, ctx).skills, [],
    "an applied term must be withdrawable — an assertion the user cannot take back is a trap");

  // ⛔ AND BOTH STORES MOVED. This is the half the old comment was protecting: if the canonical
  // store says "withdrawn" while buildRuntimeAtsBasis keeps folding selected_* into the scored
  // text, the withdrawal silently does not work.
  const row = db.prepare("SELECT selected_tools, selected_keywords FROM domain_profiles WHERE id = ?").get(ctx.profileId);
  assert.deepEqual(JSON.parse(row.selected_tools), ["Terraform"],
    "the withdrawn term must leave the legacy list, and nothing else may leave with it");
  assert.deepEqual(JSON.parse(row.selected_keywords), [],
    "matched on the normalised key, so a different spelling in the legacy store is still pruned");
});

test("CC4: withdrawal prunes the legacy list by NORMALISED key, not by raw label", () => {
  // The two stores were written by different paths and do not agree on spelling or case, so an
  // exact-string prune would leave the term scoring after it was withdrawn.
  const db = freshDb();
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "CI/CD" });
  db.prepare("UPDATE domain_profiles SET selected_tools = ? WHERE id = ?")
    .run(JSON.stringify(["ci/cd", "Docker"]), ctx.profileId);

  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "CI/CD", claimed: false });
  const tools = JSON.parse(db.prepare("SELECT selected_tools FROM domain_profiles WHERE id = ?").get(ctx.profileId).selected_tools);
  assert.deepEqual(tools, ["Docker"]);
});

test("CC4: withdrawing something never claimed touches neither store", () => {
  const db = freshDb();
  db.prepare("UPDATE domain_profiles SET selected_tools = ? WHERE id = ?")
    .run(JSON.stringify(["Kubernetes"]), ctx.profileId);
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes", claimed: false });
  // No assertion row existed, so nothing was withdrawn and the legacy list is NOT pruned — the
  // prune is a consequence of a withdrawal, not an independent delete.
  const tools = JSON.parse(db.prepare("SELECT selected_tools FROM domain_profiles WHERE id = ?").get(ctx.profileId).selected_tools);
  assert.deepEqual(tools, ["Kubernetes"],
    "a no-op withdrawal must not quietly edit the legacy store");
});

// ── Migration 089: the two axes are independent ─────────────────────────────────────────────────
//
// The whole point of splitting `status` is that a row can now be queued for the enhancement rewrite
// AND asserted by the candidate at the same time. One column could only ever hold one of those, so
// every writer had to overwrite whatever the other one had put there.
test("089: claiming a skill does not disturb its enhancement queue state", () => {
  const db = freshDb();
  addProfileSignalSuggestions(db, { ...ctx, kind: "skill", labels: ["Kubernetes"] });
  syncSelectedSkillSuggestions(db, { ...ctx, selectedKeys: ["kubernetes"] });
  assert.equal(db.prepare("SELECT queue_state FROM profile_signal_suggestions").get().queue_state, "queued");

  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });
  const row = db.prepare("SELECT queue_state, assertion FROM profile_signal_suggestions").get();
  assert.equal(row.assertion, "claimed", "the claim is recorded");
  assert.equal(row.queue_state, "queued", "and the queue state it already had survives it");

  // Still queued for the rewrite, which is what buildSelectedEnhancementSkills reads.
  assert.deepEqual(buildSelectedEnhancementSkills(db, ctx).map(s => s.label), ["Kubernetes"]);
});

test("089: withdrawing a claim leaves the queue state alone", () => {
  const db = freshDb();
  addProfileSignalSuggestions(db, { ...ctx, kind: "skill", labels: ["Kubernetes"] });
  syncSelectedSkillSuggestions(db, { ...ctx, selectedKeys: ["kubernetes"] });
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes", claimed: false });

  const row = db.prepare("SELECT queue_state, assertion, status FROM profile_signal_suggestions").get();
  assert.equal(row.assertion, "none");
  assert.equal(row.queue_state, "queued", "withdrawing a claim is not unqueueing");
  assert.equal(row.status, "selected", "and the legacy projection says so too");
});

test("089: unqueueing a skill does not withdraw the claim on it", () => {
  const db = freshDb();
  addProfileSignalSuggestions(db, { ...ctx, kind: "skill", labels: ["Kubernetes"] });
  syncSelectedSkillSuggestions(db, { ...ctx, selectedKeys: ["kubernetes"] });
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });

  // The exact interaction that used to wipe claims: one untick in "Selected For Enhancement".
  syncSelectedSkillSuggestions(db, { ...ctx, selectedKeys: [] });

  const row = db.prepare("SELECT queue_state, assertion, status FROM profile_signal_suggestions").get();
  assert.equal(row.queue_state, "none");
  assert.equal(row.assertion, "claimed", "the candidate's answer survives an unrelated untick");
  assert.equal(row.status, "claimed", "the projection prefers the assertion, which is why it is lossy");
  assert.deepEqual(listProfileClaims(db, ctx).skills, ["Kubernetes"]);
});

test("089: the legacy status column stays in step with both axes", () => {
  const db = freshDb();
  addProfileSignalSuggestions(db, { ...ctx, kind: "skill", labels: ["Kubernetes"] });
  const statusNow = () => db.prepare("SELECT status FROM profile_signal_suggestions").get().status;

  assert.equal(statusNow(), "inactive");
  syncSelectedSkillSuggestions(db, { ...ctx, selectedKeys: ["kubernetes"] });
  assert.equal(statusNow(), "selected");
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });
  assert.equal(statusNow(), "claimed", "an assertion outranks the queue in the projection");
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes", claimed: false });
  assert.equal(statusNow(), "selected", "and it falls back to the queue state underneath");
  syncSelectedSkillSuggestions(db, { ...ctx, selectedKeys: [] });
  assert.equal(statusNow(), "inactive");
});

test("089: a claimed skill is not offered back as a suggestion to tick", () => {
  const db = freshDb();
  addProfileSignalSuggestions(db, { ...ctx, kind: "skill", labels: ["Kubernetes", "Rust"] });
  setProfileSignalClaim(db, { ...ctx, kind: "skill", label: "Kubernetes" });

  const listed = listProfileSignalSuggestions(db, ctx);
  assert.deepEqual(listed.inactiveSkills.map(s => s.label), ["Rust"],
    "a claimed term must not reappear in the list of things to claim");
  assert.deepEqual(listed.claimedSkills.map(s => s.label), ["Kubernetes"]);
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
