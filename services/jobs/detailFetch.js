// services/jobs/detailFetch.js
//
// TASK Y PHASE 2 — THE ONE DETAIL FETCHER, AND THE PASS THAT SPENDS IT.
//
// SmartRecruiters and Workday both genuinely require an extra HTTP request per posting to get its
// description. Phase 1 established that empirically rather than inheriting it from documentation
// (docs/DETAIL_FETCH_PHASE1_FINDINGS.md): 11 SmartRecruiters query variants and 19 Workday
// body/query variants all returned BYTE-IDENTICAL responses, and no RSS/Atom/sitemap exists on
// either. So the N+1 is real, and this file is where it lives.
//
// ── WHY THIS IS NOT AT CRAWL TIME ANY MORE ─────────────────────────────────────────────────────
//
// Task Y put the fetch inside the crawl, behind its own budget. That created a SECOND spend budget
// — one in the crawl, one in enrichment — with two pacings and two ways to be wrong. Two budgets
// that can disagree is the defect shape this codebase pays for most: mapJobRow vs the client
// mapper, popup vs hotkey, three hardcoded tab lists, 'mid level' vs 'mid', matchScore vs
// baseAtsScore. So there is now ONE budget, and it is the enrichment day's row ceiling.
//
// That collapse is also what makes the arithmetic honest. Measured with the real plugins at the
// real crawl parameters (`aggregator.js` calls every ATS plugin with `query: ''` and
// `pageSize: 300`, so there is NO title filter at crawl time and the per-company cap is 900):
//
//     smartrecruiters  1,200 rows   (Ubisoft 300 + Bosch 900)
//     workday            300 rows   (Adobe 300)
//                      ───────────
//                      1,500 detail requests PER CRAWL, every crawl
//
// Not the 648 the migration comment estimated — that figure came from a title-filtered query and
// does not describe the crawl. Against `ENRICH_DAILY_MAX_ROWS 300`, a crawl-time fetch would buy
// 1,500 descriptions a day to feed a pass that can enrich 300, i.e. 1,200 wasted requests daily
// and a backlog that grows by 1,200/day forever. Fetching inside enrichment cannot do that: the
// day's row ceiling bounds both halves of the work at once.
//
// ⛔ REQUESTS WERE NEVER THE SCARCE THING, AND THE CODE MUST NOT PRETEND THEY WERE.
// Phase 1 ramped concurrency 2→32 against both detail endpoints: ZERO 429s and zero 503s in 124
// requests per source, and neither API emits a `RateLimit-*` or `Retry-After` header at all. So
// the reason this pass is bounded is NOT politeness theatre — it is that a description nobody
// will enrich or read this week is a description not worth having yet. Pacing below is set from
// the one measurement that did show something: Workday's throughput plateaus near 8 concurrent
// while its tail latency triples (584ms → 1882ms), so 8 is the knee. SmartRecruiters was flat to
// 32 and is capped at the same 8 for one number rather than two.
//
// ── WHY WORKDAY GOES THROUGH THE PUBLIC PAGE AND NOT THE CXS API ───────────────────────────────
//
// Phase 1 found `schema.org/JobPosting` JSON-LD on Workday's server-rendered job page, carrying
// the COMPLETE description — 1.12-1.16x more readable text than the CXS endpoint, because CXS
// returns HTML with undecoded entities (`You&#39;ll`, `6&#43; years`) and JSON-LD is already plain
// text. Same one request. It is also the canonical PUBLIC representation (Google Jobs indexes it)
// rather than an internal API whose shape we are guessing at.
//
// And it needs nothing we do not already have. The CXS door needed the tenant/wd#/site triple
// reassembled from `company_ats_list.ats_slug`, which is why task Y's version carried a slug
// around and why its first attempt lost it (normalizeJob is a field WHITELIST and silently dropped
// `_atsSlug`). The JSON-LD door is a GET of the URL ALREADY STORED ON THE ROW. A fetcher that
// works from a stored row alone is what lets the enrichment pass and the user-opens-a-job path be
// the same code — see the two callers of fetchDescription below.
//
// ⛔ SMARTRECRUITERS HAS NO SUCH DOOR. Its public page is a 118KB client-rendered shell with ZERO
// ld+json blocks, and the detail endpoint's own first sentence of body text is not anywhere in the
// served HTML. Do not "unify" the two onto one strategy; they are different because the sources
// are different, and Phase 1 checked.
//
// ── WHAT IS DELIBERATELY NOT BUILT ─────────────────────────────────────────────────────────────
//
// CONDITIONAL REQUESTS. SmartRecruiters honours `If-None-Match` with a real 0-byte 304 on both its
// list and detail endpoints (Workday sends no validator at all and `no-store, no-cache`). It is
// implemented NOWHERE here, on purpose: this pass only ever fetches rows that have NO description,
// so there is never a prior ETag to send, and a row's description is cached permanently once it
// arrives. A conditional-request path would have no caller — which is precisely the
// `_ghCompanies`/`_leverCompanies`/`_ashbyCompanies` failure, where a dormant second path capped
// live search at three of seven sources invisibly. The 304 support is recorded in
// docs/DETAIL_FETCH_PHASE1_FINDINGS.md as an unbuilt opportunity for a future re-fetch design,
// where it would have a caller.

import axios from 'axios';
import { createDetailBudget, mapWithConcurrency, detailFetchFromEnv } from './detailBudget.js';
import { profileTitleSql } from '../profileTitleFilter.js';
// ⛔ THE SAME NORMALISER THE STORE PATH USES, not a second reading of the same words.
// aggregator.js:436 pipes every source's employment type through this on the way in
// (`employment_type: normalizeEmploymentType(canonical.contract_type ?? canonical.employment_type)`),
// because six sources spell it six ways and the column is filtered against a fixed vocabulary
// (full-time | part-time | contract | internship) with the soft-null pattern. Writing "FULL_TIME"
// straight in would produce a value no filter matches — present, wrong, and invisible.
import { normalizeEmploymentType } from './schema.js';

// A real browser UA. Workday's public page is served to crawlers differently without one, and
// Phase 1 probed it with this shape — so this is the string the measurements were taken under.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Safari/537.36';

// ────────────────────────────────────────────────────────────────────────────────────────────────
// PER-SOURCE REQUEST DESCRIPTORS
//
// Each returns { url, headers, extract(bodyText) } or null when this row cannot be addressed.
// They describe a request; they never make one. One transport (`requestOnce` below) performs all
// of them, so the timeout, the retry, the Retry-After handling and the error taxonomy exist in
// exactly one place and cannot be implemented differently per source.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Concatenated in the order a human reads them; whatever subset the ad actually uses. */
const SR_SECTIONS = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'];

function smartrecruitersRequest(row) {
  // The stored URL is what normalizeSmartRecruitersJob reconstructed:
  //   https://jobs.smartrecruiters.com/{companyIdentifier}/{postingId}-{slugified-title}
  // Both pieces the API needs are in it, so the row addresses itself and no company_ats_list
  // lookup is required — which also means an imported one-off URL works the same way.
  let parsed;
  try { parsed = new URL(String(row?.url || '')); } catch { return null; }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const identifier = segments[0];
  // The slug is appended with a hyphen, and the id is the leading run of digits. Taking the
  // digits rather than splitting on '-' matters: SmartRecruiters' own postingUrl keeps a TRAILING
  // hyphen that our slugify strips, so the two URL spellings differ in the tail and must not
  // differ in the id.
  const postingId = (segments[1].match(/^\d+/) || [])[0];
  if (!identifier || !postingId) return null;

  return {
    url: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(identifier)}/postings/${encodeURIComponent(postingId)}`,
    headers: { Accept: 'application/json' },
    extract(body) {
      const sections = JSON.parse(body)?.jobAd?.sections || {};
      // Passed through as HTML, not stripped: the board stores HTML elsewhere too and
      // htmlToText.js handles it downstream. Stripping here would make this source's text
      // shape differ from every other source's for no reason.
      const text = SR_SECTIONS.map(k => sections[k]?.text).filter(Boolean).join('\n\n');
      return { text: text || null, employmentType: null };
    },
  };
}

function workdayRequest(row) {
  // The stored URL *is* the public job page. Nothing to reassemble — see the header.
  const url = String(row?.url || '');
  if (!/^https?:\/\/[^/]+\.myworkdayjobs\.com\//i.test(url)) return null;

  return {
    url,
    headers: { Accept: 'text/html,application/xhtml+xml' },
    extract(body) {
      // Every ld+json block, because "the first one" is an assumption about page structure and
      // the @type is the thing actually being looked for.
      const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
      let match;
      while ((match = re.exec(body))) {
        let parsed;
        try { parsed = JSON.parse(match[1].trim()); } catch { continue; }
        for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
          if (node?.['@type'] !== 'JobPosting') continue;
          const text = typeof node.description === 'string' ? node.description : null;
          return {
            text: text || null,
            // ⛔ THIS FIXES A DEAD READ, and that is worth a line of code here rather than a
            // follow-up. workday.js maps `contract_type: job.timeType`, and Phase 1 found
            // `timeType` absent from 100/100 list postings — so the stored employment_type has
            // been NULL on every Workday row, always: the `_atsSlug` shape again. JSON-LD carries
            // it as employmentType ("FULL_TIME"), one request away, in the request we are already
            // making.
            //
            // Handed over RAW. normalizeEmploymentType owns the vocabulary and maps
            // 'FULL_TIME' -> 'full-time'; translating it here would be a second opinion about the
            // same words, and the column's filter only matches the canonical spellings.
            employmentType: typeof node.employmentType === 'string' ? node.employmentType : null,
          };
        }
      }
      return { text: null, employmentType: null };
      // JSON-LD also carries an exact `datePosted` ("2026-08-26"), which would be strictly better
      // than parsePostedOn's approximation of "Posted 30+ Days Ago". It is NOT written, because
      // ingestion already fills posted_at on 100% of Workday rows and a COALESCE could therefore
      // never reach it — replacing it would mean an overwriting write, and enrichment-adjacent
      // writes in this codebase are additive-only for a reason (a plain assignment here once
      // erased good ingestion data on 120 rows). Recorded in the Phase 1 findings instead.
    },
  };
}

/**
 * Keyed by `scraped_jobs.source`. A source ABSENT from this map has no detail door, and that is
 * reported as `no_fetcher` rather than as a failure — it is not a defect that greenhouse rows need
 * no second request, and counting it as one would make the yield metric meaningless.
 */
const FETCHERS = Object.freeze({
  smartrecruiters: smartrecruitersRequest,
  workday:         workdayRequest,
});

export const DETAIL_FETCH_SOURCES = Object.freeze(Object.keys(FETCHERS));
export function hasDetailFetcher(source) {
  return Object.prototype.hasOwnProperty.call(FETCHERS, String(source || ''));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE TRANSPORT
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Default HTTP. Injectable everywhere below so not one test reaches a third party's API. */
async function axiosGet({ url, headers, timeoutMs }) {
  try {
    const res = await axios.get(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': BROWSER_UA, ...headers },
      // Always text: SmartRecruiters returns JSON and Workday returns HTML, and one transport
      // with one body type means the extractors decide how to read it rather than axios guessing
      // from a content-type header.
      responseType: 'text',
      transformResponse: [(d) => d],
      // A 4xx/5xx must come back as a VALUE, not a throw, so the taxonomy in fetchDescription is
      // the only place that decides what a status means. (axios spells this `validateStatus`.)
      validateStatus: () => true,
    });
    return { status: res.status, body: typeof res.data === 'string' ? res.data : String(res.data ?? ''), headers: res.headers || {} };
  } catch (err) {
    // Network/timeout only — statuses no longer arrive here.
    return { status: 0, body: '', headers: {}, error: err?.message || 'network error' };
  }
}

/** `Retry-After` in ms. Seconds or an HTTP date, per RFC 9110; null when absent or nonsense. */
function retryAfterMs(headers, now = Date.now()) {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw == null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(String(raw));
  return Number.isFinite(when) ? Math.max(0, when - now) : null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Injectable so the backoff TESTS assert the computed delay instead of serving it. A test that
// really sleeps 30s to prove a cap is 30s teaches the suite to be skipped.

/**
 * ONE posting's description. This is the whole public surface for "get me the text of this row",
 * and it has exactly two callers: the enrichment pass below, and the user-opened-a-job route in
 * server.js. One implementation, two triggers — the convergence rule the popup/hotkey split taught.
 *
 * NEVER THROWS. Returns a tagged outcome, because the caller has to tell four different
 * not-getting-text-back cases apart in order to behave correctly:
 *
 *   ok:true                  text arrived
 *   reason:'no_fetcher'      this source has no detail door — NOT a failure, not an attempt
 *   reason:'unaddressable'   the stored URL cannot be turned into a request — a real defect
 *   reason:'http_404'        the posting is gone. Retrying tomorrow will not help
 *   reason:'http_429'        WE were too fast. The row is fine; back off
 *   reason:'http_error'      the far side is unwell. Retryable
 *   reason:'network'         timeout/DNS/reset. Retryable
 *   reason:'no_text'         200, parsed, and genuinely empty. THE YIELD CASE, and the one a
 *                            request count would hide: a fetch can succeed and return nothing.
 *
 * ⛔ ON WORKDAY, 'no_text' ALSO MEANS "GONE", AND THERE IS NO WAY TO TELL. Verified live: a
 * deleted or invented posting path returns **200 with the SPA shell and no ld+json block**, not a
 * 404 — the same catch-all that makes `/external_experienced/feed` answer 200 for a feed that does
 * not exist. So a removed Workday posting is indistinguishable from one the employer published
 * without a description, and no status code will ever separate them. That is precisely why the
 * attempt cap exists and why it cannot be replaced by "stop on 404": the cap is the ONLY thing
 * bounding spend on a Workday posting that has been taken down. SmartRecruiters does return a
 * real 404, and is handled terminally below.
 *   reason:'unparseable'     200 but the body was not the shape the extractor expects
 *
 * @param {object} row  a scraped_jobs row: { job_id, source, url, company }
 */
export async function fetchDescription(row, {
  http = axiosGet,
  timeoutMs = 15000,
  maxRetries = 2,
  onRetry = null,
  sleepFn = sleep,
} = {}) {
  const build = FETCHERS[String(row?.source || '')];
  if (!build) return { ok: false, reason: 'no_fetcher', attempted: false, status: null };

  const request = build(row);
  if (!request) return { ok: false, reason: 'unaddressable', attempted: false, status: null };

  let lastStatus = null, lastRetryAfter = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // The default transport already turns every failure into a status-0 value, but an INJECTED one
    // might throw — and this function documents itself as never throwing, which callers rely on:
    // the enrichment pass would otherwise lose a whole concurrency slot's remaining rows, and the
    // route in server.js would 500 on a third party being slow.
    let res;
    try {
      res = await http({ url: request.url, headers: request.headers, timeoutMs });
    } catch (err) {
      res = { status: 0, body: '', headers: {}, error: err?.message || 'transport threw' };
    }
    lastStatus = res.status;

    // ── Retryable transport conditions. 429 first, because it is the one with an instruction
    //    attached: honour Retry-After rather than retrying blindly.
    if (res.status === 429 || res.status === 503 || res.status === 0 || res.status >= 500) {
      lastRetryAfter = retryAfterMs(res.headers);
      if (attempt < maxRetries) {
        // Retry-After when the server said so; otherwise exponential backoff from 1s. Capped so a
        // hostile or mistaken header cannot park a background pass for an hour.
        const waitMs = Math.min(lastRetryAfter ?? (1000 * 2 ** attempt), 30000);
        onRetry?.({ status: res.status, attempt, waitMs });
        await sleepFn(waitMs);
        continue;
      }
      return {
        ok: false, attempted: true, status: res.status,
        reason: res.status === 429 ? 'http_429' : res.status === 0 ? 'network' : 'http_error',
        retryAfterMs: lastRetryAfter,
        detail: res.error || null,
      };
    }

    // ── Terminal statuses. A 404 means the posting is gone; retrying is spend with no upside.
    if (res.status >= 400) {
      return { ok: false, attempted: true, status: res.status, reason: `http_${res.status}` };
    }

    // ── 200. Parsing is inside the try because a body that is not the expected shape is a
    //    different finding from an empty one, and "no description" must not absorb both.
    let extracted;
    try {
      extracted = request.extract(res.body);
    } catch (err) {
      return { ok: false, attempted: true, status: res.status, reason: 'unparseable', detail: err?.message || null };
    }
    const text = extracted?.text;
    if (!text || !String(text).trim()) {
      return { ok: false, attempted: true, status: res.status, reason: 'no_text' };
    }
    return {
      ok: true, attempted: true, status: res.status,
      text: String(text),
      employmentType: extracted.employmentType || null,
    };
  }

  // Unreachable: the loop either returns or exhausts into the retryable branch above.
  return { ok: false, attempted: true, status: lastStatus, reason: 'http_error' };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 2C · TITLE-UNION PRIORITISATION — a RANKING of what to spend on, never a filter on what to store
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An ORDER BY fragment that floats postings matching any active profile's target titles to the
 * front of the fetch queue.
 *
 * ⛔ THIS IS ORDERING ONLY. It never appears in a WHERE clause and it must never be allowed to.
 * The board is a GLOBAL pool by design — store-then-filter exists precisely so the pool is
 * profile-agnostic and curation happens at query time — so dropping a row because no current
 * profile matches it would be a silent, permanent narrowing of the board to today's two users.
 * What this decides is which description gets bought FIRST out of a bounded day, and nothing else.
 *
 * ⛔ IT REUSES profileTitleSql, THE BOARD'S OWN MATCHER, rather than a second one. That function
 * tokenises ("Software Engineer" -> LIKE %software% AND LIKE %engineer%), so it correctly reaches
 * "Software Development Engineer" — which a naive substring on the whole phrase does not. Phase 1
 * measured the union at 15 of 1,500 rows (1.0%) using the plugins' substring matcher; that figure
 * is a FLOOR produced by the weaker matcher and is deliberately not encoded anywhere. A second
 * matcher here would also mean the fetch queue and the board could disagree about what a profile
 * wants, which is the two-sides-joined-to-nothing shape this codebase keeps paying for.
 *
 * ⛔ A PROFILE WITH EMPTY target_titles CONTRIBUTES NOTHING, AND THAT IS NOT THE SAME AS
 * CONTRIBUTING EVERYTHING. profileTitleSql returns `1 = 1` for an empty list, which is right for a
 * filter (show me everything) and catastrophic for a prioritiser (everything is top priority, so
 * the ranking silently becomes a no-op). Those profiles are skipped explicitly. One of the two
 * active profiles on this board is in exactly that state today.
 *
 * Refresh cadence: recomputed from `domain_profiles` on EVERY pass, so the union can never be
 * staler than one enrichment run. There is no cache to invalidate, which is the point — a cached
 * union is how a new profile gets silently starved.
 *
 * ⛔ IT RETURNS *NAMED* PLACEHOLDERS, and that is not cosmetic. profileTitleSql speaks `?`
 * because its callers (server.js's board queries) bind positionally; the query below binds by
 * name, and better-sqlite3 refuses a statement that mixes the two styles — it throws on prepare,
 * so this would have failed loudly rather than subtly. The `?`s are rewritten to `@pri0…@priN`
 * here, in the one place that knows both conventions, rather than by reformatting the board's
 * matcher to suit this caller.
 *
 * @returns {{sql:string, params:object, profiles:number}|null} null when no active profile names a
 *          title, in which case the caller orders by recency alone and says so.
 */
export function titleUnionPriority(db, column = 'title', prefix = 'pri') {
  let rows = [];
  try {
    rows = db.prepare('SELECT target_titles FROM domain_profiles WHERE is_active = 1').all();
  } catch {
    // No domain_profiles table (a fixture DB, or a checkout predating it). An absent prioritiser
    // must degrade to "no opinion about order", never to an error that stops descriptions being
    // fetched at all.
    return null;
  }

  const clauses = [];
  const params = {};
  let contributing = 0, bound = 0;
  for (const row of rows) {
    const built = profileTitleSql(column, row);
    if (built.sql === '1 = 1') continue;   // see the ⛔ above
    // Rewrite positional to named, consuming one of THIS clause's params per `?` in left-to-right
    // order — which is exactly the order profileTitleSql pushed them in.
    let cursor = 0;
    const named = built.sql.replace(/\?/g, () => {
      const key = `${prefix}${bound++}`;
      params[key] = built.params[cursor++];
      return `@${key}`;
    });
    clauses.push(named);
    contributing++;
  }
  if (!clauses.length) return null;
  return { sql: `(${clauses.join(' OR ')})`, params, profiles: contributing };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 2A · THE PASS
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Fetches descriptions for rows that have none, writes them, and reports COVERAGE.
 *
 * Called by drainEnrichment BEFORE it selects candidates, so a row whose description arrives here
 * becomes an enrichment candidate in the SAME run with no new selector logic at all:
 * `content_hash` is sha1(title|description), so a description appearing changes the hash, and
 * enrichmentSelection.js's existing predicate picks the row up. That is the entire reason this is
 * the right seam.
 *
 * ⛔ A FETCH FAILURE MUST LEAVE THE ROW RETRYABLE. `content_hash` and `enriched_at` are NEVER
 * written here, on any path, success or failure. enrichJob's own failure path is deliberately
 * built the same way, and the reason is a measured one: stamping a row as done when nothing was
 * filled once cost this project 120 rows, and a 429 is the obvious way to recreate it. The only
 * thing a failure writes is the attempt counter and the reason — bookkeeping, never a verdict.
 *
 * ⛔ NEVER WRITE A DESCRIPTION-SHAPED NOTHING. A 200 that yields no text writes no description and
 * is counted under `no_text`, because an empty string in that column would make the row look
 * described to every downstream reader while carrying nothing.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object}  [o]
 * @param {number}  [o.limit]        how many descriptions this pass may buy. THE BUDGET. Comes
 *                                   from the enrichment day's remaining row ceiling.
 * @param {number}  [o.perCompany]   one company may not consume the whole day
 * @param {number}  [o.concurrency]  8 = Workday's measured knee
 * @param {number}  [o.maxAttempts]  stop re-spending on a row that has failed this many times
 * @param {function}[o.http]         injected transport; no test reaches a real ATS
 */
export async function fillMissingDescriptions(db, {
  limit = null,
  perCompany = null,
  concurrency = null,
  maxAttempts = null,
  timeoutMs = null,
  http = axiosGet,
  sleepFn = sleep,
  now = () => Math.floor(Date.now() / 1000),
  log = console,
} = {}) {
  const cfg = detailFetchFromEnv();
  const budgetTotal  = limit       ?? cfg.total;
  const perCo        = perCompany  ?? cfg.perCompany;
  const conc         = concurrency ?? cfg.concurrency;
  const attemptCap   = maxAttempts ?? cfg.maxAttempts;
  const timeout      = timeoutMs   ?? cfg.timeoutMs;

  const inert = (reason) => ({
    enabled: false, reason, selected: 0, attempted: 0, withText: 0, failed: 0,
    byReason: {}, byCompany: {}, describedBefore: 0, describedAfter: 0, prioritised: null,
  });

  if (!(budgetTotal > 0)) return inert('no_budget');
  if (!columnsPresent(db))  return inert('migration_107_missing');

  // ── SELECT. Only rows that lack text, only sources with a door, only rows that have not
  //    already burned their attempts.
  //
  // The attempt cap is NOT a "this row is done" marker — see the ⛔ above. It bounds RE-SPENDING
  // on a posting that has been deleted upstream or that this source genuinely will not serve. The
  // row stays a candidate forever (content_hash/enriched_at untouched), the counter and the last
  // reason are both visible in the admin health view, and clearing the counter re-arms it. Without
  // it, a 404 costs one request per pass forever, which is exactly the "one crawl to learn, not
  // one crawl per crawl" waste this task set out to remove.
  const placeholders = DETAIL_FETCH_SOURCES.map((_, i) => `@src${i}`).join(', ');
  const params = {};
  DETAIL_FETCH_SOURCES.forEach((s, i) => { params[`src${i}`] = s; });
  params.attemptCap = attemptCap;

  const priority = titleUnionPriority(db, 'title');
  // `CASE WHEN <union> THEN 0 ELSE 1 END` rather than a filter, so an unmatched row is LAST and
  // never absent. When there is no union at all the ordering collapses to recency, which is the
  // honest behaviour for "nobody has told us what they want".
  const orderBy = priority
    ? `CASE WHEN ${priority.sql} THEN 0 ELSE 1 END, COALESCE(discovered_at, scraped_at) DESC`
    : 'COALESCE(discovered_at, scraped_at) DESC';

  // ⛔ THE PER-COMPANY CAP IS APPLIED IN THE *SELECT*, NOT ONLY IN THE BUDGET, AND THAT IS A FIX
  // RATHER THAN BELT-AND-BRACES. The first version selected `LIMIT @limit` rows by priority and
  // let budget.take() refuse the ones over a company's share — which silently WASTED the day:
  // Bosch offers 900 of the 1,200 SmartRecruiters rows, so a 300-row day would fill its LIMIT
  // almost entirely with Bosch, fetch its 100, and refuse ~200 slots that Ubisoft and Adobe rows
  // could have used. A cap that quietly discards budget is the `0de67c8` shape one more time.
  //
  // ROW_NUMBER() partitions the candidates by company first, so the day's rows are spread across
  // companies BEFORE the total is applied. budget.take() still enforces the same cap afterwards,
  // and that redundancy is deliberate: the SELECT decides who gets offered a slot, the budget
  // remains the thing that cannot be exceeded, and a bug in the window function cannot overspend.
  const selected = db.prepare(`
    SELECT job_id, source, url, company, title FROM (
      SELECT job_id, source, url, company, title,
             ROW_NUMBER() OVER (
               PARTITION BY company
               ORDER BY ${orderBy}
             ) AS rn,
             ${priority ? `CASE WHEN ${priority.sql} THEN 0 ELSE 1 END` : '0'} AS unmatched,
             COALESCE(discovered_at, scraped_at) AS seen_at
      FROM scraped_jobs
      WHERE is_active = 1
        AND (description IS NULL OR TRIM(description) = '')
        AND source IN (${placeholders})
        AND COALESCE(detail_fetch_attempts, 0) < @attemptCap
    )
    WHERE @perCompany <= 0 OR rn <= @perCompany
    ORDER BY unmatched, seen_at DESC
    LIMIT @limit
  `).all({
    ...params, ...priorityParams(priority),
    perCompany: perCo, limit: budgetTotal,
  });

  if (!selected.length) return { ...inert('nothing_to_fetch'), enabled: true, prioritised: priority?.profiles ?? 0 };

  // ── COVERAGE, NOT COUNTS. `attempted: 300` is true whether 300 descriptions arrived or none
  //    did, and that sentence is the standing lesson of this pipeline. So the description column
  //    is counted over exactly these rows, before and after.
  const ids = selected.map(r => r.job_id);
  const describedBefore = countDescribed(db, ids);

  const budget = createDetailBudget({ total: budgetTotal, perCompany: perCo, concurrency: conc });

  let attempted = 0, withText = 0, failed = 0;
  const byReason = {}, byCompany = {};
  // Once a source has said 429 even after its retries, stop asking it for more this pass. Phase 1
  // never produced a 429 from either API, so this path is unexercised against a real one — which
  // is exactly why it must be conservative rather than clever.
  const throttled = new Set();

  await mapWithConcurrency(selected, conc, async (row) => {
    if (throttled.has(row.source)) return;
    if (!budget.take(row.company || '_')) return;

    const outcome = await fetchDescription(row, {
      http, timeoutMs: timeout, sleepFn,
      onRetry: ({ status, waitMs }) =>
        log.warn?.(`[detailFetch] ${row.job_id}: ${status} — backing off ${waitMs}ms`),
    });

    if (outcome.attempted) attempted++;
    const co = row.company || '_';
    byCompany[co] ||= { attempted: 0, withText: 0 };

    if (outcome.ok) {
      byCompany[co].attempted++;
      // ⛔ COUNT THE WRITE, NOT THE RESPONSE. `withText++` used to sit here, before the UPDATE,
      // and a real run caught it immediately: six live fetches returned text, the write threw on a
      // missing column, mapWithConcurrency CONTAINED the rejection by design — and the report said
      // `withText: 6` over a table with zero descriptions in it. That is this pipeline's own
      // signature defect, success-shaped output over an empty result, inside the code written to
      // remove it. Only `coverageDelta` noticed, which is exactly why coverage is the number that
      // gets reported.
      //
      // So the write is awaited, its exception is caught HERE rather than being absorbed by the
      // runner, and a row only counts as having text once the row actually has text.
      let wrote = false;
      try {
        wrote = persistDetailOutcome(db, row.job_id, outcome, now());
      } catch (err) {
        byReason.write_failed = (byReason.write_failed || 0) + 1;
        failed++;
        log.error?.(`[detailFetch] ${row.job_id}: fetched ${outcome.text.length}B and FAILED TO ` +
                    `STORE IT — ${err.message}. The request was spent for nothing.`);
        return;
      }
      if (wrote) { withText++; byCompany[co].withText++; }
      return;
    }

    byReason[outcome.reason] = (byReason[outcome.reason] || 0) + 1;

    // `no_fetcher`/`unaddressable` cost no request; they are defects in our own mapping, not
    // outcomes of a fetch, so they do not burn an attempt and nothing is written.
    if (!outcome.attempted) return;

    byCompany[co].attempted++;
    failed++;
    if (outcome.reason === 'http_429') {
      throttled.add(row.source);
      log.warn?.(`[detailFetch] ${row.source} returned 429 after retries — stopping this source for this pass`);
    }
    // Same containment on the failure side: bookkeeping that cannot be written is worth a line in
    // the log, not a lost pass. The row stays retryable either way, which is the invariant.
    try {
      persistDetailOutcome(db, row.job_id, outcome, now());
    } catch (err) {
      log.error?.(`[detailFetch] ${row.job_id}: could not record the failed attempt — ${err.message}`);
    }
  });

  const describedAfter = countDescribed(db, ids);
  const report = {
    enabled: true, reason: null,
    selected: selected.length,
    attempted, withText, failed,
    byReason, byCompany,
    describedBefore, describedAfter,
    // The only number that answers "did it work": how many of these rows now have text that did
    // not before. Everything else above is an input to it.
    coverageDelta: describedAfter - describedBefore,
    prioritised: priority?.profiles ?? 0,
    budget: budget.report(withText),
    throttledSources: [...throttled],
  };

  log.log?.(
    `[detailFetch] ${selected.length} selected, ${attempted} requests, ` +
    `description coverage ${describedBefore} -> ${describedAfter} (+${report.coverageDelta})` +
    (failed ? `, ${failed} failed ${JSON.stringify(byReason)}` : '') +
    (priority ? `, prioritised by ${priority.profiles} profile(s)` : ', NO title union — ordered by recency only')
  );
  // ⛔ THE DISAGREEMENT CHECK. `withText` counts writes this pass believes it made; coverageDelta
  // counts descriptions the TABLE actually gained. They are derived independently — one from the
  // loop, one from a re-query — and that is the whole point: if they disagree, the loop is lying,
  // and this is the line that says so. It found a real bug on its first real run.
  if (report.withText !== report.coverageDelta) {
    log.error?.(`[detailFetch] ⛔ INCONSISTENT: the pass believes it stored ${report.withText} ` +
                `description(s) but the table gained ${report.coverageDelta}. Trust the table.`);
  }
  if (attempted && report.coverageDelta === 0) {
    log.warn?.(`[detailFetch] WARNING: ${attempted} request(s) spent and NOT ONE description arrived.`);
  }

  return report;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE WRITER
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Persists what a fetch found. Called by the enrichment pass AND by the user-opened-a-job route,
 * because "one implementation, two triggers" has to cover the WRITE as well as the request — two
 * writers is how the two triggers would come to disagree about what a fetch means, and this
 * codebase's bug history is almost entirely two sides that each made sense alone.
 *
 * ⛔ WHAT THIS NEVER WRITES, ON ANY PATH:
 *
 *   content_hash   the "this row has been processed" fingerprint. Writing it here would mark a row
 *                  enrichment has never seen as already done, and it would leave the candidate set
 *                  for good.
 *   enriched_at    same, for the same reason. ⛔ NEVER WRITE enriched_at WHERE NOTHING WAS FILLED:
 *                  a two-step pass has twice as many ways to half-succeed, and stamping a row
 *                  complete when nothing was filled is the exact defect that once nulled 120 rows.
 *                  A 429 mid-fetch is the obvious way to recreate it, so the guard is structural —
 *                  neither column is nameable from this function.
 *
 * On FAILURE it also does not touch `description` or `updated_at`: nothing about the posting
 * changed, and a false `updated_at` would trip enrichmentSelection's `updated_at > enriched_at`
 * pre-filter into re-examining the row forever. The row stays exactly as retryable as it was,
 * one attempt poorer.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} jobId
 * @param {object} outcome  from fetchDescription
 * @param {number} nowEpoch
 */
export function persistDetailOutcome(db, jobId, outcome, nowEpoch = Math.floor(Date.now() / 1000)) {
  if (!outcome?.attempted) return false;   // nothing was spent, so there is nothing to record

  if (outcome.ok) {
    db.prepare(`
      UPDATE scraped_jobs SET
        description = @description,
        -- ⛔ employment_type, NOT contract_type. contract_type is the PLUGIN's field name; the
        -- stored column is employment_type, and aggregator.js:436 is where the rename happens.
        -- Writing contract_type here threw "no such column" on six live fetches — caught by the
        -- live harness, not by the unit suite, whose fixture had invented the column.
        -- (No backticks in here: this comment lives inside a JS template literal.)
        --
        -- ⛔ EXISTING FIRST, AND THIS IS DELIBERATELY THE OPPOSITE ORDER FROM enrichJob's
        -- COALESCE(@new, existing). There, a non-null extraction is MEANT to win, because a later
        -- pass correcting an earlier one is the point and only nulls need to be non-destructive.
        -- Here there is no correction to make: ingestion read this column out of the source's own
        -- structured list field, and JSON-LD's employmentType is not better evidence about the
        -- same posting — it is the same publisher saying the same thing in a second place. So
        -- this FILLS WHEN EMPTY and never overwrites, which is what makes "a fetch can only add"
        -- literally true rather than approximately true. Pinned by test/detailFetch.test.js.
        employment_type = COALESCE(employment_type, @employment_type),
        detail_fetched_at = @now,
        detail_fetch_attempts = COALESCE(detail_fetch_attempts, 0) + 1,
        detail_fetch_error = NULL,
        updated_at = @now
      WHERE job_id = @job_id
    `).run({
      job_id: jobId,
      description: outcome.text,
      // Through the shared normaliser, so this column can only ever receive a spelling its own
      // filter recognises. It fills Workday's employment_type, which ingestion leaves NULL on
      // 100% of rows because `timeType` is not in the list response.
      employment_type: normalizeEmploymentType(outcome.employmentType) || null,
      now: nowEpoch,
    });
    return true;
  }

  db.prepare(`
    UPDATE scraped_jobs SET
      detail_fetch_attempts = COALESCE(detail_fetch_attempts, 0) + 1,
      detail_fetch_error = @reason
    WHERE job_id = @job_id
  `).run({ job_id: jobId, reason: String(outcome.reason || 'unknown') });
  return false;
}

// ── small helpers ───────────────────────────────────────────────────────────────────────────────

/** The ORDER BY's own placeholders have to be bound too — titleUnionPriority already named them. */
function priorityParams(priority) {
  return priority?.params || {};
}

function countDescribed(db, jobIds) {
  if (!jobIds.length) return 0;
  const keys = jobIds.map((_, i) => `@j${i}`);
  const params = {};
  jobIds.forEach((id, i) => { params[`j${i}`] = id; });
  return db.prepare(`
    SELECT COUNT(*) n FROM scraped_jobs
    WHERE job_id IN (${keys.join(', ')})
      AND description IS NOT NULL AND TRIM(description) != ''
  `).get(params).n;
}

/**
 * Migration 107 adds the three bookkeeping columns. Their absence must make this pass INERT rather
 * than throw: this is a background step inside the enrichment cron, and observability must never
 * be the thing that breaks the work it observes (the same rule recordPipelineRun follows, and the
 * same one migration 101's absence follows in enrichJob).
 */
// ⛔ CACHED PER DATABASE, NOT PER MODULE. The first version cached one boolean for the whole
// process, which is correct for production (one db) and wrong for anything else: a caller holding
// two databases — a test file, a migration harness, the verification script that builds a scratch
// copy beside the real board — would get the first db's answer for the second. That is a cache
// that returns a confident wrong answer, which is worse than no cache, and it would have
// manifested as this pass being silently inert against a perfectly migrated database.
const columnsByDb = new WeakMap();

export function columnsPresent(db) {
  if (columnsByDb.has(db)) return columnsByDb.get(db);
  let present = false;
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(scraped_jobs)').all().map(c => c.name));
    present = cols.has('detail_fetch_attempts') && cols.has('detail_fetched_at')
           && cols.has('detail_fetch_error');
  } catch { present = false; }
  columnsByDb.set(db, present);
  if (!present) {
    console.warn('[detailFetch] migration 107 not applied — detail fetching is INERT. ' +
                 'No request will be made and no row will be touched.');
  }
  return present;
}

/**
 * Forget what was cached. Tests that ALTER a table mid-file (the write-failure test renames
 * employment_type out from under the writer) need this, because the schema genuinely changed
 * underneath a database the WeakMap has already answered for.
 */
export function _resetColumnCache(db = null) {
  if (db) columnsByDb.delete(db);
  // No db given means "forget everything", which a WeakMap cannot enumerate — so callers that
  // want a clean slate should pass the database. Kept parameter-optional for the existing call
  // sites, which create a fresh database immediately afterwards and therefore need nothing.
}
