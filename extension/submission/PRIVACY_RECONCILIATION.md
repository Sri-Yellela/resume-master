# Privacy reconciliation — manifest × code × policy × dashboard

The 2026-08-01 Web Store rules are enforced by cross-checking three documents against each other:
the **manifest**, the **privacy policy** at `https://resumemaster.one/privacy`, and the **Privacy
practices** tab in the developer dashboard. A contradiction between any two of the three is the
rejection. So the check cannot be "does the policy sound right" — it has to be a join, and every
row has to be complete in every column.

Three failure directions, all rejections:

| Orphan | Means | Verdict |
|---|---|---|
| A permission with no code | over-declaration | remove the permission |
| Code with no policy paragraph | undisclosed practice | disclose it, or delete the code |
| A policy claim with no code | false disclosure | narrow the claim |

Enforced by `test/privacyReconciliation.test.js`, which fails if a row names a permission the
manifest does not declare, or if the manifest declares one this file does not cover.

Policy paragraph references are to section headings on
`https://resumemaster.one/privacy` (source: `client/src/pages/marketing/PrivacyPage.jsx`).

**Code is cited by SYMBOL, not by line number.** This table originally carried `file:line`, and the
line numbers were wrong twice within a day — once when capture moved to the service worker and again
when it moved to injection. A citation that rots silently is worse than a vague one, because it
still looks precise. Symbols survive edits, they are what a reviewer actually wants to grep for, and
`test/privacyReconciliation.test.js` now fails if a cited symbol is not in the file it is cited
from — so this table cannot drift the way the line numbers did.

---

## Permissions

| Manifest permission | Code that requires it | Policy paragraph | Dashboard justification |
|---|---|---|---|
| `activeTab` | `background.js` `captureActiveTab()`, `previewActiveTab()` and `handleGatedHandoff()`, each reached only from `chrome.commands.onCommand` or a popup message; `popup.js` `getCurrentTab()`. The grant IS the invocation. | *Browser Extension* — "reads nothing until you invoke it… only that one tab". *Filling an Application* — "It holds no standing permission for any employer or job-portal site". | Granted only on explicit invocation; used to read the job posting in view and to fill an application form the user opened. No host permission exists for any site the extension reads a job from, so this per-tab grant is the only access there is. |
| `scripting` | `background.js` `captureActiveTab()` and `reportCapture()`, which inject the two functions in `extractor.js` — `extractJobPayload()` and `showCaptureToast()`; `gated-handoff.js` `probeFormShape()`, `applyPlan()`, `applyOverlayEdit()`; `review-overlay.js` `renderOverlay()`; `popup.js` ATS Score Tool. | *Browser Extension* — "If you click **ATS Score Tool** … it copies the visible text of that page". *Filling an Application* — "enters them into that employer's form". | Injects a one-off script into the invoked tab to read the posting, collect text for an ATS score, fill the form and render the review panel. Nothing is injected into any other tab, and nothing is registered to run persistently. |
| `storage` | `background.js` `reportCapture()` (`storage.local`, last capture) and `reportHandoff()`; `gated-handoff.js` `savePacketForTab()`, `loadPacketForTab()`, `clearPacketForTab()`, `sweepExpiredPackets()` (`storage.session`). `options.js` uses `storage.sync` only to DELETE a value the retired shortcut recorder left behind. | *What the Extension Stores in Your Browser* — both items, each with its lifetime, plus the retired third. | Stores the result of the most recent capture so the popup can show the outcome of a hotkey capture it was not open for, and — during a handoff only — the prepared answers, in memory-backed session storage with a 10-minute expiry, cleared when the tab closes. |

**Declared nowhere, deliberately:** `tabs`, `cookies`, `notifications`, `history`, `webNavigation`,
`<all_urls>`. Each is asserted absent by `test/manifestMinimumPermission.test.js`; the reasoning is
in `extension/MANIFEST_RATIONALE.md`. The policy's matching negative claims are "does **not** read,
store, or transmit your session cookies, login credentials, or any authentication tokens" and "does
**not** collect your browsing history".

## Host permissions

**One, and it is our own server.** No job board, no employer portal, nothing the extension reads a
job from. Capture injects under the `activeTab` grant the user's invocation creates, so the
extension needs no standing access to any site in order to capture from it — and holds none.

| Manifest host | Code that requires it | Policy paragraph | Dashboard justification |
|---|---|---|---|
| `https://resumemaster.one/*` | `background.js` — `importCapturedJob()` posts `/api/import/job`, the `PROBE_AUTH` handler calls `/api/auth/me`, `recordGateReview()` posts `/api/apply/gate-review`, `advanceBatch()` calls `/api/apply/gate-packets`; `gated-handoff.js` `api()` and its resume fetch. All `credentials:'include'`, no embedded secret. | *Browser Extension* — "Data extracted by the extension is sent to resumemaster.one and associated with your logged-in account using a browser session cookie". | Our own backend. The extension fetches with the user's existing session cookie; it never reads the cookie's value. |

**No content script is declared**, so there is no origin the extension runs on automatically. The
policy's central claim — "reads nothing until you invoke it" — is true because of that absence, and
`test/privacyReconciliation.test.js` fails if any non-`resumemaster.one` host is declared again,
because the claim would stop being true the moment one is.

## Data flows with no permission of their own

Not every disclosure hangs off a permission. These are the flows a reviewer will see in the code,
and each still needs a policy paragraph.

| Flow | Code | Policy paragraph | Retained server-side? |
|---|---|---|---|
| Captured job posting → the user's account | `background.js` `captureActiveTab()` then `importCapturedJob()`, which posts `/api/import/job`; the page is read by `extractor.js` `extractJobPayload()` | *Job Listings*, *Browser Extension* | Yes — title, company, location, description, URL, in `scraped_jobs`, linked to the account |
| ATS Score page text → `/ats-score?jd=…` | `popup.js` ATS button collects via `chrome.scripting` → `background.js` `OPEN_ATS_SCORE` opens the tab | *Browser Extension*, ATS bullet — states plainly that the text travels in the URL and may appear in server logs | Only as ordinary request logs; not stored as a record |
| The capture confirmation shown in the page | `extractor.js` `showCaptureToast()`, injected by `background.js` `reportCapture()` after a capture the user asked for | *Browser Extension*, ATS bullet — "no longer changes the appearance of any page except to show you a confirmation message after a capture you asked for" | Not a data flow; disclosed because it is the only thing the extension puts on a page |
| Job description → Anthropic | server-side ATS scoring / enrichment | *Browser Extension*, fifth bullet, cross-referencing *Third-Party Services* | Per Anthropic's API terms; not used for training |
| Profile answers → employer's form | `gated-handoff.js` fill | *Filling an Application* | Not retained by us; released into the page the user opened |
| Form **structure** → our server (opt-in, default OFF) | `gated-handoff.js` schema capture, server-enforced consent | *Learning an Application Form* | Yes, as a fact about the employer's form; not linked to the user |

## Negative disclosures, and the code that makes them true

| Policy claim | Why it is true |
|---|---|
| No browsing-history collection | No `history`, `tabs` or `webNavigation` permission, and now no host permission for any site either — a tab's URL is readable only after the user invokes the extension on it. `e2CaptureConvergence.mjs` asserts the negative directly: before invocation the extension cannot see the job tab at all. |
| No scraping of job lists or saved-job lists | `saved-jobs-content.js` and `SCRAPE_SAVED_JOBS` are absent from source and from the packed zip — asserted by `test/extensionSubmission.test.js`. |
| Nothing is read until you invoke it, and only that tab | No content script and no job-board host permission exist, so there is no origin the extension can run on unbidden. Every read — capture, ATS, handoff — is an `executeScript` into the tab an invocation just granted. |
| No remotely hosted code | CSP `script-src 'self'`; no `eval`, `new Function`, `importScripts` or remote `<script src>` anywhere in the bundle. |
| No sale of personal data; no unrelated transfer; no creditworthiness use | No such code path exists. Third parties are enumerated in *Third-Party Services*: Railway, Anthropic, SerpApi, Apify, Adzuna, Clearbit Logo API, LinkedIn OAuth. |
| Nothing pushes data into the extension | `externally_connectable` absent — no website can message it. |

## Dashboard — Privacy practices tab

Single purpose, permission justifications and the data-use answers are in `STORE_LISTING.md`, which
is the copy actually pasted into the dashboard. This file is the join that proves those answers are
not inventions.

Data types to declare **collected**: *Personally identifiable information* (job captures are
account-linked; the handoff moves the user's own name, email, phone, address and work-authorization
answers) and *Website content* (job posting text, ATS Score page text, and opt-in form structure).

Declared **not collected**: authentication information, web history, user activity, health,
financial, personal communications, location.

## Before submitting

- [ ] The policy is **deployed**, not just committed — `PrivacyPage.jsx` renders at
      `https://resumemaster.one/privacy` and shows the current Effective date.
- [ ] That URL returns **200 anonymously**, with no redirect and no sign-in.
- [ ] `npm test` — `privacyReconciliation.test.js` and `manifestMinimumPermission.test.js` pass.
