// T19 hardening (draft's G1, 10-30) · IS THE MODEL KEY ACCEPTED — asked at boot and once a day, said in one line.
//
// 10-15: the key on this service was created outside a workspace, and Anthropic refused every request with it. This
// service makes no model call at boot, so the first anyone heard of it was a user's failed generation. Now the cheapest
// authenticated call (GET /v1/models, one row — no tokens, nothing billed) answers at boot and daily, in the boot log:
// { boot: "model_key_check", state: "ok" | "failed" | "unreachable", reason }.
//
// ⛔ Nothing here prints a key or a workspace id: the reason is Anthropic's own message with anything key-shaped masked.
// (draft has the same check in services/modelKeyCheck.js; the two services share no code.)

/** Anthropic's reason, one line, ≤ 200 chars, with anything that looks like a key or an id masked. */
export function safeReason(e) {
  const raw = String(e?.error?.error?.message || e?.error?.message || e?.message || e || "unknown").replace(/\s+/g, " ").trim();
  return raw.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…").replace(/\bwrkspc_[A-Za-z0-9_-]+/g, "wrkspc_…").slice(0, 200);
}

/**
 * Ask once. → { state: 'ok' | 'failed' | 'unreachable' | 'unconfigured', reason, status }
 *   failed       Anthropic ANSWERED and refused the key (400 / 401 / 403) — a configuration fault; a retry cannot fix it
 *   unreachable  a timeout, a network error or a 5xx — evidence about the network, not the key
 */
export async function checkModelKey(client, { timeoutMs = 10_000 } = {}) {
  if (!client) return { state: "unconfigured", reason: "no key", status: null };
  let timer;
  try {
    await Promise.race([
      client.models.list({ limit: 1 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
    return { state: "ok", reason: null, status: 200 };
  } catch (e) {
    const status = e?.status ?? null;
    if (status === 400 || status === 401 || status === 403) return { state: "failed", reason: safeReason(e), status };
    return { state: "unreachable", reason: safeReason(e), status };
  } finally { clearTimeout(timer); }
}

export const KEY_CHECK_EVERY_MS = 24 * 3600_000;
