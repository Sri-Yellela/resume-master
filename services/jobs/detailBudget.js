// services/jobs/detailBudget.js
//
// TASK Y — a budget for the N+1 that SmartRecruiters and Workday require.
//
// ── WHY THERE IS NO DESCRIPTION TODAY ──────────────────────────────────────────────────────────
//
// Both sources' LIST endpoints carry no job text at all. Unlike Workable — whose text turned out
// to need only `?details=true` on the same request — these two genuinely require one extra HTTP
// request per posting. Migration 103 measured the consequence and seeded both companies INACTIVE
// rather than switching them on: smartrecruiters/Ubisoft2 97 rows, smartrecruiters/BoschGroup 334,
// workday/adobe 217 — 648 rows at 0% description coverage. enrichJob.js skips description-less
// rows, so turning them on without this would have added 648 permanently unenrichable postings to
// the board, which is worse than not having them: they occupy the board and can never improve.
//
// ⛔ OFF BY DEFAULT, AND "OFF" MEANS ZERO REQUESTS, NOT A SMALL NUMBER OF THEM.
// The default total is 0, which disables the whole path — plugins skip the detail step entirely
// and behave exactly as they do today, byte for byte. This is deliberate: the budget bounds a
// cost paid in OUTBOUND REQUESTS TO SOMEONE ELSE'S API, and the failure mode of getting it wrong
// is not a slow crawl, it is being rate-limited or blocked by Ubisoft, Bosch or Adobe. A default
// that quietly starts making hundreds of requests per crawl is not a conservative default.
//
// ── WHY A BUDGET RATHER THAN A CONCURRENCY LIMIT ───────────────────────────────────────────────
//
// A concurrency limit bounds how FAST the requests go out and not how MANY. The thing that needs
// bounding here is the total, because the crawl runs unattended on a daily cron: a source that
// suddenly returns 5,000 postings would, under a concurrency limit alone, issue 5,000 detail
// requests slowly rather than quickly. Both caps exist here; the total is the one that matters.
//
// ── THE CAP THIS HAS TO AGREE WITH ─────────────────────────────────────────────────────────────
//
// ⛔ DETAIL FETCHES MUST HAPPEN AFTER collectCompanyJobs, NOT BEFORE.
// `0de67c8` fixed a cap that sliced the FLATTENED cross-company array, silently discarding every
// company past the 900th posting. The fix made it per-company. Either way, postings beyond the cap
// are DISCARDED — so fetching their descriptions first spends real requests on rows that are then
// thrown away. Budget spent on a discarded row is the same defect as the cap itself, one layer up:
// invisible, and only detectable by counting. The plugins call this after capping, and
// test/detailBudget.test.js pins that ordering.
//
// ── REPORTING ──────────────────────────────────────────────────────────────────────────────────
//
// "Report coverage, not counts" is a standing lesson here: `fetched: 50` is true whether fifty
// rows gained a description or zero did. So report() returns what was SPENT, what was SKIPPED for
// want of budget, and how many rows actually ended up with text — three different numbers that a
// single counter would conflate.

/** Total is 0 — the whole feature off. Everything else only matters once it is not. */
export const DETAIL_BUDGET_DEFAULTS = Object.freeze({
  total:       0,     // per crawl, across every company of one source. 0 = disabled.
  perCompany:  25,    // a single company cannot consume the whole crawl's budget
  concurrency: 2,     // polite: two in flight against one third-party API
  timeoutMs:   8000,  // matches the list-endpoint timeout the plugins already use
});

/** Reads the budget from the environment. Absent or unparseable means OFF, never a guess. */
export function detailBudgetFromEnv(env = process.env) {
  const num = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    total:       num(env?.ATS_DETAIL_FETCH_BUDGET,      DETAIL_BUDGET_DEFAULTS.total),
    perCompany:  num(env?.ATS_DETAIL_FETCH_PER_COMPANY, DETAIL_BUDGET_DEFAULTS.perCompany),
    concurrency: Math.max(1, num(env?.ATS_DETAIL_FETCH_CONCURRENCY, DETAIL_BUDGET_DEFAULTS.concurrency)),
    timeoutMs:   num(env?.ATS_DETAIL_FETCH_TIMEOUT_MS,  DETAIL_BUDGET_DEFAULTS.timeoutMs),
  };
}

/**
 * A budget for ONE source's crawl. Stateful on purpose: it is handed to the plugin, spent down
 * across every company in that crawl, and then reported on.
 */
export function createDetailBudget(options = {}) {
  const cfg = { ...DETAIL_BUDGET_DEFAULTS, ...options };
  const byCompany = new Map();
  let spent = 0, skipped = 0;

  return {
    get enabled() { return cfg.total > 0; },
    get config()  { return { ...cfg }; },
    get remaining() { return Math.max(0, cfg.total - spent); },

    /**
     * Claim one request for `companyKey`. Returns false when either cap is reached, and counts
     * the refusal — a budget that silently declines is indistinguishable from a source that has
     * no descriptions, which is the state this whole task exists to fix.
     */
    take(companyKey = "_") {
      if (!this.enabled)                      { skipped++; return false; }
      if (spent >= cfg.total)                 { skipped++; return false; }
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
 * posting whose detail fetch fails must not abort the crawl, because the list rows are already
 * good and a missing description is the status quo, not a regression.
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

/**
 * The shared detail-fetch step. Every source that needs an N+1 calls exactly this, so the budget
 * cannot be enforced differently in two places — the defect shape this repository pays for most.
 *
 * @param {object[]} jobs      ALREADY CAPPED rows. See the ⛔ note at the top of this file.
 * @param {object}   budget    from createDetailBudget()
 * @param {function} fetchOne  async (job) => description string | null. INJECTED, so tests never
 *                             touch a third-party API and a source can be exercised offline.
 * @param {function} keyOf     (job) => company key, for the per-company cap
 * @returns {Promise<object>}  the budget report, including real coverage
 */
export async function attachDescriptions(jobs, budget, fetchOne, keyOf = (j) => j.company || "_") {
  if (!budget?.enabled) return budget ? budget.report(0) : null;

  // Only rows that still LACK text are candidates. A source that already filled some descriptions
  // must not spend budget re-fetching them.
  const candidates = jobs.filter(j => !j.description);
  let withText = 0;

  await mapWithConcurrency(candidates, budget.config.concurrency, async (job) => {
    if (!budget.take(keyOf(job))) return;
    const text = await fetchOne(job);
    if (text && String(text).trim()) {
      job.description = String(text);
      withText++;
    }
  });

  return budget.report(withText);
}
