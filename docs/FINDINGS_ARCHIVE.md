# Findings Archive

Closed findings, moved out of `NEXT_WORK.md` on 2026-09-08 so that file holds only open work.
Nothing here needs action. Kept because the *reasoning* has repeatedly proven reusable — several
of these were rediscovered by later sessions that had not read them.

---

## The recurring defect signature

Every significant bug in this project has been one of six shapes. All were silent; none threw.

**1 · Two sides of a contract that don't meet.** `mapJobRow` vs the client mapper · popup and hotkey
writing to different tables · three hardcoded tab lists · half-migrated model IDs (Haiku updated in
8 places, Sonnet left dead in 7) · `tool` sent vs `toolType` read · mode `"manual"` coerced to
`"auto"`, so a user asking to review got a real auto-submission · `'mid level'` vs DB `'mid'` · the
Android parser reading snake_case against a camelCase server.

**2 · A handler wired to nothing, or to the wrong thing.** `UnifiedSearchBar` handed
`onSearch={() => {}}`, so every bar control was dead · an unscoped `openReview` surviving in a
ternary's fallback arm, leaking every user's applications. **Search by identifier, not call-site
shape** — that is how the last one survived a fix that rewrote every matching call site.

**3 · Silence reported as success.** An unconfigured provider logging *"sync complete — 0 jobs
cached"* for months · enrichment stamping rows complete while writing nothing · discovery finding
zero fields and reporting a clean `autofill done` · a logout endpoint returning before `req.logout()`
ran, leaving a 7-day cookie alive · a truncated packet list read as `batch_empty` · a concurrency
guard returning `applied:true` with zeros.

**4 · NULL-hostile predicates over optional data.** `IN` / `LIKE` dropped every NULL row and took the
board to zero three separate times. Then a fourth: SQLite `=` in a cursor chain yields NULL when
either side is NULL, so a row with no `posted_at` made the feed **stop dead partway down and report
the end of the board in the middle of it**.

**5 · A test that pins a defect.** One asserted a broken ternary verbatim, so fixing it would have
failed CI · a negative assertion on a literal true only when written · a cost test using the DB
column name where the API field name was required, validating its own error ·
`failsafeLocationClaims.test.js` asserting `=== false` with the comment *"with no corpus there is
nothing to know"* — **the bug written down as a guarantee.**

**6 · A claim with no code.** A store listing declaring "PII not collected" for a build that types a
postal address into an employer's form · docs describing a fill that no longer happens · a README
describing shipped mobile features for code that never existed · commit `f8be63c`
*"feat: JobRepository.swift — consumes /api/jobs"* for a file not in the build target.

**A seventh, newer: a guard blind to what it guards.** `modelCallGuard` scanned for
`.messages.create(` and missed `messages.batches.create` · its comment stripper used `/\/\/.*$/`, so
`https://api.groq.com/...` was erased as a comment before the scan ran · three source anchors were
already dead in passing tests, over-slicing by up to 4.8× because `indexOf` returns `-1` and
`slice(-1)` means "one from the end". **A guard never seen to fail is not evidence** — verify by
injecting a violation.

---

## Closed tasks, one line each

| Task | Outcome |
|---|---|
| **A** Multi-provider routing | Built, guarded, `$0` pricing, migration 096 records provider. Never served a real token until A2 |
| **A2** Provider verdict | **KEEP HAIKU.** `skillsHard` Jaccard 30.5%. Groq's pinned model had been deleted entirely |
| **B** ATS bands | ρ 0.643 → **0.746** with the seniority guard; mis-ordered 16.1% → 12.2% |
| **C** Android Phase 2a | Toolchain, auth, contract-typed API, Room persistence. 40 JVM + 13 instrumented |
| **D** Generation deferral | Generation moved from queue to approval. 19-check real run |
| **E** Cache breakpoints | **Change refused** — removal would forfeit $0.39 to recover $0.02. Lever added, defaulted to measured-best, test fails if the net flips |
| **F** PII tokenization | Real round trip verified |
| **G1** Skill synonyms | Built, measured, **moves ρ by +0.000** — coverage 2 of 240 missing terms |
| **G2** LCA resolution | 70% → 75% like-for-like |
| **G3** Technographics | 8690 → 8278 rows. Corrected an earlier "near-pointless" call: normalisation does 94% independently |
| **G4** Org units | Audit found the live location regression |
| **H** Label mappings | Built; headroom measured at ~0 |
| **I** Harness prerequisite | Fails fast in ~1s, exit 2 |
| **Q** Approval cap | `APPLY_DAILY_APPROVAL_CAP` (30) — the queue cap had been bounding a free action |
| **R** Recovery | Evidence pinned with checksum, ρ reproduces from a committed fixture, deletion braked |
| **S** Board restore | 5 → 1296 rows. ρ 0.737 from board == from fixture |
| **T** Deploy check | Schemas match. **Found the brake was never deployed** |
| **U** Enrichment control | Manual trigger, freshness gate, export/import, batch provenance |

---

## Findings worth not rediscovering

**`discovered_at` is not `scraped_at`.** By `discovered_at`, 96.7% of the 837 unenriched rows looked
14–60 days old — stale. By `scraped_at`, which `aggregator.js:319` re-stamps on every re-sight, all
837 had been seen within three days. **Same rows, opposite answers.** A `discovered_at` age gate
would have refused 809 live postings and looked like it was working. The shipped gate keys on
`scraped_at`, defaulted to the same 7 days as `runExpiredJobsCleanup`.

**`ran_at` was a typo, not schema drift.** The column is `run_at`, and `SELECT ran_at` fails
identically against local. Migration `011_cleanup_log` declares it byte-identically in both
dual-path definitions. I reported schema divergence from this; there was none.

**A 200 does not mean a route exists.** `GET /api/admin/enrichment/coverage` returned HTTP 200 from
production with the SPA's `index.html`, because the client catch-all answers 200 for any unknown
path. A status-code probe "confirmed" a deployment that had not happened. **Assert a specific JSON
key, never a 200** — that is why task T's `approvalCap` probe worked.

**The cleanup brake was committed, documented, and not deployed** for a day. `bd95d20` was in `main`
while production ran a build predating `abea2c9`, committed 49 seconds later. 1248 live postings
were one process start from the id-85 predicate. Documenting a guard does not guard anything.

**Production enrichment was dead for three days and perfectly instrumented.** Railway carried a
retired Groq model, so every call 404'd. `usage_events` recorded 25 calls/day with 0 ok on 09-05,
09-06 and 09-07, then 25/25 on 09-08 after the fix. The monitoring was flawless; nobody was reading
it. **Three silent provider failures now** — Jobo never running, enrichment stamping empty rows, and
this — all found by someone happening to look.

**`max_tokens: 500` silently breaks reasoning models.** Twice: A2 saw HTTP 200 with a null extraction
49 times in 50; the U1 proof run saw exactly 500 output tokens and truncated JSON 10 times in 10,
`success = 1` on every one. Treat it as a documented pipeline property.

**Stubs answer for retired model IDs.** Task A's +33 tests all used fetch stubs, so nothing could
notice that `llama-3.1-8b-instant` no longer exists. Stubs verify plumbing, never existence.

**`purpose classifier` is not `classify_job`.** One word apart, adjacent in every cost report — and
`services/classifier.js` sends 2000 chars of the candidate's résumé. Routing by call-site name would
have leaked résumés on the first pass. **Route by payload, not by name.** The fail-closed CANDIDATE
default is what makes a misclassified site fail safe.

**The obvious ATS floor fix makes ranking worse.** Renormalising over informative components:
ρ 0.448 → 0.242, mis-ordered 33.6% → 41.0%, floating a Fraud Strategist above a backend engineering
role. Recorded in code with its numbers and pinned by a test. **Do not undo it.**

**Targeted generation's premise was false.** Mean 9.08 missing weighted terms per job; 78.8% of jobs
have *zero* rephrasable gaps; 64.8% of missing terms are genuinely absent. Handing the model a gap
list gives it nine things it is rewarded for claiming, two-thirds of which the candidate lacks — a
more dangerous prompt, not a cheaper one. The real cost split is output 51%, cache write 40%, input
8.6%, so prompt shortening is nearly worthless.

**Android: "Application sent" for 2.5 seconds, having sent nothing.** A hard-throw gesture was
implemented in five places and reached a badge that lied, because the view model routed it into the
same local queue list.

**Android: builder and preview held separate repositories.** `viewModel()` scopes to the
`NavBackStackEntry`, so every edit was invisible in the preview and **"Export as PDF" wrote the mock
résumé to a file the user then shared.**

**iOS: 30 of 32 Swift files are in the build target.** The two omitted are `JobRepository.swift` and
`LinkedInAuthService.swift` — the entire network and auth surface is never compiled.
