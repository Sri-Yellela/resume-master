# resume-master — Pipeline Diagnosis (live, evidence-based)

**Status:** OPEN. Started from "0 jobs on the website." Every CONFIRMED line below is backed by
a production query or a grep-verified code path, cited inline. Every OPEN line has the exact
query/grep that resolves it. Nothing here is inferred from the handoff brief.

**Rule for this document:** a claim moves to CONFIRMED only with evidence attached. The brief's
own golden rule applies — trust the repo and the DB, not the status column.

---

## 0. Headline

Four independent failures stacked into one symptom. Each was individually invisible:

1. **Jobo has never run.** `JOBO_API_KEY` unset → silent skip, logged as success.
2. **Enrichment destroys data.** Writes NULL over good values, then stamps the row complete.
3. **Filters hard-failed on NULL.** Three of them; enrichment lag made every one fire.
4. **No descriptions were ever stored.** greenhouse (95% of the board) and ashby both wrote
   NULL descriptions — the *root cause* of (2). See §2.4; fixed this session.

The board went to zero on (3), but (4) is the origin of the data-quality collapse: enrichment
wasn't malfunctioning so much as being handed empty postings and faithfully extracting nothing
from them. Order of causation is (4) → (2); (1) and (3) are independent.

---

## 1. Production state (measured 2026-08-10)

```
active_rows  null_exp  null_workplace  null_skills
684          157       592             684

active  enriched  has_summary  has_norm_title  has_salary
684     120       0            527             0

source      total  active  newest (UTC)
greenhouse  794    651     2026-08-10 08:00   <- today, cron works
ashby       23     23      2026-08-07 08:00   <- 3 days stale
adzuna      10     10      NULL               <- no discovered_at at all
jobo        —      —       —                  <- NEVER WRITTEN
```

Greenhouse is 95% of the active board. The provider the platform pivoted onto contributes 0%.

---

## 2. CONFIRMED failures

### 2.1 Jobo has never executed — ~~`JOBO_API_KEY` unset in Railway~~ **WRONG DIAGNOSIS; see 2.1a**
`aggregator.js:777` — `cacheJoboFeed()` opens with:
```js
if (!joboSource.isConfigured()) {
  console.log('[cacheJoboFeed] JOBO_API_KEY not set — skipping');
  return 0;
}
```
`jobo.js:23` — `isConfigured()` is `!!API_KEY`; `jobo.js:19` — `API_KEY = process.env.JOBO_API_KEY || ''`.

Cron (`server.js:3072`) then logs `'[Cron] Jobo feed sync complete —', 0, 'jobs cached'`. A skip
and a genuine empty sync are indistinguishable in the logs. Zero rows have ever been written,
which is why no `jobo` row exists even with `is_active=0`.

**Fix:** set `JOBO_API_KEY` in Railway. Then make the skip loud — it should warn, and the cron
line should distinguish "skipped (unconfigured)" from "synced 0."

**Related:** `scripts/providerEval/adapters/jobo.js` targets a different, wrong-guess endpoint
(noted in `jobo.js`'s own header). Dead code — cleanup candidate.

### 2.1a The real cause: HTTP 402, swallowed as "sync complete — 0 jobs cached"

The owner confirmed `JOBO_API_KEY` has been set in Railway all along and never rotated, and a
live bounded probe returns HTTP 200 with 10 jobs. **The key is valid.** §2.1 above inferred
"never ran" from the absence of `source='jobo'` rows — an inference, not an observation, and the
wrong one.

What the feed actually returns:

```json
{"error":"Insufficient credits",
 "detail":"This request needs 3000 credits ($3). Your wallet balance is 1890 credits ($1.89).",
 "credits_required":3000,"credits_balance":1890,"cost_per_request_usd":3}
```

Pricing is ~3 credits per job returned, so `JOBO_INCREMENTAL_BATCH = 1000` made every incremental
page cost $3 — more than the wallet holds. `cacheJoboFeed` caught the throw, correctly refused to
advance the watermark, returned its bare `cached` count of 0, and `server.js` printed
*"Jobo feed sync complete — 0 jobs cached."* A hard payment failure rendered as a healthy empty
sync. Same pattern as everything else in this document, which is why the original inference
looked plausible.

Fixed: structured return (`skipped_unconfigured` / `ok` / `failed`), the cron logging all three
differently plus a warn for "fetched N, cached none", axios errors carrying status + body +
an operator hint (402 wallet vs 401/403 key vs 429 rate limit), and `JOBO_INCREMENTAL_BATCH`
env-overridable with a free-tier default of 10.

Two further bugs found while fixing it, both of which would have made that default useless:
`batch_size` was omitted from **cursor** pages (so continuation pages silently reverted to the
API default of 1000 = $3 each — capping the batch only ever made page 1 cheap), and a small batch
means many more requests, which rate-limits itself (HTTP 429 after ~30 pages in seconds; now
paced 2s between pages). Both verified against the live API.

Five more field mappings were reading keys that do not exist in Jobo's response — `workplace_type`
(read nonexistent `is_remote`/`is_hybrid`), salary (read flat `salary_*` instead of the nested
`compensation` object), `posted_at` (fell through to `created_at`), `experience_level` (raw
"Mid Level" rejected by the schema enum), and skills (read nonexistent `job.skills`). Measured on
10 live jobs, before → after: workplace_type 0→8, experience_level 0→10, skills_json 0→9.

### 2.2 Enrichment overwrites good data with NULL, then marks the row done
`enrichJob.js:191` — the UPDATE writes every column unconditionally from `signals`, including
`normalized_title` and `experience_level`, plus `content_hash` and `enriched_at`.

Arithmetic: 120 rows have `enriched_at`, all with `summary`/`salary`/`skills` NULL. Greenhouse
`null_exp` = 124 ≈ those 120. Of the 564 unenriched rows, 527 have `normalized_title`. So
greenhouse ingestion populates `normalized_title` + `experience_level`, and enrichment then
nulls them.

`enrichJob.js:184` filters candidates by `computeContentHash(...) !== r.content_hash`. Since the
success path sets `content_hash`, those 120 rows never re-enter the candidate set. Permanently
poisoned unless title/description changes.

The failure path (`:239`) is correct — on a thrown error it leaves `content_hash`/`enriched_at`
alone. The bug is that an all-NULL LLM result **doesn't throw**; it's indistinguishable from a
legitimate "the JD is silent on this," which the soft-null design expects.

**DO NOT run enrichment again until fixed — each pass nulls more rows.**

Fixes, in order:
1. `COALESCE(@field, field)` in the UPDATE — enrichment may only add, never remove.
2. Treat an all-NULL signal set as failure; don't stamp `enriched_at`.
3. Skip rows with empty `description` before calling the API.
4. Recover: `UPDATE scraped_jobs SET content_hash = NULL, enriched_at = NULL
   WHERE enriched_at IS NOT NULL AND summary IS NULL;`

### 2.3 Filters hard-failed on NULL (fixed, uncommitted)
`jobQuery.js` — `skills_include` (fixed prior session), plus `experience_levels` and
`work_models` (fixed this session, uncommitted). Root cause identical: `NULL IN (...)` and
`NULL LIKE ?` both evaluate NULL → row excluded.

Severity by data: `skills_json` 684/684 NULL → zeroed the board (the actual outage).
`workplace_type` 592/684 → any work-model filter saw ≤92 rows. `experience_level` 157/684 → lost
~23%, and it is bridge-derived by default.

`profileFilterBridge.js` carried a comment asserting only the visa filter needed null-safety —
that belief is what let this ship three times. Corrected.

**Still hard-failing by design:** salary (`jobQuery.js:152/157`) uses
`salary_max_usd IS NOT NULL AND ...`. With `has_salary = 0`, any salary filter empties the board.
Deliberate for a range filter — needs a conscious product decision, not a silent one.
(§2.4 makes this less acute: the ashby compensation fix means salary data now actually lands, so
the filter has something to match. It is still a hard filter and still worth a product call.)

---

### 2.4 No job descriptions were ever stored (fixed, uncommitted) — ROOT CAUSE of 2.2
Verified against the live provider APIs, not inferred:

- `greenhouse.js:33` hardcoded `description: null`, **and** `fetchCompanyJobs` omitted
  `?content=true`. Probing the board endpoint both ways confirms `content` is absent entirely
  without the param and 5173 chars long with it. Two independent bugs on the same field, so
  fixing either alone would still have yielded NULL.
- `ashby.js:42` read `job.descriptionSections`, **a field the posting-api board endpoint does
  not return**. The real fields are `descriptionPlain` (16256 chars on the probe) and
  `descriptionHtml`. `?.map()` on undefined → `|| null` → silent NULL on every row.

This fully explains §2.2. Enrichment was not misbehaving: it was sent empty postings, the prompt
correctly instructs "a silent posting must produce null," the model complied, and the UPDATE
then wrote those nulls over ingestion's values and stamped the row done. It also explains
`has_summary = 0` — `schema.js:180` derives `summary` from the description.

Two further Ashby bugs found while fixing the above:
- `?includeCompensation=true` was missing, so `job.compensation` was **always** undefined and
  `extractAshbyCompensation` always returned `{}`. This is why `has_salary = 0`.
- `summaryComponents[0]` was read as the salary, but that array is a *mixed* list — the probe
  returns `Bonus`, `EquityPercentage` and `Salary` entries in no guaranteed order, and the code
  also read the wrong key names (`compensationRangeMin` vs the actual `minValue`). A leading
  bonus entry would have been stored as base pay. Now selects on `compensationType === 'Salary'`.

Fixed: `?content=true` + `?includeCompensation=true`, correct field names, salary-component
selection, `workplaceType` mapping, and a new `services/jobs/htmlToText.js` (Greenhouse returns
*entity-encoded* HTML — `&lt;p&gt;`, not `<p>` — so a tag-strip alone is a no-op; it decodes,
strips, then decodes again). Verified live: greenhouse 555/555 descriptions and summaries,
ashby 59/59 descriptions and salaries.

**Recovery is automatic — no manual SQL needed.** The doc previously called for clearing
`content_hash`/`enriched_at` on the 120 poisoned rows. That isn't required: the aggregator's
upsert is `INSERT OR REPLACE` and does not list `content_hash`/`enriched_at`, so a re-scrape
resets both to NULL (verified in sqlite) and restores `normalized_title`. And because `_hash`
includes the description (`aggregator.js:97`), every greenhouse/ashby row reads as *changed* on
the next crawl, so the full upsert path runs rather than the cheap touch. The poisoned rows
re-enter the candidate set on their own once the adapter fix deploys.

**Still unfixed by design:** `workable.js`, `smartrecruiters.js` and `workday.js` also hardcode
`description: null`. Each needs a per-posting detail fetch (an N+1 against the provider), and all
three currently contribute zero board rows. Now commented in-place so the gap doesn't read as
intentional. With §2.2 fixed these land *unenriched* rather than blanked.

---

## 3. OPEN — resolve next

**Measurement caveat:** the rows below marked *(local)* were measured against
`data/resume_master.db`, which is a **different snapshot** from the production numbers in §1
(617 greenhouse rows vs 794; it has 5 jobo rows and no adzuna). Treat those as directional and
re-run against production. Items resolved by *code path or live API probe* hold regardless.

| # | Question | Status |
|---|---|---|
| 3.1 | Are descriptions stored? Prime suspect for all-NULL enrichment. | **RESOLVED — no.** Confirmed root cause; see §2.4. Local: greenhouse 617/617 and ashby 21/21 empty, `avg_len` 0; jobo 0/5 empty, `avg_len` 4108. Confirmed independently by live API probe + code path, so this is not snapshot-dependent. |
| 3.2 | Is the LLM even being called? | **Effectively resolved by §2.4.** It *was* called (the 120 rows have `enriched_at`, and tokens were spent) — it was just handed an empty description. Post-fix the pass now warns loudly when a whole batch yields no signal. |
| 3.3 | Is `company_technographics` empty? | **RESOLVED — yes, 0 rows** *(local)*. Downstream of §2.4: skills can only come from a description. Expect it to populate once the adapter fix deploys and enrichment re-runs. FE-4 STACK / FE-6 render empty until then. |
| 3.4 | Why did ashby stop on Aug 7? | **RESOLVED — it probably never stopped.** The two write paths disagreed on what `discovered_at` means: the unchanged-row touch preserved it, but `INSERT OR REPLACE` reset it to `now` on any content change. So a source's apparent freshness tracked how often its postings *churn*, not whether it was still being crawled — and ashby (21 stable postings across Linear/Vercel) reads as stalled next to greenhouse (617 across 8 companies) while both crawl nightly. Fixed: `upsertCanonicalJob` now preserves the prior first-seen. Which explanation held in production is settled by the monitor on the next tick (it records per-source status + rows written, and last-success separately from last-run). |
| 3.5 | Why is adzuna's `discovered_at` NULL? | **RESOLVED — not an adzuna bug; nothing writes adzuna any more.** `cacheJobs` crawls only `DIRECT_ATS_SOURCES`, `cacheJoboFeed` only jobo, `searchJobs` has zero write statements. `discovered_at` is set by `upsertCanonicalJob`, which those 10 rows never went through — they are pre-pivot orphans nothing will refresh. The live consequence is fixed: the recency filter now uses `COALESCE(discovered_at, scraped_at)` instead of hard-excluding NULL, so they are no longer invisible to every date filter and the NEW<24h pill. |
| 3.6 | Are visa flags all NULL? | **RESOLVED — yes, 0 non-null for both** *(local)*. Downstream of §2.4, same as 3.3: the flags are description-derived. The OPT/H1B badge cannot render until enrichment has real text. |
| 3.8 | 2 of 10 greenhouse slugs in `company_ats_list` are dead. | **RESOLVED — and it was FOUR wrong rows, not two** (migration 070). Re-probing every seeded company found: Notion `greenhouse/notionhq` → `ashby/notion` (128 jobs), OpenAI `greenhouse/openai` → `ashby/openai` (732), Vercel `ashby/vercel` → `greenhouse/vercel` (the Ashby board returns **200 with zero jobs** — so it never even logged the warning a 404 produces), and Rippling **deactivated** (404 on greenhouse, ashby *and* lever; no board found, so `active=0` rather than an invented slug). Real crawl after the fix: **11/11 active companies return postings, 2835 total**, up from 8 working. |
| 3.7 | Test baseline: 44 or 45? | **RESOLVED — 44, always. The "45" never existed.** See below. |

---

### 3.7 detail — the 44/45 discrepancy is a counting artifact

Worth writing down because it was set up as the gate on every downstream task, and the
hypothesis attached to it ("a dismissed failure was really reporting the skills_json bug") is
**false**. Resolved by running the suite in an isolated worktree at `19c53f9` (FE-3), the only
commit that ever claimed 45:

```
node's own summary:      ℹ fail 44
raw `grep -c '^✖'`:      89          (= 44 × 2 + 1)
unique `✖` names:        45
the extra, singly-printed line:   "✖ failing tests:"
```

Node's default reporter prints each failure twice — once inline, once in the summary — and the
summary section's **header line itself begins with `✖`**. So `grep '^✖' | sort -u` counts that
header as a 45th test name. The number was 44 at FE-3 and has been 44 at every commit since; **no
test ever changed state**, and nothing was being dismissed as noise.

Two consequences worth keeping:
- The FE-3 commit's "45 unique failing tests" and the eight later commits' "44 unique failures"
  were measuring the same suite with different methods, not observing a fix.
- **Count failures with `ℹ fail N`, never by grepping `✖`.** The latter is both doubled and
  off-by-one-high.

Confirmed against current work: baseline 533 tests / 489 pass / **44 fail**; with all of this
session's work 554 / 510 / **44 fail** — +21 tests, +21 passing, 0 introduced failures. All 44
are pre-existing UI/architecture assertions untouched by this work.

---

## 4. The pattern

Every failure here is **a silent one that logs like success**:

- Jobo skip → "sync complete — 0 jobs cached"
- Enrichment writing nulls → counted as `enriched++`
- NULL filters → an empty board, not an error
- Admin panel shows 178/684 rows existing and looking fine
- A missing `?content=true` → a full page of rows, every description NULL, no warning anywhere
- A renamed provider field (`descriptionSections`) → `?.` short-circuits to null, no error
- A missing `?includeCompensation=true` → `job.compensation` undefined, salary silently null

The last three are the sharpest version of the pattern: **optional chaining and `|| null` turn a
provider contract change into clean-looking data.** Nothing in the pipeline asserts that a field
it depends on actually arrived. A single post-ingest assertion — "greenhouse rows must have a
non-null description" — would have caught §2.4 on the first crawl.

The system has no way to say "I did nothing." That is the actual defect class, and it is why
diagnosis took live production queries instead of a dashboard.

**This is the argument for repurposing the scrape monitor rather than deleting it.** It currently
scrutinises scraped-job processing — an artifact of the pre-pivot architecture. What it should
show is pipeline truth: per-source last-success + row delta, enrichment coverage (% non-null per
column), unconfigured-provider warnings, and dedup collisions. Every failure above would have
been visible at a glance.

---

## 5. Cleanup register — CLASSIFIED (no deletions performed)

Classification pass complete. Every verdict below is backed by a caller grep across `.js`/`.jsx`
excluding `node_modules` and `dist`. **Nothing has been deleted** — this pass was scoped to
classification, and several items turn out to need a decision rather than a delete.

The important finding: *most of this register is not merely unused, it is actively misleading.*
Two items are user-visible dead ends, one is an orphaned write endpoint, and two are dead code
held alive by tests that assert it must still exist.

| # | Item | Callers (proven) | Verdict |
|---|---|---|---|
| 5.1 | `searchQueryBuilder.js` → `buildApifyQueriesFromProfile`, `buildProfileSearchTerms` | `server.js:38` **imports both, calls neither**. `buildProfileSearchTerms`: zero callers anywhere. `buildApifyQueriesFromProfile`: called only by `buildProfileSearchTerms` (itself dead), 3 diagnostic scripts, and tests. | **DEAD, BUT PINNED BY TESTS** — see 5.9. Deleting requires removing the assertions too. |
| 5.2 | `scripts/providerEval/adapters/jobo.js` | 1 importer: `scripts/providerEval/run.js:29`. | **DEAD (self-contained tool).** Targets the wrong-guess endpoint; superseded by `services/jobs/sources/jobo.js`, whose real field mapping is now known (§2.1a). Running providerEval today would produce garbage for Jobo. |
| 5.3 | LinkedIn batch-import UI in `JobsPanel.jsx` | `isLinkedInExtensionInstalled` and `sendExtensionRequest` are **stubs defined at `JobsPanel.jsx:23-24`** returning `false` and `async () => {}`. Called at :1675, :1683, :1692, :1710, :3948. | **REACHABLE BUT PERMANENTLY BROKEN.** The guard at :1692 can never pass, so the flow always opens the "install the extension" modal — for a capability BYO-2 removed and which v1.2.0 deleted from the extension entirely. A user can click this today and get an install prompt that can never satisfy it. |
| 5.4 | `/api/extension/save-jobs-bulk` (`server.js:4737`) | **Test-only.** Its sole client was `saved-jobs-content.js`, removed from the extension in v1.2.0. | **ORPHANED WRITE ENDPOINT.** Still accepts bulk LinkedIn job writes with nothing calling it. Note this outlived its client — the reverse of the usual drift. |
| 5.5 | `/api/extension/save-job` (single, `server.js:4695`) | **LIVE** — `extension/linkedin-content.js:267`. | **KEEP.** Also keeps `imported_jobs` live (`server.js:4716` is its only real writer). |
| 5.6 | `/simulate-jobs/:userId` (`routes/adminDb.js:671`) | **LIVE** — `DBInspector.jsx:1322` (Query Simulator tab). | **LIVE BUT LYING.** Hardcodes the removed `sevenDaysAgo` cutoff, so it simulates a filter the board no longer applies. Worse than dead: an admin debugging tool that reports the wrong thing. Fix or remove — do not leave. |
| 5.7 | `profileMatcher.js` → `scoreJob`, `filterAndRankForProfile` | `server.js:80` **imports, never calls**. | **DEAD, BUT PINNED BY TESTS** (`profileIsolation.test.js:410-411` assert both "must still exist"). Already flagged in bb24241. |
| 5.8 | `usageTracker.trackScrape` → `scrape_events` table | **Zero callers.** Table has 0 rows. | **DEAD.** Note `trackApiCall` (10 callers) is LIVE and is the real writer of `cache_events` — do not delete `usageTracker.js` wholesale. |
| 5.9 | `refresh_log` table | **0 writers, 0 rows.** | **DEAD.** |
| 5.10 | Scrape monitor admin surfaces | — | **DONE — repurposed, not deleted** (5d14c99). See §4. |

**Keep — load-bearing despite scraping-era origin:** the 7 ATS-direct sources (canonically rank
*above* Jobo), `aggregator.js`, `schema.js`, `reconcileFingerprint`/`computeReqUid`,
`enrichJob.js`, `sync_state`. These serve store-then-filter.

**adzuna / serpapi:** no longer a cost decision — settled by 3.5. *No write path produces them
at all.* `cacheJobs` crawls only `DIRECT_ATS_SOURCES`, `cacheJoboFeed` only jobo, and
`searchJobs` contains zero write statements. The 10 production adzuna rows are orphans nothing
will refresh. The plugins remain wired into `searchJobs` (live search) only.

### 5.11 The 44-failure baseline is partly this register in test form

Grouping the 44 pre-existing failures by file changes how they should be read — they are not
uniform noise:

```
10  jobsPipelineHardening      "scrape route guards…", "scrape quota exhaustion…",
                               "local-only scrape unavailable…"   → asserts the REMOVED per-user scrape flow
 7  menuSurfaceStyle           opaque surfaces, avatar menu, profile selector → UI redesign drift
 5  authProviderIntegrations   OAuth/LinkedIn provider wiring
 3  searchSignalsQueue         asserts server.js still calls buildApifyQueriesFromProfile (5.1)
 2  searchProfileIntent        same
 3  profileAtsUiFixes          incl. "saved jobs section renders imported LinkedIn jobs" (5.3)
 3  jobsUiProfileFilters       incl. "LinkedIn import CTA…" (5.3) and the modal-surface convention
 2  jobsUiFollowups   2  profileLifecycleSearchGating   2  integrationsArchitecture
 1× resumeFormatter, resumeArtifacts, localAtsScorer, consoleArchitecture, authRouteBootstrap
```

At least **5 failures directly assert that removed scraping code is still wired**, and several
more assert removed LinkedIn-import UI. That is why the baseline never moves: they are pinned to
a pre-pivot architecture. **This also means deleting 5.1 or 5.7 will *change* the baseline** —
those tests will go from failing-for-the-wrong-reason to absent. Any cleanup commit must state
the new baseline explicitly rather than claiming "unchanged".

*(Cluster attribution above is from sampling each file's failing test names and its
`readFileSync` targets, not an exhaustive per-assertion audit.)*

### 5.12 Executed — and what executing it corrected

All four batches are done. Three classifications were **wrong** and were narrowed on evidence
rather than carried out as written:

| Item | Classified as | What executing it showed |
|---|---|---|
| 5.1 | "DEAD, delete with its tests" | **Dead in production, LIVE in tooling.** `buildApifyQueriesFromProfile` and `buildProfileSearchTerms` still have real callers in `scripts/tracePipeline.js`, `rawTrace.js` and `conditionTests.js` — all three verified to still run (exit 0) — plus passing unit tests. My earlier caller grep excluded `scripts/`, which is how I missed it. Only the unused `server.js` import was removed; the functions stay. |
| 5.9 | "`refresh_log` dead — delete" | Correct, and done (migration 071). |
| 5.8 | "`scrape_events` dead" | **The WRITER is dead; the TABLE has live readers.** `routes/admin.js` queries it in four analytics panels. `trackScrape` removed; table kept. Those panels now report a permanent zero — accurate, since no scraping happens, but it will read like a data bug to anyone who doesn't know. |

Two tests were also *not* what the register implied:

- `searchProfileIntent`'s "confirmed profile-intent switch…" was **not** scraping-era. It failed
  only because `handleSearch` was renamed `handleSetRole`; the behaviour it guards is live. Fixed
  the assertion instead of retiring the test — deleting it would have dropped a real guard.
- `jobsUiProfileFilters`'s LinkedIn CTA test pinned a string that had **already** stopped existing
  before this cleanup, which is why it was failing.

**New candidates found while executing, not yet acted on:** `scrapeJobs` (server.js:2637) is still
reachable from a cron path and is passed into the admin router; `searchThreadId` / `logSearchThread`
survive but every remaining call site passes `scrapeParams.threadId`, i.e. all of them are inside
the retired crawl; `activeScrapes`, `scrapeStateKey` and `mapPostedLimit` likewise. Removing
`scrapeJobs` is its own scoped change because of those two live entry points.

Two more surfaced while fixing the test baseline: `isExternalScrapeQuotaError` (server.js:5590),
called only from `scrapeJobs` and the cron re-scrape path; and `buildProfileScrapeRequest`
(JobsPanel.jsx:75), which is defined but has **no callers** now that the client never posts to
`/api/scrape`. The client-side one is independently removable — it has no live entry point at all,
unlike the server cluster.

**`buildProfileScrapeRequest` — DONE.** Removed; `/api/scrape` returns HTTP 410 (server.js:5622)
and the client has no outbound path to build a request for. The comment above it survives
deliberately: `jobsPipelineHardening` pins the *"Board UI filters stay local to /api/jobs and must
not shape /api/scrape"* line as a live invariant, so the rule is kept as a constraint on anyone
re-adding an outbound path even though its builder is gone. That test's note about the orphan is
now an absence assertion instead of a comment.

**The server-side cluster — TRACED. The two entry points are not equivalent; one was dead.**

`scrapeJobs` was recorded as having two live entry points, a cron path and the admin router.
Tracing them settled it, and the answer differs per path:

| Entry point | Reachable? | Verdict |
|---|---|---|
| `cron.schedule("0 7 * * *")` (server.js:3214) | **No — provably** | **REMOVED.** |
| `POST /api/admin/db/force-scrape` (adminDb.js:851) | **Yes** | **KEPT** — see below. |

**Why the cron was dead by data flow, not by missing callers.** It chose what to re-crawl from the
most recent `user_job_searches` row. That table has **zero writers anywhere in the repo** — every
reference is its `CREATE TABLE` (migration 004), two legacy migration backfills, one admin
read-only view, and the cron's own `SELECT`. So `if (!last) return` fired on every tick and the
crawl could never run. This is why it survived earlier caller-grep passes: the call site
`await scrapeJobs(...)` looks live, and only the writerless table upstream makes it unreachable.
Confirmed against the DB: `user_job_searches` has 0 rows and the cron's own query returns nothing.

**Why `scrapeJobs` is kept.** `force-scrape` reaches it, and it is not a stub — it calls
`scrapeHarvestAPI` and performs a real external crawl. So external scraping is retired from the
*user-facing* flow (`/api/scrape` → 410) while remaining fully functional behind an admin endpoint.
`isExternalScrapeQuotaError` stays with it; after the cron went, `scrapeJobs` is its only caller.

**Two things this surfaced that are decisions, not cleanup:**

1. **`force-scrape` has no caller of its own** — not even DBInspector. It is an orphaned admin
   endpoint in the shape of §5.4, except that unlike `save-jobs-bulk` it still *works*. Removing a
   functioning admin escape hatch is a product call.
2. **`AuthScreen.jsx` still collects an Apify token at signup** (lines 79, 153, 164, 356, including
   an `apify_api_` prefix check), and `PATCH /api/integrations/apify-token` still exists — even
   though the Integrations panel's Apify section was removed with external scraping. This is what
   keeps `users.apify_token` populatable, and therefore what keeps `force-scrape` usable. No user
   in the DB currently has one. A signup form asking for a third-party API token that only an
   unreferenced admin route consumes is worth an explicit decision.

**`docs/migration/DEFERRED_SCRAPE_CLEANUP.md` is stale in its premise.** It defers exactly this
admin cleanup ("Replace 'Force Scrape' with 'Trigger Adzuna Sync'") until "after Adzuna/Indeed
aggregator is live". Per §3.5 that precondition never arrived and cannot: no write path produces
adzuna or serpapi rows at all, and the pivot went to the 7 direct ATS sources plus Jobo instead.
The deferral is waiting on an event that was cancelled.

**Baseline movement, as predicted:** 44 → 43 (5.3/5.4) → **38** (5.1/5.7). Nine failures cleared,
all of them assertions pinned to the pre-pivot architecture. `/api/scrape` returning HTTP 410
*"External scraping has been removed"* is what settled that those could never be repaired.

### 5.13 RESOLVED — the apply flow's server-side prerequisite check was gone (regression, restored)

Surfaced while fixing the UI-drift failures, and **not** resolved, because the code alone doesn't
say whether it was deliberate.

`routes/apply.js` no longer imports anything from `services/integrationReadiness.js`. Its only
readiness endpoint, `GET /api/apply/readiness`, probes **browser** availability
(`probeBrowserAvailability`) — a different concern entirely. Meanwhile
`getMissingApplyPrerequisites` and `requiresLinkedInSession` are still exported from
integrationReadiness.js and have **zero callers anywhere in the repo**.

*Two corrections to the above, from re-verifying it:*

- **`requiresLinkedInSession` no longer exists.** It is not exported from integrationReadiness.js
  at all — the file's exports are `INTEGRATION_PROVIDERS`, `publicIntegrationRow`,
  `getStoredIntegration`, `getLinkedInStatus`, `getJobSourceReadiness`, `isAdzunaConfigured`,
  `isIndeedConfigured`, `isLinkedInOAuthConfigured`, `getAutomationReadiness`,
  `getMissingApplyPrerequisites`. So this is one dead helper, not two.
- **The prerequisite *computation* is not gone — only its consumption is.** `getMissingApplyPrerequisites`
  (line 129) is a one-line accessor, `readiness?.apply?.missing || []`, over data
  `getAutomationReadiness` still computes and still exposes as `apply: { ready, missing, optional }`
  (lines 118-125). `getAutomationReadiness` is live. So restoring the gate does not require
  rebuilding a check; the values are already there and already served to the integrations surface.

The gap itself is confirmed: `POST /api/apply/runs` (`routes/apply.js:404-437`) validates
`jobIds` (non-empty array, max 25), filters already-applied/in-progress jobs, inserts the run and
calls `processRun` via `setImmediate`. `requireAuth` is the only other gate. Nothing consults
`apply.ready` before a run is queued.

So an apply run is gated by `requireAuth`, input validation (jobIds required, max 25,
already-applied filtering) and browser availability — but nothing server-side checks the
integration prerequisites those two helpers exist to compute. `getAutomationReadiness` itself is
alive and well, consumed by `routes/account.js` and the integrations surface.

Client-side the gate is partial: JobsPanel still shows *"Setup needed in Integrations"*, but the
`"open Integrations to add it"` copy and the `integrationsPath` plumbing the old test asserted are
gone.

Two possibilities, and they need different fixes:
- **Deliberate** — the flow now relies on client gating plus per-step validation, in which case
  the two dead helpers should be deleted (they'd be cleanup items alongside §5.12).
- **Regression** — a user with a missing prerequisite can start a run that fails later and less
  legibly than it used to, in which case apply.js should consume `getMissingApplyPrerequisites`
  again.

#### RESOLVED — regression. The client proved it.

It was not determinable from `routes/apply.js` alone, but it *is* determinable from the client.
`JobsPanel.startApplyRun`'s catch block reads `e.payload?.missingPrerequisites` and renders
*"Setup needed in Integrations: {list}"*. The client was still honouring a contract whose server
half had been deleted — the UI was waiting for a field the run endpoint could no longer send. That
is a half-removed contract, not a design change, so the gate was restored rather than the helper
deleted.

`POST /api/apply/runs` now returns **409** with `{ error, missingPrerequisites }` when
`getMissingApplyPrerequisites(getAutomationReadiness(db, userId))` is non-empty, placed after input
validation and **before** the `apply_runs` insert. 409 was chosen because `client/src/lib/api.js`
special-cases only 401/429/5xx; every other non-2xx reaches the generic branch that preserves
`payload` intact, which is what the client's message depends on.

**Verified against the real database rather than assumed**, because the risk of restoring a gate is
over-blocking runs that currently work:

| user | profile | base resume | outcome |
|---|---|---|---|
| 1, 2, 4 | none | none | 409 gated |
| 3, 5 | ready | missing | 409 gated on `base_resume` only |
| 10 | ready | available | **202 allowed** |

A fully set-up user passes, so the check is not stale and does not over-block. It is also narrow by
construction: `getAutomationReadiness` keeps gmail/google in `apply.optional` and scopes linkedin
to `profile_import`, so no OAuth state can block a run. And the gate's two lookups
(`domain_profiles WHERE is_active=1`, `getBaseResumeRecord`) are *the same lookups*
`coreGenerateResume` performs at server.js:6110-6116 — with `generateResumeForApply` passing no
`resumeText` (server.js:6339), a run with no base resume generates from an empty string. The gate
blocks exactly the runs that could not have produced a real resume. `apply_runs` had 0 rows, so no
in-flight run was disrupted.

*One narrow trade-off, recorded rather than hidden:* `generateResumeForApply` short-circuits to a
cached artifact from the `resumes` table (server.js:6306-6311) before ever needing a base resume.
A user with no base resume but a cached artifact for **every** queued job would previously have
completed a run and is now gated. This is judged correct — the client's own copy frames a base
resume as setup, not an optimization — but it is a real behaviour change for that edge case.

The test previously asserted the wiring existed, so it had been failing silently as part of the
44-failure baseline rather than raising this. It has been narrowed to assert what is verifiably
true, with this question recorded rather than papered over.

### 5.14 RESOLVED — the dock's viewport centring is intended, not a regression

`jobsUiFollowups` asserted the dock is centred on the jobs panel's measured rect rather than the
viewport, and the code had `constrainedPillWidth = pillWidth` / `dockCenter = vw / 2` — an inert
pair that read like an unfinished revert. **It was deliberate.** `.cinematic/STATE.md` records it
as Step 7b of the cinematic redesign ("TopBar flatten + ScrollDock split"):

> *"rm:jobs-panel-zone event pair removed atomically (TopBar consumer + JobsPanel publisher).
> Zone-constraint geometry (dockCenter offset, dockMaxWidth, constrainedPillWidth clamp,
> dockScale) removed; dock now centers at vw/2 with full pillWidth and no scale() transform."*

Checked for an actual defect before accepting that, and found none:

- At **vw = 1600** the board's content column (`.usb`) spans 340..1260 — centre **800**. The dock
  centres at `vw / 2` = **800**. They coincide, so viewport centring and content centring are the
  same thing on this layout.
- `JobDetailPanel` is a **fixed right-side drawer** (`right:16, top:80`), not an in-flow panel that
  narrows the list, and it starts below the 56px top bar — so it cannot collide with the dock
  either. The divergence case the constraint was built for no longer exists.

Owner decision: leave the behaviour as-is. The misleading `constrainedPillWidth` alias has been
removed (it is what caused this to be filed as a suspected regression in the first place), and
the geometry now carries a comment pointing at Step 7b so the next reader gets the history
instead of re-deriving it.

*Not verified:* the collapsed-pill state at scroll, because a fresh test account has no profile
and therefore no rows to scroll. The centres coincide regardless of scroll, since both derive
from `vw`.

**`aPlusLoading` — RESOLVED, and there were TWO of them.** It was flagged at `JobCard.jsx:328`,
computed and never read. Removing it surfaced an identical orphan at `JobDetailPanel.jsx:274` —
found only because a *second* test (`resumeArtifacts`) pinned the JobCard line and failed, which
is the suite doing exactly its job.

Neither surface has a dedicated A+ button, which is why both flags went unread. **A+ itself is
live** — `JobsPanel.jsx` selects `A_PLUS_TOOL` by `apply_mode === "CUSTOM_SAMPLER"` and plan tier
(`canUseAPlusResume`), and SandboxPanel labels the variant — it simply has no button of its own on
either surface. Behaviour is unchanged by the removal: while a job is in the `a_plus_resume`
state, `st` is still truthy, so the `disabled={!!st}` guards on both surfaces keep disabling their
buttons exactly as before. `generateLoading` stays in both files; it has a button to drive.

Both surfaces are now guarded against the flag returning (`profileAtsUiFixes`). The detail-panel
half had no guard at first — it was found only because an unrelated test pinned the JobCard line —
so leaving it unguarded would have let the orphan back in on the one surface nothing watched.

*Correction to this entry as originally filed:* it claimed the A+ action "survives in
`JobDetailPanel`". It does not. Neither surface has a dedicated A+ button, which is the reason both
flags sat unread; the tool is selected implicitly by `apply_mode`/plan tier. `JobCard.jsx`'s own
comment repeated that wrong claim and has been corrected too.

### 5.15 FIXED — three payload-contract mismatches on `POST /api/apply/runs`

Found while fixing §5.13, in the same request body. Each side was internally consistent, so nothing
failed loudly and no static test could see them — only the *pairing* was wrong. Same family as
§5.13: the client half survived a server-side change.

| # | Client sends | Server read | Effect |
|---|---|---|---|
| 1 | `mode: "manual"` | `mode === "semi" ? "semi" : "auto"` | **Ran a full auto-submit.** |
| 2 | `tool: "a_plus_resume"` | `toolType` only | A+ silently downgraded to generate on every run. |
| 3 | reads `data.queued.length` | returned no `queued` | Success message always read *"0 jobs started."* |

**(1) was the serious one.** JobsPanel's *"Manual review"* button calls `startApplyRun("manual")`;
`processRunJob` branches on `"semi"` (its own comment at apply.js:223 reads *"semi (manual review)
mode"*) and passes `mode === "auto" ? "full" : "semi"` to `autoApply`. Because `"manual"` is not
`"semi"`, it was stored as `auto` and applications were really submitted for a user who had asked
to review them first. Blast radius was greenhouse/lever/ashby — other providers fall to
`held_review` at apply.js:165, which is what kept this from being noticed sooner.

**(2) could not be fixed by plumbing alone.** While the field was ignored, a BASIC user could not
reach A+ by asking for it; honouring `tool` would have made the route a plan-tier bypass. So the
fix adds a server-side entitlement check (403 `upgrade_required`, matching
`requireToolEntitlement`'s shape). `routes/apply.js` imports `canUseAPlusResume`/`normalisePlanTier`
directly rather than taking an injected helper, because its positional signature is pinned by
`applyPipeline.test.js`. `req.user.planTier` is populated by `deserializeUser` (server.js:3529), and
the client derives its own flag from the same `canUseAPlusResume(planTier)`, so the two cannot
disagree and no legitimate user sees a false 403.

All three are server-side fixes; the client was self-consistent on all three and is unchanged.

### 5.16 CORRECTED — what "the pipeline works" does and does not mean (AE6, 2026-08-23)

§5.15(1) is the reason this needs saying explicitly. That defect submitted real applications for a
user who had asked to review them first, and it was invisible because every surface reported
success. The mode arithmetic is now: `applyMode = mode !== "auto" ? "semi" : needsApproval ?
"preview" : "full"`, and `isUnattended = isFullAuto || isPreview`. Three consequences that were
being glossed:

1. **Queueing produces `preview`** — full-auto minus the click — not a submission. "Autofill for
   review" is accurate.
2. **A `semi` run runs NEITHER the completeness gate nor the low-confidence gate.** The human's
   reading of the form is the only check. Until AE6 it also reported nothing about the required
   fields it had left blank, so the review surface showed a clean row over an unsubmittable form;
   it now states the count and lists them.
3. **`mode:'full'` has never run against a real employer.** A `preview` run and a `semi` run have,
   as of 2026-08-23, and neither submitted anything.

`docs/GATED_HANDOFF_STATUS.md` §8 is the single source for that table; this is a pointer to it, not
a second copy.
Both spellings are now accepted for mode (`manual`/`semi`) and tool (`tool`/`toolType`).

Covered by `test/applyRunPayloadContract.test.js`, which exercises the endpoint over real HTTP
against an in-memory DB (the `adminDbInspector` pattern) rather than matching source text — static
assertions are what missed these. Each assertion was checked to fail against the pre-fix code, not
merely to pass against the new.

### Recommended order, if the deletions are approved

1. **5.6 first** — it is the only item actively giving an admin wrong answers.
2. **5.3 + 5.4 together** — client dead end and orphaned endpoint are one capability; splitting
   them leaves half a removed feature.
3. **5.1 and 5.7 with their pinning tests** — expect the failure baseline to drop.
4. **5.2, 5.8, 5.9** — trivially safe, zero callers.

---

## 6. Order of work

**Revised — §2.4 reordered this.** Fixing enrichment before descriptions would have produced a
correctly-behaving pass that still extracted nothing, because there was no text to read.

1. ~~Fix descriptions~~ **DONE** (§2.4): greenhouse `?content=true`, ashby `descriptionPlain` +
   `?includeCompensation=true`, `htmlToText.js`. Verified against the live APIs.
2. ~~Fix enrichment~~ **DONE** (§2.2): COALESCE + don't-stamp-on-empty + skip empty description.
   Manual recovery of the 120 poisoned rows is **no longer needed** — the re-scrape resets them
   (§2.4). This had to land with (1), not before it.
3. ~~Filter null-safety + tests~~ **DONE** (§2.3), still uncommitted.
4. **Commit 1–3 together**, then deploy. They are one causal chain and splitting them ships a
   board that is either empty or blanked.
5. **Verify after the first post-deploy crawl** — this is the real proof, and none of the above
   is confirmed in production until it passes:
   ```sql
   SELECT source, COUNT(*) n, SUM(description IS NULL OR description='') no_desc,
          SUM(enriched_at IS NOT NULL) enriched, SUM(summary IS NOT NULL) has_summary,
          SUM(skills_json IS NOT NULL) has_skills, SUM(salary_max_usd IS NOT NULL) has_salary
   FROM scraped_jobs WHERE is_active=1 GROUP BY source;
   ```
   Expect `no_desc → 0` for greenhouse/ashby, and `enriched`/`has_summary`/`has_skills` climbing
   25 rows per pass (`ENRICH_BATCH_SIZE`). If `no_desc` is still high, stop — the adapter fix
   didn't take and everything downstream is moot.
6. ~~Set `JOBO_API_KEY`; make the skip loud~~ **DONE, and the diagnosis in §2.1 was WRONG.** The
   key was set and valid all along; the feed returns **HTTP 402 Insufficient credits** and the
   error was being swallowed into a "0 jobs cached" log line. The skip is now loud, the return is
   structured (`skipped_unconfigured` / `ok` / `failed`), and the incremental batch is
   env-overridable with a free-tier default. **Jobo cannot sync until the wallet is topped up** —
   and per the freshness sample below, that is not obviously worth doing.
7. ~~Resolve §3 OPEN items~~ **DONE** — 3.4 and 3.5 both resolved above; 3.8 (two dead greenhouse
   slugs) remains, and is a data fix in `company_ats_list`, not code.
8. ~~Repurpose the monitor~~ **DONE** (migration 069 + `/api/admin/db/pipeline-health`). It
   reports per-source freshness/staleness, unconfigured-vs-never-ran-vs-failed, enrichment
   coverage % per column, and dedup folds. Pointed at the local snapshot it immediately showed
   greenhouse STALE 120h with 617/617 missing descriptions and coverage at 0.8%/0.5%/0%.
9. Only then: the scraping-era cleanup pass, and the UI workstream (board/search-bar separation,
   modal transitions, PDF editability) — separate tracks, separate commits.

---

## 7. Jobo freshness — measured, and the reason not to top up

From the 1000-job incremental sample actually pulled (cost ~3000 credits), with `posted_at`
corrected to Jobo's real `date_posted` field rather than `created_at`:

| Age by true posting date | Count |
|---|---|
| ≤ 1 day | **0** |
| 2–7 days | **0** |
| 8–30 days | **0** |
| 31–90 days | 367 |
| > 90 days | 331 |

Newest posting across 1000 jobs: **2026-05-13**, ~89 days old. Most were posted 1–28 April. The
`updated_at` values are recent (late July), which is what made them *look* current — Jobo
re-touches old records. The ATS-direct sources write same-day postings for free.

Caveat: this is the `updated_after` incremental slice, not a random draw across the 4,004,867-job
corpus, and `stable_scan` ordering might surface different jobs. But 1000 consecutive jobs with
zero under 30 days old is a strong signal.

**This was invisible before** because the adapter stored `created_at` (when Jobo ingested a job)
as `posted_at`, systematically understating age. Jobo's one real advantage is that it returns
`qualifications.must_have.skills` as `{name, type}` — the exact hard/soft split `enrichJob.js`
pays Haiku to produce — so Jobo rows can skip enrichment entirely. That only matters for jobs
worth showing, and 3-month-old postings are mostly dead links.
