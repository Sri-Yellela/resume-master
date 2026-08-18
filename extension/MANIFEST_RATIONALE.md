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
| `storage` | `background.js` `reportCapture()` (`storage.local` last capture), `background.js:147,190` + `gated-handoff.js:259-308` (`storage.session` packets and batch state) | `chrome.storage` is undefined. The popup cannot show the result of a hotkey capture it was not open for, and the handoff cannot hold a packet across an MV3 service-worker teardown. (`storage.sync` is no longer used: the custom-shortcut recorder it backed was retired with the content script, and rebinding is now Chrome's own.) |

**Not declared, deliberately:**

- `tabs` — `activeTab` already gives the extension the only tab URL it needs: the one the user just
  invoked it on. A blanket `tabs` grant would expose the URL and title of *every* open tab, which is
  the opposite of what this design is for.
- `cookies` — the extension never reads a cookie. Credentialed requests carry the user's session
  because `credentials: 'include'` lets the browser attach it; nothing reads its value. (The retired
  v0.1.0 builds declared this; they are deleted.)
- `notifications` — the handoff reports through `chrome.action`'s badge instead, so no additional
  user-facing consent prompt is requested for a status message.
- `<all_urls>` — never. See host permissions.
- **any job board or employer origin** — no longer needed at all, and that is the point. See host
  permissions.

## Host permissions

**There is exactly one, and it is our own server.** No job board is declared. No employer portal is
declared. Nothing the extension reads a job from is declared.

That is not a narrowing of the old list, it is a different mechanism. Capture used to run from a
CONTENT SCRIPT, which needs a host permission for every origin it runs on — so the extension could
only capture from sites the manifest named, and naming them was also what let `popup.js` read
`tab.url` to decide whether to show the button. Seven hosts bought six job boards, and no more:
a Greenhouse posting embedded on an employer's own careers domain was unreachable, and there is no
list of employer domains to add.

Capture now injects on demand under the `activeTab` grant the user's own invocation creates, which
is the same mechanism the gated handoff has always used to reach a Workday tenant it has no
permission for. The extension therefore captures from ANY job page while asking for access to NONE
of them, and it holds no standing access to any site at any time.

| Host | Required by | What breaks without it |
|---|---|---|
| `https://resumemaster.one/*` | `background.js:26` `/api/import/job`, `:76` `/api/auth/me`, `:195` `/api/apply/gate-review`, `:216` `/api/apply/gate-packets`; `gated-handoff.js:338,469` | The service worker's fetches become subject to CORS. `corsOrigin` refuses `chrome-extension://` in production, so capture, the auth probe and the whole handoff fail. |

Measured, not argued: `scripts/e6PopupGrant.mjs` opens a real popup by a real invocation on an
origin with no host permission and confirms it can both read `tab.url` and inject; its control arm —
the same page opened as an ordinary tab, which is not an invocation — can do neither.
`scripts/e2CaptureConvergence.mjs` then captures from a fixture origin the manifest does not cover,
from both triggers, and asserts first that the extension cannot even see that tab until invoked.

**No portal origin is declared** — not Workday, not Amazon, not Meta. Nor any job board. Every page
the extension reads is reached per-tab, per-invocation, by the user's own gesture.

**`extractor.js` has a Workday entry, and that is not a contradiction.** The selector map says how to
read a page IF the user invokes capture on one; it grants nothing and is consulted only after access
already exists. Workday is also the portal the gated handoff fills, so the temptation to "make it
work properly" by adding `*.myworkdayjobs.com` to `host_permissions` is exactly the mistake to avoid:
it would convert a per-invocation grant into standing access to every tenant the user can reach.
`test/manifestMinimumPermission.test.js` fails if a workday host is ever declared.

## Content scripts

**None.** The extension declares no content script and injects nothing on page load.

This is the change that removed the six job-board host permissions, and it is worth stating as a
privacy property rather than a refactor: there is no longer any page the extension runs on
automatically. Before, six sites were read whenever a tab of theirs was open. Now nothing is read
until the user presses the shortcut or opens the popup, and only the tab they did it on.

The extractor lives in `extractor.js` and is injected by `chrome.scripting.executeScript`. Its
per-site selector map is an OPTIMISATION, not a gate — an unlisted site falls through to a generic
largest-content-block heuristic and still captures, which is exactly what makes an embedded board
work. It currently names LinkedIn, Indeed, Glassdoor, Lever, Greenhouse, Workable, Ashby and
Workday, verified against real postings by `scripts/e5GreenhouseHost.mjs`.

Several of those boards publish JSON-LD, which the extractor prefers over any selector — so a
selector can be wrong and the page still capture perfectly. That is not theoretical: the Ashby entry
once pinned a CSS-module class with a build hash in it and matched nothing, for weeks, invisibly.
e5 therefore re-runs each named board with the JSON-LD deleted, so the selectors have to do the work
they exist for, and a test rejects build-hashed class names outright.

## Commands

| Command | Default | Feature |
|---|---|---|
| `capture-job` | `Ctrl+Shift+K` | Capture the posting in view. One implementation, shared with the popup button (E2), injected under `activeTab` (E7). Rebindable only at `chrome://extensions/shortcuts` — the page-scoped custom override retired with the content script, and it never worked outside six sites anyway. |
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
