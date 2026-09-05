# Next Work

**Last reconciled:** 2026-09-04, after AL1 (provider routing).
**Baseline:** 2090 passing, 0 failing. Migration high-water **096**. Contract **v1.1.0**.

> ⚠ **This file has been the stale thing twice in three sessions.** AK2 picked up five tasks and
> found three already done. AL1 picked up three and found two already done — B and C, both landed
> between this doc being written and being read. Agents land work faster than the doc can be
> reconciled. **Re-derive the baseline and check each task's status in the repo before starting.**
> That check has caught it every time.

**Blockers cleared:** API credit reloaded · Android Studio installed · Jobo deferred to launch
readiness.
**Blocker still live:** `GROQ_API_KEY` / `GOOGLE_API_KEY` are **not** in `.env` or the environment.

---

## Order

| # | Task | Repo | Needs | Status |
|---|---|---|---|---|
| **A** | Multi-provider routing + widened guard | desktop | keys | ✅ code done — **A2 below is what remains** |
| **B** | ATS bands | desktop | — | ✅ **DONE** — `docs/ak2-ats-bands.md`, ρ 0.643 → **0.746** |
| **C** | Android Phase 2a | android | — | ✅ **DONE** — `docs/aj2-android-phase2a.md` |
| **A2** | Provider quality verdict | desktop | **keys** | open — the real gate on A |
| **D** | Generation deferral | desktop | B ✅ | ✅ **DONE 2026-09-04** — `docs/al2-generation-deferral.md`, 19-check real run |
| **G** | Offline assets — G1 skills · G2 LCA · G3 technographics · G4 org units | desktop | A code | **G1·G2·G4 DONE 2026-09-04** — `docs/al3-skill-synonyms.md`, `docs/al4-lca-and-org-units.md`. G3 open (and near-pointless — see G1) |
| **F** | PII tokenization layer | desktop | A code | ✅ **DONE 2026-09-04** — `docs/al5-pii-tokenization.md`; real round trip verified |
| **E** | Cache breakpoints + Batch API | desktop | D | open — see the conditional |
| **H** | Form label → field mapping | desktop | G4 | open |
| **I** | Harness runner prerequisite doc | desktop | — | ✅ **DONE 2026-09-04** — fails fast in ~1s, exit 2 |
| — | iOS Phase 1 audit | ios | **a Mac** | open — `resume-master-ios/PHASE_1_AUDIT.md` |

**Run next:** D (unblocked, bands are set) and G1 (public data only, needs no key). F needs A's
code only. A2, E and H each have a real prerequisite below.

### ⛔ THE BOARD IS GONE — read before any corpus or rho work

`cleanup_log` id 85 deleted **1288 rows** from `scraped_jobs` on 2026-09-02T02:06. The table now
holds **5 fixtures**. Every derived table still describes the old board (8690 technographics, 856
term weights, 697 org units, 1302 enrich_job events), so every "1291 postings" figure in these docs
is true of the EVIDENCE and false of the TABLE.

**0 of the 30 graded postings survive**, so the ATS engine's only human-graded baseline cannot be
re-scored against the live database at all.

Recoverable, read-only, from `data/backups/resume_master_2026-08-31T06-00-00-534Z_auto-daily.db`
(1261 active, 1259 with skills_json, all 30 graded, profile 6 intact). Both AL3 scripts default to
it and refuse to run against a board under 200 postings.

⚠ **The 2026-09-02 snapshot is already post-deletion.** When retention rotates the 08-31 file out,
ρ = 0.746 becomes unreproducible. Pin that file out of the rotation, or export the 30 postings' text
to `docs/`. This is an owner action and nothing else in the queue does it.

---
### ⚠ Read this before picking up A, F or G

**`GROQ_API_KEY` and `GOOGLE_API_KEY` ARE NOT IN THIS WORKING COPY.** The line below that said
"Env now injected" was **wrong** — neither variable is in `.env` and neither is in the process
environment. Verified 2026-09-04.

Task A's routing is built, guarded and tested (`docs/al1-provider-routing.md`, +33 tests), but it
**has never served a real token**. Still outstanding, and all of it needs the key:

- 50 rows through Groq, per-column agreement vs Haiku — `scripts/al1ProviderQualityDiff.mjs`
- the open question: is an 8B model good enough for `skills_json`? It feeds
  `company_technographics` and the ATS scorer, and the saving at stake is only ~$3.32 a pass.

**F and G both list A as a prerequisite.** A's *code* satisfies that; A's *quality verdict* does
not exist yet. G in particular generates assets FROM the free tier, so its output quality inherits
the unanswered question above.

---

## TASK A — ✅ CODE DONE, DO NOT RE-RUN

Landed 2026-09-04. See `docs/al1-provider-routing.md`. Routing in `callModel()` only with a
fail-closed CANDIDATE default across all 14 sites, explicit `$0` pricing, migration **096** recording
provider, loud fallbacks, a pinned model that throws rather than falling back, and 429 backoff with
the row confirmed retryable. +33 tests.

**Two findings from it that must not be lost:**

1. **The guard was structurally blind to the shape it most needed to catch.** Its comment stripper
   used `/\/\/.*$/`, and `https://api.groq.com/...` contains `//` — so every URL-shaped provider
   call was erased as a "comment" before the scan ran. With no Groq or Gemini SDK installed, an
   untracked call would be a bare `fetch`: exactly the invisible case. **A guard extended by reading
   it would have shipped inert and green.** Third instance of this defect class, after
   `.messages.create(` missing `messages.batches.create` and three dead source anchors in passing
   tests. The rule that caught it: verify by INJECTING a violation per shape.
2. **`purpose classifier` is not `classify_job`.** One word apart, adjacent in every cost report —
   and `services/classifier.js` sends **2000 chars of the candidate's résumé**. This doc's original
   task-A split named `classify_job` as free-tier eligible; routing by that name would have leaked
   résumés on the first pass. The fail-closed CANDIDATE default is what makes a misclassified site
   fail safe instead of leaking. **Never route by call-site name; route by payload.**

The original task A prompt is retained below for reference only — **it is not work to be done.**

---

## TASK A2 — Provider quality verdict ⛔ NEEDS THE KEYS

```
This is requirement 8 and the VERIFY block of task A, which could not run: GROQ_API_KEY and
GOOGLE_API_KEY are in neither .env nor the environment. The routing has never served a real token.
Everything in A is verified against fetch stubs, so none of it is evidence about Groq's actual
extraction quality.

OWNER ACTION FIRST: set GROQ_API_KEY (and optionally GOOGLE_API_KEY), plus
ENRICH_PROVIDER=groq and a pinned ENRICH_MODEL=llama-3.1-8b-instant.

THEN
1. Run scripts/al1ProviderQualityDiff.mjs — 50 rows through both providers, per-column agreement.
   It REFUSES to run unconfigured rather than comparing Haiku to Haiku and reporting 100% agreement.
   That refusal is deliberate; do not work around it.
2. THE QUESTION: is an 8B model good enough for skills_json? It feeds company_technographics (8507
   rows) AND the ATS scorer. The saving at stake is ~$3.32 a pass.
   ⛔ IF AGREEMENT IS MATERIALLY WORSE, SAY SO AND KEEP ENRICHMENT ON HAIKU. Task A then stands as
   infrastructure for later rather than a live switch. Degrading the input to the ATS engine to save
   three dollars is a bad trade and reporting that honestly is the correct outcome.
3. Confirm usage_events records provider and $0 cost on real calls. The cost queries currently
   reconcile to $3.3284 over 1303 Haiku calls — they must still reconcile afterwards.
4. Confirm a real 429 leaves the row retryable (content_hash/enriched_at unset). Verified against a
   stub; not against Groq's actual rate limiter.

VERIFY: per-column agreement table, a stated verdict on the default, reconciled cost queries.
```

---

## TASK I — Harness runner prerequisite (small)

```
AL1 lost 30 minutes to a zero-output verify:harness run before discovering the suite needs the app
running separately on :3001. Nothing says so.

1. Document the prerequisite where the runner is invoked — scripts/verifyHarnesses.mjs and the npm
   script — and make the runner FAIL FAST with a clear message when :3001 is not answering, rather
   than producing 30 minutes of nothing. A silent zero-output run is Shape 3.
2. Note in the same place that no harness in that suite exercises the model-call path: the ones that
   do are excluded because they spend tokens. So a green verify:harness is NOT evidence about
   provider routing, and a future session should not read it as such.
```

---

## TASK A — original prompt (SUPERSEDED, reference only)

```
OBJECTIVE
Route the call sites that operate on PUBLIC data to a free-tier provider, keeping every call site
that touches candidate data on Anthropic. Wire it now so it can be tested on real traffic.

THE SPLIT — route by WHOSE DATA IT IS, not by what a filter finds in the string. This rule is
checkable by a test; "did the regex catch every email" is not.

  FREE-TIER ELIGIBLE — public data companies published about themselves:
    enrich_job          60.2% of all spend ($3.32 over 1302 calls)
    classify_job        high volume, tiny payloads
    import_job          LLM extraction of an open-web JD

  ANTHROPIC ONLY — carries candidate PII (home address, phone, work authorisation, employment
  history). Do NOT route these, and do not attempt redaction as part of this task:
    resume_generate · enhanceProfileResume (A+) · parse-pdf · cover letters ·
    domainProfiles suggestions

ENV — read from env only, never hardcoded, following the JOBO_API_KEY precedent:
    GROQ_API_KEY            gsk_...
    GOOGLE_API_KEY          (failover, optional at first)
    ENRICH_PROVIDER         groq | google | anthropic   (default anthropic)
    ENRICH_MODEL            pinned model id, e.g. llama-3.1-8b-instant

REQUIREMENTS
1. Routing lives in callModel() and NOWHERE ELSE. It is already the single wrapper all 14 call
   sites pass through; do not add a second path. Each site declares its data class
   (PUBLIC | CANDIDATE) and the router honours it.
2. ⛔ WIDEN THE GUARD FIRST, BEFORE ADDING A PROVIDER. test/modelCallGuard.test.js scans for
   /\.messages\.create\s*\(/ — that already failed to match messages.batches.create (AK2 caught it;
   adding batching would have created untracked spend with the suite green). A Groq or Gemini SDK
   uses an entirely different call shape and would bypass the cost-tracking guarantee completely.
   The guard must catch ANY provider call outside the wrapper. Verify by INJECTING a violation for
   each provider shape and confirming it fails — a guard never seen to fail is not evidence.
3. PRICING. calculateCost throws on an unknown model key. Add explicit $0 entries for free-tier
   models rather than an exception or a silent skip, or usage_events stops reconciling. Keep the
   loud warning on genuinely unknown keys.
4. usage_events must record provider AND model. All 14 sites stay tracked. A cost report that
   silently omits a third of traffic is the exact defect the tracking work fixed.
5. UNCONFIGURED MUST BE LOUD. If ENRICH_PROVIDER=groq and GROQ_API_KEY is absent, warn and fall
   back to Anthropic explicitly — never a silent skip. cacheJoboFeed logged "sync complete —
   0 jobs cached" for months on exactly this shape.
6. PIN THE MODEL ID. Catalogs churn: one provider deleted most of its free models on a single day
   and code calling the exact model went dark. An unavailable model is a LOUD failure, never a
   quiet fallback to nothing.
7. Rate limits are the constraint, not price — Groq is 30 req/min, 14,400 req/day. Enrichment's
   1302-call pass fits, but the background pass must handle 429 by backing off, not by marking rows
   enriched. enrichJob's failure path already leaves content_hash/enriched_at unset so rows retry —
   confirm a 429 takes that path and does not stamp.
8. Quality is not assumed. Run enrichment over ~50 rows on BOTH providers and diff the extracted
   fields. An 8B model may extract worse than Haiku; report per-column agreement before switching
   the default. If it is materially worse, say so — the saving is ~$3 and is not worth degrading
   skills_json, which feeds company_technographics and the ATS scorer.

VERIFY (real runs)
50 rows through Groq: usage_events rows present with provider and $0 cost, per-column agreement vs
Haiku reported. Guard fails on an injected Groq call outside the wrapper. Missing key warns and
falls back. A 429 leaves the row retryable. Commit & push.
```

## TASK B — ✅ DONE, DO NOT RE-RUN

Landed before 2026-09-04. `shared/atsBands.js` — all four bands, the seniority guard
(**ρ 0.643 → 0.746**, mis-ordered 16.1% → 12.2%), the thin-resume state, and the auto-submit gate
left decoupled at 30. 12 tests. Write-up: `docs/ak2-ats-bands.md`.

The original prompt is retained below for reference only — **it is not work to be done.**

---

## TASK B — original prompt (SUPERSEDED, reference only)

Graded sheet is filled in. `docs/ak2-ats-grading-set.md` joined against
`docs/ak2-ats-grading-key.json`:

**ρ = 0.643 · τ = 0.444 · 16.1% of pairs mis-ordered** (n=30, human-graded). Better than AK1's
self-graded ρ = 0.504 / 31.6%, which matters because AK1's grader was a model reading the same text
the engine reads.

```
⛔ DO NOT re-tune the engine. AK1 built and measured the obvious floor fix (renormalising over
informative components): rho 0.448 -> 0.242, mis-ordered 33.6% -> 41.0%, floating a Fraud Strategist
above a backend engineering role. Recorded in code with its numbers and pinned by a test.

THE WORST INVERSION, and it costs 0.09 of rho by itself:
  #12 Figma "Software Engineer Intern (Winter 2027)" — human 2, engine 60 (2nd highest of 30).
  Dropping it alone moves rho 0.643 -> 0.732.
  Cause: an intern JD states no years requirement, which pays a FLAT 85% experience credit (AK1's
  ~26 floor), and the JD is dense with engineering vocabulary. The engine cannot see seniority
  mismatch DOWNWARD.

REQUIREMENTS
1. SENIORITY GUARD. Cap intern / new-grad / early-career postings scored against a profile whose
   years_of_experience materially exceeds the role's implied level, regardless of term overlap.
   Measure rho before and after. Do NOT touch the reverted renormalisation.
2. BANDS: Strong / Moderate / Weak / Not enough signal. The fourth is REQUIRED — the scorer declines
   rather than fabricating (false-match 22.8% -> 0.8%) and that must surface as its own state, never
   as a low score. It holds 1 posting in 1291, so it CANNOT be calibrated from board data; it is a
   correctness state, not a population to balance.
3. SET STRONG FOR PRECISION. Jobs the owner graded 5 span engine scores 21-64 — the engine orders
   coarsely and does NOT separate excellent from mediocre. A Strong band admitting #12 is worse than
   a smaller one. Report what fraction of the graded 5s fall outside Strong and accept that cost
   explicitly rather than widening to capture them.
4. THIN-RESUME CASE. A band is a fixed number; the score is not. Profile 6's cutpoints applied to
   profile 5 give 0.2% Strong / 97.6% Weak. Profile 5 is a placeholder rather than a real second
   user, so the obvious reading overstates it — but a new user whose first upload is thin gets an
   all-Weak board. Decide and state: profile-relative cutpoints, a floor, or a distinct "your resume
   needs more detail" state.
5. ML/AI IS A PROFILE QUESTION, NOT A SCORING ONE. Dropping the ML rows moves rho by 0.007. Do not
   adjust for it. Note that ML/AI postings should score against the Data Science domain_profile,
   which already exists.
6. Every surface: ATS report panel, job cards, review screen, and anything the mobile contract
   exposes. If the numeric score stays in the API, mark it internal in the contract.
7. The auto-submit gate keeps using the NUMBER (threshold 30, recalibrated from 50 in AK1). Bands
   are display only; do not couple the gate to a band.

VERIFY: band populations across 1291 postings. rho before/after the seniority guard. Human-vs-engine
disagreements reported. "Not enough signal" renders distinctly from "Weak". Screenshot each surface.
```

## TASK C — ✅ DONE, DO NOT RE-RUN

All four steps landed and verified on a real emulator: toolchain, auth via
`GET /api/auth/mobile-token`, the contract-typed API layer including `automationTier`, and Room
persistence. 40 JVM + 13 instrumented tests. Write-up: `docs/aj2-android-phase2a.md`.

**Carried forward from it — not done, and now user data exists on device:**
`android:allowBackup="true"` with empty `backup_rules.xml` and `data_extraction_rules.xml` (both
still untouched Studio templates). The auth token AND the persisted résumé are swept into Google
cloud backup by default. **Write the excludes.** This was flagged as "before the first token exists"
— the token now exists.

Still open and owner's: **the Android admin panel.** Six screens of fabricated data, ungated, with
Delete / Suspend / Impersonate controls that hit nothing. Recommendation: build flavour, not
deletion, and never in a Play build. Asked five times.

The original prompt is at `resume-master-android/PHASE_2A.md` — reference only.

---

## TASK C — original summary (SUPERSEDED, reference only)

Full prompt: **`resume-master-android/PHASE_2A.md`** (self-contained, in that repo).

Android Studio is now installed, so "the build has never been verified" is finally closable.

```
FIRST STEP, likely the whole blocker: strip the BOM from gradle/libs.versions.toml. A conforming
TOML parser demonstrably REJECTS it and parses cleanly once stripped.
SECOND: gradle.properties hardcodes org.gradle.java.home=C:\Program Files\Android\Android Studio\jbr
— if Studio installed elsewhere, that line breaks the build. Remove it; resolve JDK 17 from the
toolchain.
THIRD: compileSdk = 35 with agp 9.0.1. AGP 9 requires compileSdk 36+.
android.suppressUnsupportedCompileSdk=35 suppresses the warning, not the minimum.

Then: auth via GET /api/auth/mobile-token (NOT the login response's authContext — that one is
session-bound and persisting it causes intermittent untraceable sign-outs), then the contract-typed
API layer including automationTier, then resume persistence. NO FEED.
```

Still open and owner's: **the admin panel** — 6 screens of fabricated data, ungated because no auth
exists to gate against, with Delete / Suspend / Impersonate controls that look functional and hit
nothing. Recommendation: build flavour, not deletion, and never in a Play build.

## TASK D — Generation deferral + free ATS at swipe

Unblocked once B sets the bands. Prompt unchanged from `docs/QUEUED_PROMPTS.md` — move the
generation trigger from queue to approve, show the free base-resume BAND on the swipe card, keep a
per-profile "generate at queue" toggle default-OFF for testing.

## TASK E — Cache breakpoints + Batch API

Full findings: `docs/ak2-cache-batching-assessment.md`.

```
1. REMOVE THE UNREAD CACHE BREAKPOINTS. The generation prefix is written at 1.25x and read at 0.1x
   — written every time, read never. A 25% surcharge buying nothing. Unconditional -8.1%, available
   with no batching. Verify before/after against real usage_events, reconciled.
2. BATCH enrich_job via the Batch API — IF it is still on Anthropic after task A. If task A moved it
   to Groq, this requirement is moot and should be reported as such rather than done.
3. -37% and -68% are ASYMPTOTES. Ten generations in one 5-minute window is -33.4%; two is -18.5%.
   resume_generate has run ONCE in 1367 events, so the projection rests on one row.
4. NOT ON THE APPLY PATH. Semi and auto both hold a live browser open blocking on the resume at the
   upload step, against a 24-hour batch SLA. Batching wins by making CASE A (current artifact, no
   model call) normal — which is what task D does. Hence E behind D.
5. Verify pricing LIVE, not from memory. A cached table dated 2026-06-24 claimed a Sonnet 5 rise
   landing 2026-09-01; live docs say it will not occur and shared/anthropicModels.js was already
   correct.
```

## TASK F — PII tokenization ⏸ deferred, deliberately

The design is sound and is recorded here so it is not re-derived from scratch:

> Substitute employers, teams and identifying fields against the in-house KB before the payload
> leaves, generate against tokens, substitute back on return. A **whitelist-constructed payload**,
> not a filtered one — a whitelist fails closed, a blacklist fails silently. Stable work history is
> what makes deterministic tokenization possible: same employer, same token, every time, so the
> model still sees coherent structure.

**Three things it must include when built:**

1. **Some fields are excluded, not tokenized.** Work authorisation, sponsorship status, visa type
   and EEO answers must not leave in any form — a token still carries the value, and immigration
   status is a special category. After AF2 the years figure comes from the profile, so generation
   does not need them. Same for `linkedin_url` and `github_url`, which a "name, email, phone" mental
   model misses.
2. **The reversal step is where the risk moves.** Two failure modes, both assertions rather than
   hopes: every token sent must come back (the model may rephrase around it), and no token outside
   the sent set may appear (hallucinated `COMPANY_C`).
3. **The guard is a field-level whitelist assertion on the outbound payload**, in `callModel()`,
   refusing to send anything not on the list for that provider tier.

**Why deferred:** `resume_generate` has run **once in 1367 events**. This subsystem — mapping layer,
KB substitution, reversal, whitelist guard, round-trip tests — currently protects about four cents.
Build it when generation volume justifies it; AF5 will show what that volume is.

---

## ⚠ The section ABOVE is superseded

The "⏸ deferred" block immediately above is **superseded by the live TASK F below**. The owner chose
to wire tokenization now rather than at volume. Its three original requirements — whitelist-not-
filter, excluded-not-tokenized fields, and the round-trip assertions — are carried into the live task
verbatim. Ignore the deferred block; run the one below.

---

## TASK F — PII tokenization layer

```
OBJECTIVE
Allow generation-class calls to use a non-Anthropic provider by constructing a payload that carries
no candidate PII, generating against tokens, and substituting back on return.

OWNER DECISION: wire this NOW rather than at volume, because testing the round trip is easier before
real traffic than after. Recorded honestly: resume_generate has run ONCE in 1367 events, so this
currently protects about four cents. It is being built for testability, not for savings.

⛔ A WHITELIST-CONSTRUCTED PAYLOAD, NOT A FILTERED ONE. Build the outbound payload from an explicit
field allow-list. Never take a full payload and strip PII out of it. A whitelist fails CLOSED; a
blacklist fails SILENTLY, and a regex that misses one email in one resume leaks a real person's data
to a training corpus with no error and no way to know. That is Shape 3 in the worst possible place,
and this codebase has produced that shape six times.

WHY TOKENIZATION WORKS HERE
Work history is stable, so tokenization can be deterministic: same employer, same token, every time.
The model still sees coherent structure (COMPANY_A, TEAM_1, 18 months) and can tailor against it.

REQUIREMENTS
1. TOKENIZE against the in-house KB: employers, teams, institutions. Deterministic mapping, stored
   per generation so the reversal is exact.
2. ⛔ SOME FIELDS ARE EXCLUDED, NOT TOKENIZED. These must not leave in ANY form, because a token
   still carries the value:
     work_auth · requires_sponsorship · visa_type · has_clearance · clearance_level ·
     gender · ethnicity · veteran_status · disability_status · linkedin_url · github_url ·
     address_line1/2 · zip · phone · email
   Immigration status is a special category in most frameworks. After AF2 the years figure comes
   from the PROFILE, not the JD, so generation does not need the eligibility fields at all — verify
   that and report it. linkedin_url and github_url are directly identifying and are exactly what a
   "name, email, phone" mental model misses.
3. THE REVERSAL STEP IS WHERE THE RISK MOVES. Two failure modes, both ASSERTIONS not hopes:
     a. every token sent must come back — the model may rephrase around one and drop it
     b. no token outside the sent set may appear — a hallucinated COMPANY_C must fail loudly
   A generation failing either check does not persist. This is the testable property that makes the
   design compliance-defensible rather than compliance-shaped.
4. THE GUARD IS A FIELD-LEVEL WHITELIST ASSERTION ON THE OUTBOUND PAYLOAD, enforced in callModel()
   for any provider tier that is not Anthropic. It refuses to send anything not on the list. Verify
   by INJECTING an excluded field and confirming the send is refused — a guard never seen to fail is
   not evidence.
5. A+ / enhanceProfileResume STAYS ON CLAUDE, untokenized, per the owner. It is the experimental
   path and its prompt changes; do not route it.
6. AF2's hard assertion — generated output may not claim more experience than the profile states —
   must still run on the tokenized path. Confirm it inspects something rather than vacuously
   passing on a payload whose shape changed.

VERIFY (real runs)
Generate through the tokenized path and diff the output against an untokenized Claude generation of
the same job: content equivalent, no token leaked into the final artifact. Injected excluded field is
refused. A dropped token fails the round trip. A hallucinated token fails. Commit & push.
```

---

## TASK G — Offline asset generation

```
THE PRINCIPLE — read this before anything else in the task
Use the free-tier LLM OFFLINE to build DETERMINISTIC ASSETS. Never at query time.

Everything valuable in this codebase that is deterministic is deterministic FOR A REASON: the ATS
scorer must be free and instant to power a swipe card; buildAnswers must never be model-generated
because those answers are attestations to an employer; the KB must never learn from claims. A model
call at query time breaks those properties. A model call OFFLINE, producing a reviewed table that
the deterministic code then consumes, fixes their known weaknesses while preserving every guarantee.

That pattern also fits free tiers exactly: batch, background, no latency budget, PUBLIC DATA ONLY.
Every output below is derived from job postings companies published about themselves. No candidate
data is sent in this task at all.

DEPENDS ON TASK A. Routing, the widened modelCallGuard, and $0 pricing entries must be live first.

─── G1 — SKILL SYNONYM TABLE (highest value; attacks a MEASURED ceiling) ───

AK1 named this precisely: the worst ATS inversion was -19 ranks, a reliability role whose JD said
"log analysis" where the resume said "observability tooling", and it called this "a ceiling on the
approach, not a bug". This is the ONLY item on the horizon that moves rho = 0.643 upward rather
than sideways.

1. Offline pass over the ~1291 active postings' JD text extracting SKILL EQUIVALENCES:
   log analysis ~ observability · K8s = Kubernetes · Postgres = PostgreSQL · JS = JavaScript.
2. Store with CONFIDENCE and PROVENANCE, like every other KB fact — which postings supported it,
   how many, when last seen. Follow services/kb/orgLayer.js's pattern; do not invent a second one.
3. ⛔ A FALSE EQUIVALENCE IS A CONFIDENTLY WRONG MATCH — the failure mode that costs the most
   trust, and the same class as the "coffee machine vendor" credited with machine learning (22.8%
   of all multi-word matches before AK1's proximity fix). Nothing above a threshold goes live
   without a HUMAN REVIEW PASS. Present the proposed table for review; do not auto-promote.
4. REUSE searchQueryBuilder's existing normalisation as the base vocabulary. Do NOT write a third.
   Do NOT wire buildApifyQueriesFromProfile into anything — it is scraping-era and off-limits.
5. MEASURE THE EFFECT. Re-run the 30-posting graded set with the synonym table active and report
   rho before and after. If rho does not move, the table is not earning its keep — say so.
6. The scorer stays deterministic, instant and free at query time. Confirm no model call enters the
   scoring path: test/localAtsScorer.test.js already asserts the scrape block contains no
   messages.create — that assertion must still hold.

─── G2 — LCA COMPANY-NAME RESOLUTION ───

Company matching landed at 75%. The unmatched 25% are legal-entity vs brand mismatches —
"META PLATFORMS, INC." vs "Meta", subsidiaries, DBAs, multiple entities per brand. An LLM resolves
these well and it is public company data.

This matters because the sponsorship differentiator has NO posting-level signal at all: 0 of 1261
postings mention "H-1B" and only 36 mention sponsorship in any form. Company-level LCA evidence is
the entire signal.

1. Resolve the unmatched employer names against your company list. Report the new match rate.
2. ⛔ EVERY RESOLUTION CARRIES A CONFIDENCE, and a low-confidence match is NOT presented as fact.
   Telling a candidate Company A sponsors when the LCA belongs to a similarly-named Company B is a
   false attestation about a third party. State the threshold and the rule.
3. The integrity line is unchanged: "this company filed 47 H-1B petitions in 2025" is evidence
   about the EMPLOYER, never a promise about this role. The posting-level is_h1b_sponsor soft-null
   rule survives untouched — two different facts, two different columns.

─── G3 — TECHNOGRAPHIC CANONICALISATION ───

company_technographics holds 8507 rows built from skills_json. If variants are not collapsed,
"Postgres" and "PostgreSQL" are two entries and every company's stack view is diluted — which is
what FE-4's STACK block and FE-6's recruiter reference render.

1. Apply G1's synonym table. Build once, use twice — do not generate a second vocabulary.
2. Report the row-count delta and the top-20 stack for three companies before and after.
3. This CHANGES a KB surface, so confirm confidence and provenance survive the merge: a canonical
   term's confidence must reflect its merged evidence, not the highest of its variants.

─── G4 — ORG-UNIT EXTRACTION (9.5), with a live false positive to fix ───

services/kb/orgLayer.js proposes org units from postings by deterministic parsing. An LLM extracts
team names better, and this is public data companies emit about themselves — so the §7 rule "never
learn from claims" is satisfied and free-tier routing is appropriate.

A LIVE FALSE POSITIVE, observed in the failsafe strip:
  FLAG: 'Bangalore' doesn't match any team we've seen in Stripe's job postings
         (closest: 'Solutions Architecture')
"Stripe | Payments Infrastructure, Bangalore" — Bangalore is the LOCATION. A location was parsed as
an org unit, then flagged against company_org_units. §7 names this as the costly error: "a false
'this doesn't match' is the costly error." It is a false flag against a TRUE claim.

1. Improve extraction from the "Company | Team, Location" pattern. Exclude locations BEFORE
   matching — scraped_jobs.location and the enrichment's workplace_type already give a location
   vocabulary. Reuse it; do not write a third.
2. Audit for the same class: any other field matched against the wrong KB dimension.
3. ⛔ The 9.5 integrity rule is unchanged and must be re-asserted: NO code path may write org units
   from resume or profile tables. Grep-prove it, as the original audit did (0 of 697 org units is a
   location — re-verify after the change).
4. Keep the proposed/confirmed distinction and the promotion thresholds (3 postings, 0.6
   confidence). An LLM proposing a unit does not promote it; corroboration does.
5. A near-match must be PLAUSIBLE before it is offered. Suggesting "Solutions Architecture" as the
   closest thing to "Bangalore" reveals the similarity threshold is too low, and a suggestion no
   human would make damages trust in every other finding.

VERIFY: the same resume produces no Bangalore flag. A genuinely wrong team name still flags. Org
units extracted from 20 postings, reviewed for plausibility. Grep-proof of rule 3.

─── EXPLICITLY OUT OF SCOPE ───

⛔ The apply answer resolver (buildAnswers) itself. Deterministic by contract — Jobo's integration
  terms say "No AI-generated answers" and §7 says the same. Its weakness is fuzzy label matching and
  the fix is a better TABLE, which is TASK H — not a model at fill time.
⛔ The 9.6 failsafe. It IS the integrity check. A model judging whether a claim contradicts the KB
  introduces exactly the fabrication risk the failsafe exists to prevent.
⛔ Anything touching candidate data. Task A's split governs: route by WHOSE DATA IT IS.

VERIFY
rho before/after on the graded 30 with G1 active. New LCA match rate with the confidence
distribution. Technographic row delta plus three before/after stack views. Grep-prove no model call
entered the ATS scoring path. Every table carries confidence and provenance. Commit per sub-task.
```

---

## TASK H — Form label → field mapping

```
OBJECTIVE
PLATFORM_LABEL_MAPS in services/platformDetector.js is hand-written for greenhouse, lever and
workday, with every other platform falling through to `generic`. G4's schema capture collects real
form structures from live ATS pages. Generate the label→field mapping offline from those captured
schemas instead of hand-authoring it.

⛔ THIS TASK PRODUCES A TABLE. IT DOES NOT PUT A MODEL IN THE FILL PATH.
buildAnswers stays deterministic — Jobo's integration terms say "No AI-generated answers" and §7
says the same. The output of this task is a reviewed mapping that deterministic code consumes. If
any part of the implementation results in a model call during a fill, the design is wrong.

⛔ THE HARD BOUNDARY: NO ELIGIBILITY FIELD MAY BE MAPPED BY THIS TABLE.
Work authorisation, sponsorship, clearance, visa, criminal history, EEO, years of experience.
Those resolve by exact handler mapping or not at all. Two precedents, both live defects:
  · login_email labelled "Email" resolved to the email handler and typed the candidate's home
    address into a portal's SIGN-IN box at 0.9 confidence. The legacy sweep also wrote to the
    PASSWORD field, because its type-exclusion list never included password.
  · The sponsorship-inversion trap: a work_authorization key substring-matched "do you now or in
    the future require sponsorship for work authorization" — a semantically INVERTED question, and
    a materially false attestation to an employer.
Label matching getting clever near attestations is how both happened. Assert the exclusion with a
test, not a comment.

REQUIREMENTS
1. Input is G4's captured company_form_schemas plus the existing PLATFORM_LABEL_MAPS. Public form
   STRUCTURE only — labels, types, required flags, option lists. Never a candidate's entered values.
2. Output is a stored mapping with confidence and provenance, following orgLayer.js's pattern.
   Low-confidence mappings stay proposed; they do not reach the resolver.
3. HUMAN REVIEW BEFORE ANY MAPPING GOES LIVE. A wrong mapping fills the wrong answer into a real
   employer's form, which cannot be recalled.
4. Preserve the resolver's existing provenance tiers. A table-derived mapping resolves at
   'field_map_exact', never at 'label_fuzzy' — and the A2 rule stands: a label_fuzzy answer is not
   auto-submitted in mode:'full'.
5. Report how many `generic`-platform fields the table newly resolves, and how many remain
   unresolvable. An unresolvable required field is VALUABLE information — it tells the user in
   advance that the run will hold. Surface it at queue time, not at submit.

VERIFY (real runs, fakeAts only)
Re-run the A1 trap matrix in full. Every trap must still PASS or HOLD — sponsorship_inversion,
name_ambiguity and lowercase_yes especially. Assert no eligibility field appears in the generated
table. Confirm the resolver makes no model call during a fill. Report newly-resolved field counts.
Commit & push.
```

---

## Owner-only, alongside

**AF5 semi campaign** — 10 runs per ATS, credit now available. Also the ground truth for whether
ρ = 0.643 predicts anything; the score-at-application field exists (migration 095).
**Extension submission** — blocked on `CWS_*` credentials only.
**Android admin panel decision.**

## Provider notes for task A

- **Groq** — 30 req/min, 14,400 req/day on `llama-3.1-8b-instant`, highest daily allowance,
  fully OpenAI-compatible so it is a base-URL swap.
- **Gemini Flash** — free, no card, 1M context. Best failover.
- **SambaNova** — 200,000 tokens/day, quota is per model rather than shared.
- **Skip Cohere** — 1,000 calls/month, **non-commercial use only**.
- ⚠ **Free tiers are generally funded by your prompts.** Confirm Groq's current data policy in their
  terms directly — the comparison articles say Groq "does not state either way on a public page."
  If they do train on free-tier data, the public-JD-only rule is what keeps this clean.
