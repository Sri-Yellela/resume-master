# AK2 — session report

Run from `docs/QUEUED_PROMPTS.md`, 2026-08-30 → 2026-08-31, repository `resume-master`.

| | |
|---|---|
| Test baseline at start | **2033 passing, 0 failing** (re-derived, not taken from the doc) |
| Test baseline at end | **2036 passing, 0 failing** |
| Introduced failures | **0** |
| Net new tests | +3 (2 encoding guards, 1 guard-coverage test) |
| Migrations touched | **none** — high-water stays **095** |
| Commits | 8, all pushed to `main` |
| Repos modified | `resume-master` only |

**The recurring theme of this session: three of the five tasks I picked up were already done or
already correct, and the documents describing them were the stale thing.** Tasks 1 and 3 had landed
in commits the queue listed as pending. Task 5's headline pricing risk was refuted by the live docs
that the repo already agreed with. In each case the standing convention — *re-derive state from the
repo, not from status documents* — is what caught it, and in each case I verified the existing work
rather than rebuilding it.

---

## What was done, per task

### Task 1 — Outcome UI · **already landed, verified not rebuilt**

Found in `10836c1`. The deliverable was not a new screen: there are **two** application endpoints,
and the Database panel's Applications sheet already read the other one (`/api/applications`). It
became two columns — `ATS @ Apply` and `Outcome` — on the sheet that existed, with the outcome cell
posting to the merge endpoint rather than the generic field PATCH. No work needed.

### Task 2 — Corruption and defect-pattern sweep · **desktop DONE, mobile reported**

Four commits. Full findings: **`docs/ak2-corruption-sweep.md`**.

The headline is a defect that reached every user. `RESUME_STYLE_BLOCK` in `server.js` set the resume
bullet to `content: "â€¢"` instead of `"•"`, so **every generated resume PDF rendered a mangled,
text-overlapping glyph**. Nothing caught it: the client's `cleanUiText()` repair layer only cleans
API JSON in the web client, and a PDF never passes through it.

Also repaired: **935 double-encoded sequences**, **18 files broken by one stamped banner in two
different ways** (6 kept a raw cp1252 `0x97` byte and were not valid UTF-8; 12 had already decayed
to a literal `U+FFFD`), and **10 BOMs**.

Deliberately **not** repaired, because their mojibake is the content: `.cinematic/` repair scripts
whose lookup tables are mojibake by design, and `client/src/lib/api.js`, which documents each corrupt
sequence beside the regex that repairs it.

**Part 2 verdicts:** Shape 1 **found** (the resume CSS exists twice — 45 of 46 lines duplicated into
the `FORMATTING_SYSTEM` prompt, which is *how* one corrupt character reached both the renderer and
the model instruction). Shape 2 **clean**. Shape 3 **clean**. Shape 4 **clean and the best-defended
shape in the repo** — every nullable `IN`/`NOT IN` is COALESCE-guarded with the reasoning written at
the site. Shape 5 **found** (below). Shape 6 **found and fixed**.

Mobile was **reported, not fixed** — an explicit decision, taken with the owner. There is no JDK,
Gradle, Android SDK or Xcode on this machine, so the sweep's own instruction ("verified by an actual
build") cannot be met; and both mobile repos held uncommitted work a commit would have swallowed.
That call proved correct: the iOS working tree I had inspected was committed by another session
mid-run as `aad5a3a`. The two highest-severity mobile findings are unverifiable here and wait for
tasks 6 and 8: the BOM on `libs.versions.toml` (which a conforming TOML parser demonstrably rejects,
and which parses cleanly once stripped) and the BOM sitting in front of the mandatory magic comment
in `project.pbxproj`.

### Task 3 — Web client cursor paging · **already landed, re-verified**

Found in `54cae7a`, and thorough: requirement 4 was *answered* rather than assumed — the board is a
**numbered** pager, so a step (Next/Prev) uses a cursor and a jump ("page 17") uses offset, because
a cursor has no notion of position and removing offset would have deleted random page access.

My contribution was verification, not code. The encoding commit had rewritten **714 sequences in
`JobsPanel.jsx`**, and trusting the node suite there is precisely the mistake this project keeps
recording. Re-ran `scripts/aj2BoardCursor.mjs` in real Chrome: **17/17 checks**, including the
discriminating precondition (*offset would skip j25–j28*), and the page-2 screenshot renders clean.

### Task 4 — ATS bands · **measurement half DONE, thresholds blocked**

Full findings: **`docs/ak2-ats-band-distribution.md`**. Grading sheet: **`docs/ak2-ats-grading-set.md`**.

Nothing persists `ats_score` on `scraped_jobs` — all 1291 rows are NULL, because a score is relative
to a resume — so the board was **re-scored** through `server.js`'s actual runtime path.

**A near-miss worth recording.** Two profiles are active. Profile 5 is the
`John Doe fakeemail@gmail.com` placeholder AK1 explicitly set aside; profile 6 is the owner's real
resume. Measuring the wrong one would have failed *quietly* — profile 5 gives median 20 / max 42, and
I would have reported the distribution of an empty CV as the distribution of the engine. Profile 6
gives **median 27, p75 32, p90 39, max 64**, within a point of AK1's independent synthetic profile.

Two findings change the design:

1. **The required fourth band is empty.** "Not enough signal" holds **1 posting in 1291** (0.08%).
   Requirement 1 makes it required and requirement 2 says a band holding 3% is not a band — both are
   right, because it is a *correctness state*, not a population to balance. It stays, but it cannot
   be calibrated from board data, and tuning the other three against it means tuning against one row.
2. **A band is a fixed number and the score is not.** Applying profile 6's p90/p50 cutpoints to
   profile 5 gives 0.2% Strong / 97.6% Weak; the reverse gives 74.9% Strong. The obvious reading
   overstates it (profile 5 is a placeholder, not a second real user) — but the mechanism has a real
   victim: **a new user whose first upload is thin gets an all-Weak board.**

**No thresholds were set**, per requirement 5. `scripts/ak2AtsGradingSet.mjs` draws 30 postings
spanning scores 6–64, shuffled, engine score withheld. AK1 states its 30 were "pinned by
title+company" — they were **never committed**, so its ρ cannot be re-joined against a human pass;
this set is generated by a committed script so it is reproducible.

### Task 5 — Cache-window batching · **non-cost half DONE, build blocked**

Full findings: **`docs/ak2-cache-batching-assessment.md`**.

**Requirement 5 sprung its own trap on the last day it could.** A cached model table dated
2026-06-24 still called Sonnet 5 *"$3.00 ($2.00 intro through 2026-08-31)"*. Today **is**
2026-08-31; from memory I would have reported a 50% price rise landing tomorrow. The live docs say
the increase *"will not occur"* — exactly what `shared/anthropicModels.js` already recorded. **The
repo was right and the cached table was wrong.** No pricing change needed.

The cost model **reconciles exactly** to the recorded `$0.041600` (output 51.1%, cache write 40.3%,
input 8.6%), independently reproducing AK1's split. Two things it stopped short of:

- The prefix is written at 1.25x and read at 0.1x — written every time, read never. The caching is
  a **25% surcharge on the prefix buying nothing**; switching it off is an unconditional **−8.1%
  available today**, no batching required.
- **−37% and −68% are asymptotes.** Ten generations in one 5-minute window is **−33.4%**; two is
  −18.5%.

And "written and never read" is about **arrival rate, not structure**: `resume_generate` has run
**once** in 1367 events. Elsewhere the same mechanism gets 7.25x and 7.98x reads per write on
clustered calls — which is the real evidence the thesis works, and also means the projection rests
on one row.

**The task is aimed at 0.8% of spend.** `enrich_job` is **60.2%** ($3.32 over 1302 calls), uses no
caching, and *cannot*: its entire static content is ~347 tokens against a ~1024-token minimum
cacheable prefix. Its saving must come from the Batch API, where it is ideal — background pass,
`SYSTEM_USER_ID`, no human near it.

**Requirement 3:** not on the apply path. Both CASE B (semi) and CASE C (auto) hold a live browser
open blocking on the resume at the upload step, against a 24-hour batch SLA. But **CASE A** already
exists (current artifact, no model call), so batching wins by making CASE A normal — the same move
task 7 is committed to. **Sequence 5 behind 7.**

---

## Shape 5, twice, and it is the durable finding

Both instances are the same defect: **a guard whose coverage is a property of a pattern, with
nothing checking the pattern.**

1. **Source-slicing tests anchored on the corrupt dividers.** Three tests sliced `server.js` /
   `JobsPanel.jsx` using the mojibake divider comments as anchors. Repairing the dividers moved the
   anchors — and `indexOf` returns `-1` for a missing anchor while `slice` reads `-1` as *"one from
   the end"*, so those tests would **not have failed**. They would have widened the slice and gone on
   passing over the wrong region. All three now assert both ends before slicing. **179 unguarded
   `slice`/`indexOf` pairs remain across the suite** — reported, not swept.
2. **The untracked-call guard could not see the Batch API.** `test/modelCallGuard.test.js` is the
   entire cost-tracking guarantee and scanned for `/\.messages\.create\s*\(/` — which does **not**
   match `messages.batches.create`, because `.messages.create` is not a substring of it. Adding
   batching would have created precisely the untracked-spend defect that guard exists to prevent,
   with the suite green. Fixed, plus a test pinning the scan against four call shapes and four
   near-misses.

The existing mojibake guard was a third, milder instance: it strips comments and names five files,
so it could not see 935 sequences, ten BOMs, or eighteen broken files. The replacement walks the
shipping tree and checks mojibake, BOM and UTF-8 validity, comments included — and **earned its keep
on first run**, immediately finding 12 files with literal `U+FFFD` that my own byte-level scan had
missed.

---

## Files changed, with dependent verdicts

### `1066b0c` — encoding repair (33 files)

| Area | Files | Dependents checked | Verdict |
|---|---|---|---|
| Live output | `server.js` (`RESUME_STYLE_BLOCK`, `FORMATTING_SYSTEM`) | resume HTML → Gotenberg PDF path | ✅ verified by Chrome render |
| Client | `JobsPanel.jsx` (714 seq), `TopBar.jsx`, `AdminPanel.jsx`, `JobCard.jsx`, `IntegrationsPanel.jsx`, `JobProfilesPanel.jsx`, `ProfilePanel.jsx`, `DBInspector.jsx`, `lib/api.js` | Vite build; board render | ✅ `aj2BoardCursor` 17/17 + screenshot |
| Migrations | `scripts/migrations.js` (21 seq) | byte-identity vs `server.js` MIGRATIONS | ✅ parity tests pass; no migration added |
| Services/routes | `browserLauncher`, `integrationReadiness`, `jobClassifier`, `jobNormalization`, `limitEnforcer`, `platformDetector`, `usageTracker`, `routes/admin`, `routes/adminDb`, `routes/domainProfiles` | importers | ✅ suite green |
| Tests re-pinned | `jobsUiTierFilters`, `localAtsScorer`, `resumeFormatter` | the moved anchors | ✅ now assert both ends |
| Guards added | `menuSurfaceStyle.test.js` | whole shipping tree | ✅ +2 tests |
| Docs | `SYNC.md`, `mobile-linkedin-import.md`, `privacy-policy.md`, `privacy/index.html` | — | ✅ BOM only |

### The rest

| Commit | Files | Note |
|---|---|---|
| `54d03dd` | `.gitattributes` (new) | `text=auto`. All 612 tracked text blobs verified LF-only **before** adding it, so it renormalises nothing. Mixed EOLs in 3 files were fixed in the worktree — invisible to git under `autocrlf`, which is *why* the attributes file is the actual fix |
| `2c20400` | `docs/MOBILE_STATE.md`, `documentation.md` | Shape 6. §7 was the stale section; §6/§8 already had a freshness note, so that known-finding was itself stale |
| `d7d49c4` | `docs/ak2-corruption-sweep.md` (new), + tracked the two prompt docs | sweep report |
| `9d7a888` | `docs/QUEUED_PROMPTS.md` | status column added |
| `be94268` | `docs/ak2-ats-band-distribution.md`, `ak2-ats-grading-set.md`, `ak2-ats-grading-key.json`, `scripts/ak2AtsGradingSet.mjs`, `scripts/verifyHarnesses.mjs` | generator excluded from `verify:harness` with a stated reason, per that runner's convention; it works on a **copy** of the database so the real one is untouched |
| `761840f` | `docs/ak2-cache-batching-assessment.md`, `shared/anthropicModels.js`, `test/modelCallGuard.test.js` | guard widened + coverage test; 1h cache price flagged, **not** guessed |

---

## Verification — real runs, not simulated

| Claim | How it was verified |
|---|---|
| The resume bullet was corrupt and is now correct | Extracted the real `RESUME_STYLE_BLOCK` from `server.js`, rendered in Chrome, read computed `::before` against a **same-origin control**: repaired `"•"`, corrupt `"â€¢"` (and visibly overlapping the text) |
| The board still pages by cursor after 714 edits | `scripts/aj2BoardCursor.mjs`, real Chrome, **17/17**, discriminating precondition asserted first, screenshot |
| BOM breaks the Gradle version catalog | `tomllib` **rejects** `libs.versions.toml` with the BOM and **parses it cleanly** without — demonstrated, not argued |
| `Info.plist` BOM is benign | `plistlib` parses it with *and* without |
| The v4 distribution | All 1291 postings re-scored through the real runtime path; corroborated against AK1's independent profile |
| Sonnet 5 pricing | Live fetch of `platform.claude.com/.../pricing` |
| The credit blocker | `usage_events` rows carrying the provider's own error text |
| The guard misses batch calls | Executed the regex against all four call shapes |

**Not verified, and stated as such:** every mobile fix (no toolchain), and requirement 2 of task 5
(no credit since 2026-08-25).

---

## What remains, and who it needs

| | Needs | First step |
|---|---|---|
| **Task 4** | **the owner** | Grade `docs/ak2-ats-grading-set.md`, 1–5. Do not read the key first |
| **Task 5** | API credit, and task 7 first | Take the **−8.1%** now by removing the unread breakpoints; batch `enrich_job` |
| **Task 6 / 8** | a JDK + Android SDK / a Mac | Strip the BOM from `libs.versions.toml` and `project.pbxproj` — the two findings most likely breaking a build right now |
| **Task 7** | nothing | Unblocked once task 4's bands are set |

**Carried forward, not done:** the 179 unguarded `slice`/`indexOf` pairs (a guarded-slice helper
asserted at both ends closes the class); the duplicated resume CSS (Shape 1 — interpolate
`RESUME_STYLE_BLOCK` into `FORMATTING_SYSTEM`, but only alongside work that can run a real
generation, since editing a prompt is a behaviour change); `gradle.properties`' hardcoded
`org.gradle.java.home`, which belongs to task 6.
