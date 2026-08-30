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
  ...params
} = {}) {
  if (!purpose) throw new Error("callModel: `purpose` is required — it is how spend is attributed to a feature");
  if (!anthropic) throw new Error(`callModel(${purpose}): no anthropic client`);
  if (!model) throw new Error(`callModel(${purpose}): no model — import MODEL_SONNET/MODEL_HAIKU from shared/anthropicModels.js`);

  const startedAt = Date.now();
  let message = null;
  let success = true;
  let errorText = null;

  try {
    message = await anthropic.messages.create({ model, ...params });
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
        model,
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
