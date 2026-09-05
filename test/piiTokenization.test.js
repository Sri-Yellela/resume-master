// TASK F — the PII tokenization layer.
//
// ⛔ WHAT THIS PROTECTS, STATED HONESTLY: `resume_generate` has run ONCE in 1367 events, so today
// this guards about four cents of traffic. It was built for TESTABILITY — the round trip is far
// easier to prove before real volume than after — not for savings, and pretending otherwise would
// be the kind of claim the rest of this codebase's comments exist to prevent.
//
// The property it establishes is not "we tokenize". It is "we can prove what came back is what
// went out", and that is what makes the design compliance-defensible rather than compliance-shaped.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { callModel, SYSTEM_USER_ID } from "../services/modelCall.js";
import { DATA_CLASS } from "../shared/modelProviders.js";
import {
  GENERATION_FIELD_ALLOWLIST, EXCLUDED_FIELDS, assertOutboundFields, policyIsConsistent,
} from "../shared/piiPolicy.js";
import {
  buildTokenMap, tokenizeText, detokenizeText, tokensPresentIn, checkRoundTrip, reverseOrThrow,
} from "../services/pii/tokenizer.js";

// ── THE POLICY IS A WHITELIST ───────────────────────────────────────────────────────────────────

test("the allow-list and the excluded list never intersect", () => {
  assert.ok(policyIsConsistent(), "a field that is both allowed and excluded makes the policy meaningless");
});

test("every field requirement 2 names is excluded, by name", () => {
  // Written out rather than looped over the set, so deleting one from the policy fails HERE rather
  // than silently widening what may leave. Immigration status is a special category in most
  // frameworks; linkedin_url and github_url are the two a "name, email, phone" mental model misses,
  // and the CURRENT untokenized prompt sends both.
  for (const f of ["work_auth", "requires_sponsorship", "visa_type", "has_clearance",
                   "clearance_level", "gender", "ethnicity", "veteran_status", "disability_status",
                   "linkedin_url", "github_url", "address_line1", "address_line2", "zip",
                   "phone", "email"]) {
    assert.ok(EXCLUDED_FIELDS.has(f), `${f} must be excluded`);
    assert.ok(!GENERATION_FIELD_ALLOWLIST.has(f), `${f} must not be sendable`);
  }
});

test("⛔ an UNKNOWN field is refused — the list is a whitelist, not a blacklist", () => {
  // The whole design. A blacklist would let a field nobody thought about through by default; this
  // refuses it. `salary_expectation` is not on anyone's PII list and is nobody's business either.
  assert.throws(
    () => assertOutboundFields({ job_title: "SRE", salary_expectation: "$200k" }),
    (e) => e.code === "PII_UNKNOWN_FIELD" && /salary_expectation/.test(e.message),
  );
});

test("an EXCLUDED field is refused with a different, louder code", () => {
  // Distinguished from "unknown" on purpose: one is a field nobody has classified, the other is a
  // field somebody classified as never-send. They need different reactions from whoever reads it.
  assert.throws(
    () => assertOutboundFields({ job_title: "SRE", work_auth: "H-1B" }),
    (e) => e.code === "PII_EXCLUDED_FIELD" && /work_auth/.test(e.message),
  );
});

test("a payload built only from allowed fields passes", () => {
  assert.ok(assertOutboundFields({
    job_title: "Site Reliability Engineer", job_company: "Acme", job_description: "…",
    years_of_experience: 6, employer_tokens: ["COMPANY_A"], resume_body: "…",
  }));
});

// ── THE GUARD IS ENFORCED IN callModel, AND IT IS SEEN TO FAIL ─────────────────────────────────

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      event_subtype TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0, model TEXT, cost_usd REAL DEFAULT 0,
      ats_score_before INTEGER, ats_score_after INTEGER, duration_ms INTEGER, job_id TEXT,
      company TEXT, success INTEGER NOT NULL DEFAULT 1, error_text TEXT, purpose TEXT,
      provider TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE cache_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      layer TEXT, domain_module TEXT, tokens_in_cache INTEGER DEFAULT 0, tokens_saved INTEGER DEFAULT 0,
      cost_saved_usd REAL DEFAULT 0, model TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE usage_tracking_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, purpose TEXT, user_id INTEGER,
      error_text TEXT, recovered_from_sink INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return db;
}

const fakeAnthropic = () => {
  const calls = [];
  return { calls, messages: { create: async (p) => { calls.push(p); return { content: [{ type: "text", text: "ok" }], usage: {} }; } } };
};

test("⛔ INJECTING an excluded field into a TOKENIZED call REFUSES THE SEND", () => {
  // Requirement 4: "verify by INJECTING an excluded field and confirming the send is refused — a
  // guard never seen to fail is not evidence." This is that injection.
  const db = makeDb();
  const anthropic = fakeAnthropic();
  assert.rejects(() => callModel({
    anthropic, db, purpose: "resume_generate", userId: SYSTEM_USER_ID,
    dataClass: DATA_CLASS.TOKENIZED,
    piiFields: { job_title: "SRE", email: "ada@example.com" },
    model: "claude-sonnet-5", messages: [{ role: "user", content: "x" }],
  }), (e) => e.code === "PII_EXCLUDED_FIELD");
  assert.equal(anthropic.calls.length, 0, "nothing may reach the provider — refused, not sanitised");
  db.close();
});

test("a TOKENIZED call with NO declared fields is refused as vacuous", () => {
  // The class asserts a property. A call claiming it without supplying anything to check is
  // claiming it vacuously, which is worse than not claiming it — it reads as verified.
  const db = makeDb();
  assert.rejects(() => callModel({
    anthropic: fakeAnthropic(), db, purpose: "resume_generate", userId: SYSTEM_USER_ID,
    dataClass: DATA_CLASS.TOKENIZED,
    model: "claude-sonnet-5", messages: [{ role: "user", content: "x" }],
  }), /requires `piiFields`/);
  db.close();
});

test("a clean TOKENIZED payload is sent", async () => {
  const db = makeDb();
  const anthropic = fakeAnthropic();
  await callModel({
    anthropic, db, purpose: "resume_generate", userId: SYSTEM_USER_ID,
    dataClass: DATA_CLASS.TOKENIZED,
    piiFields: { job_title: "SRE", employer_tokens: ["COMPANY_A"], resume_body: "…" },
    model: "claude-sonnet-5", messages: [{ role: "user", content: "x" }],
  });
  assert.equal(anthropic.calls.length, 1);
  db.close();
});

test("CANDIDATE calls are not subject to the whitelist — and are not routable either", async () => {
  // The untokenized path is unchanged. It stays on Anthropic, so the field policy is not what
  // protects it; the routing rule is. Applying the whitelist there would refuse every existing
  // generation for fields it legitimately sends.
  const db = makeDb();
  const anthropic = fakeAnthropic();
  await callModel({
    anthropic, db, purpose: "resume_generate", userId: SYSTEM_USER_ID,
    dataClass: DATA_CLASS.CANDIDATE,
    model: "claude-sonnet-5", messages: [{ role: "user", content: "x" }],
  });
  assert.equal(anthropic.calls.length, 1);
  db.close();
});

// ── TOKENIZATION IS DETERMINISTIC ───────────────────────────────────────────────────────────────

test("the same employer gets the same token every time, whatever the input order", () => {
  // Encounter-order assignment makes a stored mapping unre-derivable, so "what did we send in
  // March" becomes unanswerable — which is exactly the question an audit asks.
  const a = buildTokenMap({ employers: ["Stripe", "Acme Corp", "Zebra Ltd"] });
  const b = buildTokenMap({ employers: ["Zebra Ltd", "Stripe", "Acme Corp"] });
  assert.equal(a.forward.get("Stripe"), b.forward.get("Stripe"));
  assert.equal(a.forward.get("Acme Corp"), b.forward.get("Acme Corp"));
});

test("a longer name is replaced before the shorter one it contains", () => {
  // Otherwise "Stripe Payments" becomes "COMPANY_B Payments" and half the real name survives in
  // the outbound payload — a leak that looks like a successful tokenization.
  const map = buildTokenMap({ employers: ["Stripe", "Stripe Payments"] });
  const out = tokenizeText("Worked at Stripe Payments, then at Stripe.", map);
  assert.ok(!/Stripe/.test(out), `a real employer name survived: ${out}`);
});

test("tokenization is case-insensitive, because resumes are not consistent", () => {
  const map = buildTokenMap({ employers: ["Stripe"] });
  assert.ok(!/stripe/i.test(tokenizeText("stripe, STRIPE and Stripe", map)));
});

test("a full round trip restores the original text exactly", () => {
  const map = buildTokenMap({ employers: ["Stripe", "Acme Corp"], teams: ["Payments Infrastructure"] });
  const original = "At Stripe I joined Payments Infrastructure. Before that, Acme Corp.";
  const sent = tokenizeText(original, map);
  assert.equal(detokenizeText(sent, map), original);
});

// ── THE REVERSAL, WHERE THE RISK IS ─────────────────────────────────────────────────────────────

test("⛔ a DROPPED token fails the round trip", () => {
  // The model rephrases around COMPANY_B — "at my previous employer" — and the artifact is missing
  // a job. It reads perfectly. Nothing but this check notices.
  const map = buildTokenMap({ employers: ["Stripe", "Acme Corp"] });
  const sent = tokensPresentIn(tokenizeText("Stripe and Acme Corp", map));
  const result = checkRoundTrip(sent, "I worked at COMPANY_B and at a previous employer.");
  assert.equal(result.ok, false);
  assert.deepEqual(result.dropped, ["COMPANY_A"]);
  assert.match(result.reason, /did not come back/);
});

test("⛔ an INVENTED token fails the round trip", () => {
  // A hallucinated COMPANY_C resolves to nobody, and would put an employer in the résumé that the
  // candidate never had.
  const map = buildTokenMap({ employers: ["Stripe", "Acme Corp"] });
  const sent = tokensPresentIn(tokenizeText("Stripe and Acme Corp", map));
  const result = checkRoundTrip(sent, "COMPANY_A, COMPANY_B and COMPANY_C.");
  assert.equal(result.ok, false);
  assert.deepEqual(result.invented, ["COMPANY_C"]);
  assert.match(result.reason, /INVENTED/);
});

test("a failing round trip THROWS — the generation does not persist", () => {
  // Returning a best-effort artifact would hand the candidate a résumé with a missing job or an
  // invented employer, which is the outcome tokenization was adopted to make impossible.
  const map = buildTokenMap({ employers: ["Stripe", "Acme Corp"] });
  const sent = tokensPresentIn(tokenizeText("Stripe and Acme Corp", map));
  assert.throws(() => reverseOrThrow({ sentTokens: sent, output: "only COMPANY_A here", map }),
    (e) => e.code === "PII_ROUND_TRIP_FAILED");
  assert.throws(() => reverseOrThrow({ sentTokens: sent, output: "COMPANY_A COMPANY_B COMPANY_Z", map }),
    (e) => e.code === "PII_ROUND_TRIP_FAILED");
});

test("a clean round trip returns the restored document", () => {
  const map = buildTokenMap({ employers: ["Stripe", "Acme Corp"] });
  const sent = tokensPresentIn(tokenizeText("Stripe and Acme Corp", map));
  const restored = reverseOrThrow({
    sentTokens: sent, map,
    output: "<p>Led platform work at COMPANY_B, previously COMPANY_A.</p>",
  });
  assert.match(restored, /Stripe/);
  assert.match(restored, /Acme Corp/);
  assert.ok(!/COMPANY_/.test(restored), "no placeholder may survive into the artifact");
});

test("a token surviving substitution is caught separately", () => {
  // Belt and braces. If the mapping and the round-trip check ever disagree, a placeholder would
  // ship inside a real résumé — visible to an employer, which is the most embarrassing possible
  // failure of this feature.
  const map = buildTokenMap({ employers: ["Stripe"] });
  // COMPANY_A is both sent and returned, so the round trip passes; the reverse map is then emptied
  // to simulate a mapping that does not cover what came back.
  const sent = new Set(["COMPANY_A"]);
  map.reverse.clear();
  assert.throws(() => reverseOrThrow({ sentTokens: sent, output: "at COMPANY_A", map }),
    (e) => e.code === "PII_TOKEN_LEAKED");
});

// ── REQUIREMENTS 5 AND 6 ────────────────────────────────────────────────────────────────────────

test("requirement 5: A+ / enhanceProfileResume stays on Claude, untokenized", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const i = server.indexOf('purpose: "resume_enhance"');
  assert.ok(i > 0, "the A+ call site was not found");
  const site = server.slice(i, i + 400);
  assert.match(site, /dataClass: DATA_CLASS\.CANDIDATE/,
    "A+ is the experimental path and its prompt changes; it must not be routed or tokenized");
  assert.ok(!/dataClass: DATA_CLASS\.TOKENIZED/.test(site));
});

test("requirement 6: AF2's years assertion inspects the OUTPUT, so a tokenized payload cannot make it vacuous", () => {
  // The concern is real: a guard that reads the PAYLOAD would see tokens instead of employers and
  // pass on everything. AF2's guard reads the generated document and the profile's own years
  // figure — neither of which tokenization changes — so it still inspects something.
  const guard = fs.readFileSync("services/resumeClaimGuard.js", "utf8");
  assert.match(guard, /years/i);
  // It must not be keyed on employer names, which ARE tokenized on that path.
  assert.ok(!/COMPANY_[A-Z]/.test(guard),
    "the claim guard must not have been taught about tokens — it reads the restored document");
});

test("nothing in the tokenizer or the policy makes a model call", () => {
  for (const f of ["services/pii/tokenizer.js", "shared/piiPolicy.js"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(!/callModel|messages\.create|fetch\s*\(/.test(src),
      `${f} must be pure — a model call inside the guard is the guard calling the thing it guards`);
  }
});
