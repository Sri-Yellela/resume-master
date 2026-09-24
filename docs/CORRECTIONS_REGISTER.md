# Corrections Register

**Purpose:** every claim made in a planning doc or a task brief that later turned out to be wrong,
with what replaced it. Kept because several of these were repeated across multiple sessions before
anyone measured them, and a wrong figure in a brief becomes a wrong premise in the work.

**Last reconciled:** 2026-09-21.

> **The pattern worth naming:** almost every entry below was corrected by an agent *measuring* a
> premise it had been handed, not by anyone noticing the error. The standing instruction —
> *re-derive state from the repo, not from status documents* — is what caught all of them. Three
> briefs in a row had their central premise inverted by the first measurement taken.

---

## Numbers that were wrong

| Claim | Repeated in | Reality | Consequence if believed |
|---|---|---|---|
| **`skills_json` coverage 37%** (465/1255) | `NEXT_WORK.md`, the curation brief, several chat turns | **99.8%** — 1,263 of 1,266 active | Led to "the data is the constraint". It is not. The constraint is whole-value `LIKE` against a 6,130-string vocabulary that is 70% singletons, capped at 6 terms. **Wrong by 2.7×** |
| **`skills_json` coverage 99.8%** — the correction above | this register, `NEXT_WORK.md`, CC2 | **43.7%** in production (1,140 / 2,610 active), 2026-09-18 | THIRD value for one metric. 37% and 99.8% were both right about boards that no longer exist. The lesson is not the number: a coverage figure quoted without its board size has a shelf life of weeks |
| **Enrichment backlog "790 candidates"** | `RECONCILE_AND_RESIDUAL.md` item 3d | **1,470** and growing — 1,373 `enrich_job` events in 30 days and still losing ground | The crawl outruns the drain. This is the binding constraint `DETAIL_FETCH_ECONOMICS.md` names |
| **Enrichment "drains at 25 rows/day"** | `NEXT_WORK.md` lessons | Superseded by AE's bounded loop, now live | Would have justified a second batching mechanism |
| **Migration high-water 068 → 090 → 095 → 101 → 106** | every prompt doc, repeatedly | **109** as of `2e4429e`, read from `/api/version` 2026-09-21 | A new migration written at a stale id collides |
| **Test baseline 45 → 600 → 1006 → 1858 → 2301 → 2443** | every prompt doc | **2596** (2,591 at `2e4429e`) | Comparing against a stale baseline hides introduced failures |
| ⛔ **"workable fetched 23 and wrote 0, recruitee 16 → 0"** — reported as two sources failing | `PART1_RECONCILED_2026-09-18.md` §3a, `ENRICHMENT_BACKLOG_2026-09-18.md` §6, and **delivered as two CRITICAL alerts** | **Both sources were working.** On the crawl side `written` counts new-or-changed upserts only; unchanged postings are counted under `unchanged`, which the health query did not even SELECT. 2026-09-21 | The first entry here whose wrong claim came from **the monitor**, not from a brief. It was harmless while nothing read the route and stopped being harmless four days earlier, when `2e4429e` began delivering it. `docs/SOURCE_HEALTH_FALSE_CRITICAL.md` |
| **`ats_score` non-NULL on 4 of 1,296 rows** | the CC5 brief, the ATS/curation audit | **0 of 2,460.** The board restore left more rows and no scored ones; the 4 were `aj2fixture::*` seeds that no longer exist | Requirement 6's "stored 43 vs scores null" row cannot be reproduced. The requirement was implemented anyway |
| **Scoring costs ~5.5ms/job, 279ms a page, 13.4s a board** | comments an earlier CC5 pass left in `server.js` and `jobCursor.js` | **6.67ms mean** (median 6.32, p95 9.99, n = 300 real postings, weights and synonyms warm) — 0.33s a page, **16.4s** for all 2,458 | ~20% optimistic. Conclusion unchanged and slightly stronger: the board must read a cache |
| **`ran_at` column missing in production** | reported as prod/dev schema drift | **Typo.** The column is `run_at`, and `SELECT ran_at` fails identically locally. Migration `011_cleanup_log` is byte-identical in both dual paths | Invented a schema-divergence investigation |
| **Screenshots ≈ 186 KB** | a commit estimate | **5.8 MB** — 31× | — |
| **`requireToolEntitlement` at ~:4067** | the monetisation brief | **:5530** | — |

---

## Things asserted to exist that did not

| Claim | Reality |
|---|---|
| **`shared/entitlements.js`** | It is `services/entitlements.js` |
| **`ProfilePanel` hardcodes "Admin • Pro"** | No such literal anywhere in the repo. The monetisation brief's requirement 5 had nothing to fix |
| **Mobile modules exist in the main repo** | `git log --all --diff-filter=A` shows no mobile project file was ever added on any branch. The apps are in two sibling repos. `docs/MOBILE_STATE.md` audited the wrong repo and concluded the premise was false — true of that repo, false of the project |
| **AF3's guards were never built** | Cap, concurrency, idempotency, the kill switch and the AE1 fix had **all landed**. Two genuine gaps remained: the kill switch was tested only at admission, and the low-confidence gate had never seen a form |
| **Tasks 1 and 3 (Outcome UI, web cursor paging) were pending** | Both had landed in commits the doc listed as open |
| **Tasks B and C were pending** | Both complete; the head commit read *"docs: Phase 2a is complete"* |
| **Six commits unpushed and undeployed — "the highest-value action"** | All six were on `main` **and** `origin/main`. Sixth time `NEXT_WORK.md` was stale about its own headline |
| **`GROQ_API_KEY` absent from local `.env`** | It was present all along |

---

## Premises that inverted on measurement

**`discovered_at` is not `scraped_at`.** The brief said "most of the 837 unenriched rows are stale —
do not enrich what does not matter." By `discovered_at`, 96.7% looked 14–60 days old. By
`scraped_at`, which `aggregator.js:319` re-stamps on every re-sight, **all 837 had been seen within
three days.** Same rows, opposite answers. A `discovered_at` age gate would have refused 809 live
postings and looked like it was working. The shipped gate keys on `scraped_at`.

**Export CSV does not mangle `skills_json`.** Asserted as near-certain in the import brief. 200 real
rows through the actual escape in `routes/adminDb.js`, parsed with a strict RFC4180 parser: **zero
mismatches.** JSONL is still right, for a reason that survives testing — CSV cannot distinguish
"not supplied" from "explicitly null", and both the fill-nulls-only default and the tri-state visa
flags depend on that.

**The three export paths are not duplicates.** The brief said to retire one. `Download .sql` is DDL
only; `Export CSV` is rows over ten allow-listed tables; the JSONL export carries the staleness
interlock. Three different things with similar names.

**Targeted generation's premise was false.** Proposed as the big token saving. Mean 9.08 missing
weighted terms per job, **78.8% of jobs have zero rephrasable gaps**, 64.8% of missing terms
genuinely absent. Handing the model a gap list gives it nine things it is rewarded for claiming,
two-thirds of which the candidate lacks — a more dangerous prompt, not a cheaper one. The real cost
split is output 51% / cache write 40% / input 8.6%, so prompt shortening is nearly worthless.

**Removing the cache breakpoints would cost money, not save it.** The brief said remove them. Net
saved is $0.3632 — removal forfeits $0.39 to recover $0.02, and task D made the one zero-read caller
bursty. A lever was added instead, defaulted to the measured-best setting, with a test that fails if
the net ever flips.

**The lever brief's own headline claim.** "Can the product take money?" — no processor, no key,
twelve probed payment routes all answering with the SPA shell. But `/pricing` was live saying *"paid
upgrades are being prepared"* against a **non-trader** Web Store declaration. One sentence, and the
only outright false commercial claim.

**Task Y's N+1 may not be necessary.** `workable.js` carried a comment asserting descriptions
*required* an N+1; `?details=true` returns them in the **same request**. The comment was wrong and a
five-minute probe disproved it. `detailBudget.js` exists because that comment was believed. The same
probe has not yet been run against SmartRecruiters or Workday — see
`docs/DETAIL_FETCH_ECONOMICS.md`.

**`job_applications` is not empty in production — it has 5 rows — and the pair is still empty
anyway.** Read directly from the deployment on 2026-09-18 (`/api/admin/db/raw-query`, read-only).
0 of the 5 carry `ats_score_at_apply`, a scorer version or an outcome, and the reason is timing
rather than a broken writer: AK1's migration `094_application_ats_provenance` was applied at
1788135030 and the **newest application predates it by two weeks** (1786928129). No application has
been recorded since the stamping path existed, so the nulls are rows from before the columns. CC5
pinned both writers with tests; the path is ready and has never been exercised.

**`usage_events` carrying an ATS delta is 23, not 0.** The audit recorded "1,638 rows with 0
carrying `ats_score_before`/`after`". Production now has 23, so the generation-lift half of the
outcome dataset *is* collecting — it is only the application half that has never fired.

**Production never had the `job_role_map` restore damage.** The 277 unbucketed postings were a
LOCAL artefact of `am3RestoreBoard`. Production reports 0 unbucketed across 2,610 active rows and
`job_role_map` holds only `ats_cache` rows, so the boot-time backfill correctly did nothing there.
It stays as a guard against the next restore, not as a repair of a live defect.

**The admin router is mounted at `/api/admin/db`, not `/api/admin-db`.** Worth recording because
the wrong path returns **HTTP 200 with the SPA shell**, so a status-only probe reads as success and
a `.json()` on it fails with `Unexpected token '<'`. Same catch-all trap as the cleanup-brake probe.

**The cross-user ATS cache was on seven paths, not one.** The CC5 brief named the keywords route's
priority-2 read. Measuring found **three writers** (`scrape`, `adopt-enhanced`, the keywords route)
and **four readers** (board `matchScore`, the poll shape, that priority-2 read, and
`capturedAtsAtApply`). The two the brief did not name are the worse ones: adopt-enhanced rewrote the
score *every other user* saw on every posting the adopter had saved, and the apply stamp wrote a
stranger's score permanently into `job_applications` — the only table that can ever validate the
scorer — with a provenance version attached. See `docs/CC5_PER_PROFILE_SCORES.md` §1.

**"A row with no stored score has no route to the term list" was true for a second reason too.** The
brief blamed the badge's null guard. The handler behind the badge was *also* gated on a score
existing, so even a visible chip would have done nothing. Two independently correct decisions
composing into a dead end on 100% of rows.

**G1's synonym table did not measure "+0.000" — it has no effect path.** No server call site passes
`synonyms` to `scoreAtsLocally`; only a measurement script and one that passes `null` explicitly. Its
only production reader de-dups the technographics rollup. 196 proposals await review for a table
nothing that scores reads.

**"The board is gone" described the dev database only.** `cleanup_log` id 85 deleted 1,288 rows
locally. Production held **1,399 rows / 1,248 active** and was never affected.

---

## Verification methods that proved nothing

These are the durable lessons. Each one passed while measuring nothing.

**A 200 is not evidence a route exists.** The SPA catch-all answers 200 with `index.html` for any
unknown path. `GET /api/admin/enrichment/coverage` "confirmed" a deployment that had not happened.
**Assert a specific JSON key.** Now caught three times — the enrichment routes, `approvalCap`, and
`/api/admin/enrichment/run`.

**Loading the privacy URL proves nothing.** `resumemaster.one/privacy` returns 200 anonymously with
no redirect, and the body is a **2,044-byte SPA shell containing zero policy text.** Verifying the
wording requires fetching the content-hashed bundle and grepping it. I advised "check it in a private
window" twice; that check would have passed on an empty page.

**A guard never seen to fail is not evidence.** Six have now shipped inert:
`modelCallGuard` missing `messages.batches.create` · its comment stripper erasing `https://` URLs as
comments · three dead source anchors in passing tests, over-slicing by up to 4.8× because `indexOf`
returns `-1` and `slice(-1)` means "one from the end" · `ae5BoardUi` stubbing `logo.clearbit.com`
with a 1×1 PNG so its logo assertions passed while **every logo on the board was dead** ·
`ak2BandSurfaces` green for months on a fixture that **invented the field under test** (`baseAtsScore`,
a key `/api/jobs` has never emitted) · the monetisation lever cached as a boot constant, making both
states unreachable in one test process.

**Stubs answer for retired model IDs.** Task A's +33 tests all used fetch stubs, so nothing noticed
that `llama-3.1-8b-instant` no longer exists — Groq serves **no** Llama model. Stubs verify plumbing,
never existence.

**An unauthenticated refusal is not a gate opening.** The lever harness's "user is served" check
passed on a **401**, because registration had failed and nobody was logged in.

**Host liveness is the easy check and the rare failure.** A DNS sweep found one dead host of 24 — and
would have caught only **one of three** real failures. Groq's model id and Lever's company slugs were
*identifiers* retired while their hosts stayed up. What catches those is asserting **rows arrived
with populated key fields**, which is how `workable 0/20 → 20/20 descriptions` was found.

**Source-string tests caught almost none of the real defects.** What did: booting the real server,
driving real Chrome, and measuring field coverage on written rows.

---

## Silent failures, all found by someone happening to look

| | Duration | Instrumented? |
|---|---|---|
| **Jobo never ran** — `JOBO_API_KEY` unset, logged *"sync complete — 0 jobs cached"* | months | the log was there |
| **Enrichment 404'd on a retired model** | 3 days | `usage_events` recorded 25 calls/day with 0 ok, perfectly |
| **Lever's three company slugs all 404'd** after those companies moved off Lever | 5 crawls | `pipeline_runs` had the per-source cause |
| **Every board card read "No signal"** — `/api/jobs` emits `matchScore`, every desktop surface read `baseAtsScore` | unknown | zero client references to `matchScore` |
| **`logo.clearbit.com` dead** — no A record. Its fallback for "provider unreachable" **was Clearbit** | unknown | 1,290/1,296 dead rows |
| **The cleanup brake committed, documented, undeployed** | 1 day | — |
| **`/api/standalone/generate`** Sonnet 8192, unauthenticated, quota keyed on a cookie the caller controls | until `857fa32` | — |

**`AC`'s health check would have caught the first four.** It has been scoped and deferred roughly
fifteen times.

---

---

## Why this file stays

⛔ **RECOMMENDED KEEP, and not as a backlog.** The checklist that used to end this file was closed
out during the P5 documentation reset on 2026-09-24 and removed, because a checklist is the one
part of this document with an expiry date.

What remains has none. This is the record of **HOW the docs went wrong** — the shapes, the
verification methods that proved nothing, the silent failures and how long each ran. That outlives
every individual entry, because the next wrong figure will be new but the way it becomes wrong
will not.

"Current" has a half-life of about one session in this repository. A register of *methods* does
not.

**How the checklist closed, 2026-09-24:**

| item | outcome |
|---|---|
| `NEXT_WORK.md` — delete the "25 rows/day" lesson | **File deleted.** Superseded by `HANDOFF.md`; it was stale eight times and only ever named in comments, never read by code |
| `FINDINGS_ARCHIVE.md` — add three blind guards | **Done.** `ak2BandSurfaces`, `ae5BoardUi` and the cached monetisation lever added to the seventh defect shape, with the shape they share named |
| `shared/atsBands.js` — 5 of 12, not 4 | **Corrected** in the source comment |
| `am1-ats-graded-corpus.json` — 26 of 30 drifted, rho 0.737 | **Documented** in `ARCHITECTURE.md` §3, alongside the 0.746 the tests assert. Owner 2026-09-24: record both figures and the drift — the drift is the finding |
| `PRIVACY_RECONCILIATION.md` — DuckDuckGo in, Clearbit out | **Already done.** Verified in the file: DuckDuckGo is the live logo provider, Clearbit and Google Fonts are both named as retired recipients |
| mobile "two phases behind" | **No action needed.** No document made the claim except this checklist |

⛔ **One correction this register itself needs.** Its `skills_json` row records 37% → 99.8% → 43.7%.
Measured 2026-09-24: **41.0% production, 35.8% local.** That metric has now had five values. Do not
quote it from any document, including this one — measure it.
