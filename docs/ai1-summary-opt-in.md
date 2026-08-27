# AI1 — the summary section becomes opt-in

Default **OFF**, per job profile. The rule leaves the prompt rather than the output being stripped,
and AF2's inflation check still runs — and now says what it inspected.

---

## 1. The preference (requirement 1)

`domain_profiles.include_summary INTEGER NOT NULL DEFAULT 0`, migration `092_profile_summary_opt_in`,
byte-identical in `server.js`'s `MIGRATIONS` array and `scripts/migrations.js`. Additive: one
`ALTER TABLE ... ADD COLUMN`, no rewrite, no backfill.

**Why a column.** `domain_profiles` has no settings blob to extend — `seniority`, `target_titles`
and the `selected_*` lists are each their own typed column. A JSON blob added for one boolean would
be the odd one out and the first place a later setting hid from a query.

### Does the default silently change existing users' resumes? YES — and the UI says so.

Every resume generated before this had a summary. With `DEFAULT 0` the next one an existing
candidate generates will not. Backfilling `1` for existing rows was considered and rejected: it
leaves two populations with different defaults and no way to tell them apart, and the product
decision is that the summary is opt-in for **everyone**.

So the OFF state's copy in the panel reads:

> Off. Generated resumes for this profile have no summary section — resumes generated before this
> setting existed did.

and turning it on says what changes and when:

> Summary section on for Backend Engineering. It will appear on resumes generated from now on.

---

## 2. Off means ABSENT (requirement 2)

Two mechanisms, and only the first is the enforcement:

1. **The prompt.** With the section off the model is never told to write one, so there is nothing
   in the output to remove.
2. **`renderStructuredResume` drops EMPTY sections** — of any kind. A section with no body renders
   as a heading and a rule line over blank space, which reads to a human as something the candidate
   forgot to fill in. This is not what enforces the toggle (see requirement 3); it was always the
   right thing to do with an empty section.

Layout: `renderStructuredResume` walks `SECTION_ORDER` and filters out what is not present. There
are no reserved slots, so the sections beneath simply reflow up in document flow.

**Verified in the PDF, not the HTML preview.** `docs/ai1-summary/{off,on}.pdf`, produced through
the same puppeteer settings as `server.js htmlToPdf()`, text-extracted with `pdf-parse`:

| | pages | first content line after the contact row | `SUMMARY` heading in the PDF text |
|---|---|---|---|
| `off.pdf` | 1 | `TECHNICAL SKILLS` | **no** |
| `on.pdf`  | 1 | `SUMMARY` | yes |

Screenshots: `docs/ai1-summary/off.png`, `on.png`. The two pages are identical below the summary;
`off` reflows up by exactly the summary's height.

---

## 3. The rule comes out of the PROMPT (requirement 3)

Nothing generates a summary and strips it. `services/promptAssembler.js` gained
`applyPromptConditionals`, and the prompt files carry `<!--IF:SUMMARY-->` / `<!--IFNOT:SUMMARY-->`
spans. The flag is resolved against the cached file text and never written back, so one user's
setting cannot leak into another's request.

Markers rather than a second prompt file because the SUMMARY rules are **not one contiguous block**
— the output contract lists the section, STRUCTURE normalises its label and fixes its position, and
the final silent check names its length. A parallel copy of layer 1 would be four places to keep in
step and one to forget.

With `SUMMARY: false`, all of the following are **absent** from the assembled system blocks
(asserted, not assumed — `test/summaryOptIn.test.js` and `scripts/ai1SummaryVerify.mjs` both check
the text that is actually sent):

- `## SUMMARY` and its rules, including `430-480 rendered characters`
- `Summary / Professional Summary / Profile / About -> SUMMARY` (the label-normalisation line, which
  would reintroduce the section under another name)
- `Order: SUMMARY -> ...`
- `summary length` in the FINAL SILENT CHECK
- `### E. SUMMARY FRAMING GUIDANCE` in **all 13** layer-2 domain modules

and `## NO SUMMARY SECTION` is present instead — silence is not an instruction. It also closes the
two obvious ways to comply with the letter and not the rule: an unlabelled opening paragraph
("a summary without its heading is still a summary") and relocating the figure into the tagline.

An unknown flag name resolves **OFF**, and only `=== true` counts, so a typo cannot silently keep a
rule alive.

Prompt caching is unaffected: SUMMARY has two values, so there are two stable variants of each
block instead of one, each byte-identical call to call, each still carrying `cache_control`.

---

## 4. ⛔ AF2's assertion survives (requirement 4)

There are two checks in `services/resumeClaimGuard.js` and they were affected differently.

**The inflation check (`years_exceed_profile`) — AF2's actual subject — was already document-wide.**
The summary was only where the figure usually sat, never the limit of what was inspected. It is
unaffected by the summary's absence and still fires: a no-summary document claiming 9 years against
a 4-year profile is refused.

**The under-claim check (`years_below_profile`, AG3) WAS summary-scoped, and would have gone
silent.** `extractSummaryText` returns `""` on a document with no summary, so the check would have
inspected nothing and reported no violation — indistinguishable from an honest resume. That is the
regression the requirement names. Fixed by generalising to a **headline region**:

```
extractHeadlineRegion(html) -> { text, region: "summary" | "header" | "none" }
```

- a summary when there is one (unchanged behaviour),
- the header block when there is not — because with no summary, a tagline reading
  `Software Engineer | 8 Years Experience` is the same claim in a different place,
- `"none"` when the document has no named section heading at all, rather than falling back to the
  whole document — that fallback would read `3 years of Python` in a skills line as a claim to three
  years of career and refuse an honest resume.

The header block ends at the first **named** heading (`KNOWN_HEADING`), not at the looser
"short, shouted and wordless" shape test — the candidate's name is short, shouted and wordless, so
the loose test ended the header before its first line and returned an empty region on every real
resume. (Caught by the tests, not by inspection.)

### It asserts it INSPECTED something, not merely that it found no violation

`checked.inspected` now reports:

```js
{ documentChars, headlineRegion, headlineChars, seniorityCeilingKnown }
```

and `assertResumeClaims` **throws `ResumeClaimNotInspectedError`** when `documentChars` is 0. A pass
with nothing read is no longer possible. `coreGenerateResume` captures the result and logs the
inspection record beside the verdict.

Measured on both real renders:

| run | documentChars | headlineRegion | headlineChars | ceiling known |
|---|---|---|---|---|
| summary OFF | 2443 | `header` | 137 | yes |
| summary ON  | 3008 | `summary` | 556 | yes |

---

## 5. Where the toggle sits (requirement 5)

`client/src/panels/JobProfilesPanel.jsx`, inside each profile card's **Base Resume** block — the
per-profile resume settings — not a general settings page. Verified in a real browser: the label is
2 DOM hops from the Base Resume block. Copy is `Include a summary section`; it states the effect and
does not argue for the section.

Optimistic with reconciliation: the checkbox moves immediately, and on a failed `PUT` the previous
value is restored and the reason shown.

Screenshots: `docs/ai1-summary/ui-1-toggle.png` (both states side by side),
`ui-2-toggled-on.png` (after the write).

---

## 6. Every generation path (requirement 6)

| Path | Verdict |
|---|---|
| `coreGenerateResume` | **Honours it.** Reads `activeDomainProfile.include_summary === 1`, passes `{ SUMMARY }` to `assemblePrompt`. |
| **A+** (`CUSTOM_SAMPLER` / `A_PLUS`) | **Honours it.** Both tools route through `coreGenerateResume`; the layer-3 A+ overlay contains no summary rules, so the layer-1/layer-2 conditionals are the whole story for both modes. Asserted across both modes × 13 domains. |
| `/api/standalone/generate` | **Honours it.** No account, so no profile to hold the preference — the request carries `include_summary`, with the **same default (off)**. Read strictly (`=== true`), so a malformed request lands on the documented default. |
| `enhanceProfileResume` | **Not applicable, and unchanged.** This is the *base resume* enhancement, not artifact generation: it rewrites the candidate's own resume **text**, uses its own `ENHANCE_SYSTEM` prompt with no section rules, and adds or removes no sections. If the base resume has a summary the enhanced base resume keeps it. The toggle governs the generated artifact, which is what reaches an employer. |
| `buildArtifact` | **No such symbol in this codebase.** The artifact is assembled by `normalizeResumeHtml` → `buildStructuredResume` → `renderStructuredResume` in `services/resumeFormatter.js`, all covered above. |

---

## Regression verdicts

| Surface | Verdict |
|---|---|
| `coreGenerateResume` | Changed — reads the preference, passes it to the prompt, logs the guard's inspection record. |
| `enhanceProfileResume` | Untouched. Operates on base-resume text; no section rules. |
| `/api/standalone/generate` | Changed — accepts `include_summary`, same default. |
| `normalizeResumeHtml` / `renderStructuredResume` | Changed — empty sections of any type are dropped. A summary **with** text still renders. |
| PDF renderer (`htmlToPdf`) | Untouched. Takes the same HTML; verified on both variants. |
| HTML renderer | Covered above. |
| **ATS scorer** (`services/localAtsScorer.js`) | **Untouched, and there is no structural penalty.** It never looks for a summary section — the only `summary` tokens in the file are a field name on the years-fit report. Identical terms score identically wherever in the document they sit (asserted). **But note:** on the real fixture, dropping the summary cost 12 points (100 → 88) because `distributed systems` appeared *only* in the summary. That is the missing **term**, not the missing section — and it is why the no-summary prompt block requires every claimable Tier 1 term to appear in TECHNICAL SKILLS or a bullet. That rule was already layer 1's; it is now restated where the summary is absent. |
| `services/resumeClaimGuard.js` | Changed — headline region, `checked.inspected`, `ResumeClaimNotInspectedError`. `checked.summaryYears` kept under its original name and meaning. |
| `routes/domainProfiles.js` | Changed — GET returns a boolean, PUT accepts and coerces. |
| Tests asserting a summary is present | `test/resumeClaimGuard.test.js` (24 summary references) — **all still pass unchanged**; every document they use has a summary, so the headline region is the summary and behaviour is identical. `test/resumeArtifacts.test.js` "prompt assembler caches stable mode overlays" updated for the `layer3Text` → `layer3Resolved` rename, with its intent strengthened: it now asserts the block that is *cached* is the block that is *sent*. |
| `scripts/af2ClaimVerify.mjs`, `ag2ClaimsGeneration.mjs`, `ag3ClaimSample.mjs` | **Would have broken silently.** All three assert on the summary and called `assemblePrompt` without flags, which now defaults OFF — their summary assertions would have failed for the wrong reason. All three now pass `{ SUMMARY: true }` explicitly. |

---

## Verification

- `npm test` — **1885 pass, 0 fail** (baseline re-derived at 1858; 27 new, **0 introduced**).
- `npm run verify:harness` — **30/30 green, 767 assertions.**
- `node scripts/ai1SummaryVerify.mjs --render-only` — **29/29.** Prompt, renderer, PDF and guard.
- UI in a real Chrome against the real panel — **12/12.**

### The `--from-file` run (2026-08-25)

The Anthropic key has no credit (`400 invalid_request_error: Your credit balance is too low`), so
the two blind Sonnet calls still have not been made. `scripts/ai1SummaryVerify.mjs` gained a
`--from-file` mode so the documents can be produced on a subscription instead of a billed key and
then run through the **identical** pipeline — same `normalizeResumeHtml`, same claim guard, same PDF
renderer, same section assertions. Only the HTML's origin changes.

Both documents were written against the real assembled prompts (dumped verbatim from
`assemblePrompt`, 19,372 chars OFF / 19,863 ON) and verified: **31 passed, 0 failed.**

| | OFF | ON |
|---|---|---|
| sections | `TECHNICAL SKILLS → EXPERIENCE → ACADEMIC PROJECTS → PROJECTS → EDUCATION` | `SUMMARY → …` (same five after it) |
| guard inspected | 4404 chars, region `header` (160 chars) | 4874 chars, region `summary` (461 chars) |
| PDF first line after contact | `TECHNICAL SKILLS` | `SUMMARY` |
| `SUMMARY` heading in the PDF | **no** | yes |
| any "8 years" claim | no | no |
| years stated | none (correct — with no summary, no section is required to state a total) | `4 years` |
| claims "Senior" | no | no |

The AF2 inflation check **ran and passed in both** — unlike `--render-only`, these artifacts were
produced against the JD demanding 8 years, so the question was live. The summary is 461 rendered
characters, inside the prompt's 430–480 rule.

### What is STILL not verified

**Whether a model obeys the prompt when it does not know it is being tested.** The `--from-file`
documents were written by a model against the real prompt, so everything above is a real result on
real model output — but the author knew what was under test, and an author who knows will comply.
"The summary is absent" is then evidence about the author, not about the prompt. The failure mode
this check exists to catch is a prompt *ambiguous enough that an uncontexted model still writes a
summary*, and that remains untested.

The harness says so itself rather than reporting a full pass:

```
PARTLY verified: ... this run cannot know whether their author was blind to what
        is being tested. An author who knew would comply ...
        For evidence about MODEL OBEDIENCE, re-run with no flag: two blind Sonnet calls.
```

Cost of the real thing, measured rather than estimated: ~5k input + ~2.5k output tokens per call,
two calls, at Sonnet 5's $2/$10 per MTok — **about $0.07**. `usage_events` records $0.00 against
`ai1_summary_verify` across nine attempts; every one 400'd before any tokens were spent.

### Pre-existing defect found here, FIXED in a follow-up

Skills separators rendered as the literal text `&middot;` in both the HTML and the PDF.

Originally recorded as a bad stored artifact. The `--from-file` run settled it: the input was
written fresh with ordinary `&middot;` entities and the renderer still emitted `&amp;middot;`. The
cause was `decodeHtmlEntities` knowing only nine entity names — anything else survived the parse as
literal text, and `escapeHtml` on the render side then escaped its `&`. Since layer 1 tells the
model to separate skills with a middle dot, **every generated resume carried a row of them into the
document an employer opens.**

Fixed by decoding the whole class rather than the one name: all Latin-1 named entities, common
punctuation and symbol names, HTML5's ASCII names (`&percnt;`, `&num;`), and any numeric reference
in decimal or hex. House normalisations (em dash → hyphen, curly → straight quotes) now apply to
whatever the decoder produces, so `&#8212;` and `&mdash;` can no longer disagree. Unrecognised
entities are left verbatim rather than turned into a replacement character, and the render side
still escapes everything, so decoding is not an injection route.

Side effect worth noting: the sample resume dropped from **two pages to one**. `&middot;` is eight
characters where `·` is one, and the inflated skills rows had been pushing content over the break.
