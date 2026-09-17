// services/jobs/detailBudget.js
//
// THE BOUND ON THE N+1 THAT SMARTRECRUITERS AND WORKDAY REQUIRE.
//
// ── WHAT THE N+1 IS, AND WHY IT IS REAL ────────────────────────────────────────────────────────
//
// Both sources' LIST endpoints carry no job text at all. Phase 2's predecessor asserted that from
// documentation; Phase 1 then PROVED it against live tenants, because this project had already
// been burned by believing a comment: workable.js carried one insisting descriptions required an
// N+1, and `?details=true` returned them in the same request.
//
// The probe (docs/DETAIL_FETCH_PHASE1_FINDINGS.md, 2026-09-17): 11 SmartRecruiters query variants
// and 19 Workday body/query variants, against real boards, all returned BYTE-IDENTICAL responses.
// No `?expand=`, no `?fields=`, no `includeDescription`, no RSS/Atom/sitemap on either source.
// Unknown parameters are silently ignored rather than rejected — so on these APIs a 200 proves
// nothing and only the byte count is evidence. The extra request per posting is unavoidable.
//
// ── WHY THIS IS NO LONGER A CRAWL-TIME BUDGET ──────────────────────────────────────────────────
//
// It used to be. The fetch sat inside each plugin's `search()`, behind `ATS_DETAIL_FETCH_BUDGET`,
// off by default. That is gone, and the env vars with it. The fetch now happens inside the
// enrichment pass (services/jobs/detailFetch.js), for one reason worth stating plainly:
//
//   A crawl-time budget is a SECOND spend budget. One in the crawl, one in enrichment, two
//   pacings, two ways to be wrong, and no way to notice they disagree. That is the defect shape
//   this codebase pays for most often — mapJobRow vs the client mapper, popup vs hotkey, three
//   hardcoded tab lists, 'mid level' vs 'mid', matchScore vs baseAtsScore.
//
// And the two budgets could not have agreed even in principle. Measured with the real plugins at
// the real crawl parameters, a crawl wants 1,500 detail requests (Ubisoft 300 + Bosch 900 +
// Adobe 300) while `ENRICH_DAILY_MAX_ROWS` is 300. A crawl-time fetch therefore buys 1,200
// descriptions a day that nothing can enrich, permanently, by construction.
//
// So what survives here is the primitive — a stateful, two-axis, per-company-aware allowance and
// a bounded-concurrency runner — and the thing that SETS it is now the enrichment day's remaining
// row ceiling. One budget.
//
// ── WHY THE DEFAULT IS NO LONGER ZERO ──────────────────────────────────────────────────────────
//
// The old default was `total: 0`, i.e. the whole feature off, and that was right when the fetch
// was in the crawl: "off" had to mean zero outbound requests to Ubisoft, Bosch and Adobe, because
// a daily cron that quietly starts making hundreds of third-party requests is not a conservative
// default.
//
// It is the wrong default now, and keeping it would have been cargo cult. The capability and the
// sources are separate switches, and the SOURCES are the ones that are off: all three companies
// are `active = 0` in `company_ats_list`, so the crawl ingests nothing from them and there are
// zero description-less rows for this pass to act on. Measured on the live board today: 1,266 of
// 1,266 active rows already have a description. An enabled budget over an empty candidate set
// makes exactly zero requests — the selector in detailFetch.js is what makes that true, not a
// constant — while a `0` default would mean that enabling a source later ALSO silently required
// finding and flipping a second unrelated flag. That is how a feature ships broken.
//
// `ENRICH_DETAIL_FETCH=0` is the kill switch, and it is one lever rather than four.
//
// ⛔ PACING IS SET FROM A MEASUREMENT, NEVER FROM A GUESS.
// This project has paid for that mistake once already: the code paced Groq on 30 requests/minute
// when the binding limit was 8,000 TOKENS/minute — about 2 calls/min, turning a full pass into
// ~9.7 hours. The pacing axis was simply wrong.
//
// So Phase 1 measured these two. Concurrency ramped 2 → 32 against both detail endpoints, 124
// requests each: ZERO 429s, zero 503s, and NEITHER API EMITS A `RateLimit-*` OR `Retry-After`
// HEADER AT ALL — there is no advertised budget to read. Both are unauthenticated public
// endpoints, so any limit is per-IP by construction. The axis is requests, not bytes: a 20x
// larger payload cost only 18% of throughput.
//
// The one thing that did show a limit was Workday's backpressure — above 8 concurrent its
// throughput stops improving while tail latency triples (584ms → 1882ms). That knee is where
// `concurrency` comes from. SmartRecruiters was completely flat to 32 and is held at the same 8,
// because two numbers would be two things to keep true and the gain is nil.

/**
 * Defaults for the enrichment-side detail fetch.
 *
 * `total` is a CEILING, not the usual size of the job: drainEnrichment passes the day's remaining
 * row budget, which is normally the smaller number and is what actually binds.
 */
export const DETAIL_FETCH_DEFAULTS = Object.freeze({
  total:       300,   // ceiling per pass. drainEnrichment passes the day's remaining rows instead.
  perCompany:  100,   // one company cannot consume the whole day — Bosch alone offers 900 rows
  concurrency: 8,     // Workday's MEASURED knee. Not a guess, not politeness theatre.
  timeoutMs:   15000, // the JSON-LD page is ~23KB of HTML; the old 8s was sized for a list call
  maxAttempts: 3,     // stop RE-SPENDING on a row that keeps failing. Not a "done" marker.
});

/**
 * ⛔ THE EMPTY STRING IS NOT ZERO, AND `Number('')` IS. That coercion is why this is a named
 * function with an early return rather than a one-liner: `Number('') === 0` and
 * `Number(null) === 0`, both of which pass a `>= 0` test, so the obvious spelling turns an UNSET
 * or typo'd variable into a hard zero. For `total` a hard zero means "make no requests" — a
 * silent outage with no operator behind it, arrived at by a missing env var. An unreadable value
 * must fall back to the measured default; only an EXPLICIT "0" is a decision, and only for the
 * knobs where zero means something (`min: 0`).
 */
const envNum = (raw, dflt, { min = 0 } = {}) => {
  if (raw === undefined || raw === null) return dflt;
  const str = String(raw).trim();
  if (str === '') return dflt;
  const n = Number(str);
  return Number.isFinite(n) && n >= min ? n : dflt;
};

/**
 * Reads the pass's knobs from the environment. An absent or unparseable value falls back to the
 * measured default rather than to zero — "I could not read the setting" must not silently become
 * "make no requests", which is a different decision and one nobody made.
 *
 * `ENRICH_DETAIL_FETCH=0` (or `false`/`off`) is the single kill switch and yields `total: 0`,
 * which fillMissingDescriptions treats as inert.
 */
export function detailFetchFromEnv(env = process.env) {
  const off = /^(0|false|off|no)$/i.test(String(env?.ENRICH_DETAIL_FETCH ?? '').trim());
  return {
    // min: 0 — an explicit "0" here IS a decision (fetch nothing this pass) and is honoured.
    total:       off ? 0 : envNum(env?.ENRICH_DETAIL_MAX_ROWS,  DETAIL_FETCH_DEFAULTS.total),
    perCompany:  envNum(env?.ENRICH_DETAIL_PER_COMPANY,         DETAIL_FETCH_DEFAULTS.perCompany),
    timeoutMs:   envNum(env?.ENRICH_DETAIL_TIMEOUT_MS,          DETAIL_FETCH_DEFAULTS.timeoutMs),
    // min: 1 — zero is not a decision anybody makes here, it is a broken value. A 0 concurrency
    // would leave mapWithConcurrency with an empty runner pool and a 0 attempt cap would make
    // every row permanently ineligible, both silently. "Turn it off" already has its own switch.
    concurrency: envNum(env?.ENRICH_DETAIL_CONCURRENCY,   DETAIL_FETCH_DEFAULTS.concurrency, { min: 1 }),
    maxAttempts: envNum(env?.ENRICH_DETAIL_MAX_ATTEMPTS,  DETAIL_FETCH_DEFAULTS.maxAttempts,  { min: 1 }),
  };
}

/**
 * A budget for ONE pass. Stateful on purpose: it is spent down across every row in the pass and
 * then reported on.
 *
 * ⛔ TWO AXES, NOT ONE, AND FOR DIFFERENT REASONS. The total bounds what the pass costs. The
 * per-company cap stops ONE company monopolising it — which is not hypothetical here: Bosch alone
 * offers 4,840 postings (900 after the crawl's per-company cap), so without it a single company
 * would consume every day's fetch allowance and Ubisoft and Adobe would never get one.
 */
export function createDetailBudget(options = {}) {
  const cfg = { ...DETAIL_FETCH_DEFAULTS, ...options };
  const byCompany = new Map();
  let spent = 0, skipped = 0;

  return {
    get enabled() { return cfg.total > 0; },
    get config()  { return { ...cfg }; },
    get remaining() { return Math.max(0, cfg.total - spent); },

    /**
     * Claim one request for `companyKey`. Returns false when either cap is reached, and COUNTS the
     * refusal — a budget that silently declines is indistinguishable from a source that has no
     * descriptions, which is the state this whole task exists to fix.
     */
    take(companyKey = '_') {
      if (!this.enabled)      { skipped++; return false; }
      if (spent >= cfg.total) { skipped++; return false; }
      const used = byCompany.get(companyKey) || 0;
      if (cfg.perCompany > 0 && used >= cfg.perCompany) { skipped++; return false; }
      byCompany.set(companyKey, used + 1);
      spent++;
      return true;
    },

    /** Coverage, not a count. `withText` is supplied by the caller because only it knows how many
     *  rows actually ended up with a description — a fetch can succeed and still return nothing. */
    report(withText = null) {
      return {
        enabled: this.enabled,
        total: cfg.total, perCompany: cfg.perCompany, concurrency: cfg.concurrency,
        spent, skipped, withText,
        byCompany: Object.fromEntries(byCompany),
      };
    },
  };
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight. Rejections are contained: one
 * posting whose detail fetch fails must not abort the pass, because the list row is already good
 * and a missing description is the status quo, not a regression.
 */
export async function mapWithConcurrency(items, concurrency, worker) {
  const list = [...items];
  const limit = Math.max(1, concurrency | 0);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const index = cursor++;
      try { await worker(list[index], index); } catch { /* contained by design — see above */ }
    }
  });
  await Promise.all(runners);
}
