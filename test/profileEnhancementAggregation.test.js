import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { profileSignalKey } from "../shared/profileSignals.js";
import {
  buildSelectedEnhancementSkills,
  classifyMissingSignal,
  extractMissingSignals,
  markSelectedSuggestionsApplied,
  syncSelectedSkillSuggestions,
} from "../services/profileSignalAggregator.js";

test("ATS missing signals classify structured profile facts separately from skills", () => {
  const citizenship = classifyMissingSignal("U.S. citizenship");
  const clearance = classifyMissingSignal("TS/SCI");
  const react = classifyMissingSignal("React");

  assert.equal(citizenship?.kind, "structured_fact");
  assert.equal(citizenship?.field, "citizenshipStatus");
  assert.equal(clearance?.kind, "structured_fact");
  assert.equal(clearance?.field, "clearanceLevel");
  assert.equal(react?.kind, "skill");
  assert.equal(react?.label, "React");
});

test("ATS missing signal extraction deduplicates and keeps promotable items only", () => {
  const signals = extractMissingSignals({
    tier1_missing: ["React", "React", "U.S. citizenship", "communication"],
    action_verbs_missing: ["Architected"],
  });
  const labels = signals.map(item => item.label);

  assert.equal(labels.filter(label => label === "React").length, 1);
  assert.ok(labels.includes("U.S. citizenship"));
  assert.ok(!labels.includes("communication"));
});

test("profile enhancement architecture is wired through server routes and profile editor UI", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const routes = fs.readFileSync("routes/domainProfiles.js", "utf8");
  const panel = fs.readFileSync("client/src/panels/ProfilePanel.jsx", "utf8");

  assert.match(server, /CREATE TABLE IF NOT EXISTS profile_signal_suggestions/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS profile_resume_enhancements/);
  assert.match(server, /aggregateAtsMissingSignals\(db/);
  assert.match(server, /buildSelectedEnhancementSkills\(db/);
  assert.match(routes, /router\.put\("\/:id\/suggestions"/);
  assert.match(routes, /router\.get\("\/:id\/enhancement-history"/);
  assert.match(panel, /Inactive ATS-Suggested Skills/);
  assert.match(panel, /Selected For Enhancement/);
  assert.match(panel, /Structured ATS Facts Seen In Target Jobs/);
  assert.match(panel, /Enhance Base Resume/);
});

// ── markSelectedSuggestionsApplied, which nothing had ever called ───────────────────────────────
//
// It referenced an undefined `signalKey` and threw a ReferenceError on every invocation that had
// anything to mark. Nothing caught it, because the tests above only read source text and the only
// caller passes an empty array when nothing is selected — and `.map` never runs its callback on an
// empty array. So the function was silent right up to the moment the feature was used.
//
// These tests CALL it. That is the whole difference.
function suggestionsDb(rows = []) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE profile_signal_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      signal_key TEXT NOT NULL, signal_label TEXT NOT NULL, signal_kind TEXT NOT NULL,
      structured_field TEXT, frequency INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'inactive',
      first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      selected_at INTEGER, applied_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(profile_id, signal_key));
  `);
  const ins = db.prepare(`
    INSERT INTO profile_signal_suggestions (profile_id,user_id,signal_key,signal_label,signal_kind,status,frequency)
    VALUES (1,7,?,?,?,?,?)
  `);
  for (const r of rows) ins.run(r.key, r.label, r.kind || "skill", r.status || "selected", r.frequency ?? 3);
  return db;
}
const statusOf = (db, key) =>
  db.prepare("SELECT status, applied_at FROM profile_signal_suggestions WHERE signal_key=?").get(key);

test("markSelectedSuggestionsApplied marks the skills an adoption used", () => {
  const db = suggestionsDb([
    { key: "kubernetes", label: "Kubernetes" },
    { key: "terraform", label: "Terraform" },
  ]);
  // Labels, not keys — this is what profile_resume_enhancements.selected_skills_json stores.
  markSelectedSuggestionsApplied(db, { userId: 7, profileId: 1, selectedLabels: ["Kubernetes", "Terraform"] });

  for (const key of ["kubernetes", "terraform"]) {
    const row = statusOf(db, key);
    assert.equal(row.status, "applied", `${key} should be applied`);
    assert.ok(row.applied_at > 0, `${key} should carry an applied_at`);
  }
});

test("markSelectedSuggestionsApplied leaves rows the adoption did not use alone", () => {
  const db = suggestionsDb([
    { key: "kubernetes", label: "Kubernetes" },
    { key: "terraform", label: "Terraform" },
    { key: "graphql", label: "GraphQL", status: "inactive" },
  ]);
  markSelectedSuggestionsApplied(db, { userId: 7, profileId: 1, selectedLabels: ["Kubernetes"] });

  assert.equal(statusOf(db, "kubernetes").status, "applied");
  assert.equal(statusOf(db, "terraform").status, "selected", "an unused selection is still selected");
  assert.equal(statusOf(db, "graphql").status, "inactive", "an untouched suggestion is untouched");
});

test("markSelectedSuggestionsApplied derives the key the same way the row was written", () => {
  // A label needing case-folding AND whitespace-joining, rather than a single lowercase word that
  // would pass under almost any implementation. Note the slash SURVIVES — profileSignalKey keeps
  // "+#/()." — so the key is "ci/cd_pipelines". Derived here rather than typed, because a hand-typed
  // key tests my guess about the function instead of the function.
  const label = "CI/CD Pipelines";
  const key = profileSignalKey(label);
  assert.equal(key, "ci/cd_pipelines");
  const db = suggestionsDb([{ key, label }]);
  markSelectedSuggestionsApplied(db, { userId: 7, profileId: 1, selectedLabels: [label] });
  assert.equal(statusOf(db, key).status, "applied");
});

test("markSelectedSuggestionsApplied survives the shapes the caller can actually produce", () => {
  const db = suggestionsDb([{ key: "kubernetes", label: "Kubernetes" }]);
  // The caller JSON.parses a column that defaults to '[]' and falls back to [] on malformed JSON,
  // so an empty list is normal and must be a no-op rather than a throw.
  assert.doesNotThrow(() => markSelectedSuggestionsApplied(db, { userId: 7, profileId: 1, selectedLabels: [] }));
  assert.equal(statusOf(db, "kubernetes").status, "selected");
  // And nothing here should throw on junk, because a throw here happens AFTER the base resume has
  // been overwritten.
  for (const selectedLabels of [null, undefined, "Kubernetes", [null, "", "   "]]) {
    assert.doesNotThrow(() => markSelectedSuggestionsApplied(db, { userId: 7, profileId: 1, selectedLabels }),
      `threw on ${JSON.stringify(selectedLabels)}`);
  }
  // A bare string is treated as one label, not iterated character by character.
  assert.equal(statusOf(db, "kubernetes").status, "applied");
});

test("markSelectedSuggestionsApplied is scoped to the user and profile", () => {
  const db = suggestionsDb([{ key: "kubernetes", label: "Kubernetes" }]);
  markSelectedSuggestionsApplied(db, { userId: 999, profileId: 1, selectedLabels: ["Kubernetes"] });
  assert.equal(statusOf(db, "kubernetes").status, "selected", "another user's row must not move");
  markSelectedSuggestionsApplied(db, { userId: 7, profileId: 999, selectedLabels: ["Kubernetes"] });
  assert.equal(statusOf(db, "kubernetes").status, "selected", "another profile's row must not move");
});

test("buildSelectedEnhancementSkills hands back labels, which is what the marker expects", () => {
  // The two halves of the round trip: what the enhance step persists, and what adopt reads back.
  // A shape change on either side reintroduces a silent no-op rather than an error.
  const db = suggestionsDb([{ key: "kubernetes", label: "Kubernetes", frequency: 5 }]);
  const selected = buildSelectedEnhancementSkills(db, { userId: 7, profileId: 1 });
  assert.deepEqual(selected.map(s => s.label), ["Kubernetes"]);

  markSelectedSuggestionsApplied(db, {
    userId: 7, profileId: 1, selectedLabels: selected.map(s => s.label),
  });
  assert.equal(statusOf(db, "kubernetes").status, "applied");
});

// ── syncSelectedSkillSuggestions must not move what it does not own ─────────────────────────────
//
// It reconciled EVERY skill row to selected-or-inactive, so unticking one box in "Selected For
// Enhancement" downgraded every applied skill and withdrew every claim on the profile. A two-state
// reconciliation over a four-state column destroys the states it has never heard of — and 'claimed'
// was added by AG2, after this function was written, which is exactly how that happens.
test("syncSelectedSkillSuggestions queues and unqueues, and leaves assertions alone", () => {
  const db = suggestionsDb([
    { key: "kubernetes", label: "Kubernetes", status: "applied" },
    { key: "terraform", label: "Terraform", status: "claimed" },
    { key: "graphql", label: "GraphQL", status: "selected" },
    { key: "rust", label: "Rust", status: "inactive" },
  ]);
  db.prepare("UPDATE profile_signal_suggestions SET applied_at=1000 WHERE signal_key='kubernetes'").run();

  // The user unticks GraphQL and ticks Rust. That is the whole interaction.
  syncSelectedSkillSuggestions(db, { userId: 7, profileId: 1, selectedKeys: ["rust"] });

  assert.equal(statusOf(db, "rust").status, "selected", "ticking queues it");
  assert.equal(statusOf(db, "graphql").status, "inactive", "unticking unqueues it");
  assert.equal(statusOf(db, "kubernetes").status, "applied",
    "an applied skill is in domain_profiles.selected_tools — downgrading it splits the two stores");
  assert.equal(statusOf(db, "kubernetes").applied_at, 1000, "and its applied_at is not orphaned");
  assert.equal(statusOf(db, "terraform").status, "claimed",
    "a claim is the candidate's assertion, not this control's queue state");
});

test("syncSelectedSkillSuggestions will not promote an assertion into the queue either", () => {
  // The UI cannot ask for this — applied and claimed rows appear in neither the inactive nor the
  // selected bucket — but a stale or hand-made request must not be able to demote an assertion to
  // 'selected' and lose what it was.
  const db = suggestionsDb([
    { key: "kubernetes", label: "Kubernetes", status: "applied" },
    { key: "terraform", label: "Terraform", status: "claimed" },
  ]);
  syncSelectedSkillSuggestions(db, { userId: 7, profileId: 1, selectedKeys: ["kubernetes", "terraform"] });

  assert.equal(statusOf(db, "kubernetes").status, "applied");
  assert.equal(statusOf(db, "terraform").status, "claimed");
});

test("syncSelectedSkillSuggestions still ignores verbs, and other profiles", () => {
  const db = suggestionsDb([
    { key: "architected", label: "Architected", kind: "action_verb", status: "selected" },
    { key: "graphql", label: "GraphQL", status: "selected" },
  ]);
  syncSelectedSkillSuggestions(db, { userId: 7, profileId: 1, selectedKeys: [] });
  assert.equal(statusOf(db, "architected").status, "selected", "verbs are not this function's business");
  assert.equal(statusOf(db, "graphql").status, "inactive");

  const other = suggestionsDb([{ key: "graphql", label: "GraphQL", status: "selected" }]);
  syncSelectedSkillSuggestions(other, { userId: 999, profileId: 1, selectedKeys: [] });
  assert.equal(statusOf(other, "graphql").status, "selected", "another user's row must not move");
});

test("adopting an enhanced resume is one transaction, so it cannot half-apply", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const start = server.indexOf("ADOPTING IS ONE ACT");
  assert.ok(start > 0, "the adopt route must wrap its writes in a transaction");
  const block = server.slice(start, server.indexOf("adopt();", start));

  // The destructive write and the bookkeeping must be inside the same transaction — the ordering
  // is what turned an undefined symbol into an overwritten base resume and a 500.
  assert.match(block, /const adopt = db\.transaction\(\(\) => \{/);
  assert.match(block, /UPDATE profile_base_resumes/);
  assert.match(block, /upsertSimpleApplyProfile\(db/);
  assert.match(block, /markSelectedSuggestionsApplied\(db/);
});
