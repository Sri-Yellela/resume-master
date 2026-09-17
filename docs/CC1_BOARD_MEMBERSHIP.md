# CC1 — Board membership: measured, then changed from EXCLUDING to RANKING

Measured and implemented 2026-09-17. The brief is `docs/CURATION_CONSOLIDATION.md`; this is the
report it asks for plus the verification.

**The change in one line:** a profile's `target_titles` no longer decide whether a posting is on the
board, only where it sits on it.

---

## 1 · What the measurement found

Population: **2,460 active rows** (see the note on the population below — it is not the 1,266 the
brief was written against). Acceptance criterion, from the brief: *a rule that excludes any posting
the owner graded 5 is wrong.*

### The rule under test, and the four candidates

Profile 5 (the owner's shape): `role_family=engineering`, `target_titles=["Software Engineer"]`.

| rule | board rows | graded kept | graded-5 kept | verdict |
|---|---|---|---|---|
| **substring-AND** — what shipped | **405** | 8/30 | **7/12** | ⛔ excludes 5 of the best |
| (a) token-OR | 533 | 22/30 | 12/12 | OK |
| (b) head-noun | 532 | 22/30 | 12/12 | OK |
| (c) title ranks, no title gate | 572 | 30/30 | 12/12 | OK |
| (d) map `role_key` alone | 572 | 30/30 | 12/12 | OK |

The five graded-5 postings the shipped rule excluded, all titled "…Engineer":

- Frontend Engineer, Expansion @ Stripe
- Full Stack Engineer, Fleet Scheduling @ OpenAI
- **Backend Engineer, Credit Decisions @ Stripe** — the scorer's second-highest of the whole corpus
- Applied AI Engineer, Digital Natives @ OpenAI
- Full Stack Engineer, Link @ Stripe

### The filter was ANTI-correlated with the owner's own judgement

Spearman ρ over the graded corpus, scored with the real `scoreAtsLocally` and the real term weights:

| rule | ρ(score, human grade) | ρ(board order, score) |
|---|---|---|
| substring-AND | **−0.1769** | −0.3193 |
| token-OR / head-noun | +0.1894 | −0.0104 |
| no title gate | **+0.5340** | +0.0963 |

⚠ **The ρ(score,human) column is confounded and must not be read as "rule (c) scores better."**
Each rule is measured over a *different* member set — 8, 22 and 30 postings — and a set spanning
more of the grade range can correlate better for that reason alone. What the column does establish
is the sign: the hard filter was **negatively** correlated with the grading it exists to serve,
because the postings it removed were disproportionately the good ones.

⛔ **ρ(board order, score) stays near zero under every rule, and CC1 cannot fix that.** The board's
default order is `discovered_at DESC`. Membership rules change *which* rows are present, never the
*order* they come back in. Making the order track the score is CC2's problem — the brief's own
finding that "the bridge cannot rank: its top band is 217 rows deep and internally ordered by
`discovered_at DESC`". CC1 moved this number from −0.3193 to +0.0963 by removing an
anti-correlation, not by adding a correlation, and that is all it can do.

---

## 2 · What changed

`target_titles` became **two derived rank dimensions** instead of a WHERE predicate.

```
DERIVED_RANK_ORDER = ['q', 'target_title_exact', 'target_title_role', 'experience_levels', …]
```

- `target_title_exact` — every token of some target title appears in the posting title. This is
  **byte-for-byte the predicate that was retired**, so the rows that were the old board still *lead*
  the new one. That is what makes this a reordering rather than a different product.
- `target_title_role` — the **role noun** of some target title appears (`"Software Engineer"` → the
  last meaningful token, `engineer`). Backend / Frontend / Full Stack Engineer rank here: same role,
  different specialisation.

Two keys rather than one, deliberately. One broad key would make "Backend Engineer" and "Software
Engineer" indistinguishable to someone who asked for the latter; one narrow key would bury the five
graded-5 postings at the bottom instead of excluding them, which is barely better. Two keys order
them: the user's own phrasing, then the same role, then everything else. That is the brief's
candidate (b) implemented as ordering.

**Why this is the right rule, and it is not a new argument.** X2 already established it: *a filter
the user SET excludes; a filter DERIVED on their behalf ranks.* The user set `target_titles`. They
did **not** set the substring-AND matching rule — someone who typed "Software Engineer" was silently
taken to mean "every title containing both the token *software* and the token *engineer*". The rule
is derived, so it ranks. `services/jobs/jobQuery.js` carried a comment asserting the opposite
("scope is not the bridge's… profileTitleSql… things the user set"); its second half was wrong and
is now corrected in place.

⛔ **Neither key can ever reach the WHERE clause.** Every other dimension in `buildJobFilters` has an
`else` branch that turns it into a predicate when the value is explicit rather than derived. These
two have no such branch. The asymmetry *is* the fix.

---

## 3 · Verification — real runs against `/api/jobs`

A harness user with the owner's exact profile shape (`role_family=engineering`,
`target_titles=["Software Engineer"]` — the only two fields the board query reads).

```
GET /api/jobs?pageSize=50   HTTP 200
  total 572   page 1/12   required response keys: ALL present
  curation: { applied:true, ranked:true,
              rankedKeys:["q","target_title_exact","target_title_role"],
              total:572, demoted:167 }
```

- **Board: 405 → 572.** The 167 rows the old filter deleted are now *disclosed as demoted* rather
  than silently absent — requirement 3's "the user must be able to see that N rows exist and are
  ranked below" is a number in the response, not a claim.
- **Ordering is monotonic.** Every row on page 1 is an exact-match row; the tier sequence over the
  page is non-decreasing. The old board leads the new one, as designed.
- **`/api/jobs` stays byte-compatible.** `jobs`, `total`, `page`, `pageSize`, `totalPages` all
  present; `curation` was already there and gained two entries in `rankedKeys`.
- **A rank cannot empty a board.** With `target_titles=["Underwater Basket Weaver"]` — a phrase
  matching nothing — the board still returns **572** rows with `reason: none`. Under the old rule
  that profile saw zero, and requirement 6's honest-empty-board concern is now structurally
  impossible for this dimension.

### Graded-corpus survival, on a comparable basis

Only **18 of the 30** graded postings are still active (8 of the 12 graded-5); the rest have been
pruned since the corpus was pinned. Measured over those 18:

| board | graded reachable | graded-5 reachable |
|---|---|---|
| OLD (title AND map) | 2 | **2 of 8** |
| **NEW (title ranks, map still gates)** | 4 | **4 of 8** |
| if the map gate *also* ranked | 18 | **8 of 8** |

Graded-5 reachability **doubled**. It is not 8 of 8, and the reason is not the title rule.

---

## 4 ⛔ THE SECOND GATE IS NOW THE BINDING ONE — requirement 4's answer

The brief asked: *"If a posting with no map row is invisible regardless of title, that is a SECOND
hard gate stacked on the first and it must be reported."* It is, and it is now the larger one.

```
active rows                                     2,460
job_role_map rows (local)                       2,188
active rows WITH a map row                      2,183
active rows with NO map row                       277   <- invisible on EVERY profile
  ...of those titled "…Engineer"                  148
board for an engineering profile                  572
rows no active profile can reach                1,888
```

Every graded-5 posting still unreachable is blocked here, not by a title:

| posting | why |
|---|---|
| Software Engineer, Codex — Enterprise Controls | **no map row** |
| Full Stack Engineer, Fleet Scheduling | **no map row** |
| Software Engineer, Distributed Data Systems — Robotics | **no map row** |
| Applied AI Engineer, Digital Natives | `role_key='data'` |

The 18 active graded postings sit in map buckets `(none) 8 · engineering 4 · general 3 · data 3`.

**Recommendation — DONE as CC1b, see `docs/CC1B_ROLE_KEY_SOFT_NULL.md`.** The same principle
resolves it: an unclassified row is `RANK_UNKNOWN` — *not established* — and the codebase already
holds that "a row must never be hidden purely because we have not classified it — only on an
explicit mismatch once we have." A `LEFT JOIN` with a soft-null predicate and `role_key` as a rank
dimension takes the board to 849 rows and graded-5 reachability to **7 of 8**.

⛔ **CORRECTION: this section originally said "would reach 8 of 8". It reaches 7 of 8.** The 8-of-8
figure came from a measurement in which role mismatches ALSO merely ranked — i.e. with role scoping
removed entirely and all 2,460 active rows on every profile's board, which is exactly what the
brief's "WHAT NOT TO DO" warns against and not what CC1b does. The eighth posting
(`Applied AI Engineer, Digital Natives`) is classified `role_key='data'` at 0.795 confidence by a
deliberate taxonomy in which ML/AI is `data` — the same bucket `classifyTitle` gives "Machine
Learning Engineer". `docs/ak2-ats-bands.md` §5 already recorded that as a **profile-routing**
question, not a scoring or membership one. Reaching it needs a Data Science profile, not a looser
board.

⛔ So: the acceptance criterion is met **for the rule under test** — the title rule now excludes
nothing at all — and is **not** met for the board as a whole. Stating it the other way round would
be the more comfortable sentence and the false one.

**Update after CC1b:** the board now reaches **7 of 8**, and the eighth is out because it is
classified into a role this profile did not declare. That is the scope working, not the gate
failing.

---

## 5 · Dependents, with verdicts

| dependent | verdict |
|---|---|
| `GET /api/jobs` (board) | **CHANGED** — titles rank. The subject of CC1. |
| `GET /api/jobs/poll` | **UNCHANGED, deliberately.** Drives new-job notifications; widening it changes how often a user is interrupted, which is not CC1's question. Still uses `profileTitleSql`. |
| `GET /api/jobs/pending` | **UNCHANGED, deliberately.** A work queue, same reasoning. |
| Saved ★ tab | **UNCHANGED** — and now trivially so: with no title predicate there is nothing to opt out of. Still skips the `role_key` join and the bridge. |
| `jobCursor` | **UNCHANGED, and it did not need to change.** `buildOrderKeys(sort, rankKeys)` already prefixes derived rank keys onto the default sort, and `rank.sql` is derived from `rank.keys`, so ORDER BY and the keyset cursor cannot disagree. Requirement 5's "must not fork that" is satisfied by using the existing seam rather than adding one. |
| `buildParams` | **UNCHANGED** — still the one param builder. |
| `routes/adminDb.js` curation trace | **UNCHANGED** — it calls `profileTitleSql` to *explain* narrowing. It now over-reports for the board; folding the rank keys into that trace belongs with CC2's disclosure work. |
| `test/profileLifecycleSearchGating.test.js` | **REWRITTEN, not relaxed.** It used to assert all three paths apply the hard filter. It now asserts the board applies **no** title predicate **and** ranks by the titles — both halves, because dropping the filter without adding the ranking is the regression it exists to catch. |

No migration. Nothing was added to or removed from the schema.

---

## 6 · Corrections to the brief

Three premises were stale or wrong. All were caught by measuring them, which is the pattern
`docs/CORRECTIONS_REGISTER.md` already names.

| the brief says | measured |
|---|---|
| "`job_role_map` holds **5 rows** locally… any UI verification of curation done locally is measuring fixtures" | **2,188 rows.** A crawl repopulated it (`classifyForIngest` writes at ingest). Local verification is no longer measuring fixtures — but **277 active rows still have no map row**, because `am3RestoreBoard` restores `scraped_jobs` without it. |
| "1,266 active rows"; "960 reachable by NEITHER" | **2,460 active**, **1,888** reachable by neither. The board grew when a crawl ran; every count in the brief is against the smaller population. |
| "test baseline 2443" (`CORRECTIONS_REGISTER.md`) | **2,475** at `eecbe09`, **2,484** now. The register's own figure was already stale. |

One more, not a correction but worth recording: the résumé basis contributes almost nothing to the
score, which caps how much any membership rule can achieve.

⛔ **CORRECTION (made in CC3): this section originally said "`basis.skills` is 0 on both active
profiles". That was wrong, and it was my measurement harness's fault.** `buildRuntimeAtsBasis` reads
`signalProfile.skills` — a PARSED array — and the harness handed it the raw
`profile_simple_apply_profiles` row, which carries `skills_json`. Through the real
`loadSimpleApplyProfile`: **profile 5 has 28 terms**, profile 6 genuinely has 0 (no simple-apply row
at all).

Every conclusion above is unaffected, and that was checked rather than assumed: with the corrected
basis, **0 of 30 graded scores differ** and the band distribution over all 881 enriched rows is
identical. The reason the 28 terms change nothing is sharper than their absence would be — they are
`["javascript","java","technical","university","college","near","provided","tasks", …]`, the noise
the brief's own out-of-scope note describes, and the scorer's rejector discards essentially all of
them. See `docs/CC3_SYNONYMS_WIRED.md` §4.

---

## 7 · What was NOT done, and why

- **The `job_role_map` INNER JOIN.** Reported above as requirement 4 asks. ✅ **Done as CC1b** in the
  following commit — `docs/CC1B_ROLE_KEY_SOFT_NULL.md`.
- **A screenshot of the board.** CC1 changes membership and ordering, and contains **no client
  change at all** — verification was done at the API, which is where the change lives. A screenshot
  would need a harness user seeded with a base résumé (the board otherwise renders "Upload a profile
  resume" rather than listings), and a contrived board is weaker evidence than the 572-row,
  monotonically-ordered API response above. Flagged rather than faked.
- **The ATS/curation audit written to `docs/`.** The brief opens by requiring this. **It could not be
  done: that audit was in another session's scratchpad and is not in this one.** Its two derived
  artifacts — `docs/CURATION_CONSOLIDATION.md` and `docs/CORRECTIONS_REGISTER.md` — are both in
  `docs/` already, and CC1's own measurements independently re-derive the figures it carried
  (they are in §1 and §4 above). Whoever holds that session should still write it out.
