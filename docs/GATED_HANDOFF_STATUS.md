# Gated Portal Handoff — build status and handover

**As of commit `4e02450`.** Companion to `GATED_HANDOFF_ARCHITECTURE.md` (the design, now updated to
match what was built) and `GATED_HANDOFF_PROMPTS.md` (the task definitions).

Read this first if you are picking the work up cold. It says what exists, what was decided and why,
what is verified and how to re-verify it, and what is genuinely left.

---

## 1. Status in one table

| Task | What it does | State |
|---|---|---|
| **G0** | Settle whether an `activeTab` grant survives in-portal navigation | Done — findings in architecture §9 |
| **G1** | Server: prepared packet + single-use token when a run meets a gate | Done — migration 079 |
| **G2** | Extension: fetch the packet, target-match, fill the form + resume | Done |
| **G3** | Provenance overlay: review three uncertain fields, not thirty certain | Done — migration 080 |
| **G4** | Capture the form's structure through the gate, as a KB fact | Done — migration 081 |
| **G5** | Amortise the gate per portal: one sign-in releases a batch | Done |
| — | **Credential-leak fix** (found while reviewing G1, not in the task list) | Done |
| — | **Chrome Web Store publish script** | Done — nothing submitted |
| — | **Form-learning consent toggle** (Integrations panel) | Done — the switch G4 needed to be usable |

**All four open decisions in architecture §8 are settled.** Three by the owner, one by measurement.

Tests: **877 → 1018**, zero introduced failures at every step.
Migrations: high-water **078 → 081**.
Extension: **never published**. Repo at v1.0.0 — a deliberate first-submission reset; the store entry is a draft with zero users.

---

## 2. The one finding that changed the design

G0 was a spike, and its result is the reason the rest is shaped as it is.

**The design expected the interaction model to be "one gesture per page."** It measured as **one
gesture per application**. An `activeTab` grant survives every same-origin navigation tested —
`pushState`, a real form POST, a reload, `location.assign`, and a browser-initiated navigation — on
the fixture *and* on a live Workday tenant. The navigation mechanism turned out to be irrelevant.

Two boundaries the design did not have, both found by trials that first reported the convenient
answer:

- **Leaving the origin revokes it.** This is the realistic failure on these portals, because the
  sign-in often lives on another host — the candidate can cross the gate and land back with the
  grant already gone.
- **A new tab does not inherit it.** Workday's job links are `target="_blank"`. Any portal that opens
  its next step in a new tab needs the gesture repeated there, which G5's batching cannot assume away.

Also measured, and load-bearing later: **`chrome.storage.session` outlives the grant.** A packet
therefore survives its own grant, so it must be cleared deliberately — nothing else will.

Re-run it with `node scripts/g0ActiveTabSpike.mjs --real`. It refuses to report a finding unless its
cross-origin control trial shows a revocation, and marks a trial VOID rather than SURVIVED when the
transition it was supposed to test did not actually happen.

---

## 3. What exists now, by file

### Server
| File | Role |
|---|---|
| `services/applyGatePacket.js` | Builds the packet; mints/verifies the HMAC single-use token |
| `services/kb/formSchemaLayer.js` | Form schemas as a KB fact — normalise, reconcile, decay |
| `services/applyAutomation.js` | `detectGate`, `buildGateHold`, `GATE_FLOW_STATES`, `isCredentialField` |
| `routes/apply.js` | All gate endpoints; the `held_gate` status mapping |
| `routes/companyKb.js` | `GET /:company/form-schemas` — the KB read surface |

### Extension (v1.0.0, unsubmitted)
| File | Role |
|---|---|
| `extension/gated-handoff.js` | Target match, packet exchange, fill, resume attach, batching, capture |
| `extension/review-overlay.js` | The provenance overlay: ordering, readiness, in-page render |
| `extension/background.js` | Command handler, capture, batch advance, overlay messages |
| `extension/extractor.js` | The injected page reader. NOT a content script — see documentation.md §8.2 |

### Endpoints
```
GET  /api/apply/gate-packets                    queue, grouped by portal (+ flat list)
POST /api/apply/gate-packets/:id/token          mint a single-use token (on demand)
POST /api/apply/gate-packet/exchange            spend it, once, for the packet
POST /api/apply/gate-packets/:id/reopen         recover a released-but-unfinished handoff
POST /api/apply/gate-review                     what the candidate saw and changed
GET  /api/apply/form-schema?url=                what we know about this form, at queue time
POST /api/apply/form-schema                     capture (consent-gated)
GET  /api/apply/form-schema/consent             read the opt-in
POST /api/apply/form-schema/consent             set it
GET  /api/kb/:company/form-schemas              full schemas for a company
```

### Migrations
| id | Adds |
|---|---|
| `079_apply_gate_packets` | `apply_gate_packets` — packet, expected origin, token hash, consumption |
| `080_apply_gate_review` | `apply_run_jobs.gate_review_json` |
| `081_company_form_schemas` | `company_form_schemas` + `users.form_schema_capture` (default 0) |

All three are additive, byte-identical in `server.js` and `scripts/migrations.js`, asserted by test,
and were applied to a copy of the real database before commit.

---

## 4. Decisions, and the reasoning you would otherwise have to reconstruct

**`held_gate` is a new terminal status, not a reason code on `held_review`.** The doc framed this as
"clean separation vs. reuse the pipeline." The code settled it: `routes/apply.js` has ~14 queries
keyed on `status='held_review'`, and `finalStatus`'s fallback *already* sent gates there with
`reason_code='login_required'`. A reason code was not the conservative option — it was the status
quo, and it meant the review and approval endpoints were already picking up jobs whose form had never
been reached. `expired` deliberately stayed behind: there is nothing there for a human to finish.

**The token is minted on demand, not when the gate is observed.** A minutes-long TTL — which the task
required, because the token unlocks a home address — would be dead long before anyone read the
notification. Re-minting rotates rather than issuing a second key.

**Schema capture is opt-in, default off, enforced server-side.** It sends no personal data and the
structure-only filter is testable, but the guarantee would rest entirely on that filter being
correct, and the page being reported on sits behind the candidate's own authenticated session.

The switch lives in the Integrations panel as "Form Learning", because it governs what the extension
may do rather than who the user is. It holds `null` while unknown instead of rendering as OFF — "off"
and "we could not ask" are different claims, and this one is a permission.

**Manifest changes are batched in the repo and not submitted.** The full forward list is in
architecture §8; G3, G4 and G5 needed nothing further, so the batch is still exactly one `commands`
entry and a version bump.

---

## 5. Verification — how to re-check any of it

Every task has a harness that drives a real browser. They are not mocks: G0/G2/G3/G5 take a real
`activeTab` grant via a real OS-level keypress, because no API can mint one.

```
node scripts/g0ActiveTabSpike.mjs --real                    # grant lifetime (steals focus ~15s/trial)
A1_RESUME=<any.pdf> node scripts/g1GatePacket.mjs           # packet + token semantics
A1_RESUME=<any.pdf> node scripts/g2ExtensionHandoff.mjs     # handoff, target match, resume attach
A1_RESUME=<any.pdf> node scripts/g3ReviewOverlay.mjs        # overlay order, readiness, edits
node scripts/g4SchemaCapture.mjs                            # capture, reconcile, consent
A1_RESUME=<any.pdf> node scripts/g5PortalBatch.mjs          # two portals, one batch
node scripts/g6CredentialGuard.mjs                          # nothing enters a login form
npm test                                                     # 1018
```

`data/a5-fixture/John Doe Resume.pdf` works for `A1_RESUME`. All of them start their own `fakeAts`
if one is not already listening on :4599.

**fakeAts routes added this session:** `/multistep` (three navigation styles + a cross-origin
control), `/gated` → `/gated/signin` (a sign-in wall with no valid credential, by design),
`/gated/form` (the form behind it, carrying the inversion and label-only traps), `/gated/mixed` (a
login form and an application form on one page, both with a control named `email`),
`/gated/captcha`, and `/spa?variant=2` (a changed form, for reconciliation).

---

## 6. Things that bit me — worth knowing before they bite you

**Chrome 137+ ignores `--load-extension`.** Extensions must be installed over CDP
(`Extensions.loadUnpacked`, i.e. puppeteer's `enableExtensions` + `pipe: true`), which needs
`--enable-unsafe-extension-debugging`. Any future browser harness has to use that path.

**`Ctrl+Shift+G` is Chrome's own find-previous.** Chrome silently refuses to bind it, leaving a
command that exists with no key — indistinguishable from a working build until someone presses it.
The extension uses `Ctrl+Shift+Y`, empirically verified as bindable.

**Harnesses must wipe their Chrome profile.** A reused profile keeps the *previously* installed copy
of the extension, so a source change silently does not take effect and the run reports on code that
is no longer there. This cost an hour.

**`buildExtension.mjs` did not follow ES imports** and `background.js` is a module. It would have
shipped a service worker whose first import 404s — a bundle that validates, zips cleanly, and is dead
on load. Fixed, and `extensionSubmission.test.js` now shares the builder's one definition instead of
keeping its own copy of the reachability rules.

**Rebuild the zip after touching anything in `extension/`.** `extensionSubmission.test.js` compares it
byte-for-byte and will fail the suite. `npm run build:extension`.

---

## 7. What is actually left

1. **Submit the extension.** Requires the developer account's own login; there are no Chrome Web Store
   credentials in this repo. `npm run publish:extension -- --dry-run` runs the full preflight without
   credentials and currently passes. Before submitting, three dashboard fields need updating — single
   purpose, privacy practices, permission justifications — because the behaviour changed even though
   the permission set did not. The checklist is at the end of `extension/submission/STORE_LISTING.md`.

2. **The privacy policy must go live before the listing points at it.** The copy is written and
   committed (`client/src/pages/marketing/PrivacyPage.jsx`) but needs deploying.

3. **Discovery on a real, heavy SPA is unmeasured.** G4's original ⛔ was a live Ashby posting
   returning zero fields. On the fixture that is fixed and re-measured on every capture run. On a real
   ATS it has not been re-checked, because the testing convention forbids pointing automation at one.
   Two things limit the exposure: an empty capture is **refused** (422) rather than stored, and a
   changed schema reconciles — so one bad reading cannot permanently poison the store.

4. **No live gate has ever been crossed end to end.** Everything is verified against `fakeAts`. The
   first real run against a real portal is still ahead, and the A5 live gate still stands.
