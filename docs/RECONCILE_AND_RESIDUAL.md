# Reconciliation Audit + Residual Work

**Written:** 2026-09-09, from chat provenance. Two parts:
**Part 1** is a read-only audit prompt — run it first, because this doc will be stale.
**Part 2** is the residual task list, including Y and Z filed by the W/X session.

---

# PART 1 — Reconciliation audit (read-only, run first)

```
Session-aware. This task CHANGES NOTHING. Produce a reconciled status report.

WHY THIS EXISTS
The planning docs in this repo have been the stale thing FIVE times: AK2 found three of five tasks
already done · AL1 found two of three · AM3 found two doc claims wrong · AM4 found its own task's
central premise inverted · AN1 (task V) found two brief premises wrong by testing them. In every
case the standing "re-derive before starting" instruction caught it. This audit is that instruction
applied to the whole board at once.

⛔ DO NOT TRUST docs/NEXT_WORK.md, docs/FINDINGS_ARCHIVE.md, or anything below. Derive from the
repo, the test suite, the migration tables, and production.

1 · GROUND TRUTH
   - Current test count and failures. Recent numbers claimed: 2301.
   - Migration high-water LOCAL and PRODUCTION, and whether they match. 102 and 103 were reported
     local-only and then deployed by the owner — CONFIRM production actually carries them, by
     asserting a JSON key from a route those migrations enable. A 200 is not evidence: the SPA
     catch-all answers 200 for any unknown path and has already "confirmed" a deployment that had
     not happened.
   - Contract version at contract/mobile-api.v1.json.
   - git log since 339c9d1: what landed, in what order.

2 · PER-TASK STATUS. For each, state DONE / PARTIAL / NOT DONE with the evidence, not the doc's
   claim. Tasks claimed complete: A, A2, B, C, D, E, F, G1-G4, H, I, Q, R, S, T, U, V, W, X.
   Open per the doc: Y, Z, iOS Phase 1, Android admin flavour, Android backup excludes.
   ⛔ Flag anything the docs call done that is not, AND anything they call open that is.

3 · THE CLAIMS MOST LIKELY TO BE STALE — check each specifically:
   a. Task W enabled +141 rows plus Mercury 40 / Ramp 96, and seeded Veeva/Ubisoft/Bosch/Adobe
      INACTIVE with measured reasons. Confirm the active source list in production and the row
      counts per source. Confirm the four inactive ones are still inactive and their reasons are
      recorded where a future session will read them.
   b. Task W found searchJobs structurally capped at three of seven sources via named
      _ghCompanies/_leverCompanies/_ashbyCompanies parameters. Confirm the fix reached production
      and that all seven plugins can now receive companies.
   c. Task X swapped logos to DuckDuckGo behind one LOGO_HOST and removed a silent Google-favicon
      fallback. Confirm no second logo provider survives anywhere, and that the privacy policy does
      not need updating for whatever provider is now in use.
   d. Enrichment backlog: the drain was at 790 candidates. Report the CURRENT number and the
      per-column coverage. Only skills_json is a real gain — summary, normalized_title and
      experience_level were 1255/1255 from ingestion.
   e. THEIRSTACK_API_KEY was found vestigial and SERPAPI_KEY live-but-half-wired. Report whether
      either changed and whether THEIRSTACK is still in the production environment.

4 · THE UNJUDGED DECISION. Enrichment corrects ~19-25 values IN PLACE per 10 rows, overwhelmingly
   summary and normalized_title — columns ingestion had already filled, so they move no fill rate
   and are invisible in columnsClimbed. That extrapolates to ~2,000 rewrites across the backlog,
   and normalized_title feeds BOTH profileTitleSql's board narrowing AND the ATS scorer.
   NOBODY HAS JUDGED WHETHER THE REWRITES ARE IMPROVEMENTS. Pull the before-image for one batch
   (POST /api/admin/enrichment/batches/{id}/revert {apply:false}) and present 10 old-vs-new pairs
   for summary and normalized_title so the owner can decide. Do not decide for them; do not apply
   anything.

5 · GUARDS THAT MAY BE BLIND. Four have now shipped inert:
     modelCallGuard missing messages.batches.create · its comment stripper erasing https:// URLs ·
     three dead source anchors in passing tests · ae5BoardUi stubbing logo.clearbit.com with a 1x1
     PNG so its logo assertions passed while every logo on the board was dead.
   Sweep for the same shape: any test whose fixture or stub makes the asserted condition
   unreachable. Report candidates; fix nothing in this task.

6 · WHAT THE DNS SWEEP COULD NOT SEE — task X's own observation, and the most generalisable finding
   in the project:
     "would have caught only one of three failures — Groq's model id and lever's slugs were
      IDENTIFIERS retired while their HOSTS stayed up."
   Report every external dependency where an identifier (model id, company slug, API version,
   board token) can be retired without the host changing, and whether anything would notice.
   Host liveness is the easy check and the rare failure.

OUTPUT: a reconciled table, a list of doc corrections needed, the 10 rewrite pairs from item 4, and
a recommended order for Part 2. Change nothing.
```

---

# PART 2 — Residual tasks

Ordered. Y and Z were filed by the W/X session; the rest are carried.

## TASK Y — SmartRecruiters / Workday need an N+1 budget model

```
Filed by task W. Four of five providers were enabled; these two were not, because their
descriptions require a second request per posting and nobody has costed that.

1. MEASURE FIRST, as W did. W's method was the reusable part: measure FIELD COVERAGE on normalized
   rows, not endpoint reachability. That is how workable's "needs an N+1" comment was disproved —
   ?details=true returns descriptions in the SAME request. Check the same for these two before
   accepting an N+1 as necessary.
2. If an N+1 IS genuinely required, model the budget: requests per crawl, time per crawl, and
   whether the daily cron can complete inside its window. State the row volume BEFORE enabling.
3. ⛔ 0% DESCRIPTION COVERAGE IS A DISQUALIFIER. W seeded Ubisoft (97), Bosch (334) and Adobe (217)
   inactive for exactly this — 648 rows that can never be enriched would inflate the board and
   degrade every coverage metric. Apply the same test here.
4. Workday is per-tenant and structurally different from the others. Report what it actually needs
   rather than forcing it into the shared shape.
5. Every writer routes through reconcileFingerprint / computeReqUid and derives automation_tier
   through the SAME shared function. W verified 0 NULL tiers across 1385 rows — keep it there.
```

## TASK Z — The board lost its ATS badge

```
Filed by task X. Pre-existing, fails identically on a HEAD check, and INVISIBLE TO THE NODE SUITE —
which is the interesting part, not the badge.

1. Find why it regressed and when. Do not fix forward without knowing what removed it.
2. ⛔ THE REAL DEFECT IS THAT NOTHING NOTICED. ae5BoardUi stubbed logo.clearbit.com with a 1x1 PNG,
   so its logo assertions passed while every logo was dead; the same suite missed this. Report what
   would have to be true for a browser check to catch a missing badge, and add that — a passing
   render test that cannot distinguish "rendered" from "rendered correctly" is not a test.
3. Verify by screenshot, not by assertion count.
```

## TASK AA — Prove the export → enrich → import loop at 20 rows

```
Every piece now exists and is individually verified: export works, the five guards fire naming row
and column, the panel is live beside Download .sql, and a real dry run against production returned
matched 5 / wouldWrite 0 / unchanged 5.

WHAT HAS NOT BEEN DONE is the loop end to end with real external enrichment in the middle. Do it at
20 rows, where a mistake costs nothing.

1. Export 20 rows that are genuinely missing skills_json. That is the ONLY column with headroom —
   summary is 1255/1255, and a live dry run already reported "5 rows had values skipped because the
   column was already non-null". Everything else in the file will bounce off the null check, which
   is correct behaviour and will look like failure if you do not expect it.
2. Enrich externally, import, dry run first, then apply.
3. Verify: only skills_json climbs · nothing else is touched · the import appears as a batch with
   source='import' · it reverts to the exact before-image.
4. Report the practical batch size you observed against the stated practicalImportRows: 500 and the
   32 MB ndjson ceiling. 790 rows was measured at 5.06 MB and exceeds express.json's 4 MB limit —
   which is why import takes a raw application/x-ndjson body.
```

## TASK AB — Delete the vestigial keys, decide on the half-wired one

```
Small, from task W's audit answers.
1. THEIRSTACK_API_KEY is VESTIGIAL. Remove it from the Railway environment. A key in production for
   a source nothing calls is a standing question every future audit has to re-answer.
2. SERPAPI_KEY is LIVE BUT HALF-WIRED, and the aggregator logs "Inactive (not configured): adzuna,
   serpapi" on every boot. Decide: wire it properly or retire it. Report what "half-wired" means
   concretely — a key that is read but never reaches a request is different from one that reaches
   a request nothing consumes.
3. Neither is urgent. Both are cheap, and both remove a false signal.
```

## TASK AC — A per-source health check that measures rows, not reachability

```
The generalisation of task X's own best finding, and the strongest lesson in the project:

  "The DNS sweep found one dead host of 24 — but would have caught only ONE of the three failures
   hit so far. Groq's model id and lever's slugs were IDENTIFIERS retired while their HOSTS stayed
   up."

Three failures, three months, all invisible:
  · Jobo never ran — key unset, logged "sync complete — 0 jobs cached"
  · enrichment 404'd for three days on a retired model id — usage_events recorded it perfectly
  · lever's three company slugs all 404'd after those companies moved off Lever — five crawls of
    no_results
None would be caught by a host-liveness check. All three would be caught by asserting that rows
arrived with populated key fields.

1. Per configured source: last successful run, rows written that run, and FIELD COVERAGE on those
   rows (not just a count). W's workable finding — 0/20 → 20/20 descriptions — came from exactly
   this measurement.
2. A configured source producing zero rows, or rows with 0% descriptions, is an ALERT — not a quiet
   entry in a log nobody reads.
3. An UNCONFIGURED provider must read as NOT CONFIGURED, never as a zero-row success. That
   distinction is what hid Jobo for months.
4. Enrichment coverage per column belongs here too. It has been 37% on skills_json for weeks with
   nothing surfacing it.
5. ⛔ This is the scrape-monitor repurpose, scoped and deferred roughly fifteen times. Every silent
   provider failure in this project would have been visible on day one. Read-only aggregations over
   existing tables; no writes, no model calls.
```

## Carried, unchanged

| | |
|---|---|
| **iOS Phase 1 audit** | `resume-master-ios/IOS.md` — needs a Mac. Two phases behind Android |
| **Android admin build flavour** | `resume-master-android/ANDROID.md` — source-set separation, verify by grepping the release bundle |
| **Android backup excludes** | Same doc. The auth token AND a persisted résumé are both swept into Google cloud backup right now |

## Owner-only

| | |
|---|---|
| **Extension upload** | Zip rebuilt 42,370 bytes, 2301 tests green, screenshots verified 1280×800 / 24-bit / no alpha and checked against the real profile values. Needs your Google login |
| **AF5** | 30 real applications, 10 per ATS. Still the only test of whether ρ = 0.746 predicts anything about employers rather than about your own judgement |
| **Judge the ~2,000 rewrites** | Part 1 item 4 produces the pairs; the decision is yours |
| **Jobo** | Deferred to launch readiness |

---

## TASK AD — A2's two follow-ups, never done

```
Both filed by the provider-verdict session and never picked up. Both are small and both are the
general fix for a class this project keeps hitting.

1. PACE ON TOKENS, NOT REQUESTS. The code paces on 30 req/min. Groq's binding limit was measured at
   8000 TOKENS per minute — about 2 calls/min, making a full pass ~9.7 hours. The pacing axis is
   simply wrong. Dormant today because enrichment is on Haiku, but it will bite the moment any
   token-limited provider is used.
2. MODEL-CATALOGUE LIVENESS CHECK. At startup, ask the provider whether the pinned model still
   exists. If it is gone, REFUSE TO START and say so. No guessing, no substituting.
   ⛔ Do NOT build an auto-updater that picks whatever is available. That is how you silently switch
   to a model that behaves differently — openai/gpt-oss-20b returns HTTP 200 with an EMPTY
   extraction 49 times in 50 at max_tokens 500. An auto-updater would have "fixed" the 404 by
   quietly enriching nothing.
3. Related, and worth pinning as a documented pipeline property: max_tokens: 500 silently breaks
   reasoning models. Seen twice — 49-in-50 nulls, and 10-in-10 truncations at exactly 500 output
   tokens with success=1 on every one.
```

## TASK AE — The cron is a trickle (ENRICH_BATCH_SIZE)

```
ENRICH_BATCH_SIZE defaults to 25, and the cron runs once daily. That is ~6 WEEKS to drain 790 rows,
while ingestion can add hundreds in a day — and task W just added +141 with more sources pending.

Any backlog above ~25 is therefore PERMANENT unless someone triggers it manually. That is not a
tuning nit: it is why 837 rows accumulated with nothing surfacing it, and why the manual trigger had
to be built at all.

1. Decide: a much larger batch size, or a cron that LOOPS until the candidate set is empty within a
   bounded budget. State which and why.
2. Whichever, it must respect the daily spend ceiling and report coverage per column, not counts.
3. Report the drain time for the current backlog under the chosen setting.
```

## TASK AF — Confirm the full-auto kill switch exists

```
AF3 specced a kill switch: one env/config flag disabling all unattended submission immediately,
without a deploy, leaving semi mode working. A later scan of the Railway environment found NO such
variable.

It may exist under another name, or in config rather than env. FIND OUT before the first unattended
run — full-auto without a way to stop a batch mid-flight is a batch you cannot recall.

1. Locate it or confirm its absence. If absent, build it.
2. Verify it takes effect on an IN-FLIGHT batch, not only at admission. AF3's own verification found
   the switch had been tested at admission only; mid-batch was proven separately (1 of 3 submitted,
   2 held).
3. Same pass: confirm APPLY_DAILY_CAP (25), APPLY_DAILY_QUEUE_CAP (40) and
   APPLY_DAILY_APPROVAL_CAP (30) do not interact such that one makes another unreachable.
```

## TASK AG — Mobile corruption sweep (now unblocked)

```
docs/CORRUPTION_SWEEP.md was run on desktop and only REPORTED for the mobile repos, because no JDK,
Gradle, Android SDK or Xcode existed on the machine and the sweep requires "verified by an actual
build". ANDROID STUDIO IS NOW INSTALLED, so the Android half is unblocked. iOS still needs a Mac.

Known and waiting:
 · BOM on gradle/libs.versions.toml — a conforming TOML parser demonstrably REJECTS it and parses
   cleanly once stripped. Highest-severity item; may be the whole blocker to a first assemble.
 · BOM on 55 of 57 text files, including all three .gradle.kts and gradle-wrapper.properties.
 · gradle.properties hardcodes org.gradle.java.home=C:\Program Files\Android\Android Studio\jbr.
 · compileSdk 35 with AGP 9.0.1, which requires 36+. suppressUnsupportedCompileSdk hides the
   warning, not the minimum.
 · Both mobile SYNC.md files carry a cp1252 0x97 at offset 2277 and are not valid UTF-8.
Run the full sweep, both parts, and verify by an actual build this time.
```

## TASK AH — Small deferred items, one commit

```
Filed across several sessions, each too small for its own task.

1. A VERSION ENDPOINT returning the deployed commit SHA. The deployed build has twice been
   identified by archaeology — inferring the commit from which features the API happens to serve
   ("production does not serve approvalCap, so it predates abea2c9, committed 49 seconds after the
   brake"). That works and should not be necessary.
2. Drop import_extension_tokens from production — filed by task T, never done.
3. The restored LOCAL board was rebased on restore and ALL ROWS EXPIRE TOGETHER ~7 days out. Check
   whether that has already fired; if the dev board has emptied again, that is why. Production is
   unaffected.
4. Retire or re-head docs/QUEUED_PROMPTS.md. It is superseded by NEXT_WORK.md and still lists API
   credit as a blocker. Two planning docs disagreeing is what had AK2 rebuilding three finished
   tasks.
```

## Carried from the mobile and product docs — not scheduled here

| | Where | Note |
|---|---|---|
| **Android 2c** swipe feed | `ANDROID.md` | After the two open Android items. Cursor paging, not offset; gate on `automationTier`; show the BAND, not a number |
| **Android 2d** review queue | `ANDROID.md` | **The product's promise.** Endpoints already exist and are well specified. A user who swipes 40 and reviews 0 has spent money and applied to nothing |
| **iOS Phase 1** | `IOS.md` | Needs a Mac. Two phases behind Android |
| **Desktop swipe feed** | `SWIPE_FEED_DESIGN.md` | Gate C superseded by the mobile audit |
| **Recruiter surface (FE-6)** | built, no front door | No recruiter role, no signup path, no acquisition story. A second product behind a tab. Deferred deliberately — the seeker side is not proven |
| **196 synonym proposals** | awaiting review | Owner. G1 moved ρ by **+0.000**, so this is low value — skim and approve the obvious, or leave the table dormant |

---

## Run order

**Now, in parallel — different repos, no collision:**

| | Task | Where | Why now |
|---|---|---|---|
| 1 | **Part 1 audit** | desktop | Cheap, read-only, and this doc is already stale |
| 2 | **AG** mobile corruption sweep | android | Android Studio is installed — unblocked after weeks |

**Then, desktop, in this order:**

| | Task | Why here |
|---|---|---|
| 3 | **AA** — 20-row loop | Proves the route the whole enrichment strategy now depends on |
| 4 | **AE** — the cron trickle | 6 weeks to drain is why backlogs became permanent. Fix before adding sources |
| 5 | **AC** — per-source health check | Would have caught all three silent provider failures. Before Y, so a new source's health is visible from the moment it is enabled |
| 6 | **Y** — SmartRecruiters / Workday | After AC |
| 7 | **Z** — ATS badge | Small; the real finding is that nothing noticed |
| 8 | **AD** — token pacing + model liveness | Dormant on Haiku, but it is the general fix for the retired-identifier class |
| 9 | **AB** + **AH** | Housekeeping, one session |
| 10 | **AF** — kill switch | Before any unattended run, not before AF5 (semi does not need it) |

**Android, after AG:** admin build flavour → backup excludes → 2c feed → 2d review queue.
**iOS:** Phase 1 audit when a Mac exists.

**Owner, alongside all of it:** extension upload · **AF5** · judge the ~2,000 rewrites (Part 1
produces the pairs) · the 196 synonym proposals.

> **AF5 remains the only item that tests whether the product works.** Everything above is
> infrastructure for a pipeline that has completed exactly one real application.
