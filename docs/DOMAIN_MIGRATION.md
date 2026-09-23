# Domain migration + rebrand — resumemaster.one → jobsviadraft.com, "Resume Master" → "Draft"

**Two separate projects.** Do them in this order, with a gap between.

| | What | Reversible? |
|---|---|---|
| **M1** Domain migration | serve `jobsviadraft.com`, keep `resumemaster.one` working | yes — DNS and a redirect |
| **M2** Rebrand to "Draft" | every user-visible string, listing, policy | partly — strings yes, a shipped extension listing no |

⛔ **Do not start M2 until the Chrome extension has cleared review.** Its manifest declares
`https://resumemaster.one/*` as its only host permission, and its listing copy, privacy policy URL
and description all reference that domain. Changing any of it mid-review either resets the queue
position or ships a contradiction a reviewer will reject. The old domain must keep serving until
the extension is approved, then ship a versioned extension update.

---

## PHASE 0 — What the owner does by hand

Agents cannot reach any of this. Do these before M1's code work.

### Registrar / DNS
1. Point `jobsviadraft.com` at Railway. In Railway → the service → **Settings → Networking →
   Custom Domain**, add both `jobsviadraft.com` and `www.jobsviadraft.com`. Railway issues the
   certificate; it will give you a `CNAME` target.
2. At the registrar, add the records Railway specifies. An apex domain needs either `ALIAS`/`ANAME`
   or the registrar's flattening — a bare `CNAME` at the apex is invalid.
3. **Keep `resumemaster.one` attached to the same service.** Both domains serve, one app. Do not
   remove the old one at any point in M1.
4. Wait for the certificate to issue on the new domain before changing anything in code. Confirm
   `https://jobsviadraft.com/api/version` answers JSON — not a certificate warning, and not the
   SPA shell.

### Railway environment variables
Two need changing, and **only after** the new domain serves:

```
APP_BASE_URL     → https://jobsviadraft.com
FRONTEND_URL     → https://jobsviadraft.com
```

⛔ Leave `GOOGLE_CALLBACK_URL` alone until step 3 below is done, or you break sign-in.

### Google OAuth — this one breaks login if done in the wrong order
In Google Cloud Console → APIs & Services → Credentials → your OAuth client:
1. **Add** `https://jobsviadraft.com/auth/google/callback` to Authorised redirect URIs.
   **Do not remove the old one yet.** Both can be listed.
2. Add `https://jobsviadraft.com` to Authorised JavaScript origins, keeping the old.
3. Only once the new domain is live and sign-in is confirmed working on it, change
   `GOOGLE_CALLBACK_URL` in Railway to the new URL.
4. Remove the old redirect URI only at the end of M1, after a week of no traffic on it.

### LinkedIn OAuth
The app has an `/auth/linkedin` route. In the LinkedIn Developer app → Auth → Authorised redirect
URLs, add the new domain alongside the old. Same rule: add first, remove last.

### Chrome Web Store — ⛔ NOT YET
Nothing here until the extension clears review. When it does, M2 covers it.

### Trademark
You noted "Draft" is available. Worth checking the class you actually need — software/SaaS is
Class 42 (and often 9 and 35 too), and a bare word mark on a common English word is harder to
register than a stylised mark or a compound. Not blocking; worth a professional opinion before the
filing rather than after.

---

## PHASE M1 — Domain migration

```
Session-aware: read by SYMBOL, not line number. Re-derive the test baseline first (last known 2596).
Regression-proof: dependents and children in the SAME pass with verdicts. REPORT + REAL-run
verification. Commit and push as ONE focused commit, then verify against production by asserting a
JSON key — NEVER a 200, which the SPA catch-all answers for any unknown path.

OBJECTIVE
Serve jobsviadraft.com as the primary domain while resumemaster.one continues to work. This is an
ADDITION, not a replacement. ⛔ Nothing in this phase may break the old domain — the Chrome
extension under review declares https://resumemaster.one/* as its only host permission.

1 · FIND EVERY OCCURRENCE FIRST, REPORT BEFORE CHANGING
   Grep the whole repo for resumemaster.one, excluding node_modules/build/dist/.git. Known so far,
   and this list is a starting point, not the answer:
     · extension/config.js          RESUME_MASTER_URL — the single source for popup and content
     · extension/background.js      a DUPLICATE copy of the same constant, by design, because a
                                    service worker cannot share plain-script globals. These have
                                    drifted before — change both or neither.
     · extension/manifest.json      host_permissions
     · privacy policy               served by the client build, not a static file
     · STORE_LISTING.md, PRIVACY_RECONCILIATION.md, MANIFEST_RATIONALE.md
     · the mobile contract, contract/mobile-api.v1.json, and both mobile repos
     · docs/ — many, and low priority
   Report the full list grouped by: SHIPS TO USERS · SHIPS TO REVIEWERS · internal only.

2 · SINGLE-SOURCE THE ORIGIN. If the app has more than one place that knows its own base URL,
   collapse them. Two constants that can disagree is the defect shape this codebase pays for most
   — extension/config.js and background.js are already an instance of it, kept deliberately with a
   comment. Keep that pair in sync; do not create a third.

3 · ⛔ DO NOT TOUCH extension/ IN THIS PHASE. The package is under review. Any change to it either
   invalidates the reviewed artifact or forces a resubmission. Record the extension's occurrences
   and leave them. They are M2's problem.

4 · REDIRECT, DO NOT BREAK. resumemaster.one must keep answering. Decide and state which:
   a. serve both origins identically (simplest, and required while the extension is under review)
   b. 301 resumemaster.one → jobsviadraft.com  ⛔ NOT while the extension is under review — a 301
      on an API route can break a fetch that does not follow redirects, and the extension's
      credentialed calls are exactly that shape
   Recommend (a) now, (b) later, and say when (b) becomes safe.

5 · COOKIES AND SESSIONS. The session cookie is HttpOnly connect.sid, 7-day rolling, scoped to a
   domain. A user signed in on the old domain has no session on the new one. Report what happens:
   are they silently signed out? Does the app say so? ⛔ An unexplained sign-out reads as a bug, and
   this project's own AH1 finding was a logout that did not log out.
   Also check the extension's credentialed fetches, the per-tab auth-context token, and whether the
   bearer path (GET /api/auth/mobile-token) is domain-bound.

6 · CORS AND CSP. Report every allowlist that names the old origin: CORS config, any CSP
   connect-src or frame-ancestors, and the extension's manifest CSP (script-src 'self').

7 · ABSOLUTE URLS IN OUTBOUND CONTENT. Anything the app sends elsewhere and cannot later change:
   OAuth callbacks (Phase 0), email links if any, the privacy policy URL the Web Store holds, and
   any URL written into stored data rather than rendered at request time.

8 · TESTS AND HARNESSES. Several hardcode resumemaster.one — e4PolicyVerify, the extension
   submission tests, the mobile contract checks. They must assert against whatever the single
   source says, not a literal, or they pin the old domain forever.

VERIFY (real runs)
GET https://jobsviadraft.com/api/version returns the expected commit — assert the JSON key.
Sign in on the new domain end to end, including Google OAuth.
The OLD domain still serves, still signs in, and the extension's capture still posts successfully.
The privacy policy is reachable on BOTH domains and, per the lesson already learned, verify its
WORDING by grepping the deployed bundle — the URL returns a 2,044-byte SPA shell with zero policy
text, so loading it proves nothing.
```

---

## PHASE M2 — Rebrand to "Draft" ⛔ only after the extension clears review

```
Separate from M1 deliberately: a domain move is infrastructure and reversible via DNS; a rename
touches every user-visible string and a shipped store listing, and a rollback cannot be partial.

1 · NAMING DECISION FIRST, BEFORE ANY CODE
   "Draft" is the product; "jobsviadraft.com" is the domain. Decide and write down, once:
     · the product name as it appears in the UI — "Draft" or "Draft Jobs" or something else
     · the extension's Web Store title
     · what the company/publisher is called, which matters for the trader declaration
     · whether "Resume Master" survives anywhere as a legacy name
   ⛔ Every string below derives from that decision. Making it per-file is how two names ship.

2 · USER-VISIBLE STRINGS. Grep for "Resume Master" and "resume-master" across all three repos.
   Note the repos and package names can stay — renaming a git repo is optional and disruptive.
   Distinguish: brand strings (change) from identifiers, table names, npm package names and
   applicationId com.resumemaster.android (do NOT change; an Android applicationId is immutable
   once published, and this one is not published yet so decide now or never).

3 · THE CHROME EXTENSION — a full resubmission
   · manifest name, description, host_permissions
   · both copies of the base URL constant
   · STORE_LISTING.md in full: title, summary, description, single purpose, all four permission
     justifications, data-use disclosures, privacy policy URL, test instructions
   · the three store screenshots — they show the old brand in-frame; regenerate via the harness
   · PRIVACY_RECONCILIATION.md's four-column join, which is enforced by a test
   · a deliberate version bump
   ⛔ A rename plus a host-permission change is the shape that triggers an in-depth review. Expect
   a longer queue than the first submission.

4 · THE PRIVACY POLICY. It names the operator and the domain. It is served by the client build, so
   changing it means a deploy. It must be live and correct BEFORE the extension resubmission cites
   it, and the reviewer fetches it.

5 · THE MOBILE REPOS. ANDROID.md and IOS.md both reference resumemaster.one and the product name.
   Neither app is published, so this is cheap now and expensive later. applicationId and bundle
   identifier decisions are permanent after first publish — settle them in this phase.

6 · TRADEMARK ALIGNMENT. Whatever is filed should match what ships. If the mark is "Draft" but the
   UI says "Draft Jobs" and the store says "Jobs via Draft", the filing protects none of them
   cleanly.

VERIFY
No user-visible "Resume Master" anywhere in any of the three repos — grep-proved, brand strings
only. The extension resubmission's four-column join passes. Screenshots show the new brand. The
policy names the right operator and domain.
```

---

## Owner checklist, in order

**Now, before any code:**
- [ ] Add both domains in Railway → Settings → Networking → Custom Domain
- [ ] Add the registrar records Railway specifies (apex needs `ALIAS`/`ANAME`, not `CNAME`)
- [ ] Wait for the certificate; confirm `https://jobsviadraft.com/api/version` answers JSON
- [ ] Google Cloud Console: **add** the new redirect URI and JS origin, remove nothing
- [ ] LinkedIn Developer app: **add** the new redirect URL, remove nothing

**After M1 deploys and sign-in works on the new domain:**
- [ ] Railway: `APP_BASE_URL` and `FRONTEND_URL` → `https://jobsviadraft.com`
- [ ] Railway: `GOOGLE_CALLBACK_URL` → the new callback
- [ ] Confirm sign-in still works on **both** domains

**After the Chrome extension clears review:**
- [ ] Make the naming decision (M2 step 1) and write it down
- [ ] Run M2
- [ ] Resubmit the extension with new screenshots and a version bump
- [ ] Only then: remove the old OAuth redirect URIs, and consider the 301

**Not blocking, worth doing:**
- [ ] Trademark class check — software/SaaS is Class 42, often with 9 and 35
- [ ] Decide whether the git repos get renamed (optional, disruptive, cosmetic)
