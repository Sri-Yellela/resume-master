# A source that wrote nothing because nothing changed

2026-09-21. Closing the one item `docs/ENRICHMENT_BACKLOG_2026-09-18.md` §6 left open:

> **workable (23 fetched → 0 written) and recruitee (16 → 0)** are flagged critical by the same
> monitor and are a separate defect from this one.

**They are a separate defect, and the defect is the monitor.** Both sources were working. The
critical was false, and `2e4429e` had just started delivering it to somebody every night.

---

## 1 · What `written` actually counts

On the crawl side `written` is `cached` — the **new-or-changed** upserts. `services/jobs/aggregator.js`
fingerprints every fetched posting against the last crawl and, when it matches, takes the cheap path:
no re-classification, no upsert, a `touchSeenStmt` and `unchanged++`. A posting folded into another
source's canonical row counts `merged++`. Deliberate refusals are counted too — `dropped` for an
unclassifiable role, `ejected` for blue-collar.

Five counters, and the run row carries all five:

```
fetched = written + unchanged + merged + dropped + ejected
```

The health route read exactly one of them:

```js
const wroteNothing = lastRun != null && Number(lastRun.written || 0) === 0;
```

⛔ **So "this source's board did not change overnight" and "this source has stopped working" were
the same observation.** A stable board is the *expected* steady state of a small source: three
workable slugs that post nothing new for a day fetch the same 23 postings, match 6 fingerprints,
refuse 17, and record `written: 0`. That was classified `wrote_nothing`, ranked above `stale`, and
pushed as **critical**.

⛔ **`unchanged` was not even SELECTed.** The query pulled `fetched, written, merged, dropped,
ejected, failed, expired` — the one counter that proves the rows were accounted for was invisible to
the check that needed it. It has existed in the table since migration 069 and the aggregator has
been writing it the whole time.

---

## 2 · Why this one mattered more than a wrong cell

The route has been wrong about this since it was written, and it did not matter, because nothing
read the route. `2e4429e` changed that four days ago: pipeline alerts are now delivered to admins
and to an optional webhook. Its own header says what that makes of a false positive:

> Sending the same six criticals daily produces the one outcome this whole codebase keeps
> rediscovering: an alarm nobody reads, which is worse than no alarm because it looks like coverage.

Edge-triggering keeps a *standing* alert quiet, which is exactly what makes a standing FALSE alert
so expensive: it is delivered once, it never clears, and it sits in the set permanently, next to the
real ones. Two of the seven alerts delivered on the first run were these two.

---

## 3 · What the fix classifies on

Two zeros, and they are not the same failure:

```
accountedFor = written + unchanged + merged     // on the board, or confirmed still on it
rejected     = dropped + ejected                // refused on purpose, by the classifier
```

| last run | before | now | severity |
|---|---|---|---|
| fetched 23, written 0, **unchanged 6**, refused 17 | `wrote_nothing` | **`ok`** | none |
| fetched 10, written 0, **merged 10** | `wrote_nothing` | **`ok`** | none |
| fetched 16, written 0, unchanged 0, **refused 16** | `wrote_nothing` | **`all_rejected`** | warn |
| fetched 23, written 0, unchanged 0, refused **15** | `wrote_nothing` | `wrote_nothing` | critical |
| fetched 100, written 0, nothing else | `wrote_nothing` | `wrote_nothing` | critical |

Three deliberate choices in that table:

- **`all_rejected` is its own state, and a `warn`.** "The source is dead" and "we throw away
  everything it sends" lead to opposite actions, so they do not get the same word. Nothing is broken
  in the fetch; the judgement to make is about the source's yield or about the classifier. Folding it
  into `wrote_nothing` would have been the cheaper change and would have kept a critical on a source
  that is behaving exactly as configured.
- **Refusals that do not add up to the fetch stay CRITICAL.** A run that fetched 23, refused 15 and
  cannot say what became of the other 8 has lost rows silently. That is the `0de67c8` shape — the
  cap that discarded 43% of the crawl while every run recorded `ok` — and it is worse than a clean
  refusal, not better.
- **The refused SHARE is a field, not an alert.** `rejectedShare` now sits on every source row. It is
  the same call task Y phase 2 made for `detailYield`: a standing condition that a human reads,
  because a nightly warning that cannot be cleared is one nobody reads.

The alert text names every counter now, because the old wording — `wrote 0 rows from 23 fetched` —
was true of two working sources and gave the reader nothing to check it against.

---

## 4 · The panel said it too

`DBInspector`'s source row rendered `ok · 0 written`, which is the same conflation in the same
words. It now reads `ok · 0 written · 6 unchanged · 17 refused`, and there is an amber
**ALL REJECTED** pill beside the red **WROTE NOTHING** one.

`scripts/acPipelineHealthUi.mjs` carries an `all_rejected` source row with production's recruitee
counters, so the new label goes through the same geometry check as every other one — 13/13 pass,
including `no health pill wraps onto a second line`, the guard that exists because two labels once
broke out of their own background while every string assertion about them passed.

---

## 5 · Verified

**Five tests in `test/pipelineHealth.test.js`, three of them proved to fail by injection.** Putting
`written === 0` back produced exactly:

```
✖ a crawl that finds every posting unchanged wrote 0 rows and is HEALTHY
✖ a posting folded into another source's canonical row is accounted for, not lost
✖ a source whose whole yield the classifier refuses gets its own state and its own severity
```

The other two pass in both directions on purpose: one guards the new `all_rejected` path from
swallowing a case the old check got right, the other pins `rejectedShare`.

Suite: **2596 passing, 0 failing** (2591 at `2e4429e`).

**And against the real board, through the real route** — `createAdminDbRouter` over
`data/resume_master.db`, read-only, no fixtures:

```
greenhouse   1540 active  rejectedShare=0.281   fetched=2142 written=1540 dropped=602
ashby         777 active  rejectedShare=0.308   fetched=1123 written=500 unchanged=277 dropped=346
lever         133 active  rejectedShare=0.281   fetched=185  written=133 dropped=52
workable        6 active  rejectedShare=0.739   fetched=23   written=6   dropped=15 ejected=2
recruitee       4 active  rejectedShare=0.750   fetched=16   written=4   dropped=12
```

Zero source alerts from the new branches. (All five read `stale`: the local server has not been left
running since 09-17, which is `AH-3`'s note, not a finding.)

---

## 6 · ⛔ What I could NOT read, and what I inferred instead

`GET /api/admin/db/pipeline-health` on production answers **403 `{"error":"Admin access required"}`**
without a session, so **I never read production's own `unchanged` for those two runs.** The 23 and 16
are `docs/PART1_RECONCILED_2026-09-18.md`'s figures; the local crawl of 09-17 fetched the same 23 and
16 from the same slugs.

The inference that production's zero was the *unchanged* branch rather than the *all-rejected* one:
production holds **6 active workable rows and 4 recruitee rows**. Those rows are on the slugs that
were re-fetched, so their fingerprints matched and they were touched — `all_rejected` would require
the fetch to no longer contain them at all. It is a strong inference and it is not a measurement.

**It also does not change the fix.** Both branches were classified `wrote_nothing` critical before,
and are classified separately and correctly now — `ok` on one path, `warn` on the other. The one-curl
confirmation is available to whoever has the admin session: the payload now carries
`lastRun.unchanged` and `rejectedShare` per source.

---

## 7 · The finding the false critical was sitting on

`rejectedShare` is **0.281 on greenhouse** — 602 of 2,142 postings per crawl refused as
unclassifiable (`verdict.roleKey === null`), and 0.31 on ashby, 0.28 on lever, 0.74/0.75 on the two
small ones. Roughly **a quarter to three quarters of every fetch is discarded by `classifyJob`**,
nightly, and nothing has ever reported it.

That is the same shape CC1b found on the other side of the same classifier: 277 active rows that
`job_role_map` had never classified were hidden from every board
(`docs/CC1B_ROLE_KEY_SOFT_NULL.md`). This is the population that never got a row *at all*.

**Not attempted here, and it is a measurement task, not a fix.** Whether 602 rows a night are
correctly refused or wrongly refused cannot be answered by reading the classifier; it needs a sample
of the dropped titles judged against the taxonomy. The number is now on the payload so the question
can be asked. Adding a nightly alert for it would be the standing alarm this whole document is
about.
