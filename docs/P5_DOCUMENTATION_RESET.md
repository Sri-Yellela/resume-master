# P5 — Documentation reset (web app only)

Run **after** defect C (extension session identity) so the auth model documented is the real one.

**Scope: the `resume-master` repo — server, web client, extension.** The two mobile repos are out of
scope and keep their own docs (`ANDROID.md`, `IOS.md`). This document should be good enough that the
mobile work can be shaped from it.

---

## Why now

The P2/P3 sweep just walked every file in the repo. That file-level knowledge is fresh and will not
be this cheap again. **`HANDOFF.md` and `ARCHITECTURE.md` do not exist** — P5 was specified and never
run. There is no system diagram anywhere.

⛔ **Document what IS, not what will be.** The product is mid-pivot toward a two-sided daily-draft
model with separate candidate / recruiter / ATS-partner surfaces. **None of that is built.** Writing
it into an architecture doc produces the exact defect this project keeps paying for: a document
describing behaviour that does not exist. The pivot gets its own design doc, separately.

---

## ⭐ Checkpoint protocol — verify mid-pass, not at the end

⛔ **Read this before Phase 1.** It changes how this task runs.

The usual pattern here is: measure everything, write the whole document, report, the owner corrects
it, revise. Each round trip is expensive, and corrections arrive *after* the reasoning has been
built on the wrong premise. Three briefs in a row have had their central premise inverted by the
first measurement taken — `discovered_at` vs `scraped_at` is the clearest case, where a wrong age
gate would have refused 809 live postings and looked like it was working.

**Stop at the declared checkpoints below. Ask ONE specific question. Record the answer in the
artifact. Continue.**

### Rules

1. **Only the declared checkpoints.** Do not improvise extra ones, and do not skip one because the
   answer seems obvious — "seems obvious" is what produced the wrong premises.
2. **One question, answerable in one line.** Not "does this look right?" but *"I measured X, the doc
   claims Y — which is authoritative?"* If a question needs a paragraph back, it is a design
   decision, not a verification: note it as an open question and carry on.
3. **Write the answer into the artifact with attribution** — `owner confirmed 2026-09-24` — so the
   next session does not re-ask. This is the part that compounds.
4. **Batch within a checkpoint.** If three things need confirming at the same stop, ask all three at
   once. The cost is the interruption, not the number of questions.
5. **Do not block on a checkpoint indefinitely.** If there is work that does not depend on the
   answer, keep going and come back.

### The checkpoints

| # | When | Ask about |
|---|---|---|
| **CP1** | After Phase 1's measurements, **before any prose is written** | Every figure that CONTRADICTS what a doc claims. This is the highest-value stop — prose written on a wrong number has to be rewritten, and a measured contradiction is exactly the shape that has been wrong eight times |
| **CP2** | After the working / dormant / broken classification | Any subsystem you cannot classify from evidence. ⛔ Do NOT guess — "built but dormant" and "broken" look identical from the code and the difference is the whole point of that section |
| **CP3** | Before writing ARCHITECTURE.md §3 (curation and scoring) | Whether the post-CC1–CC5 behaviour matches what those reports claim. Three systems, ρ measured four ways, and the board still ordered by `discovered_at DESC`. If measurement disagrees with the reports, the measurement wins — confirm which is being documented |
| **CP4** | Before writing §9 (built and not reachable) | Each item you believe is unreachable. Some are deliberate (the recruiter surface has no front door on purpose), some are defects. Only the owner knows which |
| **CP5** | After the doc classification, **before deleting anything** | The full KEEP / FOLD / DROP list. ⛔ Already required below; this makes it a hard stop |
| **CP6** | Before committing | Anything in the four documents you could not verify. ⛔ An unverifiable claim in a handoff doc is how this started |

---

## Phase 1 — Measure. Derive everything.

```
⛔ CARRY NO FIGURE FORWARD FROM ANY DOC, including the ones you are replacing. Every number in the
existing docs has been wrong at least once, and NEXT_WORK.md has been stale EIGHT times — most
recently about its own headline. docs/CORRECTIONS_REGISTER.md is the list of what has already been
wrong; read it as a warning about method, not as fact.

1 · DEPLOYED TRUTH
   GET https://jobsviadraft.com/api/version → commit, contract, migration high-water,
   monetisationEnabled. Then git log for anything on main that is NOT in that commit.
   ⛔ ASSERT A SPECIFIC JSON KEY. A 200 is not evidence — the SPA catch-all answers 200 with
   index.html for any unknown path. It has produced a false finding FOUR times, most recently when
   /api/admin/stats "returned 200" for a route that does not exist.

2 · LOCAL TRUTH
   npm test → exact pass/fail. Migration high-water in BOTH scripts/migrations.js and the server.js
   MIGRATIONS array, and whether they match each other and production. Contract version.
   git status.

3 · DATA TRUTH — re-measure, do not quote:
   · scraped_jobs total / active / per source
   · skills_json coverage. The docs carried 37% for weeks; the curation audit measured 99.8%
     locally and could not read production. Measure BOTH and say which is which.
   · ats_score and ats_report non-NULL counts
   · enrichment candidates outstanding, per-column coverage
   · job_role_map rows and user_jobs rows. ⛔ If job_role_map is still tiny against the board, SAY
     SO LOUDLY: the board join means local UI verification is measuring fixtures.
   · ats_term_weights computed_at against MAX_WEIGHT_AGE_DAYS = 45. Goes stale ~2026-10-13, after
     which scoring SILENTLY reverts to unweighted with a console.warn.
   · job_applications rows, and usage_events rows carrying ats_score_before/after
   · Anthropic credit state — every model-backed feature is currently 502ing on an exhausted balance

4 · WHAT ACTUALLY WORKS. For each subsystem: working / built-but-dormant / broken, with evidence.
   Known as of the last audit, and every one needs re-checking:
   · the apply pipeline has completed ONE real application
   · job_applications is empty, so nothing connects any scoring work to an employer reply
   · the board does not rank by fit — it ranks by discovered_at DESC
   · three scoring systems decide one question and agree at ρ 0.38 at best
   · the extension is PUBLISHED (unlisted, v1.0.0) and has four open defects
   · enrichment has been dead since 09-17 on an exhausted balance
```

## Phase 2 — Write four documents

```
⛔ REWRITE, do not append. No "this was wrong, see below" blocks. The history is in git and in
CORRECTIONS_REGISTER.md.

A · README.md — what this is, how to run it, where to look. Short.

B · HANDOFF.md — the orientation doc. UNDER TWO SCREENS.
    Someone with zero context must be able to start from it.
    · deployed commit, contract, migration high-water, test baseline, monetisation state
    · what the product IS, in a paragraph
    · ⛔ WHAT WORKS vs WHAT IS BUILT BUT DORMANT. Blunt. This is the section that matters.
    · how to verify state: /api/version for deployed, npm test for the baseline, and the rule that
      a 200 from any route is not evidence
    · the six defect shapes, one line each, pointing at FINDINGS_ARCHIVE.md
    · what needs the OWNER rather than an agent
    · pointers to the other docs and to the mobile repos' own docs
    It is an orientation doc, not an index and not an architecture doc.

C · ARCHITECTURE.md — ⛔ THE MAIN DELIVERABLE. Written FROM THE CODE, during the sweep's afterglow.
    Every figure carries how it was measured. The curation audit is the model: it measured, and
    overturned beliefs that had survived months — skills_json 99.8% not 37%, G1 with no effect path
    at all, profileTitleSql excluding 5 of the owner's 12 best matches.

D · CORRECTIONS_REGISTER.md — keep, and finish. Tick or correct its open checklist, then REMOVE the
    checklist section. ⛔ RECOMMEND KEEPING THE FILE and say why in it: it is not a backlog, it is
    the record of HOW the docs went wrong, and that outlives every entry. "Current" has a half-life
    of about one session here.
```

## ARCHITECTURE.md — required sections

```
⛔ ONE DIAGRAM WOULD BE UNREADABLE. Layer them: one context diagram, then four component diagrams.
Use Mermaid so they live in git and diff. Each diagram carries a one-paragraph explanation; a
diagram nobody can read without the author present is decoration.

0 · CONTEXT DIAGRAM — the whole system on one page, boxes only:
    job sources → ingestion → the board → curation → apply → employer, plus the extension, the
    admin surfaces, and the external services (Anthropic, Resend, Cloudflare, Railway, the ATS
    APIs). No internals.

1 · INGESTION
    The seven ATS sources and which actually produce rows. reconcileFingerprint / computeReqUid and
    the canonical priority (direct ATS > provider > aggregator > import). automation_tier derivation.
    The freshness gate and the expiry brake.
    ⛔ INCLUDE THE DISCARD RATE. greenhouse drops ~28% of postings as unclassifiable, ashby 31%,
    lever 28%, workable 74%, recruitee 75%. That is a quarter to three-quarters of ingestion thrown
    away before the board sees it, and it is the largest unexamined number in the system.

2 · ENRICHMENT
    enrichJob, the candidate selector, content_hash, the COALESCE and don't-stamp-on-empty rules.
    Batch provenance and revert. The export/import round trip. Which columns come from ingestion
    (summary, normalized_title, experience_level — already 100%) versus enrichment (skills_json —
    the only real gain).
    ⛔ NOTE: ~19-25 values are CORRECTED IN PLACE per 10 rows, mostly summary and normalized_title,
    invisible in columnsClimbed. Nobody has judged whether the rewrites are improvements.

3 · CURATION AND SCORING — ⛔ THE MOST IMPORTANT SECTION, and the least understood
    THREE systems decide one question:
      A  profileTitleSql + the job_role_map join — board membership (now ranking, post-CC1)
      B  the profile→board bridge — a 3-valued sieve, top band hundreds deep, tie-broken by recency
      C  scoreAtsLocally — the band on the card
    Document their inputs, their disagreement (ρ measured four ways), and what CC1–CC5 changed.
    State plainly: the board does NOT rank by fit. Bands, cutpoints, the seniority guard, the
    graded corpus, and what ρ = 0.746 does and does not support.

4 · APPLY PIPELINE
    The state machine: queued → running → held_review / held_gate → submitted / failed. The four
    pre-submit gates and which run in which mode. ⛔ semi runs NEITHER the completeness nor the
    low-confidence gate — the human is the only check. The three caps. The kill switch. The
    deterministic resolver and the provenance tiers.
    ⛔ THE INTEGRITY RULES ARE ARCHITECTURE, NOT POLICY: no model call in the answer path ·
    flag-don't-fabricate · eligibility fields resolve exactly or not at all · the KB learns only
    from company-emitted data · companies and roles only, never individuals.

5 · THE GATED HANDOFF AND THE EXTENSION
    Why it exists: the user's own browser holds the authenticated portal session; the extension
    borrows it for one gesture under activeTab. Packet, token, single-use, expiry.
    ⛔ Document the auth model AS FIXED BY DEFECT C, not as it was.
    Note it has no mobile analogue — this is the constraint that shapes both mobile apps.

6 · DATA MODEL
    The tables that matter and how they relate. Not every column — the ones a newcomer needs:
    scraped_jobs, job_role_map, user_jobs, domain_profiles, profile_simple_apply_profiles,
    apply_runs / apply_run_jobs, job_applications, usage_events, enrichment_batches, the KB tables.
    The migration system: additive, dual-path, byte-identical in both runners, now transactional.

7 · AUTH AND IDENTITY
    Three credentials, deliberately separate, and why: connect.sid (browser, host-only, 7-day
    rolling) · the per-tab auth-context token · the sessionLess extension and mobile tokens, kept
    apart so revoking a phone does not kill the extension. Admin gating. What CC5 changed about
    per-(user, profile, job) scoping.

8 · COST AND MODEL CALLS
    callModel as the single path, all 14 sites, the provider split by DATA CLASS — ⛔ route by
    PAYLOAD, never by call-site name: `purpose classifier` sends 2000 chars of résumé and
    `classify_job` does not. usage_events, the guards, the caps. The A2 verdict: enrichment stays
    on Haiku, Groq measured 30.5% Jaccard.

9 · WHAT IS BUILT AND NOT REACHABLE
    ⛔ A SECTION THIS PROJECT SPECIFICALLY NEEDS. The recruiter surface with no front door. The
    synonym table's 196 unreviewed proposals. Dormant sources. Features behind the monetisation
    lever. Anything with code and no route in.

10 · KNOWN CONSTRAINTS AND DEADLINES
    ats_term_weights stale 2026-10-13 · the Anthropic balance · Railway's two-custom-domain limit
    blocking www · the extension's published v1.0.0 still pointing at resumemaster.one.
```

## Phase 3 — Prove it is current

```
1. Re-read all four as if you had no context. Report any claim you could not verify in Phase 1, and
   either measure it or delete it. ⛔ An unverifiable claim in a handoff doc is how this started.
2. ⛔ A DOC GUARD, if it is cheap: a test asserting the migration high-water and test count quoted
   in HANDOFF.md match reality, so the doc FAILS CI when it drifts rather than being discovered
   stale by a ninth session. This is the only item here that prevents recurrence rather than
   cleaning up after it. Report whether it is practical; build it if it is.
3. Cross-check: the four must not contradict each other, BRAND.md, MIGRATION_AND_REBRAND.md,
   CURATION_CONSOLIDATION.md or DETAIL_FETCH_ECONOMICS.md. Two planning docs disagreeing is what
   had one session rebuilding three finished tasks.
4. RETIRE DEAD DOCS — classify before deleting. ⛔ Some are load-bearing in ways their names do not
   show:
     KEEP  PRIVACY_RECONCILIATION.md  — enforced by privacyReconciliation.test.js
     KEEP  am1-ats-graded-corpus.json — the owner's 30 human grades. IRREPLACEABLE: the original
           postings were destroyed in the id-85 deletion
     KEEP  store-screenshots/         — listing assets
     KEEP  anything a test reads. GREP FOR IT; do not judge by filename.
     FOLD  session reports whose findings are already in FINDINGS_ARCHIVE.md
     DROP  superseded plans and resolved status files
   ⛔ Report the classification and get sign-off BEFORE deleting anything.
```

---

## Out of scope, recorded

**The mobile repos.** `ANDROID.md` and `IOS.md` govern them. This document should be good enough
that mobile work can be shaped from it — that is the point of writing it well, not a reason to
include them.

**The product-model pivot.** The two-sided daily draft, separate candidate / recruiter / ATS-partner
surfaces, and the UI that fits that model are **not built**. They belong in a `PRODUCT_MODEL.md`
written as a design. ⛔ Do not write them into ARCHITECTURE.md as though they exist.

Recorded so it is not lost: a full board implies exhaustiveness and invites judgement of the ranking
across thousands of rows, which ρ ≈ 0.75 cannot support. **A daily set of ten only requires that the
top ten are good** — the one thing coarse ordering can deliver. It also sidesteps the open "board
does not rank by fit" problem by changing what is promised, and it makes the name literal.
