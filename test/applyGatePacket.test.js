// TASK G1 — gated portal handoff: the packet and its single-use token.
//
// The real-run half of this lives in scripts/g1GatePacket.mjs, which drives a real browser into
// fakeAts's /gated login wall. What is here is what a real run cannot prove cheaply or repeatedly:
// the token's rejection semantics, and the invariant that a packet never contains a value with no
// provenance attached to it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildGatePacket, mintPacketToken, verifyPacketToken, hashToken, originOf,
  CANONICAL_GATE_FIELDS, ELIGIBILITY_MARKERS, isEligibilityAnswer, DEFAULT_TOKEN_TTL_MS,
} from "../services/applyGatePacket.js";
import { GATE_FLOW_STATES, PROFILE_KEY_TO_HANDLER, CONFIDENCE_BY_PROVENANCE } from "../services/applyAutomation.js";

const SECRET = "test-secret";
const PAYLOAD = {
  field_map: {
    first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", phone: "+1 555 0100",
    address_line1: "12 Analytical Way", city: "Boston", state: "MA", zip: "02115",
    country: "United States", linkedin_url: "https://linkedin.com/in/ada",
    requires_sponsorship: "No", work_authorization: "Yes",
  },
  handler_map: {},
  custom_answers: {},
};

const packet = (over = {}) => buildGatePacket({
  autofillPayload: PAYLOAD,
  applyUrl: "https://portal.example.com/apply/step1",
  jobId: "j1", runId: 1, runJobId: 2, resumeArtifactId: 3,
  gateReason: "login_required",
  ...over,
});

// ── The canonical set has to speak the resolver's own vocabulary ─────────────

test("every canonical handler_type is one the resolver can actually resolve", () => {
  const known = new Set(Object.values(PROFILE_KEY_TO_HANDLER));
  for (const f of CANONICAL_GATE_FIELDS) {
    assert.ok(known.has(f.handler_type),
      `handler_type '${f.handler_type}' (${f.name}) is not produced by PROFILE_KEY_TO_HANDLER — ` +
      `buildAnswers would never match it and the field would silently come back unresolved`);
  }
});

test("the canonical set carries no duplicate names or field ids", () => {
  const names = CANONICAL_GATE_FIELDS.map(f => f.name);
  const ids = CANONICAL_GATE_FIELDS.map(f => f.field_id);
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(ids).size, ids.length);
});

test("eligibility markers are derived from the resolver's own lists, not hand-written", () => {
  // If someone adds an eligibility class to ELIGIBILITY_HANDLERS, it must appear here without an
  // edit to applyGatePacket.js — otherwise §6's "eligibility surfaces first" silently stops holding.
  for (const h of ["sponsorship", "work-auth", "clearance", "visa", "veteran", "disability"]) {
    assert.ok(ELIGIBILITY_MARKERS.has(h), `${h} must be an eligibility marker`);
  }
  // Both spellings resolve: matched_on is a handler type on one path and a profile key on the other.
  assert.ok(isEligibilityAnswer({ matched_on: "sponsorship" }));
  assert.ok(isEligibilityAnswer({ matched_on: "requires_sponsorship" }));
  assert.ok(isEligibilityAnswer({ name: "work_authorization" }));
  assert.equal(isEligibilityAnswer({ matched_on: "first_name", name: "first_name" }), false);
});

// ── The packet ───────────────────────────────────────────────────────────────

test("a gated packet resolves the canonical questions with provenance per field", () => {
  const p = packet();
  assert.equal(p.source, "canonical_profile");
  assert.ok(p.answers.length > 5, `expected several answers, got ${p.answers.length}`);
  for (const a of p.answers) {
    assert.ok(a.provenance, `${a.name} has a value with no provenance`);
    assert.equal(typeof a.confidence, "number", `${a.name} has no confidence`);
    assert.equal(a.confidence, CONFIDENCE_BY_PROVENANCE[a.provenance],
      `${a.name}'s confidence must come from the shared table, not a second opinion`);
  }
});

test("NO packet answer is ever a bare value — this is the invariant, asserted not commented", () => {
  for (const p of [packet(), packet({ gateReason: "captcha_required" })]) {
    const bare = p.answers.filter(a => a.value != null && !a.provenance);
    assert.equal(bare.length, 0,
      `bare values leaked: ${bare.map(a => a.name).join(", ")}`);
  }
});

test("eligibility answers are flagged so G3 can pin them to the top", () => {
  const p = packet();
  const elig = p.answers.filter(a => a.eligibility).map(a => a.name);
  assert.ok(elig.includes("work_authorization"), `work_authorization missing from ${elig.join(",")}`);
  assert.ok(elig.includes("requires_sponsorship"), `requires_sponsorship missing from ${elig.join(",")}`);
});

test("what the profile cannot answer is reported, not quietly dropped", () => {
  const p = buildGatePacket({
    autofillPayload: { field_map: { first_name: "Ada" }, handler_map: {}, custom_answers: {} },
    applyUrl: "https://portal.example.com/apply", jobId: "j1",
  });
  assert.equal(p.answers.length, 1);
  const names = p.unresolved.map(u => u.name);
  assert.ok(names.includes("email"), "an unanswerable required question must be listed");
  assert.ok(p.unresolved.find(u => u.name === "work_authorization")?.eligibility === true,
    "an unresolved eligibility question must still be marked as one");
  // Every canonical question is accounted for exactly once, either answered or unresolved.
  assert.equal(p.answers.length + p.unresolved.length, CANONICAL_GATE_FIELDS.length);
});

test("real field-matched answers are preferred over the canonical fallback", () => {
  const real = [{
    field_id: "f1", name: "email", type: "email", label: "Email", value: "x@y.com",
    provenance: "handler_exact", matched_on: "email", required: true,
  }];
  const p = packet({ resolvedAnswers: real });
  assert.equal(p.source, "discovered_form");
  assert.equal(p.answers.length, 1);
  assert.equal(p.answers[0].provenance, "handler_exact");
  assert.equal(p.answers[0].confidence, 1.0);
  assert.equal(p.answers[0].is_required, true, "buildAnswers emits `required`; the packet must read it");
});

test("the resolver's refusals are not counted as prepared answers", () => {
  // A skipped answer is the resolver declining to guess. Treating it as resolved would overstate what
  // is ready and would put a null value in front of the user as though it had been decided.
  const p = packet({
    resolvedAnswers: [
      { name: "requires_sponsorship", value: null, skipped: true, refusals: ["x:undetermined_boolean_polarity"], provenance: null },
    ],
  });
  assert.equal(p.source, "canonical_profile", "an all-skipped set is not a discovered form");
});

test("a packet refuses to exist without a target-matchable origin", () => {
  assert.throws(
    () => buildGatePacket({ autofillPayload: PAYLOAD, applyUrl: "not a url", jobId: "j1" }),
    /parseable apply URL/,
    "a packet with no expected origin could only be released by trusting the page it landed on",
  );
  assert.equal(originOf("not a url"), null);
  assert.equal(originOf("https://a.example.com:8443/x?y=1"), "https://a.example.com:8443");
});

// ── The token ────────────────────────────────────────────────────────────────

test("a freshly minted token verifies and carries its bindings", () => {
  const { token, tokenHash, expiresAt } = mintPacketToken({ secret: SECRET, userId: 7, jobId: "j1", packetId: 42 });
  const v = verifyPacketToken(token, { secret: SECRET });
  assert.equal(v.ok, true);
  assert.equal(v.payload.uid, 7);
  assert.equal(v.payload.jid, "j1");
  assert.equal(v.payload.pid, 42);
  assert.equal(hashToken(token), tokenHash, "the stored hash must be reproducible from the token");
  assert.notEqual(tokenHash, token, "the row must never hold the token itself");
  // Seconds, matching the schema's expires_at.
  assert.ok(Math.abs(expiresAt * 1000 - (Date.now() + DEFAULT_TOKEN_TTL_MS)) < 5000);
});

test("the default TTL is minutes, not hours", () => {
  assert.ok(DEFAULT_TOKEN_TTL_MS <= 60 * 60 * 1000,
    "requirement 3: this token unlocks a home address and eligibility answers");
});

test("each rejection reason is distinct, so a probe cannot hide among ordinary misses", () => {
  const good = mintPacketToken({ secret: SECRET, userId: 1, jobId: "j", packetId: 1 }).token;

  assert.equal(verifyPacketToken(good, { secret: "other-secret" }).reason, "token_invalid");
  assert.equal(verifyPacketToken("", { secret: SECRET }).reason, "token_malformed");
  assert.equal(verifyPacketToken("nodot", { secret: SECRET }).reason, "token_malformed");
  assert.equal(verifyPacketToken(".sig", { secret: SECRET }).reason, "token_malformed");
  assert.equal(verifyPacketToken("payload.", { secret: SECRET }).reason, "token_malformed");
  assert.equal(verifyPacketToken(null, { secret: SECRET }).reason, "token_malformed");
  assert.equal(verifyPacketToken(good, {}).reason, "no_secret");
  assert.equal(
    verifyPacketToken(mintPacketToken({ secret: SECRET, userId: 1, jobId: "j", packetId: 1, ttlMs: -1 }).token, { secret: SECRET }).reason,
    "token_expired",
  );
});

test("a signature of the wrong LENGTH is rejected rather than throwing", () => {
  // timingSafeEqual throws on a length mismatch, which would surface as a 500 and tell an attacker
  // their guess was structurally interesting.
  const good = mintPacketToken({ secret: SECRET, userId: 1, jobId: "j", packetId: 1 }).token;
  const short = `${good.split(".")[0]}.abc`;
  assert.doesNotThrow(() => verifyPacketToken(short, { secret: SECRET }));
  assert.equal(verifyPacketToken(short, { secret: SECRET }).reason, "token_invalid");
});

test("tampering with the payload invalidates the token", () => {
  const { token } = mintPacketToken({ secret: SECRET, userId: 1, jobId: "j1", packetId: 1 });
  const [payloadB64, sig] = token.split(".");
  const forged = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  forged.uid = 999;                                              // escalate to another account
  const swapped = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
  assert.equal(verifyPacketToken(swapped, { secret: SECRET }).reason, "token_invalid");
});

test("minting refuses without a secret rather than signing with nothing", () => {
  assert.throws(() => mintPacketToken({ secret: "", userId: 1, jobId: "j", packetId: 1 }), /server secret/);
});

// ── Gate classification ──────────────────────────────────────────────────────

test("'expired' is NOT a gate", () => {
  assert.ok(GATE_FLOW_STATES.has("login_required"));
  assert.ok(GATE_FLOW_STATES.has("captcha_required"));
  assert.equal(GATE_FLOW_STATES.has("expired"), false,
    "an expired posting has nothing behind it for a human to finish; offering a handoff would be a lie");
});

test("a login_required gate does not carry the sign-in page's fields into the packet", () => {
  // classifyFlowState returns login_required because it found a password field or a /signin URL, so
  // the controls discovery walked are a CREDENTIAL form. Building the packet from them would label a
  // sign-in page's email box 'discovered_form'.
  //
  // Now asserted against buildGateHold, which both the pre-fill and post-fill gate paths return
  // through — before that refactor this rule lived inline in one of them, so the other could have
  // been written without it.
  const src = fs.readFileSync("services/applyAutomation.js", "utf8");
  const helper = src.slice(src.indexOf("async function buildGateHold"));
  assert.ok(helper.length > 0, "the shared gate result must exist");
  assert.match(helper.slice(0, 2500),
    /answers:\s*flowState === 'captcha_required' \? \(?resolvedAnswers\b/,
    "the gate result must withhold discovered answers for login_required");

  // And the stronger guarantee the credential fix adds: on a sign-in page there are no fillable
  // answers to withhold in the first place, because nothing was filled.
  assert.match(src, /const preFillGate = isUnattended \? await detectGate\(page\) : null;/,
    "a gate must be detected before the fill, not only after it");
});

// ── Migration ────────────────────────────────────────────────────────────────

test("migration 079 is present, additive, and byte-identical in both migration paths", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const script = fs.readFileSync("scripts/migrations.js", "utf8");
  const block = (src) => {
    const i = src.indexOf('id: "079_apply_gate_packets"');
    assert.ok(i > 0, "migration 079 must exist");
    return src.slice(i, src.indexOf("\n    },", i));
  };
  const a = block(server), b = block(script);
  assert.equal(a, b, "the migration must be byte-identical in server.js and scripts/migrations.js");

  assert.doesNotMatch(a, /DROP\s+TABLE|DROP\s+COLUMN|ALTER\s+TABLE\s+\w+\s+RENAME/i,
    "additive only");
  assert.match(a, /CREATE TABLE IF NOT EXISTS apply_gate_packets/);
  for (const col of ["expected_origin", "token_hash", "expires_at", "consumed_at", "answers_json", "exchange_attempts"]) {
    assert.match(a, new RegExp(`\\b${col}\\b`), `must define ${col}`);
  }
  assert.match(a, /token_hash\s+TEXT\s+NOT NULL UNIQUE/,
    "one outstanding token per packet, enforced by the schema rather than by convention");
});

test("single use is claimed by a conditional UPDATE, not a read-then-write", () => {
  // This is the one property no functional test can observe: a read-then-write version passes every
  // sequential test and serves the packet twice only under concurrency. The actual HTTP status codes
  // are verified against a running server in scripts/g1GatePacket.mjs.
  const src = fs.readFileSync("routes/apply.js", "utf8");
  assert.match(src, /consumed_at=unixepoch\(\)[\s\S]{0,160}WHERE id=\? AND consumed_at IS NULL/,
    "two concurrent exchanges would both pass a `consumed_at IS NULL` check and both be served");
  assert.match(src, /claim\.changes === 0/,
    "the UPDATE's row count is what decides which caller won");
});
