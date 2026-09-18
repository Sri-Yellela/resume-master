# job_role_map backfill — the 277 postings nobody had classified

Run 2026-09-18, closing the follow-up CC1b recorded. Script: `scripts/backfillJobRoleMap.mjs`.

**In one line:** 277 active postings carried no role bucket, so they appeared on *every* profile's
board; they are now classified by the same function the ingest path uses, and the owner-shaped
engineering board went **849 → 655**.

---

## 1 · It was restore damage, not a classifier failure

Every row that goes through `services/jobs/aggregator.js` gets a `job_role_map` row — the
classifier's verdict, or a `'general'` fallback when there is no confident bucket. A posting with
**no** row did not come through that path in its current form.

`scripts/am3RestoreBoard.mjs` restores `scraped_jobs` and **not** `job_role_map`;
`docs/am1-recovery.md` records that table losing 1,286 rows to the `ON DELETE CASCADE`. So the
restore silently un-bucketed a large share of what it restored.

CC1b is why this was a follow-up and not an outage: it turned the board's role join into a LEFT
JOIN with a soft-null predicate, so "never classified" stopped meaning "hidden from everyone".

⛔ **But visible-to-everyone is not correct.** An unmapped posting appears on *every* profile's
board. 26 of these are sales roles and 33 are PM roles, and they were on the owner's engineering
board for no better reason than that nobody had said what they were.

---

## 2 · The rule, which is ingest's

| verdict | written |
|---|---|
| `roleKey != null` | that bucket |
| white-collar, `roleKey == null` | `ROLE_KEY_FALLBACK` (`'general'`) — ingest's own fallback |
| blue-collar | **nothing**, counted and reported |

⛔ **CC1b's note named the wrong function, and following it literally would have been wrong.** It
said "a backfill at `classifyForIngest`'s own 0.75 confidence gate". `classifyForIngest` returns
null below the threshold and nothing else — it does **not** carry the strong-white-anchor →
`'general'` policy that the ingest path applies through `classifyJob`. It would have left the 70
rows that legitimately bucket as `'general'` unclassified, and a backfill that classifies by a
different rule than ingest is a second classifier: the same posting would get one bucket from the
backfill and a different one from the next re-crawl.

The blue-collar branch is **empty on this board** (0 of 277) and is implemented anyway. At ingest a
blue-collar posting is rejected before the map write is reached, so filing one under `'general'`
would be a claim the ingest classifier never makes; the remedy for one sitting on the board is
ejection, a destructive decision with its own script that must not be smuggled into a backfill.

`source_profile_id` is written NULL, which is what `retireOtherClassifierBuckets` uses to tell a
classifier row from a profile-derived one — so a backfilled bucket is retireable by a later
re-crawl exactly like any other.

---

## 3 · What it will not do

⛔ **It never touches `scraped_jobs` and never deletes anything.** `scripts/reclassifyJobs.js` — the
existing, similar-sounding script — **DELETEs board rows**: it ejects blue-collar postings to
`rejected_jobs` and drops no-signal ones outright. On a board that was itself restored from a
backup, that is a second purge, not a backfill. The only statement this script executes against the
database is one `INSERT INTO job_role_map`, and the test asserts that by extracting every
`db.prepare(...)` in the file.

It also never overwrites an existing bucket — not the classifier's and not a profile-scoped one.
The candidate set is defined by `NOT EXISTS`, so a job carrying any bucket is out of scope; there is
no `UPDATE` and no `INSERT OR REPLACE`.

---

## 4 · Measured on a copy before anything was written

`--db <path>` exists for this: apply to a copy, diff the board, then decide.

| | before | after |
|---|---|---|
| active postings with no bucket | 277 | **0** |
| engineering board | 849 | **655** |
| data | 454 | 206 |
| pm | 540 | 296 |
| sales | 626 | 375 |
| general | 812 | 605 |
| hr | 335 | 66 |

Every board shrinks, because every board was carrying all 277.

**Verdicts:** engineering 83 · general 70 · pm 33 · data 29 · sales 26 · hr 8 · marketing 8 ·
operations 7 · design 5 · legal 3 · engineering_embedded_firmware 3 · finance 2. No blue-collar,
no drops.

### The acceptance criterion CC1 established: the owner's graded 30

| | before | after |
|---|---|---|
| graded postings present and reachable | 12 of 18 | **7** |
| **graded 5 reachable** | **7 of 8** | **7 of 8 — unchanged** |

⛔ **Five graded postings left the engineering board, and the grades say that is the point.** They
are the ones the owner rated *lowest*:

| owner's fit | posting | new bucket |
|---|---|---|
| 2 | Research Program Manager – Adversarial Model Research | pm 0.84 |
| 2 | Product Designer, Engineering Acceleration | design 0.87 |
| 1 | GRC Program Manager, US Government Compliance | pm 0.84 |
| 2 | Protection Scientist Engineer, Integrity | general 0.35 |
| **4** | **Forward Deployed Engineer – Singapore** | **general 0.35** |

A Product Designer and two Program Managers were on an engineering board only because they were
unclassified. Removing them is the backfill working.

**The last row is the real cost and is not dressed up.** The owner graded it 4, it is an engineer
role by title, and the classifier could only reach `'general'` at 0.35 — below the 0.75 gate, via
the strong-white-anchor branch. The remedy is the classifier's `SIGNALS` not recognising "Forward
Deployed Engineer", which is its own task; a backfill that special-cased it would be a third
classification rule.

The one graded-5 posting that is unreachable — *Applied AI Engineer, Digital Natives* — was
**already** excluded before this run, by an `ats_cache` row bucketing it `data` at 0.79. CC1b
recorded that as a profile-routing question (ML/AI is `data` in this taxonomy), and it is unchanged.

### The alternative, measured and rejected by the owner's call

A confidence-gated variant — write only the 207 verdicts at ≥0.75, leave the 70 unmapped — was
measured on a second copy: engineering **725**, unmapped **70**, graded reachable **9**, graded-5
still 7/8. It keeps the fit-4 posting. It was rejected because the backfill and the next crawl would
then disagree about those same 70 rows: a re-crawl *will* file them `'general'`.

---

## 5 · Applied, and verified through the real API

A safety copy was written to `data/backups/pre-roleMapBackfill.db` first.

```
inserted 277 row(s). Active postings still unmapped: 0
```

`GET /api/jobs` as the fixture user: **`total: 655`**, `rankedKeys` includes `role_key`,
`demoted: 339`. A second run of the script reports `active postings with no bucket: 0` — idempotent.

**Reversible in one statement**, which the script prints:

```sql
DELETE FROM job_role_map WHERE matched_by LIKE 'backfill_classifier%';
```

---

## 6 · Not done

- ⛔ **Production is NOT backfilled.** This ran against the local database. Railway has its own, and
  a script on a laptop cannot reach it. The `automation_tier` backfill solved the same problem by
  running at boot — NULL-only, idempotent, never fatal — and that is the obvious mechanism here,
  but it makes a deploy change board membership, which is a decision to take deliberately rather
  than as a side effect of this commit.
- **The classifier's gap on "Forward Deployed Engineer"** (§4) — a `SIGNALS` question.
- **The board still is not ordered by fit.** Unchanged by this; still CC2's finding.
