/**
 * Gated-portal handoff — the prepared packet and its single-use token (TASK G1).
 * ---------------------------------------------------------------------------------------------
 * When a run reaches a portal that demands an account or a CAPTCHA, the server cannot finish the
 * application and must not pretend otherwise. Everything already decided is parked in a packet, and
 * the extension exchanges a short-lived token for it once the human has crossed the gate themselves.
 * See docs/GATED_HANDOFF_ARCHITECTURE.md §3 and §9.
 *
 * WHY A CANONICAL FIELD SET EXISTS HERE
 * buildAnswers() in applyAutomation.js is FIELD-DRIVEN: provenance describes how a value was matched
 * to a control that discovery actually found. That is the right design for a reachable form and it is
 * useless behind a login wall, where discovery finds nothing — so a gated run would produce a packet
 * of zero answers with zero provenance, which is the same mistake §7 warns about for empty schemas:
 * an asset that caches the absence of information.
 *
 * So a gated packet resolves the SAME buildAnswers() against a canonical set of questions portals ask
 * — the ones the profile can answer without having seen the form. Provenance stays real and per-field:
 * it reports whether each value came from a handler map, the field map, the user's own custom answer,
 * or nothing at all. There is no second resolver, and no invented confidence.
 *
 * When the gate appears on a page where fields WERE discovered (a form and a sign-in prompt on the
 * same page, which Workday does), the real resolved answers are strictly better evidence and are used
 * instead. G4's captured schemas replace the canonical set with the host's actual form, and this same
 * path then produces a pre-mapped packet with no change here.
 *
 * UNMAPPED IS A RESULT, NOT A GAP. A canonical question the profile cannot answer is recorded with
 * provenance null and listed in `unresolved`. That is advance notice that the human will have to
 * answer it, which is worth more before they open the portal than after.
 */

import crypto from "node:crypto";
import {
  buildAnswers, CONFIDENCE_BY_PROVENANCE, ELIGIBILITY_HANDLERS, PROFILE_KEY_TO_HANDLER,
} from "./applyAutomation.js";

// ── Canonical questions ──────────────────────────────────────────────────────────────────────
// Shaped exactly like discoverFields() output, because buildAnswers() consumes that shape and this
// must not become a second dialect of it. handler_type is what carries the resolution signal, so
// these are the handler types the profile is able to answer; `label` is present because
// buildAnswers' custom_answers path matches on label text.
//
// Deliberately NOT exhaustive of what portals ask. It is the set the server can answer from the
// profile alone; anything else is the human's to answer, and saying so in advance is the point.
// handler_type values are taken from PROFILE_KEY_TO_HANDLER, not invented. They have to be the exact
// strings buildAnswers looks up ('address1' not 'address-line-1', 'zip' not 'postal-code',
// 'work-auth' not 'work-authorization', 'sponsorship' not 'requires-sponsorship'); a near-miss
// resolves nothing and the packet would silently come back empty with every field "unresolved".
export const CANONICAL_GATE_FIELDS = Object.freeze([
  { field_id: "g_first_name",    name: "first_name",     label: "First Name",        type: "text",  handler_type: "first-name",      is_required: true  },
  { field_id: "g_last_name",     name: "last_name",      label: "Last Name",         type: "text",  handler_type: "last-name",       is_required: true  },
  { field_id: "g_full_name",     name: "full_name",      label: "Full name",         type: "text",  handler_type: "full-name",       is_required: false },
  { field_id: "g_email",         name: "email",          label: "Email",             type: "email", handler_type: "email",           is_required: true  },
  { field_id: "g_phone",         name: "phone",          label: "Phone",             type: "tel",   handler_type: "phone",           is_required: false },
  { field_id: "g_address1",      name: "address1",       label: "Address",           type: "text",  handler_type: "address1",        is_required: false },
  { field_id: "g_city",          name: "city",           label: "City",              type: "text",  handler_type: "city",            is_required: false },
  { field_id: "g_state",         name: "state",          label: "State",             type: "text",  handler_type: "state",           is_required: false },
  { field_id: "g_zip",           name: "zip",            label: "Postal Code",       type: "text",  handler_type: "zip",             is_required: false },
  { field_id: "g_country",       name: "country",        label: "Country",           type: "text",  handler_type: "country",         is_required: false },
  { field_id: "g_linkedin",      name: "linkedin",       label: "LinkedIn Profile",  type: "url",   handler_type: "linkedin",        is_required: false },
  { field_id: "g_website",       name: "website",        label: "Website",           type: "url",   handler_type: "website",         is_required: false },
  { field_id: "g_current_co",    name: "current_company",label: "Current company",   type: "text",  handler_type: "current-company", is_required: false },
  { field_id: "g_current_title", name: "current_title",  label: "Current title",     type: "text",  handler_type: "current-title",   is_required: false },
  // Eligibility. Attestations to an employer, which is why G3 pins them to the top of the review
  // overlay regardless of confidence — see §6. The labels are the real question wording rather than
  // a short name, because buildAnswers' eligibility guards read the LABEL to decide the question's
  // sense; a bare "Sponsorship" would be exactly the unreadable direction they refuse.
  { field_id: "g_work_auth",   name: "work_authorization",   type: "select", handler_type: "work-auth",    is_required: true,
    label: "Are you legally authorized to work in the country of employment?" },
  { field_id: "g_sponsorship", name: "requires_sponsorship", type: "select", handler_type: "sponsorship",  is_required: true,
    label: "Do you now or in the future require sponsorship for work authorization?" },
]);

/**
 * Eligibility markers, derived from the codebase's own vocabulary rather than restated. G3 sorts on
 * this and §6 requires these surface first, so a hand-written list that drifted out of sync would
 * silently demote an attestation to an ordinary field.
 *
 * BOTH handler types and profile keys are included, because `matched_on` is whichever one actually
 * resolved the answer: buildAnswers step 1 records the handler type, step 2 records the profile key.
 * Checking only handler types would miss every eligibility answer that resolved through the field
 * map — which, per HANDLER_TO_PROFILE_KEYS' own comment, is the path canonical keys take.
 */
export const ELIGIBILITY_MARKERS = Object.freeze(new Set([
  ...Object.values(ELIGIBILITY_HANDLERS).flat(),
  ...Object.entries(PROFILE_KEY_TO_HANDLER)
    .filter(([, handler]) => Object.values(ELIGIBILITY_HANDLERS).flat().includes(handler))
    .map(([key]) => key),
]));

/** True when an answer is an attestation to an employer rather than form-filling convenience. */
export function isEligibilityAnswer(a) {
  return ELIGIBILITY_MARKERS.has(String(a?.handler_type ?? ""))
      || ELIGIBILITY_MARKERS.has(String(a?.matched_on ?? ""))
      || ELIGIBILITY_MARKERS.has(String(a?.name ?? ""));
}

// ── Packet ───────────────────────────────────────────────────────────────────────────────────

/**
 * Normalise one resolved answer into the packet's per-field shape.
 * Confidence is derived from provenance through the SAME table the apply path uses, so a packet and
 * a submitted application cannot disagree about what a given provenance tier is worth.
 */
function toPacketAnswer(a) {
  const provenance = a.provenance ?? null;
  return {
    field:      a.label || a.name || a.field_id || null,
    name:       a.name ?? null,
    field_id:   a.field_id ?? null,
    type:       a.type ?? null,
    value:      a.value ?? null,
    provenance,
    // Never invented: an answer with no provenance has no confidence, rather than a default that
    // would read as a weak-but-real signal.
    confidence: provenance ? (CONFIDENCE_BY_PROVENANCE[provenance] ?? null) : null,
    matched_on: a.matched_on ?? null,
    // buildAnswers emits `required`; the canonical field set declares `is_required`. Read both,
    // or every real answer arrives as optional.
    is_required: (a.required ?? a.is_required) === true,
    handler_type: a.handler_type ?? null,
    eligibility: isEligibilityAnswer(a),
  };
}

/**
 * Build the packet body for a gated run.
 *
 * @param {object}   opts
 * @param {Array}    opts.resolvedAnswers  what autoApply's resolver produced, if the form was reachable
 * @param {object}   opts.autofillPayload  the profile payload (field_map / handler_map / custom_answers)
 * @param {string}   opts.applyUrl         where the human has to go — the URL the gate was observed at
 * @param {string}   opts.jobId
 * @param {number?}  opts.runId
 * @param {number?}  opts.runJobId
 * @param {number?}  opts.resumeArtifactId
 * @param {string}   opts.gateReason       'login_required' | 'captcha_required'
 * @returns {{ expectedOrigin, applyUrl, answers, unresolved, source, ... }}
 */
export function buildGatePacket({
  resolvedAnswers = [],
  autofillPayload = {},
  applyUrl,
  jobId,
  runId = null,
  runJobId = null,
  resumeArtifactId = null,
  gateReason = "login_required",
} = {}) {
  const expectedOrigin = originOf(applyUrl);
  if (!expectedOrigin) {
    // Refuse rather than store a packet nothing can target-match. A packet with no expected origin
    // could only be released by trusting the page it landed on, which is the leak §5 describes.
    const err = new Error(`gate packet needs a parseable apply URL, got: ${applyUrl}`);
    err.reasonCode = "gate_packet_unparseable_url";
    throw err;
  }

  // Prefer what the resolver actually matched against a real form; fall back to the canonical set.
  // `skipped` answers carry no value and are not answers — they are the resolver's refusals, and
  // counting them as resolved would overstate what is prepared.
  const real = (Array.isArray(resolvedAnswers) ? resolvedAnswers : [])
    .filter(a => a && !a.skipped && a.value !== null && a.value !== undefined && a.value !== "");
  const usedCanonical = real.length === 0;
  const answers = usedCanonical
    ? buildAnswers(CANONICAL_GATE_FIELDS, autofillPayload)
    : real;

  const required = new Map(CANONICAL_GATE_FIELDS.map(f => [f.name, f.is_required]));
  const packetAnswers = answers
    .filter(a => a && !a.skipped && a.value !== null && a.value !== undefined && a.value !== "")
    .map(a => toPacketAnswer({ ...a, is_required: a.required ?? a.is_required ?? required.get(a.name) ?? false }));

  // ── NEVER MINT A PACKET WITH NOTHING TO FILL (AE2 requirement 3) ────────────────────────────
  // A packet IS the "Open & fill" promise: the panel offers that route for a row that has one, and
  // the extension's only job on the far side is to type the packet's answers into the employer's
  // form. Zero answers makes that promise unkeepable — the overlay opens, matches nothing, and
  // fills nothing, which is indistinguishable to the candidate from the extension being broken.
  // Refuse, and let the caller park the hold WITHOUT a packet: the row then offers plain "Open",
  // which is honest about what it can do. routes/apply.js already treats a throw here as a
  // degraded handoff rather than a failed run, so nothing is lost by saying so.
  if (packetAnswers.length === 0) {
    const err = new Error(
      `gate packet would carry zero answers (resolved=${real.length}, source=${usedCanonical ? "canonical_profile" : "discovered_form"})`);
    err.reasonCode = "gate_packet_no_answers";
    throw err;
  }

  // What we could NOT answer. Surfacing it here is what lets the queue say "this one will ask you
  // two questions" before the human opens the portal (the same idea as G4 requirement 4).
  const answeredNames = new Set(packetAnswers.map(a => a.name));
  const unresolved = CANONICAL_GATE_FIELDS
    .filter(f => !answeredNames.has(f.name))
    .map(f => ({
      field: f.label, name: f.name, type: f.type,
      is_required: f.is_required,
      handler_type: f.handler_type,
      eligibility: isEligibilityAnswer(f),
    }));

  return {
    version: 1,
    jobId: String(jobId),
    runId, runJobId,
    gateReason,
    applyUrl,
    expectedOrigin,
    resumeArtifactId,
    // Named so a consumer can tell a form-matched packet from a profile-only one without guessing
    // from the provenance mix. G3's overlay reads differently in each case.
    source: usedCanonical ? "canonical_profile" : "discovered_form",
    answers: packetAnswers,
    unresolved,
  };
}

/** Origin of a URL, or null when it cannot be parsed. Never throws. */
export function originOf(url) {
  try { return new URL(String(url)).origin; } catch { return null; }
}

// ── What a packet is FOR ─────────────────────────────────────────────────────────────────────
//
// A packet was built for one situation — a login wall or a CAPTCHA — and the whole handoff was
// shaped around it: a prepared answer set, a short-lived token, an activeTab grant, a provenance
// overlay, and a target match before anything is released. A HELD REVIEW is the same situation. A
// form needs a human, in the human's own browser. It was simply never routed here, so a held
// application had no route to submission at all: the filled DOM lives in a Puppeteer context that
// has already closed, and only the screenshot survived it.
//
// The two kinds differ in ONE way, and it is a presentation fact rather than a security one:
//
//   GATE CROSSING   one action (a sign-in) unblocks EVERY application queued behind that origin,
//                   so these amortise and are grouped by PORTAL.
//   HELD REVIEW     the obstacle belongs to one application — a question only the candidate can
//                   answer, a form we would not complete on a guess — so it groups by APPLICATION.
//
// Grouping the second kind by portal would report "sign in to boards.greenhouse.io once → 4
// applications ready" over four applications that need four different answers, which is a promise
// the sign-in cannot keep.

/** Reasons where crossing the obstacle ONCE releases every application on that origin. */
export const GATE_CROSSING_REASONS = Object.freeze(new Set(["login_required", "captcha_required"]));

/**
 * Held terminal reasons that are RESUMABLE: the form was reached, answers were resolved, and a
 * human standing on the page can finish it. Each gets a packet exactly as a gate hold does.
 *
 * `awaiting_approval` is deliberately ABSENT. That application is complete and the decision is a
 * click in this product, not a form in someone else's browser — the approval flow submits it
 * server-side, and handing it off would offer a second, divergent copy of an application already
 * queued to send.
 */
export const RESUMABLE_HELD_REASONS = Object.freeze(new Set([
  "manual_review",                  // the form asked something only the candidate can answer
  "low_confidence_answers",         // we had a guess and would not send a guess
  "incomplete_form",                // required fields we would not fill
  "answers_changed_since_approval", // the form moved after approval; the candidate re-reads it
  "no_submit_button",               // filled, and nothing we could find would send it
  "submit_unverified",              // submit was clicked and the page never confirmed
  "ats_below_threshold",            // held on the score; the candidate may send it anyway
  "resume_unavailable",             // nothing to attach — resumable once that is fixed
  "full_auto_disabled",             // policy held it; the human is the intended route
  "provider_review_only",           // this provider is never submitted unattended
  "daily_cap_reached",              // the cap is ours, not the employer's
]));

/**
 * Statuses whose terminal rows are handed off. `held_gate` is the original G1 case; `held_review` is
 * AB1's. Both mean "a form needs a human", which is the only precondition the handoff has.
 */
export const HANDOFF_STATUSES = Object.freeze(new Set(["held_gate", "held_review"]));

/** Which kind of handoff a stored packet is, from its reason alone. */
export function handoffKind(gateReason) {
  return GATE_CROSSING_REASONS.has(String(gateReason)) ? "gate" : "review";
}

/**
 * Should a terminal run-job get a packet?
 *
 * Gates always do. A held review does when its reason is one a human can actually finish — holding
 * out `awaiting_approval` (which has its own surface) and anything we have not described, because a
 * packet nobody can act on is a row in a queue that never empties.
 */
export function shouldBuildPacket({ status, reasonCode }) {
  if (!HANDOFF_STATUSES.has(String(status))) return false;
  if (String(status) === "held_gate") return true;
  return RESUMABLE_HELD_REASONS.has(String(reasonCode));
}

// ── Staleness ────────────────────────────────────────────────────────────────────────────────
//
// AB1 requirement 5. A packet is a snapshot of a decision, and the world moves: a posting closes, a
// form is re-versioned, salary expectations change. Filling a three-day-old answer set into a form
// silently is worse than refusing, because the candidate cannot tell it happened.
//
// This is NOT the token TTL, and the two must not be confused. The token's ten minutes protect a
// home address in flight between mint and release. This protects the ANSWERS' relevance, and is
// measured in days because that is the timescale on which a prepared application goes off.
export const PACKET_STALE_MS = 72 * 60 * 60 * 1000;

/**
 * How old a packet is and whether it may still be filled.
 * @param {number} createdAtMs  epoch ms
 * @returns {{ ageMs: number, stale: boolean }}
 */
export function packetFreshness(createdAtMs, now = Date.now()) {
  const ageMs = Math.max(0, now - Number(createdAtMs || 0));
  return { ageMs, stale: ageMs > PACKET_STALE_MS };
}

// ── Token ────────────────────────────────────────────────────────────────────────────────────
// HMAC over a compact payload, not a random opaque id, so the binding to (user, job, packet) travels
// WITH the token and is checked before the database is touched. A random id would have to be looked
// up first, which makes an enumeration attempt indistinguishable from a legitimate miss.
//
// Only the HASH of the token is stored, so a database read cannot yield a usable credential.

const TOKEN_VERSION = 1;
/** Minutes, not hours (G1 requirement 3): this unlocks a home address and eligibility answers. */
export const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sign(payloadB64, secret) {
  return crypto.createHmac("sha256", String(secret)).update(payloadB64).digest("base64url");
}

/** sha256 of the whole token. What the row stores. */
export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Mint a token bound to one user, one job and one packet row.
 * @returns {{ token, tokenHash, expiresAt }}  expiresAt in epoch SECONDS, matching the schema
 */
export function mintPacketToken({ secret, userId, jobId, packetId, ttlMs = DEFAULT_TOKEN_TTL_MS, now = Date.now() }) {
  if (!secret) {
    const err = new Error("cannot mint a gate packet token without a server secret");
    err.reasonCode = "gate_token_no_secret";
    throw err;
  }
  const expMs = now + ttlMs;
  const payload = { v: TOKEN_VERSION, pid: Number(packetId), uid: Number(userId), jid: String(jobId), exp: expMs };
  const payloadB64 = b64url(JSON.stringify(payload));
  const token = `${payloadB64}.${sign(payloadB64, secret)}`;
  return { token, tokenHash: hashToken(token), expiresAt: Math.floor(expMs / 1000) };
}

/**
 * Verify signature, shape and expiry. Does NOT touch the database — single-use is enforced there.
 *
 * Failure reasons are kept DISTINCT (G1 requirement 4): a malformed token, a forged one, an expired
 * one and one belonging to another account are four different events, and collapsing them into a
 * generic 400 would hide the only one that indicates an attack.
 *
 * @returns {{ ok: true, payload } | { ok: false, reason: string }}
 */
export function verifyPacketToken(token, { secret, now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (typeof token !== "string" || !token) return { ok: false, reason: "token_malformed" };

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "token_malformed" };
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  const expectedSig = sign(payloadB64, secret);
  // Constant-time: a length mismatch is compared as a mismatch rather than short-circuiting, so the
  // comparison does not leak how much of a forged signature was correct.
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "token_invalid" };

  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")); }
  catch { return { ok: false, reason: "token_malformed" }; }

  if (payload?.v !== TOKEN_VERSION) return { ok: false, reason: "token_version" };
  if (!Number.isInteger(payload.pid) || !Number.isInteger(payload.uid) || !payload.jid) {
    return { ok: false, reason: "token_malformed" };
  }
  if (!Number.isFinite(payload.exp) || payload.exp <= now) return { ok: false, reason: "token_expired" };

  return { ok: true, payload };
}
