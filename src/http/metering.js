// Per-client accounting — built from the start, with LIMITS OFF. Decided 2026-09-27.
//
// Rate limiting and metering have to key on IDENTITY, and retrofitting identity into every call
// site after a second customer arrives is the expensive version. So every authenticated request
// already carries `req.client.id`, every model call already returns a usage record, and this module
// is the one place they meet:
//
//   · record()  emits ONE structured line per request: client, route, calls, and summed token
//               counts. Counts, never content — the same rule as the request log. With no database
//               this log line IS the ledger (Railway retains it); the caller also receives the
//               per-call records in its response and meters them itself. MCP tool calls (E1) emit
//               one line each too — calls: 0, because none of them calls a model — since MCP is the
//               first caller that can loop, and a line per call is what a future limit would count.
//   · allow()   the limit hook, called before any model spend. It returns true unconditionally while
//               limits are off, which is the decided state. Turning limits on means giving it a
//               policy — nothing at the call sites changes.
//
// ── A55 (10-02): THE POLICY, READY TO TURN ON ─────────────────────────────────────────────────────
// "Per-client accounting exists with limits OFF — turn them on before anything is public." Nothing is
// public yet (API tokens are still issued by hand, O16c), so the default stays OFF. The policy exists
// so that turning it on is a variable, not a code change: RM_LIMITS_PER_DAY="acme=50,*=200" caps each
// client's MODEL-BACKED calls per UTC day (deterministic routes are never limited — they cost
// nothing). A client with no entry and no "*" is unlimited — so "draft" stays unlimited unless named.
// Counted in memory: a restart resets the day's count, which errs toward serving.
import crypto from "node:crypto";

export function parseLimits(raw) {
  const out = new Map();
  for (const part of String(raw || "").split(",").map(s => s.trim()).filter(Boolean)) {
    const m = /^([a-z*][a-z0-9-]{0,31})=(\d+)$/.exec(part);
    if (!m) throw new Error(`RM_LIMITS_PER_DAY: malformed entry "${part.slice(0, 20)}" — expected client=N`);
    out.set(m[1], Number(m[2]));
  }
  return out;
}

// ── D21 (10-04): FREE IS NOT UNBOUNDED ───────────────────────────────────────────────────────────
// "An assistant in a loop calls a tool far more often than a human, and a zero-model endpoint still
// costs CPU." So the deterministic routes and every MCP tool call get their OWN daily cap, separate
// from the model budget above: RM_FREE_LIMITS_PER_DAY="acme=5000,*=20000", same shape, same rules (a
// client with no entry and no "*" is unlimited). Before D21 an MCP tool call was counted against the
// MODEL budget (allow), which a deterministic call never spends from.
export const parseFreeLimits = (raw) => {
  try { return parseLimits(raw); } catch (e) { throw new Error(e.message.replace("RM_LIMITS_PER_DAY", "RM_FREE_LIMITS_PER_DAY")); }
};

function dailyCounter(limits, now) {
  const enabled = !!limits && limits.size > 0;
  const used = new Map();                            // `${day}|${client}` -> calls
  return {
    enabled,
    take(clientId) {
      if (!enabled) return true;
      const cap = limits.has(clientId) ? limits.get(clientId) : limits.get("*");
      if (cap == null) return true;
      const day = new Date(now()).toISOString().slice(0, 10);
      const key = `${day}|${clientId}`;
      const n = used.get(key) || 0;
      if (n >= cap) return false;
      used.set(key, n + 1);
      if (used.size > 5000) for (const k of used.keys()) if (!k.startsWith(day)) used.delete(k);
      return true;
    },
  };
}

// ── D21: ANONYMOUS MCP — ON ONLY WITH ITS LIMITS ─────────────────────────────────────────────────
// ChatGPT's plugin directory (and any MCP host) reaches a server anonymously or through OAuth 2.1;
// a static bearer token is not an option it offers. The owner chose anonymous first, for the
// read-only, zero-model tools only (D21, 10-04). ⛔ Anonymous mode is SWITCHED ON BY ITS LIMITS:
//   RM_MCP_ANONYMOUS="perIpPerMinute=10,perIpPerDay=200,perDay=5000"
// All three are required; an absent variable leaves /mcp exactly as it was (a token or a 401), and a
// malformed or partial one refuses to boot. There is no way to open /mcp to strangers without a cap.
// The caller's address is hashed before it is held and is never logged.
const ANON_KEYS = ["perIpPerMinute", "perIpPerDay", "perDay"];
export function parseAnonymousPolicy(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const out = {};
  for (const part of text.split(",").map(s => s.trim()).filter(Boolean)) {
    const m = /^(\w+)=(\d+)$/.exec(part);
    if (!m || !ANON_KEYS.includes(m[1]) || Number(m[2]) < 1) {
      throw new Error(`RM_MCP_ANONYMOUS: malformed entry "${part.slice(0, 30)}" — expected ${ANON_KEYS.map(k => `${k}=N`).join(",")} (N ≥ 1)`);
    }
    out[m[1]] = Number(m[2]);
  }
  const missing = ANON_KEYS.filter(k => !(k in out));
  if (missing.length) throw new Error(`RM_MCP_ANONYMOUS: missing ${missing.join(", ")} — anonymous access is never uncapped`);
  return out;
}

/**
 * A one-way key for a network address: sha256(per-process random salt ‖ address), truncated. The salt
 * is created here, held only in memory and never written down, so a key cannot be turned back into the
 * address or matched across restarts. Every limiter that counts by address keys on this, never on the
 * raw address (A82) — /mcp's anonymous caps and the site's free-tool limiters alike.
 */
export function createAddressHasher() {
  const salt = crypto.randomBytes(16);
  return (ip) => crypto.createHash("sha256").update(salt).update(String(ip || "")).digest("base64url").slice(0, 22);
}

export function createAnonymousLimiter(policy, { now = () => Date.now() } = {}) {
  if (!policy) return null;
  // hashed address -> { at, n }. ⛔ Each map holds ONE window: it is emptied when its minute or UTC day
  // turns over, so a hashed address is held at most a minute (minute map) and never past the end of
  // its UTC day (day map) — a bound the privacy policy states, not a size-triggered sweep.
  const minute = new Map(), day = new Map();
  let minuteAt = null, dayAt = null;
  let total = { day: null, n: 0 };
  const keyOf = createAddressHasher();               // per process: the hash is not portable either
  const bump = (map, key, window, cap) => {
    const e = map.get(key);
    if (!e || e.at !== window) { map.set(key, { at: window, n: 1 }); return true; }
    if (e.n >= cap) return false;
    e.n++;
    return true;
  };
  return {
    policy,
    /** For the privacy bound's test: how many hashed addresses are held right now. */
    held: () => ({ minute: minute.size, day: day.size }),
    /** @returns null when allowed, else which cap refused it ("perIpPerMinute" | "perIpPerDay" | "perDay"). */
    take(ip) {
      const t = now();
      const m = Math.floor(t / 60000), d = new Date(t).toISOString().slice(0, 10);
      if (minuteAt !== m) { minute.clear(); minuteAt = m; }
      if (dayAt !== d) { day.clear(); dayAt = d; }
      if (total.day !== d) total = { day: d, n: 0 };
      if (total.n >= policy.perDay) return "perDay";
      const k = keyOf(ip);
      const dayEntry = day.get(k);
      if (dayEntry?.at === d && dayEntry.n >= policy.perIpPerDay) return "perIpPerDay";
      if (!bump(minute, k, m, policy.perIpPerMinute)) return "perIpPerMinute";
      bump(day, k, d, Infinity);
      total.n++;
      return null;
    },
  };
}

export function createMetering({ log, limits = null, freeLimits = null, now = () => Date.now() } = {}) {
  const model = dailyCounter(limits, now);
  const free = dailyCounter(freeLimits, now);
  return {
    limitsEnabled: model.enabled,
    freeLimitsEnabled: free.enabled,
    allow(clientId, _route) {
      return model.take(clientId);                   // ⛔ OFF unless RM_LIMITS_PER_DAY says otherwise
    },
    // D21: deterministic routes and MCP tool calls. OFF unless RM_FREE_LIMITS_PER_DAY says otherwise.
    allowFree(clientId, _route) {
      return free.take(clientId);
    },
    // `extra` carries content-free labels only — the MCP path passes { via: "mcp", result } so a tool
    // call is accounted for even though it spends nothing (calls: 0 — no model was called).
    record(clientId, route, usage = [], extra = {}) {
      const sum = (k) => usage.reduce((n, u) => n + (Number(u?.[k]) || 0), 0);
      log({
        ...extra,
        metering: true, client: clientId, route,
        calls: usage.length,
        failed_calls: usage.filter(u => u && u.success === false).length,
        input_tokens: sum("input_tokens"),
        output_tokens: sum("output_tokens"),
        cache_creation_input_tokens: sum("cache_creation_input_tokens"),
        cache_read_input_tokens: sum("cache_read_input_tokens"),
      });
    },
  };
}
