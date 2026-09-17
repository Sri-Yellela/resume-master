# Next Work

**Last reconciled:** 2026-09-17, after the ATS/curation audit. Closed findings are in
**`docs/FINDINGS_ARCHIVE.md`**; every wrong claim this project has made, with what replaced it, is in
**`docs/CORRECTIONS_REGISTER.md`**.

**Baseline: 2443 passing, 0 failing.** Production is **`eecbe09`**, contract **v1.1.1**, migration
high-water **106**, `monetisationEnabled: false` — confirmed by
`GET https://resumemaster.one/api/version`, which is now the one-curl answer to "what is deployed".

**The unpushed-commits banner below is HISTORICAL and resolved.** Those four commits shipped; the
full merge deployed ten including the monetisation lever, anonymous spend controls, the version
endpoint, migration 106 and task Y.

> ⚠ **Re-derive state from the repo before starting anything.** This file has now been the stale
> thing **seven** times — AK2 found three of five tasks already done, AL1 two of three, AM3 two
> claims wrong, AM4 the central premise of its own task inverted, 09-15 found six landed commits
> still listed as open, 09-16 its own headline banner wrong about production, and 09-17 the
> `skills_json` figure it had carried for weeks **wrong by 2.7×**.
>
> `/api/version` turned "what is deployed" into one curl. **Nothing has done the same for "what is
> true"** — which is why every brief now instructs measuring the premise first, and why three briefs
> in a row had their central premise inverted by the first measurement taken.

---

## ⭐ Current work — curation consolidation

The ATS/curation audit of 2026-09-17 found **three systems deciding one question**, and the one that
actually decides the board had never been measured.

| | what it is | agreement with the scorer |
|---|---|---|
| **A** `profileTitleSql` + the `job_role_map` INNER JOIN | **hard board membership** | — |
| **B** the profile→board bridge | 3-valued sieve; top band **217 rows deep, internally unordered** | ρ **0.3797** best case · **0.1508** thin résumé · **−0.0222** owner's profile as stored |
| **C** `scoreAtsLocally` | the band on the card | ρ 0.737 against human grading |

⛔ **A excludes the best matches before either scorer runs.** Of the 30 postings the owner graded,
only **8** survive a `["Software Engineer"]` board. 22 excluded, including **5 of the 12 graded 5** —
among them `Backend Engineer, Credit Decisions @ Stripe`, which the engine scores **60, its
second-highest**, excluded because the title lacks the literal word "software".

**Plan and five sequential tasks: `docs/CURATION_CONSOLIDATION.md`.** CC1 runs alone and first.

**Two claims that audit retired:**
- `skills_json` is **99.8%** covered (1,263/1,266), not 37%. The constraint is whole-value `LIKE`
  against a 6,130-string vocabulary that is **70% singletons**, capped at 6 terms drawn from a
  hardcoded list of 32.
- G1's synonym table did not measure "+0.000" — **it has no effect path.** No server call site passes
  `synonyms` to the scorer. The 196 proposals awaiting review are for a table nothing that scores
  reads.

---

## ✓ RESOLVED — the section below is historical

Those four commits shipped on 09-16/17; production is `eecbe09`. Kept only because the probe method
it records — `GET /api/config` answering **200 with the SPA shell** rather than the route — is the
third time a catch-all 200 stood in for evidence, and the reason `/api/version` now exists.

| Commit | What production was missing (RESOLVED) |
|---|---|
| `c4320e1` | The monetisation lever. **`/pricing` is live right now saying "paid upgrades are being prepared"**, with tier badges and upgrade prompts, while the Chrome Web Store trader declaration says NON-TRADER. |
| `a9d70c6` | The six lever screenshots (docs only). |
| `2c28507` | The ATS badge fix. Every card on the production board still reads "No signal" and still contradicts the panel one click away. |
| `857fa32` | ⚠ **The anonymous spend controls.** `/api/standalone/generate` is live, unauthenticated, running Sonnet at 8192 max_tokens, with a quota keyed on a cookie the caller resets by opening an incognito window. Migration 105 is not applied. This is the one with a running meter. |

**Pushing is the highest-value action available and is blocked on nothing.** Railway deploys from
`main` only, ~190s, and builds the client itself.

---

## Open

| # | Task | Repo | Needs | State |
|---|---|---|---|---|
| **Y** | SmartRecruiters + Workday descriptions | desktop | — | **PHASE 1 PROBED + PHASE 2 BUILT 09-17.** The N+1 is real, nothing rate-limits, yield is 100%. Fetch moved crawl → enrichment. **The SOURCES are still off** — see below |
| **AB + AH** | Vestigial keys, small deferred items | desktop | — | **all but AB-1 closed** — AH-1/2/3/4 done or answered 09-16/17, see below. AB-1 is an owner action (remove `THEIRSTACK_API_KEY`) |
| ~~**AF residual**~~ | A write path for `app_settings.apply_full_auto_disabled` | desktop | — | ✅ **DONE 09-17**, `1bb2a29`. GET/PUT/DELETE `/api/admin/full-auto`, three states, strict boolean. One definition in `services/appSettings.js` so the admin surface and the pipeline cannot disagree |
| **AG** | Mobile corruption sweep | android | — | **partly done** — `f337767` repaired SYNC.md's encoding. The BOM/toolchain half and a verifying build remain |
| ~~**Monetisation audit**~~ | `docs/MONETISATION_AUDIT.md` | desktop | — | ✅ **DONE 09-16.** Part 1 audit + Part 2 lever, `c4320e1`. See "Recently landed". |
| ~~**AH-1**~~ | A version endpoint | desktop | — | ✅ **DONE 09-16.** `GET /api/version` — commit SHA, contract version, migration high-water mark. Answers "is 105 deployed?" in one curl. Undeployed until the push. |
| **sweepExpiredPackets** | extension | — | — | open, deliberately unbundled — the sweep filters `startsWith('gate:')`, so two of four session keys never got the expiry the policy promises |
| — | iOS Phase 1 audit | ios | **a Mac** | open — brief written at `resume-master-ios/PHASE_1_AUDIT.md` |

**AB/AH, item by item, so nobody re-derives them:** AB-1 THEIRSTACK **confirmed vestigial** (only
consumer is the offline `scripts/providerEval`) — removing the key is an owner action, not a build.
AB-2 "SERPAPI half-wired" — **premise wrong**: the key is read, `searchJobs` includes serpapi, and
`POST /api/jobs/search` reaches it. It is absent only from `cacheJobs`, by design
(`ATS_SOURCE_NAMES`). AH-1 version endpoint ✅ **DONE 09-16**, `GET /api/version`. AH-2 drop
`import_extension_tokens` ✅ **DONE 09-17**, migration 106. AH-4 retire `QUEUED_PROMPTS.md`
✅ **DONE 09-17** — replaced with a tombstone rather than deleted, because `ak2-session-report.md`
cites it twice.

### AH-3 — ANSWERED, and the answer is "not yet, and it is now armed at 100%"

The question was whether the restored local board's synchronised 7-day expiry had already fired.
**It has not.** The last `runExpiredJobsCleanup` was `cleanup_log` id 95 on **2026-09-08T17:57**,
which deleted 0, and nothing has run in the nine days since — the cron only runs while the process
lives, and the local server has not been left up.

But every row is now past the cutoff:

```
active rows           1266
scraped_at range      2026-09-02 → 2026-09-07     (all of it, from the restore rebase)
cutoff today          2026-09-10
would expire NOW      1266 of 1266   = 100% of the board
```

⛔ **The next pass is a whole-board event.** What stands in front of it is the brake
(`services/jobs/cleanupBrake.js`, wired at `server.js:4394`): the board is 1266, above
`DEFAULT_MIN_BOARD` 50, and the share is 1.0, above `DEFAULT_MAX_SHARE` 0.5 — so the pass is
**refused and the rows are RETIRED (`is_active = 0`) instead of deleted**. That is the designed
behaviour, it is reversible, and it is exactly the case the brake was written for after
`cleanup_log` id 85 destroyed 1288 of 1291 rows.

So the local board will not be LOST, but it will go inactive and vanish from discovery the first
time the local server runs long enough to hit the 03:00 cron or a startup pass. If you want it to
survive as an active board, rebase `scraped_at` forward again — the same step the restore needed.
**Production is unaffected**: it is refilled daily, so its rows never all age past the cutoff
together.

### Task Y — probed, restructured, and the SOURCES are still off

Two documents carry the detail: **`docs/DETAIL_FETCH_PHASE1_FINDINGS.md`** (what the sources
actually do) and the header of **`services/jobs/detailFetch.js`** (why the code is shaped this way).
The short version:

**Phase 1 answered the two questions the brief asked.** The N+1 is **real** for both sources — 11
SmartRecruiters query variants and 19 Workday body/query variants against live boards, every
response **byte-identical**, and no RSS/Atom/sitemap on either. So nothing was deleted. But the
problem the budget was built to solve **does not exist**: ramping concurrency 2→32 produced **zero
429s** in 124 requests per source, and neither API emits a `RateLimit-*` or `Retry-After` header at
all. Requests were never the scarce thing.

**What was scarce is enrichment.** A crawl wants **1,500 detail requests** (Ubisoft 300 + Bosch 900
+ Adobe 300, measured with the real plugins — `aggregator.js` passes an empty query, so there is no
title filter at crawl time and the cap is 900). `ENRICH_DAILY_MAX_ROWS` is 300. A crawl-time fetch
therefore buys 1,200 descriptions a day that nothing can ever enrich, **by construction**. That, not
politeness, is why the fetch moved.

| | before (task Y) | now (phase 2) |
|---|---|---|
| where the fetch happens | inside each plugin's `search()` | inside the enrichment drain, step zero |
| what bounds it | `ATS_DETAIL_FETCH_BUDGET`, its own budget | the day's **remaining** enrichment rows |
| Workday's door | CXS detail API + a threaded tenant/site slug | the public page's **JSON-LD**, a GET of the URL already on the row |
| concurrency | 2 (guessed) | 8 (Workday's **measured** knee) |
| per-company yield | assumed 0% | **measured 100%**, 75 of 75 sampled |

**The one-budget mechanism is a subtraction**, and it is the load-bearing line: the drain asks for
`maxRows - alreadyQueued` descriptions, so if the queue already fills the day it buys **none**.
Two budgets that cannot disagree because there is only one. Pinned by `test/enrichmentDrain.test.js`.

**Migration 103's "648 rows at 0% description coverage" was wrong**, and it is the stated reason
those companies are inactive. Sampling 25 postings spread across each board returned **25/25 with
text, every company, zero failures**. The 0% was the absence of our own second request.

⛔ **THE SOURCES REMAIN OFF, AND THAT IS NOW THE ONLY GATE.** All three companies are still
`active = 0` in `company_ats_list`, so the crawl ingests nothing from them and the fetch pass finds
nothing to do — today's board is 1,266 of 1,266 rows already described. The **capability** is on by
default (`ENRICH_DETAIL_FETCH=0` is the kill switch), deliberately: keeping a second `0` default
would mean enabling a source later ALSO required finding an unrelated flag, which is how a feature
ships broken. Enabling a source is a separate decision, and the numbers to decide it on are: **1,500
detail requests per crawl, ~$3.90 and 5 days of enrichment for the first full pass, against ~1% of
those rows matching any current profile's target titles.**

**What phase 2 deliberately did NOT build, with reasons:**

- **Auto-deactivation of low-yield companies (2D).** Downgraded to measurement. Its premise —
  companies returning 0% descriptions — is false, so it would guard a condition that does not occur
  while adding a new way to lose a healthy company to one bad crawl. `pipeline-health` now reports
  `detailAttempts`, `detailObtained`, `detailYield` and `detailExhausted` per company; a human reads
  them. The finding that *would* justify it is high attempts with zero yield, and it is now visible.
- **Conditional requests (2E).** SmartRecruiters honours `If-None-Match` with a real 0-byte 304 on
  both endpoints (Workday sends no validator and `no-store`). Implemented **nowhere**: this pass only
  fetches rows with NO description, so there is never a prior ETag to send, and a dormant second path
  is the `_ghCompanies` failure. Recorded as an unbuilt opportunity for a future re-fetch design.
- **Overwriting `posted_at` from JSON-LD's exact `datePosted`.** It is strictly better than
  `parsePostedOn`'s reading of "Posted 30+ Days Ago", but ingestion already fills the column on 100%
  of rows, so a COALESCE can never reach it and replacing it would mean an overwriting write.

**Two defects found while counting, both pre-existing:**

- `workday.js` maps `contract_type` from `job.timeType`, and `timeType` is **absent from 100/100**
  live list postings — NULL on every Workday row, always. The fetch now fills the real stored column
  (`employment_type`, via the shared `normalizeEmploymentType`) from JSON-LD's `employmentType`.
- **Silent truncation.** Bosch is capped at **900 of 4,840** postings (SmartRecruiters caps its page
  size at 100 without saying so; deep offsets to 4800 do work), and Adobe at **300 of 711** (Workday
  returns 400 for any page size above 20). Both are the `0de67c8` shape — a cap that discards without
  saying so. Neither is fixed; both are recorded.

⛔ **ON WORKDAY, "GONE" AND "NO DESCRIPTION" ARE THE SAME RESPONSE.** Verified live: a deleted or
invented posting path returns **200 with the SPA shell and no ld+json**, not a 404 — the same
catch-all that makes `/external_experienced/feed` answer 200 for a feed that does not exist. No
status code will separate them, which is why the per-row attempt cap (`ENRICH_DETAIL_MAX_ATTEMPTS`,
3) is the only thing bounding spend on a taken-down Workday posting. The cap never marks a row done:
`content_hash` and `enriched_at` are never written by the fetch, on any path.

**Measured user-visible latency for fetch-on-open**, through the real route against live sources:
SmartRecruiters **604ms**, Workday **561ms** on a first open; **5-6ms** once cached; **4ms** for a
source with no fetcher. That is why the panel has a real loading state rather than showing
"No description available." for half a second and then correcting itself.

⛔ **`scripts/migrations.js` IS NOT THE ONLY MIGRATION LIST.** `server.js` carries its own inline
copy and *that* is the one the boot runner executes. A migration added only to `scripts/migrations.js`
**never runs in production**. Migration 107 was written to the wrong one first;
`test/migrationListsAgree.test.js` now fails if the two disagree.

Android's remaining work is in `resume-master-android/ANDROID.md` and the annotated header of
`PHASE_2A.md` (uncommitted): admin build flavour, backup excludes, then the feed and review queue.

---

## Recently landed — 2026-09-16, on `main`, UNPUSHED

| Commit | What it was |
|---|---|
| `857fa32` | **Anonymous spend, bounded three ways.** The quota was keyed on `req.sessionID` — a cookie the caller resets at will — in front of the largest per-call cost in the system. Now: IP keying (migration 105), a standalone-auth requirement on `generate` only (`/ats` stays anonymous; Haiku, and it is the hook), and `ANON_DAILY_SERVICE_CEILING` (50/day) as a backstop against rotating addresses. ⛔ The ceiling is checked BEFORE the per-caller allowance, or it would only ever bind callers already over their own limit. Not behind the monetisation lever — a cost control must bind whether or not the product is commercial. Also corrected two public claims: `/features` advertised "3 free scores / month" (the signed-in number) under a "no account required" heading, and the recommended `/pricing` card rendered `--color-primary-text` on a `--color-primary` fill, i.e. invisible. `scripts/an2StandaloneSpend.mjs` proves all of it against a real server **and spends nothing** — the limiter sits in front of multer, so a malformed request consumes quota and reaches no model. |
| `2c28507` | **The ATS badge and the panel it opens were reading two different fields.** `/api/jobs` emits `matchScore` (mapJobRow); every desktop surface reads `baseAtsScore` (the poll mapper). Nothing on the client read `matchScore` — zero references — so all 1,266 cards took the null branch and read "No signal" while the panel scored for real. `test/matchScoreReachesTheClient.test.js` had already fixed the SERVER half and its own comment records the client half as the reason the bug survived. Second, separate half: on a card `null` means *nobody scored this row* (1,262 of 1,266), not "the scorer declined", so a 0.1% band rendered on ~100% of cards. The badge is now absent without a score; the fourth band is untouched and still renders in ATSPanel. ⛔ `scripts/ak2BandSurfaces.mjs` had been green throughout because its stub set `baseAtsScore`, a key `/api/jobs` has never emitted — a fixture that invents the field under test measures the fixture. |
| `a9d70c6` | The six lever screenshots. **5.8 MB, not the ~186 KB assumed when approved** — recorded in the commit body rather than quietly accepted. |
| `c4320e1` | **Monetisation: one lever, off by default.** Part 1 established that the deployed product *cannot* take money (no processor, no key, twelve probed payment routes all answering with the SPA shell) but *does* claim it will. `shared/monetisation.js` is the single flag; OFF means ABSENT, not disabled — `/pricing` 404s, the Pricing link goes from all **four** navs (the fourth was found by a screenshot, not by reading), tier copy is replaced, and `/api/plans/request-upgrade` answers 404 rather than a 403 upsell. Gates and their tests are intact; the lever decides whether they are CONSULTED. The flag is read LIVE rather than cached, because a module constant made both states unreachable in one test process. `scripts/an1MonetisationLever.mjs` boots the server twice and shares ONE BASIC user across both. |

⚠ **The first run of the lever harness passed its most important check for the wrong reason** — "a
BASIC user is SERVED by a PLUS-gated route" went green on a **401**, because registration had
failed and nobody was logged in. An unauthenticated refusal is not evidence that a gate opened.
Same shape as the three guards that shipped blind. It now rejects 401 explicitly.

---

## Landed earlier — all six formerly on `fix/ats-per-company-cap`, now on `main` and DEPLOYED

| Commit | Date | What it was |
|---|---|---|
| `0de67c8` | 09-09 | **The 900-posting cross-company cap.** All seven ATS plugins sliced the *flattened* cross-company array at `pageSize*3`. `_companies` arrives in sqlite rowid order with no `ORDER BY`, so the cut fell at stripe 616 + airbnb 170 + figma 114 = exactly 900, and every company past it contributed nothing while the run recorded `status: 'ok'`. Eighteen of twenty-three active slugs sat at zero; all seven probed were healthy HTTP 200. Fixed as a **per-company** cap in `collectCompanyJobs` (`sources/base.js`) — deliberately not a total, because a total is what let adding a company silently evict another. Recovers **1,551 postings per crawl** (greenhouse +1,365, ashby +186). |
| `260e656` | 09-09 | **AC residual.** Health derived from `written`, never `status` — production had logged three consecutive days of `fetched 25 / written 0` as `ok`. Adds `wrote_nothing` ordered above `stale`, per-company-slug grain scoped by `source = ats_type`, and the alert surface AC item 2 actually asked for. AC itself was already built and deployed; rebuilding it would have been the AK2 failure for the sixth time. |
| `0364855` | 09-09 | **AA — the export → enrich → import loop, proved at 20 rows** against production. Dry run (`perColumn {skills_json: 20}`, `skippedNonNull 20`), apply, verify (only the gain plus three documented stamps changed), revert (**0 differences across 20 rows × 15 columns**), re-apply. Every row carried a deliberately wrong `summary` so that "nothing else is touched" was testable rather than merely unobserved. ⛔ Proves the pipeline, **not** model obedience — no provider was called. Found ingestion writing a bogus enum in passing. |
| `1e1f91a` | 09-13 | **AE — a bounded drain, not a bigger constant.** Plus `ENRICH_DAILY_MAX_ROWS 300`, the first spend ceiling enrichment has ever had. Clears the backlog in 4 days for ~$2.09; the old 25/day against 28/day inflow was **−3/day and never cleared**. Two premises corrected: `ENRICH_BATCH_SIZE` was a hardcoded literal with nothing to set, and **there is no enrichment cron** — it is fire-and-forget inside `cacheJobs` *and* `cacheJoboFeed`, both on the single 04:00 ET tick, so the second is refused daily by the concurrency guard. |
| `f670b24` | 09-13 | **Z — premise inverted. The board never lost its badge.** `ae5BoardUi` searched `body.innerText` for `/\b7[0-9]\b/`, correct until `7494289` (08-31) replaced the number with a band label. From that day two harnesses asserted opposite things — `ak2BandSurfaces` that the raw number is absent, this one that it is present — and this one lost. Task X filed a regression against a board that had rendered correctly for eight days. **No product code changed.** The check now derives its expectation from `shared/atsBands.js`. |
| `34bb047` | 09-13 | **AD.** Pace on **tokens**, not requests: Groq is documented at 30 req/min and *measured* at 8,000 TPM, so an ~1,400-token enrichment call exhausts the account after about six — the limiter sat under its own ceiling and handed back a wall of 429s. One window carries `{at, tokens}` so the two limits cannot disagree. Plus `services/modelCatalogue.js`, a boot-time `GET /v1/models/{id}` that **refuses to boot on a retired model id** — the failure that degraded four Sonnet paths silently for two months. |

---

## Owner actions, not agent work

| | |
|---|---|
| **Extension submission** | **In flight.** The dashboard's Privacy practices tab was filled from `STORE_LISTING.md` on 2026-09-15 and verified against the shipped manifest and the deployed policy — no contradiction in permissions, data-use ticks or description. Two documentation contradictions found and **fixed 09-15** — ⚠ the `storage` justification must be **re-pasted** from the revised `STORE_LISTING.md`. Two items still open below. Still needs the Google login and the `CWS_*` credentials to upload |
| **AF5** — 30 real applications, 10 per ATS | the only test of whether ρ = 0.746 predicts anything about **employers** rather than about your own judgement |
| **Judge the ~1,422–2,000 in-place rewrites** | §4 of `PART1_RECONCILED.md` now gives you evidence rather than just a count |
| **196 synonym proposals** | low value — G1 moved ρ by **+0.000**. Skim the obvious or leave the table dormant |
| **Jobo** | deferred to launch readiness, not pending |

### Extension submission — the two documentation contradictions are FIXED

Both landed 2026-09-15. The policy now enumerates **four** stored keys with their real storage areas
and real lifetimes — `lastCapture` (local, until uninstall), the `gate:{tabId}` packet (session, ten
minutes, cleared on tab close), `lastGatedHandoff` (session, until restart) and `batch:{tabId}`
(session, until tab close or the queue empties) — and states explicitly that the ten-minute expiry
covers only the packet, because `sweepExpiredPackets()` filters on `startsWith('gate:')`. **The fix
was to the policy, not the code:** two undisclosed session keys were honest behaviour with dishonest
documentation. `PRIVACY_RECONCILIATION.md` gained a verified third-party table (DuckDuckGo in,
Clearbit recorded as retired) and `STORE_LISTING.md`'s storage justification was rewritten.

⚠ **The owner must re-paste ONE dashboard field**: the `storage` permission justification, from the
revised `STORE_LISTING.md`. Nothing else in the dashboard changed — permissions, data-use ticks,
single purpose and description are all untouched.

Three new guards in `test/privacyReconciliation.test.js`, each **proved to fail** by injecting the
violation: the policy's stated count is pinned to the number of `chrome.storage.*.set` sites in the
extension (a fifth key fails the suite); the ten-minute caveat is pinned to the sweep's `gate:`
filter; and the reconciliation table's third-party set is pinned to the set the policy names, in
both directions. The last one is the gap that let the Clearbit row rot — the pre-existing test
checked the *policy* against the code and never this file's own enumeration.

### Still open against the extension submission

1. ⚠ **Adzuna is over-disclosed.** `isConfigured()` needs `ADZUNA_APP_ID` *and* `ADZUNA_APP_KEY`;
   neither is in the Railway inventory, so in production Adzuna receives **nothing** while the policy
   states flatly that search terms "are sent to Adzuna when you search". True on a dev box, where
   both are set. Either narrow the wording or provision the keys — an owner decision about whether
   Adzuna is coming back.
2. **Follow-up, deliberately unbundled:** `sweepExpiredPackets()` arguably should cover every session
   key rather than only `gate:`, since the policy promised an expiry two of four did not get. That is
   a behaviour change and belongs in its own commit.

### Google Fonts — FIXED 2026-09-15, and the finding undercounted it

Self-hosted via four `@fontsource/*` packages imported in `client/src/main.jsx`, and the policy now
names Google Fonts as a former recipient that receives nothing — the same pattern it uses for
Clearbit. **The original finding named one call site and two families; there were two and four.**
`client/src/index.css` line 1 also `@import`ed Instrument Serif and Inter from
`fonts.googleapis.com`, live in the deployed CSS, and self-hosting only the two from `index.html`
would have left Google receiving the same request on the same page while the policy claimed
otherwise. `test/selfHostedFonts.test.js` therefore walks the whole `client/` tree instead of
checking the files that happened to be wrong; five guards, each proved to fail by injection.
`EFFECTIVE_DATE` moved to September 15, 2026.

---

## Enrichment — no longer a trickle

`ENRICH_DAILY_MAX_ROWS 300` bounds the day's work and the day's spend; the drain loops within that
budget and self-limits, doing 28 and stopping when only 28 are queued. Measured: backlog cleared in
**4 days for ~$2.09**, then steady state ~28 rows/day at ~$0.06/day.

⚠ **Still true and still unjudged: ~19–25 values are CORRECTED IN PLACE per 10 rows** — overwhelmingly
`summary` and `normalized_title`, which ingestion had already filled, so they move no fill rate and
are invisible in `columnsClimbed`. `normalized_title` feeds `profileTitleSql`'s board narrowing *and*
the ATS scorer, so they are not cosmetic. **Only `skills_json` is a real gain.** Before-image:
`POST /api/admin/enrichment/batches/{id}/revert {apply:false}`

Manual trigger, unchanged — `apply: true` now answers **409 `{skipped:true,
skippedReason:'already_running'}`** when it refuses, instead of `applied:true` with zeros:

```js
// DRY RUN — nothing sent, nothing charged
await (await fetch('/api/admin/enrichment/run', { method: 'POST', headers: {'content-type': 'application/json'}, credentials: 'include', body: JSON.stringify({ limit: 10 }) })).json()

// APPLY — run ONCE, wait for the response before running anything else
await (await fetch('/api/admin/enrichment/run', { method: 'POST', headers: {'content-type': 'application/json'}, credentials: 'include', body: JSON.stringify({ limit: 10, apply: true }) })).json()
```

**The economics, unchanged:** enrichment runs under a flat-rate subscription, so an external
export/import round trip costs ~$0 at the margin. That makes export/import the **primary** route and
more ATS providers **desirable** rather than a backlog risk — which is what task Y is for.

---

## Environment — current state

Present in Railway: `ANTHROPIC_KEY` · `APP_BASE_URL` · `FRONTEND_URL` · `GOOGLE_CALLBACK_URL` ·
`GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET` · `JOBO_API_KEY` · `NODE_ENV` · `PORT` ·
`PUPPETEER_EXECUTABLE_PATH` · `SERPAPI_KEY` · `SESSION_SECRET` · `THEIRSTACK_API_KEY` ·
`GROQ_API_KEY` · `GOOGLE_API_KEY`

**Nothing is missing for current operation.** Notes:

- `ENRICH_PROVIDER` / `ENRICH_MODEL` are **correctly absent** — enrichment falls back to Haiku per
  A2's verdict. ⛔ **Do not set them again without re-reading A2**: Groq scored 30.5% Jaccard on
  `skills_json`, which feeds both the technographics table and the ATS scorer.
- `GROQ_API_KEY` and `GOOGLE_API_KEY` are **dormant** in production. Harmless, and correct to keep.
  AD's token pacer is what makes Groq usable when volume justifies it — the free tier binds on
  **8,000 TPM**, not on 30 req/min.
- `THEIRSTACK_API_KEY` is **vestigial** — the only consumer is the offline `scripts/providerEval`
  harness. Safe to remove unless the provider eval will be re-run.
- `SERPAPI_KEY` is **live and correctly wired** for live search; it is absent from `cacheJobs` by
  design. The old "half-wired" note here was wrong.
- Caps default in code: `APPLY_DAILY_CAP` 25, `APPLY_DAILY_QUEUE_CAP` 40,
  `APPLY_DAILY_APPROVAL_CAP` 30, `ENRICH_DAILY_MAX_ROWS` 300. Set them explicitly only to override.
- `ANON_DAILY_SERVICE_CEILING` 50 — total anonymous runs of one standalone service per 24h,
  across every caller. A cost control, not a commercial one; unaffected by the monetisation lever.
- ⛔ `ATS_DETAIL_FETCH_*` **NO LONGER EXIST** — all four were deleted with the crawl-time fetch they
  configured (task Y phase 2). Setting one now does nothing at all, and `test/detailBudget.test.js`
  pins that: a retired lever that still parses is the `_ghCompanies` failure. The replacements live
  on the enrichment side and are **on by default**, because the SOURCES are the gate:
  `ENRICH_DETAIL_FETCH=0` is the one kill switch, with `ENRICH_DETAIL_MAX_ROWS` 300 (the drain passes
  the day's *remaining* rows instead, which is normally smaller), `ENRICH_DETAIL_PER_COMPANY` 100,
  `ENRICH_DETAIL_CONCURRENCY` **8** (Workday's measured knee — not a guess),
  `ENRICH_DETAIL_TIMEOUT_MS` 15000, `ENRICH_DETAIL_MAX_ATTEMPTS` 3. All absent in Railway and correct
  to leave absent. An unreadable value falls back to the measured default, never to zero.
  `routes/apply.js:431-437` already reports when a cap ordering makes another unreachable.
- **The full-auto kill switch EXISTS.** `fullAutoDisabled()` (`routes/apply.js:513`) reads
  `app_settings.apply_full_auto_disabled`, with `APPLY_FULL_AUTO_DISABLED` as a boot default, and
  it is re-checked per job at `:981`, not only at admission. The old "a scan found NO such variable"
  note was looking at env; the switch is in **config**. What is missing is only a write path — see
  AF residual.

---

## Lessons still in force

Load-bearing for work in progress. The full catalogue is in `docs/FINDINGS_ARCHIVE.md`.

**Assert a JSON key, never a 200.** The SPA catch-all answers 200 for any unknown path. It bit again
on 09-15: `https://resumemaster.one/privacy` returns 200 anonymously and contains **none** of the
policy text, because the page is rendered from the JS bundle. Verifying a deployed policy means
fetching `/assets/index-*.js` and grepping it.

**A silent cap is worse than a loud failure.** The 900-posting slice discarded 43% of the crawl for
weeks while every run recorded `ok` and every affected provider answered 200. Cap per unit, never
per concatenation — a total makes the survivors depend on insertion order, which is precisely what
made it undetectable.

**Two harnesses can assert opposite things and neither will say so.** `ak2BandSurfaces` asserted the
raw ATS number is absent; `ae5BoardUi` asserted it is present. Both passed their own suites for eight
days and task Z was filed against working code. **Derive the expectation from the module the product
renders from**, never restate it as a literal.

**A guard never seen to fail is not evidence.** Verify by injecting a violation. Three guards have
shipped blind to the thing they guarded — and on 09-16 a fourth passed on a 401, proving only that
nobody was logged in.

**A fixture that invents the field under test measures the fixture.** `ak2BandSurfaces` stubbed
`/api/jobs` with `baseAtsScore`, which that endpoint has never emitted, and stayed green for
months while every real card read "No signal". Stub what the server actually sends. This is the
browser-level twin of "stub the SHARED constant, never a hostname literal".

**Two names for one column across two mappers is the same defect as two copies of one constant.**
`matchScore` (mapJobRow, the mobile contract) and `baseAtsScore` (the poll shape) read the same
`ats_score`, and the client only ever read one of them. The server half was found and fixed in
AJ2; the client half sat untouched for weeks *with a comment in the test describing it*.

**Health must be derived from what was WRITTEN, not from what was RECORDED.** Three consecutive days
of `fetched 25 / written 0` were logged `ok`, and everything that looked at `status` agreed.

**Report coverage, not counts.** `enriched: 10` is true whether ten rows gained everything or
nothing. An ATS source is only wired when its NORMALIZED rows carry the fields.

**A fallback that returns the same provider is not a fallback.** Both `fetchLogoUrl` and
`fetchCompanyIcon` answered "this provider is unreachable" with that provider's own URL. 1290 rows.

**A dead IDENTIFIER outlives its host, and no host probe sees it.** Three for three: the Groq model
id, task W's lever slugs, Clearbit. Only Clearbit was a dead hostname. AD's boot-time catalogue probe
is the general answer — ask the provider whether the id still exists, once, at startup.

**Pace on the limit that BINDS.** A limiter throttling the wrong axis reports success while the thing
it guards fails. And price the pre-send estimate at full `max_tokens`, or the limiter throttles
harder than the provider does for the mirror-image reason.

**A harness that stubs a third party cannot report that third party dying.** Stub the SHARED
constant, never a hostname literal.

**Do not undo the reverted ATS floor fix.** Measured worse: ρ 0.448 → 0.242. Pinned by a test.

---

## Cross-references

`docs/PART1_RECONCILED.md` (current state of record) · `docs/MONETISATION_AUDIT.md` (queued) ·
`docs/FINDINGS_ARCHIVE.md` · `docs/RECONCILE_AND_RESIDUAL.md` · `docs/CORRUPTION_SWEEP.md` ·
`resume-master-android/ANDROID.md` · `resume-master-ios/IOS.md` · `docs/AUTOAPPLY_PROMPTS.md` ·
`docs/GATED_HANDOFF_ARCHITECTURE.md` · `docs/PIPELINE_DIAGNOSIS.md` ·
per-task reports `docs/a{j,k,l,m}*.md`, `docs/w1-ats-providers.md`, `docs/x1-clearbit-dead.md`
