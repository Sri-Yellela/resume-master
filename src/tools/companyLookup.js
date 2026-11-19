// The company's stack when Resume Master scores ON ITS OWN (draft's WORKLOG D192 (3), owner 11-14: "what if i want the ats
// scorer in rm to check my ats with the technographics and contextual score").
//
// RM keeps no company data. When a caller sends `company.techStack`, that is what the scorer reads, and nothing is fetched
// (draft is that caller). When it does not, RM asks draft's PUBLIC, read-only GET /api/public/company-stack?name=<company>.
// That is the data draft's public company pages show, with nothing about any person. RM keeps each answer
// 24 hours IN MEMORY only: never on disk, gone on a restart, so the deletion obligation stays simple.
// A failed or slow lookup is "no data": the contextual score then rests on its other parts. It is never an error.
//
// ⛔ No model. This module's only network call is that GET. test/companyLookup.test.js holds both rules.
export const LOOKUP_TTL_MS = 24 * 60 * 60 * 1000;
export const LOOKUP_TIMEOUT_MS = 1500;
export const LOOKUP_MAX_ENTRIES = 2000;
export const DEFAULT_STACK_URL = "https://jobsviadraft.com/api/public/company-stack";

const keyOf = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 120);

/** A lookup function `(name) => Promise<{ matched, industry, techStack } | null>`. null when no URL is configured. */
export function createCompanyLookup({ url = DEFAULT_STACK_URL, fetchImpl = globalThis.fetch, now = () => Date.now(),
                                      ttlMs = LOOKUP_TTL_MS, timeoutMs = LOOKUP_TIMEOUT_MS, log = () => {} } = {}) {
  if (!url || typeof fetchImpl !== "function") return null;
  const cache = new Map();   // key → { at, value }
  async function lookup(name) {
    const key = keyOf(name);
    if (!key) return null;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    let value = null;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetchImpl(`${url}?name=${encodeURIComponent(String(name).slice(0, 200))}`, { signal: ctl.signal, headers: { accept: "application/json" } })
        .finally(() => clearTimeout(timer));
      if (res.ok) {
        const body = await res.json();
        value = body && body.matched === true && Array.isArray(body.techStack)
          ? { matched: true, industry: typeof body.industry === "string" ? body.industry : null,
              techStack: body.techStack.filter(t => t && typeof t.name === "string" && typeof t.postingShare === "number")
                .map(t => ({ name: t.name, category: typeof t.category === "string" ? t.category : null, postingShare: t.postingShare })) }
          : { matched: false, industry: null, techStack: [] };
      } else log({ event: "company_lookup_failed", status: res.status });
    } catch (e) { log({ event: "company_lookup_failed", error: e.name === "AbortError" ? "timeout" : e.message }); }
    // A failure is not kept: the next score asks again. An answer (matched or not) is kept for the TTL.
    if (value) {
      if (cache.size >= LOOKUP_MAX_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now(), value });
    }
    return value;
  }
  lookup.cacheSize = () => cache.size;
  return lookup;
}
