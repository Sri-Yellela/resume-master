# AF4 — publishing the extension: preflight green, submission blocked

**Summary: items 1–4 are done. Item 5 (submit) is blocked — the Chrome Web Store API credentials do
not exist in this environment. That is not a judgement call I made; it is a missing secret.**

---

## 1. `npm run publish:extension -- --dry-run` — full preflight

```
[publish] Resume Master v1.0.0
[publish] artifact  extension\submission\resume-master-extension-v1.0.0.zip
[publish] mode      DRY RUN (nothing is sent)
[publish] privacy  https://resumemaster.one/privacy -> 200
[publish] preflight OK — 13 files, byte-identical to extension/
```

**The stated gap — "the zip on disk is newer than its sources but only the manifest was compared" —
is already closed.** `preflight()` in `scripts/publishExtension.mjs` byte-compares in **both**
directions:

- every zip entry must exist in `extension/` and its bytes must be `.equals()` the source
- every manifest-reachable source file must exist in the zip

so an edited source, a stale zip, an extra file, or a missing file each fail by name. It uses the
*builder's own file list* derived from the manifest, not a second hand-maintained copy.

It also checks four things worth naming:

- **an active localhost URL in any shipped `.js` fails the build.** A dev-switched URL in a store
  build points real users at localhost. Regex-matched on an *uncommented* assignment, so the
  commented dev line is fine and an uncommented one is fatal.
- **`STORE_LISTING.md`'s version header must equal the manifest version.** If it does not, the
  dashboard copy — single purpose, permission justifications, data disclosures — has not been
  revisited for this release, and that is a rejection waiting to happen.
- **the version moves forward** against already-built artifacts, and is a valid version string.
- **the privacy policy URL actually resolves** — fetched, not assumed. 200.

## 2. Both copies of `RESUME_MASTER_URL` are on the production line

They are separate copies by design (a service worker is a module and cannot share plain-script
globals with `config.js`), and the brief is right that they have drifted before. Both confirmed:

| File | Line |
|---|---|
| `extension/config.js:6` | `const RESUME_MASTER_URL = 'https://resumemaster.one'; // A: production` |
| `extension/background.js:9` | `const RESUME_MASTER_URL = 'https://resumemaster.one'; // A: production` |

The `// B: local dev` line is commented out in both. Cross-checked against the server's own
configuration: `APP_BASE_URL` and `FRONTEND_URL` are both `https://resumemaster.one`, so the
extension and the server agree on the origin. `test/productionOriginConsistency.test.js` pins this.

This is also belt-and-braces with preflight check 3 above: had either been flipped, the dry run would
have failed rather than shipping.

## 3. The listing tests

```
test/privacyReconciliation.test.js
test/manifestMinimumPermission.test.js
test/productionOriginConsistency.test.js
test/publishExtension.test.js
  → 46 tests, 46 pass, 0 fail
```

(The brief said "12/12 last checked" for the first two; the four files together are now 46.)

## 4. Screenshots — produced

Four listing items were outstanding; three images now exist, at the Chrome Web Store's 1280×800.

> **Superseded by AI2 — see `docs/ai2-store-screenshots.md`.** They now live in
> `docs/store-screenshots/`, are produced by `npm run store:screenshots`, are re-encoded to 24-bit
> with no alpha channel (the dashboard rejects alpha on screenshots), and are captured over neutral
> fixture pages so no trap caption or third-party brand appears. The three cosmetic limits recorded
> below were addressed there.

They are captured by `scripts/g3ReviewOverlay.mjs --screenshots` rather than by a script of their
own, and that choice is the point: **a listing screenshot of the review overlay is a claim about what
the extension does, and this harness is the thing that proves the claim.** A screenshot taken by a
separate script could be of an overlay that renders and does not work. One taken at this point in
this run cannot be — every assertion around it has to pass for the run to be green. The extension
loaded is the real `extension/` directory, installed into a real Chrome.

| File | What it shows |
|---|---|
| `1-review-overlay.png` | **The one that matters.** The overlay over a real filled form, captured *before* anything is acknowledged. It reads: "Review before you submit", "7 field(s) filled · resume attached. **Resume Master never submits for you.**", the two eligibility answers pinned to the top under "ELIGIBILITY — YOU ARE ATTESTING TO THESE", a `guessed field` under "WORTH CHECKING" with an **acknowledge** button, and the footer "**Not ready — 1 guess(es) still to acknowledge.** Submit the form yourself when you are happy with it." |
| `2-popup.png` | The popup in its signed-in, capturable state — "Capture job", "Ready to capture". |
| `3-options.png` | The options page: both shortcuts (Ctrl+Shift+K, Ctrl+Shift+Y) and the sentence "Resume Master never submits an application — you do." |

To get `2-popup.png` into a *truthful* state, two fixture problems had to be fixed:

- The harness API served no `/api/auth/me`, so the popup's auth probe failed closed and rendered its
  **sign-in wall** — the wrong state for a harness whose entire scenario is a candidate who has
  already signed in to reach a gated form. Added.
- `popup.js` asks the service worker for the **active tab** and only offers to capture when that tab
  holds a posting. So the popup tab is created blank, the *posting* is brought to the front, and only
  then is `popup.html` navigated to — so its `init()` sees the posting, as the real toolbar popup
  does. Screenshotting it backgrounded is the cost of that, and is what turns "Open a job posting to
  capture it" into "Ready to capture".

### Known cosmetic limits — the owner's call before upload

I am flagging these rather than papering over them:

1. **Whitespace.** The popup (~244px) and options page (~400px) are narrow surfaces on a 1280×800
   canvas, so both images are mostly empty. Fixing it means cropping or compositing, which is a
   design decision about the listing, not a code change.
2. **`2-popup.png` is the popup rendered as a tab.** Chrome's real popup is a separate window that
   CDP cannot reliably screenshot. The markup, script and state are the real ones; the framing is
   not what a user sees. A composite of popup-over-posting is the usual listing solution and would
   need to be assembled by hand.
3. **`1-review-overlay.png`'s backdrop is the trap-laden test form**, and one fieldset legend reads
   `TRAP: label-only match`. Those legends are documentation for whoever reads the fixture and are
   used by several harnesses, so I did **not** rename them for a screenshot. A store reviewer would
   find the word odd. Either accept it, or capture the overlay over `/ashby-spa` (the measured shape
   of a live Ashby posting, which has no such legends) by seeding a gate packet against that URL.

## 5. Submit — BLOCKED, not skipped

`scripts/publishExtension.mjs` needs four secrets to upload a draft and publish it:

```
CWS_CLIENT_ID       ABSENT
CWS_CLIENT_SECRET   ABSENT
CWS_REFRESH_TOKEN   ABSENT
CWS_ITEM_ID         ABSENT
```

All four are absent from `.env`. Without them the script stops at "missing credentials" by design and
sends nothing. `--dry-run` needs none, which is why item 1 could complete.

So submission needs the owner to either put those four in `.env` and run
`npm run publish:extension` (no `--dry-run`), or upload
`extension/submission/resume-master-extension-v1.0.0.zip` through the dashboard by hand. Note that
publishing is public and irreversible in the sense that a version number cannot be reused — the
preflight's "version moves forward" check exists for that reason.

`extension/README.md` documents how to obtain the credentials.

---

## State

| Item | Status |
|---|---|
| 1. Full preflight dry run | **done** — green; the byte-comparison gap was already closed |
| 2. Both `RESUME_MASTER_URL` copies on production | **confirmed** — and pinned by preflight + a test |
| 3. Privacy + manifest permission tests | **done** — 46/46 across four files |
| 4. Screenshots | **done** — 3 × 1280×800, real, with three cosmetic limits flagged above |
| 5. Submit | **BLOCKED** — no store credentials in this environment |
