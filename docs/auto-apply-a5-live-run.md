# TASK A5 — the first live application. NOT SENT. Stopped at step 1.

**Outcome: no application was submitted. No browser was ever opened at a real employer.**
The only network contact with Greenhouse was read-only `GET` requests to the public board API
(`boards-api.greenhouse.io`), which returns a posting's question schema as JSON and accepts nothing.

Every precondition in the gate was checked rather than taken on trust. All seven pass. The run then
stopped on **procedure step 1** — *"ONE greenhouse job the candidate genuinely wants"* — because that
judgement is the candidate's, and because the posting's form turns out to require five answers that
neither the profile nor the resolver can supply and that I will not invent on a real person's behalf.

The stop is **not** the "wrong answer → return to the resolver" stop. No wrong answer was found.

---

## 1. Preconditions — every one checked

| # | Precondition | Verdict | Evidence |
|---|---|---|---|
| 1 | AA1 fixed — an empty board mid-run is disqualifying | **PASS (by symptom)** | `AA1` has no referent anywhere in the repo, so the behaviour it names was verified instead — and along **both** paths that can empty a board. (a) Title filter: user 15's active profile (`A5 Candidate`) has `target_titles=[]`, and `profileTitleSql` returns `1 = 1` for that, so it is *no* filter — 1256 of 1256 active rows survive. (b) Curation: "Showing 0 of N" is actually produced by `deriveProfileFilters` building `q` from `profile_simple_apply_profiles.search_terms_json`, which collapses to resume skills alone when `target_titles` is empty. User 15 has **no row in that table at all**, so no curation is applied. `boardSecondLoadParity`, `jobsBoardColdLoad`, `syncEventsSingleConnection` all green. |
| 2 | Enrichment complete — 1261/1261, skills 99.8% | **PASS (exceeds)** | Board has grown since that figure: **1282/1282** enriched (100%), skills **1280/1282 = 99.84%**. |
| 3 | PDF generation working end to end; the resume IS the payload | **PASS** | Ran `server.js`'s `htmlToPdf` settings against a real stored artifact: **94,760 bytes, valid `%PDF-` magic, 4.4 s**. Base resume for user 15 is real and substantive — 4,912 chars, the candidate's own contact details. |
| 4 | A `claude-sonnet-5` row in `usage_events` since the model-ID fix | **PASS** | `usage_events` id 78 — `resume_generate`, `model=claude-sonnet-5`, `success=1`, 2,125 output tokens, `$0.0416`, 18.5 s, 2026-08-21. |
| 5 | `launchBrowser` uses `resolution.path`, not the raw env override | **PASS** | `browserLauncher.js:246` passes `executablePath: resolution.path`. The override is existence-checked first (`:54-64`): `.env` sets `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`, which does not exist here, and resolution correctly falls through to `system:windows` → `C:\Program Files\Google\Chrome\Application\chrome.exe`. Verified by running it. |
| 6 | A1 trap matrix green — sponsorship-inversion and lowercase-yes | **PASS, but weaker than it looks — see §4.1** | Full matrix re-run. Sponsorship inversion no longer fires: `job_application[requires_sponsorship]` resolves to `null`, and the run holds `held_review/incomplete_form`. Name ambiguity also fixed — `referrer_name` resolves to `null`, not the candidate's name. Lowercase-yes is now polarity-aware (`booleanPolarity`, `coerceAffirmative`) and covered by 12 passing tests. |
| 7 | G-series credential guard active | **PASS** | `node scripts/g6CredentialGuard.mjs` → **ALL PASS**. `login_email` keeps no handler and receives nothing though it is named `email` and the payload has one; password controls receive nothing; the application form on the same page still fills. |

Suite: **1480 pass / 0 fail** (`npm test`).
Preflight: `node scripts/a5Preflight.mjs --user 15 --job greenhouse::5691911004` → **PREFLIGHT CLEAR**, exit 0.

The identity blocker recorded in `auto-apply-a5-preflight.md` is **cleared**: user 15 is a real
candidate (Sri Balaji Yellela), not the `John Doe` fixture. That doc's "NO-GO" is stale.

---

## 2. What the real form actually asks

Read from the posting's own schema, not guessed:
`GET https://boards-api.greenhouse.io/v1/boards/figma/jobs/5691911004?questions=true`

**Figma — Software Engineer - Full Stack**, 20 questions / 21 controls, of which **10 are required**.

The owner asked to confirm what the form asks about sponsorship before the human commits. The answer
is decisive and unexpected:

> **This form does not ask about sponsorship at all.**

Its only eligibility question is *"Are you authorized to work in the country for which you applied?"*
(required, Yes/No). I scanned **14** Figma engineering postings — every IC SWE role, plus Security and
Data Engineer. **None of them asks about sponsorship.** So the `requires_sponsorship=0` hazard does not
arise anywhere on this board. It remains a live latent defect for employers who *do* ask — see §4.1.

The five required questions the system cannot answer:

| Required question | Type | Can the profile answer it? |
|---|---|---|
| Why do you want to join Figma? | textarea | **No** — nothing in the profile, `custom_answers` is `{}` |
| From where do you intend to work? | text | **No** — not filled; `location` did not match this label |
| Have you ever worked for Figma before, as an employee or a contractor/consultant? | Yes/No | **No** |
| How many years of professional experience do you have in this type of role (excluding internships)? | select: 0–2 / 3–4 / 5–10 / 10+ | **No** — not filled (see §4.3) |
| Have you worked as a full-time software engineer in a professional setting (excluding internships)? | Yes/No | **No** |

---

## 3. Field-by-field review — every field, its provenance, and whether it is right

Procedure step 3 requires dumping every resolved answer with provenance and confidence and reading it
against the rendered form. Doing that against Figma would mean opening a browser at the employer, so
it was done against a **faithful local replica** instead: a form generated from the posting's own
schema, preserving every control's `name`, label, type, option set and required flag, served on
`localhost:4601`. The resolver ran in `mode:'semi'` with the real `buildAutofillPayload` output for
user 15. **Read §5 for what a replica cannot tell you.**

| Req | Question | Filled with | Provenance | Correct? |
|:---:|---|---|---|:---:|
| * | First Name | `Sri Balaji` | handler_exact 1.0 | yes |
| * | Last Name | `Yellela` | handler_exact 1.0 | yes |
| * | Email | `yellelasribalaji@gmail.com` | handler_exact 1.0 | yes |
| * | Phone | `+1 (402) 500-0033` | handler_exact 1.0 | yes |
| * | Resume/CV | file attached | (file path, no answer row) | yes |
| | Resume/CV (paste alternative) | — empty | — | yes, correct to leave blank |
| | LinkedIn Profile | `https://www.linkedin.com/in/sriyellela` | handler_exact 1.0 | yes |
| | Other Website | — empty | — | yes, honest blank; `portfolio_url` is empty |
| | Preferred First Name | `Sri Balaji` | handler_exact 1.0 | yes |
| * | Are you authorized to work in the country for which you applied? | `Yes` | handler_exact 1.0 | yes — **and this is the important one** |
| * | Why do you want to join Figma? | — empty | — | REQUIRED, BLANK |
| * | From where do you intend to work? | — empty | — | REQUIRED, BLANK |
| * | Have you ever worked for Figma before…? | — empty | — | REQUIRED, BLANK |
| * | How many years of professional experience…? | — empty | — | REQUIRED, BLANK |
| * | Have you worked as a full-time software engineer…? | — empty | — | REQUIRED, BLANK |
| | 3 × optional multi-selects (teams, expertise, languages) | — empty | — | blank; all three are answerable and would strengthen the application |

**7 answers filled, 7 correct, 0 wrong. Zero fuzzy matches — every fill is `handler_exact` at
confidence 1.0.** The resume attached correctly.

The work-authorization answer deserves note because it is the one the A1 audit called the most
dangerous field in the system. The profile stores `work_auth` as the free-text status
`"Authorized to work in the US (F-1 STEM OPT)"`. Posting that string verbatim into a Yes/No control is
A1 finding #2. The A2 fix reads the status instead: `workAuthAffirmative` resolves it to affirmative,
and `matchOptionValue` maps that onto the option the form actually offers. It answers **Yes**, which
is true — an F-1 STEM OPT holder is authorized to work now.

---

## 4. Findings

### 4.1 The trap matrix cannot see the sponsorship hazard it is supposed to guard (HIGH) — **FIXED**

> **Fixed before the run, at the owner's instruction. See §7 for what was built and how it verifies.**
> The paragraphs below are the diagnosis as written, kept because the reasoning is the argument for
> the shape of the fix.


Precondition 6 is satisfied, and it is weaker than it sounds. The matrix passes the
sponsorship-inversion trap by *holding* — but it holds only because **its payload has no sponsorship
key at all**, so the resolver falls through to a refusal. The real payload does have one:

```
buildAutofillPayload → field_map.requires_sponsorship = "No"
                       field_map.sponsorship          = "No"
                       handler_map['sponsorship']     = "No"
```

Run the real profile against the canonical Greenhouse wording — which `fakeAts` renders verbatim —
and it does not hold. It answers:

```
"Do you now or in the future require sponsorship for work authorization?"  →  "No"
                                              provenance=handler_exact  confidence=1.0
```

The candidate is on **F-1 OPT**. They are authorized now, and they **will** require H-1B sponsorship in
the future. For a question whose scope is explicitly *"now or in the future"*, `No` is false — and it
is delivered at the **highest** confidence tier, with no `!` flag, no refusal, and the completeness
gate satisfied. The safety net is silent exactly where the stakes are highest.

The polarity machinery is not at fault; it is correct. `applyAutomation.js:337` deliberately reads
*"do you now or in the future require sponsorship"* as the same sense as `requires_sponsorship`, and
that is the right call. **The defect is the data model:** `requires_sponsorship` is one boolean, and it
is being asked a two-tense question. `0` is the true answer to the present tense (*"can you work
without sponsorship today?"* — yes, on OPT) and a false answer to the future tense. This is precisely
the reading the owner flagged.

It does not block this run — no Figma posting asks. It will bite the first employer that does, and it
will bite silently. **A single boolean cannot answer this question; it needs a tri-state or two fields.**

### 4.2 Semi mode runs no gates, and reports `missingRequired: []` when it has not looked (HIGH)

`isUnattended = isFullAuto || isPreview` (`applyAutomation.js:1952`). Semi is neither, so in semi mode
**both the completeness gate and the low-confidence gate are skipped entirely.**

The consequence is a misleading audit row. On the replica, with **five required questions blank**, the
semi run returned:

```
status=awaiting_user   fieldsFilled=7   missingRequired: []   rejectedAnswers: []
```

`missingRequired: []` does not mean "nothing is missing". It means **nothing was checked**. Worse, the
five blank required questions produce *no answer record at all* — not even a skipped one carrying a
refusal — so they are invisible in `res.answers`, which is what the review surface renders. A human
reading that surface sees seven rows, all `handler_exact` at 1.0, no flags, and no indication that the
form cannot be submitted. The `!`-marks-a-guess convention that the rehearsal tells you to read first
gives an all-clear here.

For a mode whose entire safety argument is *"the human reviews it"*, the review surface should not be
able to say "complete" about a form it never inspected. It should either run the gate read-only, or
render `missingRequired` as unknown rather than empty.

### 4.3 Two profile facts are wrong or stale, independent of any resolver bug (MEDIUM)

- **`years_of_experience = 3`, but the base resume claims "4 years"** — first line of the summary:
  *"Fullstack Software Engineer with 4 years building scalable…"*. The form and the resume attached to
  it would disagree in the same submission. The form's own buckets (`0–2 / 3–4 / 5–10 / 10+`) make this
  harmless if answered `3–4 years`, which is consistent with both — but the underlying inconsistency
  should be resolved, not papered over by lucky bucketing.
- **`available_start_date = 2026-08-13` is in the past** (today is 2026-08-23). No field on this
  posting asks for it, so it does no damage here; on a posting that does, it would submit a start date
  ten days behind the application.

Also worth recording: the YoE select was **left blank**, not filled. The value `"3"` does not match any
option, because Greenhouse's option *values* are numeric IDs while its *labels* carry the text — so the
matcher correctly declined rather than guessing. Safe, but it means the field needs a human.

### 4.4 `scripts/a5Rehearsal.mjs` rehearses the wrong payload (MEDIUM)

The rehearsal is the prescribed dry run before the run that counts, and it hand-builds its own
`field_map` from 13 profile columns. That subset **omits every eligibility field** — no `work_auth`,
no `requires_sponsorship`, no `visa_type` — and omits `gender`, `ethnicity`, `veteran_status`,
`disability_status`, `desired_salary` and `willing_to_relocate` as well. The real run uses
`buildAutofillPayload`, which supplies all of them.

So the rehearsal cannot exercise the answers that carry the most risk, and a clean rehearsal is not
evidence about them. It should call `buildAutofillPayload` rather than keeping a second, narrower copy
of the payload.

---

## 5. What this report does *not* establish

**Discovery against the real rendered page is unmeasured.** The replica reproduces the form's schema —
names, labels, types, options, required flags — but not Greenhouse's actual markup. The live page is a
React application whose selects are typically custom combobox widgets, not the native `<select>`
elements the replica serves. `GATED_HANDOFF_STATUS.md §7.3` records the precedent: G4's original
blocker was a live Ashby posting returning **zero** fields.

So §3 establishes that **the resolver produces no wrong answer from this profile against this form's
schema**. It does not establish that the resolver can read the real page at all. That is exactly what
the first live semi run is for, and it is the one thing no amount of local work can settle.

---

## 6. To unblock — two inputs, both the candidate's

1. **Name the posting.** The pool is 101 rows, all Figma, of which ~14 are IC engineering. Preflight is
   clear for `greenhouse::5691911004` (*Software Engineer - Full Stack*), which fits the profile's own
   description of itself, but nothing in the profile records a preference — `target_titles`,
   `target_skills`, `target_domains` and `target_locations` are all empty. This is step 1, and it is a
   judgement only the candidate can make.

2. **Answer the five required questions**, above all *"Why do you want to join Figma?"* These are the
   candidate's own statements of fact and motivation. Fabricating them is what would make this the
   "bad first application" the gate exists to prevent. Once known they belong in
   `user_profile.custom_answers` (currently `{}`), keyed by label, where the resolver will pick them up
   as `custom_answer` provenance.

Then: `node scripts/a5Preflight.mjs --user 15 --job <job_id>`, a visible browser in `mode:'semi'`, the
field-by-field read against the real rendered form, and the human clicks submit.

**Recommended before that run:** fix §4.3's two profile facts (one-line edits), and decide §4.1 — not
because this posting needs it, but because the next employer might ask, and the wrong answer will look
like the most trustworthy row on the page.

---

## 7. The sponsorship fix (§4.1), built before the run

`requires_sponsorship` stored an **answer**. It now stores a **situation**, and the answer is computed
per question. Migration **086** adds `user_profile.sponsorship_need`:

| value | meaning | present tense | future-inclusive |
|---|---|:---:|:---:|
| `none` | citizen or permanent resident | No | No |
| `future` | authorized now under a time-limited status (F-1/OPT, CPT, J-1) | No | **Yes** |
| `now` | needs sponsorship to start at all | Yes | Yes |
| `NULL` | never asked | *refuses* | *refuses* |

`sponsorshipQuestionTense` reads the question's own time scope — future-inclusive checked **first**,
because the canonical wording contains both markers ("now **or in the future**") and the future
reading governs. `sponsorshipAnswer` then combines tense with the existing direction logic
(`needs` vs `without`), so both dimensions are resolved rather than one.

**Three things are deliberate:**

- **`NULL` is the default, and there is no fallback to the boolean when the tri-state is present but
  null.** `resolveSponsorshipNeed` returns null for exactly one input — `requires_sponsorship=0` on a
  profile whose visa/work-auth text names a time-limited status — because that 0 was set against the
  present-tense reading and is ambiguous between `none` and `future`. Falling back there would
  reinstate the bug. It refuses, and the run holds.
- **A payload with no `sponsorship_need` key keeps the old path.** Present-but-null and absent are
  different: the extension payload and the A1-era tests carry no tri-state, and none of them changed
  behaviour. `'sponsorship_need' in payload` is the discriminator.
- **An untensed question takes the disclosing reading**, marked `sponsorship_assumed_future` at
  confidence **0.75** — below `AUTO_SUBMIT_MIN_CONFIDENCE` (0.8), so full-auto holds and asks. Across
  both question directions the future-inclusive answer is the one that *discloses* the need;
  over-disclosing is honest, and the opposite error misrepresents the candidate.

**Step 1 of `buildAnswers` was the actual hole.** It reads `handler_map` by handler type and applies
**no guard at all** — no `refuseReason`, no polarity check. That is how `handler_map['sponsorship'] =
"No"` reached a future-tense question at confidence 1.0 while every guard in the system stood by.
Steps 1 and 2 are now closed to sponsorship-class fields. `custom_answers` (step 3) still wins: the
candidate's own answer to that exact question is better evidence than anything computed.

### Verified

```
Do you now or in the future require sponsorship for work authorization?
  before:  "No"   handler_exact         1.0     <- false attestation
  after:   "Yes"  sponsorship_derived   1.0     matched_on=sponsorship_need:future/future
Are you legally authorized to work in the country of employment?
  after:   "Yes"  handler_exact         1.0     unchanged, and true
```

The pair is now consistent and both halves are true: authorized today, will need sponsorship later.

Suite **1480 → 1506, zero failures** — 24 new tests in `test/sponsorshipTense.test.js` and 2 in
`reviewOverlay.test.js`. The new ones pin the OPT case, the citizen case that must not be disturbed,
the refusal on an ambiguous legacy profile, the untensed-question reading, the checkbox path (a
derived answer must not be re-inverted by the polarity layer), and the absent-key back-compatibility
path. The extension's duplicated confidence table gained both tiers — a drift there would have the
overlay calling an answer certain that the resolver scored as a guess — and a new test now requires
every provenance to carry a tier label, so the next one cannot ship rendering `undefined`.

Re-verified against the Figma target form afterwards: **unchanged**, 7 filled, all correct. That form
asks no sponsorship question, so the fix is invisible there — which is the point of doing it now
rather than on the posting that does ask.

`user_profile.sponsorship_need` for user 15 is set to **`future`**, and the Profile panel now offers
the three situations as a select instead of a checkbox that cannot express them.

### Deliberately not changed: the second copy of this fact

`profile_simple_apply_profiles.requires_sponsorship` is a **separate** boolean, surfaced as
`structuredFacts.requiresSponsorship` and written by its own UI in the Profile panel. It was traced
before being left alone. Its only consumers are `services/jobs/profileFilterBridge.js` (which jobs to
show on the board), `services/localAtsScorer.js` (a scoring heuristic) and
`services/profileSignalAggregator.js`. **None of them reaches `buildAutofillPayload` or
`buildAnswers`**, so no form answer is derived from it.

That makes it a different kind of fact with different stakes: wrong, it ranks postings badly. It
cannot produce a false attestation to an employer, which is what this fix is about. It is still a
duplicated fact that can drift from the tri-state, and unifying them is worth doing — but doing it
here would have meant touching the board's filtering on the way to a live application, which is
exactly the wrong time.
