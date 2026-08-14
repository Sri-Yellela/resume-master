// services/trackingFailureWebhook.js
// PURPOSE: The fourth and last tier. When a tracking failure reached NEITHER the database NOR the
// out-of-process sink — the filesystem was unwritable too — this gets the fact off the box, so it
// is not only an error log line on a host nobody is reading.
//
// OPT-IN. With USAGE_FAILURE_WEBHOOK_URL unset this module is completely inert: no timers, no
// sockets, no behaviour change. That is deliberate. This is the only tier that touches the network,
// and it sits in a path that runs because something is already broken, so it must not be able to
// make things worse.
//
// Four rules it follows, in order of importance:
//   1. NEVER throw, and never block. trackApiCall is synchronous and a model result is already
//      owed to a caller, so the POST is fire-and-forget with a hard timeout. Nothing awaits it.
//   2. NEVER flood. If the database and the filesystem are both down, EVERY call fails, so an
//      unthrottled webhook would turn one outage into an outbound request per model call.
//      Suppressed sends are counted, not silently dropped.
//   3. NEVER retry. A retry loop in a failure path is how an outage becomes an incident. One
//      attempt per failure; the counters record what happened.
//   4. NEVER carry prompt content. The payload is metadata only — model, purpose, user id, error —
//      which is exactly what the sink record already holds. No message text, no resume text.
//
// HONEST LIMIT: fire-and-forget means an in-flight POST dies with the process, and delivery is
// never confirmed to the caller. This is a best-effort notification, not a guarantee, and
// routes/admin.js reports it as such.

const TIMEOUT_MS = 5000;
// At most this many sends per window. Sized for "tell me something is wrong", not for volume.
const MAX_PER_WINDOW = 10;
const WINDOW_MS = 60_000;

const state = {
  sent: 0,
  failed: 0,
  suppressed: 0,
  lastError: null,
  lastSentAt: null,
  windowStartedAt: 0,
  windowCount: 0,
};

export function webhookUrl() {
  const raw = (process.env.USAGE_FAILURE_WEBHOOK_URL || "").trim();
  return raw || null;
}

export function isConfigured() {
  return webhookUrl() !== null;
}

/** Status for the admin coverage report. */
export function getWebhookStats() {
  const url = webhookUrl();
  return {
    configured: url !== null,
    // Host only. The URL can legitimately contain a token in its path or query, and echoing that
    // into an admin API response would be a needless way to leak it.
    target: url ? safeHost(url) : null,
    sent: state.sent,
    failed: state.failed,
    suppressed: state.suppressed,
    lastError: state.lastError,
    lastSentAt: state.lastSentAt,
  };
}

/** Test seam only. */
export function resetWebhookStats() {
  state.sent = 0;
  state.failed = 0;
  state.suppressed = 0;
  state.lastError = null;
  state.lastSentAt = null;
  state.windowStartedAt = 0;
  state.windowCount = 0;
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return "(unparseable)"; }
}

function throttled(now) {
  if (now - state.windowStartedAt > WINDOW_MS) {
    state.windowStartedAt = now;
    state.windowCount = 0;
  }
  if (state.windowCount >= MAX_PER_WINDOW) return true;
  state.windowCount++;
  return false;
}

/**
 * Notify, best effort. Returns synchronously — the POST continues in the background.
 * Returns 'disabled' | 'throttled' | 'attempted' | 'invalid_url' so the caller can count without
 * waiting for delivery.
 */
export function notifyLostFailure(record) {
  const url = webhookUrl();
  if (!url) return "disabled";

  let parsed;
  try { parsed = new URL(url); } catch { state.lastError = "USAGE_FAILURE_WEBHOOK_URL is not a valid URL"; return "invalid_url"; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    state.lastError = `USAGE_FAILURE_WEBHOOK_URL must be http(s), got ${parsed.protocol}`;
    return "invalid_url";
  }

  if (throttled(Date.now())) {
    state.suppressed++;
    return "throttled";
  }

  // Metadata only — deliberately the same shape the sink writes, minus anything from a prompt.
  const body = JSON.stringify({
    type: "usage_tracking_failure_lost",
    message: "A model call's usage could not be recorded in the database OR the local sink. " +
             "Spend happened that is not in any cost total.",
    model: record?.model ?? null,
    purpose: record?.purpose ?? null,
    user_id: record?.userId ?? null,
    error: record?.errorText == null ? null : String(record.errorText).slice(0, 500),
    persist_error: record?.persistError == null ? null : String(record.persistError).slice(0, 300),
    sink_error: record?.sinkError == null ? null : String(record.sinkError).slice(0, 300),
    at: Math.floor(Date.now() / 1000),
  });

  // No await. A hanging endpoint must not hold up a response, and AbortSignal.timeout bounds the
  // socket rather than relying on the remote end behaving.
  try {
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Never follow a redirect: an operator-configured endpoint that redirects is a
      // misconfiguration, and following it silently sends this payload somewhere else.
      redirect: "error",
    })
      .then(res => {
        if (res.ok) {
          state.sent++;
          state.lastSentAt = Math.floor(Date.now() / 1000);
        } else {
          state.failed++;
          state.lastError = `HTTP ${res.status}`;
        }
      })
      .catch(e => {
        // Swallowed on purpose. An unhandled rejection here would crash the process over a
        // notification about a logging failure.
        state.failed++;
        state.lastError = String(e?.message ?? e).slice(0, 200);
      });
  } catch (e) {
    state.failed++;
    state.lastError = String(e?.message ?? e).slice(0, 200);
  }
  return "attempted";
}
