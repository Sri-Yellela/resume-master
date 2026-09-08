# AM4 / Task U — enrichment control, export/import, and batch provenance

**Done 2026-09-08.** Baseline **2301** passing, 0 failing (was 2245; +56 new). Migration high-water
**101**, byte-identical in both paths. `mapJobRow` untouched — the board response is unchanged.

---

## ⛔ The task's central premise was wrong, and measuring it first is what caught it

Task U opens with the owner's reason, and it shapes everything: *"most of those 837 are STALE. …the
first requirement is not 'enrich them better' — it is 'do not enrich the ones that do not matter.'"*

**Measured against production, 2026-09-08 (`scripts/am4EnrichBacklogAudit.mjs --prod`, read-only):
none of the 837 are stale.**

```
never-enriched rows by discovered_at (WHEN THE ROW FIRST ARRIVED)
  0-1d        6      1-3d      6      3-7d     16
  14-30d    420     30-60d   389
  TOTAL     837   -> 809 of 837 (96.7%) are 14-60 days old

the SAME 837 rows by scraped_at (WHEN THE POSTING WAS LAST SEEN)
  0-1d      832      1-3d      5
  TOTAL     837   -> 837 of 837 (100%) were last seen within THREE DAYS
```

Both columns describe the same rows and they disagree completely. Only one of them is what "stale"
means. `services/jobs/aggregator.js:319` re-stamps `scraped_at` on **every re-sight**, so a posting
with a 40-day-old `discovered_at` and a 3-hour-old `scraped_at` is not a dead posting — it is a
posting the employer has kept open for a month and the crawler saw this morning.

**A `discovered_at` age gate — the obvious reading of requirement U1.2 — would have refused 809 live
postings as stale.** It would also have looked like it was working.

So the recommendation inverts: the backlog **is** worth enriching, and the honest cost is
**~$3.07 ceiling** for all 837 on Haiku list price. `valid_through` is NULL on all 837, so it is no
help; 416 of 837 also have a NULL `posted_at`.

### What enrichment would actually add, which is not what it looks like

Production's per-column fill rates over 1252 active rows explain where the value is:

| column | filled | note |
|---|---|---|
| `summary` | 1252 / 1252 (100%) | **already full — ingestion writes it** |
| `normalized_title` | 1252 / 1252 (100%) | **already full — ingestion writes it** |
| `experience_level` | 1252 / 1252 (100%) | **already full — ingestion writes it** |
| `skills_json` | 415 / 1252 (33.1%) | **exactly tracks `enriched_at` — only enrichment writes it** |
| `org_unit_raw` | 340 / 1252 (27.2%) | only enrichment writes it |
| `workplace_type` | 595 / 1252 (47.5%) | partly ingestion |
| `salary_min_usd` | 578 / 1252 (46.2%) | partly ingestion |
| visa columns | 4-5 / 1252 (0.4%) | the postings do not say — see below |

Across the 837 specifically: `summary`, `normalized_title` and `experience_level` are **837/837
already filled**, while `skills_json` and `org_unit_raw` are **0/837**. So the marginal value of
clearing this backlog is almost entirely `skills_json` — which feeds `company_technographics` and
the ATS scorer. 837 rows contributing nothing to the ATS corpus is the real cost of the outage, and
it is not visible in a row count.

### The local board is a different number, and conflating them is the trap

`data/resume_master.db` holds **1296 rows / 1266 active, 5 never enriched** — and all 5 are
`aj2fixture::` rows. Task S restored the board from a snapshot of already-enriched rows, so **the
837 is production's backlog and the local backlog is 5 fixtures, worth $0.013.** Every figure in
this document and in the audit script is labelled with which database it came from.

---

## ⛔ And the pre-filter over-counts candidates by 250x

`enrichJob.js` selects on `enriched_at IS NULL OR content_hash IS NULL OR updated_at > enriched_at`
and then re-filters in JS on the exact content hash. On the restored local board:

```
SQL pre-filter                      1252 rows
after the content-hash comparison      5 rows      <- 250x
```

Task S's restore stamped **one** bulk `updated_at` (`1787558402`) onto 1247 rows whose title and
description never changed. **A dry run that priced the pre-filter would have quoted ~$2.10 to send
nothing.** Every surface added here reports both numbers and the gap between them, and
`selectCandidates` has no option to skip the second step.

The gap is not measurable remotely — it needs every row's full text, and `/api/admin/db/raw-query`
caps at 200 rows — so the production figure above is the unambiguous `enriched_at IS NULL` cohort,
which needs no hash to resolve. The audit script says so rather than guessing.

---

## What was built

| file | what |
|---|---|
| `services/jobs/enrichmentSelection.js` | **new.** One candidate selector + the freshness gate + cost estimation + per-column coverage. Shared by the cron pass, the dry run, the manual trigger and the export, so they cannot disagree about which rows they mean. |
| `services/jobs/enrichmentBatches.js` | **new.** U4 provenance: open/close a batch, per-row before-image, exact revert. |
| `services/jobs/enrichmentTransfer.js` | **new.** U2 export (JSONL) + U3 import (validate, plan, apply). |
| `routes/enrichment.js` | **new.** Admin-gated HTTP surface, every spending/writing route dry by default. |
| `scripts/am4EnrichBacklogAudit.mjs` | **new.** U1.1 measurement, local + production, read-only. |
| `scripts/am4Enrich.mjs` | **new.** CLI: `run` / `export` / `import` / `batches` / `batch` / `revert`. |
| `services/jobs/enrichJob.js` | uses the shared selector; freshness gate; coverage reporting; batch provenance. `computeContentHash` moved out and is re-exported. |
| migration `101_enrichment_batches` | additive, dual-path, byte-identical in `scripts/migrations.js` and the `server.js` array. |

### U1.2 — the freshness gate keys on `scraped_at`, and its default is not arbitrary

`ENRICH_MAX_LAST_SEEN_DAYS`, default **7** — deliberately the same horizon as
`runExpiredJobsCleanup`'s cutoff (`server.js`: `now - 7*24*60*60`, also on `scraped_at`). That makes
the rule say something defensible: **never spend a token on a row the very next cleanup pass would
delete.** A row not re-sighted in seven days is not a fresh posting, it is a row awaiting expiry, and
enriching it buys an artifact with a one-day life.

`test/enrichmentTransfer.test.js` **pins the two sevens to each other** by reading server.js's
cutoff out of the source. If the expiry horizon moves and the gate does not, the gate silently stops
meaning "will survive the next pass" and becomes an arbitrary age filter; nothing else would notice.

Stated plainly because it looks like a no-op: **on both databases measured today the gate admits
every candidate** (local 5/5, production 837/837). That is the correct result. The gate is a floor
against a board that has stopped refilling — which is exactly the condition that produced
`cleanup_log` id 85. A NULL `scraped_at` is treated as **ungated**, not as infinitely old: a row with
no recorded sighting is one the aggregator has not touched, not one known to be stale.

### U1.4 — coverage, and the one-line bug that would have made it meaningless

Every run reports per-column fill rates before and after. `enriched: 837` proves nothing — A2 found
a model returning HTTP 200, `success: true`, a clean usage row and a NULL extraction 49 times in 50.

**`enriched_at` is excluded from the climbed/regressed verdict, and that exclusion is the whole
point.** The first version counted it, and `enriched_at` gains by definition on every successful
write — it is the stamp, not a signal. With it counted, `gains.length` was non-zero for *any* pass
that wrote a row, so the "no column gained a value" warning **could never fire** and the requirement
would have measured nothing. Caught by watching the warning not fire on a test that should have
tripped it.

Two further distinctions the verdict needs:

- **Fills and corrections are recorded separately.** A pass that replaces a wrong `experience_level`
  with a right one moves no fill rate at all. Warning on a flat fill rate alone cried wolf on every
  correction-only pass, and an alarm that fires on correct behaviour gets ignored. The condition that
  actually indicts an extraction is *no column gained **and** nothing was corrected*.
- **The visa columns are printed but excluded from the verdict.** 0 of 1261 descriptions contain
  "H-1B"/"H1B" and 36 mention sponsorship at all; the prompt correctly answers null when a posting is
  silent. Their emptiness is the source material, not a pipeline failure. Measured again here:
  production 0.3-0.4%, local 0.2-1.2%.

### U1.5 — proved on 10 rows, and the 10 rows found a live bug

Rehearsed on a **copy** of the real 116 MB board (`scratchpad/rehearse.db`), never on the live one:
migration applied, enrichment blanked on 10 real Stripe/Figma greenhouse postings, then a real pass.

**First attempt — all 10 failed.**

```
[enrichJob] Failed to enrich greenhouse::5416444: Unexpected end of JSON input      (x10)
[enrichJob] Enriched 0/10 (10 failed), 11285 in / 5000 out tokens
[enrichJob] coverage: NO COLUMN GAINED A VALUE  (enriched_at +0, 0 corrected)
⛔ NO COLUMN GAINED A VALUE. Task U1.5: if coverage does not climb with the count, STOP.
```

Output was **exactly** 500 x 10 — the `max_tokens` cap hit on every single call. Cause: local `.env`
carries `ENRICH_PROVIDER=groq` and `ENRICH_MODEL=openai/gpt-oss-20b`. **gpt-oss is a reasoning
model**: it spends the entire 500-token output budget on reasoning and returns truncated content, so
`JSON.parse` throws. This is A2's failure mode in a new variant — and A2's verdict was **KEEP
HAIKU**, so the local `.env` contradicts it.

**⛔ `usage_events` recorded `success = 1` on all ten.** A2 found the null-extraction variant; this is
the truncated-JSON variant, and the usage row looks clean either way. The instrumentation cannot
distinguish "the call returned" from "the call returned something usable" — which is precisely why
U1.4's coverage delta, not the call count, is the test.

The guards held exactly as designed: nothing was stamped, no `content_hash` written, all 10 stayed
candidates, and the script exited **3** rather than scaling to 837.

**Second attempt, same 10 rows, `ENRICH_PROVIDER=` `ENRICH_MODEL=` (i.e. Haiku, per A2):**

```
[enrichJob] Enriched 10/10 (0 failed, 0 no-signal), 11974 in / 2633 out tokens, ~$0.0251
coverage: summary +10, normalized_title +10, experience_level +10, workplace_type +9,
          salary_min_usd +5, salary_max_usd +5, salary_period +5, skills_json +10, org_unit_raw +4
9 column(s) climbed, 0 regressed
```

Actual **$0.0251** against the quoted ceiling **$0.0347** — the estimate is a real upper bound
(2633 actual output tokens vs the 5000-token cap it prices).

### U4 — provenance, and why it records a before-image

`enrichment_batches` (source `cron | manual | import`, provider, model, counts, tokens, cost,
coverage snapshot, `reverted_at`) + `enrichment_batch_rows` (per-row before-image) +
`scraped_jobs.enrichment_batch_id`. Columns stay where they are, so **no read path changes.**

**A revert cannot be "null the enrichment columns on the rows this batch touched."** Enrichment
writes through COALESCE, so it only ever filled columns that were NULL — but afterwards it is
unknowable *which* ones those were, because ingestion has already populated
`normalized_title`/`experience_level`/`workplace_type`/salary on many rows. Blanket-nulling would
destroy ingestion data the batch never touched: the same defect that nulled 120 rows from the inside,
pointed the other way. So the prior values are recorded before the write and a revert replays them
verbatim. Verified on real data — `experience_level` from ingestion survives, what the batch wrote
does not.

`enriched_at` and `content_hash` are in the before-image **deliberately**: restoring them is what
puts a reverted row back in the candidate set. Reverting the values but leaving the row stamped would
produce the poisoned shape U3.6 forbids. Verified: after reverting batch 4, all 10 rows were
candidates again.

A revert **keeps its own evidence** — the batch is stamped `reverted_at`, not deleted, and the
before-image rows stay. A revert that erases its own record is the same mistake as a delete that
erases the text.

**⛔ The batch used to name the wrong model.** `openBatch` was passed enrichJob's `MODEL_HAIKU`
constant, but for PUBLIC traffic the routing layer overrides it from `ENRICH_PROVIDER`/`ENRICH_MODEL`
— so batch 1 above reads `anthropic / claude-haiku-4-5-20251001` while every `usage_events` row for
it says `groq / openai/gpt-oss-20b`. Provenance that names the wrong model is worse than none,
because it is the thing you would consult to explain a bad batch. Fixed by resolving through
`resolveProvider(process.env)` — the same function the transport consults. Batch 3 (a deliberate
re-run under the Groq pin) correctly reads `openai/gpt-oss-20b`.

### U2/U3 — export and import

JSONL, not CSV (CSV loses `skills_json`'s nested shape). Each line is
`{ job_id, content_hash, stored_content_hash, source: {...}, enrichment: {...} }`. **`source` is
read-only and ignored on import; `enrichment` is the 12-column writable surface** — a flat row leaves
a filler guessing which of thirty keys they may touch, and guessing plus "we then write it to the
board" is the entire risk. The export uses the same selector as the trigger, so the export set and
the enrich set are identical by construction.

`content_hash` is **recomputed** rather than copied from the column: an unenriched row's stored
`content_hash` is NULL, and exporting null would disable the staleness interlock for exactly the rows
most likely to be enriched externally.

Verified on real board rows:

| guard | result |
|---|---|
| export, change nothing, import | **0 rows written**, 0 rejected, no batch opened |
| unknown `job_id` | rejected, **never inserted** |
| missing `content_hash` | rejected — staleness would be unknowable |
| changed `content_hash` | refused by default; `--allow-stale` overrides and then does **not** stamp `content_hash` |
| one bad enum in a 10-row file | **whole file refused, 0 written** — confirmed the 9 good rows stayed NULL |
| free text in `experience_level` | rejected against the shared registry, offending row named |
| `"120000"` for a salary | rejected, **not coerced** |
| `"yes"` / `2` for a visa flag | rejected; `0/1/true/false/null` only |
| typo'd column name | rejected as `unknown_column`, not silently dropped |
| duplicate `job_id` in one file | rejected |
| non-null value present | **skipped and reported**; `--overwrite` required to replace |
| a row where nothing was filled | **no `enriched_at` stamp** — the row stays a candidate |
| failure mid-apply | one transaction, so nothing is partially applied |

### Honest framing, restated

Export/import does **not** save cost (whoever enriches externally still pays the tokens) and does
**not** reduce verification effort — data crossing a trust boundary needs *more* validation. Most of
`enrichmentTransfer.js` is that validation, which is the honest measure of what the boundary costs.
What it buys is **control and separability**: enrich a deliberate subset, re-import a corrected batch
without re-running a model, keep the outsourcing door open.

---

## The graceful-degradation path was a claim, not a behaviour

`runEnrichment` was written to warn and continue when provenance is unavailable, and `openBatch` duly
did — but the UPDATE also names `scraped_jobs.enrichment_batch_id`, so on a database without
migration 101 it threw a bare `SQLITE_ERROR` **after** announcing it would degrade. Two existing test
fixtures failed exactly that way.

Fixed properly rather than by patching fixtures around a false comment: `batchProvenanceAvailable()`
checks **both tables and the pointer column**, the UPDATE appends the column only when it exists, and
the named parameter is bound only when the SQL uses it (better-sqlite3 rejects an unused one — which
would have turned one error into a different one). Pinned by two tests, including an import that
still lands on a database with the tables dropped.

Two fixtures were also missing `scraped_at` / `source` / `posted_at`, which the shared selector
reads. Those are real columns on the real table; the fixtures were simply incomplete.

---

## Interfaces

```
node scripts/am4EnrichBacklogAudit.mjs [--prod]      # U1.1 measurement, read-only
node scripts/am4Enrich.mjs run                       # DRY RUN: rows + cost ceiling, calls nothing
node scripts/am4Enrich.mjs run --apply --limit 10
node scripts/am4Enrich.mjs run --apply --ids-file ids.json   # exact set, reproducible
node scripts/am4Enrich.mjs export --out batch.jsonl
node scripts/am4Enrich.mjs import batch.jsonl [--apply] [--overwrite] [--allow-stale]
node scripts/am4Enrich.mjs batches | batch <id> | revert <id> [--apply]
```

`--ids-file` exists because `--limit` takes the first N of an ordering: on the local board a bare
`--limit 10` silently mixed fixture rows in with the intended ten.

```
GET  /api/admin/enrichment/candidates        # the dry run as a read
POST /api/admin/enrichment/run               # DRY unless {apply:true}; capped at 100 rows/request
GET  /api/admin/enrichment/export            # JSONL (?format=json for the object)
POST /api/admin/enrichment/import            # DRY unless {apply:true}; 422 + 0 writes if invalid
GET  /api/admin/enrichment/batches           # provenance
GET  /api/admin/enrichment/batches/:id
POST /api/admin/enrichment/batches/:id/revert  # DRY unless {apply:true}
GET  /api/admin/enrichment/coverage
```

All admin-gated, for two different reasons: `/run` spends real money per row, and `/export` returns
the entire board's posting text in one response. A manual pass is capped at **100 rows per request**
because an HTTP handler running 837 sequential model calls is killed by a proxy timeout partway
through, and the operator would not know how far it got. Larger backlogs are cleared by repeated
calls, each recorded as its own batch and individually revertible.

Verified against the **real booted server** under real admin auth (a temporary `am4_admin` fixture,
created by the boot seed and deleted afterwards — the existing `admin` account's password was not
touched). `/candidates` reported `prefilter=1252 realCandidates=5 gate=7d $0.0126`; `/run` with no
body returned `applied=false dryRun=true`; `limit: 5000` capped to 100; the unmodified round trip
wrote 0; the malformed file returned **422 with 0 written**.

---

## What this did NOT do

- **No production enrichment was run and no production row was written.** Every production call was
  a read-only `SELECT` through `/api/admin/db/raw-query`. The 837 are still unenriched.
- **The live local board was not enriched either.** All real model calls went to a copy in the
  scratchpad. The only change to `data/resume_master.db` is migration 101 (additive: two tables, one
  nullable column, two indexes) — `enrichment_batches` holds 0 rows and 0 board rows carry a batch id.
- **`mapJobRow` is unchanged**, pinned by a test asserting a row with `enrichment_batch_id = 7` maps
  to byte-identical JSON to one without it.
- **The rollup brake was not touched.** `boardSufficiency.js` still refuses `computeTermWeights`,
  `runHiringSignalsRollup` and `runOrgLayerRollup`. Enriching rows does not recompute anything.
- **No decision was made about the full enrichment-table split.** Migration 101's comment records the
  cost; the cheap version is what shipped, as task U recommended.

## Owner actions this measurement produces

1. **⛔ Delete BOTH `ENRICH_PROVIDER` and `ENRICH_MODEL` from Railway** — already in NEXT_WORK.md, and
   now with a second, independent reason. It is not only that the pinned Groq model 404s: even a
   *live* Groq model that reasons (`openai/gpt-oss-20b`) burns the whole 500-token output budget and
   returns unparseable JSON, with `usage_events` recording `success = 1`. Falling back to Haiku is
   A2's verdict and it is measured working here: 10/10, nine columns climbed.
2. **Do the same in local `.env`.** It carries the same two variables and the same failure. Local
   enrichment has been broken in exactly this way, silently, for as long as they have been set.
3. **The 837 are worth clearing, contrary to the premise** — they are all live postings, and the gain
   is `skills_json` 0 -> 837, which feeds the ATS scorer. ~$3.07 ceiling. Redeploy first (the cleanup
   brake is still not deployed), then `POST /api/admin/enrichment/run {apply:true, limit:10}`, check
   the coverage delta, and only then scale.
4. **`max_tokens: 500` is a latent trap for any reasoning model.** It is enough for Haiku (2633
   tokens across 10 calls, ~263 each) and not enough for a model that thinks before answering. Worth
   raising, or worth a provider-capability note beside the pin; A2's Groq TPM finding is the same
   class of thing — a limit the code does not know exists.
