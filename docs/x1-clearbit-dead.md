# Task X — Clearbit is dead

**Date:** 2026-09-08 · **Baseline before:** 2314 tests · **After:** 2326, 0 failing.
`ae5BoardUi` harness: 24 pass / 1 fail — **identical to HEAD**; that one failure is pre-existing
and unrelated (see the end).

---

## 1. Confirmed gone, not blocked and not rate-limited

The distinction matters, because "rate-limited" would mean back off and "blocked" would mean route
around — and neither is what happened.

```
logo.clearbit.com   →  NOERROR, no ANSWER section, SOA in AUTHORITY
clearbit.com        →  3 A records   (control: the company is still trading)
```

Both **Google** (`dns.google/resolve`) and **Cloudflare** (`cloudflare-dns.com`) return the same,
and the SOA is `ns-1077.awsdns-06.org` — **Clearbit's own Route53 nameserver**. The authoritative
operator is answering "this name has no address." That is a deliberate removal, not an outage, not
a filter on this network, and not something a status code can express.

**That last part is why the existing guard could not see it.** `fetchLogoUrl` verified with a HEAD
request and treated a throw as "network unavailable". There was no server to answer, so the request
never produced a status at all — and the code's response to that was, verbatim:

```js
} catch {
  // Network unavailable — return known URL anyway (browser will handle 404)
  return getKnownLogoUrl(companyName);
}
```

`getKnownLogoUrl` returned **another Clearbit URL**. The fallback for "this provider is unreachable"
was that provider. That is how **1290 of 1296 rows** came to hold an address that resolves to
nothing.

---

## 2. Fixed — replaced, with the request actually stopped

Chosen after checking three options; the user picked DuckDuckGo. Verified live: real per-domain
icons, byte-distinct across four spot-checks (not one shared placeholder), honest 404s for a domain
it does not have.

### One host, in one place

Clearbit's hostname was written out longhand in **three** files — `shared/companyLogos.js`,
`services/jobs/enrichLogos.js` and `server.js`'s `fetchCompanyIcon`. That is why retiring it was a
hunt rather than an edit. There is now a single `LOGO_HOST` constant with `logoUrlForDomain()` and
`isKnownLogoUrlHost()` beside it; the other two files import it. Retiring the *next* provider is one
line.

### The request now actually stops

The task's real ask was *"stop issuing the request, rather than letting it fail per card per
render."* CompanyIcon's `failed` flag was **component-local `useState`**, so it silenced only the
card it was set on — and the board unmounts and remounts cards as it scrolls and paginates, with
every remount starting again at `failed = false`. A dead host was therefore re-requested per card,
per scroll, for the whole session.

It is now a module-level `Set` keyed by URL: the first failure anywhere silences that URL for every
card at once. Deliberately session-scoped (persisting would cache a transient blip forever) and
deliberately not state (a shared value inside one component's lifecycle *is* the bug).

### `fetchLogoUrl` no longer invents a URL

Its `catch` returns `null`. A null is honest and recoverable — CompanyIcon resolves the same URL
client-side from the same table and falls back to the lettered tile. Storing an unverified URL is
the one outcome with no recovery.

### `server.js`'s silent second provider, removed

`fetchCompanyIcon` fell through to `https://www.google.com/s2/favicons?domain=…` whenever the
Clearbit HEAD failed — which, once the DNS went, was **every call**. So the app had quietly switched
which third party saw the user's browsing, from the one the privacy policy names to one it does not.
It now returns `null` and the lettered tile renders, which is the disclosed behaviour. Both retired
hosts are swept by the backfill.

### The 1290 rows

`services/jobs/backfillCompanyLogos.js`, following `backfillAutomationTier`'s established shape
exactly — called at boot in retired-hosts-only mode (a no-op once clean), plus
`scripts/recomputeCompanyLogos.js --all` as the admin action. **Offline, no HEAD request**: it runs
at boot, and a boot path that waits on a third party hangs when that third party is precisely what
broke.

It rewrites only URLs on a host *this module has produced*. A **feed-supplied** logo (LinkedIn's,
serpapi's thumbnail) is more specific than anything the domain table can derive and is never
touched, in either mode.

```
before:  clearbit (RETIRED)  1290   |   (null)  6
after:   current provider    1289   |   (null)  7
```

---

## 2b. A wrong logo, found while verifying the backfill

The rewritten rows included:

```
Physical Superintelligence  ->  https://icons.duckduckgo.com/ip3/intel.com.ico
```

`companyToDomain` matched with a bare `lower.includes(key)`, so a brand buried inside a longer word
counted. Physical Super**intel**ligence is a real row on this board. Realistic siblings, all
verified broken before the fix:

| name | resolved to |
|---|---|
| Physical Super**intel**ligence | intel.com |
| **Square**space | squareup.com |
| Al**together** Labs | together.ai |
| **Neon**atal Care Group | neon.tech |
| **Meta**bolic Health Co | meta.com |
| **Apple**cart | apple.com |

This is the one outcome the module's own doctrine rules out — *"A GUESS IS NOT A LOGO"* — and it is
worse than the failure it was meant to prevent. A lettered tile admits it does not know; Intel's
logo on another company's card asserts something false.

Now matched on word boundaries, with the key escaped rather than split so the punctuated and spaced
keys still work (`fly.io`, `c3.ai`, `x.com`, `hugging face`, `scale ai`). **All 81 KNOWN_DOMAINS
entries still resolve to themselves**, asserted as a test over the table itself rather than a
sample. Physical Superintelligence now correctly clears to NULL and gets its letter.

---

## 3. Other external dependencies — swept

Every external host production code reaches for, resolved over DoH. DNS first, deliberately: this
failure was NODATA-shaped and no HTTP probe reports it.

**`logo.clearbit.com` is the only dead name of 24.** Live: `api.lever.co`,
`boards-api.greenhouse.io`, `api.ashbyhq.com`, `apply.workable.com`, `api.smartrecruiters.com`,
`jobs.smartrecruiters.com`, `adobe.wd5.myworkdayjobs.com`, `api.adzuna.com`, `serpapi.com`,
`connect.jobo.world`, `api.groq.com`, `platform.claude.com`,
`generativelanguage.googleapis.com`, `api.resend.com`, `api.github.com`, `api.linkedin.com`,
`accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`,
`www.recaptcha.net`, `www.google.com`, `icons.duckduckgo.com`, `clearbit.com`.

### But the DNS sweep is the easy half, and it would have caught only one of the three

The task calls Clearbit the third dead external thing found by accident. The other two were **not
dead hosts**:

- The **Groq model retirement** — `api.groq.com` resolves fine; a model *id* was withdrawn.
- **Task W's three lever slugs** — `api.lever.co` resolves fine and returns 200 for a live board;
  three *company slugs* had gone.

So the recurring shape is **an external IDENTIFIER retired while its host stays up**: model ids,
ATS slugs, API versions, board tokens. A host sweep cannot see any of them, and each one fails as a
plausible-looking empty success — a 404 swallowed by a `.catch(() => [])`, or a 200 with an empty
array. The three places this codebase carries such identifiers are `shared/anthropicModels.js`,
`company_ats_list.ats_slug`, and now `LOGO_HOST`; the first two already have offline tests pinning
them, and the third does as of this task.

### Two general lessons, both instances of one rule

**A liveness check that falls back to the same provider is not a liveness check.** Both
`fetchLogoUrl` and `fetchCompanyIcon` had one, and both answered their own failure with the thing
that had just failed.

**The harness stubbed the very thing that broke.** `ae5BoardUi.mjs` intercepted
`/logo\.clearbit\.com/` and answered with a 1×1 PNG — correctly, since it must not depend on a third
party's uptime, but it means *the logo assertions kept passing for the entire time every logo on the
board was dead*. The interception now matches the shared `LOGO_HOST`, so it stubs whatever the app
actually calls rather than a hostname literal that can go stale in exactly the way this task is
about. Same fix applied to `aj2BoardCursor.mjs` and `ak2BandSurfaces.mjs`.

The `test/boardListingLayout.test.js` assertion had the identical problem — it pinned the literal
`"https://logo.clearbit.com/openai.com"` and went on passing while that host was dead, because a
URL-shaped string was all it checked. It now asserts against `LOGO_HOST`.

---

## Verified

- **2326 node tests, 0 failing** (11 new in `test/companyLogoProvider.test.js`).
- **`ae5BoardUi` in real Chrome: 24 pass / 1 fail, identical to HEAD.** The board renders 9 logo
  images and 1 lettered tile, resolved from the shared table:
  `OpenAI -> https://icons.duckduckgo.com/ip3/openai.com.ico`.
  Its Shopify fixture, which used a *Clearbit* URL to stand for a "feed-supplied" logo, now uses a
  LinkedIn CDN URL — the old fixture made that assertion pass for the wrong reason, since the feed
  URL was on the stubbed host.
- **Real images decode in a real browser.** The six live board URLs loaded in headless Chrome:
  6/6 with `naturalWidth > 0` (48×48 to 240×240), screenshotted and eyeballed — Stripe, Airbnb,
  Figma, Notion, OpenAI and Linear all render as their actual logos.
- **Privacy policy updated** and the reconciliation test tightened: it now derives the expected
  brand from `LOGO_HOST` rather than a hardcoded name, and fails if either retired host survives in
  code the policy no longer discloses. Comments are stripped first, following
  `boardListingLayout.test.js` — a check that fails on its own rationale is a check nobody keeps.

## Pre-existing, not touched

`ae5BoardUi` reports **`AE5 the ATS badge survived — MISSING`** on HEAD as well as on this branch,
and `scripts/harnessBaseline.json` expects 25 passes where HEAD delivers 24. So the board has lost
its ATS badge at some point before this task. Out of scope here, but it is a real regression sitting
one line below a green suite.
