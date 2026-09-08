# Next Work

**Last reconciled:** 2026-09-08 — **AM4 landed U** (`docs/am4-enrichment-control.md`). Enrichment now
has a manual path, a freshness gate, export/import and batch provenance — and **task U's central
premise turned out to be wrong**, which is corrected below rather than quietly worked around.
**Baseline:** **2301** passing, 0 failing (was 2245; +56 from task U). Migration high-water **101**,
byte-identical in both paths; **production is still at 100** until the next deploy. Contract **v1.1.1**.

✅ **THE REDEPLOY HAPPENED — 2026-09-08, and BOTH items it was blocking are now resolved.** Verified
read-only against production the same day:

- ✅ **THE CLEANUP BRAKE IS DEPLOYED.** `GET /api/apply/pending` now serves task Q's `approvalCap`
  (`{limit:30, approvedLast24h:0, remaining:30}`), so the running build is at or past `abea2c9` and
  therefore carries `bd95d20`. **1255 active postings are no longer one process start away from the
  id-85 predicate.** This was described in this file as the highest-value open item; it is closed.
- ✅ **PRODUCTION ENRICHMENT IS ALIVE.** `ENRICH_PROVIDER`/`ENRICH_MODEL` were deleted from Railway
  and enrichment fell back to Haiku exactly as A2's verdict said. Its own `usage_events` bound the
  outage precisely: **25 calls/day with 0 ok on 09-05, 09-06 and 09-07; 25 calls with 25 ok on
  09-08**, `anthropic/claude-haiku-4-5-20251001`, zero rows with zero output tokens.

⛔ **BUT TASK U IS NOT DEPLOYED, because it is not committed.** Production is still at migration
high-water **100_form_field_mappings** (107 rows); `enrichment_batches`, `enrichment_batch_rows` and
`scraped_jobs.enrichment_batch_id` are all absent. The task U work sits uncommitted in the working
tree. Nothing about it reached production and none of its routes exist there.

⚠ **AND A 200 DOES NOT MEAN A ROUTE EXISTS ON THIS APP.** `GET /api/admin/enrichment/coverage`
returns **HTTP 200** against production — with the SPA's `index.html`, because the client catch-all
answers 200 for any unknown path. A status-code-only probe "confirmed" a deployment that had not
happened. Task T's `approvalCap` probe is the right shape and the reason it worked: **assert a
specific JSON key, never a 200.**

> ✅ **THE CLEANUP BRAKE IS DEPLOYED — re-measured 2026-09-08 after the redeploy.** The block below
> is the 2026-09-07 finding and is **superseded**; it is kept because the probe technique is the
> reusable part. `GET /api/apply/pending` now serves `approvalCap`, so the running build is at or
> past `abea2c9` and carries `bd95d20`.
>
> ~~⛔ **THE CLEANUP BRAKE IS NOT DEPLOYED — measured 2026-09-07, task T.** `bd95d20` is in `main`
> and is NOT on production's code path: `GET /api/apply/pending` does not serve task Q's
> `approvalCap`, so the running build predates `abea2c9`, which was committed **49 seconds after**
> the brake. **1248 live postings are one process start away from the id-85 predicate with nothing
> counting the rows first.** This is a redeploy, not a code change, and it is the highest-value
> open item in this file.~~

> ⚠ **This file has been the stale thing twice in three sessions.** AK2 picked up five tasks and
> found three already done. AL1 picked up three and found two already done — B and C, both landed
> between this doc being written and being read. Agents land work faster than the doc can be
> reconciled. **Re-derive the baseline and check each task's status in the repo before starting.**
> That check has caught it every time.

**Blockers cleared:** API credit reloaded · Android Studio installed · Jobo deferred to launch
readiness.

⚠ **CORRECTED 2026-09-07 — `GROQ_API_KEY` IS IN LOCAL `.env`.** This file said it was not, and that
it was why local scripts reported it missing. `.env` carries a live `gsk_`-prefixed key plus
`ENRICH_PROVIDER=groq` and `ENRICH_MODEL`. A2's "owner action first" was already done, and had been
for some time — nobody had re-checked.

⛔ **AND THE MODEL A2 NAMED NO LONGER EXISTS.** `llama-3.1-8b-instant` returns
`404 model_not_found` and Groq's live catalog lists **no llama model at all**. Task A was built,
guarded and tested against fetch stubs and never served a real token, so nothing in the suite could
notice — a stub answers for any model id, including a retired one. Re-pinned to
`openai/gpt-oss-20b`; see `docs/am3-provider-verdict.md`.

---

## Order

| # | Task | Repo | Needs | Status |
|---|---|---|---|---|
| **A** | Multi-provider routing + widened guard | desktop | keys | ✅ code done — **A2 below is what remains** |
| **B** | ATS bands | desktop | — | ✅ **DONE** — `docs/ak2-ats-bands.md`, ρ 0.643 → **0.746** |
| **C** | Android Phase 2a | android | — | ✅ **DONE** — `docs/aj2-android-phase2a.md` |
| **D** | Generation deferral | desktop | B ✅ | ✅ **DONE 2026-09-04** — `docs/al2-generation-deferral.md`, 19-check real run |
| **G** | Offline assets — G1 skills · G2 LCA · G3 technographics · G4 org units | desktop | A code | ✅ **ALL DONE** — G1/G2/G4 2026-09-04, G3 2026-09-05. `al3-skill-synonyms.md`, `al4-lca-and-org-units.md`, `al7-technographic-canonicalisation.md` |
| **F** | PII tokenization layer | desktop | A code | ✅ **DONE 2026-09-04** — `docs/al5-pii-tokenization.md`; real round trip verified |
| **E** | Cache breakpoints + Batch API | desktop | D | ✅ **DONE 2026-09-04** — `docs/al6-cache-and-batching.md`; removal would LOSE $0.36 |
| **H** | Form label → field mapping | desktop | G4 | ✅ **DONE 2026-09-05** — `docs/al8-form-field-mappings.md`; input empty + attributes win, headroom ~0 |
| **I** | Harness runner prerequisite doc | desktop | — | ✅ **DONE 2026-09-04** — fails fast in ~1s, exit 2 |
| **R** | ⛔ **RECOVERY** — board deleted, evidence on a retention clock | desktop | — | ✅ **DONE 2026-09-05** — `docs/am1-recovery.md`; evidence pinned, ρ reproduces from a committed file, the deletion is braked |
| **Q** | Approval cap — the queue cap now bounds nothing | desktop | — | ✅ **DONE 2026-09-05** — `docs/am2-approval-cap.md`; `APPLY_DAILY_APPROVAL_CAP` (30), verified in real Chrome |
| **S** | Restore the local board | desktop | — | ✅ **DONE 2026-09-07** — `docs/am3-board-restore-and-schema.md`; 1291 restored, 1296/1266 active, ρ 0.737 from board == fixture |
| **A2** | Provider quality verdict | desktop | S ✅ + key ✅ | ✅ **DONE 2026-09-07** — `docs/am3-provider-verdict.md`; **KEEP HAIKU**, skillsHard Jaccard **30.5%** |
| **T** | Is the brake deployed? + a real prod/dev schema check | desktop | — | ✅ **DONE 2026-09-07** — schemas match; ⛔ **THE BRAKE IS NOT DEPLOYED** — redeploy |
| **U** | Enrichment control, export/import, batch provenance | desktop | — | ✅ **DONE 2026-09-08** — `docs/am4-enrichment-control.md`; **the 837 are NOT stale** — all were last seen within 3 days |
| — | iOS Phase 1 audit | ios | **a Mac** | open — `resume-master-ios/IOS.md` |

**Open: the iOS audit only** — and it needs a Mac. Everything else in this table is ✅ DONE; do not
re-run it. Their prompt bodies are retained below for reference only.

✅ **RESOLVED 2026-09-08 — the two variables were deleted and production redeployed.** Enrichment is
back on Haiku and succeeding (25/25 on 09-08). The block below is the 2026-09-07 diagnosis, kept
because the *shape* of the failure is the reusable part: the instrumentation was perfect and nobody
was reading it, three days running.

⛔ **AND THE BACKLOG STILL WILL NOT CLEAR ON ITS OWN — measured 2026-09-08.** Enrichment working is
not the same as the backlog draining:

```
enrich_job calls per day, 14 days straight:   EXACTLY 25/day
  09-05  25 calls,  0 ok  |  09-06  25 calls,  0 ok  |  09-07  25 calls,  0 ok   <- the outage
  09-08  25 calls, 25 ok                                                          <- recovered
backlog:  837 never-enriched (09-07)  ->  818 (09-08)      i.e. -19 in a day
```

`ENRICH_BATCH_SIZE` is **25** and there is **one** scheduled pass a day, so the drain rate is capped
at 25 rows/day *minus* new arrivals. **818 rows is ~6 weeks at the current arrival rate (5-7/day),
and it GROWS on any burst** — arrivals were 22, 28, 27 and 36/day on 09-01 to 09-04. Candidate
selection is `ORDER BY discovered_at DESC`, **newest first**, so every burst pushes the oldest
unenriched rows further back rather than nearer.

They will not expire meanwhile — all 818 are re-sighted daily, which resets the 7-day window — so
this is not data loss. It is **~6 weeks of 818 postings contributing nothing to `skills_json`**, and
`skills_json` is what feeds `company_technographics` and the ATS scorer.

**Task U's manual trigger is the fix and it is one deploy away:** 818 rows is ~$3.00 at the Haiku
ceiling and clears in ~9 calls at the router's 100-row cap, inside a single expiry window.

~~⛔ **PRODUCTION ENRICHMENT IS DEAD AND HAS BEEN FOR DAYS — measured 2026-09-07.** Railway carries
`ENRICH_PROVIDER=groq` and `ENRICH_MODEL=llama-3.1-8b-instant`, a model Groq has retired, so every
enrichment call 404s. Production's own `usage_events` recorded ten consecutive `success=0`,
`in=0 out=0` rows at 08:00 today. **The instrumentation worked perfectly; nobody was reading it.**
**837 of ~1248 active rows are unenriched.** Owner action: delete BOTH `ENRICH_PROVIDER` and
`ENRICH_MODEL` from Railway so enrichment falls back to Haiku, per A2's verdict. Leaving
`ENRICH_MODEL` alone still points at a dead model id.~~ **(done 2026-09-08)**

⛔ **AND TASK U FOUND A SECOND, INDEPENDENT REASON TO DELETE BOTH — 2026-09-08.** Re-pinning to a
*live* Groq model does not fix this. **Local `.env` carries `ENRICH_PROVIDER=groq` and
`ENRICH_MODEL=openai/gpt-oss-20b`, and 10 of 10 real enrichment calls failed** with
`Unexpected end of JSON input`: gpt-oss is a **reasoning** model and spends the entire
`max_tokens: 500` output budget reasoning, returning truncated content. Output was exactly 500 tokens
on every call.

**`usage_events` recorded `success = 1` on all ten.** A2 found the null-extraction variant of this;
this is the truncated-JSON variant, and the usage row looks clean either way — the instrumentation
cannot tell "the call returned" from "the call returned something usable". The same 10 rows on Haiku:
**10/10 enriched, nine columns climbed, $0.0251.** So local enrichment has been silently broken in
this exact way for as long as those two variables have been set, and **`.env` needs the same fix
Railway does.**

⚠ **`max_tokens: 500` is a latent trap for any reasoning model.** Ample for Haiku (~263 output tokens
per posting, measured) and not enough for a model that thinks first. Same class as A2's Groq TPM
finding: a limit the code does not know exists.

✅ **BUT THE 837 ARE WORTH ENRICHING, WHICH IS THE OPPOSITE OF WHAT TASK U ASSUMED.** Task U was
written on "most of those 837 are STALE". Measured against production: **809 of 837 (96.7%) are
14-60 days old by `discovered_at`, and 837 of 837 (100%) were last seen within THREE DAYS by
`scraped_at`** — which `aggregator.js:319` re-stamps on every re-sight. They are long-lived *live*
postings, not dead ones. **A `discovered_at` age gate would have refused 809 live postings and looked
like it was working.** The gate that shipped keys on `scraped_at` instead. ~$3.07 ceiling for all 837,
and the gain is `skills_json` **0 → 837**, which feeds `company_technographics` and the ATS scorer —
`summary`, `normalized_title` and `experience_level` are already 837/837 from ingestion.

---

## TASK U — ✅ DONE 2026-09-08. DO NOT RE-RUN.

`docs/am4-enrichment-control.md`. All four parts landed, +56 tests (baseline **2301**, 0 failing),
migration **101_enrichment_batches** dual-path and byte-identical, `mapJobRow` unchanged and pinned.

**What shipped:** `services/jobs/enrichmentSelection.js` (one candidate selector shared by the cron
pass, the dry run, the manual trigger and the export, so they cannot disagree) ·
`enrichmentBatches.js` (provenance + per-row before-image + exact revert) · `enrichmentTransfer.js`
(JSONL export/import with all-or-nothing validation) · `routes/enrichment.js` (admin-gated, every
spending/writing route **dry by default**) · `scripts/am4EnrichBacklogAudit.mjs` (the U1.1
measurement, local + prod, read-only) · `scripts/am4Enrich.mjs` (CLI).

**Four things worth not rediscovering:**

1. ⛔ **The premise was wrong — the 837 are live, not stale.** See the corrected block above. The
   freshness gate keys on `scraped_at` (last seen), defaulting to the **same 7 days** as
   `runExpiredJobsCleanup`'s cutoff, so it means "never spend a token on a row the next cleanup pass
   would delete". A test pins the two sevens to each other by reading server.js's source.
2. ⛔ **The cheap SQL pre-filter over-counts candidates 250x on the restored board** (1252 vs 5):
   task S's restore stamped one bulk `updated_at` onto 1247 rows whose text never changed. Pricing
   the pre-filter would have quoted ~$2.10 to send nothing. Every surface reports both numbers.
3. ⛔ **`enriched_at` must be excluded from any "did coverage climb?" verdict.** It gains by
   definition on every successful write, so counting it made the "no column gained a value" warning
   unable to ever fire — U1.4 would have measured nothing. Fills and *corrections* are also tracked
   separately, because a correction moves no fill rate.
4. ⛔ **A revert cannot null the enrichment columns.** COALESCE means enrichment only filled what was
   NULL, and afterwards it is unknowable which columns those were — ingestion populated many of them.
   Blanket-nulling is the 120-row bug pointed the other way. A per-row before-image is recorded
   before the write and replayed verbatim; `enriched_at`/`content_hash` are restored too, which is
   what returns the row to the candidate set.

**Nothing was enriched in production and no production row was written** (every prod call was a
read-only SELECT). The live local board got only migration 101; all real model calls ran against a
copy in the scratchpad. The rollup brake was not touched.

### original prompt (SUPERSEDED)

```
WHY THIS EXISTS — read before designing anything
Enrichment has three triggers, all automatic, none controllable: the 04:00 ET cron, setImmediate
after cacheJobs/cacheJoboFeed, and enrichJob.js's own row selection. There is NO manual path. That
is how 837 of ~1248 active rows accumulated unenriched during the Groq 404 outage with nothing
anyone could do short of waiting for tomorrow.

THE OWNER'S REASON, which shapes the whole task: most of those 837 are STALE. This work is testing
and extending the enrichment pipeline, not paying to enrich dead postings. So the first requirement
is not "enrich them better" — it is "do not enrich the ones that do not matter." A manual trigger
that carefully enriches 837 expired jobs still wastes the money, just deliberately.

HONEST FRAMING OF THE EXPORT/IMPORT HALF: it does NOT save cost (whoever enriches externally still
pays the tokens) and it does NOT reduce verification effort (data crossing a trust boundary needs
MORE validation, not less). What it buys is CONTROL and SEPARABILITY: enrich a deliberate subset,
re-import a corrected batch without re-running a model, keep the outsourcing door open. Build it for
those reasons; do not claim the others.

─── U1 — FRESHNESS GATE + MANUAL TRIGGER (first; it is the actual problem) ───

1. MEASURE BEFORE BUILDING. Break the 837 down by age and state — count, active, posted_at nulls,
   and min/max discovered_at, bucketed by age. Report how many are worth enriching AT ALL. If most
   are stale, the answer to "clear the backlog" may be "do not" — say so rather than enriching them
   dutifully.
2. A FRESHNESS GATE in the candidate selector. Selection is currently
   `enriched_at IS NULL OR content_hash IS NULL OR updated_at > enriched_at` with no age condition.
   Add one, configurable, and state the default with reasoning.
   ⛔ The restored board's rows were REBASED and all expire together ~7 days from the restore, so a
   naive age gate will behave strangely on this dataset. Measure real discovered_at values.
3. A MANUAL TRIGGER — bounded, admin-gated, with a DRY RUN reporting what WOULD be enriched and the
   estimated cost without calling anything. Haiku is ~$0.0025/row, so 837 is ~$2.10. Show the number
   before spending it.
4. REPORT COVERAGE, NOT CALL COUNTS. A2 found a model returning HTTP 200, success:true, a clean
   usage row and a NULL extraction 49 times in 50. `enriched: 837` proves nothing. Every run reports
   per-column fill rates: skills_json, summary, experience_level, workplace_type, salary_*, visa.
   ⛔ EXPECT THE VISA COLUMNS NEAR ZERO. 0 of 1261 postings mention H-1B, 36 mention sponsorship at
   all. That is the source material, not a failure.
5. PROVE IT ON 10 ROWS BEFORE 837. Enrichment has poisoned rows before — writing NULL over good
   greenhouse values and stamping enriched_at so they never retried. COALESCE and
   don't-stamp-on-empty are in, but this is the first real pass since the provider work touched
   callModel. If coverage does not climb with the count, STOP.

─── U2 — EXPORT ───

1. JSONL, not CSV — CSV loses nested skills_json. Filterable by the same predicates the trigger
   uses (unenriched, active, age, source) so the export set and the enrich set can be identical.
2. SEPARATE SOURCE COLUMNS FROM ENRICHMENT COLUMNS in the output shape, so the importer's writable
   surface is obvious to whoever fills the file in.
3. Include job_id AND content_hash on every row. content_hash is what tells the importer whether the
   posting changed since export — without it, stale enrichment silently overwrites a newer posting.
4. Admin-gated. This is the entire board's text.

─── U3 — IMPORT (most of the risk is here) ───

⛔ EXTERNAL DATA MUST NEVER SILENTLY CLOBBER GOOD VALUES. That bug nulled 120 rows from the inside;
from outside it is worse, because there is no code to inspect afterwards.

1. Match on job_id. Unknown job_id is REJECTED, never inserted.
2. VALIDATE EVERY COLUMN before writing anything: experience_level and workplace_type against the
   shared option registry (do NOT accept free text); skills_json as a parseable array; salary_* as
   integers; visa flags as 0/1/NULL and nothing else. A malformed batch fails AS A WHOLE, loudly,
   naming the offending rows. Never partially apply.
3. FILL NULLS ONLY unless an explicit --overwrite flag is passed. Default additive, matching
   enrichJob's own COALESCE rule.
4. STALENESS CHECK: if a row's current content_hash differs from the exported one, the posting
   changed after export. Refuse by default and report — never apply enrichment derived from text
   that no longer exists.
5. DRY RUN ALWAYS FIRST: rows matched, rows that would be written, rows rejected and why, per
   column. Then apply.
6. Never write enriched_at for a row where nothing was filled. That is the poisoning shape — a row
   marked done and empty leaves the candidate set forever.

─── U4 — BATCH PROVENANCE ───

The owner asked about splitting enrichment into its own table for separate manipulation and joins.
Achievable but expensive: mapJobRow is a field whitelist feeding the board, the mobile contract, the
ATS scorer and the KB rollups — every one would need the join, and this codebase's entire bug
history is contract mismatches.

RECOMMENDED CHEAPER VERSION — build this unless the owner asks for the full split:
1. An enrichment_batches table: id, source (cron | manual | import), provider, model, started_at,
   finished_at, rows_attempted, rows_written, per-column fill rates, cost.
2. A batch id on each enriched row. Columns stay where they are, so NO read path changes.
3. Gives provenance, the ability to identify and revert a bad batch, and a natural export/import
   unit — without touching mapJobRow at all.
4. Migration additive + dual-path, byte-identical in BOTH scripts/migrations.js and the server.js
   MIGRATIONS array.
If the owner does want the full split, report the cost first: every consumer of the enrichment
columns and what each would need.

─── VERIFY ───
U1 age breakdown reported · dry run shows count and cost with no calls · 10 rows enriched with
   per-column coverage climbing · a stated decision on the remaining backlog.
U2 round-trips: export, change nothing, import, assert ZERO rows written.
U3 malformed batch rejected whole · changed content_hash refused · --overwrite required to replace a
   non-null · a batch filling nothing writes no enriched_at.
U4 a batch is identifiable and revertible · mapJobRow unchanged, board response byte-identical.
```

⛔ **The one thing that needs doing is not a task in this table: REDEPLOY.** Task R's cleanup brake
is in `main` and is not on production's code path (task T). Nothing else in this file protects 1248
live postings.

⇒ Also worth queueing from what AM3 turned up, none of it in scope for S/T/A2:
> - **Pace the free tier on TOKENS, not requests.** `PROVIDERS[GROQ].requestsPerMinute: 30` is not
>   the binding limit; 8000 TPM is, and nothing in the code knows it exists.
> - **A model-catalogue liveness check.** A pinned model id can be retired under us and every
>   stub-based test stays green. One real `GET /v1/models` per provider would have caught it.
> - **Drop `import_extension_tokens` in production** — 3 stale token hashes from a feature removed
>   in `c818b9c`, which SQLite never dropped.
> - **Consider a migration for `users`/`resumes`.`apply_mode` defaults.** Inert today, but it proves
>   `CREATE TABLE IF NOT EXISTS` can never reconcile an existing database.

### ✅ PRODUCTION IS INTACT — measured 2026-09-05

**`scraped_jobs` in production holds 1399 rows, 1248 active.** The id-85 purge was **local only**.
Every "the board is gone" framing in this file and in `docs/am1-recovery.md` describes the DEV
database; the live board was never affected.

⚠ **The `ran_at` observation was a query typo, not schema drift — corrected 2026-09-06, and
CONFIRMED against production 2026-09-07.** Task T read production's own `sqlite_master`: both
databases have `id, run_at, jobs_deleted, orphans_cleaned, details`, and `ran_at` is in neither.

✅ **The full schema diff has now been RUN — see `docs/am3-board-restore-and-schema.md`.** Migration
sets are IDENTICAL (107 rows, high-water 100 both sides), which is the dual path's first real
measurement against a deployed database. Three differences exist and none is dual-path drift:
`import_extension_tokens` (prod only, 3 rows — residue of the extension token flow removed in
`c818b9c`, which SQLite never dropped), `provider_eval_jobs` (local only — a `providerEval` scratch
table), and `users`/`resumes`.`apply_mode` defaulting to `'TAILORED'` in prod vs `'SIMPLE'` locally.

⛔ **That last one exposes a real hole, just not the expected one.** Both code paths say `'SIMPLE'`
byte-identically; `'TAILORED'` was the original default and `b212ca6` changed it. Production's
tables predate that commit, and **`CREATE TABLE IF NOT EXISTS` is a no-op against an existing
table** — so the dual path governs what a NEW database gets and nothing reconciles a long-lived one.
Impact is inert (every insert that matters is explicit, and `publicUser()` coerces on read), but the
class of defect is not: editing a `CREATE TABLE` changes nothing already deployed.

### ✅ THE BOARD IS RESTORED — 2026-09-07, task S

**`scraped_jobs` holds 1296 rows / 1266 active.** `cleanup_log` id 85's 1288-row deletion is undone
locally: 1291 rows came back from the pinned evidence DB via `scripts/am3RestoreBoard.mjs`, and the
"1291 postings" figures throughout these docs are **true of the TABLE again**, not just the evidence.

The derived tables were RECONCILED rather than rebuilt, with a stated rule per table — 8580/8690
technographic rows join to a live posting, **1100/1100 org-unit citations resolve**, and every
`ats_term_weights` family is within 2–3 rows of its stored `corpus_size`. That last point is why ρ
still means something.

**ρ now reproduces from the TABLE, not only from the fixture:** 30/30 graded postings present,
30/30 descriptions byte-identical, 30/30 scores identical, **ρ = 0.737 from the board == 0.737 from
the fixture**. Task R proved the fixture reproduces ρ; this proves the fixture and the table agree.

⛔ **The rollups are still blocked and that is still correct.** `boardSufficiency.js` continues to
refuse `computeTermWeights`, `runHiringSignalsRollup` and `runOrgLayerRollup`. A refilled board is
not a decision to recompute — and the weights above are valid *because* nothing recomputed them.

⚠ **`scraped_at` was rebased to now on restore.** Every evidence row was older than the 7-day
expiry cutoff, so a verbatim restore would have been expired on arrival: the next startup pass would
have braked the mass delete and retired all 1291, leaving 5 active. Rebasing matches what the real
refill does (`services/jobs/aggregator.js:319` sets `scraped_at` on every re-sight, i.e. it means
LAST SEEN). `discovered_at`, `posted_at` and `is_active` are untouched, so provenance and board
ordering are intact. **The restored rows will all expire together 7 days from 2026-09-07.**

**What R changed (`docs/am1-recovery.md`):**

- **The evidence is pinned.** `data/evidence/resume_master_2026-08-31...db`, sha256
  `ad8b5c29…9ccffc`, outside anything `scripts/backup.js` can reach. It had **one backup left**
  before retention would have evicted it — computed from the real `selectRetained()`, not guessed.
- **ρ no longer depends on that file.** `docs/am1-ats-graded-corpus.json` is the 30 graded postings
  with full text, committed. `node scripts/am1GradedCorpusVerify.mjs` re-scores from it:
  **ρ = 0.737** against the published 0.746 (drift 0.009), byte-identical to what the 110 MB backup
  gives. Note the published figure is **0.746** and today's engine gives **0.737** — 26 of the 30
  individual scores moved, by up to 40 points, mostly the seniority guard landing after grading.
- **The deletion is braked.** `services/jobs/cleanupBrake.js` refuses to delete >50% of a board over
  50 rows and retires those rows instead. `CLEANUP_ALLOW_MASS_DELETE=1` overrides.
- **⛔ Every board-derived rollup now REFUSES.** `services/jobs/boardSufficiency.js` blocks
  `runHiringSignalsRollup`, `runOrgLayerRollup` and `computeTermWeights` below 200 active postings.
  This is deliberate and it means **the KB rollups are not running.** They stay blocked until the
  board is refilled. `ALLOW_THIN_BOARD_DERIVATION=1` overrides, and doing so would overwrite the
  8690/697/856 real rows with fixtures-derived ones.
- **AH4's reverted location fix** is confirmed fixed (landed in `ac25de2`) and the test that
  asserted the bug is re-pinned. The audit found no other test of that shape.

**⚠ The board refills on a CRON, so a process that is not running does not refill it.** An earlier
version of this line — and of `docs/am1-recovery.md` — said the 07:00 removal in §5.12 left
`force-scrape` as "the only path". **Production disproves that:** 1248 active rows on a board nobody
force-scrapes daily. The **04:00 `cacheJobs` / `cacheJoboFeed` cron** is the refill and survived
§5.12; only the dead `user_job_searches`-driven 07:00 crawl was removed.

The corrected statement is narrower and is the actual root cause of the purge: refill and deletion
are both tied to the process, so a continuously-deployed board stays full while a laptop's empties
between sessions. Locally, `force-scrape` or task S is what fills it, because the 04:00 cron only
fires while the server happens to be up.

---
### ⚠ Read this before picking up A, F or G

**`GROQ_API_KEY` AND `GOOGLE_API_KEY` ARE NOT IN THIS WORKING COPY** — not in `.env`, not in the
process environment. Verified 2026-09-04. The line below that said "Env now injected" was wrong
about the working copy.

⚠ **But `GROQ_API_KEY` IS live in Railway** (2026-09-05). Both statements are true and they are
about different environments, which is exactly why the local scripts' "missing key" refusal is
correct rather than a bug. Task A2 says how to bridge it: copy the value into local `.env`, or run
under `railway run`.

Task A's routing is built, guarded and tested (`docs/al1-provider-routing.md`, +33 tests), but it
**has never served a real token**. Still outstanding, and all of it needs the key:

- 50 rows through Groq, per-column agreement vs Haiku — `scripts/al1ProviderQualityDiff.mjs`
- the open question: is an 8B model good enough for `skills_json`? It feeds
  `company_technographics` and the ATS scorer, and the saving at stake is only ~$3.32 a pass.

**F and G both list A as a prerequisite.** A's *code* satisfies that; A's *quality verdict* does
not exist yet. G in particular generates assets FROM the free tier, so its output quality inherits
the unanswered question above.

---

## ⛔ TASK R — ✅ DONE 2026-09-05. DO NOT RE-RUN.

Landed as `docs/am1-recovery.md`. Every requirement is answered there with the measurement behind it:
the pinned backup and its checksum (R1.1), the committed 30-posting fixture (R1.2), rho reproduced
at 0.737 from that fixture and cross-checked against the backup (R1.3), cleanup_log id 85's trigger
and root cause (R2.4), the derived-table state table (R2.5), the two automatic re-derivations that
were stopped rather than merely reported (R2.6), AH4's reversion confirmed fixed and its test
re-pinned (R3.7-9), and the differential audit over 11 read surfaces (R3.10).

The original prompt is retained below for reference only.

### original prompt (SUPERSEDED)

```
CONTEXT
cleanup_log id 85 deleted 1288 postings. scraped_jobs now holds 5 fixtures. Every derived table
(company_technographics, company_org_units, LCA matches) still describes the old board, so every
"1291 postings" figure in these docs is true of the evidence and false of the table.

0 of the 30 human-graded postings survive. rho = 0.746, the seniority guard and every band cutpoint
were measured against a table that no longer exists.

The 2026-08-31 backup has the data. The 2026-09-02 snapshot is ALREADY POST-DELETION. When
retention rotates 08-31 out, rho = 0.746 becomes permanently unreproducible. THIS IS THE ONLY ITEM
IN THE PROJECT THAT GETS WORSE WHILE NOTHING HAPPENS.

R1 — PRESERVE THE EVIDENCE (do this first, before any analysis)
1. Copy the 2026-08-31 backup somewhere retention does not touch. Report the path and its checksum.
2. Export the 30 graded postings as a COMMITTED fixture — job_id, company, title, full description,
   plus the engine score and the human grade from docs/ak2-ats-grading-key.json and
   docs/ak2-ats-grading-set.md. A committed file survives any future purge; a backup does not.
   These 30 grades are the ONLY independent validation the ATS engine has, and they are worthless
   without the postings they refer to.
3. Re-run the band measurement against the restored data and confirm rho = 0.746 reproduces. If it
   does not, say so — that is a finding, not a failure to be smoothed.

R2 — UNDERSTAND HOW IT HAPPENED
4. Find what cleanup_log id 85 was and how it was invoked. A cleanup that removes 1288 of 1293 rows
   should not be reachable without an explicit confirmation. Report the trigger, whether it was
   intentional, and whether it can fire again.
5. Report the state of every derived table against the current 5-row board:
   company_technographics (was 8278 after G3), company_org_units (was 697), LCA matches, and the
   synonym proposals. Each now describes rows that do not exist. State which are recoverable by
   re-derivation and which depended on the deleted text.
6. Do NOT re-run enrichment or any derivation against 5 fixtures. That would overwrite real derived
   data with data derived from nothing — the same shape as the enrichment poisoning that cost 120
   rows. Report first.

R3 — THE SILENT REVERSION, and the test that certified it
7. AH4's location fix has silently reverted. Its vocabulary is read from scraped_jobs.location; the
   purge took that from 235 entries to 4, so looksLikeLocation("Bangalore") returns false again —
   the exact false finding AH4 removed, and the one §7 names as the costly error.
8. ⛔ THE SUITE STAYED GREEN BECAUSE A TEST ASSERTED THE BUG. failsafeLocationClaims.test.js asserts
   === false, commented "with no corpus there is nothing to know". That is the defect written down
   as a guarantee — Shape 5 in its most complete form. Re-pin it to assert BEHAVIOUR: a location
   must never be flagged as an unknown team, regardless of corpus state.
9. STRUCTURAL FIX: a vocabulary derived from live data is a dependency on that data existing. Seed
   a minimum location vocabulary that does not depend on the board — major cities, regions,
   countries, "Remote" — and let the corpus EXTEND it, never constitute it.
10. Audit for the same class: any other behaviour whose correctness depends on a table being
    populated, and any other test whose assertion holds only while data is absent.

VERIFY
Backup pinned with checksum. The 30 postings committed as a fixture. rho reproduced or its failure
reported. cleanup_log id 85's trigger identified. looksLikeLocation("Bangalore") returns true with
an empty board. The re-pinned test FAILS against the current reverted behaviour before the seed is
added — verify that, because a test that only passes is not evidence.
```

---

## TASK Q — ✅ DONE 2026-09-05. DO NOT RE-RUN.

Landed as `docs/am2-approval-cap.md`. `APPLY_DAILY_APPROVAL_CAP` (30) bounds the approvals that now
incur the model call; `APPLY_DAILY_QUEUE_CAP` (40) is kept and re-scoped to previews with its stale
spend rationale corrected; all three caps ride on the run payload and the approval screen, verified
in real Chrome across four states; `assertCapOrdering()` reports a configuration in which any cap is
unreachable. `APPLY_DAILY_CAP` (25) is untouched.

The original prompt is retained below for reference only.

### original prompt (SUPERSEDED)

```
Task D moved generation from queue time to approval. Correct change, but APPLY_DAILY_QUEUE_CAP
(40) was sized to bound GENERATION SPEND when queueing generated. It now bounds previews, which are
free. THE MEANINGFUL LIMIT MOVED TO APPROVALS, AND NOTHING BOUNDS APPROVALS.

Task D's requirement 4 asked for this to be reported rather than changed unilaterally. It was
reported. This task decides it.

1. Add a daily cap on APPROVALS — the point where a model call is now actually incurred.
2. Re-scope or remove APPLY_DAILY_QUEUE_CAP. A cap on a free action is friction with no benefit;
   if it stays, its message must stop saying "each queued application generates a resume", which is
   no longer true and is now a false statement to the user.
3. Both caps stay SURFACEABLE — the DailyCap/QueueCap schemas carry limit and remaining, and the
   client renders them. Do not let a cap fail as a silent drop.
4. APPLY_DAILY_CAP (25, submissions) is unaffected — confirm the three caps do not interact such
   that one makes another unreachable. The queue cap was originally set above the submission cap
   deliberately, because every submission needs a queue first.

VERIFY: exceeding the approval cap returns a clear error carrying remaining. Queueing past the old
queue cap does not block a user from work that costs nothing. Real runs.
```

---

## TASK A — ✅ CODE DONE, DO NOT RE-RUN

Landed 2026-09-04. See `docs/al1-provider-routing.md`. Routing in `callModel()` only with a
fail-closed CANDIDATE default across all 14 sites, explicit `$0` pricing, migration **096** recording
provider, loud fallbacks, a pinned model that throws rather than falling back, and 429 backoff with
the row confirmed retryable. +33 tests.

**Two findings from it that must not be lost:**

1. **The guard was structurally blind to the shape it most needed to catch.** Its comment stripper
   used `/\/\/.*$/`, and `https://api.groq.com/...` contains `//` — so every URL-shaped provider
   call was erased as a "comment" before the scan ran. With no Groq or Gemini SDK installed, an
   untracked call would be a bare `fetch`: exactly the invisible case. **A guard extended by reading
   it would have shipped inert and green.** Third instance of this defect class, after
   `.messages.create(` missing `messages.batches.create` and three dead source anchors in passing
   tests. The rule that caught it: verify by INJECTING a violation per shape.
2. **`purpose classifier` is not `classify_job`.** One word apart, adjacent in every cost report —
   and `services/classifier.js` sends **2000 chars of the candidate's résumé**. This doc's original
   task-A split named `classify_job` as free-tier eligible; routing by that name would have leaked
   résumés on the first pass. The fail-closed CANDIDATE default is what makes a misclassified site
   fail safe instead of leaking. **Never route by call-site name; route by payload.**

The original task A prompt is retained below for reference only — **it is not work to be done.**

---

## TASK S — ✅ DONE 2026-09-07. DO NOT RE-RUN.

Landed as `docs/am3-board-restore-and-schema.md` via `scripts/am3RestoreBoard.mjs`. Every
requirement is answered there with its measurement: 1291 rows restored to 1296/1266 active (1),
nine guard tables asserted unchanged INSIDE the transaction (2), all three derived tables
reconciled with a stated rule each and none rebuilt (3), 0 restored rows lacking enrichment so
nothing was re-run (4), and `looksLikeLocation("Bangalore")` true against both the restored corpus
AND an empty board (5). ρ = 0.737 from the board, identical to the fixture.

⚠ One thing the prompt did not anticipate: every evidence row was already past the 7-day expiry
cutoff, so a verbatim restore would have self-destructed on the next startup. `scraped_at` is
rebased; see the doc for why that is what the real refill does.

The original prompt is retained below for reference only.

### original prompt (SUPERSEDED)

```
CONTEXT
Production holds 1399 rows / 1248 active — measured 2026-09-05. The id-85 purge was LOCAL ONLY.
Local scraped_jobs still holds 5 fixtures, so development, the ATS engine, the derived tables and
any rho work are all running against nothing. Task R made the loss survivable and braked the
deletion; it deliberately did not refill the board.

Two sources, in order of preference:
 1. data/evidence/resume_master_2026-08-31...db — the pinned evidence DB from task R. Local,
    checksummed, and it is the exact board rho = 0.746 was measured against.
 2. A production export, if the evidence DB proves incomplete.

REQUIREMENTS
1. Restore scraped_jobs from the pinned evidence DB. Report rows restored and the active count.
2. ⛔ DO NOT restore over user tables. The purge hit scraped_jobs; users, domain_profiles,
   profile_base_resumes, apply_runs and usage_events are current and must not be rolled back to
   08-31. Restore the board table (and only what the board needs), not the database.
3. RECONCILE THE DERIVED TABLES against the restored board rather than re-deriving blindly:
   company_technographics (8690 rows), the 856 term weights, company_org_units (697). Report which
   still join to a live job_id and which are orphaned. An orphan is not automatically wrong — a
   company fact outlives a posting — so state the rule you applied per table.
4. ⛔ DO NOT re-run enrichment as part of this task. 1302 enrich_job events already exist for these
   rows; re-running would spend money to reproduce data that is being restored. If any restored row
   genuinely lacks enrichment, report the count and stop.
5. Confirm looksLikeLocation("Bangalore") returns true again once the corpus is back — and that it
   ALSO returns true with an empty board, which is task R's seeded-vocabulary fix. If the seed
   works, the corpus should be an improvement, not the thing holding it up.

VERIFY
Row counts before and after. rho reproduces at 0.746 against the restored board (task R proved it
reproduces from the committed fixture; this proves the board and the fixture agree). Derived-table
join report. No user table altered — diff the row counts of users, domain_profiles and apply_runs
before and after and confirm they are identical.
```

---

## TASK T — ✅ DONE 2026-09-07. DO NOT RE-RUN.

Landed as `docs/am3-board-restore-and-schema.md` via `scripts/am3ProdSchemaDiff.mjs` (read-only,
three authenticated GETs, no schema change applied or proposed).

⛔ **Requirement 1's answer is the important one: THE BRAKE IS NOT DEPLOYED.** Production does not
serve task Q's `approvalCap`, so it predates `abea2c9` — committed 49 seconds after the brake.
Redeploy.

Requirement 2: migration sets IDENTICAL (the dual path's first real measurement against a deployed
database). Three schema differences, all explained, none of them dual-path drift — but the
`apply_mode` default divergence exposes that `CREATE TABLE IF NOT EXISTS` can never update an
existing database, so the dual path only governs NEW ones. Requirement 3: high-water 100 both sides.

The original prompt is retained below for reference only.

### original prompt (SUPERSEDED)

```
⛔ THIS TASK'S SECOND PREMISE WAS WRONG AND IS CORRECTED BELOW. Requirement 1 stands on its own
evidence; requirement 2 originally read "THE SCHEMAS HAVE DIVERGED — production's cleanup_log has
no `ran_at` column". They have not been shown to diverge, and that column does not exist anywhere:

    SELECT ran_at FROM cleanup_log   ->  no such column: ran_at   ON THE LOCAL DATABASE TOO
    SELECT id, run_at FROM cleanup_log  ->  {"id":92,"run_at":1788577796}

The column is `run_at`. `grep -rn ran_at` finds the string only in this file. Migration
011_cleanup_log declares `run_at` byte-identically in scripts/migrations.js:230 and server.js:604,
so the dual path is intact as far as this table can show. A query that fails the same way against
both databases is evidence about the query.

The remaining work is a real schema comparison, which has NOT been run and is worth doing — the
original note was pointing at something worth checking, just not with that column. Do not open it
by assuming an answer.

1. CAN THE ID-85 CLEANUP REACH PRODUCTION? It removed 99.6% of a table locally. Find what invoked
   it, whether it is reachable from a deployed route or a cron, and what guards it. Task R braked
   the deletion (services/jobs/cleanupBrake.js, in main as of bd95d20) — CONFIRM THAT BRAKE IS ON
   THE CODE PATH THE RUNNING PRODUCTION PROCESS EXECUTES, not merely in the repo. Until it is
   deployed, production is protected by uptime rather than by a guard. A cleanup that can remove
   1248 live postings should not be one invocation away.
   Task R's finding to start from: the pass that fired was the STARTUP cleanup (app.listen ->
   setImmediate), not the 03:00 cron, and the refill is the 04:00 cacheJobs cron — so the rule
   empties a board in proportion to process downtime. Production stays full because it runs
   continuously, which means uptime IS the current control.
2. IS THERE ANY PROD/DEV SCHEMA DIVERGENCE AT ALL? Open question, not a stated finding. Compare the
   FULL schema — every table, not one column — and report the answer either way. "They match" is a
   perfectly good result and is worth writing down, because the dual-path guarantee has never been
   checked against a deployed database.
   ⛔ WHY IT IS WORTH CHECKING EVEN THOUGH THE TRIGGERING OBSERVATION WAS BAD. Migrations are
   DUAL-PATH and byte-identical in scripts/migrations.js and the server.js MIGRATIONS array
   precisely so the two can never drift, and nothing verifies that against production. If a
   difference exists it means either that guarantee has a hole or a table was created outside the
   migration system. If none exists, the guarantee has its first real measurement.
3. Report production's applied migration high-water against local (local reads 100 from
   schema_migrations). Do this FIRST — it is one query and it bounds requirement 2: equal
   high-waters make a divergence much less likely and tell you what to expect from the diff.

VERIFY: the trigger named and its production reachability stated, including whether the brake is
deployed. A full prod-vs-dev schema diff with its result stated either way. The migration
high-water for both. No schema change applied in this task — report first.
```

---

## TASK A2 — ✅ DONE 2026-09-07. DO NOT RE-RUN.

Landed as `docs/am3-provider-verdict.md`. **VERDICT: KEEP ENRICHMENT ON HAIKU.**

Both stated prerequisites were already satisfied (board restored by task S; key present in `.env` —
this file was wrong about that). A2 was blocked by a third thing nobody had checked: the pinned
model `llama-3.1-8b-instant` **404s and no Llama model exists on Groq any more**. Re-pinned to
`openai/gpt-oss-20b` and measured for real:

- **`skillsHard` Jaccard 30.5%**, `skillsSoft` 17.4%. Columns that carry a value agree 57–84%; the
  100% columns agree only because neither model extracted anything on any row.
- **8000 tokens/minute** is the binding rate limit, not 30 req/min — ~2 enrichment calls a minute,
  so a 1291-row pass is ~9.7 hours and breaches the 1000/day request cap first.
- At the pipeline's `max_tokens: 500` this reasoning model returns HTTP 200, `success: true`, and a
  **null extraction 49 times out of 50** — silently. Requirement 3 (provider + $0 recorded, cost
  queries reconcile) is fully confirmed; requirement 4 is confirmed for the transport and remains
  stub-only for the row.

The original prompt is retained below for reference only.

### original prompt (SUPERSEDED)

```
TWO PREREQUISITES, BOTH REAL:
 a. THE KEY. GROQ_API_KEY is live in the RAILWAY environment but is NOT in local .env, which is why
    local scripts correctly report it missing. Either copy the value from the Railway dashboard
    into resume-master/.env (gitignored — verified), or run via `railway run` to inject the
    deployed environment. Local .env is simpler; the script reads process.env either way.
 b. TASK S. The quality diff needs ~50 REAL postings to compare extraction across. Local
    scraped_jobs holds 5 fixtures. Restore the board first or the diff has nothing to run on.

This is requirement 8 and the VERIFY block of task A. Task A's routing is built, guarded and tested
(docs/al1-provider-routing.md, +33 tests) but HAS NEVER SERVED A REAL TOKEN — everything in it is
verified against fetch stubs, so none of it is evidence about Groq's actual extraction quality.

THEN
1. Run scripts/al1ProviderQualityDiff.mjs — 50 rows through both providers, per-column agreement.
   It REFUSES to run unconfigured rather than comparing Haiku to Haiku and reporting 100%
   agreement. That refusal is deliberate; do not work around it.
2. THE QUESTION: is an 8B model good enough for skills_json? It feeds company_technographics AND
   the ATS scorer. The saving at stake is ~$3.32 a pass.
   ⛔ IF AGREEMENT IS MATERIALLY WORSE, SAY SO AND KEEP ENRICHMENT ON HAIKU. Task A then stands as
   infrastructure for later rather than a live switch. Degrading the input to the ATS engine to
   save three dollars is a bad trade, and reporting that is the correct outcome, not a failure.
3. Confirm usage_events records provider and $0 cost on real calls, and that the cost queries still
   reconcile.
4. Confirm a real 429 leaves the row retryable (content_hash/enriched_at unset). Verified against a
   stub; never against Groq's actual rate limiter.

VERIFY: per-column agreement table, a stated verdict on the default, reconciled cost queries.
```

```
This is requirement 8 and the VERIFY block of task A, which could not run: GROQ_API_KEY and
GOOGLE_API_KEY are in neither .env nor the environment. The routing has never served a real token.
Everything in A is verified against fetch stubs, so none of it is evidence about Groq's actual
extraction quality.

OWNER ACTION FIRST: set GROQ_API_KEY (and optionally GOOGLE_API_KEY), plus
ENRICH_PROVIDER=groq and a pinned ENRICH_MODEL=llama-3.1-8b-instant.

THEN
1. Run scripts/al1ProviderQualityDiff.mjs — 50 rows through both providers, per-column agreement.
   It REFUSES to run unconfigured rather than comparing Haiku to Haiku and reporting 100% agreement.
   That refusal is deliberate; do not work around it.
2. THE QUESTION: is an 8B model good enough for skills_json? It feeds company_technographics (8507
   rows) AND the ATS scorer. The saving at stake is ~$3.32 a pass.
   ⛔ IF AGREEMENT IS MATERIALLY WORSE, SAY SO AND KEEP ENRICHMENT ON HAIKU. Task A then stands as
   infrastructure for later rather than a live switch. Degrading the input to the ATS engine to save
   three dollars is a bad trade and reporting that honestly is the correct outcome.
3. Confirm usage_events records provider and $0 cost on real calls. The cost queries currently
   reconcile to $3.3284 over 1303 Haiku calls — they must still reconcile afterwards.
4. Confirm a real 429 leaves the row retryable (content_hash/enriched_at unset). Verified against a
   stub; not against Groq's actual rate limiter.

VERIFY: per-column agreement table, a stated verdict on the default, reconciled cost queries.
```

---

## TASK I — Harness runner prerequisite (small)

```
AL1 lost 30 minutes to a zero-output verify:harness run before discovering the suite needs the app
running separately on :3001. Nothing says so.

1. Document the prerequisite where the runner is invoked — scripts/verifyHarnesses.mjs and the npm
   script — and make the runner FAIL FAST with a clear message when :3001 is not answering, rather
   than producing 30 minutes of nothing. A silent zero-output run is Shape 3.
2. Note in the same place that no harness in that suite exercises the model-call path: the ones that
   do are excluded because they spend tokens. So a green verify:harness is NOT evidence about
   provider routing, and a future session should not read it as such.
```

---

## TASK A — original prompt (SUPERSEDED, reference only)

```
OBJECTIVE
Route the call sites that operate on PUBLIC data to a free-tier provider, keeping every call site
that touches candidate data on Anthropic. Wire it now so it can be tested on real traffic.

THE SPLIT — route by WHOSE DATA IT IS, not by what a filter finds in the string. This rule is
checkable by a test; "did the regex catch every email" is not.

  FREE-TIER ELIGIBLE — public data companies published about themselves:
    enrich_job          60.2% of all spend ($3.32 over 1302 calls)
    classify_job        high volume, tiny payloads
    import_job          LLM extraction of an open-web JD

  ANTHROPIC ONLY — carries candidate PII (home address, phone, work authorisation, employment
  history). Do NOT route these, and do not attempt redaction as part of this task:
    resume_generate · enhanceProfileResume (A+) · parse-pdf · cover letters ·
    domainProfiles suggestions

ENV — read from env only, never hardcoded, following the JOBO_API_KEY precedent:
    GROQ_API_KEY            gsk_...
    GOOGLE_API_KEY          (failover, optional at first)
    ENRICH_PROVIDER         groq | google | anthropic   (default anthropic)
    ENRICH_MODEL            pinned model id, e.g. llama-3.1-8b-instant

REQUIREMENTS
1. Routing lives in callModel() and NOWHERE ELSE. It is already the single wrapper all 14 call
   sites pass through; do not add a second path. Each site declares its data class
   (PUBLIC | CANDIDATE) and the router honours it.
2. ⛔ WIDEN THE GUARD FIRST, BEFORE ADDING A PROVIDER. test/modelCallGuard.test.js scans for
   /\.messages\.create\s*\(/ — that already failed to match messages.batches.create (AK2 caught it;
   adding batching would have created untracked spend with the suite green). A Groq or Gemini SDK
   uses an entirely different call shape and would bypass the cost-tracking guarantee completely.
   The guard must catch ANY provider call outside the wrapper. Verify by INJECTING a violation for
   each provider shape and confirming it fails — a guard never seen to fail is not evidence.
3. PRICING. calculateCost throws on an unknown model key. Add explicit $0 entries for free-tier
   models rather than an exception or a silent skip, or usage_events stops reconciling. Keep the
   loud warning on genuinely unknown keys.
4. usage_events must record provider AND model. All 14 sites stay tracked. A cost report that
   silently omits a third of traffic is the exact defect the tracking work fixed.
5. UNCONFIGURED MUST BE LOUD. If ENRICH_PROVIDER=groq and GROQ_API_KEY is absent, warn and fall
   back to Anthropic explicitly — never a silent skip. cacheJoboFeed logged "sync complete —
   0 jobs cached" for months on exactly this shape.
6. PIN THE MODEL ID. Catalogs churn: one provider deleted most of its free models on a single day
   and code calling the exact model went dark. An unavailable model is a LOUD failure, never a
   quiet fallback to nothing.
7. Rate limits are the constraint, not price — Groq is 30 req/min, 14,400 req/day. Enrichment's
   1302-call pass fits, but the background pass must handle 429 by backing off, not by marking rows
   enriched. enrichJob's failure path already leaves content_hash/enriched_at unset so rows retry —
   confirm a 429 takes that path and does not stamp.
8. Quality is not assumed. Run enrichment over ~50 rows on BOTH providers and diff the extracted
   fields. An 8B model may extract worse than Haiku; report per-column agreement before switching
   the default. If it is materially worse, say so — the saving is ~$3 and is not worth degrading
   skills_json, which feeds company_technographics and the ATS scorer.

VERIFY (real runs)
50 rows through Groq: usage_events rows present with provider and $0 cost, per-column agreement vs
Haiku reported. Guard fails on an injected Groq call outside the wrapper. Missing key warns and
falls back. A 429 leaves the row retryable. Commit & push.
```

## TASK B — ✅ DONE, DO NOT RE-RUN

Landed before 2026-09-04. `shared/atsBands.js` — all four bands, the seniority guard
(**ρ 0.643 → 0.746**, mis-ordered 16.1% → 12.2%), the thin-resume state, and the auto-submit gate
left decoupled at 30. 12 tests. Write-up: `docs/ak2-ats-bands.md`.

The original prompt is retained below for reference only — **it is not work to be done.**

---

## TASK B — original prompt (SUPERSEDED, reference only)

Graded sheet is filled in. `docs/ak2-ats-grading-set.md` joined against
`docs/ak2-ats-grading-key.json`:

**ρ = 0.643 · τ = 0.444 · 16.1% of pairs mis-ordered** (n=30, human-graded). Better than AK1's
self-graded ρ = 0.504 / 31.6%, which matters because AK1's grader was a model reading the same text
the engine reads.

```
⛔ DO NOT re-tune the engine. AK1 built and measured the obvious floor fix (renormalising over
informative components): rho 0.448 -> 0.242, mis-ordered 33.6% -> 41.0%, floating a Fraud Strategist
above a backend engineering role. Recorded in code with its numbers and pinned by a test.

THE WORST INVERSION, and it costs 0.09 of rho by itself:
  #12 Figma "Software Engineer Intern (Winter 2027)" — human 2, engine 60 (2nd highest of 30).
  Dropping it alone moves rho 0.643 -> 0.732.
  Cause: an intern JD states no years requirement, which pays a FLAT 85% experience credit (AK1's
  ~26 floor), and the JD is dense with engineering vocabulary. The engine cannot see seniority
  mismatch DOWNWARD.

REQUIREMENTS
1. SENIORITY GUARD. Cap intern / new-grad / early-career postings scored against a profile whose
   years_of_experience materially exceeds the role's implied level, regardless of term overlap.
   Measure rho before and after. Do NOT touch the reverted renormalisation.
2. BANDS: Strong / Moderate / Weak / Not enough signal. The fourth is REQUIRED — the scorer declines
   rather than fabricating (false-match 22.8% -> 0.8%) and that must surface as its own state, never
   as a low score. It holds 1 posting in 1291, so it CANNOT be calibrated from board data; it is a
   correctness state, not a population to balance.
3. SET STRONG FOR PRECISION. Jobs the owner graded 5 span engine scores 21-64 — the engine orders
   coarsely and does NOT separate excellent from mediocre. A Strong band admitting #12 is worse than
   a smaller one. Report what fraction of the graded 5s fall outside Strong and accept that cost
   explicitly rather than widening to capture them.
4. THIN-RESUME CASE. A band is a fixed number; the score is not. Profile 6's cutpoints applied to
   profile 5 give 0.2% Strong / 97.6% Weak. Profile 5 is a placeholder rather than a real second
   user, so the obvious reading overstates it — but a new user whose first upload is thin gets an
   all-Weak board. Decide and state: profile-relative cutpoints, a floor, or a distinct "your resume
   needs more detail" state.
5. ML/AI IS A PROFILE QUESTION, NOT A SCORING ONE. Dropping the ML rows moves rho by 0.007. Do not
   adjust for it. Note that ML/AI postings should score against the Data Science domain_profile,
   which already exists.
6. Every surface: ATS report panel, job cards, review screen, and anything the mobile contract
   exposes. If the numeric score stays in the API, mark it internal in the contract.
7. The auto-submit gate keeps using the NUMBER (threshold 30, recalibrated from 50 in AK1). Bands
   are display only; do not couple the gate to a band.

VERIFY: band populations across 1291 postings. rho before/after the seniority guard. Human-vs-engine
disagreements reported. "Not enough signal" renders distinctly from "Weak". Screenshot each surface.
```

## TASK C — ✅ DONE, DO NOT RE-RUN

All four steps landed and verified on a real emulator: toolchain, auth via
`GET /api/auth/mobile-token`, the contract-typed API layer including `automationTier`, and Room
persistence. 40 JVM + 13 instrumented tests. Write-up: `docs/aj2-android-phase2a.md`.

**Carried forward from it — not done, and now user data exists on device:**
`android:allowBackup="true"` with empty `backup_rules.xml` and `data_extraction_rules.xml` (both
still untouched Studio templates). The auth token AND the persisted résumé are swept into Google
cloud backup by default. **Write the excludes.** This was flagged as "before the first token exists"
— the token now exists.

Still open and owner's: **the Android admin panel.** Six screens of fabricated data, ungated, with
Delete / Suspend / Impersonate controls that hit nothing. Recommendation: build flavour, not
deletion, and never in a Play build. Asked five times.

The original prompt is at `resume-master-android/PHASE_2A.md` — reference only.

---

## TASK C — original summary (SUPERSEDED, reference only)

Full prompt: **`resume-master-android/PHASE_2A.md`** (self-contained, in that repo).

Android Studio is now installed, so "the build has never been verified" is finally closable.

```
FIRST STEP, likely the whole blocker: strip the BOM from gradle/libs.versions.toml. A conforming
TOML parser demonstrably REJECTS it and parses cleanly once stripped.
SECOND: gradle.properties hardcodes org.gradle.java.home=C:\Program Files\Android\Android Studio\jbr
— if Studio installed elsewhere, that line breaks the build. Remove it; resolve JDK 17 from the
toolchain.
THIRD: compileSdk = 35 with agp 9.0.1. AGP 9 requires compileSdk 36+.
android.suppressUnsupportedCompileSdk=35 suppresses the warning, not the minimum.

Then: auth via GET /api/auth/mobile-token (NOT the login response's authContext — that one is
session-bound and persisting it causes intermittent untraceable sign-outs), then the contract-typed
API layer including automationTier, then resume persistence. NO FEED.
```

Still open and owner's: **the admin panel** — 6 screens of fabricated data, ungated because no auth
exists to gate against, with Delete / Suspend / Impersonate controls that look functional and hit
nothing. Recommendation: build flavour, not deletion, and never in a Play build.

## TASK D — Generation deferral + free ATS at swipe

Unblocked once B sets the bands. Prompt unchanged from `docs/QUEUED_PROMPTS.md` — move the
generation trigger from queue to approve, show the free base-resume BAND on the swipe card, keep a
per-profile "generate at queue" toggle default-OFF for testing.

## TASK E — Cache breakpoints + Batch API

Full findings: `docs/ak2-cache-batching-assessment.md`.

```
1. REMOVE THE UNREAD CACHE BREAKPOINTS. The generation prefix is written at 1.25x and read at 0.1x
   — written every time, read never. A 25% surcharge buying nothing. Unconditional -8.1%, available
   with no batching. Verify before/after against real usage_events, reconciled.
2. BATCH enrich_job via the Batch API — IF it is still on Anthropic after task A. If task A moved it
   to Groq, this requirement is moot and should be reported as such rather than done.
3. -37% and -68% are ASYMPTOTES. Ten generations in one 5-minute window is -33.4%; two is -18.5%.
   resume_generate has run ONCE in 1367 events, so the projection rests on one row.
4. NOT ON THE APPLY PATH. Semi and auto both hold a live browser open blocking on the resume at the
   upload step, against a 24-hour batch SLA. Batching wins by making CASE A (current artifact, no
   model call) normal — which is what task D does. Hence E behind D.
5. Verify pricing LIVE, not from memory. A cached table dated 2026-06-24 claimed a Sonnet 5 rise
   landing 2026-09-01; live docs say it will not occur and shared/anthropicModels.js was already
   correct.
```

## TASK F — PII tokenization ⏸ deferred, deliberately

The design is sound and is recorded here so it is not re-derived from scratch:

> Substitute employers, teams and identifying fields against the in-house KB before the payload
> leaves, generate against tokens, substitute back on return. A **whitelist-constructed payload**,
> not a filtered one — a whitelist fails closed, a blacklist fails silently. Stable work history is
> what makes deterministic tokenization possible: same employer, same token, every time, so the
> model still sees coherent structure.

**Three things it must include when built:**

1. **Some fields are excluded, not tokenized.** Work authorisation, sponsorship status, visa type
   and EEO answers must not leave in any form — a token still carries the value, and immigration
   status is a special category. After AF2 the years figure comes from the profile, so generation
   does not need them. Same for `linkedin_url` and `github_url`, which a "name, email, phone" mental
   model misses.
2. **The reversal step is where the risk moves.** Two failure modes, both assertions rather than
   hopes: every token sent must come back (the model may rephrase around it), and no token outside
   the sent set may appear (hallucinated `COMPANY_C`).
3. **The guard is a field-level whitelist assertion on the outbound payload**, in `callModel()`,
   refusing to send anything not on the list for that provider tier.

**Why deferred:** `resume_generate` has run **once in 1367 events**. This subsystem — mapping layer,
KB substitution, reversal, whitelist guard, round-trip tests — currently protects about four cents.
Build it when generation volume justifies it; AF5 will show what that volume is.

---

## ⚠ The section ABOVE is superseded

The "⏸ deferred" block immediately above is **superseded by the live TASK F below**. The owner chose
to wire tokenization now rather than at volume. Its three original requirements — whitelist-not-
filter, excluded-not-tokenized fields, and the round-trip assertions — are carried into the live task
verbatim. Ignore the deferred block; run the one below.

---

## TASK F — PII tokenization layer

```
OBJECTIVE
Allow generation-class calls to use a non-Anthropic provider by constructing a payload that carries
no candidate PII, generating against tokens, and substituting back on return.

OWNER DECISION: wire this NOW rather than at volume, because testing the round trip is easier before
real traffic than after. Recorded honestly: resume_generate has run ONCE in 1367 events, so this
currently protects about four cents. It is being built for testability, not for savings.

⛔ A WHITELIST-CONSTRUCTED PAYLOAD, NOT A FILTERED ONE. Build the outbound payload from an explicit
field allow-list. Never take a full payload and strip PII out of it. A whitelist fails CLOSED; a
blacklist fails SILENTLY, and a regex that misses one email in one resume leaks a real person's data
to a training corpus with no error and no way to know. That is Shape 3 in the worst possible place,
and this codebase has produced that shape six times.

WHY TOKENIZATION WORKS HERE
Work history is stable, so tokenization can be deterministic: same employer, same token, every time.
The model still sees coherent structure (COMPANY_A, TEAM_1, 18 months) and can tailor against it.

REQUIREMENTS
1. TOKENIZE against the in-house KB: employers, teams, institutions. Deterministic mapping, stored
   per generation so the reversal is exact.
2. ⛔ SOME FIELDS ARE EXCLUDED, NOT TOKENIZED. These must not leave in ANY form, because a token
   still carries the value:
     work_auth · requires_sponsorship · visa_type · has_clearance · clearance_level ·
     gender · ethnicity · veteran_status · disability_status · linkedin_url · github_url ·
     address_line1/2 · zip · phone · email
   Immigration status is a special category in most frameworks. After AF2 the years figure comes
   from the PROFILE, not the JD, so generation does not need the eligibility fields at all — verify
   that and report it. linkedin_url and github_url are directly identifying and are exactly what a
   "name, email, phone" mental model misses.
3. THE REVERSAL STEP IS WHERE THE RISK MOVES. Two failure modes, both ASSERTIONS not hopes:
     a. every token sent must come back — the model may rephrase around one and drop it
     b. no token outside the sent set may appear — a hallucinated COMPANY_C must fail loudly
   A generation failing either check does not persist. This is the testable property that makes the
   design compliance-defensible rather than compliance-shaped.
4. THE GUARD IS A FIELD-LEVEL WHITELIST ASSERTION ON THE OUTBOUND PAYLOAD, enforced in callModel()
   for any provider tier that is not Anthropic. It refuses to send anything not on the list. Verify
   by INJECTING an excluded field and confirming the send is refused — a guard never seen to fail is
   not evidence.
5. A+ / enhanceProfileResume STAYS ON CLAUDE, untokenized, per the owner. It is the experimental
   path and its prompt changes; do not route it.
6. AF2's hard assertion — generated output may not claim more experience than the profile states —
   must still run on the tokenized path. Confirm it inspects something rather than vacuously
   passing on a payload whose shape changed.

VERIFY (real runs)
Generate through the tokenized path and diff the output against an untokenized Claude generation of
the same job: content equivalent, no token leaked into the final artifact. Injected excluded field is
refused. A dropped token fails the round trip. A hallucinated token fails. Commit & push.
```

---

## TASK G — Offline asset generation

```
THE PRINCIPLE — read this before anything else in the task
Use the free-tier LLM OFFLINE to build DETERMINISTIC ASSETS. Never at query time.

Everything valuable in this codebase that is deterministic is deterministic FOR A REASON: the ATS
scorer must be free and instant to power a swipe card; buildAnswers must never be model-generated
because those answers are attestations to an employer; the KB must never learn from claims. A model
call at query time breaks those properties. A model call OFFLINE, producing a reviewed table that
the deterministic code then consumes, fixes their known weaknesses while preserving every guarantee.

That pattern also fits free tiers exactly: batch, background, no latency budget, PUBLIC DATA ONLY.
Every output below is derived from job postings companies published about themselves. No candidate
data is sent in this task at all.

DEPENDS ON TASK A. Routing, the widened modelCallGuard, and $0 pricing entries must be live first.

─── G1 — SKILL SYNONYM TABLE (highest value; attacks a MEASURED ceiling) ───

AK1 named this precisely: the worst ATS inversion was -19 ranks, a reliability role whose JD said
"log analysis" where the resume said "observability tooling", and it called this "a ceiling on the
approach, not a bug". This is the ONLY item on the horizon that moves rho = 0.643 upward rather
than sideways.

1. Offline pass over the ~1291 active postings' JD text extracting SKILL EQUIVALENCES:
   log analysis ~ observability · K8s = Kubernetes · Postgres = PostgreSQL · JS = JavaScript.
2. Store with CONFIDENCE and PROVENANCE, like every other KB fact — which postings supported it,
   how many, when last seen. Follow services/kb/orgLayer.js's pattern; do not invent a second one.
3. ⛔ A FALSE EQUIVALENCE IS A CONFIDENTLY WRONG MATCH — the failure mode that costs the most
   trust, and the same class as the "coffee machine vendor" credited with machine learning (22.8%
   of all multi-word matches before AK1's proximity fix). Nothing above a threshold goes live
   without a HUMAN REVIEW PASS. Present the proposed table for review; do not auto-promote.
4. REUSE searchQueryBuilder's existing normalisation as the base vocabulary. Do NOT write a third.
   Do NOT wire buildApifyQueriesFromProfile into anything — it is scraping-era and off-limits.
5. MEASURE THE EFFECT. Re-run the 30-posting graded set with the synonym table active and report
   rho before and after. If rho does not move, the table is not earning its keep — say so.
6. The scorer stays deterministic, instant and free at query time. Confirm no model call enters the
   scoring path: test/localAtsScorer.test.js already asserts the scrape block contains no
   messages.create — that assertion must still hold.

─── G2 — LCA COMPANY-NAME RESOLUTION ───

Company matching landed at 75%. The unmatched 25% are legal-entity vs brand mismatches —
"META PLATFORMS, INC." vs "Meta", subsidiaries, DBAs, multiple entities per brand. An LLM resolves
these well and it is public company data.

This matters because the sponsorship differentiator has NO posting-level signal at all: 0 of 1261
postings mention "H-1B" and only 36 mention sponsorship in any form. Company-level LCA evidence is
the entire signal.

1. Resolve the unmatched employer names against your company list. Report the new match rate.
2. ⛔ EVERY RESOLUTION CARRIES A CONFIDENCE, and a low-confidence match is NOT presented as fact.
   Telling a candidate Company A sponsors when the LCA belongs to a similarly-named Company B is a
   false attestation about a third party. State the threshold and the rule.
3. The integrity line is unchanged: "this company filed 47 H-1B petitions in 2025" is evidence
   about the EMPLOYER, never a promise about this role. The posting-level is_h1b_sponsor soft-null
   rule survives untouched — two different facts, two different columns.

─── G3 — TECHNOGRAPHIC CANONICALISATION ───

company_technographics holds 8507 rows built from skills_json. If variants are not collapsed,
"Postgres" and "PostgreSQL" are two entries and every company's stack view is diluted — which is
what FE-4's STACK block and FE-6's recruiter reference render.

1. Apply G1's synonym table. Build once, use twice — do not generate a second vocabulary.
2. Report the row-count delta and the top-20 stack for three companies before and after.
3. This CHANGES a KB surface, so confirm confidence and provenance survive the merge: a canonical
   term's confidence must reflect its merged evidence, not the highest of its variants.

─── G4 — ORG-UNIT EXTRACTION (9.5), with a live false positive to fix ───

services/kb/orgLayer.js proposes org units from postings by deterministic parsing. An LLM extracts
team names better, and this is public data companies emit about themselves — so the §7 rule "never
learn from claims" is satisfied and free-tier routing is appropriate.

A LIVE FALSE POSITIVE, observed in the failsafe strip:
  FLAG: 'Bangalore' doesn't match any team we've seen in Stripe's job postings
         (closest: 'Solutions Architecture')
"Stripe | Payments Infrastructure, Bangalore" — Bangalore is the LOCATION. A location was parsed as
an org unit, then flagged against company_org_units. §7 names this as the costly error: "a false
'this doesn't match' is the costly error." It is a false flag against a TRUE claim.

1. Improve extraction from the "Company | Team, Location" pattern. Exclude locations BEFORE
   matching — scraped_jobs.location and the enrichment's workplace_type already give a location
   vocabulary. Reuse it; do not write a third.
2. Audit for the same class: any other field matched against the wrong KB dimension.
3. ⛔ The 9.5 integrity rule is unchanged and must be re-asserted: NO code path may write org units
   from resume or profile tables. Grep-prove it, as the original audit did (0 of 697 org units is a
   location — re-verify after the change).
4. Keep the proposed/confirmed distinction and the promotion thresholds (3 postings, 0.6
   confidence). An LLM proposing a unit does not promote it; corroboration does.
5. A near-match must be PLAUSIBLE before it is offered. Suggesting "Solutions Architecture" as the
   closest thing to "Bangalore" reveals the similarity threshold is too low, and a suggestion no
   human would make damages trust in every other finding.

VERIFY: the same resume produces no Bangalore flag. A genuinely wrong team name still flags. Org
units extracted from 20 postings, reviewed for plausibility. Grep-proof of rule 3.

─── EXPLICITLY OUT OF SCOPE ───

⛔ The apply answer resolver (buildAnswers) itself. Deterministic by contract — Jobo's integration
  terms say "No AI-generated answers" and §7 says the same. Its weakness is fuzzy label matching and
  the fix is a better TABLE, which is TASK H — not a model at fill time.
⛔ The 9.6 failsafe. It IS the integrity check. A model judging whether a claim contradicts the KB
  introduces exactly the fabrication risk the failsafe exists to prevent.
⛔ Anything touching candidate data. Task A's split governs: route by WHOSE DATA IT IS.

VERIFY
rho before/after on the graded 30 with G1 active. New LCA match rate with the confidence
distribution. Technographic row delta plus three before/after stack views. Grep-prove no model call
entered the ATS scoring path. Every table carries confidence and provenance. Commit per sub-task.
```

---

## TASK H — Form label → field mapping

```
OBJECTIVE
PLATFORM_LABEL_MAPS in services/platformDetector.js is hand-written for greenhouse, lever and
workday, with every other platform falling through to `generic`. G4's schema capture collects real
form structures from live ATS pages. Generate the label→field mapping offline from those captured
schemas instead of hand-authoring it.

⛔ THIS TASK PRODUCES A TABLE. IT DOES NOT PUT A MODEL IN THE FILL PATH.
buildAnswers stays deterministic — Jobo's integration terms say "No AI-generated answers" and §7
says the same. The output of this task is a reviewed mapping that deterministic code consumes. If
any part of the implementation results in a model call during a fill, the design is wrong.

⛔ THE HARD BOUNDARY: NO ELIGIBILITY FIELD MAY BE MAPPED BY THIS TABLE.
Work authorisation, sponsorship, clearance, visa, criminal history, EEO, years of experience.
Those resolve by exact handler mapping or not at all. Two precedents, both live defects:
  · login_email labelled "Email" resolved to the email handler and typed the candidate's home
    address into a portal's SIGN-IN box at 0.9 confidence. The legacy sweep also wrote to the
    PASSWORD field, because its type-exclusion list never included password.
  · The sponsorship-inversion trap: a work_authorization key substring-matched "do you now or in
    the future require sponsorship for work authorization" — a semantically INVERTED question, and
    a materially false attestation to an employer.
Label matching getting clever near attestations is how both happened. Assert the exclusion with a
test, not a comment.

REQUIREMENTS
1. Input is G4's captured company_form_schemas plus the existing PLATFORM_LABEL_MAPS. Public form
   STRUCTURE only — labels, types, required flags, option lists. Never a candidate's entered values.
2. Output is a stored mapping with confidence and provenance, following orgLayer.js's pattern.
   Low-confidence mappings stay proposed; they do not reach the resolver.
3. HUMAN REVIEW BEFORE ANY MAPPING GOES LIVE. A wrong mapping fills the wrong answer into a real
   employer's form, which cannot be recalled.
4. Preserve the resolver's existing provenance tiers. A table-derived mapping resolves at
   'field_map_exact', never at 'label_fuzzy' — and the A2 rule stands: a label_fuzzy answer is not
   auto-submitted in mode:'full'.
5. Report how many `generic`-platform fields the table newly resolves, and how many remain
   unresolvable. An unresolvable required field is VALUABLE information — it tells the user in
   advance that the run will hold. Surface it at queue time, not at submit.

VERIFY (real runs, fakeAts only)
Re-run the A1 trap matrix in full. Every trap must still PASS or HOLD — sponsorship_inversion,
name_ambiguity and lowercase_yes especially. Assert no eligibility field appears in the generated
table. Confirm the resolver makes no model call during a fill. Report newly-resolved field counts.
Commit & push.
```

---

## Owner-only, alongside

**AF5 semi campaign** — 10 runs per ATS, credit now available. Also the ground truth for whether
ρ = 0.643 predicts anything; the score-at-application field exists (migration 095).
**Extension submission** — blocked on `CWS_*` credentials only.
**Android admin panel decision.**

## Provider notes for task A

- **Groq** — 30 req/min, 14,400 req/day on `llama-3.1-8b-instant`, highest daily allowance,
  fully OpenAI-compatible so it is a base-URL swap.
- **Gemini Flash** — free, no card, 1M context. Best failover.
- **SambaNova** — 200,000 tokens/day, quota is per model rather than shared.
- **Skip Cohere** — 1,000 calls/month, **non-commercial use only**.
- ⚠ **Free tiers are generally funded by your prompts.** Confirm Groq's current data policy in their
  terms directly — the comparison articles say Groq "does not state either way on a public page."
  If they do train on free-tier data, the public-JD-only rule is what keeps this clean.
