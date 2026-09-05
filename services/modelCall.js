// services/modelCall.js
// PURPOSE: The ONE path every Anthropic model call goes through, so that calling a model and
// recording what it cost cannot come apart.
//
// WHY THIS FILE EXISTS: an audit found cost observability covered 4 of 14 call sites. The other
// 10 — including per-job enrichment across hundreds of rows and three UNAUTHENTICATED standalone
// endpoints — spent real money and recorded nothing. The admin cost panel was not empty; it was
// confidently wrong, showing a total that omitted most of the traffic. A partial number nobody
// knows is partial is worse than no number.
//
// A wrapper alone would rot exactly the way the hardcoded model IDs did, so it ships with an
// absence guard (test/modelCallGuard.test.js) that fails the build if a bare
// anthropic.messages.create appears anywhere outside this module.
//
// TO ADD A CALL SITE: call callModel({ anthropic, db, model, purpose, userId, ...params }).
// `purpose` is required and should be a stable snake_case feature name — it is what lets spend be
// grouped by feature rather than only by model.

import { trackApiCall } from "./usageTracker.js";
import { DATA_CLASS, PROVIDER, PROVIDERS, resolveProvider } from "../shared/modelProviders.js";
import { assertOutboundFields } from "../shared/piiPolicy.js";
import { callProvider } from "./providerTransport.js";

// ── ROUTING ─────────────────────────────────────────────────────────────────────────────────────
//
// ROUTE BY WHOSE DATA IT IS, NOT BY WHAT A FILTER FINDS IN THE STRING. "Did the regex catch every
// email in this resume" is not a checkable property; "does this call site send job-advert text or
// person text" is, and a test can assert it per site.
//
// PUBLIC   — job descriptions, titles, requirements: text a company published about itself.
//            enrich_job (60.2% of all spend), classify_job, import_job.
// CANDIDATE — anything derived from a person. resume_generate, enhanceProfileResume, parse-pdf,
//            cover letters, domainProfiles suggestions. These stay on Anthropic. Redaction is NOT
//            part of this: a call site either sends public text or it does not.
//
// ⛔ THE DEFAULT IS CANDIDATE. A call site that declares nothing stays on Anthropic. That is the
// whitelist direction and it is the whole safety property here — a blacklist would mean that
// forgetting to annotate a new resume-touching site silently routes a person's home address and
// work authorisation to a free tier that may train on it. Forgetting to annotate a public site
// costs a fraction of a cent.

/** Warned reasons, so a fallback is loud ONCE per process rather than 1302 times per pass. */
const warnedFallbacks = new Set();

function warnFallbackOnce(reason, detail) {
  if (warnedFallbacks.has(reason)) return;
  warnedFallbacks.add(reason);
  console.warn(
    `[modelCall] PUBLIC traffic is NOT using a free tier — falling back to Anthropic. ` +
    `Reason: ${reason}. ${detail || ""} ` +
    `This warns once per process; every subsequent PUBLIC call takes the same fallback.`
  );
}

/** Test seam — the warn-once set is process-global and would hide a second test's warning. */
export function resetRoutingWarnings() {
  warnedFallbacks.clear();
}

/**
 * Decide which provider and model a call uses. Exported for testing; nothing else may call it,
 * because a second consumer is a second routing path and this must have exactly one.
 *
 * @returns {{ provider: string, model: string }}
 */
export function routeFor({ dataClass, model, env = process.env } = {}) {
  // TOKENIZED is routable for the same reason PUBLIC is: what leaves carries no identity. The
  // difference is that PUBLIC is safe by WHERE THE TEXT CAME FROM, while TOKENIZED is safe only
  // because callModel refuses to send it unless the whitelist assertion passes — see the guard in
  // callModel below, which is the thing that makes this class meaningful.
  if (dataClass !== DATA_CLASS.PUBLIC && dataClass !== DATA_CLASS.TOKENIZED) {
    return { provider: PROVIDER.ANTHROPIC, model };
  }

  // Throws on an unpinned ENRICH_MODEL, deliberately — see requirement 6 in shared/modelProviders.js.
  const resolved = resolveProvider(env);
  if (resolved.provider === PROVIDER.ANTHROPIC) {
    // UNCONFIGURED MUST BE LOUD. cacheJoboFeed logged "sync complete — 0 jobs cached" for months on
    // exactly this shape: a missing key producing a quiet no-op that reads as success.
    // `not_configured` is the honest default and is not a defect, so it does not warn.
    if (resolved.reason !== "not_configured") warnFallbackOnce(resolved.reason, resolved.detail);
    return { provider: PROVIDER.ANTHROPIC, model };
  }
  return { provider: resolved.provider, model: resolved.model };
}

// Background work — enrichment, import extraction, job classification, and the unauthenticated
// standalone endpoints — has no user in scope, but usage_events.user_id is NOT NULL REFERENCES
// users(id). id 0 can never collide with a real account because users.id is AUTOINCREMENT and
// starts at 1.
//
// It is NOT a bare sentinel: migration 075 inserts an actual 'system' users row for it.
// better-sqlite3 turns foreign_keys ON by default (no PRAGMA in this codebase — the default
// does it), so an id with no matching row is rejected outright. A real run proved that: every
// background insert failed with "FOREIGN KEY constraint failed", which would have left the
// single largest untracked spender still untracked while everything looked wired up.
export const SYSTEM_USER_ID = 0;

/**
 * Invoke a model and record its usage. Returns the message UNCHANGED, so adopting this at an
 * existing call site is a one-line edit and nothing downstream has to know.
 *
 * Failures are recorded too (success=0 with the upstream message). That is deliberate: the dead
 * claude-sonnet-4 model ID 404'd on every call for two months while the cost table simply showed
 * nothing, because a call that throws never reached the tracking line. A failed call is a fact
 * worth having. It does not affect quotas — services/limitEnforcer.js counts `success = 1` only.
 */
export async function callModel({
  anthropic,
  db,
  model,
  purpose,
  userId = SYSTEM_USER_ID,
  eventType = null,
  eventSubtype = null,
  jobId = null,
  company = null,
  domainModule = null,
  atsScoreBefore = null,
  atsScoreAfter = null,
  // AK1 — receives the usage_events row id once the call has been recorded.
  //
  // A CALLBACK RATHER THAN A RETURN VALUE, because callModel returns the model's message and every
  // one of its ~20 call sites destructures that. Changing the return shape to hand back an id that
  // exactly one caller wants would touch all of them. This fires from the same `finally` that
  // records the row, so it runs on success AND on failure, and a throwing callback cannot escape
  // into the caller's error path.
  onTracked = null,
  // WHOSE DATA THIS CALL SENDS. See the routing note at the top of this file. Defaults to
  // CANDIDATE so an unannotated site can never be routed off Anthropic by accident.
  dataClass = DATA_CLASS.CANDIDATE,
  // TASK F — the STRUCTURED payload a TOKENIZED prompt was rendered from. Required for that class
  // and asserted field-by-field against shared/piiPolicy.js before anything is sent. Not forwarded
  // to any provider; it exists to be checked.
  piiFields = null,
  ...params
} = {}) {
  if (!purpose) throw new Error("callModel: `purpose` is required — it is how spend is attributed to a feature");
  if (!model) throw new Error(`callModel(${purpose}): no model — import MODEL_SONNET/MODEL_HAIKU from shared/anthropicModels.js`);

  // Resolved BEFORE the timer and outside the try, because an unpinned ENRICH_MODEL is a config
  // error rather than a call: no request is made, so no usage row should be written for it.
  const route = routeFor({ dataClass, model });

  // ── TASK F: THE FIELD-LEVEL WHITELIST ASSERTION ON THE OUTBOUND PAYLOAD ────────────────────────
  //
  // Enforced HERE, in the one wrapper every call passes through, rather than at the call site that
  // built the payload — a guard living next to the code it guards is a guard that gets edited in
  // the same commit as the mistake.
  //
  // ⛔ IT REFUSES, IT DOES NOT SANITISE. Dropping the offending field would mean the send succeeds
  // and nobody ever learns the payload was wrong; the next payload built the same way would be
  // wrong too, silently. Refusing is the only outcome a caller cannot ignore.
  //
  // A TOKENIZED call with no declared fields is also refused: the class asserts a property, and a
  // call claiming it without supplying anything to check is claiming it vacuously.
  if (dataClass === DATA_CLASS.TOKENIZED) {
    if (!piiFields || typeof piiFields !== "object") {
      throw new Error(
        `callModel(${purpose}): dataClass TOKENIZED requires \`piiFields\` — the structured payload ` +
        `the prompt was rendered from. Without it there is nothing to assert, and the class would ` +
        `be a label rather than a guarantee.`
      );
    }
    assertOutboundFields(piiFields, { where: `callModel(${purpose})` });
  }
  // Only the Anthropic route needs the SDK client. Checked after routing so a PUBLIC-only pass is
  // not blocked by an absent Anthropic client it was never going to use.
  if (route.provider === PROVIDER.ANTHROPIC && !anthropic) throw new Error(`callModel(${purpose}): no anthropic client`);

  const startedAt = Date.now();
  let message = null;
  let success = true;
  let errorText = null;

  try {
    message = route.provider === PROVIDER.ANTHROPIC
      ? await anthropic.messages.create({ model: route.model, ...params })
      // Returns an Anthropic-SHAPED message, so every caller's `.content.map(b => b.text)` and
      // `.usage.input_tokens` keep working and routing stays a concern of this file alone.
      : await callProvider({
          provider: route.provider,
          apiKey: process.env[PROVIDERS[route.provider].envKey],
          params: { model: route.model, ...params },
        });
    return message;
  } catch (e) {
    success = false;
    errorText = String(e?.message ?? e).slice(0, 500);
    throw e;
  } finally {
    // `finally` so a throw is still recorded, and so a tracking problem can never swallow the
    // model's own result or error — trackApiCall catches internally and counts its own failures.
    if (db) {
      const eventId = trackApiCall(db, {
        userId,
        // event_type keeps its existing vocabulary because limitEnforcer keys quotas on it;
        // purpose is the new, always-populated feature name. Sites that had no event_type before
        // fall back to purpose so the column is never empty for a new row.
        eventType: eventType || purpose,
        eventSubtype,
        purpose,
        // THE MODEL ACTUALLY CALLED, not the one the call site asked for — they differ whenever a
        // PUBLIC site is routed. Recording the requested one would make cost reconcile against a
        // model that was never invoked.
        model: route.model,
        provider: route.provider,
        usage: message?.usage || {},
        durationMs: Date.now() - startedAt,
        jobId,
        company,
        domainModule,
        atsScoreBefore,
        atsScoreAfter,
        success,
        errorText,
      });
      if (typeof onTracked === "function") {
        // Swallowed on purpose. This is a measurement hook; it may not turn a successful
        // generation into a failure, nor replace the model's own error with its own.
        try { onTracked(eventId); } catch (hookError) {
          console.error(`[modelCall] onTracked hook threw for ${purpose}: ${hookError.message}`);
        }
      }
    }
  }
}
