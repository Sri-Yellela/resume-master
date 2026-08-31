# TASK A1 — Resolver baseline against the trap harness (diagnostic)

Companion to `docs/AUTOAPPLY_PROMPTS.md`. **Diagnostic only — no fix was made to
`services/applyAutomation.js`.** Every row below is from a real `autoApply(..., mode:'full')` run
against `scripts/fakeAts.js` on `localhost:4599`. Nothing was pointed at a real ATS.

Reproduce: `node scripts/fakeAts.js`, then
`A1_RESUME=/path/to/any.pdf node scripts/a1TrapMatrix.mjs`

Assertions are on `GET /_submissions` — what the form actually received — never on `status`. That
distinction earned its keep immediately: see finding N1, where a run reported `submitted` with zero
submissions recorded.

## The harness could not exercise the traps until it was fixed (read this first)

The first full matrix returned `held_review` for all six runs, each holding on a field that was not
the trap, with `missingRequired` showing raw control names rather than labels. Cause, confirmed by
dumping `discoverFields`: **every field had `label:""`.**

`fakeAts`'s `field()` helper emitted `<label>Text</label><input>` — adjacent, no `for`, input not
nested. `getLabel()` tries `label[for=id]`, then `el.closest('label')`, then
`aria-label`/`placeholder`; none match that markup. Only the two fields with a `placeholder`
resolved anything ("City, State", "MM/DD/YYYY").

Consequence: `buildAnswers` steps 3 (fuzzy label) and 4 (`custom_answers`) are **both** gated on
`field.label`, so both were unreachable — which is most of what the traps exist to test. The harness
had been verified to boot and serve, not to actually trigger a trap.

Fixed in `scripts/fakeAts.js` by deriving an id from `name` and emitting `<label for=...>`. `for`/id
rather than wrapping the input, because `getLabel()` returns `closest.textContent` — a label wrapping
a `<select>` would fold every option into the label
(`"...require sponsorship?Select...YesNo"`) and corrupt the matching under test. Real
Greenhouse/Lever/Ashby markup associates labels, so this is the fixture matching reality.

**This matters beyond the harness:** any future "the trap matrix is green" claim made against the
pre-fix fixture would have been false-green.

A second blocker: with `resumePath` omitted, the required file inputs made HTML5 validation refuse
every submit, so Greenhouse never left step 1. The matrix uploads a stub PDF.

## Trap matrix

| # | Trap | Expected | Actual (recorded) | Verdict |
|---|---|---|---|---|
| 1 | `sponsorship_inversion` | a sponsorship yes/no, not a work-auth status | `requires_sponsorship = "Yes"` **submitted** alongside `legally_authorized = "Yes"` | **FAIL — critical** |
| 2 | `name_ambiguity` | each name field gets its own value; referrer ≠ candidate | `legal_name` = `preferred_name` = `referrer_name` = `"Ada Lovelace"` **submitted** | **FAIL** |
| 3 | `lowercase_yes` | `'yes'` submitted as affirmative, not `'false'` | field is a `select`; resolved `value:"yes"`, coercion branch never runs | **NOT REPRODUCED — untestable here** |
| 4 | `submit_label` | never a false `submitted` | `filled_not_submitted`, 0 submissions | **PASS** |
| 5 | `required_unmapped` | `held_review` / `incomplete_form` with the label | exactly that, label present in `missingRequired` | **PASS** |
| 6 | ashby date | report what was submitted | `start_date = "2026-09-01"` into an MM/DD/YYYY field | **FAIL — low** |
| 7 | ashby typeahead | resolves, or the gate holds | `_systemfield_location = "Boston, MABoston, MA"` — **doubled** | **FAIL** |

### Trap 1 — severity depends on the *shape* of the stored value

This is the most actionable result for A2. Same trap, two payloads:

| `work_authorization` value | Outcome |
|---|---|
| `"Yes"` | `requires_sponsorship = "Yes"` **submitted**. False material attestation. |
| `"Authorized to work in the US"` | `held_review`, `missingRequired: ["Do you now or in the future require sponsorship…"]` |

The inversion always *happens* — the fuzzy match always fires, because `work_authorization` spaces
to `"work authorization"` and that string is literally inside *"require sponsorship for work
authorization"*. What differs is whether the wrong value is **selectable**: a yes/no-shaped value
matches an option and is submitted; a status string matches none, leaves the select empty, and the
completeness gate catches it.

So the gate is not a safety net for this trap — it only appears to be one, for the subset of profiles
whose work-auth answer happens not to be yes/no shaped. And the submitted pair is self-contradictory
(*authorized to work* = Yes **and** *requires sponsorship* = Yes), which is exactly what a recruiter
screens on.

Note both resolution paths invert: attribute matching gives `handler_type='sponsorship'` (correct,
but the profile has no `sponsorship` key so it falls through), and had it relied on the label map,
`"Work Authorization"` is checked *before* `"Sponsorship"` and would have inverted it too.

### Trap 2 — the audit named the wrong mechanism

The audit attributed this to a short `name` field_map key winning under arbitrary
`Object.entries` order. Both halves are wrong:

- **Removing the `name` key entirely changed nothing** — run `G5_no_short_name` produced identical
  output. The real mechanism is one layer earlier, in `resolveHandler`'s label-map loop:
  `generic` maps `"Name" → full_name`, matched by naive `includes` against `"Name of Referrer"`,
  yielding `handler_type='full-name'` for all three fields. They then resolve through the *exact*
  step-2 path off `field_map.full_name`.
- **It is deterministic, not unstable.** `G3` and `G4` were byte-identical. JS object key order is
  insertion-ordered, so it was never going to vary run to run. It is fragile, not random.

This matters for A2 requirement 1: provenance computed only inside `buildAnswers` would stamp the
referrer field `field_map_exact` / high confidence. **The wrong answer would be labelled as the
most trustworthy kind.** Restricting `buildAnswers`'s fuzzy step without also restricting
`resolveHandler` would leave this trap firing while *looking* clean in the audit trail.

### Trap 3 — real in code, unreachable in this harness

`buildAnswers:453` genuinely tests `value === 'Yes'` (capital only), and an unrecognised value
becomes `'false'`. But that branch runs only for `type` `checkbox`/`toggle`. Lever's control is a
`<select>`, so it takes the `String(value)` path, and `APPLY_FN_SRC`'s option matching is
case-insensitive `includes` — `"yes"` resolves correctly.

`scripts/fakeAts.js` contains **zero** `checkbox`, `radio`, or `switch` controls (grep count 0), so
the coercion path is not exercised anywhere in the matrix. Not disproven — **untested**. A2 should
add a required yes/no checkbox and a `role="switch"` before claiming this one fixed.

## Findings not in the audit register

**N1 — `submitted` is claimed without verifying anything was submitted. (HIGH)**
In the pre-resume matrix, `A1_ashby` returned `status:'submitted'` while `/_submissions` recorded
**0**. `autoApply:879` sets `submitted = true` immediately after clicking a `SUBMIT_RE`-matching
button; there is no navigation wait, no URL/DOM change check, no confirmation match. HTML5
validation had silently blocked the POST. In production this marks the job applied when nothing was
sent — a silent non-application that is also self-concealing, since the duplicate guard then treats
that job as done and it is never retried. `flowState === 'submitted'` (which *is* evidence-based)
is OR-ed with this flag rather than required.

**N2 — the completeness gate exempts file inputs. (HIGH)**
`autoApply:848` filters `f.type !== 'file'`, so a required-but-empty resume field passes the gate
while the browser refuses to submit the form. This is what produced the step-1 dead ends: gate
green, `filled_not_submitted`, no `reasonCode`, no signal that the eligibility step was never even
reached. The resume is only separately gated when `resumePathPromise` is supplied; a caller passing
a direct `resumePath` that is null gets no equivalent check.

**N3 — every context is discovered and filled twice. (MEDIUM)**
`discoverAndFill(page, [page, ...page.frames()], …)` and the gate's
`[page, ...page.frames()].map(…)` both include the main frame twice — `page.frames()` already
contains it. Evidence: `missingRequired` returned exact duplicates of every entry, and
`fieldsFilled` reached 198 on a 9-field step. Mostly wasted work for idempotent `setNativeValue`
fills, but it is the direct cause of N4.

**N4 — typeahead answers are appended, never cleared. (MEDIUM)**
`_systemfield_location = "Boston, MABoston, MA"`. `applyTypeaheadAnswer` uses `el.type()`, which
appends, and ignores `clear_first` entirely — so N3's double pass doubles the text. A required
combobox on a real ATS would reject this or store the corrupted string. Note this interacts with A2
requirement 6: `clear_first` is described as unconditionally destructive, but on the typeahead path
it is not honoured at all.

**N5 — `resolveHandler` has the same substring flaw as the fuzzy step. (MEDIUM, structural)**
Covered under trap 2. Called out separately because A2 scopes the `includes` fix to `buildAnswers`
step 3 only, and that is not where trap 2 originates.

## Ranked by real-world harm

1. **Trap 1 — sponsorship inversion.** A false, self-contradictory eligibility attestation,
   submitted. Materially misrepresents the candidate to an employer.
2. **N1 — false `submitted`.** Silent non-application, invisible and never retried.
3. **N2 — file exemption in the gate.** Enables N1 and the silent step-1 dead end.
4. **Trap 2 — referrer gets the candidate's name.** A false referral claim, submitted. Compounded by
   N5, which would let it pass A2's audit trail wearing high confidence.
5. **N4 / trap 7 — doubled typeahead value.** Corrupted required field, submitted.
6. **N5 — handler-layer fuzziness.** No wrong answer of its own; undermines the provenance layer A2
   is built on.
7. **N3 — double discovery.** Wasted work, inflated metrics, root cause of N4.
8. **Trap 6 — ISO date into an MM/DD/YYYY field.** Formatting; would be rejected or misparsed.
9. **Trap 3 — lowercase yes.** Real in code, unreachable here. Needs a checkbox/toggle fixture.

Traps 4 and 5 pass and should get regression tests in A2 so they stay passing.

## Scope note for A2

Requirement 2 ("restrict step 3's `lbl.includes(k)`") is necessary but **not sufficient** for the two
name/eligibility traps: `resolveHandler`'s label-map loop reproduces the same flaw upstream, and
trap 2 originates there. Requirement 5 (don't auto-submit `label_fuzzy`) would catch trap 1 only if
provenance is computed across **both** layers — a `resolveHandler` label hit currently becomes
indistinguishable from a genuine attribute match.

## Regression surface

- `scripts/fakeAts.js` — modified (label association). Dependents: **none**; nothing imports it,
  it is a standalone dev server. Children: `node:http` only. **Verdict: no regression surface.**
- `scripts/a1TrapMatrix.mjs` — added. Imports `services/applyAutomation.js` read-only.
  **Verdict: additive.**
- `services/applyAutomation.js`, `services/platformDetector.js`, `services/browserLauncher.js` —
  **read only, unmodified.** **Verdict: unchanged.**
- No migration required — this task adds no schema.
- Test baseline **600 pass / 0 fail before and after; introduced failures: 0.**

## Addendum — trap 8, added later

The record above is left as it was written. Two things in it have since been overtaken:

- An eighth trap (the resume upload) was added to A1's scope afterwards. It could not be run at the
  time — no fakeAts form declared `enctype`, so an upload was indistinguishable from a skipped field.
  Fixed in `b913b7b`; the trap is answered in **`docs/auto-apply-a8-file-upload.md`** (PASS).
- Finding **N2** (the completeness gate exempted file inputs) was fixed in A2 and is verified closed
  by trap 8f. Trap 3's note that the harness has no checkbox anywhere is also stale — one was added
  to the ashby form.

## Environment caveat (A4)

The runs were driven by a script that does not load `dotenv`, so
`PUPPETEER_EXECUTABLE_PATH` was unset and `launchBrowser` resolved `source=system:windows`. `.env`
sets it to `/usr/bin/chromium`, which does not exist on this machine — so a driver that *did* load
`.env` would have failed to launch. That is TASK A4's territory and was deliberately side-stepped,
not fixed. Note `browserLauncher.js:244` passes `executablePath: resolution.path`, not the
`process.env.… || resolution.path` that A4 describes, so A4 should re-confirm its line reference
before assuming the bug is where it says.
