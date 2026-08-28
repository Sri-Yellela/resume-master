# AK1 Phase 1 — Audit of the local ATS engine

Read-only. Nothing in this phase changes behaviour. Every number below is from a real run against
`data/resume_master.db` (1291 postings) using the active domain profile.

Baseline re-derived before starting: **`npm test` = 1973 pass / 0 fail**. (The brief said 1915; the
suite has grown since. 1973 is the number Phase 2 and 3 must not regress. Introduced defects = 0.)

---

## 1. The scoring paths — there is exactly one scorer, and the swipe feed can use it today

`services/localAtsScorer.js` exports `scoreAtsLocally()`. It is the **only** scoring implementation.
Four call sites, all in `server.js`, all the same function:

| # | Site | `resumeText` fed to the basis | Needs a generated artifact? |
|---|------|------------------------------|------------------------------|
| 1 | `server.js:3666` — scrape-time backfill | base resume | **No** |
| 2 | `server.js:7024` — `/api/.../keywords`, the ATS-only report | base resume, from the request body | **No** |
| 3 | `server.js:7261` — profile-template self-score | base resume | **No** |
| 4 | `server.js:7638` — post-generation scoring | `stripResumeHtml(formattedHtml)` — the **generated** resume | Yes, by construction |

The scorer is genuinely local and deterministic: no `messages.create`, no `callModel`, no network.
Only site 4 depends on a generated document, and only because it deliberately scores the artifact it
just produced.

**The swipe feed's free fit signal is possible today, with no generation step.** Site 2 is already
exactly that call — `scoreAtsLocally({ job, runtimeBasis })` where the basis is built from the base
resume. Nothing blocks it. Three caveats, none structural:

- The endpoint 400s unless the caller passes `resumeText`; the feed would want it read server-side.
- It writes a per-user `ats_only_reports` cache row on every miss.
- **Cost is 10.3 ms/job.** Fine for one card. For ranking the whole board it is 13.4 s.

**`scraped_jobs.ats_score` is NULL on all 1291 rows.** The scrape-time path (site 1) has never
persisted a score on this board, so any board ranking built on that column today ranks by NULL.

## 2. The formula

From `scoreAtsLocally`, `services/localAtsScorer.js:606-668`. Four components, fixed weights:

```
skillScore      = (matchedSkills + matchedCompetencies) / (jobSkills + jobCompetencies) * 50
verbScore       = (matchedVerbs + matchedGenericVerbs) / (jobVerbs + genericVerbs) * 15
experienceScore = fit ? 25 : (no years requirement detected ? 22 : 8)
hardScore       = max(0, 10 - hardConstraintMisses * 5)
score           = clamp(round(sum), 0, 100)
```

`ratio()` returns **1 when the denominator is 0** — a posting from which nothing was extracted
scores a full 50/50 on skills. That is the fabricated-score path the brief's item 4 asks about, and
it is live today.

Every term is weighted identically. `python` and `systems` are worth the same; a missing required
skill and a missing nice-to-have are worth the same. There is no notion of a term mattering.

## 3. Term extraction after AG1 and AH3 — both hold

Sampled 10 real postings spread across the board (deterministic stride over the whole board).

- **AG1 (fragments) holds.** No prose fragments in any bucket. Every emitted term is a clean noun
  phrase — `wpa_supplicant`, `Nitro Enclaves`, `program management`. The sliding-window artifacts
  ("and at scale") are gone.
- **AH3 (categorisation + generic noise) holds.** Competencies land in the competency bucket
  (`cross-functional collaboration`, `communication`), never in skills. Generic verbs (`Delivered`,
  `Drove`, `Partnered`, `Managed`, `Reported`, `Grew`) appear in `action_verbs_generic` and are
  never reported as gaps.

Precision of the terms themselves is high. **Precision of the match verdict is not** — see §6.

Two observations that matter for Phase 2:

- **The verb component carries no ranking signal.** Across all ten postings the matched verbs were
  almost always the identical pair `Built, Collaborated`, and the missing list was near-identical
  (`Designed, Developed, Led, …`). A component that returns the same value for every job cannot
  order anything, yet it holds 15 of the 100 points.
- **The "closed set" is only half closed.** `candidateTermsFromJob` admits `skills_json` entries
  **unconditionally** (`localAtsScorer.js:391`), before any registry check. The registry pass is
  additionally gated on the term appearing in the job text. So the effective vocabulary is
  open-ended and LLM-authored, not the curated registry `skillVocabulary.js` describes.

## 4. Shared-extractor check — they are NOT the same code, and the dependency runs the other way

The brief asks whether changing the ATS extractor would disturb `skills_json` (99.8% coverage) and
`company_technographics` (8507 rows). It would not.

- `services/jobs/enrichJob.js:114` `extractSignals()` is an **LLM call** (`callModel`, `MODEL_HAIKU`).
  It produces `skills_json` and, via `upsertTechnographics`, `company_technographics`.
- `services/localAtsScorer.js` is **deterministic** and shares no extraction code with it.

The arrow points the other way: `skills_json` is an **input** to the scorer (`jobSkillTerms`,
`localAtsScorer.js:549`). Verified on the corpus: 17766 term instances, typed `hard` 10389 /
`soft` 7377 / bare 0.

**Blast radius of Phase 2 is therefore confined to the scorer.** No enrichment column, no
technographics row, and no company KB layer is written by any code path in `localAtsScorer.js`.
The reverse risk is the live one and must be respected: enrichment re-runs silently change scores.

## 5. Distribution — the engine has no discriminating power

All 1291 jobs scored against the active profile's base resume.

```
min 18   p10 20   p25 25   median 37   p75 38   p90 40   max 55
mean 33.4   sd 7.7   IQR 13   distinct scores 30
  15-19    69 ###########
  20-24   248 ######################################
  25-29    28 ####
  30-34     4 #
  35-39   763 ######################################################################################################################
  40-44   169 ##########################
  45-49     9 #
  55-59     1
```

**Nothing scores above 55.** The top 45 points of the scale are unreachable.

Decomposing the variance says what is actually doing the ranking:

| component | sd across board | correlation with final score |
|---|---|---|
| skill (0-50) | 2.01 | **r = 0.21** |
| experience (8/22/25) | 7.53 | **r = 0.96** |
| hard constraints (0-10) | 0.39 | r = -0.02 |
| **total** | **7.66** | |

**The score is 96% the experience flag.** The bimodality is exactly the 17-point experience cliff:
346 jobs get `exp=8`, and the low hump (69+248+28 = 345) is that same set. Within an experience
bucket the spread is sd 2.1.

This is not a fixture artifact. Re-running with the profile's years forced:

```
years=null  med 37  sd 7.66     years=3   med 37  sd 7.12
years=5     med 37  sd 6.13     years=10  med 37  sd 2.87
```

Once experience is satisfied for most jobs (years=10), **the entire remaining spread is sd 2.87 on a
0-100 scale.** That is the engine's true discriminating power from skills, and it is noise.

The cause is visible in the match ratio: **median 0.000**. More than half of all postings match
*zero* extracted terms; p75 is 0.05; the maximum anywhere on the board is 0.333, so the 50-point
skill component never exceeds 16.7.

Ranking on this number today is not meaningfully better than ranking at random.

## 6. Confidently wrong — a reproducible false-match generator

This is the finding with the highest cost, and it is independent of the distribution problem.

`hasTerm` (`localAtsScorer.js:565`) tries the whole phrase, then **falls back to "every word appears
somewhere in the resume, in any order, at any distance"**:

```js
const parts = key.split(" ").filter(Boolean);
if (parts.length > 1) return parts.every(part => text.includes(` ${part} `));
```

Three lines reproduce the worst case:

> Resume: *"I design **learning** materials for a coffee **machine** vendor. I ran a **security**
> **program** for physical access badges."*
> Job: ML Engineer, requiring `machine learning`, `computer vision`, `security program`.
> **Result: score 83, `MATCHED: ['machine learning', 'security program']`.**

Measured on the real board against the real base resume: of 320 multi-word matches, **73 (22.8%) are
scattered-word artifacts, not real phrase matches.** The most frequent:

```
  41x  "software engineering"       11x  "systems engineering"
   3x  "engineering management"      2x  "knowledge management"
   1x  "state management"            1x  "systems administration"
```

`engineering management` is credited because the resume reads "business administration management";
`state management` because it reads "city state". Every one of these inflates the numerator *and*
tells the user they have a skill they do not have.

## 7. Two blockers Phase 2 must design around

**(a) `category` is NULL on all 1291 rows.** The brief asks for weights scoped per role family.
There is no role-family column populated on this board. Available substitutes: `experience_level`
(100% populated — mid 610, senior 458, lead 171, entry 35, executive 12, intern 5) and
`normalized_title` (100% populated, 765 distinct — too sparse to scope by directly).
A role family must be **derived** before it can scope anything.

**(b) The corpus is a long tail of singletons, so naive TF-IDF would invert the intended effect.**

```
1289 postings, 6123 distinct normalised terms
  appear in exactly 1 posting : 4279  (69.9%)
  appear in <= 3 postings     : 5373  (87.8%)
  appear in >= 5% of corpus   :   18
```

The singletons are LLM phrasings, not rare high-signal skills: `passion for mission`,
`japanese fluency`, `receptivenes to feedback`, `ability to work with diverse team`,
`navigation of complex organization`. **Pure IDF hands these maximum weight** — the opposite of what
the brief wants. Any weighting needs a document-frequency floor, and terms below it must be excluded
from the weighted score rather than trusted.

The head of the distribution is what a weighting should correctly demote, and it is mostly soft:
`cross functional collaboration` 39.6%, `communication` 34.8%, `problem solving` 16.7%,
`stakeholder management` 15.7%, `python` 13.3%.

## 8. Lower-severity notes

- `ratio()` returning 1 on an empty denominator is the fabricated-50 path (§2).
- `normaliseAtsTerm` strips a trailing `s` from any word of 4+ chars
  (`localAtsScorer.js:165`), producing keys like `cros`, `analysi`, `proces`, `busines`. Matching is
  still symmetric so it does not cause wrong verdicts today, but the keys are mangled and it is a
  latent collision source once weights are keyed on them.
- `job.category` is joined into `jobText` at `localAtsScorer.js:611` and is always NULL.
- The active profile's base resume is a placeholder (`john doe fakeemail gmail com`). Absolute score
  levels in §5 should be read with that in mind; the *mechanisms* in §5 and §6 are independent of it.

---

## What Phase 2 has to fix, in priority order

1. **The false-match fallback in `hasTerm`** (§6). Highest trust cost, smallest change, and it is a
   correctness bug rather than a modelling choice.
2. **The experience cliff dominating the score** (§5). A single binary flag holding r=0.96 of the
   ranking is why the ordering is meaningless.
3. **Term weighting** (§7b), with a DF floor, a derived role family (§7a), and a recompute timestamp.
4. **The decline-to-score guard** (§2), replacing the fabricated 50 on zero extracted terms.
