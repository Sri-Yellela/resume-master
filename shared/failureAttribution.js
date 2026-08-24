// shared/failureAttribution.js
// PURPOSE: Turn a thrown error into a reason code that names the SUBSYSTEM THAT ACTUALLY FAILED.
//
// WHY THIS FILE EXISTS: a run against an OpenAI Ashby URL reported "Failed / browser error" when
// the browser had worked perfectly — it navigated, recorded a full 7-column audit, and completed
// autofill. What failed was an Anthropic API call: 404 not_found_error on a retired model ID.
// The label sent a debugging session into services/browserLauncher.js, which was never involved.
//
// The rule: never let a catch-all name a subsystem. If we cannot attribute a failure, say
// "internal_error" — an honest unknown beats a confident wrong answer, because a wrong answer
// is what people go and debug.

// Anthropic/HTTP statuses that will NEVER succeed on retry. A 404 on a model name is the
// canonical case: the model does not exist, so retrying burns time and money to fail identically.
const PERMANENT_HTTP = new Set([400, 401, 403, 404, 413, 422]);
// Genuinely transient: worth a retry, with backoff.
const TRANSIENT_HTTP = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/**
 * Classify a failure from the resume-generation path (an Anthropic SDK error, usually).
 * Returns a structured record instead of the bare `e.message` the old code kept, so the run row
 * can preserve the upstream status, error type and request_id — the things you need to file a
 * bug or spot a config problem — rather than flattening them into one string.
 */
export function classifyGenerationError(e) {
  const status = e?.status ?? e?.statusCode ?? null;
  const message = String(e?.message || e || "unknown error");
  const lower = message.toLowerCase();

  // OUR REFUSAL, NOT THE API'S (AF2). The generation-time claim guard throws when the output would
  // have overstated the candidate's experience. Classifying that as "upstream generation error"
  // would be a false statement about whose fault it was, and would hide a safety event behind a
  // generic failure — the candidate should see that a resume was withheld and why.
  //
  // Retryable on purpose: the generator is stochastic, so the next attempt may well come back
  // honest. It is the SUBMISSION that must never happen, not the retry.
  if (e?.code === "resume_claim_violation") {
    return {
      code: "resume_claim_violation",
      permanent: false,
      status: null,
      apiType: null,
      requestId: null,
      isDeadModel: false,
      message,
      detail: [
        "the generated resume contradicted your own profile, so it was NOT saved or sent",
        ...(Array.isArray(e.violations) ? e.violations.map(v => v.message) : []),
      ].join(" | ").slice(0, 600),
    };
  }

  // The SDK puts the parsed JSON body on e.error; request_id is a top-level property.
  const apiType = e?.error?.error?.type ?? e?.error?.type ?? null;
  const requestId = e?.request_id ?? e?.requestID ?? null;

  let permanent;
  if (status != null && PERMANENT_HTTP.has(status)) permanent = true;
  else if (status != null && TRANSIENT_HTTP.has(status)) permanent = false;
  else if (lower.includes("timeout") || lower.includes("econnreset") || lower.includes("enotfound")) permanent = false;
  // Unknown failures are treated as transient: assuming "permanent" would let a blip
  // permanently mark a job unapplyable, which is the more damaging mistake.
  else permanent = false;

  // A 404 whose body says not_found_error on a request that names a model is almost always a
  // dead/retired model ID. Call that out by name — it is a config bug, not a job-specific one.
  const isDeadModel = status === 404 && (apiType === "not_found_error" || lower.includes("not_found_error"));

  return {
    code: "generation_failed",
    permanent,
    status,
    apiType,
    requestId,
    isDeadModel,
    message,
    // One line that survives into reason_detail and the event log, so the next person sees the
    // upstream fact without digging through the event stream.
    detail: [
      isDeadModel ? "upstream model rejected (dead/retired model id)" : "upstream generation error",
      status != null ? `http=${status}` : null,
      apiType ? `type=${apiType}` : null,
      requestId ? `request_id=${requestId}` : null,
      permanent ? "permanent=yes (retry will fail identically)" : "permanent=no (retryable)",
      message.slice(0, 300),
    ].filter(Boolean).join(" | "),
  };
}

// Substrings that genuinely indicate the BROWSER failed. Kept deliberately narrow: anything not
// matched here is not called a browser problem.
const BROWSER_SIGNATURES = [
  "net::", "err_", "navigation", "page.goto", "target closed", "session closed",
  "browser has disconnected", "protocol error", "execution context was destroyed",
  "waiting for selector", "waiting for locator", "frame was detached",
];

/**
 * Classify a failure caught by autoApply()'s outer try/catch.
 *
 * Previously this catch defaulted every unrecognised error to "browser_error", so an API failure,
 * a bug in our own code, and a real navigation failure were indistinguishable in the status.
 */
export function classifyRuntimeError(e) {
  // An error that already carries a reasonCode has been attributed by the code that threw it;
  // that attribution always wins.
  if (e?.reasonCode) return { reasonCode: e.reasonCode, permanent: null, detail: e?.reasonDetail || null };

  const message = String(e?.message || e || "");
  const lower = message.toLowerCase();
  const status = e?.status ?? e?.statusCode ?? null;

  // An upstream API error surfacing here is NOT a browser fault — this is the exact
  // misattribution that started this.
  if (status != null || lower.includes("anthropic") || lower.includes("not_found_error")) {
    const g = classifyGenerationError(e);
    return { reasonCode: "upstream_api_error", permanent: g.permanent, detail: g.detail };
  }

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { reasonCode: "browser_timeout", permanent: false, detail: message.slice(0, 300) };
  }

  if (BROWSER_SIGNATURES.some(sig => lower.includes(sig))) {
    return { reasonCode: "browser_error", permanent: false, detail: message.slice(0, 300) };
  }

  // Unattributable. Say so honestly rather than blaming the browser.
  return { reasonCode: "internal_error", permanent: null, detail: message.slice(0, 300) };
}
