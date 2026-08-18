# Manifest rationale — why each declared thing is declared

Every entry in `manifest.json` justified against the code that requires it, at v1.0.0.

**Why this is a file and not comments in the manifest.** Chrome tolerates `//` comments in
`manifest.json`, but `scripts/buildExtension.mjs`, `scripts/publishExtension.mjs` and two test files
all `JSON.parse` it, and the Web Store's own validator is not something to gamble on for a first
submission under the 2026-08-01 rules. The manifest stays strict JSON; the justification lives here
and is **enforced** — `test/manifestMinimumPermission.test.js` fails if a declared permission or host
has no row below, or if a row names something no longer declared. A rationale that can drift is not
a rationale.

The rule applied throughout: **if removing it breaks nothing, it is not declared.** For `storage` and
`scripting` the "what breaks" column is not reasoning — it was measured, by building the extension
without each one, loading it in a real Chrome and confirming the API namespace is gone. See
`scripts/e3PermissionAudit.mjs`.

`activeTab` is measured differently, and the difference is worth stating rather than hiding. It grants
access rather than an API, and only in response to a real user gesture that no API can mint — so a
probe that removes it and looks from inside an extension page distinguishes nothing: with `activeTab`
declared but not invoked, a tab the extension has no host permission for is exactly as invisible as it
is without the permission at all. The first version of the audit did exactly that and printed PASS;
run as a control with `activeTab` present it printed the same thing, so it was measuring nothing. The
real measurement is `scripts/g0ActiveTabSpike.mjs`, which delivers a genuine OS-level `Ctrl+Shift+Y`
to a focused Chrome running this manifest, with host permissions covering none of the test origins so
injection can only succeed through the grant. Its control trial C — navigate to another origin — shows
access **revoked**, which is the removal case. Findings: `docs/GATED_HANDOFF_ARCHITECTURE.md` §9.

---

## Permissions

| Permission | Required by | What breaks without it |
|---|---|---|
| `activeTab` | `background.js:112` (hotkey capture), `background.js:130` (gated handoff), `popup.js:9` (`getCurrentTab`) | The gated handoff cannot reach the portal at all — there is deliberately no host permission for any portal origin, so this grant, taken per tab at the moment the user invokes the extension, is the only access that exists. Injection fails with "Cannot access contents of the page". |
| `scripting` | `gated-handoff.js:398,452,486,521,656` (probe, fill, overlay, edits), `popup.js` ATS button | `chrome.scripting` is undefined. The gated handoff cannot read a form, fill one, or render the review overlay; the ATS-score button cannot collect the page text. |
| `storage` | `background.js:67` (`storage.local` last capture), `background.js:147,190` + `gated-handoff.js:259-308` (`storage.session` packets and batch state), `options.js` (`storage.sync` shortcut) | `chrome.storage` is undefined. The custom capture shortcut cannot be saved, the popup cannot show the result of a hotkey capture it was not open for, and the handoff cannot hold a packet across an MV3 service-worker teardown. |

**Not declared, deliberately:**

- `tabs` — `activeTab` plus the host permissions below already give every tab URL the extension needs
  to read. A blanket `tabs` grant would expose the URL and title of *every* open tab.
- `cookies` — the extension never reads a cookie. Credentialed requests carry the user's session
  because `credentials: 'include'` lets the browser attach it; nothing reads its value. (The retired
  v0.1.0 builds declared this; they are deleted.)
- `notifications` — the handoff reports through `chrome.action`'s badge instead, so no additional
  user-facing consent prompt is requested for a status message.
- `<all_urls>` — never. See host permissions.

## Host permissions

Narrowed at v1.0.0 from whole-domain (`https://*.linkedin.com/*`) to the exact job-view paths. They
exist for **one** reason: without a host permission matching a tab, `tab.url` is hidden from the
extension, and `popup.js`'s `init()` cannot tell whether it is looking at a job page — so the capture
button never appears. They therefore need to cover only the paths the content script already matches.

| Host | Required by | What breaks without it |
|---|---|---|
| `https://resumemaster.one/*` | `background.js` — every server call | The service worker's fetches become subject to CORS. `corsOrigin` refuses `chrome-extension://` in production, so capture, the auth probe and the whole handoff fail. |
| `https://www.linkedin.com/jobs/view/*` | `linkedin-content.js:43-63` extractor + `popup.js` `isJobPage` | `tab.url` hidden → the popup shows no capture button on a LinkedIn job. |
| `https://www.indeed.com/viewjob*` | same | same, for Indeed |
| `https://www.glassdoor.com/job-listing/*` | same | same, for Glassdoor |
| `https://jobs.lever.co/*/*` | same | same, for Lever |
| `https://job-boards.greenhouse.io/*/*` | same | same, for Greenhouse. This is the host postings actually live on: `boards.greenhouse.io` 301s here for every board, so the old declaration could never run a content script and was dropped rather than kept alongside. |
| `https://*.workable.com/j/*` | same | same, for Workable |

**No portal origin is declared** — not Workday, not Amazon, not Meta. The gated handoff reaches those
pages only through `activeTab`, granted per tab by the user's own invocation. That is the design's
central security property and it is why the handoff needed no new permission.

## Content scripts

`matches` is the same six job-view paths, never a bare domain wildcard. Each one has a real extractor
behind it in `linkedin-content.js:43-63`; there is no host matched without one.

## Commands

| Command | Default | Feature |
|---|---|---|
| `capture-job` | `Ctrl+Shift+K` | Capture the posting in view. One implementation, shared with the popup button (E2). |
| `fill-gated-application` | `Ctrl+Shift+Y` | The gated handoff. `Ctrl+Shift+G` was the first choice and Chrome silently refuses to bind it — it is Chrome's own find-previous — leaving a command with no key. |

## Deliberate absences

- **`externally_connectable` is ABSENT AND MUST STAY ABSENT.** With it, a website could message the
  extension. The design inverts that on purpose: nothing pushes inward, the extension *pulls* from
  our server with the user's own session. Adding this key would not "fix" anything; it would remove a
  security property. Asserted by `test/extensionGatedHandoff.test.js`.
- **No remotely hosted code.** MV3 forbids it and nothing loads any — no `eval`, no `new Function`,
  no `importScripts`, no remote `<script src>`.
- **`popup.css` is deleted, not unshipped.** It was the v0.1.0 stylesheet, superseded by the inline
  `<style>` block in `popup.html`; it had been excluded from every build since v1.2.0 and nothing
  referenced it.
