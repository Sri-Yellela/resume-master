import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../scripts/migrations.js";
import { profileSignalKey } from "../shared/profileSignals.js";
import {
  buildSelectedEnhancementSkills,
  classifyMissingSignal,
  extractMissingSignals,
  markSelectedSuggestionsApplied,
  syncSelectedSkillSuggestions,
} from "../services/profileSignalAggregator.js";
import { at } from "../test-support/sourceAnchors.js";

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
/**
 * A database built by RUNNING THE MIGRATIONS, not by hand-writing the schema.
 *
 * The hand-written version drifted the moment migration 089 split `status` into queue_state and
 * assertion: the fixture kept describing a table the product no longer has, so these tests would
 * have gone on passing against a schema that existed nowhere else. 96 migrations against :memory:
 * costs about 50ms and cannot drift, because it IS the schema.
 *
 * Rows are seeded on the two axes. `status` is written too, as the product writes it — the legacy
 * projection — so a fixture can never assert a combination the product cannot produce.
 */
function suggestionsDb(rows = []) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  // The real schema turns foreign keys ON, so the parents have to exist. The hand-written fixture
  // never needed these, which is another way of saying it was not the real schema.
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (7, 'fixture', 'x')").run();
  db.prepare(`INSERT INTO domain_profiles (id, user_id, profile_name, role_family, domain)
              VALUES (1, 7, 'Fixture', 'engineering', 'software')`).run();
  const ins = db.prepare(`
    INSERT INTO profile_signal_suggestions
      (profile_id,user_id,signal_key,signal_label,signal_kind,queue_state,assertion,status,frequency)
    VALUES (1,7,?,?,?,?,?,?,?)
  `);
  for (const r of rows) {
    const queueState = r.queued ? "queued" : "none";
    const assertion = r.assertion || "none";
    const status = assertion !== "none" ? assertion : (r.queued ? "selected" : "inactive");
    ins.run(r.key, r.label, r.kind || "skill", queueState, assertion, status, r.frequency ?? 3);
  }
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
    { key: "kubernetes", label: "Kubernetes", queued: true },
    { key: "terraform", label: "Terraform", queued: true },
    { key: "graphql", label: "GraphQL" },
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
  const db = suggestionsDb([{ key: "kubernetes", label: "Kubernetes", queued: true }]);
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
  const db = suggestionsDb([{ key: "kubernetes", label: "Kubernetes", queued: true }]);
  markSelectedSuggestionsApplied(db, { userId: 999, profileId: 1, selectedLabels: ["Kubernetes"] });
  assert.equal(statusOf(db, "kubernetes").status, "selected", "another user's row must not move");
  markSelectedSuggestionsApplied(db, { userId: 7, profileId: 999, selectedLabels: ["Kubernetes"] });
  assert.equal(statusOf(db, "kubernetes").status, "selected", "another profile's row must not move");
});

test("buildSelectedEnhancementSkills hands back labels, which is what the marker expects", () => {
  // The two halves of the round trip: what the enhance step persists, and what adopt reads back.
  // A shape change on either side reintroduces a silent no-op rather than an error.
  const db = suggestionsDb([{ key: "kubernetes", label: "Kubernetes", queued: true, frequency: 5 }]);
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
    { key: "kubernetes", label: "Kubernetes", assertion: "applied" },
    { key: "terraform", label: "Terraform", assertion: "claimed" },
    { key: "graphql", label: "GraphQL", queued: true },
    { key: "rust", label: "Rust" },
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
    { key: "kubernetes", label: "Kubernetes", assertion: "applied" },
    { key: "terraform", label: "Terraform", assertion: "claimed" },
  ]);
  syncSelectedSkillSuggestions(db, { userId: 7, profileId: 1, selectedKeys: ["kubernetes", "terraform"] });

  assert.equal(statusOf(db, "kubernetes").status, "applied");
  assert.equal(statusOf(db, "terraform").status, "claimed");
});

test("syncSelectedSkillSuggestions still ignores verbs, and other profiles", () => {
  const db = suggestionsDb([
    { key: "architected", label: "Architected", kind: "action_verb", queued: true },
    { key: "graphql", label: "GraphQL", queued: true },
  ]);
  syncSelectedSkillSuggestions(db, { userId: 7, profileId: 1, selectedKeys: [] });
  assert.equal(statusOf(db, "architected").status, "selected", "verbs are not this function's business");
  assert.equal(statusOf(db, "graphql").status, "inactive");

  const other = suggestionsDb([{ key: "graphql", label: "GraphQL", queued: true }]);
  syncSelectedSkillSuggestions(other, { userId: 999, profileId: 1, selectedKeys: [] });
  assert.equal(statusOf(other, "graphql").status, "selected", "another user's row must not move");
});

test("migration 089 is present, additive, and byte-identical in both migration paths", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const script = fs.readFileSync("scripts/migrations.js", "utf8");
  const block = (src) => {
    const i = src.indexOf('id: "089_profile_signal_queue_and_assertion"');
    assert.ok(i > 0, "migration 089 must exist");
    return src.slice(i, at(src, "\n    },", i));
  };
  const a = block(server), b = block(script);
  assert.equal(a, b, "the migration must be byte-identical in server.js and scripts/migrations.js");

  assert.doesNotMatch(a, /DROP\s+TABLE|DROP\s+COLUMN|ALTER\s+TABLE\s+\w+\s+RENAME/i, "additive only");
  // status is KEPT. Dropping it would strand anything still reading it mid-deploy, and SQLite would
  // need a table rebuild to do it — the opposite of an additive migration.
  assert.match(a, /ADD COLUMN queue_state TEXT NOT NULL DEFAULT 'none'/);
  assert.match(a, /ADD COLUMN assertion TEXT NOT NULL DEFAULT 'none'/);
  assert.match(a, /ADD COLUMN claimed_at INTEGER/);

  // Every legacy value has a backfill. A missing one would silently land on the 'none' defaults and
  // read as a row nobody had ever touched.
  assert.match(a, /SET queue_state = 'queued' WHERE status = 'selected'/);
  assert.match(a, /SET assertion = 'applied' WHERE status = 'applied'/);
  assert.match(a, /SET assertion = 'claimed', claimed_at = selected_at, selected_at = NULL/,
    "a claim's timestamp must MOVE to claimed_at, not be left on the queue's column");
});

test("migration 089 backfills every legacy status onto the right axes", () => {
  // Run the real migration against rows in all four pre-089 states. The assertions above prove the
  // SQL says the right words; this proves it does the right thing.
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) {
    if (m.id === "089_profile_signal_queue_and_assertion") break;
    db.exec(m.sql);
  }
  db.exec(`
    INSERT INTO users (id, username, password_hash) VALUES (7, 'f', 'x');
    INSERT INTO domain_profiles (id, user_id, profile_name, role_family, domain)
      VALUES (1, 7, 'F', 'engineering', 'software');
  `);
  const ins = db.prepare(`INSERT INTO profile_signal_suggestions
    (profile_id,user_id,signal_key,signal_label,signal_kind,status,selected_at,applied_at)
    VALUES (1,7,?,?,'skill',?,?,?)`);
  ins.run("a", "Inactive", "inactive", null, null);
  ins.run("b", "Queued", "selected", 111, null);
  ins.run("c", "Claimed", "claimed", 222, null);   // pre-089, selected_at held the CLAIM time
  ins.run("d", "Applied", "applied", null, 333);

  db.exec(MIGRATIONS.find(m => m.id === "089_profile_signal_queue_and_assertion").sql);

  const rows = Object.fromEntries(
    db.prepare("SELECT * FROM profile_signal_suggestions").all().map(r => [r.signal_label, r]));
  assert.deepEqual(
    ["Inactive", "Queued", "Claimed", "Applied"].map(k => [rows[k].queue_state, rows[k].assertion]),
    [["none", "none"], ["queued", "none"], ["none", "claimed"], ["none", "applied"]]);
  assert.equal(rows.Claimed.claimed_at, 222, "the claim time moved to its own column");
  assert.equal(rows.Claimed.selected_at, null, "and no longer masquerades as a queue timestamp");
  assert.equal(rows.Queued.selected_at, 111, "a real queue timestamp is left alone");
  assert.equal(rows.Applied.applied_at, 333);
});

test("adopting an enhanced resume is one transaction, so it cannot half-apply", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const start = server.indexOf("ADOPTING IS ONE ACT");
  assert.ok(start > 0, "the adopt route must wrap its writes in a transaction");
  const block = server.slice(start, at(server, "adopt();", start));

  // The destructive write and the bookkeeping must be inside the same transaction — the ordering
  // is what turned an undefined symbol into an overwritten base resume and a 500.
  assert.match(block, /const adopt = db\.transaction\(\(\) => \{/);
  assert.match(block, /UPDATE profile_base_resumes/);
  assert.match(block, /upsertSimpleApplyProfile\(db/);
  assert.match(block, /markSelectedSuggestionsApplied\(db/);
});
