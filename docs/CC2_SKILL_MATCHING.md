# CC2 — the bridge's skill matching rule, and the `'[]'` MISS

Implemented 2026-09-17, after CC1 and CC1b. Brief: `docs/CURATION_CONSOLIDATION.md`.

**The change in one line:** a profile's skill term now matches as a **whole word inside** a stored
skill phrase instead of having to *be* the whole phrase, and an empty extraction is ranked as
unknown rather than as a mismatch.

---

## 1 · The defect, measured

The rule was `sj.skills_json LIKE '%"<skill>"%'`. The quotes make it **whole-value equality**: the
term had to be the entire stored array element. Measured against this board's **4,775 distinct
skill values**, of which **85% are multi-word** and **71% appear exactly once**:

| term | exact value | whole word inside a value |
|---|---|---|
| `api` | **0** | **33** |
| `communication` | 1 | **41** |
| `machine learning` | 1 | **17** |
| `sql` | 1 | 6 |
| `python` | 1 | 1 |

**`api` matched nothing**, on a board holding 33 values that mention it (`stripe api`,
`api design`, `api product sales`). The head of the distribution is phrases, not tokens —
`cross-functional collaboration` 345, `communication` 288, `stakeholder management` 132, and
`python` only 119 — so whole-value equality can only ever reach the handful of values that happen
to be exactly one term long.

### ⛔ A correction to the brief's premise

The brief says *"skills_json coverage is 1,263 / 1,266 active = 99.8%"* and that the 37% figure was
"stale and wrong by 2.7×". **Both are now true of different populations, and the 99.8% is the stale
one.** Measured today:

```
active rows                    2,460
skills_json IS NULL            1,579      <- unenriched
skills_json non-empty            881      = 35.8%
  ...of the PRE-CRAWL 882 rows   881      = 99.9%   <- the board the brief measured
```

A crawl ran during this session and added 1,578 unenriched postings, so **the enrichment backlog is
real again** and coverage is back to ~36%. The brief's 99.8% was correct for its board; it is not
correct for this one. The *constraint* the brief identifies — the comparison rule, not the data — is
unaffected either way, because the rule is measured over the enriched rows.

---

## 2 · The rule, and why not the obvious fix

Four patterns per spelling, using `"` and ` ` as boundaries:

```
%"term"%    the value IS the term
%"term %    the value STARTS with it      ("machine learning pipelines")
% term"%    the value ENDS with it        ("stripe api")
% term %    the term is in the middle     ("api design patterns")
```

**A bare substring (`%term%`) is the obvious fix and it is wrong in this vocabulary, measurably.**
Every one of these is a real stored value:

| term | naive substring credits it to | verdict |
|---|---|---|
| `api` | `"stripe capital knowledge"` (c‑**api**‑tal) | ⛔ |
| `java` | `"javascript"` | ⛔ |
| `sql` | `"postgresql"`, `"mysql"`, `"pl/sql"` | ⛔ |
| `python` | `"backend languages (python, go, rust, typescript)"` | arguable |

AG1 spent a session removing exactly this class of artifact — a résumé reading *"I design learning
materials for a coffee machine vendor"* credited with **machine learning**, 22.8% of all multi-word
matches at the time.

### ⛔ The coffee machine, run as the brief requires

| rule | coffee prose | `"machine learning pipelines"` | `java` → `["javascript"]` |
|---|---|---|---|
| whole-value (before) | no | **no** ← the defect | no |
| **word-boundary (after)** | **no** | **MATCH** | **no** |
| naive substring | **⛔ YES** | MATCH | **⛔ YES** |

All seven guardrail cases pass, pinned in `test/boardSkillMatching.test.js`.

**Note what is being matched, because it is why this rule can be simpler than the scorer's:** the
bridge matches `skills_json`, a list of **already-extracted skill phrases**, not free prose. AG1's
defect was a term mined from prose. The prose case is still asserted — if a future change ever
points this rule at a description column, that test is what fails.

### ⛔ The compact-JSON assumption, which is load-bearing

`% term %` is safe only because `JSON.stringify` emits no space around its commas, so a space can
occur only *inside* a value. That is what makes `["machine","learning"]` unable to be credited with
`machine learning`. A pretty-printing writer would break it; nothing writes one today, and the test
asserts both the compact and the space-after-comma spellings.

### Requirement 2 — the scorer's normaliser, imported

`normaliseAtsTerm` is imported from `services/localAtsScorer.js`; there is **no third
normalisation**. Both the raw term and its normalised form are tried, deduplicated — which is what
reaches a stored `"ci/cd tooling"` from a profile term `CI/CD` (raw) and a stored `"ci cd tooling"`
from the same term (normalised), without either side re-implementing the other's rules.

No import cycle: `localAtsScorer` imports only `skillVocabulary` and `shared/atsBands`.

### The gap this accepts, measured

Punctuation is not a boundary, so a term delimited by `/` or `-` *inside* a value is still missed:

| term | reached | missed | examples missed |
|---|---|---|---|
| `api` | 33 | 4 | `api-first products`, `api-based integrations` |
| `machine learning` | 17 | 3 | `ai/machine learning`, `machine learning-based fraud tools` |
| `sql` | 6 | 1 | `pl/sql` |

Closing it needs the **stored** side normalised, which in SQL means a `REPLACE` chain — a partial
re-implementation of `normaliseAtsTerm` in a second language, i.e. precisely the third
normalisation requirement 2 forbids. So the gap is **accepted and recorded** rather than closed the
cheap way. The honest fix is a normalised column written at enrichment time: a migration, and its
own task.

---

## 3 ⛔ Requirement 4 — the `'[]'` bug: fixed, and currently unreachable with real data

The rank read `WHEN sj.skills_json IS NULL THEN RANK_UNKNOWN`, so `'[]'` fell through to
`RANK_MISS`: a row whose enrichment **ran** and legitimately found no skills was ranked as an
**explicit mismatch**. Fifth NULL-propagation shape in this codebase, second in the
"unknown treated as mismatch" direction.

Fixed, and asserted in **both** directions plus the whitespace spellings (`'[ ]'`, `'[\t]'`), and on
**both** paths — the derived rank and the explicit filter must not disagree about what "unknown"
means, since a row ranked as a mismatch on one path and kept on the other is invisible to both.

**But: 0 rows on this board hold `'[]'`.** `enrichJob` writes `signals.skills.length ?
JSON.stringify(signals.skills) : null` — NULL, never `'[]'`. The brief verified the bug on a
**fixture** (`aj2fixture::weak-boundary`). So it is real in code and not currently reachable with
real data. Fixed anyway: it is one line, and the next importer that writes `'[]'` would otherwise
silently rank every such row as an explicit mismatch. Saying it was a live production defect would
have overstated it.

`skills_exclude` got the same two corrections — otherwise "do not show me api roles" would fail to
exclude the 33 values that merely *mention* api, which is the same defect wearing a negation.

---

## 4 · Verification

### Match rate, over the 881 enriched rows

| term set | terms | before | after | delta |
|---|---|---|---|---|
| the owner's derived skills | 2 | 48 | 48 | **+0** |
| a multi-word-heavy set | 6 | 467 (53.0%) | **665 (75.5%)** | **+198** |
| punctuated terms (`CI/CD`, `REST APIs`) | 2 | 12 | **27** | +15 |

⛔ **The owner's own set does not move, and that is the honest headline.** Their derived skills are
`["javascript","java"]` — both **single words**, so whole-value equality was already reaching
everything a word-boundary rule can. CC2 fixes the *rule*; whether a given profile benefits depends
on whether its terms are multi-word. The brief's "217 of 1,266 rows (17%)" was measured with a
different term set on a different board.

### ⛔ Requirement 6 — the Strong-row demotion count cannot be reproduced

The brief asks for "it demotes 24 of 69 Strong rows … report the same figures after the change."
Measured against profile 5 over all 881 enriched rows:

```
band distribution:  weak 851 · moderate 30 · STRONG 0
Strong rows demoted by the skills dimension:  BEFORE 0 of 0   AFTER 0 of 0
```

**There are no Strong rows at all**, so the before/after is 0 of 0 and the brief's 24-of-69 is not
reproducible on this board. The reason is upstream and the brief already names it in its own
out-of-scope list: **`basis.skills` is 0** — the résumé basis has no extracted skills, so the
scorer has almost nothing to score with. That is the two-extractors problem
(`SKILL_HINTS`, noise suppressing `resumeDepthWarning` at `MIN_PROFILE_SKILLS: 8`), and no
matching-rule change can move it.

### ⛔ Requirement 5 — the bridge still cannot rank, and ρ proves it

ρ(board order, scorer score), using the **real** rank vector and the **real** tie-breaker, over the
453 scoreable rows:

```
BEFORE  whole-value      rho = 0.1889
AFTER   word-boundary    rho = 0.1806
```

**CC2 improved the match rate by 42% relative and moved ρ nowhere — slightly down, within noise.**
That is not a disappointing result, it is the answer to requirement 5, and it is structural:

```
skills dimension over all 2,460 active rows:
  rank 0 (match)   665
  rank 1 (unknown) 1,579
  rank 2 (miss)    216
```

Three values on five dimensions, compared lexicographically, so rows tie in **blocks of hundreds**
and the tie-breaker is `discovered_at DESC` — recency, which has nothing to do with the score. The
top block is **665 rows deep**. CC2 changed *which* rows are in the top block; it did not make the
block an ordering.

**So, as the brief instructs: this cannot be fixed here, and it is scoped separately rather than
half-done.** Making the board's order track the score is a scoring change — the rank vector would
need to carry a magnitude, not a bucket — and it touches the cursor (`jobCursor`'s keys must stay
comparable one at a time), the disclosure, and the score's own availability (`ats_score` is non-NULL
on 4 rows; see CC5). It is the single highest-leverage item left in this programme.

### Requirement 3 — `MAX_DERIVED_SKILLS`, and why it stays at 6

| cap | patterns bound | enriched rows matched | median query |
|---|---|---|---|
| 6 | 24 | 402 of 881 | 16.4 ms |
| 12 | 52 | 411 of 881 | 33.6 ms |
| 24 | 108 | **881 of 881** | 40.4 ms |
| 29 | 124 | 881 of 881 | 38.0 ms |

**Raising the cap dissolves the signal.** At 24 terms the dimension matches **every** enriched row,
which is exactly equivalent to not having the dimension at all — while costing 2.5× the query time.
The cap is **unchanged**, and this is the measurement that says so rather than a preference.

The rule itself costs 6 → 28 bound patterns and **5.0 ms → 12.0 ms** median over a full 2,460-row
scan. Acceptable, and stated so it can be re-checked if the board grows.

---

## 5 · Dependents, with verdicts

| dependent | verdict |
|---|---|
| `/api/jobs` derived rank | **CHANGED** — the point of the task. |
| `skills_include` as an EXPLICIT filter | **CHANGED consistently** — same whole-word rule, same `'[]'`-is-unknown treatment, so the two paths cannot disagree. |
| `skills_exclude` | **CHANGED** — same two corrections, negated. |
| `computeSkillsFacet` | **UNCHANGED** — it aggregates stored values in-app and never used this predicate. |
| `q` rank (`Q_MATCH_COLUMNS` includes `skills_json`) | **UNCHANGED** — a deliberately loose free-text search over five columns; tightening it is a different question. |
| the scorer (`C`) | **UNCHANGED** — it already had proximity, the rejector and the registry. CC2 borrowed its normaliser, nothing else. |
| `MAX_DERIVED_SKILLS` | **UNCHANGED at 6**, on the measurement above. |

No migration. No schema change.

---

## 6 · What this does not fix

- **The punctuation gap** (§2), which needs a normalised stored column.
- **`basis.skills = 0`**, which caps what any of this can achieve and is the two-extractors task.
- **The bridge's inability to rank** (§4), now measured twice and scoped separately.
- **The enrichment backlog**: 1,579 of 2,460 active rows have no skills at all, so they rank
  `UNKNOWN` on this dimension whatever the rule. That is `ENRICH_DAILY_MAX_ROWS` working through a
  fresh crawl, not a defect.
