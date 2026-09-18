# Detail-Fetch Economics — probe, then restructure

Task Y built an N+1 detail budget for SmartRecruiters and Workday, **off by default**, written from
documentation and never run against a live tenant. Before it is enabled, two things need settling:
whether the N+1 is necessary at all, and whether crawl time is the right moment to pay for it.

Run **Phase 1 alone** and report. It is allowed to conclude that most of Phase 2 is unnecessary.

---

## The reframing that governs everything below

**The binding constraint is not requests — it is enrichment capacity.**

Current state: 1,266 active rows · `skills_json` ~37% · **`ats_score` 4 of 1,266** · enrichment was a
25-row/day trickle until AE's bounded loop.

SmartRecruiters and Workday would add rows that arrive unenriched, unscored and unrankable. **Solving
the request problem in order to add more unenriched rows makes the real problem worse.** Any design
here must answer "and then what enriches them," or it is a bigger backlog wearing a solution's
clothes.

⛔ Do not enable either source at the end of this work without a separate decision. Building the
capability and switching it on are two different things.

---

## PHASE 1 — PROBE. No code. Report and stop.

```
⛔ THE DOCUMENTATION IS NOT EVIDENCE. Task W's decisive finding: workable's own source carried a
comment asserting descriptions REQUIRED an N+1, and `?details=true` returned them in the SAME
REQUEST. The comment was wrong and a five-minute probe disproved it. Lever's three configured
company slugs all 404'd because those companies had moved off Lever. Assume nothing about either
ATS's real behaviour.

Probe LIVE TENANTS. Report raw findings, not conclusions.

1 · BULK / EXPANSION PARAMETERS — the loophole, if it exists
    Against real SmartRecruiters and Workday boards, try list-level expansion:
      ?expand= · ?fields= · ?include= · ?full=true · ?details=true · ?view=full
    Workday's list endpoint already takes a JSON POST body with limit/offset/appliedFacets — probe
    additional body keys, not just query strings.
    ⛔ If ANY of these returns descriptions in the list response, the N+1 does not exist for that
    source and services/jobs/detailBudget.js should be DELETED for it rather than tuned. Say so
    plainly; do not preserve a module that guards a problem you disproved.

2 · NON-API SURFACES — a different door with different limits
    a. JSON-LD. ATSes emit schema.org JobPosting markup in the public job page's <head>, because
       Google Jobs indexing requires it, and that markup INCLUDES description. Still one request
       per job, but a different endpoint, different rate limiting, and the canonical PUBLIC
       representation rather than an internal API we are guessing at. Check both sources.
    b. RSS/Atom feeds. Some boards publish feeds carrying the full body in <content:encoded>.
       Greenhouse has one. If either of these does, that is N descriptions in ONE request.
    Report the exact URL shape that worked, and whether the description is complete or truncated.

3 · CONDITIONAL REQUESTS
    Do either source honour ETag / If-Modified-Since? A 304 is nearly free and often counts
    differently against a rate limit. Report per source, with the actual response headers.

4 · ⛔ MEASURE THE REAL RATE LIMIT. DO NOT PACE ON A GUESS.
    This project already paid for that mistake: the code paced Groq on 30 requests/minute when the
    binding limit was 8,000 TOKENS/minute — about 2 calls/min, making a full pass ~9.7 hours. The
    pacing axis was simply wrong.
    Find each source's actual limit empirically: what triggers a 429, what Retry-After says, whether
    the limit is per-IP or per-token, and whether it is requests or bytes.

5 · YIELD PER COMPANY
    For each currently-configured company on these two sources: how many postings, and what
    fraction actually carry a description when fetched?
    Task W seeded Ubisoft (97), Bosch (334) and Adobe (217) INACTIVE at 0% description coverage —
    648 rows that could never be enriched. Apply the same test here BEFORE spending anything.

6 · WHAT THE CARD ACTUALLY NEEDS
    Enumerate every field the board card renders, and confirm which come from the LIST response.
    Expectation: title, company, location, salary, freshness, automation_tier all do, and only the
    description does not. If that holds, the description is needed for exactly three things — the JD
    panel, enrichment, and ATS scoring — and all three happen AFTER a user shows interest. That
    finding is what licenses Phase 2.

OUTPUT: raw findings per source · a plain statement of whether the N+1 is necessary for each · the
measured rate limits · per-company yield · and a recommendation on which parts of Phase 2 are still
needed. Write no code.
```

---

## PHASE 2 — Restructure. Only what Phase 1 shows is necessary.

### 2A · Lazy detail fetch, folded into enrichment ⭐ the core change

```
Move the description fetch OUT of crawl time and INTO the enrichment pass.

WHY THIS IS THE RIGHT SEAM, not merely cheaper:
Task Y's budget creates a SECOND spend budget — one at crawl time, one in enrichment — in two
places, with two pacings and two ways to be wrong. Two budgets that can disagree is the defect shape
this codebase pays for most: mapJobRow vs the client mapper · popup vs hotkey · three hardcoded tab
lists · 'mid level' vs 'mid' · matchScore vs baseAtsScore. Collapse them into one.

THE PLUMBING MOSTLY EXISTS:
  · enrichJob already SKIPS description-less rows and reports them as noDescription.
  · content_hash is hash(title, description) — so a row whose description ARRIVES LATER naturally
    changes its hash and becomes an enrichment candidate with NO new selector logic.
  · AE's bounded loop already paces and reports coverage per column.

1. The crawl writes rows with NO description, cheaply, from the list response alone.
2. Enrichment fetches the description AND enriches it in one pass, under ONE budget.
3. ⛔ A FETCH FAILURE MUST LEAVE THE ROW RETRYABLE. enrichJob's failure path deliberately leaves
   content_hash and enriched_at unset. A 429 or a 404 on the detail fetch must take that same path —
   never stamp a row as done because its description could not be fetched. That poisoning cost 120
   rows once and a 429 recreating it is the obvious way to do it again.
4. ⛔ NEVER WRITE enriched_at WHERE NOTHING WAS FILLED. Same rule, restated because a two-step pass
   has twice as many ways to half-succeed.
5. A row with no description shows "Not enough signal" until opened. That is an EXISTING, honest
   band — not a fabricated score. Confirm the band surface handles it without inventing a number.
6. Report the per-column coverage delta, not row counts. "fetched: 300" is true whether 300
   descriptions arrived or none did.
```

### 2B · Fetch on open

```
If a user opens a job whose description has not been fetched, fetch it then — one request for a job
someone actually cares about, cached permanently.

1. Reuse the SAME fetcher as 2A. One implementation, two triggers — the convergence rule that the
   popup/hotkey split taught.
2. Cache permanently. content_hash already exists; a fetched description is never re-fetched unless
   the posting changes.
3. It must degrade honestly: if the fetch fails, the panel says the description is unavailable. It
   does NOT show an empty panel, and it does NOT report success.
4. Report the latency a user actually sees, measured, and whether it needs a loading state.
```

### 2C · Title-union prioritisation, only if pre-fetching survives Phase 1

```
If any pre-fetch remains, do not fetch all 300 postings from a 300-opening company. Most will never
be shown to anyone.

1. The board is a GLOBAL pool by design, so it cannot prioritise by one user's profile. Prioritise
   by the UNION of all active profiles' target_titles — a handful of terms at current user count.
2. Title-level matching from the LIST response alone is enough to sort "could plausibly be shown"
   from "never will be". A 301-request crawl becomes ~21 with no loss anyone would notice.
3. ⛔ This is a RANKING of what to spend on, never a filter on what to INGEST. Do not drop rows from
   the board because no current profile matches them — the store-then-filter architecture exists
   precisely so the pool is profile-agnostic and curation happens at query time.
4. State how the union is computed and how often it refreshes. A stale union silently starves new
   profiles.
```

### 2D · Per-company yield, automated

```
Task W did this by hand. Make it self-correcting.

1. Track descriptions-obtained per request-spent, per company.
2. A company returning 0% descriptions should cost ONE crawl to learn that, not one crawl per
   crawl forever. Auto-deactivate with the measured reason recorded where a future session reads it
   — that is what W did manually for Ubisoft, Bosch and Adobe.
3. ⛔ Auto-deactivation must be REVERSIBLE and VISIBLE. A company silently dropped because of one
   bad crawl is a silent data loss, which is this project's most-repeated failure shape. Record it,
   surface it in the health check, and allow a re-probe.
4. This belongs in AC's per-source health check, not beside it. AC already measures field coverage
   on written rows rather than endpoint reachability — exactly the right measurement. Extend it;
   do not build a parallel monitor.
```

### 2E · Mechanics

```
1. Bounded concurrency with backoff. 300 sequential requests at ~300ms is 90 seconds of pure
   latency; eight concurrent is twelve. Pace on the limit MEASURED in Phase 1 item 4 — never on a
   documented or assumed number.
2. Honour Retry-After on 429. Do not retry blindly.
3. Conditional requests if Phase 1 found them supported.
4. ⛔ If Phase 1 found a bulk parameter, JSON-LD or an RSS feed for a source, DELETE the N+1 path
   for it. Do not keep a dormant N+1 beside a working bulk fetch — a second unused path is how
   `_ghCompanies`/`_leverCompanies`/`_ashbyCompanies` silently capped live search at three of seven
   sources, invisibly, because a plugin with no companies returns an empty result rather than an
   error.
```

---

## Verify

**Phase 1:** raw probe output per source · a plain yes/no on whether the N+1 is necessary · measured
rate limits with the evidence · per-company yield · which Phase 2 parts remain justified.

**Phase 2:** a crawl writes rows with no description and spends no detail requests · enrichment
fetches and enriches in one pass under one budget, reporting per-column coverage · a 429 mid-fetch
leaves the row retryable and stamps nothing · opening an unfetched job fetches once and caches · a
failed fetch says so rather than showing an empty panel · both sources still route through
`reconcileFingerprint`/`computeReqUid` and derive `automation_tier` via the shared function (W
verified 0 NULL tiers across 1,385 rows — keep it there) · sources stay OFF at the end, pending a
separate enable decision.

---

## The honest bottom line, for whoever runs this

The cheapest outcome is that Phase 1 finds a bulk parameter or a JSON-LD path and most of Phase 2
is deleted rather than built. **That is a success, not a wasted phase.** Task Y's budget module
exists because a comment in `workable.js` was believed instead of tested; the same belief is what
this phase is checking.
