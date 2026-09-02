# AJ2 — Android Phase 2a: toolchain, auth, contract-typed API layer

Run 2026-09-01. Desktop suite re-derived before and after: **2050 passing, 0 failing** both times.
Android: **32 JVM unit tests, 0 failing** (31 new). Android commits `e35b6f8`, `d8e0611`, `01c1221`.
Desktop commit `8df2f6c`.

Steps 1–3 of `resume-master-android/PHASE_2A.md` are done and verified on a real emulator against
the real local server. **Step 4 (resume persistence) is not started.**

---

## The finding that outranks the rest: `Job.matchScore` is always null

`services/jobs/mapJobRow.js:43` reads:

```js
matchScore: j._matchScore || j.match_score || null,
```

`_matchScore` is assigned **nowhere in this repository**, and `match_score` **is not a column** —
the stored column is `ats_score`. So `GET /api/jobs` emits `matchScore: null` for every row, always.

**Why nobody noticed.** The desktop client never reads it. `JobCard.jsx`, `JobDetailPanel.jsx` and
`JobsPanel.jsx` all read `g?.atsScore ?? job?.baseAtsScore`, and `baseAtsScore` comes from a
different mapper (`server.js:6964`, `j.ats_score ?? null`) on a different endpoint. Two sides,
each self-consistent, joined to nothing — the shape this codebase keeps finding.

**Why it matters now.** AK2 task 4 marked `matchScore` internal in three places and wrote the band
apparatus around it; the contract's description of that one field is the longest in the schema. A
mobile client that implements it exactly as specified renders **"Not enough signal" on 100% of
jobs**. This is not theoretical — the screenshot in this run shows a card whose row has
`ats_score = 43` in the database rendering as "No signal".

**Fix, not applied here:** map `ats_score` into `matchScore` in `mapJobRow`, or add `baseAtsScore`
to the contract. Either is a contract change (regeneration + `CHECKSUMS.json` + the `--check` test),
so it belongs to whoever owns the desktop side, not to a mobile pass reaching across.

---

## Step 1 — the first verified assemble, four failures deep

The build had **never been run**; Phase 1 audited on a machine with no JDK, SDK or Studio. It now
produces a 77.7 MB debug APK, reproducibly from `clean`. Four fixes, three unpredicted:

1. **BOM on `gradle/libs.versions.toml` — confirmed, not merely suspected.** Gradle 9.1.0 agrees
   with `tomllib`: `Unexpected '﻿'` at line 1, column 1, build fails outright. Stripped from
   all **56** tracked text files (the audit's "55 of 57" counted a smaller tree; the real figure is
   56 of 72).
   **A negative finding worth keeping:** the BOM on `.gitignore` line 1 does *not* kill the `*.iml`
   rule. Git strips it itself — `git check-ignore -v` still reports `.gitignore:1:*.iml`.
2. **`compileSdk = 35` under AGP 9**, which requires 36+. Now 37. The
   `android.suppressUnsupportedCompileSdk` flag was **deleted rather than repointed**: it suppressed
   the warning, never the minimum.
3. **KSP vs AGP 9 built-in Kotlin** (unpredicted) — `kotlin.sourceSets` is rejected. AGP's own
   documented migration flag, commented with its exit condition.
4. **iText 9 renamed `setBold()` to `simulateBold()`** (unpredicted). Verified with `javap` against
   the resolved `layout-9.6.0.jar` rather than guessed. Behaviour-preserving: both are synthetic
   bold.

The predicted iText duplicate-resource conflict **did not occur**. `org.gradle.java.home`, hardcoded
to one machine's Studio path, is gone.

---

## Step 2 — auth

**The backup excludes landed first, before any token could exist**, and are verified in the
**compiled binary XML inside the APK** (`aapt2 dump xmltree`), not merely on disk.
`android:allowBackup="true"` plus two untouched Studio templates meant every SharedPreferences file
was swept into Google cloud backup by default.

The two-call exchange is confirmed **in the database**: signing in from the emulator writes one row
with a `session_sid` (the discarded login token) and one with `session_sid NULL` (the credential
stored), and it is the NULL one whose `last_seen_at` advances when the board loads.

**A defect nearly reintroduced:** the login body is `{ username, password }` — passport-local's
default field names, as the contract types it. An `email` field 401s in a way indistinguishable from
a wrong password. That is the same wrong-key-name shape as the snake_case parser, failing loudly
instead of silently.

---

## Step 3 — the API layer

Generated from the contract by `scripts/generateContractModels.py` (with `--check`), 37 fields
against the old parser's 10. `ContractDriftTest` re-verifies the vendored contract against
`CHECKSUMS.json`, LF-normalised as that file instructs, and fails if model and schema disagree.

**`attribution` threw on EVERY response, not just the cache-empty path** as the audit supposed.
Verified against the live endpoint: `/api/jobs` emits no `attribution` key on either branch, so
every successful board load was reported to the user as a network failure.

**A sixth copy of the ATS-percentage defect.** `JobCard.kt` rendered `"${job.matchScore}% match"` —
the desktop fixed five, and this one additionally called the score a *percentage*. `Job.matchScore`
was also non-null, so a decline could only be represented as 0.

### Verified on the device

Five rows seeded, one per tier, scores **on** the cutpoints (`scripts/aj2SeedMobileBoard.mjs`,
`--clean` removes them):

| seeded row | tier | reached the phone |
|---|---|---|
| Block, `$150k–$195k`, remote | guest | **yes** |
| Stripe, `$180k–$240k`, hybrid | direct | **yes** |
| Datadog | gated | no |
| Figma | account | no |
| Physical Superintelligence | null | no |

After both completable cards, the board reads *"No jobs to review / Jobs your phone can complete
will appear here."* Salary, `workplaceType` and `experienceLevel` all render — the fields the old
parser read under snake_case and always got null for.

**Two things the seeding itself taught**, recorded because they read as filter bugs:
the board's `job_role_map` join is an **INNER JOIN**, so an unmapped row is invisible however active
it is (symptom: `total=0` with **no `reason`**); and `profileTitleSql` requires *every* token of a
target title, so profile 5's `["Software Engineer"]` rejects a row titled "Senior Backend Engineer".

---

## Not done, and why

- **Step 4, resume persistence.** Room remains declared and entirely unused; the builder is still
  in-memory and process death still loses every edit. Untouched.
- **`matchScore`** — reported above, deliberately not reached across for.
- **The Android admin panel** decision is still open.

## Environment notes for the next session

Emulator `rm_api36` (API 36, google_apis, x86_64) exists; WHPX works. `cmdline-tools` is installed
at `$ANDROID_HOME/cmdline-tools/latest`, and its `sdkmanager` is a deprecated shim over a new
`android` CLI that takes **slash-separated** package paths, not semicolons.

⚠ Under Git Bash, `adb shell` paths like `/sdcard/ui.xml` are rewritten by MSYS path conversion into
`/Files/Git/sdcard/...`. Export `MSYS_NO_PATHCONV=1` or every `screencap`/`uiautomator dump` fails
with a usage error that looks like a bad flag.
