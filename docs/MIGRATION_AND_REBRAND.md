# Migration + Rebrand + Documentation Reset

**One project.** `resumemaster.one` → `jobsviadraft.com`, "Resume Master" → **draft**. The Chrome
extension package is replaced in place rather than resubmitted from scratch where the dashboard
allows it.

The rename touches every file that hardcodes a name or an origin, which makes it the right moment to
collapse those into single sources and to rebuild the documentation from measured state.

---

## ⛔ CORRECTED 2026-09-26 — THIS DOCUMENT ASSUMED THE OLD DOMAIN GOES AWAY. IT DOES NOT.

Every phase below was written on one premise: that `resumemaster.one` is a *former* address being
walked away from, and that once the extension update ships, the old domain, its OAuth entries and
its traffic can all be wound down. **The owner decided on 2026-09-25 that Resume Master is a
PRODUCT** — a separate, stateless processing service on its own deployment
(`docs/PRODUCT_MODEL.md`). The domain is not a legacy address. It is an address that is staying.

**Four instructions in this document were wrong as a result. Each is struck below where it appears,
with the reason attached rather than silently deleted — a reader who saw the old version needs to
know which way it flipped.**

| | Said | Actually |
|---|---|---|
| 1 | Keep the old domain attached **until P4 lands** | Keep it attached, **full stop**. There is no event that detaches it |
| 2 | Remove the old OAuth redirect URI **at the very end** | **Never remove it.** Resume Master's own users sign in through it |
| 3 | State **when the 301 becomes safe** | ⛔ **It never becomes safe**, and the reason is permanent, not a review-queue delay |
| 4 | Add `www.jobsviadraft.com`; the slot frees up on retirement | **The slot never frees.** `www` is dropped; the bare apex is canonical |

⛔ **THE 301 IS THE ONE THAT CAN ACTUALLY BREAK SOMETHING, AND THE REASONING CHANGED SHAPE.** The
original ban was a *timing* argument — don't redirect while a reviewed extension points at the old
origin, safe once the update is live. That made it sound like a countdown. It is not. A credentialed
`fetch` does not follow redirects, so a 301 on `/api/...` fails **silently**: the call returns an
opaque response rather than an error, and the caller sees an empty answer rather than a failure. Any
client of Resume Master, present or future, that fetches with credentials breaks this way — not just
the extension, and not just the ones that exist today. **There is no date after which this becomes
fine.** Serve both origins directly, always.

⚠ **What this document still cannot tell you**, because it is an owner decision that has not been
made: whether the two origins go on serving ONE app, or whether Resume Master becomes a second
Railway service with its own database. `docs/PRODUCT_MODEL.md` says the latter; nothing is built.
Until it is, both hosts serve this app, which is why the no-301 rule binds *this* deployment today.

---

## Sequence

| | Phase | Blocking |
|---|---|---|
| **P0** | Owner: DNS, Railway, OAuth | everything |
| **P1** | Brand decision, written down once | all code work |
| **P2** | Single-source the brand and origin, with a guard | the sweep |
| **P3** | The sweep — all three repos | the extension |
| **P4** | Extension: replace the package, new screenshots | ✅ **done 2026-09-26**, except the dashboard upload |
| **P5** | Documentation reset | ✅ done 2026-09-24 |

---

## P0 — Owner actions, before any code

### DNS and Railway
1. Railway → the service → **Settings → Networking → Custom Domain**. Add `jobsviadraft.com`.
   **Keep `resumemaster.one` attached — permanently.**

   ~~Add `www.jobsviadraft.com`~~ · ~~both serve one app until P4 lands~~ — ⛔ **struck
   2026-09-26.** Both were written expecting the old domain to be detached after P4, which freed
   the second of Railway's two custom-domain slots for `www`. The old domain is staying, so the
   slot never frees and `www` is dropped: the bare apex is canonical and `docs/BRAND.md` says so.
   This is not a loss — `host_permissions` is a match pattern and `https://jobsviadraft.com/*`
   does **not** match a `www` host, so a `www` that worked would have been a way to break the
   extension quietly.

   ⚠ A separate Resume Master service would need a slot of its own. Confirm whether Railway counts
   custom domains per service or per account **before** planning the split; this document does not
   know and neither did the plan that assumed a free slot.
2. At the registrar, add the records Railway specifies. An apex domain needs `ALIAS`/`ANAME` or the
   registrar's flattening; a bare `CNAME` at the apex is invalid.
3. Wait for the certificate. Confirm `https://jobsviadraft.com/api/version` answers **JSON** — not a
   certificate warning, not the SPA shell.

### Google OAuth — sequence matters or sign-in breaks
In Cloud Console → Credentials → the OAuth client:
1. **Add** `https://jobsviadraft.com/auth/google/callback` to Authorised redirect URIs. Remove
   nothing.
2. **Add** `https://jobsviadraft.com` to Authorised JavaScript origins. Remove nothing.
3. Only once the new domain serves and sign-in is confirmed there, set `GOOGLE_CALLBACK_URL` in
   Railway.
4. ~~Remove the old URI at the very end, after the extension update is live.~~ ⛔ **STRUCK
   2026-09-26 — DO NOT DO THIS.** Resume Master is a product on that domain, and its own users sign
   in through that callback. Removing it is not cleanup; it is turning off sign-in for a live
   service. **Both redirect URIs stay listed, indefinitely.** An OAuth client may hold many, and
   holding an extra one costs nothing.

### LinkedIn
Developer app → Auth → Authorised redirect URLs: add the new, **remove nothing — not "not yet",
not ever.** Same reasoning as the Google client above: the old URL serves a product, not a legacy
address.

### Railway env — only after the new domain serves
```
APP_BASE_URL   → https://jobsviadraft.com
FRONTEND_URL   → https://jobsviadraft.com
GOOGLE_CALLBACK_URL → (step 3 above, not before)
```

### Chrome Web Store
Check whether the pending item allows **replacing the package and editing listing fields in place**.
If it does, use it — it may preserve queue position. If not, cancel and resubmit; two days is a
small loss.

### Trademark
Class 42 for SaaS, often with 9 and 35. A bare word mark on a common English word is harder to
register than a stylised or compound mark. Worth a professional opinion *before* filing, and the
filing should match exactly what ships — see P1.

---

## P1 — The brand decision

```
⛔ MAKE THIS ONCE, WRITE IT DOWN, AND DERIVE EVERYTHING FROM IT. Deciding per-file is how two names
ship. Record the answers in docs/BRAND.md before any code changes.

  · product name in the UI — "Draft"? "Draft Jobs"? exact casing
  · the Chrome Web Store title
  · the publisher / company name — this feeds the trader declaration, currently NON-TRADER
  · the email sender name and address, if any
  · does "Resume Master" survive anywhere as a legacy name, or nowhere
  · Android applicationId: currently com.resumemaster.android. ⛔ IMMUTABLE AFTER FIRST PUBLISH.
    The app is NOT published, so this is decided now or never.
  · iOS bundle identifier — same permanence, same window
  · git repo names — optional, disruptive, cosmetic. Decide and move on.

State clearly which identifiers DO NOT change: database table names, column names, npm package
names, internal module names. Renaming those is cost without benefit.
```

---

## P2 — Single-source, with a guard that cannot go stale

```
Session-aware: read by SYMBOL, not line number. Re-derive the test baseline first (last known 2596).
Regression-proof: dependents and children in the SAME pass with verdicts.

This is the documentation that works in this codebase. Prose goes stale — NEXT_WORK.md was wrong
eight times. A guard test does not.

1 · ONE ORIGIN CONSTANT, one BRAND constant, per repo. Everything derives from them.
2 · ⛔ extension/config.js and extension/background.js hold DUPLICATE copies of the base URL BY
    DESIGN — a service worker cannot share plain-script globals, and the code says so. They have
    drifted before. Keep the pair, and add a test asserting they are byte-identical. Do not create
    a third copy.
3 · THE GUARD IS THE DELIVERABLE. A test asserting no literal `resumemaster`, `Resume Master`, or
    `resumemaster.one` survives outside the single source and an explicit allowlist. ⛔ VERIFY IT
    FAILS by reintroducing a literal, then remove it. A guard never seen to fail is not evidence —
    six have shipped inert in this project.
4 · The allowlist is where legacy mentions live, each with a stated reason: historical migration
    comments, the corrections register, git history references.
```

---

## P3 — The sweep

```
1 · INVENTORY FIRST, REPORT BEFORE CHANGING. Grep all three repos for `resumemaster.one`,
    `resumemaster`, `Resume Master`, `resume-master`. Exclude node_modules/build/dist/.git.
    Group as: SHIPS TO USERS · SHIPS TO REVIEWERS · TEST FIXTURES · internal only · docs.

2 · KNOWN LOCATIONS, a starting point and not the answer:
    · extension/config.js + background.js (the duplicate pair)
    · extension/manifest.json — name, description, host_permissions
    · the privacy policy — served by the CLIENT BUILD, so changing it requires a deploy
    · STORE_LISTING.md · PRIVACY_RECONCILIATION.md · MANIFEST_RATIONALE.md
    · contract/mobile-api.v1.json and both mobile repos
    · e4PolicyVerify.mjs, the extension submission tests, the mobile contract checks —
      ⛔ these HARDCODE the domain. They must assert against the single source, or they pin the old
      name forever.

3 · SESSIONS DO NOT CROSS DOMAINS. The session cookie is HttpOnly connect.sid, 7-day rolling,
    domain-scoped. A user signed in on the old domain has no session on the new one. Report what
    they see. ⛔ An unexplained sign-out reads as a bug, and this project's AH1 finding was a logout
    that did not log out. Check the same for the per-tab auth-context token and the bearer path
    (GET /api/auth/mobile-token).

4 · CORS, CSP, and any allowlist naming the old origin. Including the extension manifest's
    script-src 'self'.

5 · ABSOLUTE URLS ALREADY SENT OUTWARD and not changeable later: OAuth callbacks (P0), the privacy
    policy URL the Web Store holds, anything written into stored data rather than rendered per
    request.

6 · REDIRECT POLICY. Both origins serve identically. ⛔ **NEVER 301 the old domain.**

    ~~while the reviewed extension still points at it~~ · ~~State when the 301 becomes safe~~ —
    struck 2026-09-26. The original framing made this a countdown: a temporary ban that expires
    when the extension update ships. It is permanent. A credentialed `fetch` does not follow
    redirects, so a 301 on an API route fails SILENTLY — an opaque response that reads as an empty
    answer, not as an error — and that is true of every credentialed client of that origin, now and
    later, not only of the extension that happened to prompt the rule. **There is no "when".**

VERIFY: GET https://jobsviadraft.com/api/version returns the expected commit — assert the JSON key,
never a 200. Sign in end to end on the new domain including Google OAuth. The OLD domain still
serves and still signs in. The privacy policy is reachable on both — and ⛔ verify its WORDING by
grepping the deployed bundle, because the URL returns a ~2,044-byte SPA shell with zero policy text.
```

---

## P4 — Extension ✅ RAN 2026-09-26

**Everything in this repository is done. The dashboard steps are not, and no agent can do them.**
`npm test` went from 2646/2644/**2** to **2648/2648/0** — the two deliberate failures cleared by
being fixed, which is how they were always meant to go.

### What was done

| | | |
|---|---|---|
| 1 | Package rebuilt | `resume-master-extension-v1.1.0.zip`, 14 files, byte-identical to source. The v1.0.0 artifact was **deleted** — two zips in `submission/` is the same "which artifact is real" ambiguity that produced the original hand-assembled bundle, and git keeps the old one |
| 2 | Manifest | `name: "draft"`, `version: "1.1.0"`, `host_permissions` and `privacy_policy_url` → `jobsviadraft.com` |
| 3 | `STORE_LISTING.md` | Rewritten, including a "what changed since v1.0.0" block for the reviewer. ⚠ **Test instructions are still EMPTY and that is a blocker** — see below |
| 4 | Screenshots | All three regenerated, new brand in frame, 1280×800 / 24-bit / no alpha. Both assertions kept |
| 5 | `PRIVACY_RECONCILIATION.md` | All four columns updated, plus new rows for `auth.js` |
| 6 | The policy | Rewritten and verified in the built bundle by grep, not by loading the URL |
| 7 | Casing | `WORDMARK = "draft"` added beside `BRAND = "Draft"`; see `docs/BRAND.md` |

### ⛔ What P4 found that was not on the list, and it is the important part

**The privacy policy had been factually wrong for two days and the test built to catch that was
asleep.** `extension/auth.js` — added by the session-identity fix on 2026-09-24 — writes two
storage keys. The policy said the extension "keeps four things"; it kept six. Worse, it said **"None
of them is sent anywhere by the extension"**, which stopped being true the moment the extension
carried a token of its own, and which a reviewer falsifies by watching a single request.

`test/privacyReconciliation.test.js` counts storage writes and asserts the policy's stated count
matches. It kept passing, because **its input was a hardcoded array of six filenames** and nobody
added the seventh. The count is now derived from the shipped bundle, so a new extension file cannot
be invisible to it. Both the count and the retracted claim are corrected; `docs/EXTENSION_DIAGNOSIS.md`
§6.6 carries the full account.

⚠ **The screenshot harness had also been unable to run since 2026-08-27**, for the same underlying
reason and equally silently: its stub server had no `/api/auth/extension-token`, so every call
through `authedFetch` returned null and the run died at "Sign in to Draft first" before the overlay
rendered. Its `/api/auth/me` stub also returned a flat `{username}` where the real route returns
`{user:{username}}` — a 200 with the wrong shape, which left the popup rendering its "your account"
fallback into a store listing image. Both stubs fixed.

### ⛔ What is LEFT, and it is all the owner's

1. **A reviewer test account.** There is none. Checked, not assumed: the local database holds
   `system`, `admin`, `johndoe` and the owner's account, and nothing named for Web Store review
   exists anywhere in this repository or its history. **The extension does nothing without a signed-in
   account** — a reviewer sees "Sign in to Draft first" and stops, and "I could not test it" is a
   rejection. `STORE_LISTING.md` § Test instructions has the walkthrough written and the credentials
   deliberately blank. ⛔ Do not commit them; that file is tracked.
2. **Deploy the client before the listing cites the policy URL.** The policy TEXT changed this
   release. Reviewers fetch it, and it is served by the client build.
3. **Upload v1.1.0.** Replace in place if the pending v1.0.0 item allows it. ⛔ **Re-paste the
   `storage` and host-permission justifications** — both changed materially, and a dashboard field
   contradicting the policy is the rejection this whole four-column join exists to prevent.
4. ⛔ A rename plus a host-permission change is the shape that triggers an in-depth review. Expect a
   longer queue than the first submission.

⚠ Not verified, and it cannot be from here: `privacy@jobsviadraft.com` is published in a legal
document a reviewer reads. **Nothing in this repository can confirm that mailbox exists.**

---

## P5 — Documentation reset

```
⛔ "REMOVE ALL OTHER DOCUMENTATION" NEEDS CLASSIFYING FIRST. Some files in docs/ are load-bearing in
ways their names do not show. Deleting by directory sweep breaks a passing test and destroys the
only independent validation the ATS engine has.

1 · INVENTORY every file in docs/ and classify:
    KEEP — referenced by code or a test, or irreplaceable data:
      · PRIVACY_RECONCILIATION.md  — enforced by privacyReconciliation.test.js
      · am1-ats-graded-corpus.json — the owner's 30 human grades; ⛔ IRREPLACEABLE, the original
        postings were destroyed in the id-85 deletion
      · store-screenshots/         — the listing assets
      · any file a test reads. ⛔ GREP FOR IT; do not judge by filename.
    FOLD IN — session reports whose findings already live in FINDINGS_ARCHIVE.md
    DELETE — superseded plans, retired prompt docs, resolved status files
    ⛔ Report the classification and get sign-off BEFORE deleting anything.

2 · THE NEW SET, and it is small:
    · README.md        — what this is, how to run it, where to look
    · HANDOFF.md       — the orientation doc. Under two screens
    · ARCHITECTURE.md  — written FROM THE CODE during the sweep, not from memory
    · NEXT_WORK.md     — open work only
    · FINDINGS_ARCHIVE.md + CORRECTIONS_REGISTER.md — kept, they are the institutional memory
    · BRAND.md         — P1's decisions
    Everything else earns its place or goes.

3 · ARCHITECTURE.md IS THE OPPORTUNITY. The sweep walks every file anyway, so the inventory is free.
    ⛔ Write it from what the code DOES, not what docs claim. The curation audit is the model: it
    measured, and it overturned several beliefs that had survived months — skills_json was 99.8%
    not 37%, G1 had no effect path at all, profileTitleSql excluded 5 of the owner's 12 best
    matches. Every figure in it carries how it was measured.

4 · HANDOFF.md must state plainly what WORKS versus what is BUILT BUT DORMANT. As of the last audit:
    the apply pipeline has completed ONE real application · job_applications is empty, so nothing
    connects any scoring work to whether an employer replied · the board does not rank by fit, it
    ranks by discovered_at DESC · the Anthropic account has no credit, so nothing has enriched since
    09-17 and the backlog exceeds 1,470 · ats_term_weights go stale 2026-10-13, after which scoring
    silently reverts to unweighted.

5 · A DOC GUARD, if it is cheap: a test asserting the migration high-water and test count quoted in
    HANDOFF.md match reality, so the doc fails CI rather than being discovered stale by a ninth
    session. This is the only thing on the list that prevents recurrence rather than cleaning up.
```

---

## Recorded for later — the two-sided daily draft

Not in scope. Written down so it is not lost, and because it should inform P5's architecture doc.

**Separate logins and surfaces for candidates, recruiters and ATS partners.** FE-6 built a recruiter
surface with no front door — no recruiter role, no signup path. This is that, properly.

**A daily draft instead of a full board.** Both sides receive a handpicked set from the curation
logic rather than browsing everything.

⭐ **Why this fits the measurements better than the current model:** ρ ≈ 0.75 supports *coarse
ordering*, not a trustworthy full ranking. A full board implies exhaustiveness and invites the user
to judge the ordering across 2,460 rows — which is exactly what the engine cannot support. **A daily
set of ten only requires that the top ten are good**, which is the one thing coarse ordering can
deliver. It also sidesteps the open "board does not rank by fit" problem by changing what is
promised, and it makes the name literal.

The hard parts, for when it is scoped: the recruiter side's companies-and-roles-only integrity
boundary (§7) · what happens when a day's draft is empty · and that it needs outcome data to tune,
which does not exist yet.
