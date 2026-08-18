# Chrome Web Store listing — Resume Master v1.0.0

Copy for the Web Store developer dashboard. Every justification below was written against the
actual code and cites the file that uses the permission, because the dashboard rejects
justifications that don't match observable behaviour.

Upload artifact: `extension/submission/resume-master-extension-v1.0.0.zip`
(build with `npm run build:extension` — never hand-assemble it; see extension/README.md).

> **THIS IS A FIRST SUBMISSION.** The item has never been published: the Web Store entry is a
> draft, no version has been publicly available, and there are zero installed users. Earlier
> version numbers exist in this repo's history (v0.1.0 through v1.3.0) but **none of them was ever
> published**, and the zips have been deleted. Nothing below should be read as a change description
> against a live version, because there is no live version. v1.0.0 is a deliberate reset to a
> first-submission number for the first build that will actually be reviewed.

---

## Single purpose

> Help the user complete a job application they have chosen to make: capture the posting they are
> viewing into their own Resume Master account, and — when they invoke the extension on an
> application form they have opened and signed in to themselves — fill it with answers they have
> already given us, for them to review and submit.

The capture half and the fill half are the same purpose at two points in one flow: the user finds a
job, and the user applies to it. Nothing runs without a direct user action — there is no background
activity of any kind, and **no content script**, so nothing runs on page load either. Every read of
every page begins with a click or a keystroke.

The popup's other buttons (Open Resume Builder, ATS Score Tool, Sign in with LinkedIn, Capture
Shortcut Settings) are not separate features; they open a page of the user's own Resume Master
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
| Toolbar button → **Capture job** | Reads the job description on the page in view, sends it to the user's Resume Master account. Works on any job posting, including employers' own careers pages — not a fixed list of sites. |
| **Ctrl+Shift+K** (rebindable) | **The identical capture.** Same implementation, same destination, same wording of the result. |
| **Ctrl+Shift+Y** on an application form | The gated handoff: fetches the answers the user already saved in their account, fills the form, shows a review panel. The user submits. |
| Toolbar → **ATS Score Tool** | Collects the visible text of the page in view and opens the user's ATS Score page with it prefilled. |
| Toolbar → **Open Resume Builder** / **Sign in with LinkedIn** | Opens a Resume Master page in a new tab. Nothing is read from the current page. |
| Toolbar → **Capture Shortcut Settings** | Opens the extension's own options page. |

There is exactly **one** capture implementation. The button and the shortcut are two triggers for
it, they land in the same place with the same duplicate detection, and they report the same text.

---

## Permission justifications

**`activeTab`**
> Granted only when the user explicitly invokes the extension — clicking the toolbar button or
> pressing one of the two keyboard shortcuts. It is used for two things: reading the job posting on
> the page they are viewing, and filling the application form on a page they have opened and signed
> in to themselves. The extension holds no host permission for any job portal, so it can reach such
> a page **only** through that per-tab, per-invocation grant. It never accesses a tab the user is not
> on, and never acts without a direct user action.

*(Code: `background.js:112` `chrome.commands.onCommand` and `popup.js:9` both call
`chrome.tabs.query({active: true, currentWindow: true})` only inside a user-gesture handler.
`gated-handoff.js` `runGatedHandoff()` is reached only from that handler, via `background.js:130`.)*

**`scripting`**
> Injects a one-off script into the invoked tab to (a) collect the visible job description text when
> the user asks for an ATS score, and (b) fill the application form and render the review panel on a
> handoff. Nothing is injected into any other tab, and no script is registered to run persistently.

*(Code: `gated-handoff.js:398,452,486,521,656` for the probe, fill and overlay; `popup.js:188` for
the ATS Score Tool. The capture path itself uses the declared content script, not injection.)*

**`storage`**
> Persists the user's own capture-shortcut preference, the result of their most recent capture, and —
> during a handoff only — the prepared answers for the tab they are working in, held in
> `chrome.storage.session` (memory-backed, cleared on browser restart) with a 10-minute expiry and
> cleared when the tab closes.

*(Code: `options.js` (`storage.sync`); `background.js:67` (`storage.local` last capture);
`background.js:147,190` and `gated-handoff.js:259-308` `savePacketForTab` / `clearPacketForTab` /
`sweepExpiredPackets` (`storage.session`).)*

**Host permissions** — one, and it is our own backend
> `https://resumemaster.one/*` is our own server, which the extension fetches from with the user's
> existing session cookie.
>
> **No job board and no employer portal is declared, and none will be.** The extension has no
> standing access to any site it reads a job from. It reads a page only by injecting into the tab
> the user has just invoked it on, under the `activeTab` grant that invocation creates, and that
> access ends when the tab leaves the origin. Earlier builds declared six job boards and ran a
> content script on them automatically; that is gone, and with it the extension's ability to read
> anything the user has not deliberately pointed it at.

| Host | Why |
|---|---|
| `https://resumemaster.one/*` | Our own backend: capture, the auth probe, the handoff packet |

Full derivation, including every permission deliberately **not** requested and why, is in
`extension/MANIFEST_RATIONALE.md`. `test/manifestMinimumPermission.test.js` fails the build if that
file and the manifest ever disagree in either direction.

---

## Data usage disclosures

These are the answers for the **Privacy practices** tab.

- **Personally identifiable information** — **collected and transmitted.** Two distinct flows:
  1. *Capture and ATS scoring.* Job postings the user captures are stored in **their own Resume
     Master account**, which is an identified account. The posting text itself is employer-authored,
     but it is account-linked, so this is collection of personally identifiable information and is
     declared as such.
  2. *The handoff.* The extension fetches, from the user's own Resume Master account, the details
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

Privacy policy URL: `https://resumemaster.one/privacy` (set in `manifest.json`).

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

## Pre-submission checklist

- [ ] `npm run build:extension` — regenerates the zip and fails on a flipped dev switch
- [ ] `npm test` — includes `extensionSubmission.test.js`, which proves the zip is byte-identical
      to `extension/` and ships nothing unreachable from the manifest, and
      `manifestMinimumPermission.test.js`, which proves every permission is justified
- [ ] `node scripts/e3PermissionAudit.mjs` — removes each declared permission in a real Chrome and
      confirms something actually breaks
- [ ] Confirm `https://resumemaster.one/privacy` returns 200 **anonymously** and its Browser
      Extension section matches the disclosures above. The policy is served by the deployed client
      build, so a policy change is not live until it is **deployed**, not merely committed.
- [ ] Read `PRIVACY_RECONCILIATION.md` — the four-column join of manifest, code, policy and the
      justifications on this page. Every row complete; an orphan in any column is a rejection
- [ ] Fill the **Privacy practices** tab with the disclosures above
- [ ] Fill the **single purpose** field with the statement above
- [ ] Upload `resume-master-extension-v1.0.0.zip`
