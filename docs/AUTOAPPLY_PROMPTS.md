# resume-master — Auto-Apply Execution Prompts

Companion to the auto-apply architecture audit. Run **in order**, one task per session, one
commit each.

**Audit summary (do not re-derive):** the resolver is deterministic with zero LLM calls,
unresolvable fields are skipped rather than guessed, and there are four independent pre-submit
gates (ATS/resume gate, terminal flow states, completeness gate, semi mode). The foundation is
sound. What it lacks is an **evidence and confidence layer** — an exact `handler_map` hit and a
fuzzy substring guess are submitted identically, with no record of which matched.

**Prerequisite already landed:** `scripts/fakeAts.js` — a local ATS-shaped test target, verified
booting and serving all routes, multi-step carry-forward, submission recording, and a completion
page whose wording triggers `classifyFlowState`'s `submitted` branch. Zero dependencies.
`node scripts/fakeAts.js` → http://localhost:4599

---

## Standing conventions (prepend to every task)

```
Session-aware: read the files in scope and reconstruct state from the repo — do not trust status
docs. No UI/current-feature change without sign-off. Regression-proof: for every modified module
review its dependents (importers) and children (imports) and fix them in the SAME pass, reporting
each with a verdict. Migrations additive + dual-path, byte-identical in BOTH scripts/migrations.js
and the server.js MIGRATIONS array (high-water 068, next id 069). Close the task with a REPORT
(files, dependents + verdicts, migration id, REAL-run verification — not simulated) then commit
& push as ONE focused commit. Confirm the current unique test-failure baseline before starting;
introduced failures must be 0.

SAFETY, NON-NEGOTIABLE FOR EVERY TASK IN THIS FILE: this pipeline submits real applications to
real employers under a real candidate's name. A submission cannot be recalled and burns that
candidate's one opportunity at that company. Until TASK A5, ALL testing runs against
scripts/fakeAts.js. Do NOT point autoApply at any real ATS URL. Do NOT set mode:'full' against
anything but localhost.
```

---

## TASK A1 — Baseline the resolver against the trap harness (diagnostic)

```
OBJECTIVE
Establish, by real runs, which of the audited weaknesses actually fire. No fixes in this task —
produce a trap-by-trap PASS/FAIL table that scopes TASK A2.

READ FIRST
- services/applyAutomation.js — buildAnswers (~:406), discoverFields (~:393), classifyFlowState
  (~:511), autoApply (~:700), and the completeness gate (~:843).
- scripts/fakeAts.js — the TRAPS registry at the top names each audit finding and its expected
  correct answer. Read it before running.

SETUP
1. node scripts/fakeAts.js  (serves :4599)
2. Build a representative profilePayload: field_map / handler_map / custom_answers as a real
   user would have them, including a `work_authorization` key and a short `name` key — those two
   are what the traps are designed to catch.
3. Drive autoApply() against http://localhost:4599/greenhouse, /lever, /ashby in mode:'full'.

ASSERT ON RECORDED ANSWERS, NOT STATUS
GET /_submissions returns exactly what the form received. A run reporting status:'submitted'
while answering the sponsorship trap wrongly is the precise failure that is invisible in
production. Never assert on status alone.

TRAP-BY-TRAP — report actual submitted value vs expected:
1. sponsorship_inversion — "Do you now or in the future require sponsorship for work
   authorization?" Does a `work_authorization` field_map key substring-match this and submit a
   work-authorization status where a sponsorship yes/no belongs? This is the highest-stakes
   finding: it is a materially false attestation to an employer.
2. name_ambiguity — do legal_name / preferred_name / referrer_name each receive their own value,
   or does one key win all three? Note that Object.entries order decides the winner, so the
   result may not be stable across runs — run it more than once.
3. lowercase_yes — Lever's option values are 'yes'/'no'. buildAnswers checks value === 'Yes'
   (capital Y). Confirm whether 'yes' coerces to 'false', silently answering No.
4. submit_label — Lever's button reads "Review and Submit"; SUBMIT_RE is ^-anchored. Does the run
   end as filled_not_submitted? Confirm it does NOT report a false 'submitted'.
5. required_unmapped — Greenhouse step 2's "How did you hear about us?" is required and has no
   standard mapping. Confirm the completeness gate HOLDS (status 'held_review', reasonCode
   'incomplete_form') with that label in missingRequired.
6. ashby date — the field wants MM/DD/YYYY; buildAnswers normalises dates to YYYY-MM-DD. Report
   what was submitted.
7. ashby typeahead — a required combobox. Does applyTypeaheadAnswer resolve it, or does the
   completeness gate hold?

OUTPUT
Table: trap | expected | actual | PASS/FAIL | severity. Then rank by real-world harm — a wrong
eligibility attestation outranks a formatting mismatch. Propose no fixes. Commit the harness
usage notes only if you add any; otherwise this task produces a report, not a code change.
```

---

## TASK A2 — Answer provenance, and fix what A1 proved broken

```
OBJECTIVE
Give every answer a provenance and confidence, and repair the resolution bugs A1 confirmed. The
KB layer already carries provenance + confidence + last_seen on every fact; the apply path — which
has higher stakes — carries none.

READ FIRST
services/applyAutomation.js buildAnswers (~:406) and its callers (discoverAndFill ~:577,
autoApply ~:700). Read TASK A1's report; fix what it proved, not what it merely suspected.

REQUIREMENTS
1. PROVENANCE. Every answer records which rule produced it:
   'handler_exact' | 'field_map_exact' | 'label_fuzzy' | 'custom_answer' | 'default'
   plus a confidence. Carry it through to the result and persist it with the application, so a
   submitted answer can be audited after the fact.
2. FUZZY MATCHING. Step 3's `lbl.includes(k)` is a naive substring match, first-match-wins over
   an arbitrary key order. Restrict it:
   - Never allow a fuzzy match to answer an ELIGIBILITY-CLASS field (work authorization,
     sponsorship, clearance, visa, criminal history, EEO). Those resolve by exact handler/field
     mapping or not at all.
   - Add negation/inversion guards so a key cannot match a label that inverts it ("require",
     "not", "without", "sponsor").
   - Require whole-token matching rather than raw substring, so `name` cannot claim
     "Name of Referrer".
3. CUSTOM ANSWERS. `ql.includes(lbl)` (the reverse direction) is very loose — a short label
   matches almost any longer stored question. Tighten or drop that direction.
4. BOOLEAN COERCION. `value === 'Yes'` is capital-Y only; 'yes' currently becomes 'false',
   silently answering No. Normalise case and accept the common affirmatives. Keep the fail-safe
   DIRECTION — an unrecognised value must never become an affirmative.
5. LOW-CONFIDENCE POLICY. A 'label_fuzzy' answer must not be auto-submitted in mode:'full'. Hold
   for review (reuse the existing held_review path and reasonCode vocabulary) and report which
   answers triggered it. This is the same flag-don't-fabricate principle the resume failsafe
   uses, applied where the stakes are higher.
6. clear_first is currently unconditional and wipes ATS-prefilled values, including ones the ATS
   correctly parsed from the uploaded resume. Make it conditional on actually having a
   higher-confidence value.

REGRESSION
buildAnswers is exported and used by discoverAndFill and autoApply; check both. If any test
asserts on the answer object shape, update it in the same pass.

VERIFY (real runs, fakeAts only)
Re-run the full TASK A1 trap matrix. Every trap must now PASS or HOLD — never a wrong answer
submitted. Add regression tests for the sponsorship inversion and the lowercase-yes cases
specifically; those are the two that produce false employer attestations. Commit & push.
```

---

## TASK A3 — Submit guards: idempotency, rate limit, audit trail

```
OBJECTIVE
Nothing currently stands between a retry storm and duplicate applications to the same employer.
The only collision guard is "already applied or in progress" (routes/apply.js ~:419).

READ FIRST
routes/apply.js — all routes: POST /api/apply, /api/apply/runs, GET /api/apply/status/:jobId,
/applications, /readiness, /runs, /runs/:runId, /review, POST /api/apply/close/:jobId, and the
two /api/apply/session/* stubs (confirm whether those are live or placeholders).

REQUIREMENTS
1. IDEMPOTENCY. An Idempotency-Key on POST /api/apply and /api/apply/runs; a repeat key returns
   the original result rather than re-applying. (This is the one idea worth taking directly from
   Jobo's API shape — duplicate applications are worse than none.)
2. RATE LIMIT / CAP. A per-user daily application cap and a concurrency limit, both configurable.
   Exceeding them is a clear error, never a silent drop.
3. AUDIT TRAIL. Persist, per application: the resolved answers WITH provenance/confidence from
   A2, the resume artifact used, the terminal status + reasonCode, and the screenshot path.
   Requirement: it must be possible to reconstruct exactly what was sent to an employer and why.
   Needs migration 069 if columns are missing — additive, dual-path, byte-identical.
4. KILL SWITCH. A single env/config flag that disables all full-auto submission immediately
   without a deploy, leaving semi mode working.

REGRESSION
/api/jobs stays byte-compatible. Confirm existing apply callers in the client still work; report
each with a verdict.

VERIFY
Real runs against fakeAts: duplicate POST with the same Idempotency-Key produces ONE submission
in GET /_submissions. Cap enforcement returns a clear error. Kill switch blocks full auto while
semi still runs. Commit & push.
```

---

## TASK A4 — browserLauncher path bug (cross-referenced)

```
Already scoped in docs/EXECUTION_PROMPTS.md. Restating because it lands squarely on this path:
services/browserLauncher.js launchBrowser (~:246) uses
  process.env.PUPPETEER_EXECUTABLE_PATH || resolution.path
which discards the existsSync-validated resolution that the readiness probe (~:186) correctly
uses. Failure signature: readiness reports healthy via fallback while real launches fail. Both
auto-apply and PDF generation run through this. Fix before TASK A5.
```

---

## TASK A5 — First live application ⛔ GATE — owner present, semi mode only

```
⛔ DO NOT START until A1–A4 are committed and the trap matrix is fully green.

OBJECTIVE
One real application, in SEMI mode, with a human reviewing before submit. Not a batch. Not
full-auto.

PRECONDITIONS
- A1 trap matrix all PASS/HOLD; A2 low-confidence policy active; A3 audit trail recording;
  A4 browserLauncher fixed.
- PDF generation confirmed working end to end — the resume is the payload, and it is a known
  live regression. If PDF is still broken, STOP: there is nothing to submit.
- Target is a greenhouse row (651 of 684 active rows are greenhouse; adzuna is 10 and jobo is 0,
  and aggregator links frequently resolve to redirects rather than fillable ATS forms).

PROCEDURE
1. Pick ONE greenhouse job the candidate genuinely wants — a bad first application costs a real
   opportunity, so it should be a role worth applying to on its own merits.
2. Run in mode:'semi'. The browser is visible and the human submits.
3. BEFORE the human clicks submit: dump every resolved answer with provenance/confidence and
   read them against the rendered form, field by field. Pay closest attention to eligibility
   answers — work authorization, sponsorship, years of experience.
4. Record the outcome, the audit row, and the screenshot.

VERIFY
Report every field the resolver filled, its provenance, and whether it was correct on the real
form. Any wrong answer means STOP and return to A2 — do not proceed to full-auto. Full-auto
remains gated on a clean run of several semi-mode applications. Commit & push the report.
```

---

## Deferred

- **Validation-correction loop.** Today `missingRequired` ends the run (`held_review`). Feeding
  those labels back — to a second resolution pass, or to the user as a targeted "answer these 3
  questions" prompt — turns a dead end into a completion. This is the most useful idea in Jobo's
  design and needs no dependency on them.
- **Step-scoped answer approval.** Restructuring `discoverAndFill` so each step emits a resolved
  answer set that a policy layer approves/rejects/escalates. Gives a natural confirmation hook
  and matches the seam any hosted provider would plug into later.
- **Non-greenhouse coverage.** Only after greenhouse is reliably green.
