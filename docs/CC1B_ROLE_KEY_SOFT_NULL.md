# CC1b — the role join stops hiding what nobody classified

Implemented 2026-09-17, immediately after `docs/CC1_BOARD_MEMBERSHIP.md`, which found this gate and
was scoped to report it rather than fix it.

**The change in one line:** a posting nobody has classified is now on the board and ranked last
instead of being invisible; a posting classified into a role the profile did not declare is still
excluded.

---

## 1 · The defect

The board's scope was `JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?` — an
**INNER JOIN on a derived table**. It conflated two states the codebase's own rank vocabulary
insists are different:

| state | what an INNER JOIN did | what it should mean |
|---|---|---|
| classified into another role | excluded | **explicit mismatch** — exclusion is fine |
| **never classified at all** | excluded | **not established** — must not hide the row |

`services/jobs/jobQuery.js` already spells the rule out for three other columns, and `server.js`
repeats it verbatim for `work_type` / `employment_type` / `category`:

> *A row must never be hidden purely because we have not classified it — only on an explicit
> mismatch once we have.*

`role_key` was the one column that got a hard join instead of that soft-null predicate.

Measured, 2,460 active rows:

```
active rows with NO job_role_map row       277     invisible on EVERY profile
  ...of those titled "…Engineer"           148
board for an engineering profile           572
```

`am3RestoreBoard` restores `scraped_jobs` without `job_role_map` (`docs/am1-recovery.md` records the
table losing 1,286 rows to the cascade), so **a restore silently un-boards a large share of what it
restores** — and nothing says so, because the rows are present, active, and simply unreachable.

Three of the four graded-5 postings CC1 still could not reach were in that set.

---

## 2 · The change

```sql
-- before
JOIN      job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?
WHERE     sj.is_active = 1

-- after
LEFT JOIN job_role_map jrm ON jrm.job_id = sj.job_id AND jrm.role_key = ?
WHERE     sj.is_active = 1
  AND (jrm.role_key IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM job_role_map m WHERE m.job_id = sj.job_id))
```

Plus a fourth derived rank key, `role_key`, ahead of CC1's two title keys in `DERIVED_RANK_ORDER`
(the declared role is coarser than the words used for it):

```js
CASE WHEN jrm.role_key IS NOT NULL THEN RANK_MATCH ELSE RANK_UNKNOWN END
```

### ⛔ `role_key` stays in the ON clause, and that is a correctness requirement

`job_role_map`'s primary key is **`(job_id, role_key)`** — a job *may* hold several buckets. Joining
on `job_id` alone would emit one board row per bucket and **duplicate postings**. With `role_key` in
the ON clause at most one row can ever match. No job holds more than one bucket today, but the
schema permits it, and a duplicate-emitting board is not a failure anyone would read as a join bug.

The cost is that `jrm.role_key IS NULL` now means *either* "never classified" *or* "classified as
something else" — which are exactly the two states that must be told apart. Hence the `NOT EXISTS`,
one indexed probe on the primary key.

### Why `RANK_MISS` is unreachable on this key, deliberately

The WHERE clause has already dropped explicit mismatches, so the expression can only produce
`RANK_MATCH` or `RANK_UNKNOWN`. That is why it contributes **nothing** to `demotedSql`, which counts
`RANK_MISS` only — and correctly so: an unclassified row has not been judged, so reporting it as
"demoted" would be a claim nobody made. Written three-valued anyway so every rank dimension shares
one vocabulary.

---

## 3 · Verification — real runs against `/api/jobs`

A harness user with the owner's profile shape, walking **every** page.

```
total                       849      (CC1: 572)
rows walked                 849
DISTINCT rows walked        849   -> duplicates: 0
curation: { applied:true, ranked:true,
            rankedKeys:["q","role_key","target_title_exact","target_title_role"],
            total:849, demoted:372 }
```

| what is on the board | rows |
|---|---|
| `role_key = engineering` (the declared role) | 572 |
| **no map row** — not established | **277** ← CC1b admits these |
| `role_key` = something else | **0** ← scope stays hard |

- **Zero duplicates across all 849 rows.** The ON-clause decision held.
- **Ordering is monotonic**: page 1 is entirely declared-role rows; the unclassified follow.
- **Graded corpus: 4 → 12 reachable, graded-5 4/8 → 7/8.**

### The one remaining graded-5 is not a membership defect

`Applied AI Engineer, Digital Natives` is classified `role_key='data'` — an *explicit* mismatch for
an engineering profile, so CC1b correctly leaves it out. And it is not a classifier bug either:

```
classifyTitle("Applied AI Engineer, Digital Natives") -> data, 0.795, strong_anchor
classifyTitle("Machine Learning Engineer")            -> data, 0.795, strong_anchor
```

That is a deliberate taxonomy in which ML/AI is `data`, and the project already recorded the
consequence — `docs/ak2-ats-bands.md` §5: *"ML/AI postings should be scored against a Data Science
`domain_profile`, not the engineering one. This is a profile-routing question, not a scoring one."*
The brief says the same thing in CC1's defect statement. **Reaching 8 of 8 is a profile-routing
task, not a membership one**, and forcing it here would mean letting explicit mismatches onto every
board — which is the thing the brief's "WHAT NOT TO DO" warns against.

---

## 4 ⛔ A correction to `docs/CC1_BOARD_MEMBERSHIP.md`

That document — written by me, one commit earlier — said this fix *"reaches 8 of 8"*. **It reaches
7 of 8.** The 8 of 8 figure came from a measurement in which role mismatches ALSO only ranked, i.e.
with role scoping removed entirely and all 2,460 active rows on every board. That is not what CC1b
does and not what should be done. The claim is corrected in place in that file.

---

## 5 · Dependents, with verdicts

| dependent | verdict |
|---|---|
| `GET /api/jobs` (board) | **CHANGED** — 572 → 849 for an engineering profile. |
| Saved ★ tab | **UNCHANGED** — still drops the join entirely. The rank key is only requested when `!savedTab`, since the alias does not exist there. |
| `/api/jobs/poll`, `/api/jobs/pending` | **UNCHANGED** — they never joined `job_role_map`; they narrow by `profileTitleSql` only, and that stands per CC1's verdict. |
| keyset cursor | **UNCHANGED and correct.** The new key is just another expression in `rank.keys`; `orderByClause` and `cursorPredicate` are both generated from that one list. |
| `rank.demotedSql` | now references `jrm.role_key`. Only the board reads it, and the board defines the alias. Contributes 0 to the count by construction (see §2). |
| facet counts | **follow the board**, because `resolveFacetDimensions` runs against the same join and WHERE. A facet that counted the old population would have disagreed with the list. |
| `routes/adminDb.js` curation trace | **still over-reports**, unchanged from CC1's verdict — it explains narrowing via `profileTitleSql` and now knows about neither change. Belongs with CC2's disclosure work. |

No migration. No schema change. `services/profileTitleFilter.js` is untouched and still the matcher
for the queues.

---

## 6 · What this does not fix

- ~~**Nothing backfills `job_role_map`.**~~ **DONE 2026-09-18** — `scripts/backfillJobRoleMap.mjs`,
  reported in `docs/ROLE_MAP_BACKFILL.md`. All 277 classified; the engineering board went
  **849 → 655**, and the rows that left are the ones that were only ever there because nobody had
  said what they were (26 sales, 33 PM, …).

  ⛔ **And the function named above is the wrong one.** `classifyForIngest` returns null below 0.75
  and nothing else — it does **not** carry the strong-white-anchor → `'general'` policy that the
  ingest path actually applies through `classifyJob`. Following this note literally would have left
  70 rows unclassified and made the backfill disagree with every future crawl. The backfill uses
  `classifyJob`, which applies the same 0.75 threshold *plus* ingest's fallback.
- **The 849-row board is not ordered by score.** CC1b adds members; it does not make the ordering
  track the scorer any more than CC1 did. That remains CC2's "the bridge cannot rank".
- **A screenshot.** Same reasoning as CC1: no client change, and verification is at the API where
  the change lives.
