# Corruption and Defect-Pattern Sweep

Run this SEPARATELY in each of the three repositories:
`resume-master` · `resume-master-android` · `resume-master-ios`

Report everything found before fixing anything, then fix in separate commits by category.
Re-derive the test baseline first if the repo has one; introduced failures must be 0.

---

## Why this exists

A literal PowerShell escape was found written into `resume-master-android/app/build.gradle.kts`:

```
implementation(libs.itext.core)`r`n    implementation(libs.androidx.browser)
```

The two-character sequence `` `r`n `` was emitted literally instead of a newline, breaking the
Gradle build. Files were generated or patched by a PowerShell script, so the same corruption may
exist elsewhere — in this repo and its siblings.

Separately, this project has an unusually consistent DEFECT SIGNATURE, established across many
sessions of real production bugs. Sweep for both.

---

## PART 1 — Literal escape / encoding corruption

Grep the whole repo (excluding `node_modules`, `build`, `.git`, `dist`) for:

1. **Literal PowerShell escapes**: `` `r`n `` `` `n `` `` `t `` `` `0 `` `` `e `` — backtick followed
   by a single letter. Also the doubled form ` ``r``n ` from nested quoting.
2. **Literal C-style escapes in non-string contexts**: `\r\n` `\n` `\t` appearing as literal text
   where a real newline belongs.
3. **BOM corruption.** Several files already carry a UTF-8 BOM (`extension/manifest.json` needed
   `utf-8-sig` to parse; both mobile READMEs start with one). Report every file with a BOM and
   whether its parser tolerates it — a BOM in a `.json`, `.kts`, `.gradle`, `.yml`, `.toml` or
   `.plist` is a real hazard.
4. **Mojibake from double-encoding**: `â€”` `â€™` `Â ` `ðŸ` and similar. Known present in this
   project's migration comments and in `SYNC.md`'s status glyphs. Report location and whether it
   reaches a user-visible surface.
5. **Mixed line endings within a single file** (CRLF and LF interleaved). This has already caused a
   silent no-op edit here: a revert regex assumed `\n` against a CRLF file, and a test briefly
   looked verified when it was not.
6. **Lines implausibly long for their file type** — a strong signal that a newline was lost.

For each hit: file, line, the literal sequence, and whether it breaks a build/parse or is cosmetic.
**Fix the build-breaking ones first, each verified by an actual build, not by inspection.**

### Known findings to start from

These were found incidentally, which is the argument for sweeping deliberately.

- **android**: three literal `` `r`n `` sites — `app/build.gradle.kts`, and TWO in
  `gradle/libs.versions.toml` which broke the version catalog (`libs.androidx.browser` unresolvable,
  `libs.itext.core` with a corrupt version ref). Reported repaired — **re-verify**.
- **android**: UTF-8 BOM on 55 of 57 text files including `libs.versions.toml`, all three
  `.gradle.kts`, and `gradle-wrapper.properties`. Kotlin tolerates BOM; Gradle's TOML parser is the
  open question — `tomllib` rejected the file outright. `JobRepository.kt` is one of the two files
  with no BOM, and it is also the newest, which corroborates the PowerShell origin.
- **android**: `gradle.properties` hardcodes
  `org.gradle.java.home=C:\Program Files\Android\Android Studio\jbr` — a path that will not exist
  for anyone whose Studio is elsewhere.
- **android**: `LinkedInAuthManager.kt:27` points at `https://YOUR_DOMAIN.com`; `AndroidManifest.xml`
  carries the same placeholder as its `autoVerify` deep-link host, so App Links verification fails.
  Meanwhile `JobRepository:79` uses `https://resumemaster.one`. Two base URLs, one fake.
- **desktop**: `extension/manifest.json` required `utf-8-sig` to parse.

---

## PART 2 — The project's recurring defect signature

Every significant bug found in this project has been ONE OF SIX SHAPES. All were silent; none threw.
Sweep for each and report instances with evidence.

### Shape 1 — Two sides of a contract that don't meet

Precedents: `mapJobRow`'s whitelist vs the client mapper · the popup and the hotkey writing to two
different tables · three hardcoded tab lists · half-migrated model IDs (Haiku updated in 8 places,
Sonnet left dead in 7) · `tool` sent vs `toolType` read · mode `"manual"` coerced to `"auto"`, so a
user asking to review got a real auto-submission · select values `'mid level'` vs DB `'mid'` ·
the Android parser reading snake_case against a camelCase server.

**Look for:** any value list, enum, route table, field name or option set existing in more than one
place. Each duplicate is a future divergence. Report every one; propose a single source per pair.

### Shape 2 — A handler wired to nothing, or to the wrong thing

Precedents: `UnifiedSearchBar` handed `onSearch={() => {}}` so every bar control was dead ·
`onResolve={resumable ? () => openHandoff(...) : openReview}` where the fallback arm was unscoped
and leaked every user's applications.

**Look for:** no-op callbacks (`{}` or `() => {}`) passed as props · zero-argument handlers still
nameable after a scoped variant was introduced · handlers reached only through a ternary's fallback
arm. **A pattern-based grep MISSES these — search by IDENTIFIER REFERENCE, not by call-site shape.**
That is exactly how the last one survived a fix that rewrote every matching call site.

### Shape 3 — Silence reported as success

Precedents: an unconfigured provider logging `"sync complete — 0 jobs cached"` for months ·
enrichment stamping rows complete while writing nothing, then never retrying them · discovery
finding zero fields and reporting a clean `autofill done` · a session endpoint returning before the
actual logout ran, leaving a 7-day cookie alive · a truncated packet list read as `batch_empty`,
stopping a run that still had work.

**Look for:** catch blocks that log and continue · early returns on a misconfiguration that report
the same shape as success · success paths that don't verify the write happened · any "complete"
message emitted without confirming work occurred · a cap or truncation that cannot be distinguished
from an empty result.

### Shape 4 — NULL-hostile predicates over optional data

Precedents: `col IN (...)` and `col LIKE ?` silently dropped every NULL row and took a production
board to zero — three separate times, on three columns. Then a fourth: SQLite `=` in a cursor chain
yields NULL when either side is NULL, so a row with no `posted_at` made the feed stop dead partway
down and report the end of the board in the middle of it.

**Look for:** `IN` / `NOT IN` / `LIKE` / `=` / comparison against any nullable column, in SQL or in
code. In SQL, `NULL IN (...)` is NULL, not false — and `NOT IN` drops NULLs identically. Report both
directions.

### Shape 5 — A test that pins a defect or asserts the wrong thing

Precedents: a test asserting a broken ternary verbatim, so fixing it would have failed CI · a
negative assertion on a literal string that was true only the moment it was written · a cost test
using the DB column name where the API field name was required, so the fixture validated its own
error · a test asserting a UI control that never existed.

**Look for:** assertions matching implementation strings rather than behaviour · negative assertions
on literals · fixtures whose field names differ from the real payload's. For each, state what
behaviour it MEANT to protect and re-pin it there.

### Shape 6 — A claim with no code, or code with no claim

Precedents: a store listing declaring "PII not collected" for a build that types a postal address
into an employer's form · docs describing a fill that no longer happens where they say · a README
describing shipped mobile features for code that never existed · a privacy policy naming a processor
that receives nothing.

**Look for:** README/docs statements with no implementing code, and behaviour with no documentation.

**Known, in this class:**
- Both mobile READMEs and `SYNC.md` are written in the present indicative describing unshipped
  behaviour. `SYNC.md`'s Feature Registry marks Android columns for auth, application tracking and
  auto-apply queue — none of which exist.
- android README: "full admin panel" = 6 screens of MockData; "Velocity-sensitive card stack" is
  false — `resolve()` reads displacement, never velocity, and `MIN_VELOCITY = 800f` is declared and
  never referenced.
- desktop: `docs/MOBILE_STATE.md` concludes "no mobile project has ever existed in any commit, on
  any branch." True of that repo, false of the project — it audited the wrong repo and will keep
  generating this confusion in reverse. Needs a header pointing at the two sibling repos.
- desktop: `documentation.md` §6 and §8 predate `applyAutomation.js` and describe a fill that no
  longer happens where they say. A freshness note names which sections are current.

---

## Output

One table per shape: location · evidence · severity · proposed fix.

Fix build-breaking corruption immediately. Everything else in separate commits by shape, so a
regression can be attributed.
