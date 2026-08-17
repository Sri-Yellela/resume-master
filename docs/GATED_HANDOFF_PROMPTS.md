# Gated Portal Handoff — Task Prompts

Companion to `docs/GATED_HANDOFF_ARCHITECTURE.md`. Read that first. Run **in order**, one task per
session, one commit each.

**Order rationale:** G0 settles the single unknown that can invalidate the UX, so it comes before
any building. G4 is deliberately last because it depends on field discovery working on JS-rendered
pages, which is currently broken.

---

## Standing conventions (prepend to every task)

```
Session-aware: read the files in scope and reconstruct state from the repo — do not trust status
docs. No UI/current-feature change without sign-off (these tasks ARE the signed-off scope, for
their own surfaces only). /api/jobs stays byte-compatible; new fields/params optional and
default-off. Regression-proof: for every modified module review its dependents (importers) and
children (imports) and fix them in the SAME pass, reporting each with a verdict. Migrations
additive + dual-path, byte-identical in BOTH scripts/migrations.js and the server.js MIGRATIONS
array (high-water 068). Close each task with a REPORT (files, dependents + verdicts, migration id,
REAL-run verification — not simulated) then commit & push as ONE focused commit. Re-derive the
current unique test-failure baseline first; introduced failures must be 0.

HARD BOUNDARY FOR EVERY TASK IN THIS FILE: the human crosses every gate and submits every
application. Do NOT build anything that solves, bypasses, or automates a CAPTCHA, an identity
verification step, or account creation. Do NOT store portal credentials or replicate a portal
session server-side. If a task appears to require any of these, STOP and report — the design is
wrong, not the boundary.

TESTING: all runs against scripts/fakeAts.js on localhost until a task explicitly says otherwise.
Never point automation at a real ATS. The A5 live gate still stands.
```

---

## TASK G0 — Settle the `activeTab` lifetime question (spike, no production code)

```
OBJECTIVE
Establish EMPIRICALLY whether an activeTab grant survives same-origin navigation inside a
multi-step form. This is the largest unknown in the design and it determines the interaction
model: one user gesture per application, or one per page. Building G2 before knowing this risks a
UX that has to be rebuilt.

BACKGROUND
Chrome revokes an activeTab grant on navigation away from the granted origin. Multi-step portals
(Workday, Amazon) paginate — sometimes as SPA route changes, sometimes as real navigations. Those
two cases may behave differently and that distinction is the whole question.

METHOD
1. Add a throwaway multi-step route to scripts/fakeAts.js with BOTH navigation styles:
   - a real form POST -> new document (like the existing /greenhouse step1->step2)
   - an SPA route change that rewrites the DOM via history.pushState without a document load
2. Load an unpacked build of extension/ (do NOT submit to the Web Store for this).
3. Invoke the extension on step 1, then advance to step 2 by each mechanism, and attempt
   chrome.scripting.executeScript into the tab WITHOUT re-invoking.
4. Record for each: does injection still succeed, and does chrome.storage.session state survive.
5. Repeat against one real published careers page that is NOT gated (a public Workday tenant job
   view is fine — read-only, do not submit anything, do not fill anything).

OUTPUT
A findings note appended to docs/GATED_HANDOFF_ARCHITECTURE.md §8 replacing the open question, with
the interaction model it implies:
  - grant survives both -> one gesture per application
  - survives SPA only   -> one gesture per real navigation; design steps to be SPA transitions
  - survives neither    -> one gesture per page; G3's overlay must make re-invoking near-free
No production code in this task. Commit the fakeAts route and the findings note.
```

---

## TASK G1 — Packet + single-use token (server side)

```
OBJECTIVE
When a run hits a gate, persist a prepared answer packet and mint a signed, single-use,
short-TTL token that the extension can exchange for it. Server side only; nothing in the browser
yet.

READ FIRST
- services/applyAutomation.js classifyFlowState (~:511) — login_required / captcha_required are
  already detected. This task consumes that signal; do not re-derive it.
- The pre-submit gate block (~:780-830) and the terminal status vocabulary (submitted, ats_held,
  held_review, filled_not_submitted, no_submit_button, manual_review, failed).
- routes/apply.js — processRun / processRunJob, and the audit-trail columns already written
  ("Audit recorded (7/7 columns)" appears in live event logs).
- The answer resolver's provenance/confidence output — the packet MUST carry it; G3 renders it.

REQUIREMENTS
1. On a gate detection, terminate the job as a HELD outcome, not `failed`. Decide with the owner
   whether that is a new `held_gate` status or a reason code on `held_review` (open decision in
   the architecture doc §8) and be consistent everywhere, including the client's status labels.
2. Persist the packet: resolved answers WITH provenance and confidence per field, the generated
   resume artifact reference, the target apply URL and expected origin, and the job/run ids.
   Migration required — additive, dual-path, byte-identical, next id after the current high-water.
3. Mint a token: HMAC-signed with a server secret, single-use (server marks it consumed), TTL on
   the order of minutes not hours. Bind it to the user AND the job. A token must not be replayable
   and must not be usable by another account.
4. Exchange endpoint, `requireAuth`: given a valid unconsumed token, return the packet ONCE. The
   response must include the expected origin so the extension can target-match before releasing
   anything (see G2 requirement 3). Reject and log expired/consumed/mismatched tokens distinctly —
   do not collapse them into one generic 400.
5. The resume must be fetchable as a blob by the extension via a session-authenticated request.
   Confirm whether an existing artifact route serves this; add nothing new if one does.
6. Rate-limit the exchange endpoint. It returns a home address and work-authorization answers.

REGRESSION
Non-gated runs must behave exactly as before — no new status appearing on a greenhouse run. The
existing audit trail must still record fully. Report processRun's dependents with verdicts.

VERIFY (real runs, fakeAts)
Force a gate (add a login-walled route to fakeAts that redirects to a fake sign-in). Confirm the
job ends HELD with a packet row and a token. Confirm the token works exactly once, that a replay
is rejected, that an expired token is rejected, and that another user's token is rejected. Assert
the packet contains provenance per field, not bare values. Commit & push.
```

---

## TASK G2 — Extension handoff via `activeTab`

```
OBJECTIVE
The user, standing on a gated application page they have authenticated themselves, invokes the
extension; it fetches the packet and fills the form — including the resume file.

READ FIRST
- extension/manifest.json — MV3, permissions activeTab + scripting + storage. externally_connectable
  is ABSENT and must stay absent: the extension PULLS from our server, nothing pushes inward.
- extension/linkedin-content.js:369 — the existing credentialed fetch to /api/import/job. Same
  pattern for the packet exchange.
- extension/background.js — the service worker and its existing chrome.commands handling.
- G0's findings. The interaction model is whatever G0 established, not what is convenient.

REQUIREMENTS
1. Invocation is an explicit user gesture (action click or keyboard command) — that gesture is what
   grants activeTab. Do NOT add host permissions for portal origins; the whole security property of
   this design is that access is granted per-tab, per-gesture, by the user.
2. Fetch the packet from our server with credentials:'include'. Never embed a secret in the
   extension.
3. TARGET MATCH BEFORE RELEASE — non-negotiable. Release answers only when the active tab's origin
   matches the packet's expected origin AND a form is present in the DOM. On mismatch, release
   nothing and tell the user why. The packet carries a home address and eligibility answers; a
   stray release is a data leak, not a bug.
4. Fill text fields using the NATIVE value setter (Object.getOwnPropertyDescriptor on the
   prototype), then dispatch input/change. These portals are React apps that track value
   internally; direct .value assignment is silently reverted on re-render and will look like a
   working fill that submits empty.
5. Attach the resume: fetch it as a blob, construct a File, attach via DataTransfer, assign
   input.files, dispatch change. Verify against a real file input that the filename appears in the
   page's own UI, not merely that the property was set.
6. State lives in chrome.storage.session scoped per tab with a TTL — MV3 service workers are torn
   down and cannot hold packets in memory. Clear the packet on submit, on TTL expiry, and on tab
   close.
7. Manifest changes ship on Web Store review latency (currently published v1.2.0). Batch every
   manifest change this design needs into ONE submission — list what G3/G4 will also need before
   submitting.

REGRESSION
The existing single-job capture (CAPTURE_AND_IMPORT -> /api/import/job) and the popup's SAVE_JOB
path must keep working. saved-jobs-content.js must stay deleted and grep-clean; do not reintroduce
any batch-scraping affordance.

VERIFY (fakeAts only)
Against fakeAts's multi-step and SPA routes: invoke, confirm every mapped field fills, confirm the
resume file registers in the page UI, confirm a deliberate origin mismatch releases NOTHING.
Confirm the packet is gone from storage after submit. Do NOT run this against a real portal.
Commit & push.
```

---

## TASK G3 — Provenance overlay review

```
OBJECTIVE
Replace "read the whole form and check it" with "approve three uncertain fields." Render the
packet's provenance over the real form so review takes seconds and produces an audit record.

READ FIRST
The answer resolver's provenance tiers (handler_exact / field_map_exact / label_fuzzy /
custom_answer / default) and confidence values. The client design system: glass, pills radius 999
~11px/700, MetaChips idiom — the overlay should look like the product, not like a debug panel.

REQUIREMENTS
1. An in-page overlay listing each filled field: label, value, provenance tier, confidence cue.
   Reuse the verified/inferred visual language already used for KB org units.
2. SORT ORDER IS THE FEATURE. Eligibility answers (work authorization, sponsorship, clearance,
   veteran, disability) pin to the TOP regardless of confidence — they are attestations to an
   employer. Then low-confidence, then everything else collapsed behind a disclosure.
3. Per-field approve/edit. An edit writes through to the real input using the native-setter path
   from G2 requirement 4.
4. Any `label_fuzzy` answer must be explicitly acknowledged before the overlay reports ready.
   Fuzzy matching on an eligibility field should not be reachable at all — if one appears here,
   that is a resolver bug; surface it loudly rather than asking the user to rubber-stamp it.
5. The overlay never submits. It hands back to the user, who submits.
6. Record what the user approved or changed against the application's audit row — this is the only
   record of what a human actually saw before an application went out.

VERIFY (fakeAts)
Against the trap forms: the sponsorship-inversion field must appear at the top and, if it was
fuzzy-matched, must block "ready" until acknowledged. A user edit must persist in the real input
after a React re-render. Commit & push.
```

---

## TASK G4 — Schema capture through the gate ⛔ BLOCKED

```
⛔ DO NOT START until field discovery is reliable on JS-rendered pages. Currently discovery
returns ZERO fields on Ashby (observed live: 9-second run, autofill_done with 0 fields). Amazon
and Meta are heavier SPAs. Building this first would persist EMPTY schemas and cache the bug into
the asset that is supposed to compound. Fix discovery, and add a JS-rendered route to
scripts/fakeAts.js (which serves static HTML and cannot reproduce the failure), first.

OBJECTIVE
The extension, standing inside a place our server can never reach, returns the form's STRUCTURE so
the next user's packet arrives pre-mapped.

READ FIRST
- services/applyAutomation.js discoverFields (~:393) — it already extracts labels, types,
  is_required, current_value. This task persists what it produces; do not write a second extractor.
- services/platformDetector.js PLATFORM_LABEL_MAPS (~:24) — hand-written maps for greenhouse,
  lever, workday, with everything else falling to `generic`. Captured schemas are the mechanism
  that replaces hand-writing these.
- services/kb/orgLayer.js — the provenance + confidence + last_seen + promotion pattern. Follow it
  exactly; a form schema is a KB fact and decays the same way.

REQUIREMENTS
1. Capture STRUCTURE ONLY: labels, types, required flags, option lists, field order. NEVER the
   user's entered values, never anything about the user, never any page content beyond the form's
   shape. Assert this with a test, not a comment.
2. Store per COMPANY / apply-host, not per job — one careers page serves all its postings, so a
   schema captured once serves every future import from that host. New table alongside
   company_org_units / company_technographics. Migration: additive, dual-path, byte-identical.
3. Confidence and staleness like every other KB fact: last_seen, corroboration count, decay.
   Forms change. A stale schema that is trusted is worse than no schema — re-discover and
   reconcile rather than assuming.
4. UNMAPPED FIELDS ARE VALUABLE. A captured schema with three unresolvable fields tells us IN
   ADVANCE that the run will hold. Surface that at import/queue time, not at submit time.
5. This is the same store that imported-careers-page support needs. Design it for both consumers
   now; do not build a gated-only variant that has to be merged later.
6. Consent: this reports on a page behind the user's authenticated session. Settle with the owner
   whether capture is opt-in (architecture doc §8) before shipping.

VERIFY
Against fakeAts's JS-rendered route: a captured schema reproduces the real field set. Grep-prove no
code path writes user answers into the schema store. A second capture of a CHANGED form reconciles
rather than duplicating. Commit & push.
```

---

## TASK G5 — Amortize the gate per portal

```
OBJECTIVE
Reframe the held queue from per-job reviews to per-portal sessions. One gate crossing releases a
batch. This is the highest-leverage item in the design and is mostly presentation over existing
data.

REQUIREMENTS
1. Group held-gate jobs by apply host. Present as "Sign in to <portal> once -> N applications
   ready", not N separate review items.
2. One gesture per portal session where G0's findings allow it; where they do not, make
   re-invoking as close to free as possible (G3's overlay should already be open).
3. Packets for the batch share the authenticated session but remain individually target-matched
   and individually approved. Batching the GATE must not batch the REVIEW — each application is
   still a separate attestation the user sees.
4. Per-portal state: if a session goes stale mid-batch, remaining jobs return to held rather than
   failing.

VERIFY
With several held jobs across two portals, the queue groups correctly, one session releases one
portal's batch and not the other's, and each application is still individually approved before
submission. Commit & push.
```

---

## Deferred / explicitly out of scope

- CAPTCHA solving, identity-verification automation, headless account creation. Not deferred —
  outside scope permanently. See the hard boundary in the standing conventions.
- Server-side portal session replication or credential storage.
- Anything that submits an application without the user's own final action.
