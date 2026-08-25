# AI2 — automated Chrome Web Store listing screenshots

```
npm run store:screenshots
```

Three files, written to `docs/store-screenshots/`, each **1280×800, 8-bit, PNG colour type 2
(24-bit truecolour, no alpha channel)** — asserted on the encoded bytes and again on the file after
it lands.

| file | dimensions | colour type | bits | bytes |
|---|---|---|---|---|
| `docs/store-screenshots/1-review-overlay.png` | 1280×800 | 2 (truecolour, no alpha) | 24 | 47,052 |
| `docs/store-screenshots/2-popup.png` | 1280×800 | 2 (truecolour, no alpha) | 24 | 30,177 |
| `docs/store-screenshots/3-options.png` | 1280×800 | 2 (truecolour, no alpha) | 24 | 31,109 |

---

## Extended, not duplicated (constraint: read first)

`scripts/g3ReviewOverlay.mjs` — the AF4 harness that already drove a real Chrome with the real
extension installed — takes the shots. It gained `--screenshots` behaviour, not a sibling script.

The reason that harness was chosen originally still holds and is stronger now: **a screenshot taken
at this point in this run cannot be of an overlay that renders and does not work**, because the run
is only green if the eligibility ordering, the acknowledge gate, the edit persistence, the inversion
trap and "nothing reached the ATS" all passed on the very page being photographed.

Without `--screenshots` the harness is unchanged and still runs in `verify:harness` (19/19).

## The alpha channel

Chrome writes RGBA. The store dashboard rejects an alpha channel on a screenshot — and rejects it by
hand, at submission, which is the worst place to find out. There is no image library in this
project's dependencies and adding one to drop a channel is not worth the supply chain, so
`services/pngTruecolor.js` decodes, composites any non-opaque pixel over white, and re-encodes as
colour type 2. Node's `zlib` does the work; the module handles 8-bit non-interlaced colour type 2
and 6, which is every PNG Chrome produces.

Flattened rather than truncated: a partially transparent pixel's RGB means nothing on its own, and
discarding its alpha would show whatever sat underneath. In practice every pixel is opaque — all
three shots report **0 non-opaque source pixels** — but "in practice" is not an assertion, so the
count is measured and printed.

## The three shots

### 1. `1-review-overlay.png` — the most important one

The review overlay over a real form, before anything is acknowledged. It shows:

- real filled fields — Ada, Lovelace, `ada@example.com`, `+1 555 0100`, Analytical Engines
- the provenance cues — `eligibility` badges on the two attestation answers, `guessed field` on the
  label-only match, and an `acknowledge` control on it
- the central claim of the listing copy, in the extension's own words: *"Resume Master never submits
  for you"*, *"Not ready — 1 guess(es) still to acknowledge"*, *"Submit the form yourself when you
  are happy with it"*

### 2. `2-popup.png` — the popup over a posting

**This is a composite of two real captures, and that is stated here rather than glossed.** A browser
cannot screenshot its own toolbar popup together with the page beneath it: the popup is a separate
top-level surface and a page capture does not contain it. So the pairing is not obtainable in one
shot by any means.

Both halves are genuine. The popup is rendered by the extension from its own `popup.html`, having
actually resolved the posting as the active tab — asserted, because the popup only reads "Capture
job" in that state, and the run dies if it reads anything else. The page behind is the fixture
posting as served. Nothing is drawn, mocked or retouched; two true captures are placed in the
spatial relationship a user sees, with a hairline border and a flat shadow so the popup reads as a
separate surface.

This closes AF4's cosmetic limits 1 and 2. It also fixed a real sizing bug: measuring the popup's
width while its tab was still 1280 wide reported 1280 (the body stretches to the viewport), so the
first attempt photographed the popup at Chrome's 800px clamp — four times its real width, covering
the posting. It is measured at a small viewport now and comes out at its declared 260px.

### 3. `3-options.png` — both keyboard shortcuts

`Ctrl+Shift+K` (capture) and `Ctrl+Shift+Y` (fill), sourced from `chrome.commands.getAll()` in
`extension/options.js` — there is no second inventory to drift from. Asserted three ways before the
shot is taken: both rows present, both showing a real key rather than `Not set`, and the page
genuinely reading from `chrome.commands.getAll()`.

`Not set` is what Chrome renders when it declines a default binding (usually another extension
claimed the combination). It is a true rendering of a real state and a bad listing image, so it
**fails the run** rather than shipping.

---

## Constraints

### 1. Localhost only — the A5 gate stands

Every URL is `http://localhost:4599`, fakeAts. Asserted in the test suite that no external `https://`
target appears in the harness.

### 2. Neutral fixture pages

A **presentation flag on the existing routes**, not new routes — so the pages that get photographed
are the pages that get tested.

| route | what `?presentation=1` changes | what it does NOT change |
|---|---|---|
| `/gated/form` | `<legend>TRAP: label-only match</legend>` → `Employment`; `<legend>TRAP: sponsorship_inversion</legend>` → `Voluntary Disclosures`; the explanatory paragraph under the inversion trap is dropped; the page title loses its `G3-TRAPS` prefix | every `name`, `id`, label, option, `required` and `aria-required` — **the traps themselves are byte-identical** |
| `/ashby-spa` | the real employer's brand and role title → `Senior Backend Engineer — Northwind Systems`; the harness caption → a posting line | every field name, including the `_systemfield_*`/GUID mix the shape was measured for |

The `/ashby-spa` change matters for a second reason: that fixture's shape was transcribed from a
**live posting**, so it had inherited a real company's brand and role title. Putting another
company's name in our own store listing is a different kind of wrong from an ugly caption, and it
now has its own line in the forbidden list.

### 3. Realistic fixture data, not the owner's

The candidate is the harness's existing synthetic fixture: **Ada Lovelace**, `ada@example.com`,
`+1 555 0100` (a reserved fictional range), Analytical Engines. Plainly not a real person.

But "the fixture is synthetic" is a claim about the seed, not about the pixels. So before each
capture is written, the surface's rendered text is checked against **every value in the developer's
own `user_profile` table** — `full_name`, `first_name`, `last_name`, `email`, `phone`, `location`,
9 values on this machine. A hit throws. If `data/resume_master.db` is absent the run **says** the
check has nothing to look for rather than reporting a vacuous pass.

This fired for real during development: the fixture's job location read `Boston, MA`, which is also
a `location` in the real table. Not a leak — a coincidence — but the guard cannot tell, so the
fixture says `Remote — United States` and the guard stays strict.

### 4. Actual functionality

The extension UI in all three images is rendered by the extension itself, from a real installed
build in a real Chrome. Only the form behind it is a local fixture, and the traps that make the
overlay worth looking at are present and unfilled in the photographed run.

### 5. Deterministic and re-runnable

One command, overwriting cleanly. Verified: three separate runs produced **byte-identical files**
(`53c68c54…`, `f396f4d7…`, `a62cb22c…` each time). The directory is emptied at the start of a
screenshot run, so a shot that fails to be produced cannot be silently satisfied by last run's file.

### 6. Fail loudly and write nothing

`shoot()` validates before it writes, and throws rather than counting a failure — a `check()` would
tally the problem and let the run write the other two. Both capture paths (the direct one and the
composited popup) go through the single `writeShot()` gate; the test suite asserts there is exactly
one `fs.writeFileSync` in the harness, because a second write path is how one of the three ends up
unvalidated.

**Demonstrated, not assumed.** Three real failures during this work, each killing the run with an
empty output directory:

| injected fault | what happened |
|---|---|
| fixture location collided with a real `user_profile` value | `1-review-overlay: REAL personal data is visible in the capture — "Boston, MA"` — nothing written |
| `?presentation=1` not yet wired for `/ashby-spa` | `2-popup: a trap caption is visible on the posting — /rendered by JavaScript/i` — nothing written |
| capture size forced to 1000×700 | `1-review-overlay: captured 1000x700, the store needs 1280x800` — `docs/store-screenshots/` left **empty** |

There is also a guard for a stale fixture server: the harness reuses a `fakeAts` already listening
on 4599, and one started before the presentation flag existed would serve the trap captions at
`?presentation=1`. It now asks the fixture what it actually serves and dies **before launching a
browser** if it is the wrong one.

---

## Verification

- `npm run store:screenshots` — **ALL PASS**, 3 of 3, each asserted 1280×800 / 24-bit / no alpha.
- Each image opened and read: no trap captions, no third-party brand, no real personal data, and the
  overlay shot shows real filled fields with provenance cues.
- `npm test` — **1904 pass, 0 fail** (19 new here; baseline for this task was 1885 after AI1).
- `npm run verify:harness` — **30/30 green, 767 assertions**; `g3ReviewOverlay` 19/19 unchanged
  without the flag.
- Determinism: three runs, byte-identical output.

## Regression verdicts

| Surface | Verdict |
|---|---|
| `scripts/g3ReviewOverlay.mjs` (no flag) | **Unchanged behaviour**, 19/19 in `verify:harness`. `FORM_URL` is plain `/gated/form` without `--screenshots`. |
| `scripts/g3ReviewOverlay.mjs` (`--screenshots`) | Output moved from `extension/submission/screenshots/` to `docs/store-screenshots/`; captures validated and alpha-stripped; runs on the presentation fixture. |
| `scripts/fakeAts.js` — `gatedForm`, `ashbySpaForm` | Additive parameter, defaulting to today's behaviour. Every field name, id, label and option unchanged in both variants; only human-facing captions differ. |
| `scripts/fakeAts.js` — `spaForm` | Untouched. An earlier edit here was reverted: `/ashby-spa` is served by `ashbySpaForm`, not `spaForm`, and a presentation flag on an unused path would be untested surface. |
| Other harnesses using `/gated/form` or `/ashby-spa` | Unaffected — they pass no `presentation` param and get the existing pages. `verify:harness` 30/30 confirms. |
| `services/pngTruecolor.js` | New. No existing caller. |
| `docs/af4-extension-publish.md` | Updated: the old screenshot path is marked superseded, and its cosmetic limits 1 and 2 are recorded as addressed. |

## Not done

**Submitting the listing.** Out of scope here and still blocked for the reason AF4 gave: there are
no Chrome Web Store credentials in this environment. The three files are ready to upload as they
are.
