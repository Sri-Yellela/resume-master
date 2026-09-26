# Chrome Web Store listing — draft v1.1.0

Copy for the Web Store developer dashboard. Every justification below was written against the
actual code and cites the file that uses the permission, because the dashboard rejects
justifications that don't match observable behaviour.

Upload artifact: `extension/submission/resume-master-extension-v1.1.0.zip`
(build with `npm run build:extension` — never hand-assemble it; see extension/README.md).

> **THIS REPLACES v1.0.0, WHICH IS IN REVIEW AND WAS NEVER PUBLISHED.** There are still zero
> installed users, so nothing below is a change description against anything a user has. Earlier
> version numbers exist in this repo's history (v0.1.0 through v1.3.0); none was ever published and
> the zips are gone. What changed since the v1.0.0 package, and every one of these is a field a
> reviewer re-reads:
>
> 1. **The product was renamed.** "Resume Master" → **draft**, and the listing title with it.
> 2. **The host permission moved**, from `https://resumemaster.one/*` to
>    `https://jobsviadraft.com/*`. Same server, same operator, new address. The old address still
>    serves and is deliberately NOT redirected — a credentialed `fetch` does not follow redirects,
>    so a 301 would break the v1.0.0 build silently rather than move it.
> 3. **The privacy policy URL moved with it**, and the policy is live on the new origin.
> 4. **The extension stopped borrowing the browser's session.** It now holds an access token of its
>    own (`auth.js`). That changes the `storage` disclosure from four values to **six**, and one
>    of the six is transmitted where previously none were. Both are corrected below.
>
> ⛔ A rename plus a host-permission change is the shape that triggers an in-depth review. Expect a
> longer queue than the first submission.

---

## Single purpose

> Help the user complete a job application they have chosen to make: capture the posting they are
> viewing into their own Draft account, and — when they invoke the extension on an
> application form they have opened and signed in to themselves — fill it with answers they have
> already given us, for them to review and submit.

The capture half and the fill half are the same purpose at two points in one flow: the user finds a
job, and the user applies to it. Nothing runs without a direct user action — there is no background
activity of any kind, and **no content script**, so nothing runs on page load either. Every read of
every page begins with a click or a keystroke.

The popup's other buttons (Open Resume Builder, ATS Score Tool, Sign in with LinkedIn, Keyboard
Shortcuts) are not separate features; they open a page of the user's own Draft
account, or the extension's own options page. They request no permission of their own beyond the
`scripting` call the ATS Score Tool makes on a job page, which is disclosed below.

---

## Description (matches `manifest.json` byte for byte)

> Capture the job you're viewing, and fill the application you signed in to reach. You review every
> answer and submit it yourself.

---

## What the extension does, end to end

| Trigger | What happens |
|---|---|
| Toolbar button → **Capture job** | Reads the job description on the page in view, sends it to the user's Draft account. Works on any job posting, including employers' own careers pages — not a fixed list of sites. |
| **Ctrl+Shift+K** (rebindable) | **The identical capture.** Same implementation, same destination, same wording of the result. |
| **Ctrl+Shift+Y** on an application form | The gated handoff: fetches the answers the user already saved in their account, fills the form, shows a review panel. The user submits. |
| Toolbar → **ATS Score Tool** | Collects the visible text of the page in view and opens the user's ATS Score page with it prefilled. |
| Toolbar → **Open Resume Builder** / **Sign in with LinkedIn** | Opens a Draft page in a new tab. Nothing is read from the current page. |
| Toolbar → **Keyboard Shortcuts** | Opens the extension's own options page, which lists both commands with the key currently bound to each, and links to Chrome's own shortcuts page — the only place a command can actually be rebound. Reads no page. |

There is exactly **one** capture implementation. The button and the shortcut are two triggers for
it, they land in the same place with the same duplicate detection, and they report the same text.

### Which sites it works on

**Any job posting the user opens it on.** There is no supported-sites list, because there is no
mechanism that could enforce one: the extension reads whichever tab the user invoked it on, and it
holds no permission for any site in advance.

It carries tuned extraction for LinkedIn, Indeed, Glassdoor, Lever, Greenhouse, Workable, Ashby and
Workday, and falls back to a generic reader everywhere else. That distinction is about extraction
quality, not access — a Greenhouse posting embedded on an employer's own careers domain is captured
by the generic path and works. Verified against live postings on all of the above by
`scripts/e5GreenhouseHost.mjs`, including two employer-hosted pages.

---

## Permission justifications

**`activeTab`**
> Granted only when the user explicitly invokes the extension — clicking the toolbar button or
> pressing one of the two keyboard shortcuts. It is used for two things: reading the job posting on
> the page they are viewing, and filling the application form on a page they have opened and signed
> in to themselves. The extension holds no host permission for any job portal, so it can reach such
> a page **only** through that per-tab, per-invocation grant. It never accesses a tab the user is not
> on, and never acts without a direct user action.

*(Code: `background.js` `chrome.commands.onCommand` and `popup.js` `getCurrentTab()` both call
`chrome.tabs.query({active: true, currentWindow: true})` only inside a user-gesture handler.
`captureActiveTab()`, `previewActiveTab()` and `handleGatedHandoff()` are reached only from there.)*

**`scripting`**
> Injects a one-off script into the invoked tab to (a) read the job posting the user is capturing,
> (b) collect the visible text when the user asks for an ATS score, and (c) fill the application form
> and render the review panel on a handoff. Nothing is injected into any other tab, and no script is
> registered to run persistently — the extension declares no content script at all.
>
> This is how the extension reads a job page without holding a permission for the site. It is also
> why it can capture a posting on an employer's own careers domain, which no list of declared hosts
> could ever have covered.

*(Code: `background.js` `captureActiveTab()` and `reportCapture()`, injecting `extractor.js`
`extractJobPayload()` and `showCaptureToast()`; `gated-handoff.js` `probeFormShape()`, `applyPlan()`
and `applyOverlayEdit()`; `review-overlay.js` `renderOverlay()`; `popup.js` for the ATS Score Tool.)*

**`storage`** — ⚠ **REVISED AGAIN 2026-09-26. Re-paste this field in the dashboard.**
> Six values. Five never leave the browser; the sixth is the extension's own access token, which is
> sent to our backend and to nowhere else. In `chrome.storage.local`: the result of the user's most
> recent capture, so the popup can show the outcome of a capture made with the keyboard while the
> popup was closed; the username of the account the extension is connected to, so the popup can name
> it before a capture; and that access token, which is how the extension identifies itself to us —
> it is not the user's password and not their website session, and it is deleted the moment they
> disconnect the extension. In `chrome.storage.session` (memory-backed, discarded on browser
> restart): the prepared answers for an application in progress, with a 10-minute expiry and cleared
> when the tab closes; the result of the most recent form fill, so the popup can report a fill
> started with the keyboard; and, when several applications are queued for one employer site, that
> site's origin and how many remain, so a batch can resume in the same tab — no answers and nothing
> about the user in that one. Only the prepared-answers packet carries the 10-minute expiry; the
> other two session values live until the browser restarts, or until the tab closes in the case of
> the batch.

*(Code: `background.js` `reportCapture()` → `lastCapture` (`storage.local`) and `reportHandoff()` →
`lastGatedHandoff` (`storage.session`); `gated-handoff.js` `savePacketForTab()` /
`clearPacketForTab()` / `sweepExpiredPackets()` → `gate:{tabId}`, and `saveBatchForTab()` /
`clearBatchForTab()` → `batch:{tabId}` (`storage.session`); `auth.js` `storeToken()` → `authToken`
and `getIdentity()` → `authIdentity` (`storage.local`), both cleared by `clearStoredToken()`.
`options.js` touches `storage.sync` only to delete a value the retired shortcut recorder left
behind.)*

> ⚠ **Why this changed, twice.** On 2026-09-15 this field said two values and the extension kept
> four. On 2026-09-26 it said four and the extension kept six: `auth.js` added `authToken` and
> `authIdentity` when the extension moved off the browser's ambient session, and the test that
> counts storage writes was reading a HARDCODED list of source files which did not include the new
> one — so it kept asserting four and kept passing. Both corrections went to the DOCUMENTATION,
> never to the code: undisclosed keys are honest behaviour with dishonest documentation, and
> deleting a key to make a sentence true is the wrong direction. The count is now derived from the
> shipped bundle, so the next file that writes a storage key fails the test instead of quietly
> making this field wrong again. See `PRIVACY_RECONCILIATION.md` § Permissions.
>
> ⚠ **One claim was RETRACTED, not merely widened.** "Four values, none of them sent anywhere by the
> extension" became false the moment the extension carried a token of its own, and a reviewer
> falsifies it by watching a single request. The replacement names which value is sent and where it
> goes.

**Host permissions** — one, and it is our own backend
> `https://jobsviadraft.com/*` is our own server. The extension fetches from it with an access
> token of its own — obtained once, when the user connects the extension, and sent on every call
> thereafter. The browser's session cookie is deliberately NOT sent (`credentials: 'omit'` on every
> call but the one that obtains the token). That is what makes the extension act as the single
> account the user connected it to, rather than as whatever session the browser happens to hold for
> our origin.
>
> **No job board and no employer portal is declared, and none will be.** The extension has no
> standing access to any site it reads a job from. It reads a page only by injecting into the tab
> the user has just invoked it on, under the `activeTab` grant that invocation creates, and that
> access ends when the tab leaves the origin. Earlier builds declared six job boards and ran a
> content script on them automatically; that is gone, and with it the extension's ability to read
> anything the user has not deliberately pointed it at.

| Host | Why |
|---|---|
| `https://jobsviadraft.com/*` | Our own backend: capture, the auth probe, the handoff packet |

Full derivation, including every permission deliberately **not** requested and why, is in
`extension/MANIFEST_RATIONALE.md`. `test/manifestMinimumPermission.test.js` fails the build if that
file and the manifest ever disagree in either direction.

---

## Data usage disclosures

These are the answers for the **Privacy practices** tab.

- **Personally identifiable information** — **collected and transmitted.** Two distinct flows:
  1. *Capture and ATS scoring.* Job postings the user captures are stored in **their own Draft
     account**, which is an identified account. The posting text itself is employer-authored,
     but it is account-linked, so this is collection of personally identifiable information and is
     declared as such.
  2. *The handoff.* The extension fetches, from the user's own Draft account, the details
     they previously saved there — name, email, phone, postal address, and work-authorization
     answers — and enters them into the application form the user has opened. This is the user's own
     data, sent to the employer's form at the user's instruction, in a tab they opened and signed in
     to. It is held only for the duration of that handoff and is never sent to any third party other
     than the employer's own form.
- **Website content** — **collected, in three narrow cases.**
  1. The text of a job posting the user explicitly captures, sent to their account.
  2. The visible text of a job page when the user clicks **ATS Score Tool**, passed to their own
     ATS Score page so it arrives prefilled. It travels in the URL of the page that opens, so it
     can appear in ordinary server logs; the privacy policy states this explicitly.
  3. *Optional and off by default:* the **structure** of an application form — its field labels,
     types, required flags and option lists. Never the values in it, never anything about the user.
     This is used to recognise the same form for other users. It is controlled by a per-account
     setting that defaults to OFF and is enforced on our server, not only in the extension.
- **Authentication information** — *not collected.* The extension never reads, stores or transmits
  any portal's session cookie, password, or token. It cannot sign the user in and does not try; the
  user crosses every sign-in and CAPTCHA themselves. It holds no `cookies` permission.
- **Web history** — *not collected.* The extension reads the URL only of the tab the user has
  invoked it on, and only to decide whether that page is a supported job posting. It holds no
  `tabs`, `history` or `webNavigation` permission, so it cannot see any other tab.
- **User activity** — *not collected.* No clickstream, no analytics, no telemetry.
- **Health / financial / personal communications / location** — *not collected.*

Certifications:
- Not being sold to third parties.
- Not being used or transferred for purposes unrelated to the item's single purpose.
- Not being used or transferred to determine creditworthiness or for lending purposes.

Privacy policy URL: `https://jobsviadraft.com/privacy` (set in `manifest.json`).

---

## Reviewer notes

> The extension never submits an application. It fills the form and shows a review panel; the user
> presses the employer's own submit button. There is no background activity of any kind: every
> behaviour begins at a toolbar click or a keyboard shortcut.
>
> It also never crosses a sign-in or a CAPTCHA. The user authenticates on the portal themselves, in
> their own browser; only then can they invoke the extension, and that invocation is what grants
> access to that one tab. The extension requests no host permission for any job portal, so it has no
> standing access to any of them.
>
> Before releasing anything into a page, it checks that the tab's origin matches the origin our
> server nominated for that application and that a form is actually present. On a mismatch it
> releases nothing.
>
> The extension asks for no site permissions. Capture, the ATS reader and the form fill all reach a
> page the same way: `chrome.scripting.executeScript` into the tab the user just invoked on, under
> `activeTab`. There is no content script and no job-board host permission, so there is no page the
> extension can read without a deliberate gesture on that exact tab.
>
> No remotely hosted code. Everything executed ships in the package: no `eval`, no `new Function`,
> no `importScripts`, no remote `<script src>`. The CSP in the manifest is `script-src 'self'`.
>
> `externally_connectable` is deliberately absent. No website can message this extension; the data
> flow is outbound-only, from the extension to our own server with the user's own session.

---

## Test instructions — ⛔ THIS FIELD IS EMPTY AND IT IS A BLOCKER

**The dashboard has a "Test instructions" field for items that cannot be exercised without an
account, and this item cannot.** Every behaviour the listing describes — capture, the handoff, the
ATS Score Tool — begins with `authedFetch`, which returns null without a signed-in session to
bootstrap a token from. A reviewer who cannot sign in sees a popup that says "Sign in to Draft
first" and nothing else, and "I could not test it" is a rejection rather than a question.

⚠ **No reviewer account exists.** This was checked at P4 rather than assumed: the local database
holds `system`, `admin`, `johndoe` and the owner's own account, and no account named for Web
Store review appears anywhere in this repository or its history. Whether one exists in PRODUCTION
could not be established from here.

**What the owner has to do, and no agent can do any of it:**

1. Create an account on `https://jobsviadraft.com` that exists to be used by a reviewer, with a
   password that is not reused anywhere. ⛔ Not the owner's own account and not `admin` — a
   reviewer signs in to it, and the extension's identity model means it then acts as that account.
2. Give it a completed profile. The handoff fills a form from saved details; an empty profile makes
   the extension look broken rather than restrictive. Name, email, phone, postal address and the
   work-authorization answers are what the review panel shows.
3. Paste the credentials into the dashboard's **Test instructions** field along with the two steps
   below. ⛔ Do NOT commit them to this file — it is a tracked file in a repository.

> Sign in at https://jobsviadraft.com with the account above. Then:
>
> **To see a capture:** open any job posting in another tab — an employer's own careers page is
> fine — and press Ctrl+Shift+K, or click the extension's toolbar button and then "Capture job".
> The posting appears on the account's board.
>
> **To see the form fill:** from the account's board, start an application. The extension opens the
> employer's form in a tab; sign in to the employer's site yourself if it asks, and then press
> Ctrl+Shift+Y on the form. The answers appear with a review panel above them. **The extension does
> not submit** — the panel says so, and you press the employer's own submit button.

---

## Pre-submission checklist

- [ ] `npm run build:extension` — regenerates the zip and fails on a flipped dev switch
- [ ] `npm test` — includes `extensionSubmission.test.js`, which proves the zip is byte-identical
      to `extension/` and ships nothing unreachable from the manifest, and
      `manifestMinimumPermission.test.js`, which proves every permission is justified
- [ ] `node scripts/e3PermissionAudit.mjs` — removes each declared permission in a real Chrome and
      confirms something actually breaks
- [ ] ⛔ Confirm `https://jobsviadraft.com/privacy` returns 200 **anonymously** and its Browser
      Extension section matches the disclosures above. The policy is served by the deployed client
      build, so a policy change is not live until it is **deployed**, not merely committed — and
      this release CHANGED THE POLICY TEXT (six stored values, the access token, the retracted
      "none of them sent anywhere" claim). Deploy before the listing cites the URL; reviewers fetch
      it, and the wording has to be verified by grepping the deployed bundle rather than by loading
      the URL, which returns a ~2 kB SPA shell with zero policy text in it.
- [ ] ⛔ Confirm the reviewer's test account signs in on `https://jobsviadraft.com`. An account
      that exists only on the developer's machine is not an account a reviewer can use, and
      "cannot sign in" is a rejection rather than a question.
- [ ] Read `PRIVACY_RECONCILIATION.md` — the four-column join of manifest, code, policy and the
      justifications on this page. Every row complete; an orphan in any column is a rejection
- [ ] Fill the **Privacy practices** tab with the disclosures above
- [ ] Fill the **single purpose** field with the statement above
- [ ] Upload `resume-master-extension-v1.1.0.zip` — and ⛔ check the version in the dashboard is
      higher than the v1.0.0 still sitting in review, or the upload is refused
