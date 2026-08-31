# Queued Prompts — run in this order

Written after AK1 (ATS engine v4). Each task is a separate session and a separate commit.
Re-derive the test baseline at the start of every task — the suite grows constantly and every
recorded number in these docs goes stale. Last known: **2028 passing, 0 failing**; harnesses 32/32;
migration high-water **095**; mobile contract **v1.1.0** at `contract/mobile-api.v1.json`.

**Repo column matters.** Three repositories are in play:
- `resume-master` (desktop: server, web client, extension, contract) — most tasks
- `resume-master-android`
- `resume-master-ios`

| # | Task | Repo | Blocks | Parallel-safe with |
|---|---|---|---|---|
| 1 | Outcome UI | desktop | AF5's value | 2, 3 |
| 2 | Corruption + defect-pattern sweep | **all three** | Android Phase 2 | 1, 3 |
| 3 | Web client offset paging | desktop | — | 1, 2 |
| 4 | ATS bands, not numbers | desktop | swipe feed design | — |
| 5 | Cache-window batching | desktop | — | 4 |
| 6 | Android Phase 2a | android | feed + review queue | 5 |
| 7 | Generation deferral + free ATS at swipe | desktop | mobile feed | — |
| 8 | **iOS Phase 1 audit** | **ios** | iOS Phase 2a | anything |

Owner-only, not agent work, running alongside: **AF5 semi campaign** · **extension submission**
(blocked on `CWS_*` credentials) · **admin-panel build-flavour decision** · **Jobo renewal**.

---

## Standing conventions — prepend to every task below

```
Session-aware: read the files in scope by SYMBOL, not line number — line numbers in this project's
docs have gone stale twice in a day. Reconstruct state from the repo, not from status documents.
Regression-proof: for every modified module review its dependents (importers) and children
(imports) and fix them in the SAME pass, reporting each with a verdict. Migrations additive +
dual-path, byte-identical in BOTH scripts/migrations.js and the server.js MIGRATIONS array
(high-water 095). Close each task with a REPORT (files, dependents + verdicts, migration id,
REAL-run verification — not simulated) then commit & push as ONE focused commit. Re-derive the test
baseline BEFORE touching anything; introduced failures must be 0.

EVIDENCE RULE: a passing suite is not evidence for UI or pipeline behaviour in this codebase. A
totally broken panel once passed the build and 1460 source tests (a TDZ crash — every render threw).
Confirm UI work by SCREENSHOT and pipeline work by REAL RUN.

THE RECURRING DEFECT SIGNATURE — every significant bug here has been one of these. Watch for all six.
 1. Two sides of a contract that don't meet (mapJobRow vs the client mapper; popup vs hotkey writing
    to different tables; `tool` sent vs `toolType` read; mode "manual" coerced to "auto").
 2. A handler wired to nothing, or to the wrong thing (onSearch={() => {}}; an unscoped openReview
    surviving in a ternary's fallback arm). Search by IDENTIFIER, not by call-site shape.
 3. Silence reported as success (a provider that never ran logging "sync complete — 0 jobs cached";
    enrichment stamping rows complete while writing nothing; a truncated packet list read as
    batch_empty).
 4. NULL-hostile predicates over optional data (IN / NOT IN / LIKE / `=` in a cursor chain — four
    separate production incidents).
 5. A test that pins a defect or asserts the wrong thing (one asserted a broken ternary verbatim, so
    fixing it would have failed CI).
 6. A claim with no code, or code with no claim (a store listing declaring "PII not collected" for a
    build that types a postal address into an employer's form).
```

---

## 1 — Outcome UI (desktop)

```
OBJECTIVE
AK1 added the (score, outcome) pair — migration 095 plus shared/applicationResponse.js — and nothing
in client/src reads /api/apply/applications. Outcomes are API-only. Without a UI, n stays 0 forever
and the ATS engine can never be validated against reality.

CONTEXT THAT SHAPES THE DESIGN
 • ρ = 0.504. The engine orders coarsely; it does not produce a trustworthy number. Do not build a
   view that implies precision the engine lacks.
 • A rejection COUNTS AS A RESPONSE. An ATS score is a screening score; it has no business
   predicting hiring outcomes. This decision is already encoded in shared/applicationResponse.js —
   read it and follow it, do not re-derive it.
 • NULL is not "no response". MATURITY_DAYS = 30; anything younger is pending, or every early rate
   reads near zero.

REQUIREMENTS
1. A view of submitted applications: company, role, date, resume version sent, ATS score at time of
   application, and current outcome.
2. Let the user RECORD an outcome — responded / rejected / interview / offer / no response. This is
   the ground-truth capture and it is the point of the feature. It must be one interaction, not a
   form.
3. Show pending-vs-mature honestly. An application 3 days old is not "no response".
4. Aggregate ONLY once n supports it. With n < some stated threshold, show the raw list and say
   "not enough applications yet to show a pattern" — never a correlation computed from four rows.
5. Reuse the Database panel's listing idiom and PanelControls primitives. Do not clone.

VERIFY
Record an outcome; confirm it persists and the maturity window behaves. Screenshot the empty state,
the small-n state, and a populated state. Commit & push.
```

---

## 2 — Corruption and defect-pattern sweep (run separately in ALL THREE repos)

**Full prompt: `docs/CORRUPTION_SWEEP.md`.** Self-contained — it carries the six defect shapes with
their precedents, the encoding checklist, and every known finding to start from. Run it three times,
once per repository. For the mobile repos, either copy that file across or point the agent at
`../resume-master/docs/CORRUPTION_SWEEP.md`.

```
KNOWN FINDINGS TO START FROM — these were found incidentally, which is the argument for running the
sweep deliberately:
 • resume-master-android: three literal `r`n sites (app/build.gradle.kts, and TWO in
   gradle/libs.versions.toml which broke the version catalog). Reported repaired — re-verify.
 • resume-master-android: UTF-8 BOM on 55 of 57 text files. Kotlin tolerates it; Gradle's TOML
   parser is the open question (tomllib rejected the file outright). Same root cause as the `r`n:
   PowerShell Set-Content with a single-quoted escape that never expanded.
 • Both mobile READMEs and SYNC.md are written in the present indicative describing unshipped
   behaviour — Shape 6. SYNC.md's status glyphs are mojibake.
 • desktop: docs/MOBILE_STATE.md concludes "no mobile project has ever existed on any branch". True
   of that repo, false of the project — it audited the wrong repo and will keep causing this
   confusion in reverse. Needs a header pointing at the two sibling repos.
 • desktop: extension/manifest.json required utf-8-sig to parse (BOM).

Report per repo. Fix build-breaking corruption immediately, each verified by an actual build.
Everything else in separate commits by shape.
```

---

## 3 — Web client offset paging (desktop)

```
OBJECTIVE
The server now supports keyset cursors (commit 153bb27 era, contract v1.1.0). The WEB CLIENT still
pages by offset and has the same defect on its dislike path: every dislike sets disliked=1, the
default board excludes disliked rows, so the next page silently skips as many jobs as were swiped
away. Measured server-side at 6 of 25 skipped with 3 swipes per page. This is live on the only
shipped client.

READ FIRST
services/jobs/jobCursor.js — one key list generates the ORDER BY, the SELECT projection AND the
resume predicate, deliberately, because written twice they drift and a mismatched cursor does not
error, it returns the wrong rows. Do not reimplement any part of that in the client.
buildParams is the ONE param builder — extend, never fork.

REQUIREMENTS
1. Adopt cursor paging on the board's continuous/scroll path. nextCursor is emitted in BOTH modes,
   so an offset caller can adopt mid-feed.
2. Cursors are valid only for the filter set that produced them. On any filter change, restart
   paging — do not carry a stale cursor.
3. Handle the filter-mismatch rejection error explicitly; it must restart paging, not surface as a
   failure.
4. If the board is a discrete paged list rather than a continuous feed, say so and report whether
   cursors are the right fit — this may be a UI decision rather than a swap.

VERIFY
Load page 1, dislike several rows, load page 2: NO row skipped. Demonstrate the skip still occurs
on the offset path, so the test discriminates rather than passing vacuously. Screenshot.
```

---

## 4 — ATS bands, not numbers (desktop)

```
OBJECTIVE
AK1 measured ρ = 0.504, τ = 0.357, with 31.6% of pairs still mis-ordered. The engine orders coarsely
and is honest about declining, but it CANNOT support a displayed number. "This job is a 43" claims
precision it does not have. Convert every user-facing surface to coarse bands.

⛔ DO NOT re-tune the engine in this task. AK1 measured the obvious fix (renormalising over
informative components) and it made ranking WORSE: ρ 0.448 → 0.242, mis-ordered 33.6% → 41.0%,
floating a Fraud Strategist above a backend engineering role. That result is recorded in code with
its numbers and pinned by a test. Do not undo it.

REQUIREMENTS
1. Bands, not scores: Strong / Moderate / Weak / Not enough signal. The fourth is REQUIRED — the
   scorer now declines rather than fabricating (false-match rate 22.8% → 0.8%) and that must reach
   the user as its own state, never as a low score.
2. Set the thresholds from the REAL distribution. v4's median is 28 and v3's was 45 — do not carry
   over v3-era intuitions. Report the band populations across the live board; a band holding 3% or
   85% of jobs is not a band.
3. Every surface: the ATS report panel, job cards, the review screen, and anything the mobile
   contract exposes. If the numeric score stays in the API, mark it internal in the contract with a
   note that it must not be displayed.
4. The auto-submit gate keeps using the NUMBER (threshold 30, recalibrated from 50 in AK1). Bands
   are a display concern only. Do not couple the gate to a band.
5. BEFORE setting thresholds: the owner should human-grade the same 30 postings AK1 used. Its
   Phase 3 judgements were the agent's own and share a failure mode with the thing they grade, so
   ρ may be flattered. Ask for that pass; do not proceed on self-graded data alone.

VERIFY
Band populations reported across 1291 postings. Every display surface shows a band. "Not enough
signal" renders distinctly from "Weak". Screenshot each.
```

---

## 5 — Cache-window batching (desktop)

```
OBJECTIVE
AK1 located the real token saving and it is not where either of us expected. From a real generation
row, reconciling exactly to the recorded $0.041600: output 51%, cache write 40%, input 8.6%. A
shorter prompt is nearly worthless. The 6704-token prefix is already correctly structured and is
being WRITTEN AND NEVER READ.
Cache-window batching: −37%. With the Batch API: −68%. No scorer change, no prompt change, no new
integrity surface.

REQUIREMENTS
1. Batch generations so the cached prefix is written once and read many times, within the cache
   window. Report the window and how batching respects it.
2. Report measured cost before and after against a real run, not an estimate.
3. Batch API: assess separately. It is asynchronous, so it changes latency and the user-visible
   flow. Report whether the apply pipeline can tolerate that, especially the semi path where a human
   is waiting. Do NOT adopt it unilaterally.
4. usage_events must keep reconciling. All 14 call sites are tracked with guard tests; batching must
   not create an untracked path.
5. Verify pricing LIVE against docs.claude.com rather than from memory — AK1 found a cached table
   claiming a Sonnet 5 price rise that the live docs refuted.

VERIFY
Real generations, before/after cost from usage_events, reconciled. Commit & push.
```

---

## 6 — Android Phase 2a (resume-master-android)

**Full prompt: `resume-master-android/PHASE_2A.md`**, written into that repo so the agent working
there has it locally. Self-contained — it carries the four constraints, the toolchain findings, the
auth credential distinction, every API-layer defect found in the Phase 1 audit, and the deferred
list.

Summary of what it covers, so this index stands alone:

```
ORDER WITHIN THIS TASK, NOT NEGOTIABLE:
  toolchain → auth → contract-typed API layer (including automationTier) → resume persistence.
  NO FEED IN THIS TASK.

TOOLCHAIN
 • gradle.properties hardcodes org.gradle.java.home=C:\Program Files\Android\Android Studio\jbr —
   a path that does not exist on this machine and will break the build for anyone whose Studio is
   elsewhere. Remove it; resolve JDK 17 from the toolchain.
 • compileSdk = 35 with agp 9.0.1. AGP 9 requires compileSdk 36+.
   android.suppressUnsupportedCompileSdk=35 suppresses the warning, not the minimum. Prime suspect
   for the next failure after the syntax fix.
 • The build has NEVER been verified — no JDK, no Android SDK, no Studio on the audit machine. "It
   assembles" is currently unknown, not true.

AUTH — ⛔ USE THE RIGHT CREDENTIAL. This trips people.
  POST /api/auth/login        -> authContext   SESSION-BOUND. DO NOT PERSIST.
  GET  /api/auth/mobile-token -> token         sessionLess, durable. THIS is the credential.
A login-issued token stores session_sid = req.sessionID and is swept by revokeBrowserAuthContexts;
the mobile mint stores NULL and that sweep deliberately never touches it. Persisting the login token
produces intermittent, untraceable sign-outs.
Flow: login → GET /api/auth/mobile-token → persist in EncryptedSharedPreferences (Keystore-backed)
→ Authorization: Bearer thereafter. Idle 7d sliding, absolute 90d.
POST /api/auth/revoke-mobile-token for sign-out.
⛔ BEFORE the first token exists: android:allowBackup="true" with empty backup_rules.xml and
data_extraction_rules.xml means the token is swept into Google cloud backup by default. Write the
excludes FIRST.

API LAYER — from contract/mobile-api.v1.json (v1.1.0), not hand-written
 • The existing hand-rolled JobRepository parser reads snake_case; the server emits camelCase. Five
   fields fail silently to null (salary_min/max/currency, posted_at, contract_type) — salary never
   renders, tags always empty, remote never labelled. Shape 1, confirmed against the generated
   schema. Replace it; do not patch it.
 • matchScore = 0 and logoColor = "#888888" are hardcoded in toUiJob() despite the server providing
   real values.
 • json.getJSONArray("attribution") THROWS on the cache-empty path (that branch omits the key),
   so a successful 200 empty board reports as a network failure. Adzuna's ToS also requires the
   attribution be displayed — swallowing it is a compliance problem.
 • The Job model carries 10 fields against the server's 37.
 • EIGHT contract fields have NO null coalescing server-side, so JSON.stringify DELETES them — they
   arrive ABSENT, not null. A Kotlin decoder throws on a missing key it would accept as null. The
   contract types them optional; honour that.
 • automationTier MUST land in the Job model in THIS change, not after. gated/account/unknown are
   completableOnMobile: false — note UNKNOWN is not completable, which is broader than "gated".
   Filter server-side via tiers_include/tiers_exclude, NEVER client-side: the server pages before
   the client filters, so hiding rows after the fact yields short pages and a count that disagrees
   with the list.
 • Use /api/jobs/interact, NOT PATCH /api/jobs/{id}/starred — the latter TOGGLES, so a retried swipe
   on a flaky phone network undoes itself and returns 200. The contract excludes the toggle routes.
 • Cursor paging (v1.1.0) — build against cursors, not offset. The offset path silently skips rows
   a user has swiped away.
 • APPLY_DAILY_QUEUE_CAP is a typed response field (DailyCap / QueueCap schemas) carrying limit and
   remaining. Render remaining; never swallow it.
 • CHECKSUMS.json hashing is LF-NORMALISED on purpose — the desktop repo runs core.autocrlf=true
   while this repo is CRLF. A raw-byte verify here fails spuriously.

RESUME PERSISTENCE
The builder is in-memory only; process death loses every edit. Invisible while data is mock, real
data loss the moment it is not. Room is declared (runtime, ktx, compiler, KSP) and entirely unused —
zero @Entity anywhere.

ALSO
The dead Button(onClick={}){Text("Apply")} at ui/jobs/JobCard.kt:20 — a tap, not a gesture, and a
literal no-op, so it cannot submit, but the copy is misleading. Resolve it here.
```

---

## 7 — Generation deferral + free ATS at swipe (desktop)

```
⛔ DO NOT START until task 4 lands. The band design determines what the swipe card shows.

OBJECTIVE
Generation currently fires at QUEUE time (~$0.04, Sonnet). Swiping is ~1s per job, so five idle
minutes is ~60 jobs / ~$2.40 from a gesture costing the user no thought. Defer generation to
APPROVAL so a right-swipe is free.

THE PROBLEM THIS MUST SOLVE
A user cannot approve blind. AK1 established the answer: scoreAtsLocally runs with NO model call and
NO generated artifact — server.js:7024 already does exactly this. So the swipe card shows a real fit
BAND computed against the BASE resume, free, and generation happens on approval.

That framing is also more honest than today's: the current score is computed against the GENERATED
resume, so it reflects tailoring the user has not yet decided to pay for. A base-resume band is an
honest floor — tailoring can only improve it.

REQUIREMENTS
1. Move the generation trigger from queue to approve. One queue mechanism, two triggers (web and
   mobile) — do NOT add a second path.
2. The approval screen shows the band, the matched/missing terms, and what WOULD be filled, then
   generates on commit.
3. A per-profile "generate at queue" toggle, default OFF, for the owner's testing phase — real
   output is needed while validating, and this is cheaper than reverting later.
4. APPLY_DAILY_QUEUE_CAP was sized for generate-at-queue. Re-examine: if queueing is free, the cap
   protects nothing and the meaningful limit moves to approvals. Report; do not change unilaterally.
5. Both caps must stay SURFACEABLE — the structured payload carries limit and remaining, and the
   client must render them rather than swallowing an error string.

VERIFY
Queue a job: no model call (assert by counting generator invocations, as AH5 did). Approve it: one
generation. The band renders before approval. Toggle ON restores generate-at-queue. Commit & push.
```

---

## Cross-references

Prompts already written and still valid, referenced rather than duplicated:
- `docs/CORRUPTION_SWEEP.md` — task 2, run in all three repos
- `resume-master-android/PHASE_2A.md` — task 6, lives in that repo
- `resume-master-ios/PHASE_1_AUDIT.md` — task 8, lives in that repo
- `docs/AUTOAPPLY_PROMPTS.md` — A1–A5, the semi campaign and live-run gate
- `docs/GATED_HANDOFF_PROMPTS.md` — G0–G5, all landed
- `docs/EXECUTION_PROMPTS.md` — the pipeline-diagnosis series
- `docs/SWIPE_FEED_DESIGN.md` — updated by the mobile audit; Gate C superseded
- `docs/ak1-ats-ranking.md` — the ρ measurement and the reverted renormalisation, with its numbers
