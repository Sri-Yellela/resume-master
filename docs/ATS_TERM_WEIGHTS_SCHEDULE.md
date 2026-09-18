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

## 7 · Not done

- **The 45-day refusal is unchanged.** With a 14-day schedule it should now be unreachable; if it
  is ever hit, that means the nightly pass has failed three times running, which is worth a
  louder signal than this task builds.
- **No alert.** Everything here is a log line or a field. Nothing pages anybody, and nothing
  watches `/api/version` on a timer — deliberately: that is monitoring, not scoring.
- **`weightsAreStale` still judges by AGE only**, never by corpus drift. A table computed
  yesterday from a corpus half the size of today's board reads as perfectly fresh. §6 is the
  evidence that this case is real.
