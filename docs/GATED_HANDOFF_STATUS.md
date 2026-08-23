# Gated Portal Handoff — build status and handover

**As of commit `4e02450`, with §8 added 2026-08-23 (AE6).** Read §8 before quoting anything
here as "verified end to end": it states exactly which paths have met a real employer and
which have not. Companion to `GATED_HANDOFF_ARCHITECTURE.md` (the design, now updated to
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

3. ~~**Discovery on a real, heavy SPA is unmeasured.**~~ **MEASURED 2026-08-23 — see §8.** G4's
   original ⛔ was a live Ashby posting returning zero fields. Re-checked against that exact posting
   with a read-only instrument: readiness settles at **32 stable controls in ~3s** and discovery finds
   **15 fields across 3 frames**, comboboxes and typeahead included. It holds. The two limits stay
   anyway, because one provider's form is not a guarantee about the next: an empty capture is
   **refused** (422) rather than stored, and a changed schema reconciles.

4. **No live gate has ever been crossed end to end.** Everything about the HANDOFF is verified
   against `fakeAts`. See §8 for exactly which paths have and have not met a real employer.

---

## 8. What has run against a real employer, and what has not (AE6, 2026-08-23)

This section exists because "end to end" was being used loosely, and a stale status doc is what this
project's golden rule exists to prevent. The precise position:

| Path | Mode | Met a real employer? | Notes |
|---|---|---|---|
| **Unattended, non-submitting** | `preview` | **YES — 2026-08-23** | `scripts/ae1LiveVerify.mjs` against `jobs.ashbyhq.com/openai/0432731c-…/application`. Fixture identity. 15 fields discovered, 4 filled, held `incomplete_form`, **nothing submitted** — `preview` stops at the PREVIEW STOP before any submit button is touched. |
| **Attended** | `semi` | **YES — 2026-08-23** | Same script, `--semi`. 4 filled, 2 required fields reported as the human's to answer, **nothing submitted**. |
| **Unattended, SUBMITTING** | `full` | **NO** | The path that actually clicks submit has never run against a real employer. This is the A5 live gate, and it still stands. |
| **A gate crossing** | any | **NO** | Every packet, token, overlay and portal batch is verified against `fakeAts` only. |

Three things follow, and none of them were said plainly before:

1. **`ab1HeldHandoff`'s end-to-end proof was `semi`, against `fakeAts`.** The script says so itself
   and always did — it is the docs that let "verified end to end" be read as "verified against an
   employer". It proves the pipeline→packet→extension→submission chain on a fixture. That is a real
   and useful proof of the chain; it is not a claim about any employer's form.

2. **The attended path runs no automated checks.** `isUnattended = isFullAuto || isPreview`, so a
   `semi` run executes NEITHER the completeness gate nor the low-confidence gate. That is deliberate
   — semi's premise is that a human is reading the form, and pre-filling a guess for them to correct
   is the entire point of the mode — which means **the human's reading of the form is the only check
   that runs.** Anything the docs imply about semi being "verified" is a statement about the fill,
   not about the answers.

3. **Silence is no longer part of that.** Until AE6 a semi run returned no `missingRequired` at all,
   so the review surface rendered a clean row over a form that could not be submitted. It now states
   the count and lists the fields (`"N required fields are yours to answer"`), and populates
   `openQuestions` so they can be answered rather than merely named. The gates are still off; the
   run no longer pretends there is nothing outstanding.

### The submitting path IS now exercised end to end — against the shape, not the employer

Added after the table above, and it changes what "still ahead" means. AE1's diagnosis found that
everything had been verified against `/ashby`, a static replica with native controls, while the live
posting is a React SPA that does not resemble it. `scripts/fakeAts.js` now serves **`/ashby-spa`**:
the live form's shape transcribed field-for-field from `ae1Diagnose.mjs` — 15 fields, every label,
name, type and required flag identical, rendered in two chunks, with the nameless required date
picker, the three UUID field names and the checkboxes named with their own question text.

`scripts/ae7SubmitOnRealShape.mjs` drives **`mode:'full'`** against it — the submitting path,
including the click — in four cases, asserting on what the ATS RECORDS rather than on any status:

| Case | Form | Outcome | Why it matters |
|---|---|---|---|
| A | as measured | `held_review / incomplete_form`, `missingRequired: ["Pick date..."]`, 4 filled, **0 recorded** | The live outcome, reproduced locally. The fill works; the FORM declines to say what one required control wants. |
| B | `?answerable=1` | **`submitted`**, `confirmation_page,url_changed`, **1 recorded** | The only difference from A is that one control has a label. Resume arrived at 193 bytes in `_systemfield_resume`; the UUID phone field resolved by label; the date came from the candidate's own `custom_answers`. |
| C | `?deadsubmit=1` | `filled_not_submitted / submit_unverified`, `clicked_no_evidence`, **0 recorded** | A1 finding N1's case, which had no local target on a JS-submitted form. |
| D | `?autofilltrap=1` | `held_review`, `missingRequired: ["Resume"]`, **0 recorded** | The resume uploads into the wrong file input, because that input carries the real page's own autofill copy. |

Case B's **negative** assertions are the ones worth reading: no EEOC self-identification was
answered, no arbitration agreement was accepted, and the nameless typeahead was left alone. Nothing
was invented for a question nobody could answer, and no attestation was made on the candidate's
behalf. That is the property that has to hold on the path that actually submits.

What this does **not** establish: that the click works at a real employer. It establishes that it
works against the real employer's *markup*, which is the part that can be tested without spending an
application. The A5 gate is unchanged.

**Queueing produces `semi`-shaped work, not a submission.** The board's "Autofill for Review" and
the queue both post `mode:"auto"` with the server's approval-required default, which
`processRunJob` turns into `applyMode = 'preview'` — full-auto minus the click. Nothing the board
can do today reaches the submitting path without an explicit approval.
