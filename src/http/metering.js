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
export function parseLimits(raw) {
  const out = new Map();
  for (const part of String(raw || "").split(",").map(s => s.trim()).filter(Boolean)) {
    const m = /^([a-z*][a-z0-9-]{0,31})=(\d+)$/.exec(part);
    if (!m) throw new Error(`RM_LIMITS_PER_DAY: malformed entry "${part.slice(0, 20)}" — expected client=N`);
    out.set(m[1], Number(m[2]));
  }
  return out;
}

export function createMetering({ log, limits = null, now = () => Date.now() } = {}) {
  const limitsEnabled = !!limits && limits.size > 0;
  const used = new Map();                            // `${day}|${client}` -> calls
  return {
    limitsEnabled,
    allow(clientId, _route) {
      if (!limitsEnabled) return true;               // ⛔ OFF unless RM_LIMITS_PER_DAY says otherwise
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
