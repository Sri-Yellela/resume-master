# Non-greenhouse coverage (Deferred item)

**The gate is not met, and the gated part was not done.** The deferred item reads "Only after
greenhouse is reliably green", which means A5 — one real greenhouse application, with you present.
That has not happened, so **`V1_AUTO_PROVIDERS` is unchanged** (`greenhouse`, `lever`, `ashby`), and
every other provider still routes to `held_review` / `provider_review_only`.

What was done is the half that does not depend on it, and that I had already flagged twice as its
prerequisite: **audit the provider label maps, and get the untested provider shapes under the
harness.** That work found a bug I introduced in A2 which had been silently degrading resolution for
every provider.

## The bug: a backslash eaten by a template literal

`DISCOVER_FN_SRC` is a template literal, so a single backslash is consumed by the parser. The
in-page `tokenMatch` needle normaliser was written with one, and therefore **shipped normalising runs
of the letter `s` instead of whitespace**:

```js
// intended                          // actually emitted to the browser
.replace(/\s+/g, ' ')                .replace(/s+/g, ' ')
```

So `"First Name"` normalised to `"fir t name"` and never matched itself. **Every multi-word
label-map key containing an `s` silently failed** — First Name, Last Name, Years of Experience,
Postal Code, Security Clearance, Address Line 1, Sponsorship — and a shorter key such as `"Name"`
won instead.

It was invisible because the attribute path (`HANDLER_BY_ATTR`) covers the common fields on the
fixtures, and the label map is only the *fallback* for controls whose attributes do not identify
them. It surfaced the moment a provider relying on that fallback was exercised: the workday fixture
resolved **both** "First Name" and "Last Name" to the candidate's full name.

Introduced in A2, live through A3/A4 and both deferred items. Guarded now by a test that evaluates
the **escape-processed** value of all three in-page scripts — that catches the whole class, not just
this instance. Verified to fire against the exact original line.

*(A footnote on the same theme: the comment I first wrote explaining this fix contained the forbidden
pattern and its own backslash collapsed identically — the fourth time this session a comment has
tripped an assertion about itself. The check strips comments.)*

## Audit findings and fixes

**Nine dead label mappings.** A map value must be a key of `PROFILE_KEY_TO_HANDLER` or
`resolveHandler` silently skips it:

| value | providers | why it was dead |
|---|---|---|
| `years_experience` | greenhouse, lever, workday, generic | the real key is `years_of_experience` |
| `clearance_level` | greenhouse, lever, workday, generic | no profile key produced a `clearance` handler |
| `visa_type` | generic | no profile key produced a `visa` handler |

The last two are notable: A2's `ELIGIBILITY_HANDLERS` already lists `clearance` and `visa` as the
valid handlers for those classes, so the guard tables were written against handlers **nothing
produced**. Wired up, which makes the eligibility guard's canonical-key path work for clearance and
visa questions instead of refusing every key and holding the run.

**Provider maps shadowed generic instead of extending it.** The eleven non-generic maps carried 5–15
entries against generic's 22, and **none had a plain `"Name"`** — which is why ashby (whose only name
control is labelled exactly "Name") and greenhouse ("Legal Name") could not resolve the candidate's
name, a gap I reported twice as two separate provider defects when it was one structural one.
`getPlatformLabelMap` now returns the provider map layered over generic: provider entries first (so a
provider-specific spelling like lever's "Email address" is tried before generic's "Email", and wins
on collision), generic entries as fallback. Every provider went from 5–15 to 22–28 entries with full
core coverage.

Ordering is asserted: `"First Name"` must be tried before `"Name"`, or both name halves collapse onto
`full_name` — exactly what the live iframe run caught.

**The iframe path had never been exercised.** `usesIframe()` is true for workday, icims and taleo —
three of the nine providers outside the allowlist — and the harness had no iframe at all. Added a
workday-shaped fixture (`/workday` hosting `/workday/inner`). It found two main-frame-only
assumptions:

- **File upload** scanned only the main document, so with A3's gate now checking required file
  fields, every iframe-hosted run held on "Resume" — the resume was never uploaded because nothing
  looked inside the frame. Fixed, frame-aware, with the uploaded flags threaded so one resume is not
  attached twice.
- **Typeahead fill** looked the control up in the main document and silently never filled it. Fixed
  to use the owning frame. For a single-document form `frame === mainFrame`, so both are no-ops on
  the existing providers.

Result: an iframe form now fills completely and passes the completeness gate.

## Deliberately not done

**Cross-frame submission.** The `SUBMIT_RE` scan is still main-frame-only, so the iframe fixture ends
`filled_not_submitted` / `no_submit_button` with `submitVerified: false` and zero submissions —
honest, thanks to A1's N1 fix. Making it frame-aware would change behaviour on **greenhouse**, which
embeds its form in an iframe on some boards and is a live full-auto provider: it could start
submitting where runs currently stop. That belongs with the provider-allowlist decision, gated on A5.
Asserted by test so it is not enabled by accident.

**Speculative label entries for untestable providers.** I did not invent spellings for icims, taleo,
jobvite, smartrecruiters, workable or bamboohr. The generic fallback gives them real coverage; going
further needs real forms.

## Verification

- **Trap matrix** — unchanged: every trap holds or passes, ashby still submits correct values.
- **Correction loop** — now converges in **one round with two questions**, down from two rounds. With
  the maps fixed, "Are you legally authorized to work…" resolves from the canonical
  `work_authorization` key instead of being asked; **sponsorship is still asked**, because it is not
  derivable from work authorization — the entire A1 trap. Asserted as that invariant rather than a
  question count.
- **A3 guards** — all pass, after a fixture fix (below).
- **Iframe fixture** — fills every field correctly (`First Name = "Ada"`, `Last Name = "Lovelace"`,
  resume uploaded, gate passed), stops at `no_submit_button`.
- **Suite: 654 → 664 pass, 0 fail, 0 introduced.** 10 tests added.

## Two incidental findings

**One missing column loses the whole audit trail.** `a3GuardsIntegration.mjs`'s in-memory schema
predated migration 073, so the audit `UPDATE` — which now also sets `open_questions_json` — threw and
its `try/catch` silently dropped **every** audit field while the run still reported success. Fixture
fixed, but the shape is worth knowing: all audit columns share one best-effort statement, so on an
un-migrated deployment the entire audit row is lost rather than just the new column. It only
`console.warn`s.

**`"Website" → github_url`** in both the greenhouse and generic maps. Pre-existing, looks like a
copy-paste from the GitHub entry, and it means a website field gets the GitHub URL. Not touched —
it is a data question about what those profile keys mean, not a bug in the resolution path.

## What remains for real non-greenhouse coverage

1. **A5** — the gate. One real greenhouse application, semi mode, you present.
2. Frame-aware submission, decided together with the allowlist.
3. Real-form validation of the thin provider maps, now that the generic fallback makes them workable.
4. Then, and only then, add a provider to `V1_AUTO_PROVIDERS`.
