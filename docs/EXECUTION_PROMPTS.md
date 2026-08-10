# resume-master — Execution Prompts (post-diagnosis)

Companion to `docs/PIPELINE_DIAGNOSIS.md`. Run **in order**, one task per session, one commit
each. Do not bundle.

**Before anything:** resolve the test baseline. The last commit claimed "44 unique failures
(baseline unchanged)" against a documented 45. Run `npm test`, de-dupe (Node's reporter
double-prints — a raw ✖ count shows ~2x), and record the real number. Every task below compares
against it, so a wrong baseline poisons all of them. If it is 44, identify which of the 45 went
green — it was likely reporting the skills_json bug and was being dismissed as unrelated noise.

---

## Standing conventions (prepend to every task)

```
Session-aware: read the files in scope and reconstruct state from the repo and the DB — do not
trust status docs, including the handoff brief. No UI/current-feature change without sign-off.
/api/jobs stays byte-compatible; new fields/params optional and default-off. Regression-proof:
for every modified module, review its dependents (importers) and children (imports) and fix them
in the SAME pass, reporting each with a verdict. Migrations additive + dual-path, byte-identical
in BOTH scripts/migrations.js and the server.js MIGRATIONS array (high-water 068, next id 069).
Close the task with a REPORT (files changed, dependents + verdicts, migration id if any, REAL-run
verification — not simulated) then commit & push as ONE focused commit.

Context: production diagnosis found three stacked failures — Jobo never ran (JOBO_API_KEY unset,
silent skip), enrichment writes NULL over good data then stamps rows complete, and three query
filters hard-failed on NULL. See docs/PIPELINE_DIAGNOSIS.md. The pattern is that every failure
logs like success; when you add behaviour here, make failure LOUD.
```

---

## TASK 0 — Commit the work already in the tree

```
OBJECTIVE
Clear the working tree. Uncommitted work has repeatedly been lost to session collapse; this is
finished, verified-by-reading work that should not be sitting loose.

SCOPE
Already modified, NOT yet committed:
- services/jobs/jobQuery.js — experience_levels and work_models made soft-null
  (sj.<col> IS NULL OR sj.<col> IN (...)), matching the skills_include fix from the prior session
- services/jobs/profileFilterBridge.js — comment only; replaced the claim that "only the visa
  filter is required to be null-safe" (that belief let this bug ship three times)
- test/jobQueryFilters.test.js — three tests appended, in the existing in-memory-SQLite idiom
- docs/PIPELINE_DIAGNOSIS.md — new

SEPARATE, DO NOT INCLUDE
- client/src/components/ImportJobModal.jsx — unrelated BYO-1 UI, unwired and unbuilt. Stash it
  or commit it on its own branch. It must not ride along in this commit.

REQUIREMENTS
1. git diff every file above and confirm the changes are as described before committing.
2. Run npm test. The three new tests must pass; introduced failures must be 0.
3. Two commits: one for the filter null-safety + tests, one for the diagnosis doc.

VERIFY
Real npm test run. Report unique failure count vs the confirmed baseline. Confirm ImportJobModal
is NOT in either commit. Then push.
```

---

## TASK 1 — Read-only diagnostics (no code changes)

```
OBJECTIVE
Answer the open questions in docs/PIPELINE_DIAGNOSIS.md §3 against PRODUCTION data. Read-only:
change no code, no schema, no rows. Output a findings table. This gates TASK 3 — the description
result determines whether the enrichment fix is complete or whether ingestion is also broken.

QUERIES (run against production)
1. Descriptions — the prime suspect for all-NULL enrichment output:
   SELECT source, COUNT(*) n,
          SUM(description IS NULL OR description='') no_desc,
          AVG(LENGTH(COALESCE(description,''))) avg_len
   FROM scraped_jobs WHERE is_active=1 GROUP BY source;
2. company_technographics row count. Skills are 0% populated and this table is fed from them —
   if it is empty, FE-4's STACK block and FE-6's stack reference render empty states for every
   company while their tests still pass.
3. Visa coverage — this is the OPT/STEM-OPT/H1B niche edge:
   SELECT SUM(is_h1b_sponsor IS NOT NULL), SUM(requires_work_auth IS NOT NULL),
          SUM(is_clearance_required IS NOT NULL)
   FROM scraped_jobs WHERE is_active=1;
4. Server logs: the most recent [enrichJob] cost line. Input/output tokens ~0 means the LLM is
   not being called at all, which is a different bug from "called and returned nulls."
5. Server logs: the most recent [cacheJobs] run. Why did ashby last write 2026-08-07 while
   greenhouse wrote today? Look for a per-source error.
6. Why is adzuna's discovered_at NULL for all 10 rows? Trace where sources/adzuna.js sets it.
   NULL discovered_at is silently dropped by jobQuery.js's recency filter (~line 171) and by the
   NEW<24h pill.

REQUIREMENTS
- Report findings as a table. For each, state what it implies for the enrichment fix in TASK 3.
- Propose no fixes in this task. Do not modify anything.
```

---

## TASK 2 — Jobo: unblock and make the skip loud

```
OBJECTIVE
Jobo has never written a row. aggregator.js:777 cacheJoboFeed() early-returns 0 when
joboSource.isConfigured() is false (jobo.js:23 -> !!process.env.JOBO_API_KEY), and the cron then
logs "Jobo feed sync complete — 0 jobs cached". A skip and a real empty sync are indistinguishable.

OWNER ACTION FIRST (the agent cannot do this)
Set JOBO_API_KEY in the Railway environment and local .env. Confirm the key is currently valid —
the previously pasted jbe_live_... key was flagged for revocation, so a revoked key with no
replacement produces exactly this symptom. Do not paste the key into any prompt or chat.

REQUIREMENTS
1. Make the unconfigured path LOUD: console.warn, not console.log, and worded as a
   misconfiguration rather than a routine skip.
2. Make cacheJoboFeed's return distinguish "skipped (unconfigured)" from "synced 0 jobs", and
   have the server.js:3072 cron line log those differently. A provider that never ran must never
   again read as a healthy empty sync.
3. Live verification, BOUNDED: POST https://connect.jobo.world/api/jobs/feed with
   {"batch_size":10} and X-Api-Key from process.env.JOBO_API_KEY. TEN JOBS ONLY.
   DO NOT run a stable_scan backfill — it burns wallet credits.
4. Confirm rows land with source='jobo' and is_active=1, and that an ATS duplicate still wins
   canonical (direct ATS > provider > aggregator > import).
5. Confirm the expiry path (GET /api/jobs/expired) maps to is_active=0 and only touches rows
   where source='jobo' (the aggregator.js:802 guard).

REGRESSION
cacheJobs and the ATS sources are untouched. Confirm the 04:00 cron still runs both sequentially.

VERIFY
SELECT source, COUNT(*), SUM(is_active=1) FROM scraped_jobs GROUP BY source;
jobo must now appear with a non-zero active count. Report the before/after. Commit & push.
```

---

## TASK 3 — Enrichment: stop it destroying data

```
OBJECTIVE
enrichJob.js is not lagging — it is actively degrading the board. Its UPDATE (enrichJob.js:191)
writes every column unconditionally from `signals`, including normalized_title and
experience_level, then stamps content_hash + enriched_at. When the model returns an all-NULL
signal set (which does NOT throw, and is indistinguishable from a legitimate "the JD is silent"),
good greenhouse-provided values are overwritten with NULL and the row is marked permanently
complete — enrichJob.js:184 filters candidates by content_hash equality, so it never retries.

Evidence: 120 rows have enriched_at set, all with summary/salary/skills NULL; greenhouse null_exp
is 124; of the 564 unenriched rows 527 still have normalized_title.

DO NOT run enrichment against production until this lands. Every pass nulls more rows.

READ FIRST
services/jobs/enrichJob.js in full — extractSignals, the candidate selector (:177-184), the
UPDATE (:191-201), the success path (:214-236), and the failure path (:237-240, which is already
correct — it deliberately leaves content_hash/enriched_at alone so the row retries).
Also read TASK 1's description findings before choosing the fix.

REQUIREMENTS
1. Enrichment may only ADD information, never remove it: COALESCE(@field, field) for every
   column in the UPDATE, so a NULL signal cannot clobber an existing value. This is the same
   principle the KB layer already follows — absence of a signal must not destroy a signal.
2. An all-NULL (or empty-of-substance) signal set is a FAILURE, not a success: do not stamp
   enriched_at/content_hash, do not increment `enriched`, and log it distinctly so a run that
   produced nothing cannot report as a run that enriched N.
3. Skip rows with an empty/missing description BEFORE calling the API — no input, no call, no
   spend. Count and report them separately as "skipped (no description)".
4. If TASK 1 shows descriptions are empty at the source, that is an INGESTION bug — report it and
   STOP rather than papering over it here. Fixing enrichment does not fix an empty input.

REGRESSION
Dependents: the cron path (server.js), cacheJobs/cacheJoboFeed (both fire runEnrichment via
setImmediate), and upsertTechnographics (fed from signals.skills). Report each with a verdict.

VERIFY (real run, NOT against production)
Seed a local DB with three rows: one with a real description, one with an empty description, one
already-enriched holding a good normalized_title. Run one pass. Assert: row 1 enriches; row 2 is
skipped without an API call; row 3's existing normalized_title SURVIVES a null signal.
Add regression tests covering the clobber case specifically. Commit & push.
```

---

## TASK 4 — Recover the 120 poisoned rows (ONLY after TASK 3 is verified)

```
OBJECTIVE
120 rows carry enriched_at with nothing enriched, and are excluded from the candidate set forever
because content_hash matches. Clear those stamps so they re-enter enrichment.

PRECONDITION
TASK 3 must be committed and verified first. Running this before the fix simply re-nulls them on
the next pass and re-poisons them. If TASK 3 revealed an ingestion-side description bug, that
must be fixed first too — otherwise these rows re-enrich to NULL again.

REQUIREMENTS
1. Count before acting:
   SELECT COUNT(*) FROM scraped_jobs WHERE enriched_at IS NOT NULL AND summary IS NULL;
   Confirm it is ~120. If it is materially different, STOP and report — the population is not
   what the diagnosis measured.
2. Back up the DB first.
3. UPDATE scraped_jobs SET content_hash = NULL, enriched_at = NULL
   WHERE enriched_at IS NOT NULL AND summary IS NULL;
4. Run ONE bounded enrichment pass and confirm those rows now populate summary + skills.
5. Report the enrichment coverage delta per column (% non-null before vs after).

DO NOT clear content_hash across the whole table — that would re-enrich all 684 rows and burn
budget for no reason.

VERIFY
Real before/after counts for enriched_at, summary, skills_json. Commit & push.
```

---

## TASK 5 — Repurpose the monitor into pipeline truth ⛔ SIGN-OFF FIRST

```
⛔ Confirm scope with the owner before starting. This changes an existing admin surface.

OBJECTIVE
The admin monitor scrutinises scraped-job processing — an artifact of the pre-pivot architecture.
It showed 684 rows "existing and looking fine" while three failures ran undetected. Repurpose it
to show whether the pipeline actually WORKED, not what is in the table.

REQUIREMENTS
Per-source: last successful run, rows written that run, and a STALE warning when a configured
source has not written in >48h (ashby has been silent since 2026-08-07 with no visible signal).
Unconfigured providers shown explicitly as NOT CONFIGURED, never as a zero-row success — this is
what hid Jobo. Enrichment coverage as % non-null per enriched column (skills_json, summary,
experience_level, workplace_type, salary, visa flags); 0% must be visually alarming. Enrichment
outcome counts per run: enriched / failed / skipped-no-description. Dedup collisions folded.

Read-only aggregations over existing tables. No new writes, no LLM calls. Prefer no migration; if
one is needed it is id 069, dual-path and byte-identical.

VERIFY
Against real production data, each panel reflects the numbers in docs/PIPELINE_DIAGNOSIS.md §1.
Commit & push.
```

---

## Deferred (do not start yet)

- **Scraping-era cleanup pass** — classification only, no deletions: see §5 of the diagnosis.
  ATS-direct sources are load-bearing and rank ABOVE Jobo; adzuna/serpapi are a cost decision.
- **UI workstream** — board/search-bar separation, modal transitions, PDF editability, redundant
  sections. Separate track. Diagnose PDF editability on its own first: browserLauncher.js's
  launchBrowser (~line 246) overrides the existsSync-validated path with the raw env var, and PDF
  generation runs through Puppeteer. Cheap to rule in or out.
- **Salary filter** — jobQuery.js:152/157 hard-fails on NULL by design, and has_salary is 0, so
  any salary filter empties the board. Product decision, not a bug fix.
