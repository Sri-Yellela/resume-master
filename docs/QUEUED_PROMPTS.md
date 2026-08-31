# Queued Prompts — current state

**Last reconciled:** 2026-08-31, after AK2. Suite **2038 passing, 0 failing**. Migration high-water
**095**. Mobile contract **v1.1.0** at `contract/mobile-api.v1.json`.

> **Read this before trusting anything below.** AK2 picked up five tasks and found **three of them
> already done** — tasks 1 and 3 had landed in commits this file listed as pending, and task 5's
> headline pricing risk was refuted by live docs the repo already agreed with. This file was four
> hours old and already wrong. Re-derive state from the repo, not from here. Re-derive the test
> baseline at the start of every task; the number above will be stale too.

**Three repositories:** `resume-master` (desktop) · `resume-master-android` · `resume-master-ios`.

---

## Status

| # | Task | Repo | State | Blocked on |
|---|---|---|---|---|
| 1 | Outcome UI | desktop | ✅ **DONE** `9edb91a` | — |
| 2 | Corruption sweep | all three | ✅ **desktop DONE** · mobile reported only | toolchains |
| 3 | Web client cursor paging | desktop | ✅ **DONE** `5d11da7`, re-verified 17/17 | — |
| 4 | ATS bands | desktop | ⏸ **measurement done, thresholds blocked** | **owner grading** |
| 5 | Cache batching | desktop | ⏸ **assessment done, changes blocked** | task 7, then API credit |
| 6 | Android Phase 2a | android | ⛔ not started | **JDK + Android SDK** |
| 7 | Generation deferral | desktop | ⛔ not started | task 4 |
| 8 | iOS Phase 1 audit | ios | ⛔ not started | **a Mac with Xcode** |

**Missing tools — the whole blocker list:** a JDK + Android SDK (Android Studio installs both) ·
a Mac with Xcode · Anthropic API credit (exhausted 2026-08-25, confirmed by provider error text in
`usage_events`).

---

## Do these in this order

**1 · Grade `docs/ak2-ats-grading-set.md`** — owner, ~30 minutes, blocks tasks 4 and 7.
30 postings spanning engine scores 6–64, shuffled, score withheld. Rate each 1–5 for fit against
your resume. **Do not read `ak2-ats-grading-key.json` first.** This is the only independent check on
ρ = 0.504; AK1's own 30 were self-graded and were never committed, so its ρ cannot be re-joined.

**2 · Install Android Studio** — unblocks task 6 and the two highest-severity mobile findings.
Three sessions have now reported "the build has never been verified."

**3 · Top up API credit** — unblocks task 5's verification, task 7's, and AF5.

**4 · Decide the Android admin panel** — open across three reports. 6 screens of fabricated data,
ungated (no auth exists to gate against), with Delete / Suspend / Impersonate controls that look
functional and hit nothing. Recommendation: **build flavour, not deletion**, and never in a Play
build.

**5 · Then run task 4** (set bands) **→ task 7** (generation deferral) **→ task 5** (take the −8.1%,
batch `enrich_job`). Tasks 6 and 8 run whenever their toolchain lands, in parallel with everything.

---

## Task 4 — ATS bands · thresholds blocked on grading

Full findings: `docs/ak2-ats-band-distribution.md`. Grading sheet: `docs/ak2-ats-grading-set.md`.

Measurement is complete. All 1291 postings re-scored through the real runtime path against the
owner's profile (6): **median 27, p75 32, p90 39, max 64** — within a point of AK1's independent
synthetic profile.

**A near-miss worth carrying:** two profiles are active. Profile 5 is the `John Doe` placeholder AK1
set aside; profile 6 is the real resume. Measuring the wrong one would have failed *quietly* —
profile 5 gives median 20 / max 42, and the distribution of an empty CV would have been reported as
the distribution of the engine.

**Two findings that change the design:**

1. **The required fourth band is empty.** "Not enough signal" holds **1 posting in 1291** (0.08%).
   It stays — it is a *correctness state*, not a population to balance — but it cannot be calibrated
   from board data, and tuning the other three against it means tuning against one row.
2. **A band is a fixed number; the score is not.** Profile 6's cutpoints applied to profile 5 give
   0.2% Strong / 97.6% Weak. Profile 5 is a placeholder rather than a second real user, so the
   obvious reading overstates it — but the mechanism has a real victim: **a new user whose first
   upload is thin gets an all-Weak board.**

```
⛔ DO NOT re-tune the engine. AK1 measured the obvious fix (renormalising over informative
components) and it made ranking WORSE: ρ 0.448 → 0.242, mis-ordered 33.6% → 41.0%, floating a Fraud
Strategist above a backend engineering role. Recorded in code with its numbers and pinned by a test.

REQUIREMENTS
1. Bands: Strong / Moderate / Weak / Not enough signal. The fourth is REQUIRED — the scorer declines
   rather than fabricating (false-match rate 22.8% → 0.8%) and that must reach the user as its own
   state, never as a low score.
2. Set cutpoints from the owner's graded 30 joined against the engine scores, NOT from percentiles
   alone. Report where the human's 1–5 and the engine's ordering disagree — the disagreements are
   the finding.
3. Address the thin-resume case explicitly. An all-Weak board on first upload is a worse first
   impression than no bands. Options: profile-relative cutpoints, a floor, or a distinct
   "your resume needs more detail" state. Decide and state which.
4. Every surface: ATS report panel, job cards, review screen, and anything the mobile contract
   exposes. If the numeric score stays in the API, mark it internal in the contract.
5. The auto-submit gate keeps using the NUMBER (threshold 30, recalibrated from 50 in AK1). Bands
   are display only. Do not couple the gate to a band.

VERIFY: band populations across 1291 postings. Human-vs-engine disagreements reported. Screenshot
every surface. "Not enough signal" renders distinctly from "Weak".
```

---

## Task 5 — Cache batching · reframed by the assessment

Full findings: `docs/ak2-cache-batching-assessment.md`.

**The task as written aimed at 0.8% of spend.** `enrich_job` is **60.2%** ($3.32 over 1302 calls),
uses no caching, and *cannot* — its entire static content is ~347 tokens against a ~1024-token
minimum cacheable prefix. Its saving must come from the **Batch API**, where it is ideal: background
pass, `SYSTEM_USER_ID`, no human waiting.

**Available today, no batching, no credit needed to implement:** the prefix is written at 1.25× and
read at 0.1× — **written every time, read never**. The caching is a 25% surcharge buying nothing.
Removing the unread breakpoints is an unconditional **−8.1%**.

**−37% and −68% are asymptotes.** Ten generations in one 5-minute window is −33.4%; two is −18.5%.
And `resume_generate` has run **once** in 1367 events, so the projection rests on one row. Elsewhere
the same mechanism gets 7.25× and 7.98× reads per write on clustered calls — that is the real
evidence the thesis works.

**Not on the apply path.** Semi and auto both hold a live browser open blocking on the resume at the
upload step, against a 24-hour batch SLA. But CASE A (current artifact, no model call) already
exists, so batching wins by **making CASE A normal** — which is exactly what task 7 does.
**Sequence 5 behind 7.**

```
1. Remove the unread cache breakpoints on the generation prefix — unconditional −8.1%. Verify
   against real usage_events, before/after, reconciled.
2. Batch enrich_job via the Batch API. It is the 60.2%.
3. modelCallGuard was widened this session to catch messages.batches.create — confirm it still
   holds and that batching creates no untracked path. All 14 call sites stay tracked.
4. Verify pricing LIVE against the docs, not from memory. A cached table dated 2026-06-24 claimed a
   Sonnet 5 rise landing 2026-09-01; the live docs say it will not occur, and
   shared/anthropicModels.js was already correct.
```

---

## Task 7 — Generation deferral + free ATS at swipe

**Unblocked the moment task 4's bands are set.** Full prompt below is unchanged and still correct.

```
OBJECTIVE
Generation fires at QUEUE time (~$0.04, Sonnet). Swiping is ~1s per job, so five idle minutes is
~60 jobs / ~$2.40 from a gesture costing the user no thought. Defer generation to APPROVAL so a
right-swipe is free.

A user cannot approve blind. scoreAtsLocally runs with NO model call and NO generated artifact —
server.js already does exactly this. So the swipe card shows a real fit BAND computed against the
BASE resume, free, and generation happens on approval.

That framing is more honest than today's: the current score is computed against the GENERATED
resume, so it reflects tailoring the user has not yet decided to pay for. A base-resume band is an
honest floor — tailoring can only improve it.

REQUIREMENTS
1. Move the generation trigger from queue to approve. One queue mechanism, two triggers (web and
   mobile) — do NOT add a second path.
2. The approval screen shows the band, matched/missing terms, and what WOULD be filled, then
   generates on commit.
3. A per-profile "generate at queue" toggle, default OFF, for the owner's testing phase.
4. APPLY_DAILY_QUEUE_CAP was sized for generate-at-queue. If queueing is free the cap protects
   nothing and the meaningful limit moves to approvals. Report; do not change unilaterally.
5. Both caps stay SURFACEABLE — the structured payload carries limit and remaining; render them.

VERIFY: queue a job, assert zero generator invocations (count them, as AH5 did). Approve it: one
generation. The band renders before approval. Toggle ON restores generate-at-queue.
```

---

## Tasks 6 and 8 — mobile, blocked on toolchains

Full prompts live in their own repos: **`resume-master-android/PHASE_2A.md`** and
**`resume-master-ios/PHASE_1_AUDIT.md`**. Both self-contained.

**Two findings most likely breaking a build right now, first step in each repo:**

- **android** — BOM on `gradle/libs.versions.toml`. A conforming TOML parser demonstrably rejects it
  and parses cleanly once stripped. Also `gradle.properties` hardcodes
  `org.gradle.java.home=C:\Program Files\Android\Android Studio\jbr`.
- **ios** — BOM sitting in front of the mandatory `// !$*UTF8*$!` magic comment in `project.pbxproj`.

**The iOS finding that settles its Phase 1 networking question:** 32 Swift files on disk, **30 in the
Sources build phase**. The two omitted are `Data/JobRepository.swift` and
`Services/LinkedInAuthService.swift` — the entire network and auth surface is **never compiled**.
Commit `f8be63c` *"feat: JobRepository.swift — consumes /api/jobs"* has zero effect on the built app.

⛔ Adding those files to the target breaks the build immediately on `invalid redeclaration of 'Job'`
— two structs, 13 fields vs 10, `String` id vs `UUID`. Deciding which is canonical is the same
decision as Phase 2's contract-typed model. **Defer to Phase 2; do not patch.**

Note: the iOS working tree was committed by another session mid-sweep as `aad5a3a` — re-derive before
acting on any iOS finding above.

---

## Carried forward

- **Duplicated resume CSS** (Shape 1). 45 of 46 lines of `RESUME_STYLE_BLOCK` are duplicated into the
  `FORMATTING_SYSTEM` prompt — which is *how* one corrupt character reached both the renderer and the
  model instruction. Interpolate rather than duplicate, but only alongside work that can run a real
  generation, since editing a prompt is a behaviour change.
- **Shape 5 policy.** 113 of 157 desktop test files (72%) `readFileSync` a source file and assert on
  its text. Not a mass rewrite — a policy going forward, plus re-pinning only tests that touch code
  being changed. The source-anchor sweep closed the dangerous subset: 284 lookups across 59 files now
  go through `at()`/`lastAt()`, which throw and name a missing anchor, held at zero by
  `test/sourceAnchorGuard.test.js`.

---

## Owner-only, running alongside

**AF5 semi campaign** (10 runs per ATS — needs credit) · **extension submission** (blocked on
`CWS_*` credentials; preflight green, screenshots automated, privacy policy live) · **Android admin
panel decision** · **Jobo renewal**.

---

## Cross-references

- `docs/CORRUPTION_SWEEP.md` — the sweep prompt, for the mobile repos when toolchains land
- `docs/ak2-corruption-sweep.md` · `ak2-ats-band-distribution.md` · `ak2-ats-grading-set.md` ·
  `ak2-cache-batching-assessment.md` · `ak2-source-anchor-sweep.md` — AK2 findings
- `resume-master-android/PHASE_2A.md` · `resume-master-ios/PHASE_1_AUDIT.md`
- `docs/AUTOAPPLY_PROMPTS.md` · `docs/GATED_HANDOFF_PROMPTS.md` · `docs/EXECUTION_PROMPTS.md` ·
  `docs/SWIPE_FEED_DESIGN.md`
