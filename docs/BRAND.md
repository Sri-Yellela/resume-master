# Brand

**Decided 2026-09-23 by the owner. This file is the single source for every naming decision.**
Derive from it; do not decide per-file. Deciding per-file is how two names ship.

---

## The decision

| | |
|---|---|
| **Public brand** | **Draft** — the name, as a word in a sentence |
| **Wordmark** | **draft** — lowercase, the name set as a mark. Added 2026-09-26 |
| **Domain** | `jobsviadraft.com` |
| **Canonical host** | `https://jobsviadraft.com` — bare apex, no `www` |

"Draft" is what users see everywhere: web, app icon, App Store, Play Store, Chrome Web Store,
marketing, email. `jobsviadraft.com` is the address, not the name — never write "Jobs via Draft" as
a product name.

---

## ⬛ The casing rule — decided 2026-09-26

**The mark is lowercase. The word is not.** Two constants in `shared/brand.js`:

```js
export const BRAND    = "Draft";   // the name, inside prose
export const WORDMARK = "draft";   // the name, as a mark
```

| Use `WORDMARK` — the name stands alone as a label | Use `BRAND` — the name is a noun in a sentence |
|---|---|
| the nav and footer lockups | marketing copy, the About page, the FAQ |
| the stamp logo | toasts and error messages the extension shows |
| the extension's `manifest.name` | the email sender name |
| the Chrome Web Store title | the `aria-label` on the logo link — a screen reader speaks it |
| the extension's options-page heading | the copyright line |

⛔ **WHY TWO CONSTANTS AND NOT ONE.** A single lowercase `BRAND` renders every sentence wrong:
*"draft is an AI-powered job application platform"*, *"Does draft auto-apply to jobs on my
behalf?"* — a reader parses those as typos, not as styling. Lowercasing in CSS instead was
considered and rejected: `text-transform` does not reach the extension's `manifest.json`, the
store title, or a `<title>` element, so the mark would be lowercase in the app and title-case
everywhere a reviewer looks.

⛔ **THE RISK THIS INTRODUCES, AND THE GUARD FOR IT.** A second constant holding a name is a second
name waiting to happen, which is the exact failure this file opens by warning about. So
`test/brandAndOriginGuard.test.js` asserts `WORDMARK === BRAND.toLowerCase()` and that the two
differ — same letters, different case, nothing else. **If the mark ever needs to be a different
WORD, that is a decision for this file, not a constant quietly diverging.** The same test also pins
the extension's two directions: `manifest.name` must equal `WORDMARK` character for character —
`extension/options.js` tells the user to look for that exact string in Chrome's shortcuts list —
and its user-facing sentences must use `BRAND`.

---

## Canonical host — why bare apex

`www.jobsviadraft.com` is configured in DNS and points at the same Railway target, but **is not
activated, and the plan to activate it is dropped.** The Railway plan allows two custom domains and
both slots are in use (`resumemaster.one` + `jobsviadraft.com`).

⛔ **Corrected 2026-09-26: the second slot never frees.** This section used to say "yet", on the
assumption that `resumemaster.one` would be retired after the extension update. It is not being
retired — it is a product's address (`docs/PRODUCT_MODEL.md`). **The bare apex is canonical,
permanently.** That is not a loss: see the match-pattern warning immediately below, which makes a
working `www` a way to break the extension quietly rather than a convenience.

⛔ **Everything that hardcodes a host uses the bare apex.** `APP_BASE_URL`, `FRONTEND_URL`, the
OAuth redirect URIs, the extension manifest's `host_permissions`, the store listing, the privacy
policy URL.

⚠ **`host_permissions` is a match pattern.** `https://jobsviadraft.com/*` does **NOT** match
`www.jobsviadraft.com`. If any code path ever emits a `www` URL, the extension's credentialed fetch
is blocked. Since the app's own origin constant is the bare apex this should not arise — but assert
it during the sweep rather than assuming.

~~**After `resumemaster.one` is retired:** add `www.jobsviadraft.com` in Railway…~~ — ⛔ **struck
2026-09-26. There is no "after".** The old domain is staying.

**The no-301 rule survives the correction and gets stronger.** It was stated here as a property of
the apex redirect; it is a property of *any* redirect on *either* origin. A credentialed `fetch`
does not follow redirects, so a redirected `/api/...` returns an opaque response that reads as an
empty answer rather than an error — silently, for every credentialed client, not only the
extension. **Serve every origin directly. Never redirect one at another.**

---

## Names, by surface

| Surface | Value | Which constant |
|---|---|---|
| UI lockups — nav, footer, stamp logo | **draft** | `WORDMARK` |
| Chrome Web Store title | **draft** | `WORDMARK` |
| Extension `manifest.name` | **draft** | `WORDMARK` |
| App Store / Play Store | **draft** | `WORDMARK` |
| Product name inside a sentence | **Draft** | `BRAND` |
| Email sender name | **Draft** | `BRAND` |
| Marketing copy | **Draft** | `BRAND` |
| Domain | `jobsviadraft.com` | `CANONICAL_HOST` |

**"Resume Master" survives nowhere as a name for THIS product.** Legacy mentions are allowed only
in: historical migration comments · `docs/CORRECTIONS_REGISTER.md` · `docs/FINDINGS_ARCHIVE.md` ·
git history. Those are the guard's allowlist.

---

## ⛔ Resume Master is a SECOND PRODUCT — the guard needs a carve-out, and it cannot be pre-added

**Corrected 2026-09-26.** The sentence above used to end the matter. It no longer does: the owner
decided on 2026-09-25 (`docs/PRODUCT_MODEL.md`) that **Resume Master is a separate product** — a
stateless processing service keeping `resumemaster.one`. So the repository will legitimately
acquire `resumemaster` and `Resume Master` literals again, in files where they are **correct**.

`test/brandAndOriginGuard.test.js` forbids exactly those literals outside an allowlist. The two
facts have to be reconciled deliberately, because the failure mode is well documented in this
project: **a guard that cries wolf gets suppressed, and then it is gone for the case that
mattered.** Six guards here shipped inert that way.

### The rule

| | |
|---|---|
| **This product** | never "Resume Master", anywhere a user can see it. Unchanged |
| **The other product** | "Resume Master" is its NAME. Its own files say so, correctly |
| **Which files** | only files that are ABOUT the second product — its service, its privacy policy, its API docs |
| **What is still forbidden** | this product's UI, listings, policy or marketing naming the old brand. That is a regression, not a second product |

### ⛔ Why the allowlist entry cannot be added in advance

**The allowlist self-prunes.** `test/brandAndOriginGuard.test.js` asserts that every allowlisted
path *currently contains* a legacy literal, and fails the entry if it does not — the anti-rot
mechanism that stops an entry outliving its reason and silently protecting a later regression.

So an entry added today, before any Resume Master file exists, **fails immediately**. It is not
possible to prepare the ground, and that is the mechanism working rather than getting in the way.

**The entry is added in the SAME commit as the first file that needs it**, as a prefix — likely
`resume-master/` or whatever the service directory is called — with a reason of the form:

> "The second product's own source. `Resume Master` is its NAME, not a legacy mention of this
> one's. Removed if that product is discontinued or renamed."

⚠ **Two things to get right when that commit lands**, both of which this project has already been
bitten by:

1. **A PREFIX, not a blanket exemption on the word.** Widening `FORBIDDEN` to stop matching
   `Resume Master` anywhere would disarm the guard for this product's files too, which is the whole
   thing it protects. Scope the permission to the directory.
2. **`git ls-files` only sees TRACKED files.** A brand-new directory is invisible to the scan until
   it is staged, so the guard passes vacuously and then goes red on commit.
   `git add -N` the new files before running the guard for the first time — `test/
   productionOriginConsistency.test.js` learnt this the hard way.

---

## ⛔ Permanent identifiers — decided

Both are **immutable after first publish**. Neither app is published, so these remain editable until
then — but treat them as settled and change them only with a deliberate decision.

| | Current | **Decided** |
|---|---|---|
| Android `applicationId` | `com.resumemaster.android` | **`com.draft.android`** |
| iOS bundle identifier | check `project.pbxproj` | **`com.draft.ios`** |

⚠ **Verify availability before first publish, not after.** Bundle identifiers are globally unique
across each store, and "draft" is a contested namespace. Check by searching `com.draft.android` in
the Play Store and attempting to reserve `com.draft.ios` in App Store Connect — both answer
immediately. If either is taken, the fallback is `com.jobsviadraft.*`, which matches a domain the
owner holds and is certain to be free. Changing it before publish is a grep across two unpublished
repos; changing it after means a new listing with zero installs and zero reviews.

Note reverse-DNS convention assumes you own the matching domain. `com.draft.*` implies `draft.com`,
which is not held. Neither store enforces this, and **no user ever sees the identifier** — the app is
called **Draft** in the launcher, the listing, the icon and every screen.

⚠ **The sweep's guard must treat the bundle identifier as an allowed exception**, whatever value it
holds at the time. Otherwise a lingering `com.resumemaster.android` fails a test asserting no
"resumemaster" survives, and someone suppresses the guard to make the build pass — which is how six
guards in this project ended up shipping inert.

---

## Store name and trademark — the owner's plan

"Draft" is currently free as a store display name and as a trademark. The owner intends to claim
both **once the product is on the market**.

⚠ **Store display names and bundle identifiers are separate namespaces.** "Draft" being free as a
display name says nothing about whether `com.draft.*` is free as an identifier. Check both.

⚠ **An App Store name can be reserved now** with a stub app and held for 120 days. Cheap insurance
on a common word, and independent of the trademark filing, which can wait for launch.

---

## What does NOT change

Renaming these costs work and buys nothing:

- database table and column names
- npm package names
- internal module, function and variable names
- git repository names — `resume-master`, `resume-master-android`, `resume-master-ios`. Optional,
  disruptive, cosmetic. **Decided: leave them.**
- the `RESUME_STYLE_BLOCK` constant and similar internal identifiers

⛔ The sweep's guard asserts no **user-visible** "Resume Master" survives. It must not fire on
identifiers, table names or repo paths, or it becomes noise that gets suppressed.

---

## Trademark

"Draft" was reported available. Before filing:

- SaaS is **Class 42**, often with **9** (software) and **35** (business services)
- A bare word mark on a common English word is harder to register than a stylised or compound mark.
  A logo mark, or `Draft` in a specific stylisation, may be the stronger filing
- ⛔ **The filing must match what ships.** If the mark is "Draft", the UI says "Draft Jobs" and the
  store says "Jobs via Draft", the filing protects none of them cleanly. This file is what "what
  ships" means — keep them aligned
- Worth a professional opinion before filing rather than after

---

## Trader declaration

Currently **NON-TRADER** on the Chrome Web Store, on the basis that no entity is registered and no
payment has been taken. `monetisationEnabled` is `false` and there is no payment processor.

The owner's stated bar for incorporating is **~1000 applications across users**. Revisit the
declaration when money first moves, not when the LLC is filed — the declaration turns on acting for
business purposes, and the first paid subscription is closer to that line than an incorporation
certificate.
