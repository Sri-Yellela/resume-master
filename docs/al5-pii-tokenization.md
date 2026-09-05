# AL5 (task F) — the PII tokenization layer

Run 2026-09-04. Suite **2147 → 2168 passing, 0 failing** (+21). Spend ~$0.24.

**What it protects, stated honestly:** `resume_generate` has run 9 times in 1414 events. This guards
about four cents of traffic. It was built for **testability** — the round trip is far easier to prove
before real volume than after — not for savings.

---

## A whitelist, not a filter

Taking the payload we already build and stripping PII out of it **fails silently**. A regex that
misses one email in one résumé leaks a real person's address into a training corpus with no error
and no way to discover it afterwards.

A whitelist **fails closed**: a field nobody thought about is absent by construction rather than
present by oversight, and adding one is an edit to `shared/piiPolicy.js`, visible in a diff, next to
the reason the list exists.

**Three classes, not two:**

| | meaning |
|---|---|
| **ALLOWED** | sent as-is — job text, and structural facts (years, seniority, skill words) |
| **TOKENIZED** | sent only as a stable placeholder — employers, teams, institutions |
| **EXCLUDED** | **not sent in any form, including tokenized** |

The third class is the one a two-class design gets wrong. **A token still carries the value**, and
its mapping travels with the request: `work_auth: H-1B` as `STATUS_1` is still one bit about
someone's immigration status leaving the building.

### Verified, and worth recording

- **The eligibility fields are not needed at all.** `buildRuntimeInputs` never referenced
  `work_auth`, `requires_sponsorship`, `visa_type`, `has_clearance` or `clearance_level` — after AF2
  the years figure comes from the profile. Requirement 2 asked for this to be verified; it holds.
- **The current untokenized prompt sends `phone`, `email`, `linkedin_url` and `github_url`.** The
  last two are exactly what a "name, email, phone" mental model misses: directly identifying, and
  stable across every application a person ever makes.

Requirement 2's list is asserted **field by field**, written out rather than looped over the set, so
deleting one fails the test instead of silently widening what may leave.

---

## The guard refuses; it does not sanitise

Enforced in `callModel()` — the one wrapper every call passes through — rather than beside the code
that built the payload, because a guard living next to the code it guards gets edited in the same
commit as the mistake.

Dropping the offending field would mean the send succeeds and nobody learns the payload was wrong;
the next payload built the same way would be wrong too. **Refusing is the only outcome a caller
cannot ignore.**

Two failure codes, deliberately distinct: `PII_EXCLUDED_FIELD` (someone classified this as
never-send) and `PII_UNKNOWN_FIELD` (nobody has classified it at all). They need different reactions.

A `TOKENIZED` call with **no** declared fields is also refused. The class asserts a property; a call
claiming it with nothing to check is claiming it **vacuously**, which is worse than not claiming it
because it reads as verified.

**Requirement 4's injection is a test**: an excluded field reaches the provider zero times.

---

## The reversal is where the risk moves

Both failure modes produce a document that reads perfectly:

- **A dropped token.** The model rephrases around `COMPANY_B` — "at my previous employer" — and the
  artifact is **missing a job**.
- **An invented token.** `COMPANY_C` was never sent, resolves to nobody, and puts **an employer on
  the résumé that the candidate never had**.

Both are silent, so both are assertions, and a generation failing either **does not persist**.
Returning a best-effort artifact would hand the candidate exactly the outcome tokenization was
adopted to make impossible.

The property is not *"we tokenize"*. It is **"we can prove what came back is what went out"**.

**One hop, never transitive** is enforced the same way it is for skill synonyms, and a third check
catches a token surviving substitution — if the mapping and the round-trip check ever disagree, a
placeholder would ship inside a real résumé, visible to an employer.

Tokenization is deterministic **by sorted value**, not encounter order: otherwise a stored mapping
cannot be re-derived and *"what did we send in March"* is unanswerable, which is the question an
audit asks. Substitution is **longest-first**, or "Stripe Payments" replaced after "Stripe" leaves
half a real name in the payload — a leak that looks like a successful tokenization.

---

## VERIFY — a real Sonnet generation

`scripts/al5TokenizedGeneration.mjs`. This is the part no unit test could establish: **whether a real
model actually carries placeholders through.** If a model silently rewrote `COMPANY_A` as "a leading
payments company", every generation would fail the round trip and the feature would be unusable.

```
PASS  no candidate employer leaked into the OUTBOUND prompt
PASS  the prompt carries tokens instead  — 2 tokens
PASS  the round trip passed — every token came back, none invented
PASS  no token leaked into the final artifact
PASS  the real employers are back in the artifact  — all present
PASS  the control generation completed
      vocabulary overlap (Jaccard): 65.8%  (366 vs 317 distinct terms)
PASS  substantial vocabulary overlap with the control
ALL CHECKS PASSED
```

Equivalence is measured as **overlap, not equality** — two Sonnet generations of the same prompt
differ anyway, so a strict diff would fail for reasons unrelated to tokenization. It says the
tokenized output is not degraded; it cannot say the two are the same document, and no run of two
samples could.

### ⚠ One residual disclosure, reported rather than hidden

`job_company` is on the allow-list because the company published the posting and the prompt cannot
tailor without it. **If the candidate has also worked there** — the run's own case: Stripe, both
employer and target — that token is inferable for free.

Tokenization cannot fix this without removing the target company, which breaks the tailoring the
feature exists to do. The harness **names it** instead of exempting it silently behind a green tick.
It is the one case where this design leaks by construction.

### Two harness defects, found by the round trip doing its job

A regex extractor tokenized `Aug 2022`, then on the next pass `Java` and `Distributed Key` — skills-
line fragments. Tokens landed where no model would reproduce them, the round trip failed, and **the
failure looked like a defect in the design when it was a defect in the input.**

It now uses `buildStructuredResume` — the same parser `services/kb/failsafe.js` uses to read company
claims — rather than being a second source of truth about what an employer is.

---

## Requirements 5 and 6

**5. A+ stays on Claude, untokenized.** Asserted at the call site: `resume_enhance` is `CANDIDATE`
and is not `TOKENIZED`. It is the experimental path and its prompt changes.

**6. AF2's years assertion still inspects something.** The concern was real — a guard reading the
*payload* would see tokens instead of employers and pass on everything. AF2's guard reads the
**generated document** and the profile's own years figure, neither of which tokenization changes.
Asserted, including that the guard has **not** been taught about tokens: if it had, it would be
reading the tokenized form rather than the restored one.
