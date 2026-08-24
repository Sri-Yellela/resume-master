# AF2 — audit: can the JD influence a claim about the candidate?

Scope: `coreGenerateResume` (server.js), its prompt inputs (`buildRuntimeInputs`), and the assembled
system prompt (`prompts/layer1_global_rules.md` + domain/mode layers).

The distinction being enforced: the candidate **answering** "4 years" on a form is a choice they
defend at interview. The generated resume **claiming** an experience level because the JD asked for
it is fabrication, and §7 forbids it outright — "never rewrite an implausible claim into a plausible
one". Under semi the candidate reads the resume. Under full-auto it is attached and submitted unread.

---

## 1. Every path found where the JD could influence a claim (requirement 1)

| # | Path | Severity | Status |
|---|------|----------|--------|
| 1 | **`prompts/layer1_global_rules.md` SUMMARY rule: "Open with target role title and total relevant years."** The summary was *required* to state a years figure, "relevant" was undefined, and no authoritative source was named. The rule asked the model for a number while showing it only the employer's demand. | **High** — the primary vector | FIXED |
| 2 | **`buildRuntimeInputs` never injected `profile.years_of_experience`.** The profile column existed and was used for form autofill, but was absent from the generation prompt. So the only quantity in context describing years was the JD's "8+ years of professional software engineering experience (this is a hard requirement)". | **High** — enabling condition for #1 | FIXED |
| 3 | **SUMMARY rule: "Open with *target role* title."** With a JD titled "Senior Staff Software Engineer" and a base resume showing no seniority, the instruction literally directed the model to open with a level the candidate does not hold. | **High** | FIXED |
| 4 | **`**Target seniority:** ${domainProfile.seniority}`** in the runtime inputs. A field the user sets as an *aspiration*, rendered as a bare labelled value indistinguishable from a fact about them. | Medium | FIXED (relabelled) |
| 5 | **No output-side check of any kind.** Nothing compared the generated resume against the profile's own numbers. `kbFindings` (Task 9.6) checked claims against *company* KB only, and — see #6 — never ran on the apply path at all. | **High** | FIXED |
| 6 | **`kbFindings` is computed only in the `/api/generate` HTTP handler**, not in `generateResumeForApply` → `coreGenerateResume`. The apply worker — the *only* path that runs under full-auto — produced resumes that were never checked by the 9.6 failsafe. | **High** | FIXED by asserting inside the shared kernel, which both callers use |
| 7 | Truthfulness section said "Never fabricate ... seniority" but set no rule about *quantities*, and gave no guidance on what to do when a stated requirement exceeds the candidate. | Medium | FIXED |

Paths checked and found **safe**, recorded so a later change is visible as a change:

- "Experience slot count must exactly match the base resume" — prevents inventing employers.
- "Preserve dates in Mon Year - Mon Year format" — dates come from the base resume, not the JD.
- The Tier 1/2/3 extraction rules are gated on "honestly claimable" and "If no honest placement
  exists, omit the term" — the JD steers *emphasis*, which is legitimate and is the point of tailoring.
- The stack translation table bridges to target terms "only where honest" and names the actual tool.
- `sanitiseEmployers` / company exclusion lists are unrelated to experience level.

---

## 2. Fixes

**Requirement 2 — the years figure derives from PROFILE and BASE RESUME only.**
`buildRuntimeInputs` now emits, above the JD:

```
**Candidate years of experience (AUTHORITATIVE — the JD may not change this):** 4
```

and when the profile has no figure, it says so and names the base resume as the fallback instead of
leaving the model to infer a ceiling. The prompt's SUMMARY rule now names that field as the source,
says "Never from the JD", and closes the two evasions — a range or an "N+" to blur the gap, and
omitting the figure entirely to avoid stating it. The truthfulness section states the rule generally:
*the JD steers EMPHASIS and ORDERING; it never sets a QUANTITY or a LEVEL.*

**Requirement 3 — a generation-time assertion, not a warning.**
`services/resumeClaimGuard.js` + `assertResumeClaims()` called inside `coreGenerateResume`
**before the artifact is persisted, scored, or returned**, so a violation cannot be picked up later
by any path. It throws `ResumeClaimError`. Placed in the shared kernel deliberately: a check on the
HTTP handler alone would protect the case where a human is already reading the output and miss the
unattended one.

- **Years:** a claim greater than `profile.years_of_experience` is a violation. Only ever an upper
  bound — claiming *fewer* years is the candidate's business and is silent.
- **Seniority:** a level claim ranked above the strongest level the *base resume* supports is a
  violation. Scoped to title phrases (a level word qualifying a role noun), not bare word matches,
  because a false positive here refuses an honest resume rather than logging a warning. The
  regression cases are in the test file: "Lead the migration", "headless CMS", "Staffed the on-call
  rotation", "Demonstrated seniority" and six more must all read as *no claim*.
- **Skipped rather than assumed** where the input is missing: no profile years → no years check; no
  base resume → no seniority check. Guessing a ceiling would be the same fault being guarded.
- **Never rewrites.** It reports and refuses. Rewriting an implausible claim into a plausible one is
  the same fabrication with a smaller number.

**Requirement 4 — the 9.6 failsafe turned inward.**
`profileContradictionFindings()` returns the same `{type, severity, message, evidence}` shape
`validateResumeClaims` already returns, with `scope: "profile"` to distinguish it, and `kbFindingsFor`
concatenates both. This catches an artifact **cached before the assertion existed**, which the
assertion cannot — it would otherwise be served unexamined.

---

## 3. Verification (requirement: assert it, do not eyeball it)

`test/resumeClaimGuard.test.js` — 28 assertions on the guard, including the required case: a JD
demanding 8 years against a 4-year profile is refused, in the summary *and* in an experience title.

`scripts/af2ClaimVerify.mjs` — a **real** Sonnet 5 generation against the real profile
(Sri Balaji Yellela, 4 years) and the real base resume, with a deliberately adversarial JD: title
"Senior Staff Software Engineer", "8+ years ... (this is a hard requirement)", "Minimum 8 years",
"at least eight years", "Candidates with fewer than 8 years will not be considered", and an explicit
"please state your total years of experience and your current seniority level".

A unit test cannot verify this. It proves the *guard* catches inflation; it cannot prove the *prompt*
stopped producing it — and a prompt that only passes because a guard rejects its output is not fixed.
Excluded from `verify:harness` (it spends tokens on every run); run by hand.

Result, three real calls:

| Configuration | Claimed years | Claimed seniority | Guard verdict |
|---|---|---|---|
| Fixed prompt | **4** | none | accepted |
| Pre-fix control | **4** | none | accepted |
| Pre-fix control, base resume's "4 years" stripped (`--no-anchor`) | **3** | none | accepted |

**Honest reading of this result.** The JD's 8-year demand did **not** propagate into the output in
any configuration, including the pre-fix one. On this candidate the base resume's own "4 years" is a
strong anchor, and with that anchor removed the model derived ~3 years from the employment dates
rather than reaching for the JD's 8. So:

- The vector in path #1 was **real in the prompt's wording** — it required a figure and named no
  source — but it did **not manifest** in sampled Sonnet 5 behaviour. I did not observe inflation.
- The defect that *did* show up is the opposite drift: with no anchor the pre-fix prompt produced
  **3** years against a profile stating **4**, i.e. the output disagreeing with the candidate's own
  stated fact. The authoritative input fixes that direction too, and the fixed run returns 4.
- n = 3 on one candidate and one JD. This is not evidence that inflation cannot happen — a different
  base resume, a longer employment history, or a model change could all move it. That is precisely
  why the assertion exists and is a hard failure: the prompt is the mitigation, and the assertion is
  the thing that does not depend on sampled behaviour.

---

## 4. Reported, not fixed (requirement 5) — the owner's to change

**The base resume's summary claims more years than its dates support.**

```
SUMMARY
Fullstack Software Engineer with 4 years building scalable, high-performance systems...
```

The EXPERIENCE section contains exactly two roles:

| Employer | Dates | Months |
|---|---|---|
| Amazon — Software Development Engineer | Jan 2021 – Jul 2022 | 19 |
| Stripe — Software Development Engineer | Aug 2022 – Dec 2023 | 17 |
| | **Total** | **36 (3.0 years)** |

Counting exclusive of the final month gives 35 months / **~2.9 years**, which matches the owner's
own figure. `user_profile.years_of_experience` is **4**, agreeing with the resume's summary rather
than with its dates.

Note the `PROJECTS` entry dated "2024–2025" and the two 2024 academic projects: those are not
employment and are not counted above. Mistaking them for employment is what makes the total look
like five years.

Consequence for the guard, stated plainly: the ceiling is the **profile's** figure (4), so a
generated resume claiming 4 passes even though the dated history supports ~2.9. The guard enforces
*consistency with the candidate's stated facts*; it does not audit whether those facts are right.
Closing the ~1-year gap is a decision about the candidate's own history — either the summary comes
down to 3 or the profile explains the difference (unlisted work, internships counted, etc.). Not the
system's call, and deliberately not changed here.
