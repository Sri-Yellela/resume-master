# Queued Prompts — current state

**Last reconciled:** 2026-09-03, after AJ2. Suite **2057 passing, 0 failing**. Migration high-water
**095**. Mobile contract **v1.1.1** at `contract/mobile-api.v1.json`.

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
| 2 | Corruption sweep | all three | ✅ **desktop DONE** · ✅ **android DONE** (56 BOMs) · ios reported only | a Mac |
| 3 | Web client cursor paging | desktop | ✅ **DONE** `5d11da7`, re-verified 17/17 | — |
| 4 | ATS bands | desktop | ✅ **DONE** `7494289` | — |
| 5 | Cache batching | desktop | ⏸ **assessment done, changes blocked** | task 7, then API credit |
| 6 | Android Phase 2a | android | ✅ **DONE** — all 4 steps device-verified `2bbd242` | — |
| 7 | Generation deferral | desktop | ⛔ not started | — (task 4 landed) |
| 8 | iOS Phase 1 audit | ios | ⛔ not started | **a Mac with Xcode** |

**Missing tools — the whole blocker list:** a Mac with Xcode · Anthropic API credit (exhausted
2026-08-25, confirmed by provider error text in `usage_events`).

**The Android toolchain is no longer a blocker.** Studio, SDK platform 37, build-tools 36.0.0,
`cmdline-tools`, and an emulator (`rm_api36`, API 36 x86_64, WHPX) are all installed and working.
The build has now been run: it produces a 77.7 MB debug APK reproducibly from `clean`.

---

## Do these in this order

**1 · Top up API credit** — unblocks task 5's verification, task 7's, and AF5.

**2 · Decide the Android admin panel** — open across three reports. 6 screens of fabricated data,
ungated (no auth exists to gate against), with Delete / Suspend / Impersonate controls that look
functional and hit nothing. Recommendation: **build flavour, not deletion**, and never in a Play
build.

**3 · Then run task 7** (generation deferral) **→ task 5** (take the −8.1%, batch `enrich_job`).
Task 6 is complete; task 8 waits on a Mac. Phase 2b (the feed) is the next mobile step.

---

## Task 4 — ATS bands · ✅ DONE

Landed in `7494289`. Full write-up: `docs/ak2-ats-bands.md`; measurement half in
`docs/ak2-ats-band-distribution.md`; the owner's graded 30 in `docs/ak2-ats-grading-set.md`.

Cutpoints **Strong ≥ 44 · Moderate ≥ 26 · Weak < 26 · null = Not enough signal**, set from the
graded 30 (ρ 0.746 after a seniority guard, τ-b 0.594, 12.2% mis-ordered). Strong is tuned for
PRECISION and the accepted cost is stated: 4 of the 12 postings graded 5 render Moderate. The
auto-apply gate stays a NUMBER at 30 and a test asserts 44 ≠ 30.

The bands had nothing to band until `54eb06e`: `matchScore` was null on every row of every
response, because mapJobRow read `_matchScore || match_score` and neither exists — the column is
`ats_score`. Fixed, contract bumped to **1.1.1**, and verified on a real device (44 → Strong,
43 → Moderate, one point apart). The desktop surfaces were never affected; they read
`baseAtsScore` from a different mapper, which is why nobody noticed for so long.

---

## Task 6 — Android Phase 2a · steps 1-3 done, step 4 open

Full write-up: `docs/aj2-android-phase2a.md`. Android commits `e35b6f8`, `d8e0611`, `01c1221`.

**Done and verified on a real emulator against the real local server:** the toolchain (first
verified assemble in the project's history, four failures deep), auth (login → `mobile-token`
exchange, with the sessionLess mint confirmed in `auth_contexts`), and a contract-typed API layer
generated from `contract/mobile-api.v1.json` (37 fields, against the old parser's 10). Backup
excludes for the token landed BEFORE any token existed and are verified in the compiled APK.

Tier gating verified end to end: of five seeded rows, one per tier, only `direct` and `guest`
reached the phone.

**Step 4, resume persistence, is done** (`2bbd242`). Room-backed, with the two order columns SQL
needs and no destructive migration. Verified by 13 instrumented tests on a real file-backed
database, plus a by-hand edit read back out of the device's own `.db` + `-wal`.

⛔ Do not re-run the corruption sweep on this repo — all 56 BOMs are stripped and committed.

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

**UNBLOCKED — task 4's bands landed in `7494289`.** Full prompt below is unchanged and still correct.

Requirement 2 (the approval screen shows the band) is now actually implementable: `matchScore`
carries a score as of `54eb06e`. Before that a band computed from the API alone was
"Not enough signal" every time.

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
