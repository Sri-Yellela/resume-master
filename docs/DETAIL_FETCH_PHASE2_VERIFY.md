# Detail-Fetch Economics — PHASE 2 verification record

What was built, and the evidence for each clause of the brief's Verify list. Measured 2026-09-17.

Phase 1's findings are in `docs/DETAIL_FETCH_PHASE1_FINDINGS.md`; the reasoning behind the shape of
the code is in the header of `services/jobs/detailFetch.js`. This file is the receipts.

⛔ **Both sources are still `active = 0` in `company_ats_list`.** Nothing here enables them, and the
capability being on does not enable them — the crawl ingests nothing from those companies, so the
fetch pass has nothing to act on. Today's board is 1,266 of 1,266 active rows already described.

---

## What changed

| | before (task Y) | after (phase 2) |
|---|---|---|
| where the description is fetched | inside each plugin's `search()` | `fillMissingDescriptions`, step zero of the enrichment drain |
| what bounds it | `ATS_DETAIL_FETCH_BUDGET` — a second, independent budget | the enrichment day's **remaining** row ceiling |
| Workday's door | CXS detail API + the tenant/wd#/site triple threaded through | the public page's **JSON-LD** — a GET of the URL already on the row |
| concurrency | 2, guessed | 8, Workday's **measured** knee |
| fetch-on-open | did not exist | `POST /api/jobs/by-id/:jobId/description`, same fetcher, same writer |
| per-company yield | assumed 0% | **measured 100%** and recorded per company |

Files: `services/jobs/detailFetch.js` (new), `services/jobs/detailBudget.js` (repurposed),
`services/jobs/enrichJob.js`, both source plugins, `server.js`, `routes/adminDb.js`,
`client/src/components/JobDetailPanel.jsx`, migration `107_detail_fetch_bookkeeping`.

Tests: `test/detailFetch.test.js` (33), `test/detailBudget.test.js` (11 rewritten),
`test/migrationListsAgree.test.js` (3, new), four added to `test/enrichmentDrain.test.js`.
**Full suite 2,483 passing, 0 failing.** The client builds clean (`npm --prefix client run build`).

`npm run verify:harness`: **36/42 green, 1,063 assertions.** The six that are not green
(`abPanelUi`, `ag4PdfDuplication`, `ah4LocationClaims`, `aj1MobileBearer`, `am1GradedCorpusVerify`,
`e5GreenhouseHost`) were **verified pre-existing**: each was re-run against a stashed, unmodified
tree and reproduced with byte-identical failure text and identical assertion counts. They name
features this work never touches — an AutoApply modal's controls, a missing generated-resume
fixture, two of 146 corpus locations still flagged as a team, two contract keys
(`baseAts`/`generationDeferred`/`generate_at_queue`) that the mobile contract does not document, an
unpinned graded corpus, and `"Databricks | Databricks"` from a host inference. "Implausible" is not
evidence, which is why the baseline was actually run.

---

## The Verify clause, line by line

### ✅ "a crawl writes rows with no description and spends no detail requests"

Live, both plugins, with the detail path removed:

```
smartrecruiters: 6 rows in 1.8s · with description: 0 · _detail key present: false
workday:         6 rows in 11.3s · with description: 0 · _detail key present: false
→ all rows description-less: true
enrichment candidates BEFORE any fetch: 0   (correct — there is nothing to extract from)
```

`_detail` is gone from the response shape, not merely zero. `test/detailFetch.test.js` asserts
neither plugin's `search()` source contains `attachDescriptions`, `fetchPostingDescription`,
`_fetchDetail`, `_detailBudget` or `ATS_DETAIL_FETCH` — the injection points are **removed**, not
left dormant, because a dormant second path is the `_ghCompanies` failure.

### ✅ "enrichment fetches and enriches in one pass under one budget, reporting per-column coverage"

**The one budget is a subtraction.** `drainEnrichment` asks for `maxRows - alreadyQueued`
descriptions, so if the queue already fills the day it buys **none**:

```
the fetch budget is the day's REMAINING rows          10-row ceiling − 4 queued → asked for 6
a full queue buys NO descriptions                     10 queued against a 5-row day → 0 calls
no client means no descriptions are bought either     ran: false, 0 calls
```

Two budgets cannot disagree because there is only one. Live pass:

```
[detailFetch] 6 selected, 6 requests, description coverage 0 -> 6 (+6), prioritised by 1 profile(s)
report: { selected: 6, attempted: 6, withText: 6, failed: 0,
          describedBefore: 0, describedAfter: 6, coverageDelta: 6 }
```

**`attempted` and `coverageDelta` are reported side by side and derived independently** — one from
the loop, one from re-querying the table. That is not redundancy; see the bug it caught below.

### ✅ "a 429 mid-fetch leaves the row retryable and stamps nothing"

`content_hash` and `enriched_at` are not nameable from `persistDetailOutcome` on any path. After a
simulated 429 and after a real live 404 / `no_text`:

```
content_hash = NULL   enriched_at = NULL   description = NULL   updated_at = NULL
detail_fetch_attempts = 1   detail_fetch_error = 'http_429'
```

Only the attempt counter and the reason move. A failure does not touch `updated_at` either —
nothing about the posting changed, and a false `updated_at` would trip
`enrichmentSelection`'s `updated_at > enriched_at` pre-filter into re-examining the row forever.

Live, all six fetched rows: `rows carrying content_hash or enriched_at: 0`.

### ✅ "opening an unfetched job fetches once and caches"

Through the real route, real login, live sources:

```
smartrecruiters   604ms  HTTP 200  success=true   bytes=8096  cached=false
workday           561ms  HTTP 200  success=true   bytes=7950  cached=false
— second open —
smartrecruiters     6ms            cached=true    bytes=8096
workday             5ms            cached=true    bytes=7950
```

**Answer to "does it need a loading state": yes.** 561–604ms is well past the threshold where a
panel showing "No description available." and then correcting itself would be lying for half a
second, on every first open. The panel has four states — loading, text, failed (with a Retry link),
and "this source has no description" — because the previous single fallback sentence collapsed three
different facts, one of them about us rather than about the posting.

### ✅ "a failed fetch says so rather than showing an empty panel"

```
greenhouse   4ms  success=false  reason=no_fetcher
             "The greenhouse feed does not publish a separate description for this posting."
workday    363ms  success=false  reason=no_text
             "The source returned this posting without any description text."
```

Every failure path returns `success: false` **with a reason**. Note the greenhouse row recorded
**0 attempts** — a source with no detail door costs no request and must not pollute the yield metric.

### ✅ "both sources still route through `reconcileFingerprint`/`computeReqUid` and derive `automation_tier` via the shared function"

180 live rows through the real shared functions:

```
total rows            180
NULL fingerprint        0
NULL req_uid            0
NULL automation_tier    0        ← W's invariant, kept
tier distribution     {"guest":120,"account":60}
```

### ✅ "sources stay OFF at the end, pending a separate enable decision"

All three remain `active = 0`. The capability is on by default (`ENRICH_DETAIL_FETCH=0` is the kill
switch) **deliberately**: a second `0` default would mean enabling a source later also required
finding an unrelated flag, which is how a feature ships broken. The selector, not a constant, is
what makes an enabled budget cost nothing over an empty candidate set — and that is the claim that
has to be checked rather than asserted, so it was, against the real board with a transport rigged to
THROW on any outbound request:

```
knobs as the app reads them: {total:300, perCompany:100, concurrency:8, timeoutMs:15000, maxAttempts:3}
board:                       2,460 active, 2 without a description
rows from fetchable sources: 0
company_ats_list:            Bosch active=0 · Ubisoft active=0 · Adobe active=0

report:  { enabled: true, reason: 'nothing_to_fetch', selected: 0, attempted: 0 }
outbound requests attempted:  0
rows carrying any detail bookkeeping: 0
```

`enabled: true` with `selected: 0`. The two description-less rows on the board are from greenhouse
and are correctly ignored — that source carries its text in the list and has no detail door, so it
is `no_fetcher` rather than a candidate.

---

## Two bugs this work found in itself

**1. `withText` counted responses, not writes.** The first live run reported `withText: 6` over a
table holding **zero** descriptions. Six fetches genuinely returned text; the `UPDATE` threw on a
column name; `mapWithConcurrency` contained the rejection exactly as designed — and the report
claimed success. That is this pipeline's own signature defect, success-shaped output over an empty
result, *inside the code written to remove it*.

**Only `coverageDelta` noticed**, which is the entire argument for reporting coverage rather than
counts, made concrete. The write is now awaited, its exception caught at the call site rather than
absorbed by the runner, a row counts only once the row actually has text, and a
`withText !== coverageDelta` disagreement is logged as an error. Pinned by two tests.

**2. The column was `employment_type`, not `contract_type`.** `contract_type` is the *plugin's*
field name; `aggregator.js:436` renames it on the way in. The unit fixture had invented
`contract_type`, so every write test passed against a column production does not have — **a fixture
defect wearing a product defect's clothes**, which is a note the drain's own fixture already carries.
The live harness is what caught it. The value now goes through the shared
`normalizeEmploymentType`, so the column can only receive a spelling its own filter recognises
(`FULL_TIME` → `full-time`).

A third, found in review rather than by a run: **the per-company cap wasted the day's budget.** It
lived only in `budget.take()`, so the SELECT filled its `LIMIT` by priority — and Bosch offers 900
of the 1,200 SmartRecruiters rows, so a 300-row day would take almost all Bosch rows, fetch its 100,
and refuse ~200 slots Ubisoft and Adobe rows could have used. Budget silently discarded: the
`0de67c8` shape again. The cap is now applied in the SELECT with `ROW_NUMBER() OVER (PARTITION BY
company)` and *also* kept in the budget, so the SELECT decides who is offered a slot and the budget
remains the thing that cannot be exceeded.

---

## Findings worth carrying forward

⛔ **On Workday, "gone" and "no description" are the same response.** A deleted or invented posting
path returns **200 with the SPA shell and no `ld+json`**, not a 404 — the same catch-all that makes
`/external_experienced/feed` answer 200 for a feed that does not exist. No status code will separate
them, so the per-row attempt cap (`ENRICH_DETAIL_MAX_ATTEMPTS`, 3) is the **only** thing bounding
spend on a taken-down Workday posting. SmartRecruiters does return a real 404 and is handled
terminally.

⛔ **`scripts/migrations.js` is not the only migration list.** `server.js` carries its own inline
copy and *that* is what the boot runner executes; `scripts/migration.js` reads the other one. A
migration added only to `scripts/migrations.js` **never runs in production** — migration 107 was
written to the wrong one first, and the detail-fetch pass would have been permanently inert behind
its own "migration missing" guard, which degrades quietly by design.
`test/migrationListsAgree.test.js` now fails if the two disagree, and the false
"single source of truth" comment in `scripts/migration.js` has been corrected.

**Two pre-existing defects recorded, not fixed:**

- `workday.js` maps `contract_type` from `job.timeType`, absent from **100/100** live list postings
  — the stored column has been NULL on every Workday row since the source was added. The detail
  fetch now fills it from JSON-LD's `employmentType`, so the dead read is bypassed rather than
  removed; it is kept because it is the correct mapping if Workday ever returns the field.
- **Silent truncation.** Bosch is capped at **900 of 4,840** postings (SmartRecruiters caps its page
  size at 100 without saying so; deep offsets to 4,800 do work) and Adobe at **300 of 711** (Workday
  returns 400 for any page size above 20).

**Deliberately not built:** conditional requests (SmartRecruiters' real 0-byte 304s have no caller
in this design — this pass only fetches rows with no description, so there is never a prior ETag);
auto-deactivation of low-yield companies (its premise is measurably false, and it would add a new
way to lose a healthy company); and overwriting `posted_at` with JSON-LD's exact `datePosted`
(ingestion already fills it on 100% of rows, so it would require an overwriting write).

---

## If someone enables a source

The numbers to decide on, all measured: **1,500 detail requests per crawl** (Ubisoft 300 + Bosch 900
+ Adobe 300), **~$3.90 and 5 days** of enrichment for the first full pass at
`ENRICH_DAILY_MAX_ROWS 300`, against **~1%** of those rows matching any current profile's target
titles. Neither source rate-limited at any volume tested, so the constraint is entirely downstream.

Start with **Ubisoft2** (300 postings, the smallest) and read `coverageDelta` from the
`[detailFetch]` log line — not `attempted`, which is true whether descriptions arrived or not.
