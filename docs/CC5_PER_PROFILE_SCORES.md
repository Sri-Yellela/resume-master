# CC5 — the stored ATS score becomes per (user, profile, job)

Implemented 2026-09-17/18, after CC1–CC4. Brief: `docs/CURATION_CONSOLIDATION.md` §CC5.

**The change in one line:** an ATS score is a statement about *(résumé, posting)*, and it was stored
in a cell that had room only for the posting — so it is now stored, read and sorted per
`(user_id, domain_profile_id, job_id)`, and the per-job cell has no writer and no reader left.

---

## 1 · The defect, confirmed

The brief named the keywords route's priority-2 read. Measuring found the same cell on **seven**
paths, three writing and four reading, all of them keyed by posting alone.

| | path | what it did |
|---|---|---|
| **W1** | scrape scorer, `server.js:4330` | `UPDATE scraped_jobs SET ats_score=?, ats_report=?` from `runtimeBasis` — built out of *one* user's base résumé, signal profile and claims |
| **W2** | adopt-enhanced, `server.js:8550` | selected **this user's** `user_jobs` rows, scored them against **this profile's** new résumé, wrote them to the shared cell |
| **W3** | keywords route | wrote `ats_only_reports`, correctly per user, `UNIQUE(user_id, job_id)` — no profile |
| **R1** | board `matchScore` → the card badge | `sj.ats_score` |
| **R2** | `/api/jobs/poll` → `baseAtsScore` / `baseAtsReport` | `sj.ats_score` / `sj.ats_report` |
| **R3** | keywords route priority 2 | `SELECT ats_report FROM scraped_jobs WHERE job_id=?` |
| **R4** | `capturedAtsAtApply`, the apply stamp | same statement, as source 3 of 3 |

**W2 is the one to read twice.** Adopting an enhanced résumé took rows scoped correctly to
`(user, profile)` and wrote the results somewhere scoped to nothing. One user pressing one button
rewrote the score **every other user** was shown, on every posting that user had saved.

**R4 is the one that would have lasted.** `job_applications` is the only table that can ever
correlate a score with whether an employer replied, and AK1's own comment in that function forbids
putting a fabricated point in it. A stranger's score against the same posting is a fabricated point
*with a plausible provenance version attached* — indistinguishable, later, from a real one.

It was not exploitable **today**, and that is luck rather than design: `ats_score` is non-NULL on
**0 of 2,460** active rows and `ats_report` on 0, so there was nothing in the cell to serve. W1 and
W2 both still filled it, so the next crawl that scored a row would have armed all four readers.

### A correction to the brief's own numbers

The brief says `ats_score` is non-NULL on **4 of 1,296** rows and that `aj2fixture::moderate-upper`
stores 43 while scoring null. Neither is true of this board any more: the restore described in
`docs/am3-board-restore-and-schema.md` left **2,460 active rows, 0 of them scored**, and the
`aj2fixture::*` rows are gone. Requirement 6's disagreeing row no longer exists — the requirement it
motivated is implemented anyway, because the next one will.

---

## 2 · What was built

**Migration 108** (`108_ats_reports_per_profile`, in both runners) rebuilds `ats_only_reports` with
`UNIQUE(user_id, domain_profile_id, job_id)` plus `scorer_version` and `scored_at`. SQLite cannot
widen a UNIQUE in place, so the table is recreated and refilled; every existing row carries over
with `domain_profile_id NULL`, meaning *"cached before profiles were distinguished"*, which the
reads honour as a last-resort fallback rather than deleting. 0 rows on this database, so the copy is
a no-op here and the code path still has to be right for a deployment that has some.

**One writer.** `storeAtsReportForProfile` in `server.js` replaces all three `UPDATE scraped_jobs`
sites. The defect survived two earlier rounds of work on this code precisely because it was three
copies of one statement: fixing any one of them looked complete.

> ⛔ **It is DELETE-then-INSERT, not `ON CONFLICT`.** SQLite treats NULLs as *distinct* in a unique
> index, so `ON CONFLICT(user_id, domain_profile_id, job_id)` never fires for a user with no active
> profile — every open of the ATS panel would append another row, forever. `WHERE domain_profile_id
> IS ?` is null-safe. `test/atsScoreIsPerProfile.test.js` asserts the SQLite behaviour itself, not
> just the code shape, so the comment cannot quietly become false.

**Readers, in the same order as the table above:**

- **R1** the board `LEFT JOIN`s `ats_only_reports` on `(job_id, user_id, domain_profile_id IS ?)`
  and selects `aor.ats_score AS matchScore`. `mapJobRow` no longer reads `ats_score` at all.
- **R2** `baseAtsScore` / `baseAtsReport` are hard `null`. The field names stay so the response
  shape is unchanged for the desktop and mobile clients that read them — and they were already
  null on 100% of rows, so no client loses anything it was receiving.
- **R3** deleted. There is no narrower version of it to write.
- **R4** deleted as a source; the two that remain (`resumes`, `ats_only_reports`) are scoped to the
  profile with the NULL fallback last.

**The suppression bug, which nobody had named.** W1 skipped any posting whose `ats_score` was
already set — a marker as shared as the value. The second user to crawl a posting was skipped for
having a score they did not have. `hasAtsReportForProfile` asks per `(user, profile)`.

---

## 3 · Requirement 3 — what `scraped_jobs.ats_score` IS

The brief offered two options: compute the band per request, or keep the column as an explicitly
profile-agnostic signal and stop rendering it as the user's score.

**Neither. It is RETIRED.** "Profile-agnostic" would have been a lie about this column: it was never
computed agnostically, it was computed from *one specific candidate's* résumé and then labelled
as belonging to the posting. Keeping it under a new description would preserve the false value and
add a false name.

Concretely: **no writer, no reader, column not dropped.** Old rows keep whatever they hold; the
admin DB inspector still lists the column because it lists all of them; `include_fields=ats_score`
still projects it in SQL and `mapJobRow` drops it, so no API response carries it. Dropping the
column is a separate, purely destructive migration with no reader to protect — it can happen any
time and buys nothing today.

---

## 4 · Requirement 4 — the data gap: per request, and the route that was missing

**The answer is per request, not a backfill.** Scoring is local, free of money, and costs 6.67ms for
one posting — so the surface that can afford it is the one looking at a single job. A backfill would
have to be per *(user, profile)*, i.e. 2,458 rows × every profile, recomputed whenever a résumé
changes; it buys a badge on rows the user may never open.

But the brief's deeper point was right, and worse than it said: **there was no route to the term
list at all**, and it was locked twice.

1. `ATSBadge` renders nothing when the score is null — correctly. A card must not report an absent
   score as a verdict; an earlier task established that and it stands.
2. `onAts` was *also* gated on a score or report existing, so the handler behind the invisible chip
   was a no-op too.

Two independently correct decisions composing into a dead end on 100% of rows. Fixed with:

- **`AtsSlot`** in `JobCard.jsx` — renders `ATSBadge` when there is a score, and otherwise a
  deliberately non-committal **"Check match"** chip: dashed border, muted text, no band colour and
  no band word, because there is no band to report. It appears only when there is somewhere to go.
- **the gate removed** from `onAts`. Opening with an empty payload is the *working* case: `ATSPanel`
  fetches `POST /api/jobs/:id/keywords` when handed no report, which scores against the caller's own
  basis and writes their per-profile cache.
- **`buildAtsPayload` now carries `jobId`,** and `AtsReportPanel` prefers it over the `selectedJob`
  prop. The panel used to take the job to fetch from the JD drawer's state, which is a different
  question — a card click on a board with nothing selected fetched nothing at all. This also fixes
  the history list opening a report for job X while the panel asked the server about job Y.

The badge itself appears on the **next** board fetch, not the moment the panel answers, because it
comes from the board response. That is a deliberately small promise; the term list — the thing that
was unreachable — is on screen immediately.

---

## 5 · Requirement 5 — the `atsScore` sort

It was a **dead control**: `sj.ats_score` is NULL on every row, so `NULLS_LAST` was equal for all of
them and the order collapsed to the recency tie-break. Picking "best match" silently gave you
"newest".

Now sorts on `aor.ats_score` — the caller's own cached score for their active profile. Rows they
have never had scored sort last, which is honest: the control orders what it knows and says nothing
about the rest.

> ⛔ **Not scored per request, and that is measured rather than assumed.** Sorting the whole board by
> score requires scoring the whole board: 2,458 × 6.67ms = **16.4 seconds**. A cache read is the only
> affordable source.

---

## 6 · Requirement 6 — a stored score says what produced it

`scorer_version` and `scored_at` on every stored report, taken from the report's **own** `source`
field and never from today's `LOCAL_ATS_SOURCE` — the same rule `capturedAtsAtApply` already used,
for the same reason: those two differ exactly when a cached report predates a scorer change, which
is the case the column exists to keep straight. v3 and v4 disagree by roughly 17 points on the same
fit.

---

## 7 · Measurements

**Scorer cost** — 300 real postings from this board, term weights and synonyms warm, median
description 5,000 chars:

| | |
|---|---|
| mean | **6.67 ms** |
| median | 6.32 ms |
| p95 | 9.99 ms |
| max | 27.15 ms |
| a board page (50 rows) | 0.33 s |
| the owner's curated board (849) | 5.7 s |
| every active row (2,458) | **16.4 s** |

This **corrects the figures an earlier pass left in these comments** (5.5ms / 279ms / 4.8s / 13.4s),
which were roughly 20% optimistic. The conclusion is unchanged and slightly stronger.

**Board state**, local, 2026-09-18: 2,460 `scraped_jobs` rows, all active; 2,458 with a description;
`ats_score` non-NULL on 0; `ats_report` on 0; `ats_only_reports` 0 rows; `resumes` 0 rows;
`job_applications` 0 rows; `job_role_map` 2,183; 2 users with an active domain profile.

---

## 8 · Verification — the brief's own list, against the running server

`node scripts/cc5PerProfileScores.mjs` (needs `node server.js` on :3001; no model calls, no spend).
It creates a throwaway second profile, restores the original in a `finally`, and deletes the cache
rows it created so it leaves the fixture as it found it.

```
  user A : johndoe (id 14, profile 5)
  user B : sribalajiyellela (id 15, profile 6)
  job    : greenhouse::7737237 — Software Engineer, Metronome Infrastructure @ Stripe

PASS  both users get a report  — 200 / 200
PASS  the chosen posting discriminates between the two résumés at all  — A 4 matched terms, B 1
PASS  the two reports are DIFFERENT  — A score 31 (4 matched), B score 19 (1 matched)
PASS  no backend-only term is reported as MATCHED for the data scientist
PASS  no data-only term is reported as MATCHED for the backend engineer
PASS  one cached row per user, not one shared row  — A 1, B 1
PASS  each row is keyed to its own user's ACTIVE profile  — A -> 5, B -> 6
PASS  a stored score carries the engine that produced it and when  — local_ats_v4 @ 1789704605
PASS  scoring this posting wrote NOTHING to the shared per-job cell
PASS  A asking twice gets A's report back from cache, not B's  — 31 vs A 31 / B 19
PASS  the same user, same job, on a second profile gets a report
PASS  and it is DIFFERENT from the first profile's  — profile 5 -> 31, profile 65 -> 15
PASS  two cached rows for one user and one job, one per profile  — 5:31 65:15
PASS  the original profile's report survived the other profile being scored  — 31 vs 31
PASS  each board serves the caller their OWN cached score as matchScore  — A 31, B 19

ALL PASS
```

> ⛔ **The first version of this harness passed the wrong thing and had to be fixed.** It took
> `ORDER BY job_id LIMIT 1`, which on this board is *HRBP, Consumer Devices @ OpenAI* — an HR role
> neither of the two test résumés shares a single term with. Both users scored 20 with zero matched
> terms, and the run read "identical reports" as "the cache is shared". The posting could not tell
> the candidates apart, so the check had nothing to observe. It now picks from the intersection of
> the two boards, prefers an engineering title, and **asserts that the fixture discriminates before
> reading anything into it.** A fixture that cannot fail is not evidence.

It is in `scripts/harnessBaseline.json` at a floor of **16**, not the 17 above: the last check —
each board serving its caller's own `matchScore` — legitimately SKIPs when the chosen posting is not
on both boards, and that is CC1's membership rule rather than anything CC5 controls.

Two things it does **not** cover, stated so the green is not over-read:

- **The local board is 10 rows per user.** Board membership is CC1's join and `job_role_map` is
  thin locally, so this exercises the score's *plumbing*, not curation at production scale.
- **No browser for the new chip.** The route-to-the-term-list change is pinned by source assertions
  in `test/atsScoreIsPerProfile.test.js` and an esbuild parse of the three changed `.jsx` files; the
  "Check match" chip itself has not been clicked in a real browser.

**The browser harnesses that were run**, individually, because `npm run verify:harness` was killed
for system memory partway through — not by a failure:

| harness | |
|---|---|
| `aj2BoardCursor` | **16/16**, at its baseline floor. The one that matters most: the `atsScore` sort key now names a join alias, and this walks the cursor over the board |
| `ae5BoardUi` | **ALL PASS**, including *"the ATS badge survived, as a band chip inside the card — 8 chips: Strong"* — `AtsSlot` passes a real score straight through to `ATSBadge` |
| `cc5PerProfileScores` | 17/17, above |
| `ag1AtsPanelUi`, `ag2ClaimsUi` | **fail before reaching any code this pass touched**: both hard-code `scraped_jobs id=1974`, which the board restore did not bring back (ids now run 809–4323). Pre-existing environment failures |
| `ah3TermQuality` | 1 failure, *"27 terms outside the closed set reach the skills buckets"*. A scorer-vocabulary finding over 2,457 postings. `git diff services/localAtsScorer.js` has **zero non-comment lines**, so CC5 cannot be its cause |

---

## 9 · Tests that changed meaning, and were not relaxed

| file | what changed |
|---|---|
| `test/atsScoreIsPerProfile.test.js` | **new.** The writers, the readers, the NULL-uniqueness fact, and the client route |
| `test/matchScoreReachesTheClient.test.js` | AJ2 pinned `ats_score → matchScore`. That fix was right about the symptom and wrong about the cure; the file now pins **both** directions — the field must carry a real per-caller score *and* must never carry the shared cell |
| `test/atsRankingHonesty.test.js` | three tests seeded the per-job cell; they seed `ats_only_reports` now. **Two added**: one candidate's score is never stamped onto another's application, and two profiles of one user do not share a stamp |
| `test/applicationResponseOutcome.test.js` | same seed move, same reason |
| `test/profileAtsUiFixes.test.js` | asserted the poll reads `sj.ats_report` and the keywords route reads the per-job cell. Both reversed; the client half is unchanged and still passes |
| `test/localAtsScorer.test.js` | three `LOCAL_ATS_SOURCE` cache gates became two. Pinned at 2 rather than loosened, so *re-adding* a gate also fails: a third would mean somebody reintroduced the cache, and a version check would not make it safe |
| `test/jobsKeysetCursor.test.js` | the fixture gained `ats_only_reports` and the join, because the sort key is written against the board's alias. Left **empty** on purpose — that is every board on day one |

Suite: **2,524 tests, 0 failing** (`npm test`). The two `jobsKeysetCursor` failures present when this pass was
picked up (`SQLITE_ERROR`, from the sort key changing to an alias the fixture did not define) are
fixed.

---

## 10 · What was NOT done

- **The per-job columns are not dropped.** See §3 — no reader, no writer, and dropping them is a
  separate destructive migration with nothing to gain today.
- **The badge does not refresh in place** after the panel scores a row. It appears on the next board
  fetch. Wiring the panel's result back into the board's row cache is a small, separate change.
- **No backfill.** Deliberate, per §4.
- **Mobile is unchanged** and still cannot show *why* a score is what it is — `docs/CURATION_CONSOLIDATION.md`
  records that as its own gap, and CC5 neither closes nor worsens it.
- **`ats_term_weights` still go stale on 2026-10-13**, after which scoring silently reverts to
  unweighted with only a `console.warn`. Untouched here; still the loudest thing on the
  not-in-scope list.
