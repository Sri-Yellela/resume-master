# Step-scoped answer approval (Deferred item, now built)

Each step of a form now emits a resolved answer set, and a policy decides what happens to it
**before anything is typed**.

Previously all policy ran at the *end* of a run. By the time the low-confidence gate said "this is a
guess, hold", the guess had already been typed into steps 1..N of a real employer's form and "Next"
had been clicked through them. A run that was always going to be held is now held **before it
writes anything**.

## The seam

```js
autoApply(url, payload, { answerPolicy })   // defaults to defaultAnswerPolicy
```

The policy receives `{ step, mode, provider, url, answers, fields, fillable }` and returns
`{ approved?, rejected?, escalate?, reason? }`. Omitted fields mean "approve everything", so a
minimal policy is a one-liner. Three outcomes, per the deferred item:

| outcome | meaning |
|---|---|
| **approve** | fill these answers |
| **reject** | do not fill these, but continue — a guess in an *optional* field is better left blank than fabricated |
| **escalate** | stop the run now and hand back to a human, before typing anything on this step |

This is the hook a confirmation UI or a hosted provider plugs into: it sees exactly what would be
written, with provenance and confidence per answer, and can veto per field or stop the run.

Two deliberate safety properties:

- **A policy that throws escalates.** It does not fall back to "approve everything" — a broken
  confirmation hook must not become an unreviewed submission.
- **A non-object return approves the original set** rather than silently dropping every answer, so a
  policy that forgets to return does not produce a blank application.

## What the default policy does

Derived from what A1–A3 established, and mode-aware:

- **semi** — approve everything. A human is looking at the form; pre-filling a guess for them to
  correct is the entire point of semi.
- **full, guess in a REQUIRED field** — escalate. The form cannot proceed without it, so stop and
  ask, carrying the proposed value.
- **full, guess in an OPTIONAL field** — reject and carry on. Leaving it blank is more truthful than
  typing a value we do not know, and it lets a run that would otherwise be held complete.

The end-of-run low-confidence gate is kept as a backstop for custom policies that approve guesses.

## Two behaviour changes, both intended

**1. Escalation happens earlier, so question ordering changed.** A form whose *first* step contains a
guess in a required field now reports `low_confidence_answers` at step 1, instead of walking to step 2
and reporting `incomplete_form`. In the correction-loop run that means round 1 asks about "Legal
Name" and round 2 asks the step-2 eligibility questions — where before both arrived together.

Trade-off, stated plainly: **fewer writes to the employer's form, at the cost of more round trips**
when early steps contain guesses. That is the right side to err on for a pipeline that submits under a
real candidate's name. The loop still converges in 2 rounds.

**2. An optional guess is no longer typed.** "Preferred Name" was previously filled with the
candidate's full name on a `label_fuzzy` guess; it is now left blank and recorded as
`policy_rejected`. Verified in the real run: the submitted form has `preferred_name` empty, and the
audit trail shows *why* it is empty.

## A bug this surfaced

The first real run held on round 3 over "Preferred Name" — an optional field the policy had already
**rejected**. The end-of-run gate was still counting policy-rejected answers, so a guess that was
never typed kept re-opening as a question, and **answering it could not close it**, because the answer
was never the problem. `lowConfidenceAnswers` now excludes `policy_rejected` answers: a guess that was
not typed cannot make the submission unsafe. The loop went back to converging in 2 rounds.

This is the kind of defect that only shows up when the loop is actually run to convergence rather
than checked one round deep.

## Known limitation, written down next to the code

**The legacy `fillContext` sweep is NOT policy-gated.** It fills elements inside the page by
attribute/label heuristic and never produces an answer object to approve, so there is nothing for a
policy to see. Its A2 guards — eligibility class, third-party subject, whole-token matching — are what
keep it in bounds. Bringing it under the policy means porting it onto the `buildAnswers` path, which
is its own change and would want its own verification. A test asserts the limitation stays documented
in the source so it cannot quietly become an assumption.

## Verification

`scripts/a6CorrectionLoop.mjs` — real chain, **all checks passed**:

```
round 1: 1 question  (Legal Name, low_confidence — escalated at step 1, nothing typed)
round 2: 3 questions (sponsorship + work auth + free text, unanswered at step 2)
         -> converged in 2 rounds
submitted, submit_verified=1 (confirmation_page,url_changed), EXACTLY ONE submission
nothing SUBMITTED was a low-confidence guess
a guess in an optional field was dropped, not typed, and is recorded  ["Preferred Name=label_fuzzy"]
that optional field was left blank in the submission                  ""
```

`scripts/a1TrapMatrix.mjs` — **unchanged**: every trap still holds or passes, ashby still submits with
correct values. Those runs resolve as `generic`, whose label map covers the name fields, so there are
no guesses and the policy approves everything — which is the right no-op.

`test/applyAnswerPolicy.test.js` adds 14 tests: the three outcomes, mode-awareness, the required vs
optional split, the boundary at exactly `AUTO_SUBMIT_MIN_CONFIDENCE`, the injectable seam and its two
failure modes, ordering (the decision provably precedes the fill, and an escalation returns before
it), and the `policy_rejected` interaction with the end gate. Two were confirmed to fail against a
deliberately reintroduced version of each bug, then the file was restored byte-identically.

## Regression review

| Surface | Verdict |
|---|---|
| `services/applyAutomation.js` | `discoverAndFill` restructured around the seam; `answers` gain `required` and `options` (additive); `autoApply` gains `answerPolicy` (defaulted). |
| `routes/apply.js` | **Unchanged.** The escalation hold reuses the existing `held_review` / `low_confidence_answers` / `openQuestions` shape, so A3's audit persistence and the correction loop consume it with no change. |
| Client | **No change.** |
| Existing tests | **No churn** — 640 passed before and after the restructure, without editing one assertion. |

**No migration.** **Baseline: 640 pass / 0 fail before → 654 pass / 0 fail after (14 added).
Introduced failures: 0.**

## Deferred list status

- ~~Validation-correction loop~~ — done.
- ~~Step-scoped answer approval~~ — done (this).
- **Non-greenhouse coverage** — still deferred, and gated on "greenhouse is reliably green", which
  means A5. Note two providers now show the same missing-label-map pattern (`ashby` and `greenhouse`
  both lack a plain `"Name"` entry), so that audit is the natural first half of this item.
