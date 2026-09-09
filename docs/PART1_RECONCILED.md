# Part 1 — Reconciled status, 2026-09-09

Read-only. Nothing was changed, applied, reverted or deployed. Every number below was derived from
production (`https://resumemaster.one`, authenticated admin, `GET /api/admin/db/raw-query` and
`/api/admin/db/pipeline-health`), from the repository, or from a live probe of the provider's own
API. Where a planning-doc claim and the evidence disagree, the evidence is recorded and the claim
is listed under **Doc corrections**.

---

## 0 · THE HEADLINE — a live defect that outranks the entire residual list

**All seven ATS plugins truncate their cross-company result set at 900 postings, and the
truncation is silent.**

`services/jobs/sources/{greenhouse,ashby,lever,workable,recruitee,smartrecruiters,workday}.js` all
carry the identical shape:

```js
async search({ query, _companies = [], pageSize = 50 }) {
  const MAX = pageSize * 3;                     // cacheJobs passes pageSize: 300  →  MAX = 900
  const results = await Promise.allSettled(_companies.map(...));
  const jobs = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []))
    .slice(0, MAX);                             // ← applied to the FLATTENED, cross-company array
}
```

`_companies` comes from `SELECT * FROM company_ats_list WHERE active = 1` with **no `ORDER BY`**,
so the array is in sqlite rowid order. `flatMap` concatenates each company's postings in that
order and `.slice(0, 900)` discards the tail. **Every company that falls past the 900th posting
contributes nothing at all**, and the run is still recorded `status: 'ok'`.

Measured live against the providers' own APIs, 2026-09-09, with both folds run over a single fetch
of production's own `company_ats_list` so the difference is measured rather than inferred:

| source | active slugs | postings the provider serves | old fold admits | **recovered** |
|---|---|---|---|---|
| greenhouse | 9 | **2,265** | 900 | **1,365 (60%)** |
| ashby | 4 | **1,086** | 900 | **186 (17%)** |
| lever | 5 | 187 | 187 | 0 — under the cap |
| workable | 3 | 35 | 35 | 0 — under the cap |
| recruitee | 2 | 14 | 14 | 0 — under the cap |
| | | **3,587** | 2,036 | **1,551 per crawl** |

Per company, greenhouse:

```
company    slug       fetched  old_fold  new_fold  recovered
Stripe     stripe     616      616       616       0
Airbnb     airbnb     170      170       170       0
Figma      figma      157      114       157       43     ← the company the slice bisected
Anthropic  anthropic  595        0       595       595
Brex       brex       282        0       282       282
Duolingo   duolingo    89        0        89        89
Scale AI   scaleai    211        0       211       211
Mercury    mercury     58        0        58        58
Vercel     vercel      87        0        87        87
```

**The cut lands on exactly 900**: stripe 616 + airbnb 170 + figma 114. ashby's rowid order is
notion 131 + openai 769 = 900, so OpenAI lost 12 and Ramp (145) and Linear (29) were severed whole.
That lever, workable and recruitee recover nothing is the useful control — all three sit under the
cap, which is why **task W's +141 rows will arrive intact** and why the defect was invisible in W's
own measurements.

The board carries **1,255 active rows from exactly five distinct companies** — OpenAI 536,
Stripe 468, Notion 98, Airbnb 79, Figma 74. Eighteen of the twenty-three ACTIVE company slugs
contribute zero rows.

Seven of those zero-row slugs were probed live and **every one is healthy**:

```
greenhouse/anthropic  HTTP 200  597 jobs   board: 0
greenhouse/brex       HTTP 200  282 jobs   board: 0
greenhouse/scaleai    HTTP 200  212 jobs   board: 0
greenhouse/duolingo   HTTP 200   89 jobs   board: 0
greenhouse/vercel     HTTP 200   87 jobs   board: 0
ashby/ramp            HTTP 200  145 jobs   board: 0
ashby/linear          HTTP 200   29 jobs   board: 0
```

The cut happens **inside the plugin, upstream of `classifyJob`, `reconcileFingerprint` and
`cacheJobs`**, so no downstream counter can see it — which is why the source still reports `ok`.

**Root cause** is one method serving two callers with opposite needs. `search()` is also the live
`POST /api/jobs/search` path, where `pageSize` is 10–20 and a bounded result set is correct.
`cacheJobs` reuses the same method with `pageSize: 300` as a "give me everything" signal, and the
cap was never designed for a crawl.

**Why this is the same finding as everything else in the doc.** The host is up. The identifier
(slug) is alive. The run reports `ok`. Rows silently never arrive. It is task X's observation —
*"host liveness is the easy check and the rare failure"* — one level deeper: even the per-source
row count is the easy check. Only a **per-company-slug** row count sees this.

**FIXED after the audit, by the owner's decision to take it first.** `collectCompanyJobs` in
`services/jobs/sources/base.js` caps each company independently; all seven plugins now route
through it and none carries a copy of the fold. `test/atsCompanyCap.test.js` pins the behaviour and
adds a source scan asserting no registered plugin re-slices across companies — the structural half
was proved to fail by reverting one plugin to the old fold, so it is a guard that can fail rather
than one that merely passes. Suite: 2,334 pass, 0 fail. Verified against the live provider APIs at
**1,551 postings recovered per crawl**; awaiting the next daily cron to become board rows.

---

## 1 · Ground truth

| | Claimed | Actual | |
|---|---|---|---|
| Test suite | 2301 | **2326 pass, 0 fail, 0 skipped** (23.7 s) | doc stale |
| Migration high-water LOCAL | 103 | **103**, `103_seed_remaining_ats_companies`; 104 entries in the `MIGRATIONS` array, 6 legacy non-numeric ids in `schema_migrations` | ✔ |
| Migration high-water PRODUCTION | "deployed by the owner — confirm" | **103. Confirmed.** | ✔ |
| Contract version | — | `contract/mobile-api.v1.json` → **1.1.1** | |
| git log since 339c9d1 | — | `54d43da` task V → `a0b0fcc` task W → `8abd5a4` task X | ✔ |

Production migrations, asserted by JSON key (`columns`/`rows` present on the real handler) and not
by status code, per the standing warning that the SPA catch-all answers 200 for any unknown path:

```
103_seed_remaining_ats_companies   applied_at 1788928062   2026-09-09 04:27:42Z
102_fix_dead_lever_slugs           applied_at 1788928062   2026-09-09 04:27:42Z
101_enrichment_batches             applied_at 1788886544
```

**Both 102 and 103 are in production.** The catch-all trap was live during this audit and caught
three probes: `/api/version`, `/api/admin/version` and `/api/admin/db/version` all return
**HTTP 200 with HTML**. Only `/api/health` is a real route, and it returns `{ok, time}` only.

### The timing that decides tasks 3a and 3b

```
migrations 102/103 applied   2026-09-09 04:27Z   (1.2 h ago)
last source_sync crawl       2026-09-08 08:00Z   (21.7 h ago)
```

**The last crawl ran 20.5 hours BEFORE the migrations landed.** Every `no_results` and
`skipped_unconfigured` in `pipeline_runs` predates the deploy. Task W's row effect has not yet had
a single opportunity to occur, and the next daily cron is the first crawl that will see the new
company list.

---

## 2 · Per-task status — evidence, not the doc's claim

| Task | Doc says | **Verdict** | Evidence |
|---|---|---|---|
| W — company lists | done, "+141 rows" | **PARTIAL — code and data deployed, row effect UNPROVEN** | migrations 102/103 in prod ✔; all 10 active companies and all 6 inactive present ✔; but board is **1,255 active, unchanged**, because no crawl has run since the deploy |
| W — searchJobs cap of 3/7 | fixed | **DONE** | `groupCompaniesByAtsType` in `aggregator.js:597`; `_companies: companyMap[source.name]` reaches all seven plugins; `_ghCompanies`/`_leverCompanies`/`_ashbyCompanies` are gone. Deployed in the same commit as migration 103 |
| X — logos | done | **DONE** | production holds **1,333 / 1,333 duckduckgo** URLs. Zero clearbit, zero google-favicon |
| X — no second provider | confirm | **DONE** | the only surviving clearbit/google strings are `RETIRED_LOGO_HOSTS` in `backfillCompanyLogos.js`, a *repair* list used to rewrite bad rows, plus comments. Nothing issues a request |
| X — privacy policy | confirm | **ALREADY DONE** | `PrivacyPage.jsx:381-385` discloses "DuckDuckGo Icons" and states Clearbit is retired and receives nothing. No update needed |
| **AC — health check** | **open, "deferred ~15 times"** | **LARGELY DONE AND DEPLOYED** | `GET /api/admin/db/pipeline-health` (`routes/adminDb.js:71`), landed in `a8bc438`, live in production, consumed by `client/src/pages/admin/DBInspector.jsx`, covered by `test/pipelineHealth.test.js` |
| **AF — kill switch** | **"a scan found NO such variable"** | **DONE, one real gap** | `fullAutoDisabled()` (`routes/apply.js:513`) reads `app_settings.apply_full_auto_disabled` first, `APPLY_FULL_AUTO_DISABLED` as boot default. The scan looked at env and the switch is in **config** |
| AF-2 mid-flight | verify | **DONE** | `routes/apply.js:981` is inside the per-job worker and its own comment says "Re-checked per job, not just at admission … the kill switch can be flipped while a run is in progress". Admission gate is separately at `:1657` |
| AF-3 cap interaction | verify | **DONE** | `routes/apply.js:431-437` already validates and reports when `APPLY_DAILY_QUEUE_CAP < APPLY_DAILY_APPROVAL_CAP` or `APPLY_DAILY_APPROVAL_CAP < APPLY_DAILY_CAP` makes a cap unreachable |
| AA — 20-row loop | open | **NOT DONE** | `enrichment_batches` holds ids 1-4, **all `source:'manual'`**. No `source:'import'` batch has ever existed |
| AB-1 THEIRSTACK | open | **CONFIRMED VESTIGIAL** | only occurrences are `.env.example`, three docs, and `scripts/providerEval/` — a one-off eval harness. Nothing in `services/`, `routes/` or `server.js` reads it. Still in local `.env`; Railway env not readable from here |
| AB-2 SERPAPI "half-wired" | open | **PREMISE WRONG** | `isConfigured()` is `!!process.env.SERPAPI_KEY`; production `pipeline-health` reports `serpapi configured: true`, so **the boot log does not name it** and the claimed line cannot be firing. Concretely: the key IS read, `searchJobs` DOES include serpapi, and `POST /api/jobs/search` DOES reach it with a real query. It is absent only from `cacheJobs` — by design, `ATS_SOURCE_NAMES` only |
| AD-1 token pacing | open | **NOT DONE** | `providerTransport.js:64` paces on `spec.requestsPerMinute`. The axis is still requests |
| AD-2 model liveness | open | **NOT DONE** | no startup catalogue probe anywhere; no `models.list` / `GET /v1/models` call |
| AH-1 version endpoint | open | **NOT DONE** | three candidate paths return the SPA catch-all |
| AH-2 drop `import_extension_tokens` | open | **NOT DONE** | table exists in production with **3 rows**; zero code references repo-wide |
| AH-3 local board expiry | "check if it fired" | **HAS NOT FIRED** | local board is **1,296 / 1,266 active**, intact. `valid_through` is NULL on every row, so the mechanism is `scraped_at` staleness, and `scraped_at` has only **2 distinct values** (2026-09-02, 2026-09-07) — the rebase is real and they will still age out together |
| Z — ATS badge | open | **NOT VERIFIED HERE** | needs a screenshot, not an assertion; deferred to its own task per the brief |
| Y — SmartRecruiters/Workday | open | **OPEN**, and correctly gated | both still inactive in production with their reasons in migration 103's comment |

---

## 3 · The claims most likely to be stale — item by item

**a. Task W's +141 rows and the four inactive seeds.** Migrations present. All ten active
companies present with the right `ats_type`/`ats_slug`. Six inactive rows present — Rippling,
Retool, Veeva Systems, Bosch, Ubisoft, Adobe — the four W seeded plus the two prior. Migration
102's three repairs all landed: Mercury is `greenhouse/mercury` active, Ramp is `ashby/ramp`
active, Retool is `lever/retool` inactive. **The reasons are recorded where a future session will
read them**: migration 103's SQL carries a 30-line comment with every measured
fetched→kept number and the reason each inactive entry is inactive. That is the right place.
Row counts per source in production are **ashby 634 active / greenhouse 621 active / everything
else 0** — but see the timing above: no crawl has run since the deploy, so this measures the
pre-W board, and §0 explains why the greenhouse and ashby numbers will not grow either.

**b. searchJobs capped at three of seven.** Fixed and deployed — but §0 shows the fix uncovered a
second, larger cap in the plugins themselves. All seven can now *receive* companies; none of them
can *return* more than 900 postings.

**c. Logos.** Done, in production, and the privacy policy was already updated. Two harnesses that
previously hardcoded `logo.clearbit.com` — `aj2BoardCursor.mjs` and `ak2BandSurfaces.mjs` — now
import `LOGO_HOST` from `shared/companyLogos.js`, so the stub follows the real host. `ae5BoardUi`
does the same and its comment records why: *"Matched against the shared LOGO_HOST, not a hostname
literal: this guard named Clearbit."* The blind-guard shape was repaired at the root.

**d. Enrichment backlog.** **Still exactly 790** — unchanged from the number in the doc. Coverage
on 1,255 active rows, as production reports it:

| column | non-null | % |
|---|---|---|
| description | 1255 | 100 |
| summary | 1255 | 100 |
| normalized_title | 1255 | 100 |
| experience_level | 1255 | 100 |
| workplace_type | 617 | 49.2 |
| salary_max_usd | 576 | 45.9 |
| **skills_json** | **465** | **37.1** |
| is_h1b_sponsor | 5 | 0.4 |
| requires_work_auth | 4 | 0.3 |

`active_missing_skills_json` = 790 = `candidates_never_enriched` = 1255 − 465. Consistent.
`active_no_description_unenrichable` = **0**. `automation_tier` NULL count = **0 of 1,333** — task
W's guarantee is holding.

**e. THEIRSTACK / SERPAPI.** See the table. THEIRSTACK is vestigial as claimed; SERPAPI's
"half-wired" premise does not survive contact with production.

---

## 4 · The unjudged decision — and the evidence inverts the question

Ten pairs from batch 4 (`manual`, `claude-haiku-4-5-20251001`, 2026-09-08 17:24Z, 10/10 written,
$0.0258). **`normalized_title` rewritten in 8 of 10 rows; `summary` in 10 of 10.**

First, a correction to the method: the task said to pull the before-image from
`POST /api/admin/enrichment/batches/{id}/revert {apply:false}`. That dry run returns
`{applied, dryRun, batchId, recordedRows, alreadyReverted, note}` and **no values at all** — it
cannot produce pairs. The before-image lives in `enrichment_batch_rows.before_json`, which the
revert replays; joining it to the live row is the same evidence through a pure `SELECT`.

**The finding: `summary` was never a summary.** `services/jobs/schema.js:186` sets it at ingestion
to `cleanDesc.slice(0, 300)` — the first 300 characters of the description. And
`normalized_title` at `:185` is `cleanTitle.toLowerCase()`, which the file's own comment at line 71
already admits is *"just a lowercased passthrough today"*.

So the 100% fill rate on both columns was measuring non-nullness, not content. Every unenriched
Notion row's "summary" is the same boilerplate:

| | |
|---|---|
| **OLD** | `"WHO WE ARE\n\nNotion is the collaborative AI workspace where teams and agents think together https://www.youtube.com/watch?v=vkpYpWfEK5s. We're building one place where your knowledge, projects, meetings, and AI tools live side by side, so work is faster, clearer, and less fragmented. Millions of indi"` |
| **NEW** | `"Business Development Representative responsible for generating qualified pipeline through outbound prospecting and qualifying high-potential accounts for Solutions Consultants at Notion."` |

That identical OLD string appears in **all ten rows**. The NEW value is per-role in all ten.

`normalized_title` strips the location suffix, which is exactly what a title-matching scorer wants:

| | OLD | NEW |
|---|---|---|
| 1 | `business development representative, france` | `business development representative` |
| 3 | `manager, solutions consultants, dach` | `manager, solutions consultants` |
| 4 | `manager, solutions consultants, france` | `manager, solutions consultants` |
| 5 | `gtm recruiter, tokyo` | `gtm recruiter` |
| 8 | `business development representative, dach` | `business development representative` |
| 10 | `business development representative, uki` | `business development representative` |
| 2 | `smb marketing manager` | *unchanged* |
| 9 | `commercial solutions consultant` | *unchanged* |

Full text of all ten pairs, both columns, is in the scratchpad at `pairs.txt`.

**Nothing is decided here and nothing was applied.** But the question the doc posed — *"nobody has
judged whether the rewrites are improvements"* — now has evidence pointing one way, and it comes
with a second finding: the 1255/1255 coverage number is itself a false signal, of exactly the same
family as the blind guards in item 5. `columnsClimbed` cannot distinguish a summary from a
truncated description, so it reported a column as fully covered while it held boilerplate.
Extrapolated at the observed rate, ~1,422 in-place rewrites remain across the 790-row backlog.

---

## 5 · Guards that may be blind

**Repaired at the root, and worth recording as a success.** The `ae5BoardUi` shape —
a stub that made its own assertion unreachable — is gone from all three harnesses that carried it.
`ae5BoardUi.mjs`, `aj2BoardCursor.mjs` and `ak2BandSurfaces.mjs` now all `import { LOGO_HOST }
from '../shared/companyLogos.js'` and stub *that*, so if the real host changes the stub follows it
or the harness fails. Deriving the fixture from the same constant the product uses is the general
fix for this whole class.

**Candidates found — reported, not fixed:**

1. **`pipeline_runs.status = 'ok'` on a run that wrote nothing.** Production's enrichment history:

   ```
   2026-09-08 08:00   ok   fetched 25   written 25   failed  0
   2026-09-07 08:00   ok   fetched 25   written  0   failed 25
   2026-09-06 08:00   ok   fetched 25   written  0   failed 25
   2026-09-05 08:00   ok   fetched 25   written  0   failed 25
   2026-09-04 08:00   ok   fetched 25   written 25   failed  0
   ```

   Three consecutive days of **total failure recorded as `ok`** — the retired-model-id incident,
   dated. `pipeline-health` classifies on `lastRun?.status === "failed"`, so a run like this reads
   as healthy. **Any alert keyed on `status` is blind to it; it has to key on `written` and on
   coverage.** This is the single most important input to AC's remaining work.

2. **`pipeline-health` cannot see §0.** It aggregates per *source*. greenhouse reports `ok`
   with 621 active rows while six of its nine slugs contribute zero. Only a per-slug row count
   surfaces it, and `pipeline_runs.details_json` records `{ companies: companies.length }` — the
   *count* attempted, never the per-company outcome.

3. **A configured source that never ran reads as `never_ran`, not as an alert.** `adzuna` and
   `serpapi` both report `configured: true, health: "never_ran", active: 0` in production. Correct
   in the narrow sense — they are live-search-only and `cacheJobs` never calls them — but it is the
   exact shape that hid Jobo, and nothing distinguishes "never ran because it is not in the crawl"
   from "never ran because it is broken".

4. **`source = 'scraped_jobs'` on 5 local rows** — a source value named after its own table, plus
   one `source = 'import'` row. Not a test defect, but nothing validates `source` against the
   registered plugin list, so a typo becomes a permanent unfilterable board partition.

---

## 6 · Retired identifiers that no host check would see

Task X's observation generalised. Every row is an identifier that can be retired while the host
stays up and returns 200.

| Dependency | Identifier that can retire silently | Would anything notice? |
|---|---|---|
| Anthropic enrichment | model id `claude-haiku-4-5-20251001` | **Recorded, not noticed** — three days at `failed 25` under `status: ok` (item 5.1) |
| Anthropic elsewhere | `claude-sonnet-4-20250514`, `claude-sonnet-5` | No startup catalogue check exists (AD-2) |
| greenhouse | board token, `/v1/boards/{slug}/jobs` | **No** — per-company; source stays `ok`. §0 makes this worse: a dead slug and a capped-out slug are indistinguishable, both zero |
| ashby | job-board name, `/posting-api/job-board/{slug}` | **No** — same |
| lever | company slug, `/v0/postings/{slug}` | Only because **all three** died at once → `no_results`. One of three dying would be invisible |
| workable | account slug, `/api/v1/widget/accounts/{slug}` | **No** |
| recruitee | company subdomain | **No** |
| smartrecruiters | company id (`Ubisoft2`, `BoschGroup`) | **No** — and the ids are case-sensitive and non-obvious |
| workday | **three** identifiers encoded as `wdNumber\|tenant\|site` | **No** — three independent ways to break behind one string |
| adzuna | `/v1/api` path version + app id/key pair | **No** — `never_ran` |
| serpapi | engine parameter + key | **No** — `never_ran` |
| jobo | API key + `/api/jobs/feed` path | **Yes** — `health: failed`, 27 failed runs, 669 h stale |
| DuckDuckGo icons | `icons.duckduckgo.com/ip3/{domain}.ico` | **No** — browser-side `<img>`; a 404 renders the lettered tile, which is also the correct answer for an unknown company |

The pattern: **the only dependency whose retirement is currently visible is the one that fails
loudly at the transport layer.** Everything that fails by returning a valid, empty, 200 response is
invisible, and eleven of thirteen rows fail that way.

---

## Doc corrections needed

1. `NEXT_WORK.md` / this doc — test count **2326**, not 2301.
2. **TASK AC is largely DONE and deployed.** `GET /api/admin/db/pipeline-health` landed in
   `a8bc438`, is live in production, has a UI in `DBInspector.jsx` and a test in
   `pipelineHealth.test.js`. It satisfies AC items 1, 3 and 4 and the not-configured distinction.
   Its residual is narrow and specific: alert on `written`/coverage rather than `status` (item
   5.1), and go per-company-slug rather than per-source (item 5.2 / §0). Rebuilding it from the
   brief would be the AK2 failure again.
3. **TASK AF is DONE.** The kill switch exists as `app_settings.apply_full_auto_disabled` with
   `APPLY_FULL_AUTO_DISABLED` as the boot default; mid-flight re-checking and the cap-interaction
   validator are both already implemented. `docs/af3-full-auto-guards.md` says "Already live" — so
   two planning docs contradict each other, which is the thing AK2 was rebuilding for.
   **The one real gap:** `app_settings` is empty in production and **no endpoint or UI writes to
   it**. The only ways to pull the switch today are direct DB access or a Railway env var plus a
   restart — and avoiding the restart was the entire point. That gap is the task.
4. **TASK AB item 2's premise is wrong.** Production reports `serpapi configured: true`, so the
   claimed boot log "Inactive (not configured): adzuna, serpapi" is not firing. Both keys are in
   the production environment.
5. **TASK Part 1 item 4's method is wrong.** The revert dry run returns counts, not values, and
   cannot produce before/after pairs. Use `enrichment_batch_rows.before_json`.
6. **Task W's "+141 rows" reads as accomplished and is a prediction.** No crawl has run since the
   deploy. It should say so, and §0 means the greenhouse and ashby figures will not move at all.
7. `AE` states "~6 WEEKS to drain 790 rows". At 25/day it is **31.6 days ≈ 4.5 weeks**.
   Directionally right, arithmetically not.
8. Add §0 to the residual list as its own task. It is not a tuning nit and it is not covered by
   any existing entry.

---

## Recommended order for Part 2

The audit moves three things and removes two.

| | Task | Why here |
|---|---|---|
| **1** | **§0 — the 900-posting cross-company cap** | A live 60%-loss defect on the only two sources producing rows. It also makes AA's and AE's inputs wrong: sizing an enrichment drain against a board that is missing ~1,550 postings per crawl is sizing against the wrong number. One-line-ish fix, then a crawl, then measure |
| **2** | ~~**AC residual only**~~ **DONE** | See below. Not a rebuild — three additions to the existing route, plus the alert surface item 2 actually asked for |
| 3 | **AA** — 20-row loop | Unchanged in substance, but run it *after* §0 so the batch-size and coverage numbers are measured against the real board |
| 4 | **AE** — cron trickle | Its input is the backlog size, which §0 will change |
| 5 | **Y** — SmartRecruiters / Workday | After AC, as the doc argues. Its N+1 budget model must account for the cap in §0 |
| 6 | **Z** — ATS badge | Unchanged |
| 7 | **AD** — token pacing + model liveness | Confirmed NOT DONE, both parts. Item 5.1 is the concrete argument for AD-2 |
| 8 | **AB + AH** | AB-1 confirmed, AB-2's premise corrected, AH-1/2 confirmed not done, AH-3 confirmed not fired |
| 9 | **AF residual only** | Not a build. Add a write path for `app_settings.apply_full_auto_disabled` so the switch can be pulled without a restart |

**Owner, unchanged:** extension upload · AF5 · the 196 synonym proposals · and the ~1,422 rewrites,
which §4 now gives you evidence on rather than just a count.

---

# AC RESIDUAL — completed 2026-09-09

Not a rebuild. `GET /api/admin/db/pipeline-health` already satisfied AC items 1, 3 and 4; these are
the three things it did not do, each tied to a failure that really happened and really went unseen.

## 1 · Health is derived from `written`, never from `status`

Production's own enrichment history is the argument:

```
2026-09-08 08:00   ok   fetched 25   written 25   failed  0
2026-09-07 08:00   ok   fetched 25   written  0   failed 25
2026-09-06 08:00   ok   fetched 25   written  0   failed 25
2026-09-05 08:00   ok   fetched 25   written  0   failed 25
```

Three consecutive days of total failure recorded as `ok`. Every status-keyed check read that as
healthy, and `pipeline-health` classified on `lastRun?.status === "failed"`, so it did too.

Now: a `source_sync` that fetched rows and wrote none is `wrote_nothing`, ordered **above** `stale`
so a source failing every run cannot hide behind having gone quiet. Enrichment runs carry a derived
`health` (`failed` / `degraded` / `idle` / `ok`) alongside the recorded `status`, and **both are
shown** — the contradiction is the finding, so hiding either half would lose it.

## 2 · Per-company-slug health, which is the grain that matters

The source grain reported greenhouse `ok` with 621 active rows while six of its nine active slugs
contributed zero. lever's three dead slugs surfaced only because *all* of them died at once; one of
three dying is invisible one row up.

`companies[]` now carries per-slug rows, description coverage, enrichment count and staleness,
joined on `company` **scoped by `source = ats_type`**. That join is exact rather than fuzzy: every
ATS plugin writes `company: companyName` straight from the `company_ats_list.company` value the
crawl handed it, so both sides are the same string by construction. The scoping matters because
jobo, adzuna and imported rows carry the *provider's* spelling and would otherwise vouch for a dead
ATS slug by coincidence.

Two false-positive suppressions, both load-bearing:

- **`awaiting_first_crawl`** — a company seeded after its source's last successful crawl has not had
  a chance to produce. Migration 103 added ten companies at 04:27Z while the last crawl ran at
  08:00Z the previous day, so without this the panel would have opened with ten false criticals on
  the day it shipped. An alert list with ten false positives is one that gets closed.
- **per-company `stale` is suppressed when the source already reported it** — otherwise one finding
  becomes N identical warnings and buries the per-company results. The per-company table still
  shows each slug's own `staleHours`, which genuinely differ.

Both suppressions are tested in the negative too: a long-standing company at zero rows still
alerts, and a company gone quiet under a *healthy* source still alerts, because nothing else says
it.

## 3 · `live_search_only`, so "never ran" means "should have and did not"

`adzuna` and `serpapi` are configured, correct, and outside the crawl — `cacheJobs` only iterates
`DIRECT_ATS_SOURCES` plus jobo's feed. They read `never_ran`, a warning shape indistinguishable
from Jobo's real months-long failure, and a permanent warning is one nobody reads. `inCrawl` is
derived from `DIRECT_ATS_SOURCES` rather than restated, so a provider added there joins here too.

`not_configured` also now says **which kind**: no API key versus no active companies. One shared
sentence had been telling workday, smartrecruiters, workable and recruitee they were missing a key
none of them uses.

## 4 · The alert surface — what item 2 was actually asking for

Everything above is a table, and a table is a log with better spacing. All three silent failures
were already visible in a panel somebody had to think to open and then read a row of. So findings
are collected into a ranked `alerts[]` with `alertCounts`, rendered **above the stat cards** in a
red-bordered block. An empty list renders too, in green, and says so — a panel that shows nothing
because it computed nothing is indistinguishable from one that checked and found nothing.

Measured against the real local board: **33 alerts before the suppressions, 17 after**, and every
survivor is a genuine finding — the six greenhouse zero-row slugs and `ashby/ramp` among them,
which is §0's defect stated in the surface that should always have been reporting it.

## Verification

- `test/pipelineHealth.test.js` — 11 tests to 27. **All four behaviours proved to fail** against
  the old logic by reverting the route: `wrote_nothing`, the stale ordering, enrichment health, and
  `live_search_only` each failed and were restored.
- One of those tests was **blind on its first pass**: the `live_search_only` test read
  `configured: false` in a test process with no keys and `continue`d past every assertion, passing
  identically against old and new code. It now sets the keys and asserts `configured === true`
  first. That is this project's Shape 5 caught in the act of being written.
- The fixture's `company_ats_list` was missing `active` and `bucket_role`, which made per-company
  health 500 rather than degrade — an under-specified fixture reporting a route defect that did not
  exist. Fixture corrected to the real shape; the route now also degrades to `[]` on any
  per-company query failure, because this panel must never be the thing that breaks.
- `scripts/acPipelineHealthUi.mjs` — new browser harness, 12 assertions, screenshots in
  `data/screenshots/ac-residual/`. It found a layout defect on its first run that no string
  assertion could see: `LIVE SEARCH ONLY` and `NOT CONFIGURED` wrapped to two lines and broke out
  of the pill's rounded background.
- **That guard was itself blind at first.** `getClientRects().length` is always 1 for an
  `inline-block` pill however many lines sit inside it, and `scrollWidth > clientWidth` is always
  false because the box grows in height. Both passed against the broken layout. A `Range` over the
  text contents returns one rect per rendered line, which does work — verified in both directions.
- Suite: **2,351 pass, 0 fail.** Client builds.

## Still open in AC's own terms

AC item 1 asks for field coverage "on those rows" — the rows a given run wrote. What is reported is
coverage per company and per column over all active rows, which is the more useful aggregate but is
not per-run. `pipeline_runs.details_json` records `{ companies: companies.length }` — the count
attempted, never the per-company outcome — so per-run field coverage needs the writer to record it
first. Worth doing when something needs it; nothing does today.
