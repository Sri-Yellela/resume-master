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
export function createMetering({ log, limitsEnabled = false } = {}) {
  return {
    limitsEnabled,
    // eslint-disable-next-line no-unused-vars
    allow(_clientId, _route) {
      return true;                                   // ⛔ limits are OFF by decision, not by omission
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
