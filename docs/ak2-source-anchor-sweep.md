# AK2 — the source-anchor sweep (Shape 5)

Run 2026-08-31. Baseline re-derived first: **2036 passing, 0 failing**. After: **2038 passing, 0
failing**. Introduced failures: **0**.

This closes the finding carried forward from the corruption sweep.

---

## The defect

Most of this suite asserts against a **region** of a source file, carved out with `indexOf`:

```js
const fn = src.slice(src.indexOf("function buildRuntimeInputs"), src.indexOf("// PDF generation"));
assert.match(fn, /something/);
```

When an anchor moves, `indexOf` returns **-1**. It does not throw — and `slice` does not treat -1 as
an error either. It reads a negative index as an offset from the **end** of the string:

| what happens | result |
|---|---|
| `slice(-1, 5000)` | starts at the **last character**, yields `""` |
| `slice(1200, -1)` | runs to one character from the end of the **whole file** |

The second is the dangerous one. The region becomes far too wide rather than empty, and a `match`
assertion over a region four times too large usually still finds its string — so **the test keeps
passing while it has stopped being about the thing it is named after**. A wider slice only fails if
it happens to contain a counter-example.

---

## What the sweep found

**284 lookups across 59 test files**, rewritten to `at()` / `lastAt()` from
`test-support/sourceAnchors.js`, which throw and name the missing anchor.

**Three anchors were already dead. All three were in tests that were passing.**

| test | dead anchor | why | region |
|---|---|---|---|
| `summaryOptIn` | `"async function generateResumeForApply"` | the function is **not** async — it is `function generateResumeForApply(userId, jobId, toolType)` | 63,521 chars instead of 15,948 — **4.0x** |
| `authRouteBootstrap` | `"{/* Root and catch-all"` | that comment was split in two; the root route now reads `{/* Root: landing page for logged-out` | 1,066 instead of 223 — **4.8x** |
| `appScrollProgressRemoved` | `indexOf("Left group") >= 0` | a guard that could **never** be true: the file's own `code()` helper strips JSX comments before the search, and `"Left group"` exists only inside one — so the ternary always took its fallback and sliced to EOF | 2,571 instead of 608 — **4.2x** |

The third is the most instructive: not a `-1` reaching `slice`, but a **dead ternary branch**. The
end anchor was reachable the whole time; the guard in front of it was simply unsatisfiable. The
`summaryOptIn` case has the same flavour of near-miss — it carries
`assert.ok(body.length > 500, "coreGenerateResume was not located")`, which looks like it guards the
slice and does not: it only catches a region that came out too **small**, which is the failure that
does not happen here.

None of the three failed before this sweep. They were repaired only because a missing anchor was
made to throw.

---

## What was changed

| | |
|---|---|
| `test-support/sourceAnchors.js` | **new.** `at()` and `lastAt()` — drop-in replacements for `indexOf`/`lastIndexOf` that throw, naming the anchor, instead of returning -1 |
| 59 files under `test/` | 284 call sites rewritten; helper imported |
| `test/summaryOptIn.test.js`, `test/authRouteBootstrap.test.js`, `test/appScrollProgressRemoved.test.js` | the three dead anchors repaired, each with the measured over-slice recorded beside it |
| `test/sourceAnchorGuard.test.js` | **new.** Fails the build on any new bare `indexOf` feeding a `slice` |

### Why `test-support/` and not `test/helpers/`

`node --test` with no arguments discovers `**/test/**/*.js` — **every** `.js` file under `test/`, not
just `*.test.js`. Verified rather than assumed: a file that throws at
`test/helpers/probe.js` fails the run; the identical file at `test-support/probe.js` does not.
A helper under `test/` would be loaded and executed as though it were a test.

### The guard is pinned against its own coverage

The new guard is a source scan, so its coverage is a property of its own regex — which is exactly
what let the Batch API slip past `modelCallGuard` (see
`docs/ak2-cache-batching-assessment.md`). So it ships with a second test asserting it catches all six
call shapes (two anchors, one anchor, a from-index, `lastIndexOf`, a dotted receiver, a nested
lookup) and ignores four near-misses, including already-repaired `at()` sites.

The guard was also verified to **fail** on an injected violation and pass again once removed — a
guard that has never been seen to fail is not evidence of anything.

**Known limitation, stated rather than hidden:** the scan matches an identifier or dotted-chain
receiver (`src`, `a.b`). A `slice` whose receiver is a string literal or a call expression is not
matched. Every one of the 284 real sites had an identifier receiver, so this costs nothing today,
but it is where the guard would need widening if that changes.

---

## Incidental finding: eleven more corrupt files the encoding sweep missed

While rewriting, a literal `U+FFFD` turned up on line 1 of `test/localAtsScorer.test.js`. Checking
the bytes against `HEAD` showed it was **pre-existing**, not introduced here — and a proper scan
found **11 files under `test/`** carrying the same corrupt
`// SCRAPING <U+FFFD> SCHEDULED FOR REMOVAL AFTER MIGRATION` banner.

The corruption sweep missed them for a stated reason that turns out to be too broad: its guard
**excludes `test/`**, because the mojibake guards in `menuSurfaceStyle.test.js` hold those characters
on purpose. Excluding the whole directory to protect two lines in one file left 11 real defects in
place. All 11 are repaired here.

That raises the banner's total blast radius from 18 files to **29**, in three variants: 6 kept the
raw cp1252 `0x97` byte (not valid UTF-8), **23** decayed to a literal `U+FFFD`, and a third group
has a plain `--` and is fine.

**Not fixed here:** the `test/` exclusion itself. Narrowing it from "the whole directory" to "the two
guard lines that legitimately contain these characters" is the right repair and belongs with the
encoding guard, not with this sweep.

---

## What this leaves

The 179-pair item from `docs/ak2-corruption-sweep.md` is **closed** — the real count was 284
lookups across 182 slice sites, and it is now zero, with a guard holding it there.

The sibling instance of the same shape is also closed: `modelCallGuard`'s scan could not see
`messages.batches.create`, fixed in `761840f`.
