# Audit and Re-plan — 2026-09-25

The product model changed after the migration was planned and after the documentation was rewritten.
This task reconciles what exists against what is now intended, and corrects the docs that are now
wrong.

⛔ **Run this before any build work.** Four documents now contain instructions that contradict the
current plan, and one of them (`MIGRATION_AND_REBRAND.md`) tells you to retire a domain that is now
a product.

---

## What changed

| Decision | Recorded | Consequence |
|---|---|---|
| **draft** (lowercase wordmark) | `BRAND.md` says Draft | Casing needs correcting |
| **Two unlinked products** | `PRODUCT_MODEL.md` | `resumemaster.one` is **never retired** |
| Resume Master is a **stateless processor** | `PRODUCT_MODEL.md` | Real API boundary, personal data crossing it |
| Audience is **students and new grads** | `PRODUCT_MODEL.md` | Seniority guard inverted, corpus historical |
| Validation is **per-user, behavioural** | `PRODUCT_MODEL.md` | ρ-against-corpus retired as primary measure |
| **Outcome tracking**, possibly Gmail | this session | New privacy surface, not yet designed |

---

## PHASE 1 — Audit. Measure, do not assume.

```
⛔ CARRY NO FIGURE FORWARD FROM ANY DOC. NEXT_WORK.md has been stale EIGHT times and
CORRECTIONS_REGISTER.md lists every number that has already been wrong. Read it as a warning about
method, not as fact.

1 · DEPLOYED AND LOCAL TRUTH
   GET https://jobsviadraft.com/api/version — commit, contract, migration high-water,
   monetisationEnabled. ⛔ ASSERT A JSON KEY, never a 200: the SPA catch-all has produced a false
   finding FIVE times, most recently /api/admin/stats "returning 200" for a route that does not
   exist.
   npm test — exact counts. ✅ The TWO DELIBERATE submission-zip failures CLEARED at P4 on
   2026-09-26 — the baseline is green, and ⛔ a red is a real failure again. See
   CLAUDE.md, which tracks the deliberate-failure count and currently says zero.
   git log and git status across all three repos, and what is unpushed.

2 · ⛔ THE STUDENT QUESTION — the single most important measurement here
   The audience pivot assumes the board can serve students. MEASURE IT BEFORE ANYTHING IS DESIGNED
   AROUND IT.
   · How many active postings are intern, new-grad, entry-level or early-career? By title pattern
     AND by experience_level.
   · Per source. Ingestion is tuned to engineering roles from greenhouse and ashby.
   · What fraction of the board would survive a student-shaped profile today?
   ⛔ IF THE ANSWER IS SMALL, THE SCORING REINVENTION IS PREMATURE AND INGESTION IS THE THING TO
   CHANGE FIRST. Say so plainly. This is a query, not a project — do it first and report it first.

3 · OUTCOME DATA
   job_applications row count and how many carry ats_score_at_apply / response_outcome.
   usage_events rows with ats_score_before / after.
   ⛔ Last known: ZERO of everything. The recording path has never been exercised — the only
   resume_generate events since AK1 landed all carried job_id = null. Report whether recordAtsOutcome
   can fire at all, or only that it has produced nothing.

4 · THE SCORING STACK, as it now stands after CC1–CC5
   · the three systems and their current agreement
   · the seniority guard — confirm it demotes intern/new-grad postings, and by how much
   · ats_term_weights computed_at against MAX_WEIGHT_AGE_DAYS = 45. ⛔ Goes stale ~2026-10-13, after
     which scoring SILENTLY reverts to unweighted with a console.warn. That is days away.
   · the résumé-side extractor: the hardcoded 32-item SKILL_HINTS list, and how many of the 32
     appear nowhere on the board as an exact value

5 · ENRICHMENT AND THE BALANCE
   Outstanding candidates, per-column coverage, and confirm the Anthropic balance is still
   deliberately unfunded. Capture now degrades rather than failing (e602a5f) — confirm that holds
   in production, which has not been exercised with a real posting.

6 · RAILWAY DOMAIN SLOTS — an open question blocking the split
   Are custom domains per-service or per-account? Two are in use. A separate Resume Master service
   needs its own. Answer from the dashboard or the docs, not from inference.
```

## PHASE 2 — Correct the documents

```
⛔ REWRITE, do not append. Four documents now contain instructions that would cause damage if
followed.

1 · MIGRATION_AND_REBRAND.md — ⛔ MOST URGENT
   It instructs: retire resumemaster.one, remove the old OAuth redirect URIs, consider the 301,
   free the slot for www. ALL FOUR ARE NOW WRONG. resumemaster.one is a product. The 301 must NEVER
   happen. Rewrite P4 and the owner checklist accordingly, and mark the retirement steps struck
   with the reason.

2 · BRAND.md
   Lowercase wordmark: "draft", not "Draft". State the casing rule explicitly — wordmark lowercase,
   sentence-start usage, and what the Web Store title is.
   ⛔ Add the Resume Master carve-out: the rebrand guard forbids `resumemaster` literals, and a
   product legitimately named that needs an ALLOWLIST ENTRY WITH A STATED REASON. Note the allowlist
   self-prunes, so the entry must be genuine.

3 · NEXT_WORK.md
   Re-derive against Phase 1. Its open list predates the product model.

4 · ANDROID.md / IOS.md
   Phase 2c/2d specify a swipe feed and review queue against the BOARD model. The daily draft is a
   different information architecture. ⛔ Mark both as needing revision before they are built; do
   not rewrite them here.

5 · docs/am1-ats-graded-corpus.json
   ⛔ KEEP — irreplaceable, the original postings were destroyed in the id-85 deletion. Add a header
   marking it HISTORICAL: 30 senior engineering postings graded by an experienced engineer. It no
   longer validates the product and must not be used to justify cutpoints for a student audience.
```

## PHASE 3 — Draft the two new documents

```
A · docs/OUTCOME_TRACKING.md — design, not implementation

  WHY IT MATTERS MORE NOW: validation moved from ρ-against-a-corpus to per-user behaviour, and the
  only signal a user cannot flatter is whether an employer replied. job_applications has never held
  a row, so this IS the validation story.

  Three options, in ascending cost. ⛔ Design all three; recommend the order.

  1. MANUAL CAPTURE — one tap on the application row. replied / rejected / interview / no response.
     shared/applicationResponse.js already encodes the rules: a REJECTION COUNTS AS A RESPONSE (an
     ATS score is a screening score; it has no business predicting hiring outcomes), and
     MATURITY_DAYS = 30 means NULL is not "no response" yet. Reuse both.
     Weakness: people stop logging. With 30 applications it may be enough to start.

  2. A FORWARDING ALIAS — Cloudflare Email Routing is already live on jobsviadraft.com. A per-user
     alias the candidate routes job mail to. ⭐ You only ever see mail they DELIBERATELY route to
     you. No restricted scope, no assessment, unambiguous consent.

  3. GMAIL READ — ⛔ A DIFFERENT KIND OF DATA ENTIRELY. Everything held today is data the user gave
     about themselves; an inbox contains correspondence with people who consented to nothing.
     Google classes Gmail read scopes as RESTRICTED: an annual third-party security assessment
     costing real money, and verification measured in weeks. Design it, cost it, do not start it.

  Cover for whichever is built: what is stored vs parsed-and-discarded · how an outcome is matched
  to an application (employer domain? subject? thread?) and the false-positive rate · both privacy
  policies · the Web Store data-use declaration and the four-column reconciliation join.

B · docs/SCORING_FOR_STUDENTS.md — design, not implementation
  ⛔ BLOCKED ON PHASE 1 ITEM 2. If the board cannot serve students, this is premature and ingestion
  comes first. State that dependency at the top.

  · THE SENIORITY GUARD IS BACKWARDS. It demotes intern and new-grad postings, and exists because a
    Figma intern role scored 60 against the owner's profile and was graded 2 — removing that
    inversion moved ρ 0.643 → 0.732. For students those postings ARE the product. Invert, or make
    it profile-relative. ⛔ Do not simply delete it: a senior posting against a student profile
    still needs demoting, so the guard is needed in BOTH directions.
  · THE RÉSUMÉ-SIDE EXTRACTOR IS THE REAL GATE. A hardcoded 32-item SKILL_HINTS list, 8 of which
    appear nowhere on the board as an exact value. Student résumés carry coursework, projects,
    clubs, teaching assistantships — none of that vocabulary exists in it.
  · THE JD SIDE CHANGES TOO. Intern postings often state NO years requirement, which is exactly the
    case the ~26 floor and the guard were built around. Re-measure both.
  · A NEW REFERENCE SET. The method is reusable: draw a shuffled sample with scores withheld, grade
    blind, join. ⛔ The grader should be someone in the target audience, not the owner — that was a
    caveat on the original corpus too, and it is sharper now.
```

---

## What the owner should do, in order

| | Action | Why now |
|---|---|---|
| **1** | **Run Phase 1 item 2** — the student question | A query, not a project. ⛔ It determines whether the scoring reinvention or ingestion comes first, and everything downstream depends on the answer |
| **2** | **P4 — repackage and update the extension** | Last migration step. Clears the two red tests. Unblocked now the brand is decided |
| **3** | **Check Railway's domain-slot model** | Blocks planning the split |
| **4** | **Decide outcome tracking** | Manual first is my recommendation. It is cheap, needs no new consent surface, and AF5 is about to generate the first real applications |
| **5** | **AF5** | ⭐ 30 supervised applications. The only thing that fills `job_applications`, which is now the entire validation story |

**Not yet:** the Resume Master split, the draft UI, the scoring reinvention, remote browser
profiles. Each depends on something above.

⚠ **`ats_term_weights` go stale around 2026-10-13** — days away — after which scoring silently
reverts to unweighted. That deadline is independent of every decision here and needs a loud failure
plus a recompute schedule.
