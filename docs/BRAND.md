# Brand

**Decided 2026-09-23 by the owner. This file is the single source for every naming decision.**
Derive from it; do not decide per-file. Deciding per-file is how two names ship.

---

## The decision

| | |
|---|---|
| **Public brand** | **Draft** |
| **Domain** | `jobsviadraft.com` |
| **Canonical host** | `https://jobsviadraft.com` — bare apex, no `www` |

"Draft" is what users see everywhere: web, app icon, App Store, Play Store, Chrome Web Store,
marketing, email. `jobsviadraft.com` is the address, not the name — never write "Jobs via Draft" as
a product name.

---

## Canonical host — why bare apex

`www.jobsviadraft.com` is configured in DNS and points at the same Railway target, but **cannot be
activated yet**: the Railway plan allows two custom domains and both slots are in use
(`resumemaster.one` + `jobsviadraft.com`) until the old domain is retired.

⛔ **Everything that hardcodes a host uses the bare apex.** `APP_BASE_URL`, `FRONTEND_URL`, the
OAuth redirect URIs, the extension manifest's `host_permissions`, the store listing, the privacy
policy URL.

⚠ **`host_permissions` is a match pattern.** `https://jobsviadraft.com/*` does **NOT** match
`www.jobsviadraft.com`. If any code path ever emits a `www` URL, the extension's credentialed fetch
is blocked. Since the app's own origin constant is the bare apex this should not arise — but assert
it during the sweep rather than assuming.

**After `resumemaster.one` is retired:** add `www.jobsviadraft.com` in Railway, confirm the
certificate issues, and keep it serving the same app directly — **no 301.** A redirect at the apex
is what the migration plan exists to avoid: the extension's credentialed `fetch` calls do not follow
redirects, so a redirected `/api/...` fails silently rather than working.

---

## Names, by surface

| Surface | Value |
|---|---|
| UI / product name | **Draft** |
| Chrome Web Store title | **Draft** |
| App Store / Play Store | **Draft** |
| Email sender name | **Draft** |
| Marketing copy | **Draft** |
| Domain | `jobsviadraft.com` |

**"Resume Master" survives nowhere** as a user-visible name. Legacy mentions are allowed only in:
historical migration comments · `docs/CORRECTIONS_REGISTER.md` · `docs/FINDINGS_ARCHIVE.md` · git
history. Those are the guard's allowlist.

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
