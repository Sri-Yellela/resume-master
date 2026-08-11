# Chrome Web Store listing — Resume Master v1.2.0

Copy for the Web Store developer dashboard. Every justification below was written against the
actual code and cites the file that uses the permission, because the dashboard rejects
justifications that don't match observable behaviour.

Upload artifact: `extension/submission/resume-master-extension-v1.2.0.zip`
(build with `npm run build:extension` — never hand-assemble it; see extension/README.md).

---

## What changed since the published v1.1.0

This is the part the review will focus on, since the permission set changed.

| | v1.1.0 (published) | v1.2.0 (this submission) |
|---|---|---|
| Permissions | `activeTab`, `scripting` | `activeTab`, `scripting`, **`storage`** |
| Host permissions | unchanged | unchanged |
| Options page | none | **`options.html`** (capture shortcut settings) |
| Keyboard command | none | **`capture-job`** (default Ctrl+Shift+K / Cmd+Shift+K) |
| Content scripts | 2 blocks | **1 block** |
| LinkedIn saved-jobs scraping | present (`saved-jobs-content.js`, matched `linkedin.com/my-items/*`) | **REMOVED** |

**One permission added, one capability removed.** `storage` is added solely to persist the
user's own capture-shortcut preference and the result of their most recent capture. The
saved-jobs content script — which read the user's LinkedIn saved-jobs *list* — is gone, along
with its `https://www.linkedin.com/my-items/*` match patterns. The extension no longer reads any
list of postings, only the single posting on the page the user is actively viewing.

Worth stating explicitly in the reviewer notes: this release **narrows** what the extension can
observe. The published v1.1.0 bundle still contained that saved-jobs script even though the
product had stopped offering the feature.

---

## Single purpose

> Capture the single job posting on the page you are currently viewing and send it to your
> Resume Master account, so you can score it against your resume and track it on your job board.

---

## Description (matches `manifest.json`)

> Capture the job you're viewing into Resume Master, score it against your resume, or send it
> for ATS scoring.

---

## Permission justifications

**`activeTab`**
> Used only to identify the tab the user is currently looking at when they explicitly trigger
> the extension — clicking the toolbar button or pressing the capture shortcut. The extension
> reads the job posting from that tab only at that moment. It never accesses tabs the user is
> not on, and never acts without a direct user action.

*(Code: `popup.js` and `background.js` both call `chrome.tabs.query({active: true, currentWindow: true})`
only inside a click handler or the `chrome.commands` handler.)*

**`scripting`**
> Used for a single feature: when the user clicks "ATS Score Tool" in the popup, the extension
> injects a one-off script into the current tab to collect the visible job description text, so
> it can be scored against the user's resume. It is not used to modify any page.

*(Code: one call site — `popup.js`, `chrome.scripting.executeScript`.)*

**`storage`** — NEW IN THIS VERSION
> Stores two things belonging to the user, both local to their own browser profile:
> 1. `chrome.storage.sync` — the user's custom capture keyboard shortcut, if they set one on the
>    extension's options page. Sync is used so the preference follows their Chrome profile.
> 2. `chrome.storage.local` — the title/company of the user's most recent capture, so the popup
>    can show them what was last captured.
>
> No job data, browsing history, or personal information beyond the above is stored, and nothing
> in storage is transmitted anywhere.

*(Code: `options.js` and `linkedin-content.js` read/write `captureShortcut`; `linkedin-content.js`
writes and `popup.js` reads `lastCapture`.)*

**Host permission `https://resumemaster.one/*`**
> The extension's own backend. Required to send a captured posting to the user's account and to
> check whether the user is signed in. All requests go to this origin and carry the user's
> existing Resume Master session cookie.

*(Endpoints called: `/api/auth/me`, `/api/import/job`, `/api/extension/save-job`.)*

**Host permissions for job sites**
`https://*.linkedin.com/*`, `https://*.indeed.com/*`, `https://*.glassdoor.com/*`,
`https://*.lever.co/*`, `https://*.greenhouse.io/*`, `https://*.workable.com/*`
> These are the job boards the extension can capture from. A content script runs on individual
> job-posting pages to read the posting the user is viewing when they trigger a capture. The
> content script's match patterns are restricted to job-detail URLs on these sites — it does not
> run across the whole domain.

*(Match patterns in `manifest.json`: `linkedin.com/jobs/view/*`, `indeed.com/viewjob*`,
`glassdoor.com/job-listing/*`, `jobs.lever.co/*/*`, `boards.greenhouse.io/*/*`,
`*.workable.com/j/*`.)*

---

## Data usage disclosures

Tick **only** the following, and certify all three statements at the bottom of the form:

- **Personally identifiable information** — *not collected.*
- **Health / financial / authentication / personal communications / location** — *not collected.*
- **Website content** — **collected.** The text of a job posting the user explicitly captures is
  sent to resumemaster.one so it can be scored and saved to their board.
- **User activity** — *not collected.* No clickstream, browsing history, or analytics.

Certifications (all true for this build):
- Not being sold to third parties.
- Not being used or transferred for purposes unrelated to the item's single purpose.
- Not being used or transferred to determine creditworthiness or for lending purposes.

Privacy policy URL: `https://resumemaster.one/privacy` (already set in `manifest.json`).

---

## Suggested reviewer notes

> v1.2.0 adds one permission and removes one capability.
>
> `storage` is new. It holds only the user's own capture-shortcut preference (`storage.sync`)
> and the title of their most recent capture for display in the popup (`storage.local`). Nothing
> in storage leaves the browser.
>
> This version also removes the previous `saved-jobs-content.js` content script and its
> `https://www.linkedin.com/my-items/*` match patterns. The extension no longer reads any list of
> saved jobs — it reads only the single posting on the page the user is actively viewing, and
> only when they click the toolbar button or press the capture shortcut.
>
> All network requests go to the extension's own backend at resumemaster.one, authenticated with
> the user's existing session cookie. There is no background collection and no auto-apply.

---

## Pre-upload checklist

- [ ] `npm run build:extension -- --check` passes (validates the dev switch is on production,
      the manifest has no BOM, and no referenced file is missing).
- [ ] Version in `manifest.json` bumped and matches the zip filename.
- [ ] Upload `resume-master-extension-v1.2.0.zip`.
- [ ] Update the **Privacy practices** tab for the new `storage` permission — this is the field
      that blocks review most often when a permission is added without a matching justification.
- [ ] Screenshots: if any show the old LinkedIn saved-jobs import flow, replace them — that
      feature no longer exists and a screenshot of a removed capability invites a rejection.
