# AK2 — Corruption and Defect-Pattern Sweep

Run 2026-08-30 against `docs/CORRUPTION_SWEEP.md`, in all three repositories.
Desktop test baseline re-derived before touching anything: **2033 passing, 0 failing**.
After the work in this sweep: **2035 passing, 0 failing** (baseline + 2 guards added here).
Introduced failures: **0**.

> **Scope honesty.** Only `resume-master` was fixed. There is no JDK, Gradle, Android SDK or Android
> Studio on this machine, and Xcode cannot run on Windows at all, so the sweep's own instruction —
> "fix build-breaking corruption immediately, each verified by an actual build" — is not satisfiable
> for the mobile repos here. Both also have substantial uncommitted work in progress (iOS: 918
> insertions and two deleted files), so committing there would have swept that in. The mobile
> findings below are reported for tasks 6 and 8, which own those repos and can build them.

---

## The headline: one corrupt character shipped in every generated resume

`RESUME_STYLE_BLOCK` in `server.js` set the resume bullet to a three-character mojibake sequence
instead of `•`:

```css
ul.bullets li::before { content: "â€¢"; position: absolute; left: -0.85em; }
```

That style block is injected into every generated resume and rendered to PDF, so every bullet in
every resume the product has produced carried the mangled glyph.

**Verified by real render, not by inspection.** The actual style block was extracted from `server.js`,
loaded into Chrome, and the computed `::before` content read back, against a same-origin control
holding the corrupt rule:

| | computed `::before` |
|---|---|
| repaired (current `server.js`) | `"•"` |
| corrupt (what shipped) | `"â€¢"` |

In the screenshot the corrupt bullets also overlap their text, because the glyph is three characters
wide in a box positioned for one.

**Why nothing caught it.** `client/src/lib/api.js` has a `cleanUiText()` layer that repairs mojibake
at runtime — but it only cleans API JSON in the web client. A generated PDF never passes through it.
The existing mojibake test strips comments and names five files; this was in neither.

---

## PART 1 — Encoding corruption

### Desktop — fixed in `1066b0c`

| Finding | Location | Evidence | Severity | Status |
|---|---|---|---|---|
| Mojibake bullet in live resume CSS | `server.js` `RESUME_STYLE_BLOCK` | render check above | **High — user-visible in every resume** | Fixed |
| 935 double-encoded sequences | `server.js` (199), `JobsPanel.jsx` (714), `migrations.js` (21), `api.js` (1) | cp1252→UTF-8 inversion is clean for every run | Medium | Fixed |
| 6 files **not valid UTF-8** | `services/jobNormalization.js`, `services/limitEnforcer.js`, 4 test files | raw cp1252 byte `0x97` in a line-1 banner | Medium | Fixed |
| 12 files with a literal `U+FFFD` | `TopBar.jsx`, `AdminPanel.jsx`, `routes/admin.js`, +9 | same banner, em dash already destroyed | Medium | Fixed |
| **+11 more, under `test/`** | found 2026-08-31 by the anchor sweep | same banner — **missed here** because this sweep's guard excludes `test/` | Medium | ✅ Fixed later |
| UTF-8 BOM | 10 files incl. `server.js`, `JobsPanel.jsx`, `docs/privacy/index.html` | — | Low | Fixed |
| Mixed line endings | `enrichLogos.js`, `schema.js`, `companyLogos.js` | CRLF+LF in one file | Low | See below |
| Literal PowerShell escapes | — | none outside the sweep docs themselves | — | **Clean** |

**The banner is one root cause with two outcomes.** **29 files** carry
`// SCRAPING — SCHEDULED FOR REMOVAL AFTER MIGRATION`. Six kept the raw `0x97` byte and were
therefore not valid UTF-8; **23** had already been flattened to `U+FFFD`. Node substitutes rather
than throwing, so neither form ever surfaced. A third group has a plain `--` and is fine.

> **Corrected 2026-08-31.** This originally read "eighteen files … twelve", and 11 more were found
> later, all under `test/`. The guard added by this sweep **excludes `test/`** — because the mojibake
> guards in `menuSurfaceStyle.test.js` hold those characters on purpose — and excluding a whole
> directory to protect two lines in one file left 11 real defects sitting in it. Repaired in the
> anchor sweep (`docs/ak2-source-anchor-sweep.md`); narrowing the exclusion from the directory to
> those two lines is still open.

**`JobsPanel.jsx` needed separate handling.** It was mojibaked and *then* run through a smart-quote
flattener, so the middle byte survives as a straight quote and the generic inversion cannot recover
it. Exactly three such sequences exist in the repo; they were enumerated exhaustively and replaced
literally rather than by a guessed rule.

**Deliberately not repaired.** `.cinematic/` holds historical repair scripts whose lookup tables are
mojibake by design, and `api.js` documents each corrupt sequence beside the regex that repairs it.
Rewriting either would have destroyed the mapping it exists to express. `extension/manifest.json`,
previously reported as needing `utf-8-sig`, is **already clean** — re-verified, not assumed.

### Line endings — fixed in `54d03dd`

The three mixed-EOL files are now internally consistent, but that is not what the commit is. With
`core.autocrlf=true` and no `.gitattributes`, an EOL-only edit produces **no git diff at all**, so
the mixture could never have been committed away. The real defect is that the LF guarantee was never
written down: all 612 tracked text blobs are LF-only in the index, but only because every clone so
far happened to have `autocrlf=true`. A `.gitattributes` with `text=auto` moves the guarantee into
the repository. Storage is already LF, so it renormalises nothing — checked before adding.

### Android — reported, not fixed

| Finding | Evidence | Severity |
|---|---|---|
| **BOM makes `libs.versions.toml` unparseable** | `tomllib` **rejects** the file with the BOM and **parses it cleanly** without — demonstrated, not argued | **High, unverified against Gradle** |
| BOM on 55 of 57 text files | incl. all three `.gradle.kts`, `gradle-wrapper.properties` | Medium |
| `SYNC.md` is not valid UTF-8 | single `0x97` byte at offset 2277 | Low |
| Kotlin source is effectively minified | `JobCard.kt` is 21 lines; line 20 is **2118 characters** and holds the entire composable. 29 files affected. | Medium — maintainability |
| The `` `r`n `` repairs | **held** — `itext-core` and `androidx-browser` both resolve their `version.ref` correctly | Re-verified |

Whether Gradle's own TOML parser (`tomlj`) tolerates a BOM is the open question the sweep raised and
**it remains open** — it cannot be answered without a JDK. That is precisely why the recommendation
is to strip the BOM rather than resolve the argument: stripping is safe under every parser and makes
the question moot.

`gradle.properties` still hardcodes `org.gradle.java.home` to an Android Studio path that does not
exist on this machine. Reported here, but the fix belongs to task 6, which owns it and can build.

### iOS — reported, not fixed

| Finding | Evidence | Severity |
|---|---|---|
| **BOM on `project.pbxproj`** | the BOM sits *before* the mandatory `// !$*UTF8*$!` magic comment | **High, unverifiable here** |
| BOM on `Info.plist` | `plistlib` parses it with **and** without the BOM | Low — XML parsers skip it |
| BOM on 34 text files | — | Medium |
| `SYNC.md` is not valid UTF-8 | byte-identical to Android's, same `0x97` at offset 2277 | Low |
| Swift source is effectively minified | `JobCardView.swift` is 7 lines, four of them 400–845 chars | Medium — maintainability |

The `pbxproj` BOM is the one I would fix first and cannot test: Xcode requires that magic comment as
the first bytes of the file, and no Xcode exists on Windows to confirm whether it tolerates a BOM in
front of it.

**Correction to the sweep's own notes:** `SYNC.md`'s status glyphs are *not* mojibake. Both copies
contain exactly **one** non-ASCII byte in the whole file. The glyphs are plain ASCII.

---

## PART 2 — The recurring defect signature

### Shape 1 — two sides of a contract that don't meet · **FOUND**

| Location | Evidence | Severity | Proposed fix |
|---|---|---|---|
| `server.js` `RESUME_STYLE_BLOCK` vs `FORMATTING_SYSTEM` | **45 of 46 lines** of the style block appear verbatim inside the formatter prompt. Only `</style>` differs. | Medium | Interpolate `${RESUME_STYLE_BLOCK}` into the prompt so one definition feeds both |

This is not hypothetical drift — it is the mechanism of the headline bug. The mojibake bullet was in
**both** copies, which is how one corrupt character reached both the renderer and the instruction
telling the model what to emit. They were repaired together here, but nothing enforces that next
time: fixing one copy alone would leave the model instructed to emit CSS the renderer does not use.

**Not fixed in this sweep, deliberately.** Editing `FORMATTING_SYSTEM` changes a model prompt, and a
prompt change is a behaviour change that the evidence rule says must be shown by a real generation.
The Anthropic key is out of credit, so no real generation can be run. Reporting it beats changing a
prompt I cannot verify.

### Shape 2 — a handler wired to nothing · **CLEAN**

Searched `client/src` for no-op callback props by shape and by identifier. The only hits are the
comment in `JobBoardContext.jsx` recording the historical `onSearch={() => {}}` fix. No live no-op
handler props.

### Shape 3 — silence reported as success · **CLEAN, with one note**

Every "complete"/"synced" log now carries counts, which is the mitigation for the original defect
(`"sync complete — 0 jobs cached"` from a provider that never ran). The suite also pins
`unconfigured is completely inert`. One fully-empty catch exists,
`services/applyAutomation.js:1739` — `try { window[bindingName](json); } catch (e) {}` — inside
injected in-page code, where the callback may legitimately be gone. Low severity, noted not filed.

### Shape 4 — NULL-hostile predicates · **CLEAN, and well defended**

Every `IN`/`NOT IN` over a nullable column is guarded, and the reasoning is written down at the site:

- `automation_tier` — `COALESCE(sj.automation_tier, 'unknown')` in **both** directions, with a long
  comment explaining why the coalesce is right here and the `IS NULL OR` escape is right elsewhere.
- `sj.source`, `sj.company` — schema says `NOT NULL`, so no hazard; the comment says so explicitly.
- `apply_run_jobs.status` — `TEXT NOT NULL DEFAULT 'queued'`.

This is the shape that took the board to zero four times, and it is now the best-defended one.

### Shape 5 — a test that pins a defect · **FOUND, partly fixed**

| Location | Evidence | Severity | Status |
|---|---|---|---|
| `jobsUiTierFilters`, `localAtsScorer`, `resumeFormatter` | sliced source using the **corrupt divider comments** as anchors | High | Fixed in `1066b0c` |
| ~~179 unguarded `slice`/`indexOf` pairs across the suite~~ | same latent failure mode | Medium | ✅ **SWEPT 2026-08-31** — see below |

This is the finding I would act on next. `indexOf` returns `-1` for a missing anchor and `slice`
reads `-1` as *"one from the end"* — so a moved anchor does not fail the test, it **widens the
slice** and the assertions go on passing over the wrong region. The three mojibake-anchored tests
would have silently degraded the moment the dividers were repaired. They now assert both ends before
slicing; the other 179 sites do not.

The existing mojibake guard is itself a mild instance: it strips comments and names five files, so
it could not see 935 sequences, ten BOMs, or eighteen broken files. The new guard walks the shipping
tree and checks mojibake, BOM and UTF-8 validity, comments included.

### Shape 6 — a claim with no code · **FOUND, fixed in `2c20400`**

| Location | Evidence | Status |
|---|---|---|
| `docs/MOBILE_STATE.md` | concluded "no mobile project has ever existed in any commit, on any branch" — true of this repo, false of the project | Scope-correction header added, naming both sibling repos |
| `documentation.md` §7 | describes sourcing as "Apify LinkedIn scraper + Apify Indeed scraper"; sourcing now runs through `services/jobs/aggregator.js` over Adzuna | Added to the freshness note |
| mobile READMEs / `SYNC.md` | present-indicative descriptions of unshipped behaviour | Reported — belongs to tasks 6 and 8 |

**A correction to the sweep's own known-findings list:** it says `documentation.md` §6 and §8 need a
freshness note. They already have one, naming both. That known finding is stale, and re-adding it
would have produced a second, contradictory note. §7 was the section actually missing.

---

## What was fixed, and where

| Commit | Contents |
|---|---|
| `1066b0c` | Encoding repair — 935 sequences, 18 broken files, 10 BOMs, the resume bullet, 3 Shape 5 test re-pins, 2 new guards |
| `54d03dd` | `.gitattributes` — LF normalisation as a repository guarantee |
| `2c20400` | Shape 6 doc corrections |

## Recommended next

1. **Strip the BOM from `libs.versions.toml` and `project.pbxproj`** during tasks 6 and 8, where a
   real build can confirm it. These are the two findings most likely to be breaking a build right
   now, and the two I could not test.
2. ~~Sweep the 179 unguarded `slice`/`indexOf` pairs.~~ **Done 2026-08-31** —
   `docs/ak2-source-anchor-sweep.md`. The real count was 284 lookups across 182 slice sites in 59
   files; all now go through `at()`/`lastAt()`, which throw on a missing anchor, and a guard test
   holds it at zero. **Three anchors were already dead, in tests that were passing**, over-slicing
   by 4.0x, 4.2x and 4.8x.
3. **Give the resume CSS one definition** rather than two, alongside work that can run a real
   generation.
