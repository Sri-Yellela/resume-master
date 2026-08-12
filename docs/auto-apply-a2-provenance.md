# TASK A2 — Answer provenance, and the resolution bugs A1 proved

Follows `docs/auto-apply-a1-trap-matrix.md`. Verified by real `autoApply(..., mode:'full')` runs
against `scripts/fakeAts.js` only. Nothing was pointed at a real ATS.

**Result: every A1 trap now PASSES or HOLDS. No wrong answer is submitted on any fixture.**

## Verification — before and after

| # | Trap | A1 (before) | A2 (after) |
|---|---|---|---|
| 1 | sponsorship_inversion | `requires_sponsorship="Yes"` **submitted** | **HOLD** `incomplete_form` on all 5 greenhouse variants |
| 2 | name_ambiguity | referrer got the candidate's name, **submitted** | **PASS** — referrer refused, `legal_name`/`preferred_name` still resolve |
| 3 | lowercase_yes | untestable (no checkbox existed) | **PASS** — `authorized_no_sponsorship = "on"` from a stored `'yes'` |
| 4 | submit_label | PASS | **PASS** (holds earlier now, on low confidence) |
| 5 | required_unmapped | PASS | **PASS** |
| 6 | ashby date | `"2026-09-01"` into an MM/DD/YYYY field | **PASS** — `"09/01/2026"` submitted |
| 7 | ashby typeahead | `"Boston, MABoston, MA"` | **PASS** — `"Boston, MA"` |

The single remaining submission (ashby) is correct in every recorded field. Reproduce:
`node scripts/fakeAts.js`, then `A1_RESUME=/path/to/any.pdf node scripts/a1TrapMatrix.mjs`.

## What was implemented

1. **Provenance + confidence** on every answer: `handler_exact` (1.0), `field_map_exact` (0.9),
   `custom_answer` (0.85), `label_fuzzy` (0.3), `default` (0.1), plus `matched_on` (which key or
   question produced it). Carried out through the `autoApply` result on every return path and
   persisted per application by `routes/apply.js` as an `answers_resolved` event, values included —
   auditing "was this answer correct" is impossible without the value.
2. **Fuzzy matching restricted**: whole-token instead of raw substring; eligibility-class fields
   (sponsorship, work auth, clearance, visa, criminal history, EEO) refused outright; inversion
   guard so a key cannot match a label that negates it. Refusals are recorded, not silently dropped.
3. **custom_answers tightened**: the reverse direction (`ql.includes(lbl)`) is dropped; forward
   matching requires a question of at least 8 characters.
4. **Boolean coercion** normalised (`yes/y/true/1/on/checked/agree/...`, case-insensitive). The
   fail-safe direction is preserved and tested: anything unrecognised stays false. An affirmative is
   what attests something to an employer, so one is never invented.
5. **Low-confidence policy**: a `label_fuzzy` answer cannot auto-submit in `mode:'full'`. The run
   returns `held_review` / `low_confidence_answers` and names the offending answers.
6. **`clear_first` conditional**: granted only at confidence ≥ 0.9, i.e. the two exact paths. A
   guess now fills a blank field but never overwrites one the ATS parsed from the resume.

Policy lives in exported, unit-testable Node functions (`refuseReason`, `matchesWholeToken`,
`invertsKey`, `coerceAffirmative`, `eligibilityClassOf`, `formatDateForHint`,
`sanitizeDiscoveredFields`). In-page scripts receive regex *sources* and rebuild them, so the rules
are defined once.

## Findings that changed the task as written

**Requirement 2's stated remedy does not achieve its stated goal.** It asks for whole-token matching
"so `name` cannot claim 'Name of Referrer'". Whole-token matching does not prevent that — `name` **is**
a whole token there, and the test asserts this explicitly. What actually fixes it is a
**third-party-subject guard**: when a label names a different person (referrer, reference, emergency
contact, guardian, supervisor…), identity-class keys and handlers are refused. Both are implemented;
only the second one closes the trap.

**Restricting `buildAnswers` alone would have fixed nothing.** The legacy `fillContext` sweep
(`FILL_FN_SRC`) fills elements directly, bypassing `buildAnswers` and therefore bypassing provenance
and the low-confidence hold. Its own step-3 label matching reproduces the same substring flaw, and
A1's inverted sponsorship answer is reachable through it independently. The same guards are now
applied inside the sweep, and its label/hint matching uses whole tokens.

**N5 (from A1) fixed at the source.** Discovery now reports `handler_source`
(`attr` | `file` | `label` | null), and Node re-vets label-derived handlers in
`sanitizeDiscoveredFields`. This is what stops a label-map guess ("Name" → `full_name`) from
resolving through the *exact* `field_map` path and arriving stamped `field_map_exact` at high
confidence. Attribute-derived handlers are trusted, because `name="requires_sponsorship"` is an
exact signal rather than a guess.

**New — the canonical key could not answer its own field.** Step 2 only tried
`field_map[handler_type]` and its underscore variant, so handler `sponsorship` never looked for
`requires_sponsorship`. Restricting eligibility fields to exact mapping would therefore have made
them **permanently unanswerable** — safe but useless, holding every run forever. Added
`HANDLER_TO_PROFILE_KEYS` (the reverse of `PROFILE_KEY_TO_HANDLER`). Step 2 also runs the guards
now, so an exact-looking handler of the wrong class for the label is still refused.

**New (N6) — the legacy sweep clobbered vetted values.** Its step 1 (exact name/id match) had no
already-filled guard, unlike steps 2 and 3. Caught by a real run: ashby submitted the raw ISO
`"2026-09-01"` even though `buildAnswers` had correctly produced `"09/01/2026"`, because the
field_map key `start_date` equals the control's `name` and the sweep overwrote it afterwards. The
same path would overwrite an ATS-prefilled value, which is exactly what requirement 6 exists to
prevent — so requirement 6 needed a fix in two places, not one.

**A1 findings N3 and N4 fixed** as prerequisites for verifying anything: `frameList()` stops
`page.frames()` being processed twice (`fieldsFilled` was 198 on a 9-field step; `missingRequired`
came back duplicated), and `applyTypeaheadAnswer` now honours `clear_first` instead of appending.
A dead `fillAllFrames` closure was removed — defined, never called.

## Deliberately NOT in A2

- **N1 — `submitted` claimed without verification** (`autoApply` sets `submitted = true` straight
  after clicking a submit-shaped button). This is a submit guard and belongs to **A3**. It is the
  highest-ranked open finding: A1 observed `status:'submitted'` with zero recorded submissions.
- **N2 — the completeness gate exempts `type:'file'`**, so a required empty resume passes the gate
  while the browser refuses to submit. Also A3.
- **Trap 3's toggle half.** The fixture now has a checkbox, which exercises the coercion. It has no
  `role="switch"`, and for a non-input element `APPLY_FN_SRC` sets `.checked`, which does nothing —
  a required switch would hold forever. Worth its own fix before any provider that uses one.

## Trade-off that needs a decision

**Full-auto now holds whenever any field resolves only by fuzzy label match.** Observed on Lever:
the run holds because `current_company` matched "Current company" — a benign, in fact *exact*, label
match scored `label_fuzzy` at 0.3.

This is requirement 5 implemented literally, and it is the right conservative posture before A5. But
on real forms it will hold a large share of runs, because harmless fuzzy matches are common.

Recommendation: add a `label_exact` tier (normalised label == key phrase) at ~0.9, keeping
`label_fuzzy` for genuine token-subset guesses. That preserves the safety property — guesses still
hold — while not holding on exact label matches. **Not implemented**, because requirement 1 fixes the
provenance enum to five values and adding a sixth is a spec change, not an implementation detail.
The Deferred "validation-correction loop" is the other half of this: today a hold is a dead end.

## Regression review

| Module | Role | Verdict |
|---|---|---|
| `services/applyAutomation.js` | modified | Importers: `routes/apply.js`, `scripts/a1TrapMatrix.mjs`, 4 test files. Children: `browserLauncher.js`, `platformDetector.js` — read only, unmodified. Answer shape is **additive** (fields added, none removed), which is why all 16 pre-existing `applyFieldDiscovery` assertions pass untouched. |
| `routes/apply.js` | modified | Importer: `server.js` (`applyRoutes(...)`) — positional signature **unchanged**, still matching `applyPipeline.test.js`. Only additive logging. |
| `scripts/fakeAts.js` | modified | Nothing imports it; standalone dev server. Added the checkbox A1 proved was missing. |
| `scripts/a1TrapMatrix.mjs` | modified | Fixed a broken import (`./services/…` → `../services/…`) that the A1 commit introduced when the driver moved into `scripts/`; it could not run as committed. |
| client / extension | — | No consumer of `clear_first`, `typeahead_selection` or `handler_source` outside the service and its tests. **No UI change.** |

**Migration: none.** Provenance is persisted through the existing `apply_job_logs.details_json`
column, deliberately leaving id **069** free for A3's dedicated audit columns, which its prompt
claims.

**Baseline: 600 pass / 0 fail before → 611 pass / 0 fail after (11 added). Introduced failures: 0.**
`node --check` clean on both modified services.
