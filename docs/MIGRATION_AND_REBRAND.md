# Migration + Rebrand + Documentation Reset

**One project.** `resumemaster.one` → `jobsviadraft.com`, "Resume Master" → **Draft**. The Chrome
extension package is replaced in place rather than resubmitted from scratch where the dashboard
allows it.

The rename touches every file that hardcodes a name or an origin, which makes it the right moment to
collapse those into single sources and to rebuild the documentation from measured state.

---

## Sequence

| | Phase | Blocking |
|---|---|---|
| **P0** | Owner: DNS, Railway, OAuth | everything |
| **P1** | Brand decision, written down once | all code work |
| **P2** | Single-source the brand and origin, with a guard | the sweep |
| **P3** | The sweep — all three repos | the extension |
| **P4** | Extension: replace the package, new screenshots | — |
| **P5** | Documentation reset | last, so it documents the end state |

---

## P0 — Owner actions, before any code

### DNS and Railway
1. Railway → the service → **Settings → Networking → Custom Domain**. Add `jobsviadraft.com` and
   `www.jobsviadraft.com`. **Keep `resumemaster.one` attached** — both serve one app until P4 lands.
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
4. Remove the old URI at the very end, after the extension update is live.

### LinkedIn
Developer app → Auth → Authorised redirect URLs: add the new, remove nothing yet.

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

6 · REDIRECT POLICY. Both origins serve identically until P4 lands. ⛔ Do NOT 301 the old domain
    while the reviewed extension still points at it — a 301 on an API route breaks a fetch that does
    not follow redirects, which is exactly the shape of the extension's credentialed calls. State
    when the 301 becomes safe.

VERIFY: GET https://jobsviadraft.com/api/version returns the expected commit — assert the JSON key,
never a 200. Sign in end to end on the new domain including Google OAuth. The OLD domain still
serves and still signs in. The privacy policy is reachable on both — and ⛔ verify its WORDING by
grepping the deployed bundle, because the URL returns a ~2,044-byte SPA shell with zero policy text.
```

---

## P4 — Extension

```
1 · Replace the package in place if the dashboard allows; otherwise cancel and resubmit.
2 · manifest: name, description, host_permissions → the new origin. Deliberate version bump.
3 · STORE_LISTING.md in full — title, summary, description, single purpose, all four permission
    justifications, data-use disclosures, privacy policy URL, test instructions. The test account's
    credentials must still work on the new domain.
4 · SCREENSHOTS: the three committed images show the old brand in-frame. Regenerate via the harness.
    ⛔ It asserts 1280x800, 24-bit, no alpha, and checks captures against the owner's REAL profile
    values — keep both assertions.
5 · PRIVACY_RECONCILIATION.md's four-column join is enforced by a test. Update all four columns, and
    note its third-party row is MANUALLY MAINTAINED and not covered by that test.
6 · The policy must be live and correct on the new domain BEFORE the listing cites it. Reviewers
    fetch it.
7 · ⛔ A rename plus a host-permission change is the shape that triggers an in-depth review. Expect
    a longer queue.
```

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
