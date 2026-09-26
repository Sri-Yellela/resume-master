# resume-master — Chrome Extension Diagnosis (evidence-based)

**Status:** OPEN. Diagnosed 2026-09-24 against commit `11728e4`. Nothing was changed in this
session — the tracked tree was untouched, deliberately, because five symptoms were reported and
the first question was how many defects they actually are.

**Rule for this document:** every CONFIRMED line is backed by a real-browser run, a production
HTTP response, or a grep-verified code path, cited inline. Where something is INFERRED it says so
and names what would settle it.

**Test baseline re-derived first:** `npm test` → **2606 pass / 0 fail**, exit 0. That baseline is
green and stayed green throughout; it is also structurally incapable of seeing any defect below,
which is the point of §7.

---

## 0. Headline

Five symptoms were reported. They are **four defects, and one non-defect.**

| | Cause | Explains |
|---|---|---|
| **A** | Dead routes `/resume` and `/ats-score`, plus a 404 fallback that navigates admins to `/admin` | the whole "resume builder opened an admin session" symptom, **and** the ATS button |
| **B** | Anthropic credit exhausted; `/api/import/job` has a hard model dependency and no fallback | **all** of capture (and enrichment, and every model-backed path) |
| **C** | The extension authenticates by ambient cookie, so it inherits whatever session exists — including admin | the real security item; **not** what produced the visible symptom |
| **D** | `applyPlan` never reads a value back after setting it; custom comboboxes unhandled; corrections not wired | the fill path's honesty |

**The autofill hotkey is not broken** (§3). It is bound, it fires, and it fills.

The two things worth noticing about the shape of this: **A and C were reported as one symptom and
are unrelated**, and **B is not an extension defect at all** — the extension is faithfully
reporting a server failure.

---

## 1. The host question — answered, and it is not the problem

The published extension declares `https://resumemaster.one/*` as its only host permission. The repo
has moved to `jobsviadraft.com`. Measured 2026-09-24:

```
                          resumemaster.one    jobsviadraft.com
/api/version  commit      11728e4             11728e4      <- SAME deployment
/api/auth/me                 200                 200
/api/import/job              401                 401       <- alive, auth-gating correctly
```

**CONFIRMED: the old origin still serves everything the extension expects.** This is deliberate and
documented in `shared/brand.js`, which is the single source for both origins:

- ~~`extension/` is frozen for **P4**~~ — P4 ran 2026-09-26; the package names the canonical
  origin now. The v1.0.0 item still in the review queue names the old one, which is one reason the
  old origin has to keep answering.
- ~~Both origins serve one app until P4 lands.~~ Both origins serve one app, **permanently**: the
  old host belongs to a second product (`docs/PRODUCT_MODEL.md`) and is not being retired.
- ⛔ **There is deliberately no 301 on the old origin, and this is PERMANENT.** The extension's
  fetches are credentialed and do not follow redirects, so a 301 on an `/api` route fails
  *silently* rather than working. ~~The redirect becomes safe only once the extension update is
  live~~ — corrected 2026-09-26: **it never becomes safe.** The original framing made it a
  countdown, but the property holds for every credentialed client of that origin, present and
  future, not only the extension that prompted the rule.

### The one real hazard here

`GOOGLE_CALLBACK_URL` **has** already moved:

```
GET https://resumemaster.one/auth/google
  302 → accounts.google.com/…&redirect_uri=https%3A%2F%2Fjobsviadraft.com%2Fauth%2Fgoogle%2Fcallback
```

The session cookie is host-only (`server.js:6317` sets no `domain:`). So **a Google sign-in started
on the old origin lands its cookie on the new one**, and the extension — which only ever talks to
the old origin — sees no session at all. Password sign-in on the old host still works and still
sets a usable cookie, which is why this is a latent hazard rather than today's failure.

**This did not cause the reported capture failure** (§2 proves the extension *was* authenticated),
but it will start causing it for any user who signs in with Google.

## 2. The published build is the repo

Every finding here applies to what users actually have installed. `extension/submission/
resume-master-extension-v1.0.0.zip` (packaged 2026-09-08) unzipped and compared file-by-file:

```
same  background.js   same  gated-handoff.js   same  extractor.js   same  popup.js
same  manifest.json   same  config.js          same  review-overlay.js
```

**CONFIRMED byte-identical across all 7 source files.** In particular the `?origin=` fix (270949d,
2026-08-28) predates the package, so the installed build *does* send it — see §3.

---

## 3. NOT A DEFECT — the autofill hotkey works

Reported: `Ctrl+Shift+Y` does nothing. Measured at runtime, not from the manifest:

```
chrome.commands.getAll()
  capture-job                Ctrl+Shift+K
  fill-gated-application     Ctrl+Shift+Y
  _execute_action            UNBOUND
```

`scripts/g2ExtensionHandoff.mjs` — real browser, real extension, real OS-level keypress — is
**ALL PASS**: the handoff runs, fields fill, the value survives a React re-render, the resume lands
in the page's own file input, an origin mismatch releases nothing and does not spend the token, and
the packet is consumed exactly once.

`?origin=` is in the published build **and** the server honours and echoes it
(`routes/apply.js:2694`), returning a pre-cap `total` over the same scope so a truncated list can
no longer read as `batch_empty`. Both halves of that fix are live.

**Most likely explanation on the reporter's machine: a shortcut conflict.** Check
`chrome://extensions/shortcuts` — another extension can silently take the binding.

**One real weakness stands, though.** A handoff that parks with no packet reports only through a
`!` badge and the action tooltip (`reportHandoff`, `background.js:212`). That is not silence, but
it is close enough that a user cannot distinguish it from nothing happening. Worth fixing under D.

---

## 4. DEFECT A — dead routes, and a 404 fallback that promotes admins

> **✅ RESOLVED 2026-09-24.** And it was THREE defects, not two. Legacy aliases in `App.jsx`
> forward `/resume` → `/tools/generate` and `/ats-score` → `/tools/ats` **carrying the query**,
> which fixes every already-installed copy without a store update; `ATSToolPage` now reads
> `?jd=`; and — found only by opening the page — **both tool pages used `<Link>` without
> importing it**, so each threw `ReferenceError` on render and had never worked. `vite build`
> exits 0 on that. Verified by `scripts/dx4ToolRoutes.mjs`, which asserts the pages RENDER, not
> just that the URL is right. Guarded by `test/jsxIdentifiersResolve.test.js`.

**This is the reported "resume builder opened an ADMIN session" symptom, in full.**

Every URL the extension navigates a user to:

| URL | Source | Route exists? |
|---|---|---|
| `/resume` — **"Resume builder" button** | `background.js:175` | **NO** |
| `/ats-score?jd=…` — **ATS button** | `background.js:163` | **NO** |
| `/auth/linkedin` | `background.js:169` | yes (`server.js:6451`) |
| `/login` | `popup.js:118` | yes |
| `chrome://extensions/shortcuts` | `options.js:74` | yes |

`client/src/App.jsx:729` — the catch-all both dead routes fall into:

```jsx
<Route path="*" element={
  authStatus === "authenticated" && authUser
    ? (authUser.isAdmin ? <Navigate to="/admin" replace/> : <Navigate to="/app" replace/>)
    : <>{navBar}<NotFoundPage/></>
}/>
```

**CONFIRMED: the extension opens a route that does not exist, and the SPA's 404 handler navigates
an admin straight to `/admin`.** Nothing "chose" an admin session. The real resume builder is a
panel under `/app`; the real ATS route is `/tools/ats`.

⛔ **The ATS button has a second, independent break.** `client/src/pages/tools/ATSToolPage.jsx`
contains **no `useSearchParams` and never reads `jd`**. Even pointed at the correct route, the job
text the popup carefully extracts and encodes is dropped on arrival. Fixing only the URL leaves the
button still not working.

---

## 5. DEFECT B — capture cannot degrade, so it fails whole

> **✅ RESOLVED 2026-09-25 — capture degrades instead of failing.** Two changes, a day apart.
>
> **The message (09-24).** `isPermanentModelFailure()` in `services/modelCall.js` separates a
> billing exhaustion from a transient failure, so a non-retryable error stops telling people
> to retry.
>
> **The fallback (09-25).** `jobFromLabelledText()` files the posting WITHOUT a model when the
> model call fails permanently, reading the labelled block `extension/extractor.js` already
> sends. Measured in a real browser with the balance still exhausted:
> *"Saved (partial): Senior Backend Engineer @ Northwind Systems"*, HTTP 200, row persisted.
>
> ⛔ The balance is still unfunded and that was never the point — §10 of ARCHITECTURE.md had
> recorded "no deterministic fallback" as a **design constraint**, and this removes the
> constraint rather than the symptom. Enrichment completes the row once funded, because
> `enriched_at` stays NULL: degraded is a stage, not a state.

Reproduced in a real browser (`scripts/dx1CaptureDiagnosis.mjs`) with a real `activeTab` grant from
a real OS keypress, against the **real `server.js`** on a throwaway data dir, on two deliberately
different page shapes — an employer careers page with JSON-LD, and a LinkedIn-shaped page using
LinkedIn's own class names and no JSON-LD:

```
── the extension is authenticated ──
PROBE_AUTH                 {"authenticated":true}              <- NOT a 401

── the extractor RAN and SUCCEEDED on both ──
careers page    ok=true  title="Senior Backend Engineer"   desc=341ch
LinkedIn-shaped ok=true  title="Staff Software Engineer…"  desc=314ch

── and capture still failed, identically ──
capture outcome            success=false "Could not import this job. Please try again."
raw POST /api/import/job   502, in 204 ms

── server log ──
[POST /api/import/job] Error: 400 {"type":"invalid_request_error",
  "message":"Your credit balance is too low to access the Anthropic API…"}
```

**CONFIRMED, and it rules out four hypotheses at once.** Not auth (authenticated), not the
`activeTab` grant (hotkey delivered, extractor ran), not LinkedIn's DOM (both pages extracted
cleanly), not parsing. The 204 ms *is* the reported "under a second".

### Why this is a design constraint, not only a defect

`/api/import/job` → `importJob()` → `extractJobFromContent()` (`services/jobs/importJob.js:316`)
made a **mandatory** Anthropic call with no deterministic fallback — not even
title-plus-URL from the JSON-LD the extractor already parsed. When the model call fails, the whole
import fails.

`import_job` is `DATA_CLASS.PUBLIC`, so it is *eligible* to route to a free provider — but
`resolveProvider` (`shared/modelProviders.js:185`) requires `ENRICH_PROVIDER`, which is unset, so it
falls back to Anthropic (`reason: "not_configured"`, which by design does not even warn).

The same run shows `enrichJob` failing with the identical error. **This is not extension-specific;
every model-backed path is down.**

### Two secondary facts

- The user-facing message is **wrong**. "Please try again" for a billing failure that no number of
  retries can clear.
- ⚠️ **INFERRED, not confirmed:** I probed the key in the local `.env` (free, `max_tokens:1`) and got
  `credit balance is too low`. I cannot read Railway's environment, so "production uses this same
  key" is inference — strongly supported by the symptom matching exactly. Settled by one
  authenticated capture against production, or by reading the Railway env.

---

## 6. DEFECT C — the extension acts as whoever is signed in ⛔ SECURITY

> **✅ RESOLVED 2026-09-24.** The extension now holds its own sessionLess token and the server
> refuses admin routes to it. Verified in a real browser by `scripts/dx2ExtensionIdentity.mjs`:
> **7/7 reached → 0/7, all 403 by response body**, while the same admin account still reaches
> 7/7 in a browser tab. The section below is kept as the record of what was measured and why;
> §6.5 states what the fix turned out to require beyond the obvious.

### How it authenticates today

Ambient cookie, and nothing else. `credentials:'include'` at all six call sites
(`background.js:29,154,273,299`; `gated-handoff.js:359,509`). Grepping `extension/` for
`extension-token|Authorization|Bearer|authContext|X-Auth` returns **zero matches**.

**It uses neither credential AH1 built.** Not the per-tab auth-context token, not the sessionLess
one.

### What that reaches — tested, not reasoned

`scripts/dx2AdminInheritance.mjs`: real browser, real extension, browser signed in as an admin,
probing only routes that **actually exist** (grepped from `server.js`), judged by **response body
and content-type**:

```
── the browser is signed in as the ADMIN ──
/api/auth/me username              dx2_admin        isAdmin  true

── who does the EXTENSION act as? nothing was configured ──
extension PROBE_AUTH               {"authenticated":true}
extension sees itself as           dx2_admin  isAdmin=true

── admin routes, from the EXTENSION origin ──
/api/admin/backups                 200 JSON  << REACHED ADMIN DATA
/api/admin/users                   200 JSON  << REACHED ADMIN DATA
/api/admin/upgrade-requests        200 JSON  << REACHED ADMIN DATA
/api/admin/domain-profile-requests 200 JSON  << REACHED ADMIN DATA
/api/admin/full-auto               200 JSON  << REACHED ADMIN DATA
/api/admin/contact-messages        200 JSON  << REACHED ADMIN DATA
/api/admin/db/tables               200 JSON  << REACHED ADMIN DATA
                                   7/7

── control: same probe, no session ──
                                   403 JSON on all 7
```

**CONFIRMED: 7 of 7 real admin routes return real admin JSON to a credentialed fetch from the
extension origin.** The control proves the guards themselves are sound — `requireAdmin` works. The
defect is that the extension borrows a session it never chose and cannot name.

**AH1's cross-user audit (19 endpoints → 404, 16 admin → 403) did not cover this origin.** It does
not hold here, because AH1 tested a *non-admin* caller; the failure mode here is an *admin* caller
the extension did not intend to be.

### ⛔ The false finding this produced first, four times over

DX1's initial probe reported `/api/admin/stats → 200` and it looked like a leak. **That route does
not exist.** `express.static` + the SPA catch-all answer **200 with an HTML shell for any unknown
path**. A status-only probe cannot tell a leak from a 404.

**Rule, and it is not optional: judge every route probe by response body and content-type, never by
status.** DX2 above does; DX1's first pass did not, and was wrong.

### Which credential is correct, and why not the other two

**Use `GET /api/auth/extension-token`** — it already exists at `server.js:6697`:

```js
app.get("/api/auth/extension-token", requireAuth, (req, res) => {
  const token = issueAuthContext(req.user.id, req,
    { userAgent: "resume-master-extension", sessionLess: true });
```

- ⛔ **Not the mobile token.** `server.js:6729` states the reasoning explicitly: the two revoke
  endpoints key on `user_agent`, so one shared endpoint would mean "sign out my phone" also kills
  the extension. **Two independent credentials must be independently revocable.** The two handlers
  are deliberately near-identical rather than folded into a helper, because
  `test/authCredentialLifecycle.test.js` asserts the extension's guarantees as source strings
  *inside* its route block.
- ⛔ **Not the login-issued `authContext`.** It is session-bound, swept by
  `revokeBrowserAuthContexts`, and persisting it produces intermittent untraceable sign-outs.
- **A service worker having no tab of its own is exactly the case `sessionLess:true` exists for.**
  It stores `session_sid NULL`, which `revokeBrowserAuthContexts` deliberately never sweeps
  (`server.js:5330`). The wire values are pinned in `shared/brand.js` as
  `EXTENSION_USER_AGENT` / `MOBILE_USER_AGENT` — ⛔ renaming either orphans every live row and
  revoke silently stops revoking.

### The popup cannot name its identity

`extension/popup.html` contains no "Signed in as" element — verified by grep. A user has no way to
tell which identity the extension is acting as. Whatever credential is adopted, **this must become
visible**, or the fix is unverifiable by the person it protects.

---

### 6.5 What the fix required beyond "use the token" — two measured corrections

**The brief said: use `GET /api/auth/extension-token`. That was necessary and NOT sufficient.**
Both of the following were found by a harness failing, not by reading code.

**(1) A token does not remove the privilege.** With the extension moved onto its own sessionLess
token, dx2 §2 still failed **7/7**. `bindAuthContext` hydrates the FULL user from the token's
`user_id`, so an admin's extension token still satisfies `req.user.isAdmin`. The credential had
changed; the privilege had not. The check has to be on the KIND of credential, so
`bindAuthContext` now carries `auth_contexts.user_agent` forward as `req.authContextUserAgent`.

**(2) There were THREE `requireAdmin` definitions, not one.** `server.js`, `routes/admin.js` and
`routes/adminDb.js` each wrote their own, each checking `req.user?.isAdmin` and nothing else. A
fix in one left the other two open — and `routes/adminDb.js` guards the DB inspector, the single
most valuable thing behind an admin check. All three now consult `shared/authPolicy.js`.

**(3) `Origin` is absent, so an origin check is dead code.** With the credential check in place,
dx2 §2 STILL failed 7/7: a `credentials: 'include'` fetch issued from an extension *page* carries
the browser cookie, because `host_permissions` lets the extension talk to our origin with cookies
attached. The obvious guard — test `Origin` for `chrome-extension://` — **can never fire.**
Measured off the wire (`scripts/dx3ExtensionHeaders.mjs`, a real Chrome):

```
                                        origin     referer    sec-fetch-site  sec-fetch-mode
extension page,   credentials:'include'  (absent)  (absent)   none            cors
extension page,   credentials:'omit'     (absent)  (absent)   none            cors
service worker,   credentials:'include'  (absent)  (absent)   none            cors
same-origin page fetch (admin console)   present   present    same-origin     cors
typed URL / bookmark                     (absent)  (absent)   none            navigate
curl / node / a harness                  (absent)  (absent)   (absent)        (absent)
```

So the discriminator is `sec-fetch-site: none` **and** `sec-fetch-mode: cors`. `none` alone is
wrong — a typed URL is also `none`, but `navigate`. Equality against `"none"` leaves an ordinary
API client, which sends neither header, untouched. `Sec-Fetch-*` are forbidden header names, so a
page cannot forge them.

⛔ **This is defence in depth, not the primary control.** The primary control is that the
extension holds its own token and never sends the cookie — enforced by a test that counts
`credentials: 'include'` in extension source and permits exactly one, the bootstrap. The header
check is the backstop for the day someone adds a credentialed fetch back, and it can only ever
REMOVE privilege, so a browser that omits the headers fails safe to the credential check.

**Two guesses were wrong before the headers were read.** That is the lesson worth keeping: this
file's own rule — judge by what the wire says, not by what the API ought to do — applies to
request headers exactly as it does to response bodies.

---

### 6.6 Shipping state — existing users are already protected

**The server-side half closes the escalation for everyone, with no store update.** dx2 §8 extracts
the PUBLISHED `resume-master-extension-v1.0.0.zip` — the cookie-only build, no `auth.js` — loads
it in a real browser with a live admin cookie in its jar, and measures:

```
the published build predates the fix (no auth.js, still cookie-only)   v1.0.0
the ALREADY-PUBLISHED build reaches zero admin routes too              0/7 reached
```

That is the whole reason the extension side was not rushed into the store. The token, the popup
identity and the disconnect control are an improvement to the identity MODEL; the privilege was
removed the moment the server deployed.

✅ **RESOLVED 2026-09-26 — P4 rebuilt the package and both tests went green on their own.**

From 2026-09-24 until then, two tests in `test/extensionSubmission.test.js` failed on purpose:

```
every file in the submission zip is byte-identical to extension/ source
every file the manifest references is present in the zip          (auth.js is new)
```

`extension/` had moved ahead of the published v1.0.0 package and those tests were correctly
reporting it. They were never silenced and no assertion was weakened. P4 bumped the manifest to
**v1.1.0**, repackaged for the domain flip, and `resume-master-extension-v1.1.0.zip` now contains
`auth.js` and is byte-identical to source. The v1.0.0 artifact was deleted: leaving two zips in
`extension/submission/` reintroduces exactly the "which artifact is real" ambiguity that the
hand-assembled bundle caused in the first place, and git holds the old one.

⚠ **Waiting cost nothing, which is the part worth keeping.** The privilege escalation was closed
server-side the moment the server deployed — dx2 §8, above, measured 0/7 on the published build —
so the three weeks the package spent un-rebuilt protected the review queue without leaving anyone
exposed.

⛔ **One thing the wait DID cost, and it was invisible until P4 looked.** `auth.js` writes two
storage keys, `authToken` and `authIdentity`. `test/privacyReconciliation.test.js` counts storage
writes and asserts the privacy policy's stated count matches — but it read a HARDCODED list of six
filenames that did not include the new file. So it kept asserting four, kept passing, and the
policy said "keeps four things" while the extension kept six, for the whole period. Worse, the
policy's flat claim that "None of them is sent anywhere by the extension" became FALSE the moment
the extension carried a token of its own. Both were corrected at P4, the count is now derived from
the shipped bundle, and the retraction is recorded in `STORE_LISTING.md`'s storage field. **The
lesson is not "rebuild sooner" — it is that a test whose INPUT LIST is hand-maintained can go
silent about the exact file that was added.**

---

## 7. DEFECT D — the fill path, and what it does not check

### More is built than the brief assumes

`applyPlan` (`gated-handoff.js:85`) already handles, and g2 verifies in a real browser:

- text / textarea, via the **prototype native setter** then `input`+`change` — the only thing a
  React-controlled input believes
- checkbox and radio
- native `<select>`, matching on value **or** visible option text, and **skipping rather than
  assigning** when no option holds the value
- **file upload via `DataTransfer` — this works.** The brief asks whether it is possible from an
  injected script; it is, it is implemented, and g2 confirms the *page itself* reports
  `{count:1, name:"resume-g2job.pdf"}`, not merely that a property was set.

### The real gap

**No read-back — ✅ RESOLVED 2026-09-24.** `applyPlan` is now async: it sets everything, yields
two animation frames so a framework re-render can disagree, then **re-reads every value** and
reports `reverted_after_set` for anything that did not stick. A synchronous re-read would not
have caught it. `select[multiple]`, date inputs, `contenteditable` and ARIA/custom comboboxes
are handled too. Proven in a real browser against a deliberately-reverting React-controlled
input (`scripts/fakeAts.js` `/widgets`, asserted in `g2ExtensionHandoff`). The original text
follows.

**The defect as found:** `filled.push(...)` ran immediately after `nativeSetter` with no re-read
of the element. A React-controlled select that silently reverts is reported as filled. The **only** place
read-back exists in the whole file is the resume attachment, which does it correctly and is the
model to copy.

Also unhandled: **ARIA/custom comboboxes** (react-select, Workday's dropdowns — not native
`<select>`, so `probeFormShape` does not even see their options), **multi-selects**, **date
pickers**, **`contenteditable`**.

### Eligibility — re-verified, and it holds

`scripts/a1TrapMatrix.mjs` re-run in full:

```
G1_minimal        held_review   submissions=0
G2_status_value   held_review   submissions=0
G3_yesno_value    held_review   submissions=0
G4_repeat_of_G3   held_review   submissions=0
G5_no_short_name  held_review   submissions=0
L1_lever          submitted     cards[authorized_to_work] = "yes"   name = "Ada Lovelace"
A1_ashby          submitted     authorized_no_sponsorship = "on"    _systemfield_name = "Ada Lovelace"
```

- `login_email` **never written** — the defect that typed a home address into a sign-in box at 0.9
  confidence does not recur.
- `name_ambiguity` — the full name resolved correctly, not split.
- `sponsorship_inversion` — correct polarity in **both** directions and both phrasings.
- `lowercase_yes` — accepted.
- G1–G5 **held with 0 submissions**: what cannot be resolved exactly is held, not guessed.

g2 separately confirms the extension's own matcher reports eligibility answers with no exact
control (`eligibility_requires_exact_match`) rather than placing them.

⛔ **No model call exists anywhere in the fill path**, and none may be added — Jobo's terms and §7
both say "no AI-generated answers".

### Learning from corrections — not built, and blocked

AF1's store is `POST /api/apply/answers` → `user_profile.custom_answers`, keyed by the **exact
question text** (`routes/apply.js:3468`), which is what makes "Have you worked for X before" and
"Are you a former employee" correctly two separate keys. **The extension never calls it.**

The extension *does* have `captureFormSchema()` (`gated-handoff.js:646`) → `/api/apply/form-schema`,
already gated on `users.form_schema_capture` (**DEFAULT 0**) and already capturing only field
*shape*, never answers — the correct shape. But **the consent UI was never built**: no file under
`client/src/` references `form_schema_capture`, so the toggle is unreachable and off, and capture
never runs.

⛔ **Do not ship this without the consent surface**, a privacy-policy update, and a Web Store
data-use change. Recording what a user typed into an employer's form is a real data flow.

---

## 8. What the node suite could not see

`npm test` was **2606 pass / 0 fail** before, during and after this diagnosis. It could not see any
of A, B, C or D, and that is structural, not an oversight:

- A source-string test cannot tell you **who a request is answered as** — only a real request can.
  That is the same reason `scripts/ah1SessionIdentity.mjs` exists as a harness rather than a test.
- A route that does not exist still returns **200** to anything that checks status.
- The fill path's honesty is a property of the **live DOM after a framework re-render**, which no
  unit test mounts.

The two harnesses written for this diagnosis are in **`.dx1-scratch/`** and are currently
**untracked**. They must live inside the repo to resolve `puppeteer-core`. They found what the
suite structurally cannot and should be promoted into `scripts/` with a `verifyHarnesses.mjs`
exclusion — ⛔ `scripts/*.mjs` is **auto-discovered** with no opt-in, and both launch a browser.

| harness | answers |
|---|---|
| `dx1CaptureDiagnosis.mjs` | did the extractor run? what status and text came back? how long? |
| `dx2AdminInheritance.mjs` | who does the extension act as, and what does that reach? |

---

## 9. Suggested order

**SUPERSEDED by an owner decision, 2026-09-24 — recorded here so nobody acts on the original
ordering.** The Anthropic balance is **deliberately unfunded during the domain transition**, so
B's root cause is *not* being fixed. Expect every model-backed path to 502 by design. Only B's
**message** is in scope.

The agreed order is now:

1. **C** — adopt `extension-token`, and make the popup say whose identity it holds. Taken first
   because it is a live privilege escalation in a published, installable extension.
2. **Documentation reset** (`docs/P5_DOCUMENTATION_RESET.md`), recording the auth model as C
   leaves it, and recording §5's hard model dependency in `ARCHITECTURE.md §1` as a **design
   constraint**, not merely a defect.
3. **A**, **B's message**, and **D** together — dead routes plus `useSearchParams`; a
   non-retryable error that says it is non-retryable; read-back for every control type, then the
   unhandled ones.

⛔ **Capture stays broken after all of the above**, and that is intentional. What changes is that
it will stop claiming a billing failure is worth retrying. Giving `/api/import/job` a
deterministic title-plus-URL fallback remains the only change that would make capture work
without spend — it is **not** currently scheduled.

⛔ **B is not fixed by setting `ENRICH_PROVIDER`.** `docs/am3-provider-verdict.md:183` measured
Groq at **30.5% Jaccard on `skillsHard`** (and 17.4% on `skillsSoft`) — the column A2 named as the
deciding one, and the one that feeds **both** `company_technographics` and the ATS scorer. Routing
public traffic there to dodge a billing problem trades a loud failure for a quiet data-quality one.
