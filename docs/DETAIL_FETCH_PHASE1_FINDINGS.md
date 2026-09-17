# Detail-Fetch Economics — PHASE 1 findings

Probe only. **No code was written or changed.** Both sources remain `active=0` in
`company_ats_list`, and `ATS_DETAIL_FETCH_BUDGET` remains unset (total 0 = the whole path off).

Probed live on **2026-09-17** against the three configured tenants:
`smartrecruiters/Ubisoft2`, `smartrecruiters/BoschGroup`, `workday/5|adobe|external_experienced`.

**Headline: the N+1 is real for both sources — no bulk parameter, no feed. But the request
problem the budget was built to solve does not exist.** Neither source rate-limited at any volume
a crawl needs, so the case for Phase 2 rests entirely on *not paying for rows nobody opens*, not on
scarcity. Two of Phase 2's five parts should shrink, one should change door, and one premise in the
brief is stale.

---

## 1 · BULK / EXPANSION PARAMETERS — the loophole does not exist

**SmartRecruiters.** Eleven list-level variants against both companies:
`?expand=jobAd|all|true`, `?fields=jobAd|all`, `?include=jobAd`, `?full=true`, `?details=true`,
`?view=full`, `?detail=full`.

```
Ubisoft2    baseline and all 11 variants: 200, bytes=5117 (identical), totalFound=300
BoschGroup  baseline and all 11 variants: 200, bytes=6360 (identical), totalFound=4840
```

Every response was **byte-identical to the baseline**. Unknown parameters are silently ignored, not
rejected — so a 200 proves nothing here and only the byte count does. The only text-adjacent key in
a list posting is `jobAdId` (a 36-char UUID, present 100/100), which is a *pointer* to the ad, not
the ad.

**Workday.** Twelve POST-body keys (`includeDescription`, `includeJobDescription`,
`expand:['jobDescription']`, `fields`, `include`, `full`, `detail`, `details`, `view:'full'`,
`bulletFields:['jobDescription',…]`, `returnFields`) plus seven query strings on the same endpoint:

```
adobe/external_experienced  baseline and all 19 variants: 200, bytes=9421 (identical), total=711
```

Also byte-identical throughout. A Workday list posting has **five keys and no sixth is obtainable**:
`title, externalPath, locationsText, postedOn, bulletFields` (plus `jobPostingEndDateAsText`,
`timeLeftToApply` on some rows).

> **Plain statement: the N+1 is NECESSARY for both sources.** `services/jobs/detailBudget.js`
> should **not** be deleted for either. This is the opposite of Task W's workable finding, and it
> was worth five minutes to establish rather than inherit.

---

## 2 · NON-API SURFACES — one real find, on Workday only

### 2a · JSON-LD

**Workday: YES.** The server-rendered public job page carries exactly one
`<script type="application/ld+json">` block, a `schema.org/JobPosting`, and the description is
**complete — not truncated**:

| posting | CXS `jobDescription` | JSON-LD `description` |
|---|---|---|
| `Staff-Incident-Response-Commander_R168701` | 8,709 B raw HTML → 6,881 B text | 7,950 B, already plain text |
| `Legal-Counsel_R171930` | 9,381 B → 7,362 B | 8,471 B |
| `Software-Development-Engineer_R…` | 10,991 B → 8,545 B | 9,575 B |

JSON-LD carries **1.12–1.16× more readable text** than the CXS field, because CXS returns HTML with
undecoded entities (`You&#39;ll`, `6&#43; years`) while JSON-LD is decoded plain text. The
divergences I diffed were all entity-decoding, never missing content.

**URL shape that worked:**
`https://{tenant}.wd{n}.myworkdayjobs.com/{site}{externalPath}` — the same `externalPath` the list
already returns, without the `/wday/cxs/{tenant}/{site}` prefix. Requires a browser `User-Agent`.

It also carries four structured fields the CXS search response does not:

```
datePosted      "2026-08-26"   ← an EXACT date, where the list says "Posted 22 Days Ago"
employmentType  "FULL_TIME"
jobLocation     { addressCountry: "United States of America", addressLocality: "San Jose" }
identifier      { value: "R169992", name: "<title>" }
baseSalary      null (Adobe does not publish it)
```

**SmartRecruiters: NO.** Zero `ld+json` blocks on all four posting pages probed. The page is a
118 KB client-rendered shell — the detail endpoint's own first sentence of body text is **not
present anywhere in the served HTML**. The string `jobAd` appears, but as bundle code, not content.
There is no non-API door for SmartRecruiters.

### 2b · RSS / Atom / sitemap — none, on either source

```
404  jobs.smartrecruiters.com/Ubisoft2/{feed,rss,atom,feed.xml}, /Ubisoft2.rss
404  jobs.smartrecruiters.com/{,Ubisoft2/}sitemap.xml · www.smartrecruiters.com/jobfeed/Ubisoft2
400  api.smartrecruiters.com/v1/companies/Ubisoft2/postings/feed
404  adobe.wd5.myworkdayjobs.com/sitemap.xml
422  adobe.wd5.myworkdayjobs.com/wday/cxs/adobe/external_experienced/sitemap.xml
200  adobe.wd5.myworkdayjobs.com/external_experienced/{feed,rss,sitemap.xml}   ← NOT feeds
```

⛔ Those three Workday 200s are **the SPA catch-all**, the same trap recorded for our own
deployment probes: ~99 KB of `text/html`, no XML declaration, no `<description>` or
`content:encoded`, and the byte counts differ by 2–16 bytes across the three paths purely because
the path string is echoed into the shell. A status-only probe would have reported three working
feeds. **Zero N-descriptions-in-one-request paths exist.**

---

## 3 · CONDITIONAL REQUESTS — SmartRecruiters yes, Workday no

| endpoint | ETag | Last-Modified | `If-None-Match` result |
|---|---|---|---|
| SR list | `W/"63a3-2ouIDzb…"` | — | **304, 0 bytes** ✅ |
| SR detail | `W/"2c87-hSbiCy5…"` | — | **304, 0 bytes** ✅ |
| WD list (POST) | — | — | n/a — `cache-control: no-store, no-cache` |
| WD CXS detail | — | — | n/a — same |
| WD public page | — | — | n/a — same |

SmartRecruiters issues a weak ETag on both endpoints and honours it with a real empty-bodied 304.
No `Last-Modified` anywhere, so `If-Modified-Since` is not available on either source. Workday sends
**no validator at all** and explicitly `no-store, no-cache` on all three surfaces — conditional
requests are impossible there, not merely unhonoured.

---

## 4 · THE MEASURED RATE LIMIT — there isn't one, at the volumes that matter

Escalating concurrency waves against each **detail** endpoint, distinct URLs throughout so no cache
absorbed the load, aborting at the first 429/503:

```
SMARTRECRUITERS (api.smartrecruiters.com)
  conc= 2  n=4   ~4.4 req/s   p50=478ms  max=496ms   {200:4}
  conc= 4  n=8   ~9.5 req/s   p50=408ms  max=437ms   {200:8}
  conc= 8  n=16  ~16.4 req/s  p50=450ms  max=491ms   {200:16}
  conc=16  n=32  ~33.1 req/s  p50=416ms  max=547ms   {200:32}
  conc=32  n=64  ~61.4 req/s  p50=421ms  max=596ms   {200:64}
  → no 429/503 in 124 detail requests. Latency completely FLAT to 32 concurrent.

WORKDAY (adobe.wd5.myworkdayjobs.com)
  conc= 2  n=4   ~4.2 req/s   p50=419ms  max=659ms   {200:4}
  conc= 4  n=8   ~8.7 req/s   p50=333ms  max=584ms   {200:8}
  conc= 8  n=16  ~12.7 req/s  p50=459ms  max=664ms   {200:16}
  conc=16  n=32  ~15.7 req/s  p50=500ms  max=1570ms  {200:32}
  conc=32  n=64  ~25.3 req/s  p50=505ms  max=1882ms  {200:64}
  → no 429/503 in 124 detail requests. Throughput PLATEAUS near conc=8 and tail latency triples.
```

- **No 429 or 503 was ever produced**, on either source, at any concurrency tested.
- **No rate-limit headers exist.** `RateLimit-*`, `X-RateLimit-*`, `Retry-After` were absent from
  every response, success or otherwise. There is no advertised budget to read.
- **Both are unauthenticated public endpoints**, so any limit is per-IP by construction — there is
  no token to scope one to.
- **The axis is requests, not bytes.** 16 small SR list calls (`limit=1`) ran at 18.6 req/s; 16
  large ones (`limit=100`, ~20 KB each) at 15.2 req/s. A 20× payload difference cost 18% of
  throughput — consistent with per-request overhead, not a byte budget. This is the Groq trap
  checked for explicitly, and it is absent here.
- **Workday's real signal is backpressure, not throttling.** Above 8 concurrent its throughput stops
  improving and max latency goes 584 ms → 1,882 ms. That is the number to pace on: **8 concurrent
  for Workday**, and SmartRecruiters tolerated 32 without flinching.

> The current default `concurrency: 2` is ~4× more conservative than Workday's measured knee and
> ~16× more than SmartRecruiters'. Nothing found here argues for *lowering* it.

---

## 5 · YIELD PER COMPANY — 100%, all three, and the 0% was our own absence

25 postings per company, sampled at even offsets **across the whole board** rather than page 1:

| company | board size | sampled | with text | empty | failed | median text | median latency |
|---|---|---|---|---|---|---|---|
| `smartrecruiters/Ubisoft2` | 300 | 25 | **25 (100%)** | 0 | 0 | 4,182 B | 420 ms |
| `smartrecruiters/BoschGroup` | 4,840 | 25 | **25 (100%)** | 0 | 0 | 3,011 B | 418 ms |
| `workday/adobe` — CXS json | 711 | 25 | **25 (100%)** | 0 | 0 | 10,196 B | 381 ms |
| `workday/adobe` — JSON-LD | 711 | 25 | **25 (100%)** | 0 | 0 | 8,584 B | 391 ms |

Every status was 200. Not one empty `jobAd`, not one missing `jobPostingInfo`.

⛔ **Migration 103's "648 rows at 0% description coverage" was not a property of these sources.**
It was the absence of a detail fetch. Every one of those rows has retrievable text, today, at one
request each. The W-style yield test that seeded Ubisoft/Bosch/Adobe INACTIVE reports 100% once the
second request is actually made — which removes the stated reason they are switched off.

### The bill is 1,500 requests per crawl, not 648

`aggregator.js:753` calls every ATS plugin with `query: ''` and `pageSize: 300`. Empty query means
`queryWords()` returns `[]` and `titleMatchesQuery()` returns `true` for everything: **there is no
title filter at crawl time**, and `PER_COMPANY_MAX` is `300 × 3 = 900`. I ran both real plugins with
exactly those parameters and the budget off:

```
smartrecruiters  rows=1200  { Ubisoft: 300, Bosch: 900 }   wall 4.7s
workday          rows= 300  { Adobe: 300 }                 wall 11.6s
                 ───────────────────────────────────────
                 an ENABLED crawl issues 1,500 detail requests per run
```

The 97/334/217 figures in the migration comment were measured under a *title-filtered* query and do
not describe the crawl. At the measured 8-concurrent pace that is ~3 minutes of wall time and, at
current pricing, ~**$3.90 of downstream enrichment** (1,500 × ~$0.0026) spread over **5 days** of
`ENRICH_DAILY_MAX_ROWS 300`.

### Two silent truncations found while counting

- **Bosch: 900 of 4,840 postings reachable (18.6%).** `fetchCompanyJobs` loops 10 pages × 100, and
  SmartRecruiters caps `limit` at 100 *silently* (`limit=500` returns 100 rows and a 200). Deep
  offsets do work — `offset=4800` returns a row, `offset=5000` returns none — so the other 3,940 are
  reachable in principle and are being dropped by the page loop, invisibly.
- **Adobe: 300 of 711 (42%).** `limit: 20` is **forced** — Workday returns `400` for `limit=50` and
  above. So 15 pages × 20 is the ceiling the loop can reach, and the remaining 411 need more pages.

Neither is this task's scope; both are the `0de67c8` shape (a cap that discards without saying so)
and both should be recorded rather than fixed here.

---

## 6 · WHAT THE CARD ACTUALLY NEEDS — the expectation holds, with two corrections

Field coverage measured on the real 1,500 normalized rows, **from the list response alone**:

| card field | Ubisoft+Bosch (1,200) | Adobe (300) | from list? |
|---|---|---|---|
| `title`, `company`, `location`, `url` | 1,200 | 300 | ✅ |
| `posted_at` | 1,200 | 300 | ✅ (WD approximated from "Posted N Days Ago") |
| `experience_level` | 1,200 | 300 | ✅ |
| `contract_type` | 1,200 | **0** | ⚠️ see below |
| `workplace_type` | 244 | 7 | partial |
| `automation_tier` | derived downstream | derived downstream | ✅ from `source` + `url` |
| **`description`** | **0** | **0** | ❌ |
| **`salary_min`/`salary_max`** | **0** | **0** | ❌ |
| `skills_json`, `ats_score` | 0 | 0 | ❌ |

**The brief's expectation is confirmed for the collapsed card.** `JobCard.jsx:800` renders
`job.description` **only inside `{expanded && …}`**, and `hasDesc` (line 458) is computed and read
nowhere. A collapsed card needs no description at all. The description is needed for exactly the
three things named: the JD panel, enrichment, and ATS scoring — all after a user shows interest.

**Correction 1 — salary is NOT list-derivable.** Neither source publishes a salary field: no
salary-ish key exists in the SR list posting (18 keys, none matching `/salary|comp|pay|wage|rate/`),
none in Workday's five, and Adobe's JSON-LD `baseSalary` is `null`. `salary_min_usd`/`salary_max_usd`
are written **by `enrichJob`, from the description**. So salary on these rows is downstream of the
fetch, not parallel to it.

**Correction 2 — `automation_tier` is not on the normalized row at all.** `normalizeJob` doesn't
name it (0/1,500), so it is 0 at the plugin boundary by design; `deriveAutomationTier(source,
applyUrl)` runs downstream and needs only `source` and `url`, both of which the list provides. W's
"0 NULL tiers across 1,385 rows" stays true and is unaffected by any of this.

### A real defect: Workday's `contract_type` reads a field that is never there

`workday.js:52` maps `contract_type: job.timeType || null`. **`timeType` is absent from 100/100 list
postings** — so `contract_type` is `null` on every Workday row, always, and 0/300 confirms it on live
data. It is the `_atsSlug` shape again: code that compiles, runs, and reads nothing.

The field does exist one request away — `jobPostingInfo.timeType = "Full time"` in CXS, and
`employmentType = "FULL_TIME"` in JSON-LD. So the detail fetch would *fix* a currently-dead column,
which is a second, unbudgeted-for reason it has value.

---

## 7 · THE REFRAMING IS STALE — the binding constraint has moved

The brief's governing premise is no longer what the board shows. Measured against
`data/resume_master.db` today:

| | brief says | actually |
|---|---|---|
| active rows | 1,266 | **1,266** ✅ |
| `description` | — | **1,266 / 1,266 — 100%** |
| `skills_json` | ~37% | **1,264 / 1,266 — 99.8%** |
| `enriched_at` | 25/day trickle | **1,261 / 1,266** |
| `ats_score` | 4 of 1,266 | **4 of 1,266** ✅ |

AE's bounded loop did what it was built to do: 1,175 rows enriched on 2026-08-22, and the backlog is
gone. **"Enrichment capacity" is not currently the binding constraint — it is idle.** Nothing has
been enriched since 2026-08-24, because there is nothing left to enrich.

**And `ats_score` is not an enrichment-capacity problem either.** `scoreAtsLocally`
(`services/localAtsScorer.js:940`) is a **synchronous, local, zero-cost** function — no `fetch`, no
`axios`, no Anthropic client anywhere in the module. The two writers
(`server.js:4250`, `server.js:8085`) fire only for *newly inserted* jobs during a scrape and on
profile adoption, and both require `description IS NOT NULL`. So 4/1,266 is **a backfill that was
never run over the restored corpus**, not a ceiling anyone is queued behind. It costs API money
nowhere.

This does not license enabling the sources. It changes *which* argument does: the honest one is
"1,500 crawl-time requests a day buy descriptions for rows nobody opens," not "we cannot afford to
enrich them."

### And the brief's Phase 2 item 5 is wrong about the card

> *"A row with no description shows 'Not enough signal' until opened. That is an EXISTING, honest
> band."*

Not on a card, and deliberately not. `ATSBadge` (`JobCard.jsx:254`) is
`if (score == null || Number.isNaN(score)) return null` — **a null score renders nothing**. The
comment above it (lines 235–253) reverses an earlier decision on purpose: on a card, `null` cannot
distinguish "the scorer declined" from "nobody ever scored this row," and since 1,262 of 1,266 rows
have a NULL `ats_score`, rendering the decline band turned a 0.1% state into a chip on every card.
The fourth band lives on `ATSPanel`, which actually *ran* the scorer.

So a description-less row shows **no badge**. That is still honest and still fabricates nothing —
but Phase 2 must not be written expecting the words "Not enough signal" to appear, and a test
asserting they do would fail correctly.

---

## 8 · SIZING 2C — the union is one term, and 1% is not a safe constant

`domain_profiles` holds **2 profiles, both active**. One has `target_titles: ["Software Engineer"]`;
**the other's is empty `[]`**. The union over active profiles is therefore **one term: `software
engineer`**.

Applying the plugins' own matching shape (substring on a lowercased title) to the live 1,500:

```
smartrecruiters/Ubisoft    1 / 300   (0.3%)   e.g. "Software Engineer – MLOPS"
smartrecruiters/Bosch      7 / 900   (0.8%)   e.g. "Agentic Software Engineer", "Software Engineer - AI (f/m/div.)"
workday/Adobe              7 / 300   (2.3%)   e.g. "Senior Android Software Engineer, Firefly Growth & Monetization"
                          ────────────────
                          15 / 1500  (1.0%)   → 15 detail requests instead of 1,500
```

A 100× reduction, and it does confirm the brief's arithmetic. **But do not hard-code 1%.** Two
measured reasons:

1. **A one-term union is fragile.** One of two active profiles contributes nothing because its
   `target_titles` is empty — the exact "stale union silently starves new profiles" failure the
   brief warns about, already present at n=2.
2. **Substring matching misses real SWE roles.** Adobe's `Software-Development-Engineer_R…` does
   **not** match `software engineer`, because the term is not a substring of that title. The 1% is a
   floor produced by a narrow matcher, not a property of the boards.

It remains the right *ranking*, exactly as the brief's ⛔ insists — never a filter on what to
ingest.

---

## 9 · RECOMMENDATION — which parts of Phase 2 are still justified

| part | verdict | why |
|---|---|---|
| **2A · lazy fetch folded into enrichment** | **BUILD — unchanged** | The N+1 is real for both, so the seam argument stands on its own merits: one budget instead of two, `enrichJob` already skips description-less rows, and `content_hash = hash(title, description)` re-candidates a row whose text arrives later with no new selector logic. The *justification* changes from scarcity to not paying for unopened rows. |
| **2B · fetch on open** | **BUILD — now with a measured latency** | A single detail request costs **~420 ms (SR) / ~380–390 ms (WD)** at p50. That is inside the range where a spinner suffices; measure it in the real panel rather than assuming. Reuse the 2A fetcher. |
| **2C · title-union prioritisation** | **BUILD only if any pre-fetch survives — but not on today's numbers** | 15/1,500 is real and a 100× saving, yet the union is one term and the matcher misses `Software Development Engineer`. Ship it as ordering with a stated refresh cadence; do not encode 1% anywhere. |
| **2D · per-company yield, automated** | **DOWNGRADE to measurement only. Do NOT auto-deactivate.** | The premise was companies returning 0% descriptions. All three return **100%**, 0 failures in 75 detail requests. An auto-deactivator would guard a condition that does not occur while creating a new way to lose a healthy company to one bad crawl — this project's most-repeated failure shape, newly introduced. Extend AC's health check to *record* descriptions-obtained-per-request-spent per company, surface it, and let a human read it. |
| **2E · mechanics** | **BUILD, three of four items** | ✅ Bounded concurrency — pace at **8 for Workday** (its measured knee: throughput plateaus, tail latency triples above it) and 8 is also comfortably safe for SR, which was flat to 32. ✅ Conditional requests — **SmartRecruiters only**, where `If-None-Match` returns a genuine 0-byte 304 on both endpoints; Workday sends `no-store` and no validator, so there is nothing to implement. ⚠️ `Retry-After` on 429 — keep the handler, but record that **no 429 was ever observed**, so it will ship untested against a real one. ❌ "DELETE the N+1 path if a bulk source was found" — **no bulk parameter or feed exists for either source**, so nothing is deleted and `detailBudget.js` stays. |

### One addition the brief did not anticipate

**For Workday, fetch the JSON-LD page, not the CXS detail endpoint.** Same one request, same 100%
yield, and measurably better:

- **Complete text, already decoded** — 1.12–1.16× more readable characters than CXS's entity-laden
  HTML, with no `htmlToText` pass needed.
- **A real `datePosted`** (`"2026-08-26"`), replacing `parsePostedOn`'s approximation of
  `"Posted 22 Days Ago"` — which is right to within a day today and degenerate for
  `"Posted 30+ Days Ago"`.
- **`employmentType: "FULL_TIME"`**, which fixes the dead `timeType` read documented in §6.
- It is the **canonical public representation** Google Jobs indexes, rather than an internal API we
  are guessing the shape of — the brief's own stated preference.

Cost: it needs a browser `User-Agent`, and it returns 23 KB of HTML against CXS's 9.7 KB of JSON, so
it trades bandwidth for correctness. The measured rate limits make that trade free.

**SmartRecruiters keeps its CXS-equivalent API detail endpoint** — there is no JSON-LD and no feed,
and `jobAd.sections` is what exists. Its four-section concatenation in
`fetchPostingDescription` matches the live shape exactly: all four of `companyDescription`,
`jobDescription`, `qualifications`, `additionalInformation` were present on every posting probed
(Bosch also emits a `videos` section, correctly ignored).

---

## 10 · WHAT STAYS OFF

⛔ Both sources remain `active=0`. Nothing here is an argument to enable them, and this report makes
no enable decision. It does, however, retire the *stated* reason they are off ("0% description
coverage"), which was a measurement of our own missing second request. Whoever enables them should
decide on the real numbers: **1,500 detail requests per crawl, ~$3.90 and 5 days of enrichment for
the first full pass, against 1% of those rows matching any current profile's target titles.**

The cheapest outcome the brief hoped for — a bulk parameter that deletes most of Phase 2 — did not
materialise. What replaced it is nearly as good: **the request budget was never the binding
constraint**, so Phase 2 can be built for the right reason instead of the assumed one, and 2D can be
most of the way deleted.
