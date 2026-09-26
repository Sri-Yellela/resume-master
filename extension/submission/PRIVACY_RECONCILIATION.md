# Privacy reconciliation — manifest × code × policy × dashboard

The 2026-08-01 Web Store rules are enforced by cross-checking three documents against each other:
the **manifest**, the **privacy policy** at `https://jobsviadraft.com/privacy`, and the **Privacy
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
`https://jobsviadraft.com/privacy` (source: `client/src/pages/marketing/PrivacyPage.jsx`).

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
| `storage` | **Six keys, two areas.** `background.js` `reportCapture()` → `lastCapture` (`storage.local`); `background.js` `reportHandoff()` → `lastGatedHandoff` (`storage.session`); `gated-handoff.js` `savePacketForTab()`, `loadPacketForTab()`, `clearPacketForTab()`, `sweepExpiredPackets()` → `gate:{tabId}` (`storage.session`); `gated-handoff.js` `saveBatchForTab()`, `loadBatchForTab()`, `clearBatchForTab()` → `batch:{tabId}` (`storage.session`); `auth.js` `storeToken()` → `authToken` and `getIdentity()` → `authIdentity`, both (`storage.local`), both removed by `clearStoredToken()`. `options.js` uses `storage.sync` only to DELETE a value the retired shortcut recorder left behind. | *What the Extension Stores in Your Browser* — **all six items**, each with the area it lives in and its real lifetime. ⚠ Only `gate:` gets the ten-minute expiry; the policy says so rather than implying it covers everything. ⚠ `authToken` is the ONE stored value that is transmitted, and the policy names it as such. | Six values. In `chrome.storage.local`: the result of the most recent capture, so the popup can show the outcome of a hotkey capture it was not open for; the account the extension is connected to, so the popup can name it; and the extension's own access token, which is sent with each request to our backend and to nowhere else. In `chrome.storage.session` (memory-backed, discarded on browser restart): the prepared answers for an application in progress, with a 10-minute expiry and cleared when the tab closes; the result of the most recent form fill; and, when several applications are queued for one employer site, that site's origin and how many remain. |

⚠ **The storage row was wrong until 2026-09-15, and this is how.** The policy said the extension
keeps "two things" and enumerated `lastCapture` and the packet. It writes four.
`background.js` `reportHandoff()` was cited in this table's code column while the policy paragraph
it pointed at described only the other two, and `gated-handoff.js` `saveBatchForTab()` was cited
nowhere at all — so the join looked complete in both directions while an undisclosed key sat on each
side of it. `gated-handoff.js` `sweepExpiredPackets()` filters on `k.startsWith('gate:')`, which
means `lastGatedHandoff` and `batch:{tabId}` never got the expiry the policy promised; they live
until the browser restarts, or until `chrome.tabs.onRemoved` fires for `batch:`. The fix was to the
**policy**, not the code: two undisclosed session keys are honest behaviour with dishonest
documentation, and deleting a key to make a sentence true would have been the wrong direction.
**Follow-up, deliberately not done here:** the sweep arguably should cover every session key rather
than just `gate:`, since the policy promised an expiry two of four did not get. That is a behaviour
change and belongs in its own commit.

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
| `https://jobsviadraft.com/*` | `auth.js` `authedFetch()` is the single network path, and `bootstrapToken()` is the single credentialed one. Through it: `background.js` `importCapturedJob()` posts `/api/import/job`, the `PROBE_AUTH` handler calls `/api/auth/me`, `recordGateReview()` posts `/api/apply/gate-review`, `advanceBatch()` calls `/api/apply/gate-packets`; `gated-handoff.js` `api()` and its resume fetch. Every one of them is `credentials:'omit'` and carries the extension's own bearer token; no secret is embedded in the package. | *Browser Extension* — "Data extracted by the extension is sent to … and associated with the account you connected the extension to … it sends the token and not the browser cookie". | Our own backend. The extension identifies itself with a token it obtained for itself, not with the browser's session cookie, so it acts only as the account the user connected it to. |

**No content script is declared**, so there is no origin the extension runs on automatically. The
policy's central claim — "reads nothing until you invoke it" — is true because of that absence, and
`test/privacyReconciliation.test.js` fails if any non-`jobsviadraft.com` host is declared again,
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
| No sale of personal data; no unrelated transfer; no creditworthiness use | No such code path exists. Third parties are enumerated in *Third-Party Services* — see the verified table below, which replaces the stale enumeration this row used to carry. |
| Nothing pushes data into the extension | `externally_connectable` absent — no website can message it. |

## Third-party recipients — verified against live code, 2026-09-15

This row used to be a flat list inside the negative-disclosures table, and it went stale for five
weeks: it named **Clearbit Logo API** as a recipient and omitted **DuckDuckGo Icons**, which is the
provider browsers actually request. Task X swapped them on 2026-09-08 and the deployed policy has
been right ever since — only this file was wrong. A named processor that receives nothing is a false
disclosure in the same way an undisclosed one is a gap, so each entry now carries its live status.

| Named in the policy | What reaches it | Code | Live status |
|---|---|---|---|
| **Railway** | hosting; everything | the deployment itself | **live** |
| **Anthropic** | job descriptions, résumé content | `services/jobs/enrichJob.js` and generation, via `resolveProvider()` | **live** — `ANTHROPIC_KEY` set, Haiku per A2 |
| **SerpApi** | search terms and filters | `services/jobs/aggregator.js` `searchJobs()`; reached by `POST /api/jobs/search` | **live in production** (`SERPAPI_KEY` set). Absent from `cacheJobs` by design — `ATS_SOURCE_NAMES` only. ⚠ Not set locally, which is the only reason a local boot logs `Inactive (not configured): adzuna, serpapi`; that line describes the dev box, not production |
| **Apify** | job titles, locations, filters for one refresh | per-user `apify_token` set via `/api/settings/apify-token`; reached only by `adminDb.js` `scrapeJobs()` behind an admin force-scrape | **conditional, and the policy says so** — "if you have not connected a token, nothing is ever sent". True whether or not any user has |
| **Adzuna** | search terms and filters | `services/jobs/sources/adzuna.js` `isConfigured()` requires **both** `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` | ⚠ **OVER-DISCLOSED.** Neither variable is in the Railway inventory, so in production Adzuna is inactive and receives **nothing**. Both are set locally. The policy states flatly that search terms "are sent to Adzuna when you search" — true on a dev box, not true of the deployed product |
| **Job boards we search directly** | search terms and filters | the seven ATS plugins, all now reached via `services/jobs/aggregator.js` `groupCompaniesByAtsType()` | **live** |
| **DuckDuckGo Icons** | a company domain, in an image URL | `LOGO_HOST` in `shared/companyLogos.js` | **live** — the only logo provider |
| **LinkedIn OAuth** | name, email, on opt-in sign-in | OAuth callback | **live, optional** |
| *Clearbit Logo API* | **nothing** | appears only in `services/jobs/backfillCompanyLogos.js` `RETIRED_LOGO_HOSTS`, a repair list that rewrites bad rows | **retired.** Named in the policy only as the thing DuckDuckGo replaced, which is the correct way to name it |
| *THEIRSTACK* | **nothing** | only consumer is the offline `scripts/providerEval` harness | **vestigial, and correctly NOT named in the policy** |
| *Google Fonts* | **nothing** — self-hosted since 2026-09-15 | four `@fontsource/*` packages imported in `client/src/main.jsx`, served from our own origin. Guarded by `test/selfHostedFonts.test.js` | **retired.** Was a real recipient of every visitor's IP and user-agent until that date, on every page, and the policy had never named it. Now named the way Clearbit is — as a former recipient that receives nothing |

✅ **Google Fonts — FIXED 2026-09-15, and it was worse than first reported.** The finding was that
`client/index.html` preconnected `fonts.googleapis.com` / `fonts.gstatic.com` and loaded two
families, handing Google every visitor's IP and user-agent on every page including the privacy page
itself, while *Third-Party Services* named no such recipient — the same shape as the Google S2
favicon fallback task X removed.

**There were TWO call sites and FOUR families, not one and two.** `client/src/index.css` line 1 also
carried `@import url('https://fonts.googleapis.com/…Instrument+Serif…Inter…')`, which the first
sweep of `index.html` missed entirely and which was confirmed live in the deployed CSS. Self-hosting
only the two families named in the original finding would have left Google receiving the same
request on the same page and made the policy's new claim false. That second site is the reason
`test/selfHostedFonts.test.js` walks the whole `client/` tree rather than checking the two files
that were wrong.

All four are now `@fontsource/*` packages imported in `client/src/main.jsx` — exactly the weights
the two retired requests asked for — served from our own origin. `EFFECTIVE_DATE` moved to
September 15, 2026 for this and the storage change; both reduce what leaves the browser, so neither
triggers the policy's advance-notice commitment, which covers changes adverse to a user.

### What is machine-guarded, and what is not

`test/privacyReconciliation.test.js` now asserts that **this table's named set matches the set the
policy names** — that was the actual reason the Clearbit row rotted unnoticed. The existing
third-party test only ever checked the *policy* against the code, never this file's own
enumeration, so both directions of that row were unguarded while the rest of the join was covered.

Still **manually maintained and unguarded**: the *Live status* column above (it depends on
deployment environment variables, which no offline test can read), and whether a paragraph is
honest prose. Those need a human.

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
      `https://jobsviadraft.com/privacy` and shows the current Effective date.
- [ ] That URL returns **200 anonymously**, with no redirect and no sign-in.
- [ ] `npm test` — `privacyReconciliation.test.js` and `manifestMinimumPermission.test.js` pass.
