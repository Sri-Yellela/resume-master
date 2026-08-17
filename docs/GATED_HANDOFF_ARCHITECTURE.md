# Gated Portal Handoff — Architecture

**Status:** DESIGN. Nothing built. Depends on a prerequisite that is currently broken (§7).

**Problem.** Portals like Meta, Amazon, Google and per-tenant Workday require an account, and
often a CAPTCHA or identity verification, before an application can be submitted. `classifyFlowState`
already detects these at runtime (`login_required`, `captcha_required`) and correctly HOLDS. This
document describes how to turn that dead end into a completion without automating the gate itself.

**Non-goal, permanently.** Defeating a CAPTCHA, automating identity verification, or creating
accounts headlessly. These are not deferred items — they are outside scope by design. The human
crosses the gate. Everything else is prepared for them in advance.

---

## 1. Why the obvious approaches fail

**Iframe — dead, two independent reasons.** Every major portal sends `X-Frame-Options: DENY` or
CSP `frame-ancestors 'none'`. And even against one that didn't, same-origin policy blocks DOM
read/write, so you would have a picture of a form you cannot touch. Do not revisit.

**Server-side session replication — rejected.** Storing candidates' portal passwords is a security
liability taken on per-user, and automated account creation generally violates those sites' terms.
The design below needs neither.

**Puppeteer through the gate — rejected.** The gate is the part a human must do. Driving a
headless browser to the gate and stopping there is what happens today; the problem is what comes
after.

---

## 2. The mechanism: `activeTab` + `scripting`, pulling not pushing

The extension manifest already carries exactly what is needed:

```json
"permissions": ["activeTab", "scripting", "storage"]
```

`activeTab` grants access to the tab the user is on **at the moment they invoke the extension** —
no host permission for that origin required. The user clicking "Review" IS the granting gesture.

This makes the design permission-minimal by construction:
- No `<all_urls>` host permission (a Web Store review problem and a privacy red flag).
- No stored portal credentials — the user's own browser already holds the authenticated session.
- The server never sees a session cookie or a password.

**Direction matters.** `externally_connectable` is absent from the manifest, so the website cannot
message the extension. Invert it: the **extension fetches the packet from our server** with
`credentials: 'include'`, exactly as `extension/linkedin-content.js:369` already does against
`/api/import/job`. Nothing pushes inward, so the missing manifest key never becomes a blocker.

---

## 3. Flow

```
1. QUEUE       user queues a gated job
2. PREPARE     server: JD analysis, resume generation, answer resolution with provenance
               (all machine work happens BEFORE the human is involved — see §4 Latency arbitrage)
3. CLASSIFY    gate detected -> status held_gate, NOT failed. Packet stored, token minted.
4. NOTIFY      "Sign in to Amazon once -> 7 applications ready"   (see §4 Amortization)
5. HANDOFF     user clicks Review -> portal opens in their own tab
6. GATE        user authenticates / completes CAPTCHA themselves. We do nothing here.
7. INVOKE      user triggers the extension (action click or hotkey) -> activeTab granted
8. MATCH       extension verifies tab origin == job's apply host AND a form is present
9. RELEASE     extension exchanges the single-use token for the packet, injects values + resume
10. REVIEW     provenance overlay: low-confidence and eligibility answers surface first
11. SUBMIT     the user submits. Always the user.
12. LEARN      extension returns the form SCHEMA (structure only, no answers) -> KB
```

---

## 4. The four design decisions that make this worth building

**Latency arbitrage.** All machine time is spent before the human arrives. When they show up every
decision is already made, so they spend attention on review and never on waiting. This is the
organizing principle; most implementations make the user sit through the automation.

**Amortize the gate per PORTAL, not per application.** Once authenticated at Amazon, that session
serves every queued Amazon job. Group the held queue by apply host and present one gate crossing
that unlocks a batch. A ten-second CAPTCHA releasing seven applications is a different product
from seven separate manual reviews. This is the highest-leverage item here and it is a reframing,
not additional machinery.

**Learn the form schema through the gate.** Behind a gate is a place our server can never reach —
but the extension is standing inside it. Capture the form's STRUCTURE (labels, types, required
flags, option lists) and return it. Not answers. The shape.

The first user through Amazon's portal teaches the system Amazon's form; every later user's packet
arrives pre-mapped and their review is shorter. A compounding asset extracted from a constraint,
and it only accumulates from real users crossing real gates. It is also the same
`company_application_forms` store that imported-careers-page support needs — a form schema is a
fact a company publishes about itself, so it sits cleanly on the companies-and-roles side of the
§7 integrity line.

**Review as a provenance overlay, not a form read-through.** The answer resolver already records
whether each value came from an exact `handler_map` hit or a fuzzy label guess. Render a card over
the real form showing value + provenance, sorted so low-confidence and eligibility answers come
first. One click approves and commits into the real inputs. Review becomes ten seconds checking
three uncertain fields rather than two minutes reading thirty certain ones — and it produces the
audit trail for free.

---

## 5. Technical constraints — verified and unverified

**File injection into `<input type="file">` IS possible** from a content script: construct a
`File`, attach it to a `DataTransfer`, assign to `input.files`, dispatch `change`. This is the
piece usually assumed impossible, and it is what makes the resume travel with the packet rather
than being the one thing left manual. Fetch the resume as a blob inside the extension.

**React-controlled inputs need the native setter.** These portals are React apps that track input
value internally; assigning `.value` directly is silently reverted on re-render. Use the native
property descriptor's setter, then dispatch `input`/`change`. Applies to text fields as well as
the file case.

**MV3 service workers are ephemeral.** No packet state in memory. `chrome.storage.session` (not
persisted to disk, cleared on browser restart) scoped per tab, with a TTL.

**SETTLED — the activeTab lifetime question.** Measured in G0; full findings in §9. The grant
survives same-origin step navigation of every mechanism tested, including full document loads, so
the interaction model is one gesture per application. The boundaries that do cost a re-invoke are
leaving the origin and the portal opening a step in a new tab.

**Packet release must be target-matched.** Signed, single-use, short-TTL token, exchanged only when
tab origin matches the job's apply host AND a form is present. The packet carries a home address
and work-authorization answers; a stray release onto the wrong page is a data leak, not a bug.

---

## 6. Integrity boundary

- The human crosses every gate and submits every application. No exceptions.
- Schema capture returns structure only. Never a user's entered values, never anything about the
  user, never anything from a page other than the form's shape.
- Eligibility answers (work authorization, sponsorship, clearance, veteran/disability) surface at
  the TOP of the review overlay regardless of confidence. These are attestations to an employer,
  not form-filling convenience.
- No credential storage. The design's security property is that our server never holds a session.

---

## 7. Prerequisite — currently broken, blocks §4's schema capture

Field discovery returns **zero fields** on a JS-rendered ATS (observed live against Ashby: run
completed in 9s, `autofill_done` with 0 fields, reported misleadingly as "browser error"). Amazon
and Meta are heavier SPAs than Ashby.

Building schema capture before discovery is reliable would persist EMPTY schemas — caching the bug
into the asset that is supposed to compound. Fix discovery before task G4.

Correction (G0, from reading the repo rather than this doc): the second half of that instruction is
already done. `scripts/fakeAts.js` has served a JS-rendered `/spa` route since the hydration fix —
fields injected in two chunks after a configurable delay, specifically so a discovery pass that does
not wait for a readiness condition walks an empty DOM. Whether discovery is now reliable against it
is a separate question and still G4's gate; it has not been re-measured here.

---

## 8. Open decisions

- ~~Does the `activeTab` grant survive in-portal step navigation?~~ **SETTLED in G0 — see §9.**
- Web Store re-submission: the extension is published at v1.2.0. Any manifest change ships on
  review latency. Batch manifest changes into one submission.
- Whether `held_gate` is a new terminal status or a reason code on the existing `held_review`.
- Whether schema capture is opt-in per user. It sends no personal data, but it does report on a
  page behind that user's authenticated session, which is worth an explicit consent decision.

---

## 9. G0 findings — `activeTab` grant lifetime (measured, not inferred)

Harness: `scripts/g0ActiveTabSpike.mjs`. Real headful Chrome 151, the real `extension/` manifest
copied verbatim (`activeTab` + `scripting` + `storage`, host permissions unchanged and covering
none of the test origins, so injection can only succeed through the grant). The grant is taken by
a real OS-level `Ctrl+Shift+Y` keypress delivered to the focused Chrome window, because a
`chrome.commands` invocation is the only automatable way to produce a genuine user gesture — there
is no API that mints an `activeTab` grant, which is the whole security property. A service worker
then attempts `chrome.scripting.executeScript` into the granted tab every 400ms and records whether
it still succeeds.

**Result: the navigation mechanism is irrelevant. The origin is what matters.**

| Case | Mechanism | Verdict |
|---|---|---|
| A | `history.pushState` + DOM rewrite, same document | SURVIVED |
| B | form POST → new document, same origin | SURVIVED |
| D | reload of the same URL | SURVIVED |
| E | `location.assign` → new document, same origin | SURVIVED |
| F | browser-initiated (CDP) navigation, same origin | SURVIVED |
| R2 | real Workday tenant, browser-initiated same-origin navigation | SURVIVED |
| R3 | real Workday tenant, page-initiated same-origin navigation | SURVIVED |
| **C** | **navigation to a different origin (control)** | **REVOKED** |

Document identity was verified per trial via `performance.timeOrigin`, so "same document" is
observed rather than assumed from the mechanism's name. Trial C is a control, not a case of
interest: without an observed revocation, a silently broken probe would report that the grant
survives everything, and the harness refuses to state a finding if C does not revoke.

### Interaction model: one gesture per application

For as long as the flow stays on one origin in one tab, neither a step transition nor a full page
load costs a re-invoke. G2 can be built on a single user gesture. Two things break that:

1. **Leaving the origin.** An SSO hop to a different host revokes the grant. This is the realistic
   failure on the gated portals this design targets — the sign-in itself often lives on another
   host, so the user may cross the gate and land back with the grant already gone. G2 must treat a
   revoked grant as an expected state with a clear re-invoke prompt, not an error.
2. **A new tab.** Observed on a real Workday tenant: its job links are `target="_blank"`. The grant
   is per-tab and does not follow. Any portal that opens its apply step in a new tab needs the
   gesture repeated there, and G5's per-portal batching cannot assume one tab per portal session.

### Consequences for the other tasks

- **A grant surviving does not mean the page is unchanged.** Because the grant persists across
  same-origin navigation, "we still have access" no longer implies "still the same form". Origin
  matching alone is therefore not sufficient for packet release (§5, G2 requirement 3): the target
  match must also pin the specific page, or a packet minted for one job on a portal can be released
  onto a different job on the same portal.
- **`chrome.storage.session` outlived every transition, including the ones that revoked the
  grant.** A packet therefore outlives its own grant: a re-invoke can resume without re-fetching
  (so the single-use token in G1 must not be the only thing standing between a re-invoke and a
  usable packet), and G2 requirement 6's clearing has to be deliberate, because nothing else will
  do it.
- **`world: 'MAIN'` injection works under `activeTab` alone.** G2 requirement 4's native-setter path
  and requirement 5's `DataTransfer` file attach both need the main world; no extra permission is
  required to reach it.
- **`chrome.tabs.get().url` returns `undefined` without access to that tab.** Fine for G2, which
  reads the URL after the grant exists, but it means the URL cannot be used to decide whether to
  ask for a gesture.

### Caveats

- Chrome 137+ ignores `--load-extension`, so the harness installs over CDP
  (`Extensions.loadUnpacked`), which requires `--enable-unsafe-extension-debugging`. That flag opens
  the Extensions CDP domain and does not touch grant or revocation logic; Trial C confirms
  revocation still behaves normally under it. It does mean any future extension test harness cannot
  use `--load-extension`.
- One real-portal case was NOT established: a portal's own same-document route change. Workday sends
  job detail to a new tab (R1) and paginates without changing the URL (R4), so neither reached one.
  It is entailed by the same-origin results rather than measured — if replacing the document
  entirely on the same origin does not revoke, a route change that does not replace the document
  cannot. Trial A measures the mechanism itself on the fixture.
- The real-portal phase (`--real`) was read-only: navigation and control counting on a public
  careers page. No field was typed into, no submit control clicked, no apply flow entered.

Reproduce with `node scripts/g0ActiveTabSpike.mjs --real`. It refuses to report a finding unless the
control trial shows a revocation, and marks a trial VOID rather than SURVIVED when the transition it
was supposed to test did not actually happen.
