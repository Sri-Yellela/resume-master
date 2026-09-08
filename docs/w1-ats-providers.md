# Task W — wire the remaining ATS providers

**Date:** 2026-09-08 · **Baseline before:** 2301 tests · **After:** 2314 tests, 0 failing.
Migrations **102** and **103** (local high-water now 103; production still 101 until deploy).

---

## The brief's central premise was half right

> "What is missing is the CONFIGURED COMPANY BOARD LIST."

True for four of the five. **Not true for lever**, which had a company list all along — three active
rows seeded by migration 056 — and had recorded `no_results` on **five consecutive crawls** without
ever advancing its watermark. The list was present, the plugin was registered, and the fetcher
worked. The *slugs were dead*.

`pipeline_runs` answers item 1 per source without any guessing, which is what it exists for:

| source | status × 5 crawls | cause |
|---|---|---|
| **lever** | `no_results` | 3 active companies, **all three slugs 404** |
| **workday** | `skipped_unconfigured` | no company list |
| **smartrecruiters** | `skipped_unconfigured` | no company list |
| **workable** | `skipped_unconfigured` | no company list |
| **recruitee** | `skipped_unconfigured` | no company list |

They do **not** share a cause, and the two are distinguishable in the log — recording status per
source rather than per crawl is what made this readable at all.

### Lever specifically

Lever's public API is alive: `api.lever.co/v0/postings/spotify?mode=json` → **200, 75 postings**.
All three seeded slugs return `404 {"ok":false,"error":"Document not found"}`. Each company was
re-probed across all three single-slug providers before being moved:

| company | seeded as | actually on | measured |
|---|---|---|---|
| Mercury | `lever/mercury` 404 | **`greenhouse/mercury`** | 59 fetched → 40 kept |
| Ramp | `lever/ramp` 404 | **`ashby/ramp`** | 141 fetched → 96 kept |
| Retool | `lever/retool` 404 | *nothing found* — 404 on greenhouse, lever **and** ashby | — |

Retool is **deactivated, not deleted and not guessed**, exactly as migration 070 did for Rippling.
`active = 0` is honoured by `cacheJobs`' `WHERE active = 1`, so it stops costing a failed request
every crawl while the row survives as a record to reactivate.

The reason this hid for five crawls: every ATS plugin wraps each company in
`.catch(err => { console.warn(...); return []; })`. Three dead slugs and one healthy empty board
produce the identical outcome — an empty array and a `no_results` row.

---

## A second, wider defect: live search was structurally capped at three of seven

Not in the brief, and worth more than the company lists.

`searchJobs()` took `_ghCompanies`, `_leverCompanies`, `_ashbyCompanies` as three **named
parameters**, and `server.js`'s `POST /api/jobs/search` pre-split `company_ats_list` into exactly
those three. So workday, smartrecruiters, workable and recruitee — registered in `SOURCES`,
validated at boot, mapped in `automationTier.js`, and fully handled by `cacheJobs` — could only
ever be handed an empty list on the live-search path, no matter how many companies the table held.

It was invisible because **an ATS plugin given no companies returns an empty result, not an error**,
which reads as "that provider had nothing today".

Both call sites now group the same table through one exported helper,
`groupCompaniesByAtsType()`, keyed off `DIRECT_ATS_SOURCES`. Onboarding a provider is one decision
— a `company_ats_list` row — instead of also editing a function signature and its caller.
`test/atsCompanyGrouping.test.js` pins it, including a source-text assertion that neither call site
has re-grown a hand-rolled `ats_type === '…'` filter. **Verified by injection**: reintroducing the
filter fails the guard with `actual: [ "ats_type === 'greenhouse'" ]`.

---

## Three source-level defects, found by running the plugins against live boards

Endpoint reachability proves nothing here. What matters is field coverage on the **normalized**
rows — a fetcher that works while the normalizer reads a field the API does not send yields 100%
nulls, which is the `descriptionSections` defect ashby already had.

| source | before | after | fix |
|---|---|---|---|
| **workable** | description **0/20** | **20/20** | `?details=true` |
| **recruitee** | description raw HTML (`<p><span style=…>`) | clean text | `htmlToText`, joining `description` + `requirements` |
| **lever** | description **51/60**, prefix-only `slice(0,3000)` | **60/60** | `truncateWithTail` + HTML fallback |

### Workable: the code comment was wrong, and it was the expensive kind of wrong

```js
// NOT a deliberate omission: Workable's list endpoint has no description field, so getting
// one needs a per-posting detail fetch (an N+1 against the API). Left unfixed while this
// source contributes no board rows …
```

There is no N+1. `apply.workable.com/api/v1/widget/accounts/{slug}?details=true` returns
`description` for **every job in the same request** — the identical trade greenhouse's
`content=true` and ashby's `includeCompensation=true` already make. One query parameter, same
round-trip, larger body. The comment had turned a missing query param into a permanent
architectural excuse.

### Lever

`descriptionPlain?.slice(0, 3000)` was a prefix-only cut at a limit no other source uses. Both
halves mattered: compensation, benefits and EEO text sit at the **bottom** of a posting, so the cut
dropped exactly what enrichment reads — and 9 of 60 Spotify postings omit `descriptionPlain`
entirely, which the `|| null` turned into no description at all rather than falling back to HTML.

---

## Item 2 — Workday

Workday is already structurally handled and did **not** need forcing into the single-slug shape.
`sources/workday.js` encodes the three things a Workday board needs —
`ats_slug = "wdNumber|tenant|site"`, e.g. `5|adobe|external_experienced` — in the existing column,
rather than adding Workday-only columns every other provider would leave null. Confirmed live:
`adobe` returns **300 fetched → 217 kept**.

What it still needs, none of it in this task's scope:

1. **Descriptions.** The CXS search response carries no job text. Unlike Workable, this is a real
   N+1 — a per-posting detail fetch.
2. **Real dates.** The list endpoint gives `"Posted Today"` / `"Posted 30+ Days Ago"`;
   `parsePostedOn` approximates, so `posted_at` is an estimate on every Workday row.
3. **Locations.** `locationsText` is sometimes a count, not a place — Adobe's first row reads
   `"2 Locations"`.
4. **Per-tenant slug discovery.** No registry; the wd# subdomain varies per tenant and a wrong one
   is an HTTP 422 (`1|nvidia|NVIDIAExternalCareerSite` → 422).

---

## Items 3 & 4 — every writer routes through the shared derivations

**Grep-proven.** Three production writers touch `scraped_jobs`; the rest of the matches are tests
and one-off harnesses under `scripts/`:

| writer | `reconcileFingerprint` | `deriveAutomationTier` |
|---|---|---|
| `services/jobs/aggregator.js:216` (`upsertCanonicalJob`, shared by cacheJobs + importJob) | ✅ (4 call sites) | ✅ line 413 |
| `server.js:3840` (LinkedIn scrape) | ✅ line 3885 | ✅ line 3937 |
| `server.js:6999` (live-search write-back) | ✅ line 7017 | ✅ line 7049 |

`upsertCanonicalJob` is the shared path, so a new ATS source inherits both automatically — nothing
new bypasses them. `computeReqUid` is called once, inside `reconcileFingerprint`.

**Item 4 verified empirically, not just by reading.** Across **1385 candidate rows** from all five
sources, `deriveAutomationTier` returned NULL **zero** times. The interesting case is recruitee:
its `careers_url` is a customer's own domain (`jobs.channable.com`), so URL detection reads
`generic` — the source-name fallback catches it and yields `direct`. `PLATFORM_TIER` already covers
all seven providers and `uncoveredDirectAtsSources()` guards that.

Confirmed on the real crawl (below): 141 new rows, **0 NULL** `automation_tier`, `fingerprint`,
`req_uid` or `sources_seen`.

---

## Item 5 — SERPAPI_KEY and THEIRSTACK_API_KEY

**`THEIRSTACK_API_KEY` — vestigial in production.** Its only consumer anywhere in the repo is
`scripts/providerEval/adapters/theirstack.js`, an offline evaluation harness. No import from
`server.js`, `services/` or `routes/`; no write path; it cannot produce a row. It is not set
locally. Keep it only if the provider eval will be re-run — nothing in production reads it.

**`SERPAPI_KEY` — live, and half-wired.** Not vestigial: probed with the real key, it returned
4 rows. Why §3.5 found no serpapi rows, in three parts:

1. **No cron path at all.** `cacheJobs` filters to `ATS_SOURCE_NAMES`; serpapi is an aggregator, so
   it is never crawled. Its only writer is the live-search write-back, which fires only when a user
   runs a search.
2. **It cannot answer the cron anyway** — `search()` early-returns on `!query?.trim()`, and
   `cacheJobs` calls with `query: ''`.
3. **Half its results are filtered before they can be written.** Google Jobs returns aggregator
   URLs; measured **2 of 4 survive `filterDirectApplyOnly`** (two `linkedin.com` blocked). The
   survivors were `jobmesh.io` and `bebee.com` — themselves aggregators that simply are not in
   `BLOCKED_URL_PATTERNS`.

So: a live key on a source that can only ever write on user-initiated searches, and whose output is
mostly middlemen. Worth a decision, not a fix.

---

## Item 6 — measured volume, before enabling

`fetched` is what the API returns; **`kept`** is what survives `classifyJob`'s blue-collar eject and
`roleKey === null` drop inside `cacheJobs` — the only number that becomes board rows. `desc%` is
description coverage on kept rows, after the fixes above.

### Enabled — +141 rows on a ~1266-active board, all 100% desc

| provider | company | fetched | kept | desc% | tier |
|---|---|---|---|---|---|
| lever | Spotify | 75 | 54 | 100% | direct |
| lever | Match Group | 74 | 54 | 96% | direct |
| lever | Wealthfront | 23 | 17 | 100% | direct |
| lever | OpenX | 7 | 4 | 100% | direct |
| lever | Tala | 7 | 2 | 100% | direct |
| workable | Blueground | 20 | 2 | 100% | guest |
| workable | Skroutz | 12 | 2 | 100% | guest |
| workable | Persado | 3 | 2 | 100% | guest |
| recruitee | Channable | 12 | 3 | 100% | direct |
| recruitee | Hygraph | 2 | 1 | 100% | direct |

Plus the two repointed companies: Mercury **40**, Ramp **96**.

### Seeded but INACTIVE — with the measured reason, not "we did not check"

| provider | company | fetched | kept | why held back |
|---|---|---|---|---|
| lever | Veeva Systems | 899 | **596** | Quality is fine. **+47% board size from one company** while enrichment drains at 25/day. Volume only. |
| smartrecruiters | Ubisoft | 282 | 97 | **0% description** |
| smartrecruiters | Bosch | 900 | 334 | **0% description** |
| workday | Adobe | 300 | 217 | **0% description** |

Switching the bottom three on would add **648 permanently unenrichable rows** — `enrichJob.js`
skips description-less rows, so they would never gain `skills_json`, which is the only column
enrichment is actually a real gain on. Both SmartRecruiters and Workday need a genuine per-posting
detail fetch, and an N+1 of that size has no budget model in `cacheJobs`' shared crawl loop. That is
the follow-up, and it is a scheduling problem, not a parsing one.

`test/companyAtsList.test.js` pins the inactive state with the reason, so flipping either on
without first adding the detail fetch fails the suite.

---

## Verified end to end, on a copy of the real database

`cacheJobs(db, null)` — real network, real upserts, `anthropic: null` so no enrichment spend.
Every prediction above matched the crawl exactly:

```
[cacheJobs:lever]     186 fetched, 131 new/changed, 55 dropped
[cacheJobs:workable]   35 fetched,   6 new/changed, 27 dropped, 2 blue-collar ejected
[cacheJobs:recruitee]  14 fetched,   4 new/changed, 10 dropped
[cacheJobs:workday]         No companies configured — skipping   (deliberate)
[cacheJobs:smartrecruiters] No companies configured — skipping   (deliberate)
```

Board 1266 → 1619 active. ashby +96 (Ramp), greenhouse +116 (Mercury plus new postings on existing
boards). Guard coverage on the 141 new rows: **0 NULL** across `automation_tier`, `fingerprint`,
`req_uid`, `sources_seen`; 2 of 131 lever rows have no description (postings with no body).

⚠ This ran against a **copy**. The live board is unchanged until the next cron pass after deploy.

---

## Two traps worth keeping

**SmartRecruiters returns HTTP 200 with `totalFound: 0` for a company that does not exist.** A
status-code probe "confirms" boards that were never there — the same shape as the SPA catch-all
lesson. `Ubisoft` reads as a valid empty board; the real identifier is **`Ubisoft2`**. The ids are
opaque, case-sensitive and have no discovery endpoint, so a SmartRecruiters slug can only be
validated by **asserting a non-zero `totalFound`**. Greenhouse, lever, ashby, workable and recruitee
all 404 honestly.

**A 200 with zero jobs is not the same as a 404, and both matter.** `lever/kraken` and
`ashby/mercury` both return 200 with an empty list — real boards a company has emptied. Treating
those as dead deletes a row that will repopulate; treating a 404 as empty keeps a request failing
every crawl forever.

---

## Not done, and why

- **SmartRecruiters / Workday descriptions.** Genuine N+1, no budget model in the crawl loop.
  Seeded inactive with the numbers recorded.
- **Slug discovery is manual and low-yield.** ~20% of guessed slugs are live. There is no registry
  for any of these providers. The seeded set is deliberately small and every entry is probed.
- **`MIGRATIONS` is duplicated.** `scripts/migrations.js` calls itself "single source of truth for
  both server.js's boot-time migration runner and the standalone CLI runner", but `server.js:383`
  holds its own inline copy — **two 110-entry arrays** that must be edited in lockstep. They are
  currently identical (asserted while adding 102/103). This is the codebase's most-cited defect
  class sitting in its migration runner; making `server.js` import the shared array is a small,
  separate change and was left out of this task.
