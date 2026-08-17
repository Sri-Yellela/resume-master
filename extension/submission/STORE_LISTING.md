# Chrome Web Store listing — Resume Master v1.3.0

Copy for the Web Store developer dashboard. Every justification below was written against the
actual code and cites the file that uses the permission, because the dashboard rejects
justifications that don't match observable behaviour.

Upload artifact: `extension/submission/resume-master-extension-v1.3.0.zip`
(build with `npm run build:extension` — never hand-assemble it; see extension/README.md).

> **READ THIS BEFORE SUBMITTING.** v1.3.0 is not a bug-fix release. The extension now fills
> application forms on portals the user has signed in to, renders a review panel over those forms,
> and can optionally report the form's structure back. The v1.2.0 listing declared "no auto-apply"
> and "personally identifiable information — not collected"; **neither is true any more**, and
> submitting the old copy would be submitting justifications that do not match observable
> behaviour. The single purpose, the data disclosures and the privacy policy all change here.

---

## What changed since the published v1.2.0

| | v1.2.0 (published) | v1.3.0 (this submission) |
|---|---|---|
| Permissions | `activeTab`, `scripting`, `storage` | **unchanged** |
| Host permissions | 7 entries | **unchanged** |
| Keyboard commands | `capture-job` | + **`fill-gated-application`** (Ctrl+Shift+Y / Cmd+Shift+Y) |
| New scripts | — | `gated-handoff.js`, `review-overlay.js` |
| Reads job pages | yes | yes |
| **Fills application forms** | no | **yes, on user invocation** |
| **Sends the user's own details into a page** | no | **yes — see disclosures** |
| **Reports form structure back** | no | **optional, off by default** |

**No permission was added.** The permission set is byte-identical to the approved v1.2.0. What
changed is what the extension *does* with `activeTab`, which is the part the review should focus on.

---

## Single purpose

> Help the user complete a job application they have chosen to make: capture the posting they are
> viewing, and — when they invoke the extension on an application form they have opened themselves —
> fill it with answers they have already given us, for them to review and submit.

The capture half and the fill half are the same purpose at two points in one flow: the user finds a
job, and the user applies to it. Nothing runs without a direct user action.

---

## Description (matches `manifest.json`)

> Capture the job you're viewing, and fill the application you signed in to reach. You review every
> answer and submit it yourself.

---

## Permission justifications

**`activeTab`**
> Granted only when the user explicitly invokes the extension — clicking the toolbar button or
> pressing one of the two keyboard shortcuts. It is used for two things: reading the job posting on
> the page they are viewing, and filling the application form on a page they have opened and signed
> in to themselves. The extension holds no host permission for any job portal, so it can reach such
> a page **only** through that per-tab, per-invocation grant. It never accesses a tab the user is not
> on, and never acts without a direct user action.

*(Code: `background.js` `chrome.commands.onCommand` and `popup.js` both call
`chrome.tabs.query({active: true, currentWindow: true})` only inside a user-gesture handler.
`gated-handoff.js` `runGatedHandoff()` is reached only from that handler.)*

**`scripting`**
> Injects a one-off script into the invoked tab to (a) collect the visible job description text on
> capture, and (b) fill the application form and render the review panel on a handoff. Nothing is
> injected into any other tab, and no script is registered to run persistently.

*(Code: `linkedin-content.js` for capture; `gated-handoff.js` `probeFormShape` / `applyPlan` and
`review-overlay.js` `renderOverlay` for the handoff.)*

**`storage`**
> Persists the user's own capture-shortcut preference, the result of their most recent action, and —
> during a handoff only — the prepared answers for the tab they are working in, held in
> `chrome.storage.session` (memory-backed, cleared on browser restart) with a 10-minute expiry and
> cleared when the tab closes.

*(Code: `options.js`, `shortcutUtils.js`; `gated-handoff.js` `savePacketForTab` /
`clearPacketForTab` / `sweepExpiredPackets`.)*

**Host permissions** (`resumemaster.one`, LinkedIn, Indeed, Glassdoor, Lever, Greenhouse, Workable)
> `resumemaster.one` is our own backend, which the extension fetches from with the user's existing
> session cookie. The six job sites are where the capture content script runs. **No job portal that
> the handoff fills is on this list, and none will be** — reaching those pages depends entirely on
> `activeTab`.

---

## Data usage disclosures

These are the answers for the **Privacy practices** tab, and they are different from v1.2.0's.

- **Personally identifiable information** — **collected and transmitted.** During a handoff the
  extension fetches, from the user's own Resume Master account, the details they previously saved
  there — name, email, phone, postal address, and work-authorization answers — and enters them into
  the application form the user has opened. This is the user's own data, sent to the employer's form
  at the user's instruction, in a tab they opened and signed in to. It is held only for the duration
  of that handoff and is never sent to any third party other than the employer's own form.
- **Website content** — **collected, in two narrow cases.**
  1. The text of a job posting the user explicitly captures, sent to their account.
  2. *Optional and off by default:* the **structure** of an application form — its field labels,
     types, required flags and option lists. Never the values in it, never anything about the user.
     This is used to recognise the same form for other users. It is controlled by a per-account
     setting that defaults to OFF and is enforced on our server, not only in the extension.
- **Authentication information** — *not collected.* The extension never reads, stores or transmits
  any portal's session cookie, password, or token. It cannot sign the user in and does not try; the
  user crosses every sign-in and CAPTCHA themselves.
- **Health / financial / personal communications / location** — *not collected.*
- **User activity** — *not collected.* No clickstream, browsing history, or analytics.

Certifications:
- Not being sold to third parties.
- Not being used or transferred for purposes unrelated to the item's single purpose.
- Not being used or transferred to determine creditworthiness or for lending purposes.

Privacy policy URL: `https://resumemaster.one/privacy` (set in `manifest.json`).
**The policy's "Browser Extension" section must be updated before submission** — see the checklist.

---

## Reviewer notes

> The extension never submits an application. It fills the form and shows a review panel; the user
> presses the employer's own submit button. There is no background activity of any kind: both
> behaviours begin at a toolbar click or a keyboard shortcut.
>
> It also never crosses a sign-in or a CAPTCHA. The user authenticates on the portal themselves, in
> their own browser; only then can they invoke the extension, and that invocation is what grants
> access to that one tab. The extension requests no host permission for any job portal, so it has no
> standing access to any of them.
>
> Before releasing anything into a page, it checks that the tab's origin matches the origin our
> server nominated for that application and that a form is actually present. On a mismatch it
> releases nothing.

---

## Pre-submission checklist

- [ ] `npm run build:extension` — regenerates the zip and fails on a flipped dev switch
- [ ] `npm test` — includes `extensionSubmission.test.js`, which proves the zip is byte-identical
      to `extension/` and ships nothing unreachable from the manifest
- [ ] **Update the privacy policy's "Browser Extension" section** at `resumemaster.one/privacy`.
      The published text describes an extension that only reads job pages; it must describe the form
      fill and the optional structure capture before this listing points at it.
- [ ] Update the **Privacy practices** tab with the disclosures above — in particular, flip
      *personally identifiable information* to **collected**, which v1.2.0 declared as not collected
- [ ] Update the **single purpose** field, which no longer matches
- [ ] Upload `resume-master-extension-v1.3.0.zip`
- [ ] Expect a longer review than v1.2.0's: the behaviour change is material even though the
      permission set is not
