# ATS term weights — a refusal is not a schedule

2026-09-18. Closing the dated item on `docs/CURATION_CONSOLIDATION.md`'s not-in-scope list.

**The brief said:** *"`ats_term_weights` go stale 2026-10-13 — 856 rows, `computed_at` 19.6 days
old against `MAX_WEIGHT_AGE_DAYS = 45`. Past that, scoring silently reverts to unweighted with only
a `console.warn`. Needs a loud failure and a recompute schedule."*

**What measuring found:** that is a *local* statement, and the production situation is worse and
already happening.

---

## 1 · Production's weight table was empty, and had always been

Read from the deployment (read-only, `/api/admin/db/raw-query`):

```
PRODUCTION ats_term_weights:  []          -- zero rows, no families, never computed
enriched postings now:        1,140
active postings now:          2,610
```

So there is no 2026-10-13 deadline in production. **Every ATS score the product has ever served
was computed unweighted**, from the day the weighting system was built.

⛔ **And the one warning in the codebase could not fire.** `atsTermWeightsForJob` read:

```js
if (loaded && loaded.stale && loaded.weights.size) { console.warn("term weights are stale …"); }
```

`weights.size` is 0 for an empty table, so the guard required a table that **exists** and is old.
The state production was actually in — no table at all — was silent *by construction*. There are
three states and the code could only ever report one of them.

| state | scorer | reported before | reported now |
|---|---|---|---|
| fresh | weighted | — | boot line + `/api/version` |
| stale | **unweighted** | `console.warn` | warn + boot line + `/api/version` |
| **absent** | **unweighted** | **nothing at all** | warn + boot line + `/api/version` |

---

## 2 · What unweighted scoring actually costs, measured

Scored the same corpus twice — real profile, real résumé, real synonyms — with and without the
weight table:

| | weighted | unweighted |
|---|---|---|
| ρ vs the owner's own fit grades (n=18) | **0.4757** | 0.4151 |
| graded scores that differ | 3 of 18, max Δ3, 1 band change | |
| **board sample (881 enriched)** | | |
| scores that differ | **180 (20.4%)**, max Δ5 | |
| **band changes** | **25 (2.8%)** | |

Honest reading: **not catastrophic.** One in five scores moves by up to five points, one in
thirty-six lands in a different band, and ρ improves by 0.06 on a small sample. Weighting is a
refinement, not the difference between working and broken.

The defect is not the size of the effect. It is that a deployment could run in its degraded mode
indefinitely with no log line, no field, and no way to ask.

---

## 3 · The fix: a refresh threshold, and three states all reported

⛔ **`MAX_WEIGHT_AGE_DAYS` was never a schedule — it is a refusal**, and
`scripts/recomputeAtsTermWeights.js`'s own header says so: *"That refusal is the safety net, not
the schedule."* A system whose only weight-management mechanism is a refusal degrades to unweighted
and calls that safety. The missing half:

```js
export const REFRESH_WEIGHT_AGE_DAYS = 14;   // rebuild here
export const MAX_WEIGHT_AGE_DAYS     = 45;   // refuse to use, unchanged
```

14 against 45 leaves two further nightly opportunities before the cliff, so one failed run cannot
reach it. A test pins `REFRESH < MAX` and the ≥2× ratio, because equal thresholds would mean a
rebuild triggered by the damage it exists to prevent.

**New in `services/atsTermWeights.js`:** `atsWeightStatus` (the three states), `weightsNeedRefresh`,
and `maybeRecomputeTermWeights` — one rebuild path, never throwing.

**Wired in two places, through one function (`runTermWeightRefresh`):**

- **boot** — because production needs it *now*, and waiting up to 24h for a cron tick while scoring
  unweighted is the thing being fixed. Deferred one tick with `setImmediate`; see §5.
- **the nightly 04:00 cron**, immediately *after* the crawl — weights are document frequencies over
  the board, and the board just changed. Before the crawl they would describe a board that no
  longer exists.

**Reported in three places:** a boot line on every start including the healthy case (a log that
only speaks when something is wrong cannot answer *"is weighting on?"*), a per-family warning that
now covers `absent`, and `/api/version`:

```json
"atsWeights": { "state": "fresh", "weightedScoring": true, "terms": 604,
                "families": ["__global__","data","engineering","pm"],
                "ageDays": 0, "corpusSize": 881,
                "refreshAtDays": 14, "refusedAtDays": 45 }
```

Unauthenticated, like the rest of that endpoint — it carries a state name, a count and an age, no
term and no weight. The project already answers *"what is deployed?"* in one curl; *"is the scorer
actually weighted?"* belongs in the same breath, because a deployment scoring unweighted is not the
deployment anyone thinks they shipped.

---

## 4 · Two things that would have made this a no-op

⛔ **The cache.** `server.js` holds `_atsWeightCache`, one entry per role family, for the process
lifetime — **including the `null` entry meaning "unweighted"**. A nightly rebuild that does not
clear it writes a perfectly good table that nothing reads until the next deploy, which is
indistinguishable from a rebuild that never ran. CC3 hit this exact shape with the synonym cache.
`maybeRecomputeTermWeights` takes an `onInvalidate` callback and a test asserts it fires on rebuild
and **does not** fire when the rebuild is skipped or refused.

⛔ **The thin-board refusal.** `assessRebuildScope` exists because `cleanup_log` id 85 took
`scraped_jobs` from 1,291 rows to 5. A *scheduled* rebuild must not become the thing that finally
destroys a good weight table while the corpus is momentarily gone. A refusal is reported as
`refused:`, keeps the existing table, and does not invalidate the cache — because "0 terms written"
must never read as a successful recompute.

---

## 5 · Verified by reproducing production's state locally

Deleted the local weight table to recreate "never computed", then booted:

```
[boot] ats_term_weights: absent — NEVER COMPUTED; every score is unweighted until this is fixed
[ats-weights] (boot) rebuilt — absent -> fresh, 604 terms over 881 enriched postings
              [__global__:424 engineering:123 data:41 pm:16]
```

`/api/version` then reported `state=fresh weightedScoring=true terms=604 age=0d`.

**One bug found this way rather than by reading.** The first boot logged:

```
[ats-weights] (boot) refresh threw: Cannot access '_atsWeightCache' before initialization
```

The boot block runs during module evaluation, ~2,200 lines before that `const` is declared, and the
refresh clears it. The never-fatal wrapper caught it and the server came up fine — which is exactly
how a refresh that never runs would have gone unnoticed. `setImmediate` defers it past module
evaluation. Same TDZ shape as the CC5 writer earlier the same day.

Rebuild cost: **60 ms** over 881 enriched postings, measured. That is what makes a boot-time
rebuild reasonable rather than merely convenient.

---

## 6 · A side observation the rebuild surfaced

The old local table was computed from a corpus of **1,289**; the rebuild used **881**. The board
grew 1,266 → 2,460 active while the *enriched* subset shrank, so enrichment has fallen behind the
crawl. The weights are correct for the board as it is — but a nightly rebuild now makes corpus
drift visible in the log, where previously a 20-day-old table said nothing about the board having
nearly doubled underneath it.

---

## 6b · Production is weighted now — with ONE family, and that is a second finding

The boot hook fired on production and computed weights for the first time in the product's history:

```
"atsWeights": { "state": "fresh", "weightedScoring": true, "terms": 493,
                "families": ["__global__"], "ageDays": 0, "corpusSize": 1179 }
```

⛔ **Only `__global__`.** Locally the same code builds four families (engineering, data, pm,
global). Production has 1,179 enriched postings and, by `job_role_map`, 245 engineering and 244
sales among them — far above `MIN_FAMILY_POSTINGS = 60`. So a per-family table should exist and
does not.

The cause is that **the weight table buckets families with a different, narrower function than the
board classifies roles with**:

| | used by | "account executive" | "applied ai architect" | "software engineer" |
|---|---|---|---|---|
| `roleFamilyForTitle` | `computeTermWeights` | **null** | **null** | engineering |
| `classifyJob` | ingest, `job_role_map` | sales | (a bucket) | engineering |

Production's enriched corpus is dominated by titles the *narrow* mapper does not recognise —
its top five enriched titles are `account executive` (38), `applied ai architect` (21),
`enterprise account executive` (20), then two engineering titles at 18 each — so fewer than 60
rows land in any single family bucket and only the global table is written.

**This is not a failure of the schedule and it does not break scoring**: `loadTermWeights` falls
back to the global table by design, which is why production is `weightedScoring: true`. It is a
loss of *resolution* — the scorer weights a sales posting with the whole board's document
frequencies rather than sales'.

It is also the same shape as two other defects repaired this week: **two classifiers answering one
question.** Fixing it means either widening `roleFamilyForTitle` or bucketing weights by
`job_role_map.role_key`, and either is a measurement task of its own — the weights change, so rho
has to be re-measured against the graded corpus before and after. Not attempted here.

## 7b · The louder signal — added 2026-09-26

§7 below named one gap and left it: *"if the 45-day refusal is ever hit, that means the nightly
pass has failed three times running, which is worth a louder signal than this task builds."* Built
now, because it is the same defect shape as everything else on this page — **a degraded state that
nothing says out loud.**

⛔ **The refresh is never-fatal on purpose, and that is exactly what hides a broken one.** A scorer
on 20-day-old weights beats a dead cron tick, so `runTermWeightRefresh` swallows everything and
logs. But never-fatal plus console-only means **a pass that fails every single night is
indistinguishable from one that simply has not been due.** The table reads `fresh` for 14 days,
then `stale`, and at 45 the scorer drops to unweighted — and at no point does anything say "the
mechanism that prevents this has not worked in three weeks".

**No migration.** `pipeline_runs` (069) is generic — `run_kind` is a bare `TEXT` column — and it
already exists to record "a pass that did nothing". `term_weights` joins `source_sync` and
`enrichment` as a third grain. A test asserts there is no `CHECK` on `run_kind`, so a later
constraint fails loudly instead of making every rebuild silently unrecorded.

**What is recorded, and what deliberately is not:**

| outcome | status | why |
|---|---|---|
| rebuilt | `ok` | resets the streak |
| refused (thin board) | `no_results` | ⛔ neither counts NOR resets — the guard doing its job is not evidence either way about whether the pass works |
| failed / threw | `failed` | increments the streak |
| not due yet | **not recorded** | the expected state on 13 nights in 14; a row per night would bury the failures |

**Three is the number, and it is derived rather than chosen.** With refresh at 14 and refusal at
45 there are two further nightly chances after the first miss, so three consecutive failures is
where the cliff becomes reachable. A test asserts the arithmetic still holds, so moving either
threshold fails rather than quietly making the reported number a lie.

**Reported in two places:** `/api/version` gains `atsWeights.refresh`, and a **stderr** line at
boot — but only when the streak is non-zero. That is a deliberate exception to §3's "print even
when healthy" rule: a boot line reading *"0 consecutive failures"* forever is how a warning stops
being read.

```json
"refresh": { "consecutiveFailures": 0, "failuresBeforeCliff": 3, "lastRun": null }
```

⚠ **Verified by driving the counter over a synthetic history**, not by reading it: success → 0,
one failure → 1, **a refusal in the middle → still 1**, two more failures → 3, then a success → 0.
The refusal case is the one worth checking, because counting it would make the alarm fire on the
thin-board guard working correctly.

---

## 7 · Not done

- **The 45-day refusal is unchanged.** With a 14-day schedule it should be unreachable. ✅ The
  "louder signal" this bullet asked for is built — see §7b.
- **No alert.** Everything here is a log line or a field. Nothing pages anybody, and nothing
  watches `/api/version` on a timer — deliberately: that is monitoring, not scoring.
- **Per-family weights on production** — see §6b. Global-only weighting works and is the designed
  fallback; the resolution loss is real and the fix is its own measured task.
- **`weightsAreStale` still judges by AGE only**, never by corpus drift. A table computed
  yesterday from a corpus half the size of today's board reads as perfectly fresh. §6 is the
  evidence that this case is real.
