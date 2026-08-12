# Validation-correction loop (Deferred item, now built)

`missingRequired` used to end a run. It was a list of label strings — no type, no options, no reason
— so a hold was a dead end. This turns it into an answerable question set, and the answers back into
a completed application.

**Verified end to end** by `scripts/a6CorrectionLoop.mjs`: a greenhouse job that holds becomes a
verified submission in **two rounds**, with every eligibility answer supplied by the user rather than
inferred.

## The shape of it

A second resolution pass over the same inputs would return the same answers — the loop only works if
it acquires *new information*, and the only source of that is the user. So the loop closes through
`custom_answers`, which A2 already made the one exact-by-construction path (an eligibility field can
be answered there only on a normalised-exact question match). **Nothing is guessed on retry; it is
answered.**

```
run holds  ──▶  GET  /api/apply/questions      what would unblock this, with type/options/reason
                POST /api/apply/answers        merged into user_profile.custom_answers
                     { answers, retryJobIds }  + retry through startRun
           ──▶  retry resolves them as custom_answer (0.85) ──▶ submitted
```

Two kinds of question, because a hold has two causes:

| reason | meaning | what answering it means |
|---|---|---|
| `unanswered` | required, still empty, nothing resolved it | supply the answer |
| `low_confidence` | resolved only by a guess (`label_fuzzy`) | confirm or replace the `proposed` value |

Each question carries `type`, real `options` (the placeholder is dropped), `eligibility`, the jobs it
`blocking`s, whether it is already `answered`, and — when the resolver *tried and refused* —
`refusals`. That last field is the difference between "we have no answer" and "we refused to guess",
which for a sponsorship question is the whole point:

```json
{ "question": "Do you now or in the future require sponsorship for work authorization?",
  "type": "select", "eligibility": "sponsorship", "options": ["Yes", "No"],
  "refusals": ["work_authorization:eligibility_class:sponsorship"] }
```

## The precedence change that makes it terminate

**`custom_answers` now runs BEFORE the fuzzy label step.** This is load-bearing, and the loop does
not work without it.

A `low_confidence` hold asks the user to confirm a guess. If the fuzzy step still ran first, its 0.3
guess would keep winning, the stored answer would never be reached, and **the same question would be
asked forever** — the loop would never converge. An explicit answer to this exact question is
strictly better evidence than a token-subset match against a profile key.

The exact paths are unaffected: `handler_map` and `field_map` still outrank `custom_answers`, because
an attribute-derived handler is stronger evidence than free text typed into a question box. Order is
now: `handler_exact` → `field_map_exact` → `custom_answer` → `label_exact`/`label_fuzzy`. Both
directions are asserted by test.

## Guards are not bypassed on retry

The retry calls the **same** `startRun()` as a fresh run, which was extracted for exactly this
reason. Every A3 guard still applies — kill switch, concurrency limit, daily cap, prerequisite gate,
duplicate filter — and `INSERT INTO apply_runs` now exists in exactly one place, asserted by test.

If a guard refuses the retry, **the answers are still saved** and the real reason is returned. Losing
a user's typed answers because a cap was spent would be its own bug.

Two further safeguards:
- A job is retryable only when **every** question it was blocked on is answered. A half-answered
  retry would just burn a run and hold again, so it returns 409 `no_retryable_jobs` and names what
  was skipped.
- The superseded hold is marked `superseded`, not left `held_review` — otherwise the review queue
  would keep offering questions that have since been answered.

## End-to-end result

```
1. first run HOLDS                 held_review / incomplete_form, 0 submissions, questions persisted
2. the hold is a question set      3 questions, 2 flagged as eligibility attestations,
                                   sponsorship carries its options AND its refusal reason
3. answer, retry, repeat           round 1: 3 unanswered   round 2: 2 low_confidence  -> converged
4. the retry COMPLETES             submitted, submit_verified=1 (confirmation_page,url_changed),
                                   EXACTLY ONE submission at the ATS
   recorded: requires_sponsorship="No"  legally_authorized="Yes"
             hear_about_us="Your engineering blog"  legal_name="Ada Lovelace"
   audit:    provenance=custom_answer, matched_on=<the full question text>
             nothing in the final submission was label_fuzzy
5. no questions remain             queue empty
```

Round 2 is not a defect — it is the design. The `incomplete_form` gate fires before the
low-confidence gate, so a low-confidence field only becomes visible once the form is otherwise
complete. The loop is a loop precisely because holds can be layered.

## Found while building this

**`PLATFORM_LABEL_MAPS.greenhouse` has no plain `"Name"` entry** (only `"First Name"`/`"Last Name"`),
so greenhouse's "Legal Name" and "Preferred Name" fall through to a `label_fuzzy` guess and hold the
run. This is the **same gap A3 found in the ashby map** — and it is why round 2 exists in the run
above. The loop handles it correctly by asking, but two providers now show the same missing-mapping
pattern, which suggests the maps should be audited against real forms rather than patched one label
at a time. Not fixed here: `platformDetector` is shared, and this is a resolution concern.

**`answers_json` and the `answers_resolved` log event store different shapes.** The column holds the
raw answer objects (`label`/`name`/`field_id`, plus `matched_on`, `refusals`, `clear_first`); the
event holds a normalised `{ field, … }`. Both are useful — raw is richer — but a reader has to know
which is which. Worth unifying if a UI consumes them.

## API added

| Endpoint | Purpose |
|---|---|
| `GET /api/apply/questions` | every outstanding question, deduplicated, with `answered`, `blocking`, `eligibilityCount` |
| `POST /api/apply/answers` | merge answers into `custom_answers`; optional `retryJobIds` + `mode` to retry |
| `GET /api/apply/review` | now additionally returns `openQuestions` per held job (additive) |

`POST /api/apply/answers` is idempotency-protected like the other write endpoints.

## Not built: the UI

The deferred item offers "a targeted *answer these 3 questions* prompt" as one option. **No UI was
built** — the standing conventions require sign-off for UI changes. The server side is complete and
the data is already on the existing review payload, so the prompt is a thin rendering layer over
`GET /api/apply/questions`: group by `blocking`, render `type`/`options`, show `proposed` for
confirmations, and mark `eligibility` questions as attestations. **That needs your sign-off.**

## Regression review

| Surface | Verdict |
|---|---|
| `services/applyAutomation.js` | Step order changed (custom_answers above fuzzy); `openQuestions` added to both hold returns. Additive to the result shape. |
| `routes/apply.js` | `startRun()` extracted from `POST /api/apply/runs` — same guards, one implementation, two callers. Response shapes unchanged. |
| `POST /api/apply/runs` | Unchanged externally; now delegates to `startRun`. |
| `GET /api/apply/review` | Additive field only; a caller ignoring `openQuestions` is unaffected. |
| Client | **No change.** No UI built. |
| `test/integrationsArchitecture.test.js` | Re-pointed at `startRun` — the invariant (prerequisite gate precedes the insert) now covers *both* entry points, so the assertion is stronger than before. |

**Migration `073_apply_open_questions`** — one additive column, byte-identical in both migration
paths (md5-verified), applied cleanly against a copy of the production DB.

**Baseline: 629 pass / 0 fail before → 640 pass / 0 fail after (11 added). Introduced failures: 0.**
