# Handoff — start here

**Everything below was measured on 2026-09-24, not carried forward from another document.** Every
figure in the docs this replaces had been wrong at least once. If a number here disagrees with
something you read elsewhere in `docs/`, re-measure before you believe either.

## State, right now

| | |
|---|---|
| deployed commit | **read it from `/api/version`** — any value written here is stale by the next push, which is why the doc guard deliberately does not assert one |
| contract | `1.1.1` (source and production agree) |
| migration high-water | `109_restore_stripped_seniority_titles`, in **both** runners and production |
| test baseline | **2655 tests, 2655 pass, 0 fail** — no deliberate failures since P4; see `CLAUDE.md` |
| monetisation | **disabled** — the product presents as free and untiered |
| Anthropic balance | **exhausted.** Model-backed paths return 502 — except capture, which degrades (see below) |

## What this is

A job-application system for one candidate at a time. It crawls applicant-tracking systems
directly (Greenhouse, Lever, Ashby and others), reconciles postings into a single board, enriches
them with a model, scores them against a stored profile, and then either fills an application form
automatically or hands the filled form to the candidate in their own browser to review and submit.
A published Chrome extension captures a posting from any job page and fills applications behind
login gates the server cannot cross. The candidate reviews and submits; **the system never submits
on their behalf without a gate.**

## ⛔ What works, and what only exists

**Working** — verified this session:

- **Ingestion.** Production scraped at `2026-09-24 08:00`. 2776 rows, 2662 active.
- **The board and its ranking.** Post-CC1 it ranks by a three-valued sieve, recency as tiebreak.
- **Weighted ATS scoring.** Production: `state: fresh`, `weightedScoring: true`, 493 terms.
- **Auth and identity.** Three credentials, deliberately separate. Re-verified in a real browser.
- **Migrations.** 116 applied, **0 defined-but-unapplied**.

**Built but never completed** — this is the section that matters:

- ⛔ **The apply pipeline has never submitted an application. Not one.** 9 attempts in production:
  7 `held_review`, 1 `held_gate`, 1 `failed`. **Zero** rows carry any submit evidence. Earlier docs
  say "one real application" — that is wrong. The 5 `job_applications` rows are unrelated: four are
  `CUSTOM_SAMPLER` logged from LinkedIn in April, one is `MANUAL`.
- **Enrichment is dead** and has been since 2026-09-17, on the exhausted balance. 1559 production
  rows have never been enriched. `skills_json` sits at **41.0% production / 35.8% local**.
- **Capture still works, degraded.** Since 2026-09-25 `/api/import/job` files the posting without
  a model when the balance is out — title, company, location and description, from the block the
  extension already sends. Salary and skills stay NULL and enrichment completes the row once
  funded. The extension says "Saved (partial)". `ARCHITECTURE.md` §10.
- **`workday` and `smartrecruiters` produce zero rows** in both databases, while appearing in the
  boot log as active. *Owner confirmed 2026-09-24: not wired properly — a defect, not dormancy.*
- **`scraped_jobs.ats_score` is NULL on every row**, both databases. *Owner confirmed 2026-09-24:
  by design — CC5 made scoring per (user, profile, job), so the global column is vestigial.*
- **`usage_events` never carries `ats_score_before/after`** — 0 of 1971 production rows, though
  AK1 built the callback. *Intent could not be established; recorded as unresolved.*
- **The recruiter surface, and features behind the monetisation lever.** See `ARCHITECTURE.md` §9.

## How to check state yourself

- **Deployed:** `GET https://jobsviadraft.com/api/version` and **read a JSON key.**
  ⛔ **A 200 is not evidence.** The SPA catch-all answers 200 with `index.html` for any unknown
  path. That has produced a false finding four times, most recently `/api/admin/stats` "returning
  200" for a route that does not exist. Judge by **response body and content-type**, always.
- **Local:** `npm test`. Expect 2655 / 2655 / 0. ⛔ A red is now a REAL failure — the two deliberate
  ones cleared at P4 on 2026-09-26. Check `CLAUDE.md` before assuming otherwise.
- **Real behaviour:** `npm run verify:harness` (needs the app on `:3001`). A green node suite is
  **not** evidence about anything a browser does — see the note in `package.json`.

## The six defect shapes

Every significant bug here has been one of six, all silent, none threw. One line each; the full
account with examples is in `docs/FINDINGS_ARCHIVE.md`.

1. **Two sides of a contract that don't meet** — `tool` sent, `toolType` read.
2. **A handler wired to nothing** — search by identifier, never by call-site shape.
3. **Silence reported as success** — "sync complete — 0 jobs cached", for months.
4. **NULL-hostile predicates over optional data** — took the board to zero three separate times.
5. **A test that pins a defect** — the bug written down as a guarantee.
6. **A claim with no code** — docs describing behaviour that does not exist.

A seventh, newer: **a guard blind to what it guards.** A guard never seen to fail is not evidence —
verify it by injecting a violation.

## What needs the owner, not an agent

- **Funding the Anthropic balance.** Enrichment, résumé generation and cover letters do nothing
  until then, and no agent can do it. Capture degrades rather than waiting.
- **The Chrome Web Store.** ⛔ **Uploading v1.1.0 is the owner's, and it is the only thing P4 did
  not finish.** P4 (2026-09-26) rebuilt the package for the new origin and brand, regenerated the
  three listing screenshots and rewrote the listing copy — all of it sitting in
  `extension/submission/`. The dashboard steps are manual: replace the package in place if the
  pending v1.0.0 item allows it, re-paste the **storage** and **host permission** justifications
  (both changed materially), and confirm the reviewer's test account signs in on the new domain.
  A rename plus a host-permission change triggers an in-depth review; expect a longer queue.
- **DNS, Railway env, and the OAuth consoles** — see `docs/DOMAIN_MIGRATION.md` Phase 0.
- **Two mailboxes** that may not exist yet: `privacy@` and `noreply@` on the new domain.
- **Whether the apply pipeline should ever auto-submit.** It never has; that is a product decision.

## Where to look next

| | |
|---|---|
| `ARCHITECTURE.md` | how the system actually works, written from the code |
| `docs/FINDINGS_ARCHIVE.md` | the six defect shapes, and findings worth not rediscovering |
| `docs/CORRECTIONS_REGISTER.md` | **how the docs went wrong** — method, not backlog. Read before trusting any figure |
| `docs/EXTENSION_DIAGNOSIS.md` | the extension's four defects and what was fixed |
| `docs/DOMAIN_MIGRATION.md` | the rebrand, and what only the owner can do |
| `CLAUDE.md` | repo rules, the deliberate test failures, and the line-ending trap |

**The mobile repos are out of scope here** and keep their own docs (`ANDROID.md`, `IOS.md`). This
document should be good enough to shape that work from; it does not describe it.
