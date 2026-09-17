# Curation Consolidation — five tasks, in order

Derived from the ATS/curation audit of 2026-09-17. **Write that audit to `docs/` before starting
anything** — it is currently in a session scratchpad and it is the most load-bearing analysis in the
project.

**Run these in order. Each one changes the measurements the next depends on.** Do not parallelise.

> **Status 2026-09-17: CC1, CC1b, CC2 and CC3 are DONE** (`docs/CC1_BOARD_MEMBERSHIP.md`,
> `docs/CC1B_ROLE_KEY_SOFT_NULL.md`, `docs/CC2_SKILL_MATCHING.md`,
> `docs/CC3_SYNONYMS_WIRED.md`). CC4 and CC5 are untouched.
> The owner's board is now **849** rows, not 405. 277 of them are still UNCLASSIFIED in
> job_role_map — nothing backfills it, which remains the obvious follow-up and is not done.
>
> **CC3's premise should be re-checked before it is acted on.** CC2 measured rho(board, score)
> at ~0.18 and unmovable by matching-rule changes, so CC3's "re-measure rho with synonyms live"
> will measure the same tie-dominated ordering. CC3's real question — wire G1 or retire it — is
> unaffected, but expect its rho delta to be ~0 for the reason in CC2 §4, not because synonyms
> do nothing.

---

## The finding that orders everything

There are **three** systems deciding one question, and the one that actually decides the board had
never been measured:

| | what it is | semantics | reads |
|---|---|---|---|
| **A** `profileTitleSql` + `job_role_map` join | **hard board membership** | substring-AND of title tokens | `target_titles`, `title` |
| **B** the bridge | 3-valued coarse rank | SQL `LIKE` | signals, `skills_json`, `experience_level` |
| **C** `scoreAtsLocally` | the band on the card | registry vocabulary, normalisation, proximity, weights | title, company, category, **description**, requirements, `skills_json` |

Agreement between board order and scorer score: **ρ = 0.3797 best case · 0.1508 on a thin résumé ·
−0.0222 on the owner's profile as actually stored.** The #1 ranked job renders "No signal."

⛔ **A excludes the best matches before either scorer runs.** Of the 30 postings the owner graded,
only **8** survive a `["Software Engineer"]` board. 22 are excluded, including **5 of the 12 graded
5** — among them `Backend Engineer, Credit Decisions @ Stripe`, which the engine scores **60, its
second-highest**, excluded because the title lacks the literal word "software."

That is why CC1 comes first. Every measurement downstream is taken over a population A has already
gutted.

---

# CC1 — Board membership ✅ DONE 2026-09-17 — see `docs/CC1_BOARD_MEMBERSHIP.md`

```
✅ target_titles now RANK instead of excluding, as two derived keys (target_title_exact,
   target_title_role). Board 405 -> 572 for the owner's profile; the 167 rows the old filter
   deleted are disclosed as `demoted` instead of being absent. Graded-5 reachability DOUBLED
   (2 -> 4 of the 8 still active). A target title matching nothing can no longer empty a board.

✅ CC1b ALSO DONE — see `docs/CC1B_ROLE_KEY_SOFT_NULL.md`. The other gate, the job_role_map INNER
   JOIN, hid 277 active rows (148 titled "...Engineer") from EVERY profile because nobody had
   classified them; am3RestoreBoard restores scraped_jobs without job_role_map, so a restore
   silently un-boards much of what it restores. It is now a LEFT JOIN with a soft-null predicate
   (in my declared bucket OR never classified) plus a role_key rank key. Board 572 -> 849, zero
   duplicate rows, zero rows from another role, graded-5 reachability 4/8 -> 7/8.

⛔ 7 OF 8, NOT 8 OF 8 — AND AN EARLIER NOTE HERE SAID 8. The eighth, Applied AI Engineer/Digital
   Natives, is classified role_key='data' at 0.795 by a deliberate taxonomy where ML/AI is data
   (same bucket as "Machine Learning Engineer"). That is an EXPLICIT mismatch, so excluding it is
   the scope working. docs/ak2-ats-bands.md section 5 already recorded ML/AI as a PROFILE-ROUTING
   question; reaching it needs a Data Science profile, not a looser board. 8 of 8 would require
   letting explicit mismatches onto every board — what "WHAT NOT TO DO" warns against.

⛔ rho(board order, score) CANNOT be moved by CC1. Board order is discovered_at DESC; a membership
   rule changes WHICH rows are present, never their order. CC1 took it from -0.3193 to +0.0963 by
   removing an ANTI-correlation. Making order track score is CC2's "the bridge cannot rank".

CORRECTIONS this task made to the text below — all three found by measuring a handed-down premise:
  · "job_role_map holds 5 rows locally" → 2,188. A crawl repopulated it; local verification is no
    longer measuring fixtures. But 277 active rows still lack a map row (am3RestoreBoard restores
    scraped_jobs without it).
  · "1,266 active rows" / "960 reachable by NEITHER" → 2,460 active, 1,888 reachable by neither.
  · "test baseline 2443" → 2,475 at eecbe09, 2,484 after this task.
  · Not a correction but load-bearing: basis.skills is 0 on BOTH active profiles, which caps what
    any membership rule can achieve.
```

<details>
<summary>The original CC1 brief, kept for the record</summary>


```
Session-aware: read by SYMBOL, not line number. Regression-proof: dependents and children in the
SAME pass with verdicts. Migrations additive + dual-path, byte-identical in BOTH
scripts/migrations.js and the server.js MIGRATIONS array. REPORT + REAL-run verification. One
commit. Re-derive the test baseline first (last known 2443); introduced failures must be 0.

THE DEFECT
profileTitleSql builds a substring-AND over title tokens per target title, OR'd across titles, and
it is a HARD FILTER on board membership — not a rank. Measured over 1,266 active rows:

  target_titles = []                            -> 1266   (1=1, no filter)
  ["Software Engineer"]                         ->  240
  ["Machine Learning Engineer"]                 ->   29
  ["Software Engineer"] u a DS profile           ->  306   (960 reachable by NEITHER)
                                                   308 of those 960 are titled "...Engineer"

Of the owner's 30 graded postings, 8 survive. 22 excluded, 5 of 12 graded-5 among them.
An ML job is on NEITHER an SE board nor a ["Data Scientist"] board (29 vs 35 rows, 3 in both) — so
"which profile does it score against" is moot; it is on no board.

⛔ WHAT NOT TO DO
Do NOT simply delete the title filter. It exists because the board is a GLOBAL profile-agnostic pool
and something must scope 1,266 rows to a role. Removing it hands every user every posting. The
store-then-filter architecture depends on scoping happening at query time — the question is whether
scoping should EXCLUDE or RANK.

THE DECISION, and it mirrors one already made
X2 changed derived filters from EXCLUDING to RANKING, on exactly this reasoning: a filter the USER
SET excludes; a filter DERIVED on their behalf ranks. target_titles is user-set, but the
SUBSTRING-AND MATCHING RULE is not — the user typed "Software Engineer", they did not ask for
"every title containing both the token software and the token engineer". The rule is derived, and
under X2's own principle it should rank.

REQUIREMENTS
1. MEASURE BEFORE CHANGING. Report, for the owner's profile and one thin profile:
   - rows surviving A today
   - rows that would survive under each candidate rule below
   - how many of the 30 graded postings survive each, and how many of the 12 graded-5
   The graded corpus is docs/am1-ats-graded-corpus.json. That count is the acceptance criterion:
   ⛔ A RULE THAT EXCLUDES ANY POSTING THE OWNER GRADED 5 IS WRONG.
2. Candidate rules to measure, not to pick blind:
   a. token-OR instead of token-AND ("Backend Engineer" reaches a "Software Engineer" board)
   b. head-noun matching — match on the role noun ("Engineer", "Scientist") and RANK on the
      qualifier, so specialisation demotes rather than excludes
   c. keep A as a rank dimension feeding B, and drop the hard exclusion entirely
   d. role_family / job_role_map alone as membership, with target_titles ranking within it
3. Whatever is chosen, MEMBERSHIP AND RANKING MUST BE DISTINGUISHABLE IN THE RESPONSE. A user must
   be able to see that 960 rows exist and are ranked below, rather than believing 306 is the board.
4. ⛔ THE job_role_map JOIN IS AN INNER JOIN. Locally job_role_map holds 5 rows and the app renders
   a 5-row board. Report production's row count. If a posting with no map row is invisible
   regardless of title, that is a SECOND hard gate stacked on the first and it must be reported —
   an INNER JOIN on a derived table is a silent exclusion of anything the classifier missed.
5. /api/jobs stays byte-compatible for existing callers. New response fields optional.
   buildParams stays the ONE param builder. jobCursor's key list still generates ORDER BY,
   projection and predicate from one definition — a membership change must not fork that.
6. THE EMPTY-BOARD MESSAGE MUST STAY HONEST. It has twice meant a NULL bug. If a rule change can
   still empty a board, it says which rule did it.

VERIFY (real runs, production data where possible)
Before/after row counts per profile. Graded-corpus survival before/after, with the graded-5 count
stated explicitly. ρ between board order and scorer score before/after — this is the number CC1
exists to move. A screenshot of the board for the owner's profile. Commit & push.
```

</details>

---

# CC2 — The bridge's matching rule ✅ DONE 2026-09-17 — see `docs/CC2_SKILL_MATCHING.md`

```
✅ Whole-value equality replaced with WHOLE-WORD-INSIDE-A-VALUE (four `"`/space-bounded patterns),
   reusing normaliseAtsTerm from the scorer — no third normalisation. Match rate on a
   multi-word term set: 467 -> 665 of 881 enriched rows (53.0% -> 75.5%). "api" matched 0 values
   before and 33 now. All 7 guardrail cases pass, INCLUDING the coffee machine; a naive substring
   fails 4 of them (it credits "api" to "stripe capital knowledge" and "java" to "javascript").

✅ The '[]' bug is fixed and asserted in BOTH directions, on BOTH the derived and the explicit
   path, plus the '[ ]' / '[\t]' spellings. ⛔ But 0 rows on this board hold '[]' — enrichJob writes
   NULL, never '[]'. The brief verified it on a FIXTURE. Real in code, not reachable with real
   data today; fixed anyway because it is one line.

⛔ REQUIREMENT 5 STANDS AND IS NOW MEASURED TWICE: THE BRIDGE STILL CANNOT RANK. rho(board order,
   score) went 0.1889 -> 0.1806 — nowhere — while the match rate rose 42% relative. Three values
   on five dimensions tie in blocks of hundreds (top block 665 rows deep) and the tie-breaker is
   discovered_at DESC. CC2 changed WHICH rows are in the top block, not that it is a block. As the
   brief instructs, this is SCOPED SEPARATELY rather than half-done, and it is the highest-leverage
   item left.

⛔ REQUIREMENT 6 IS NOT REPRODUCIBLE: there are ZERO Strong rows for the owner's profile on this
   board (weak 851, moderate 30), so "24 of 69 demoted" measures 0 of 0. The cause is upstream and
   this brief already names it — basis.skills is 0, the two-extractors problem. No matching rule
   can move it.

⛔ MAX_DERIVED_SKILLS STAYS AT 6, on measurement rather than preference: at cap 24 the dimension
   matches 881 of 881 enriched rows — identical to having no dimension — at 2.5x the query cost.

CORRECTION to the text below: "skills_json coverage is 99.8%" is now the STALE figure. A crawl ran
   and added 1,578 unenriched rows, so coverage is 881/2,460 = 35.8% (and 881/882 = 99.9% of the
   PRE-CRAWL rows, which is the board the brief measured). The backlog is real again.
```

<details>
<summary>The original CC2 brief, kept for the record</summary>

# CC2 — The bridge's matching rule, and the `'[]'` MISS

```
Only after CC1. CC1 changes the population this is measured over.

THE DEFECT — and it is NOT a data gap
⛔ skills_json coverage is 1,263 / 1,266 active = 99.8%. The "37%" figure repeated across several
sessions is STALE AND WRONG BY 2.7x. Any plan resting on it rests on nothing. Retire the claim.

The constraint is the comparison rule against a free-text long tail:
  · 17,325 skill mentions, 6,130 distinct strings, 70% appear EXACTLY ONCE
  · the head is soft skills, not technologies: cross-functional collaboration 498,
    communication 435, stakeholder management 201 — then python at 164
  · the bridge matches  sj.skills_json LIKE '%"<skill>"%'  — WHOLE-VALUE EQUALITY. So "Python"
    matches and "machine learning pipelines" NEVER matches "machine learning"
  · capped at MAX_DERIVED_SKILLS = 6
  · result: 217 of 1,266 rows (17%) match on skills, on a 99.8%-covered board. 1,047 demoted.

REQUIREMENTS
1. Replace whole-value equality with a rule that matches a term INSIDE a multi-word skill value,
   without reintroducing the substring defect AG1 spent a session removing. AG1's finding is the
   guardrail: "I design learning materials for a coffee machine vendor" was credited with MACHINE
   LEARNING, and that artifact was 22.8% of all multi-word matches. Bounded proximity at window 1
   fixed it; at window 3 the coffee machine came back. ⛔ Whatever rule you choose, run the coffee-
   machine case and report it.
2. REUSE THE SCORER'S NORMALISER. C already has normaliseAtsTerm, compound detection, the term
   rejector, the ambiguity guard and the competency registry. The bridge calls cleanStringList and
   emits raw LIKE. ⛔ Do NOT write a third normalisation — that is Shape 1, and the audit named it
   as the reason AG1/AH3's fixes "could not have been inherited": both live entirely inside
   candidateTermsFromJob, which the bridge never calls.
3. MAX_DERIVED_SKILLS = 6 against a 6,130-string vocabulary. Report what raising it does to match
   rate and to query cost before changing it.
4. ⛔ THE '[]' BUG. skills_json IS NULL ranks RANK_UNKNOWN (1) — correct. But '[]' ranks RANK_MISS
   (2): an enriched row whose enrichment legitimately found no skills is ranked as an EXPLICIT
   MISMATCH rather than unknown. Verified on aj2fixture::weak-boundary. This is the FIFTH
   NULL-propagation shape in this codebase, in the "unknown treated as mismatch" direction. Fix it
   and assert both directions.
5. THE BRIDGE CANNOT RANK — say so if you cannot fix it here. Three values x 5 dimensions,
   lexicographic. Its top band is 217 ROWS DEEP and internally ordered by discovered_at DESC. Every
   one of the top 20 has rank vector 0,0 — a tie. It is a 3-bucket sieve, not a ranking. If making
   it a real ordering is larger than this task, report that and scope it separately rather than
   half-doing it.
6. It demotes 24 of 69 Strong rows. Buried examples, all vec 0,2 (an explicit skills MISS):
     pos 528  score 54  Backend Engineer/API, Payments and Risk @ Stripe
     pos 715  score 53  Backend Engineer, Developer & End-user Experience @ Stripe
     pos 705  score 51  Software Engineer, Agent Infrastructure @ OpenAI
   Report the same figures after the change.

VERIFY
Match rate before/after. ρ between board order and scorer score before/after. Strong-row demotion
count before/after. The coffee-machine case explicitly. Both '[]' and NULL directions asserted.
```

</details>

---

# CC3 — Wire G1 into the scorer ✅ DONE 2026-09-17 — see `docs/CC3_SYNONYMS_WIRED.md`

```
✅ DECISION: option (a), WIRE IT. All 8 scoreAtsLocally call sites in server.js now pass
   `synonyms`, pinned by a source scan (the failure mode is a NEW call site, which no behavioural
   test over existing ones can see). loadConfirmedSynonyms is memoised per database and invalidated
   by confirmSynonym / rejectSynonym / recordSynonymProposals — a cache a confirmation did not clear
   would reproduce the exact bug CC3 fixes. Confirmed rows only; the 196 proposals stay out.

✅ THE PATH IS LIVE, NOT MERELY WIRED. Proved on a copy of the real board: a PROPOSED pair moves
   the score 0 points, a CONFIRMED pair moves it 20 -> 27 and moves the term from
   competencies_missing to competencies_matched. All of requirement 2's invariants still pass.

⛔ REQUIREMENT 4, THE NUMBER: rho delta is +0.0000 on both profiles, 0 of 30 scores changed. A
   synonym needs BOTH halves: the scorer must ASK about term A and the résumé must CONTAIN term B.
   4 of the 12 confirmed pairs do name a term the scorer asks about — so the first half lands — but
   the owner's résumé contains neither side of any of those four. The table is connected; the
   intersection is empty.

✅ AND THE REVIEW QUEUE IS NOW AIMED. 54 of the 196 proposals name a term the scorer asks about, so
   they can move a score; the other 142 cannot, for this corpus. Separately, 241 of the 311 terms
   the scorer asks about have NO synonym row at all — topped by cross functional (11 postings),
   reliability (10), python (10), strategy (10). That is where extraction should be aimed.

⛔ A CORRECTION TO CC1 AND CC2, BOTH MINE: they said "basis.skills is 0 on both profiles". WRONG —
   a harness defect (the raw DB row was passed to buildRuntimeAtsBasis, which wants the PARSED
   arrays loadSimpleApplyProfile produces). Profile 5 has 28 terms. Every conclusion survives,
   verified not assumed: 0 of 30 graded scores differ and the band distribution is identical. The
   28 terms are noise ("near","provided","tasks","college"), so 28 terms score exactly as 0 do —
   which is a MEASUREMENT of the two-extractors problem. Both docs corrected in place.
```

<details>
<summary>The original CC3 brief, kept for the record</summary>

# CC3 — Wire G1 into the scorer, or retire it

```
THE DEFECT
G1's synonym table is DEAD CODE IN THE SCORING PATH. No server call site passes `synonyms` to
scoreAtsLocally — only scripts/al3SynonymRhoEffect.mjs (a measurement) and am3RestoreBoard.mjs,
which passes `synonyms: null` explicitly. Its only production reader is enrichJob.js:251 ->
canonicalSkillKey, de-duping the company-KB technographics rollup.

Contents: 12 confirmed, 196 proposed, 10 rejected.

⛔ This is why it measured "+0.000". Not a weak effect — NO EFFECT PATH. The owner has been asked
to review 196 proposals for a table nothing that scores reads.

REQUIREMENTS
1. DECIDE FIRST, then implement one of:
   a. Pass synonyms into scoreAtsLocally at every server call site, and MEASURE ρ with them live.
      The earlier +0.000 was measured through al3SynonymRhoEffect with coverage of 2 of 240 missing
      terms — re-measure after CC2, because CC2 changes which terms are missing.
   b. Retire it from the scoring story entirely, keep it for the technographics de-dup, and STOP
      asking for review of proposals that cannot affect scoring. Say so in the UI.
   ⛔ Do NOT leave it as it is: a review queue for a dead table is worse than either choice.
2. If (a): the existing invariants hold and are already tested — ONE HOP NEVER TRANSITIVE ·
   corroboration never promotes · a rejection is sticky · (a,b) and (b,a) are the same row · a
   synonym cannot rescue a term the résumé does not support at all · an absent table degrades to
   "no synonyms" rather than throwing. Keep every one.
3. If (a): a false equivalence is a CONFIDENTLY WRONG MATCH — the failure that costs the most trust,
   and the same class as the coffee machine. The 196 proposals do not go live without human review,
   and the review UI must put the risky claims first (it already does).
4. Report the measured ρ delta either way. A number, not a claim.
```

</details>

---

# CC4 — Make user-claimed terms reach curation ⭐ the feature the owner asked for

```
Only after CC1–CC3. This is the feature; the three before it are the plumbing it needs.

THE DEFECT, stated as the audit did:
A claim writes profile_signal_suggestions.assertion='claimed', which listProfileClaims feeds to the
GENERATION PROMPT and nothing else. AG2's own copy — "It is used in resumes generated from now on...
It does not change this score" — IS STILL LITERALLY TRUE.

So the user-enrichable semantic layer that changes ranking DOES NOT EXIST. The nearest thing that
does reach curation is an unlabelled "Extracted Titles / Keywords / Skills / Tools / Search Terms"
textarea in ProfilePanel -> PUT /api/domain-profiles/:id/signals — and /signals/refresh or any
résumé re-upload calls upsertSimpleApplyProfile and SILENTLY OVERWRITES those edits, with no warning
in the UI.

REQUIREMENTS
1. CLAIMED TERMS REACH BOTH SCORERS. A term the user claims is true of them must affect the band and
   the board ranking, not only generation.
2. ⛔ A CLAIM IS THE CANDIDATE ASSERTING SOMETHING. That is the right direction and the integrity
   line holds: the system may SUGGEST, only the user may CLAIM. It must never be auto-checked, never
   pre-selected, and the copy must read "I have this", never "add this to improve your score".
   Update AG2's copy — it currently promises the opposite of the new behaviour, and leaving it would
   be a claim with no code in the other direction.
3. ONE STORE, NOT TWO. profile_signal_suggestions (claims) and
   domain_profiles.selected_keywords/tools/verbs are two different stores for the same idea; only
   the legacy 'applied' path writes both. Unify them or state plainly which is canonical and make
   the other read-only. Two stores for one concept is the defect shape this codebase pays for most.
4. ⛔ STOP THE SILENT OVERWRITE. /signals/refresh and résumé re-upload must not destroy user edits
   without warning. Either they preserve user-asserted terms, or the UI says clearly what will be
   lost. Auto-extracted and user-claimed must be DISTINGUISHABLE in the store — the audit notes the
   copy calls them "Extracted", which is accurate today and must stop being accurate.
5. WITHDRAWAL MUST WORK. A claimed term can be withdrawn today (assertion -> 'none', history kept).
   An APPLIED term cannot — the code marks it locked by acknowledged omission, because it also lives
   in selected_tools and that path never had a remove. Fix it as part of unifying the stores.
6. The bridge must read whatever the canonical store is. It currently CANNOT see
   selected_keywords/verbs/tools, which C does read — gap 3 in the audit's matrix.
7. PER-PROFILE, GENUINELY. Inputs already switch per profile. THE OUTPUT DOES NOT — see CC5. Note
   the dependency; do not fix it here.

VERIFY
Claim a term, then measure: board order changes, the band changes, generation still uses it. Withdraw
it and confirm all three revert. Trigger /signals/refresh and confirm claimed terms survive or the
user was warned. Confirm nothing is pre-checked. Screenshot the claim surface.
```

---

# CC5 — The stored score is a cross-user cache

```
Can run in parallel with CC4; independent of CC1–CC3.

THE DEFECT
scraped_jobs.ats_score / ats_report is ONE CELL PER JOB, shared across all users and all profiles.
Written at ingest (server.js:4260) from whichever user's basis triggered the crawl, and overwritten
wholesale by adopt-enhanced (server.js:8091) for one profile. mapJobRow -> matchScore -> the card
badge reads that cell.

POST /api/jobs/:id/keywords cache chain:
  1. resumes WHERE user_id=? AND job_id=?          — IGNORES profile (the column exists)
  2. scraped_jobs WHERE job_id=?                    — no user, no profile: A CROSS-USER CACHE
  3. ats_only_reports WHERE user_id=? AND job_id=?  — UNIQUE(user_id, job_id), ignores profile
  4. only here does it score against the caller's active profile

So the ATS report is per-profile at NO level, and at step 2 one user can be served another's report.

REQUIREMENTS
1. ⛔ STEP 2 IS THE SERIOUS ONE. A score computed against one candidate's résumé must never be
   served to another. Fix that first and independently of everything else here.
2. Key the per-user caches on (user_id, domain_profile_id, job_id). resumes already carries
   domain_profile_id and the priority-1 read ignores it. ats_only_reports needs its UNIQUE
   constraint widened — migration, additive, dual-path.
3. Decide what scraped_jobs.ats_score IS. If it cannot be per-profile it cannot be a user-facing
   band. Options: drop it from mapJobRow and compute the band per request; or keep it as an
   explicitly profile-agnostic signal and stop rendering it as the user's score. State which.
4. THE DATA GAP, and it makes the feature dormant either way: ats_score is non-NULL on 4 of 1,296
   rows; ats_report on 0. JobCard.jsx:250 already documents this and returns null, so there is no
   badge — and onAts is gated on the same value, so on 1,262 of 1,266 rows THERE IS NO ROUTE TO THE
   TERM LIST AT ALL. Report whether the fix is a backfill or computing per request.
5. The atsScore SORT OPTION sorts on that column. It is a dead control on 1,262 of 1,266 rows.
   Fix or remove it.
6. For the one row that does carry a score, stored and fresh DISAGREE: aj2fixture::moderate-upper
   stores 43 (Moderate) and scores null (No signal) today. A stored score with no version or
   scored_at is unfalsifiable — if any stored score survives, it carries the scorer version.

VERIFY
Two users, same job: each gets their own score, neither sees the other's. Two profiles, same user,
same job: different reports. A row with no stored score still offers a route to the term list.
Commit & push.
```

---

## Not in scope, recorded so they are not lost

| | |
|---|---|
| **Two extractors** | Résumé side is a hardcoded 32-item `SKILL_HINTS`; JD side is the registry pipeline. **8 of the 32 appear nowhere on the board as an exact value** — `api, rest, sqlite, power bi, roadmap, budget, risk, timeline` — so a quarter of the résumé vocabulary structurally cannot match. AG1 cleaned the JD side only: profile 5's stored keywords read `near, provided, tasks, july, windows, college`. That noise inflates `basis.skills.length`, which is what silences `resumeDepthWarning` at `MIN_PROFILE_SKILLS: 8` — **noise suppressing the warning about noise.** Its own task. |
| **`ats_term_weights` go stale 2026-10-13** | 856 rows, `computed_at` 19.6 days old against `MAX_WEIGHT_AGE_DAYS = 45`. Past that, scoring **silently reverts to unweighted** with only a `console.warn`. Four weeks out. Needs a loud failure and a recompute schedule. |
| **The graded corpus has drifted** | 26 of 30 postings now score differently from the grading key, max \|delta\| 40. ρ still reproduces at 0.737 within tolerance, and Strong ≥ 44 still holds at 100% precision — but the accepted cost grew: the doc says 4 of 12 graded-5 miss Strong; **today it is 5 of 12.** Update the doc. |
| **Mobile** | Sees `matchScore` (marked INTERNAL — DO NOT DISPLAY) and a `Curation` schema, and has **no** ATS-report, claims or signals path in 30 contract paths. It can show a band; it can never show why, or let a user add a term. |
| **No per-job reason on the board** | `CurationNotice` names dimensions, never jobs, and only when something is demoted. |
| **`job_role_map` holds 5 rows locally** | The local app renders a 5-row board. **Any UI verification of curation done locally is measuring fixtures.** Report production's count in CC1. |
| **n = 0 outcome data** | `job_applications` 0 rows; `usage_events` 1,638 rows with 0 carrying `ats_score_before`/`after`. The recording path has never been exercised — the only 8 `resume_generate` events since AK1 landed all carry `job_id = null`. Nothing connects any of these three systems to whether an employer replied. |

---

## The honest summary

The feature is **three-quarters built and unjoined.** Nothing here is a rewrite:

- **CC1** changes a matching rule on a filter nobody had measured
- **CC2** replaces whole-value equality with proximity, reusing a normaliser that exists
- **CC3** passes an argument that is currently never passed, or retires a dead table
- **CC4** makes an existing per-profile store reach two existing consumers
- **CC5** adds profile scoping to three cache reads

And **CC1 alone may move ρ more than everything else combined**, because it currently excludes 5 of
the owner's 12 best matches before either scorer sees them.
