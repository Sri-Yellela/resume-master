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

### 2.1 Jobo has never executed — `JOBO_API_KEY` unset in Railway
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
| 3.4 | Why did ashby stop on Aug 7? | **OPEN.** Note §2.4 changes the fetch URL and raises the timeout to 15s; re-check after deploy before digging, since a slow/oversized response is now a plausible prior cause. Check `[cacheJobs]` logs for an ashby error. |
| 3.5 | Why is adzuna's `discovered_at` NULL? | **OPEN.** Breaks the NEW<24h pill and `jobQuery.js:171` recency filter — adzuna rows are dropped by any date filter. Not reproducible locally (this snapshot has no adzuna rows). |
| 3.6 | Are visa flags all NULL? | **RESOLVED — yes, 0 non-null for both** *(local)*. Downstream of §2.4, same as 3.3: the flags are description-derived. The OPT/H1B badge cannot render until enrichment has real text. |
| 3.8 | **NEW** — 2 of 10 greenhouse slugs in `company_ats_list` are dead. | `notionhq` and `openai` both return **404** on the board endpoint (verified on the old *and* new URL, so this is pre-existing and unrelated to §2.4). `greenhouse.js`'s per-company `.catch(...) => []` logs a warning and moves on, so the board just quietly carries 8 companies instead of 10. Find the current slugs or drop the rows. Same silent-failure class as §4. |
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

## 5. Cleanup register (scraping-era, pending the classification pass)

Not yet verified — do not delete without grep-proving zero callers.

- `searchQueryBuilder.js` → `buildApifyQueriesFromProfile` (flagged do-not-wire)
- `scripts/providerEval/adapters/jobo.js` (wrong endpoint, superseded)
- LinkedIn batch-import UI in `JobsPanel.jsx` (`START_LINKEDIN_IMPORT`) + the dead bridge stubs
  `isLinkedInExtensionInstalled`/`sendExtensionRequest` — promises a capability BYO-2 removed
- `/simulate-jobs/:userId` admin endpoint (hardcodes the removed `sevenDaysAgo` cutoff)
- Scrape monitor admin surfaces → **repurpose, don't delete** (see §4)

**Keep — load-bearing despite scraping-era origin:** the 7 ATS-direct sources (canonically rank
*above* Jobo), `aggregator.js`, `schema.js`, `reconcileFingerprint`/`computeReqUid`,
`enrichJob.js`, `sync_state`. These serve store-then-filter. adzuna/serpapi are a cost decision,
not a cleanup one.

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
6. Set `JOBO_API_KEY`; make the skip loud. Verify rows land tagged `source:'jobo'`. (Independent
   of 1–5 — deliberately moved after them, since they restore 95% of the board and this adds a
   new source on top.)
7. Resolve remaining §3 OPEN items (3.4, 3.5) — both are cheap post-deploy log/query checks.
8. Repurpose the monitor into pipeline-truth observability. Per §4, the single highest-value
   addition is a **per-source non-null coverage table** — it makes §2.4's whole failure class
   visible on the first crawl instead of never.
9. Only then: the scraping-era cleanup pass, and the UI workstream (board/search-bar separation,
   modal transitions, PDF editability) — separate tracks, separate commits.
