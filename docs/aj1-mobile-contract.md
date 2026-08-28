# AJ1 — Publishing the mobile API contract

**Baseline re-derived first: 1915 passing, 0 failing. Migration high-water `092_profile_summary_opt_in`.**

| Check | Result |
|---|---|
| `npm test` | **1973 passing, 0 failing** (+58 new). **Regressions introduced: 0.** |
| `npm run verify:harness` | **32/32 green, 913 assertions** |
| `scripts/aj1MobileBearer.mjs` | **129/129 checks**, bearer-only against a live server |
| `generateMobileContract --check` | Contract current (**v1.1.0**); regeneration is byte-identical |
| `scripts/aj2BoardCursor.mjs` | **16/16 checks** driving the real board in Chrome |
| `scripts/abPanelUi.mjs` | **121/121 checks**; the truncation notice verified on screen |

`ah1SessionIdentity` passes **67/67** — the one that matters most, since this task changed
`bindAuthContext`, which every authenticated request goes through.

> A caveat on that harness suite. An earlier run reported three harnesses at "0 assertions,
> exit 1". They were not regressions: I had been running `aj1MobileBearer.mjs` by hand at the same
> time, and the contention starved them. Re-run alone they are 17/17, 32/32 and 24/24, and the clean
> full-suite run above is 31/31. Recorded because "it was probably concurrency" is exactly the kind
> of guess this repository's harness runner exists to stop anyone making.

No mobile screens were built. This is the server side of a repository boundary.

---

## 0. The problem, restated in one paragraph

The API now has **four consumers**: `client/`, `extension/`, and two mobile repositories outside
this tree. Until this task, **nothing noticed when a published shape changed.** This repository's
defect history is almost entirely contract mismatches that failed *silently* — `mapJobRow` vs
`normalizeApiJob`, popup vs hotkey writing to different tables, three hardcoded tab lists,
half-migrated model IDs, five of fourteen LLM call sites logging usage, `tool` vs `toolType`, mode
`"manual"` coerced to `"auto"`. Every one was two sides of a contract that did not meet. Being in
the same tree is what eventually made each findable; a separate repository removes that. So the
deliverable is not a document — **it is a test that fails.**

---

## 1. What was built

| Artefact | Role |
|---|---|
| `services/api/mobileContract.js` | The **derived** job shape + declared types + tier gating |
| `services/jobs/jobCursor.js` | **Board ordering + keyset cursor, from one key-list declaration** (§12) |
| `services/api/mobileEndpoints.js` | The 32-endpoint surface, retirements, and the gaps |
| `services/api/mobileSchemas.js` | Declared response envelopes |
| `services/api/buildMobileContract.js` | Deterministic OpenAPI 3.1 + TypeScript generator |
| `scripts/generateMobileContract.mjs` | Writes `contract/`; `--check` fails on staleness |
| `contract/mobile-api.v1.json` | **The published contract** (OpenAPI 3.1 — 30 paths, 32 operations, 52 schemas) |
| `contract/mobile-api.v1.d.ts` | Generated TypeScript declarations |
| `contract/CHECKSUMS.json` | SHA-256 over LF-normalised content — what the mobile repos pin |
| `contract/README.md` | Consumption strategy and versioning rules |
| `test/mobileApiContract.test.js` | **21 tests. The actual deliverable.** |
| `test/jobsKeysetCursor.test.js` | 12 tests: the offset defect, then the cursor that fixes it |
| `client/src/lib/boardPaging.js` | **Which paging mode answers which navigation** (§13) |
| `test/boardPagingCursor.test.js` | 14 tests over the paging decision table |
| `scripts/aj2BoardCursor.mjs` | 16 real-browser checks: the board pages by cursor and skips nothing |
| `scripts/aj1MobileBearer.mjs` | **129 real-run checks** on a live server, bearer-only |

---

## 2. The contract is GENERATED, not written (requirement 2)

`mapJobRow` is a field whitelist and the only shape `GET /api/jobs`, `GET /api/jobs/by-id/:jobId`
and `routes/importJob.js` emit. It is therefore the binding constraint, and it is **executed**, not
parsed:

```js
Object.keys(mapJobRow({}))   // → the 37 published job fields
```

Probing rather than regexing is deliberate: a regex agrees with the source *text*, calling the
function agrees with the source *behaviour*, which is what a client actually receives.

### The probe found something a hand-written contract would have got wrong

Eight fields are plain pass-throughs with no null coalescing:

```
id  title  company  location  description  url  applyUrl  source
```

For a row whose column is NULL these evaluate to `undefined`, and **`JSON.stringify` deletes an
undefined property**. They do not arrive as `null` — they do not arrive at all.

A contract typing these as `string | null` would be wrong in a way that reads as correct. A Swift
or Kotlin decoder distinguishes *null* from *missing*: a non-optional field that is merely absent
throws at decode time even though it would tolerate an explicit null. **That is a store crash,
found from a review.** They are emitted as optional (`?:` in the generated TypeScript, absent from
`required` in the schema), and `test/mobileApiContract.test.js` asserts the split against what
`JSON.stringify` actually does rather than against anyone's belief.

### What could not be derived, and how it is kept honest

Scalar types cannot be recovered by probing — `mapJobRow({}).title` is `undefined` whether the
column is TEXT or INTEGER. So `JOB_FIELD_TYPES` declares them, and that declaration is reconciled
against the derived key set **in both directions**, the `privacyReconciliation.test.js` pattern:

- a `mapJobRow` field with no declared type → **fail** (it would ship untyped)
- a declared type with no `mapJobRow` field → **fail** (the contract would promise a dead field)

Enums are **imported** from `shared/jobFilterOptions.js` and `shared/applyOutcomeGroups.js`, never
restated — a third copy of the tier list is precisely the bug this task exists to prevent. The
apply-status vocabulary is derived from the outcome *partition*, so a status added without being
filed into a group cannot reach the contract.

---

## 3. The contract test (requirement 4) — VERIFIED BY BREAKING IT

The task asked that the test fail when a whitelisted field is removed from `mapJobRow`. It was
removed and the test was run.

`automationTier` deleted from `mapJobRow` → 37 fields became 36 → **2 of 21 tests failed**:

```
✖ REMOVING A FIELD FROM mapJobRow BREAKS THE BUILD — the join, in both directions
  AssertionError: The contract declares field(s) that mapJobRow NO LONGER RETURNS. A mobile
  client decoding this contract expects them, and will get undefined. Either restore the field
  or bump the contract's MAJOR version and remove it here:
    automationTier

✖ the committed contract is not stale — regenerating changes nothing
  AssertionError: contract/mobile-api.v1.json is STALE. The source of truth changed and the
  contract was not regenerated. The two mobile repositories consume this file, so shipping it
  stale is how they break silently.
  Run: node scripts/generateMobileContract.mjs
```

The field was restored (`git checkout`), 37 fields confirmed, 21/21 green.

**Note which test did *not* fail, because it is the design working.** "THE WHITELIST IS THE
CONTRACT" compares derived-against-derived and always agrees — both sides move together. The
catch comes from the *derived-against-declared* join. That is why the declared half exists.

Generation is deterministic — asserted, and verified across separate processes. There is no
timestamp, git sha or hostname in the output: a "generated at" line would make every regeneration a
diff, which is how a drift check gets disabled for being noisy.

---

## 4. The two open auth decisions — RESOLVED SERVER-SIDE (requirement 6)

### 6a. Sliding renewal — **implemented**

Until now `expires_at` was set once at issue and never moved, so the 7-day *idle* window was
really a **hard** window. A native app — which, unlike a browser, has no rolling `connect.sid`
cookie to fall back on — was signed out every seventh day no matter how much it was used.

**Decision: sliding renewal with an absolute cap.** Two windows, answering different questions:

| | | |
|---|---|---|
| `AUTH_CONTEXT_IDLE_SECONDS` | 7 days | how long a token survives **unused** — unchanged |
| `AUTH_CONTEXT_ABSOLUTE_SECONDS` | 90 days | how long it can live **at all**, however active |

**Why not a refresh endpoint.** A refresh token is a *second credential kind* with its own
rotation, replay and revocation story, and a second thing all four clients must implement
correctly. Sliding renewal gets the same result by moving a column `bindAuthContext` **already
writes on every request** (`last_seen_at`) — no new endpoint, no new token kind, nothing for a
client to do, and the extension and browser benefit too.

The clamp is the safety property: without it "active" means "immortal", and a leaked token in the
hands of anything that polls would never expire. The write is guarded by `slidTo > row.expires_at`
so renewal only ever moves the deadline **forward** — an unguarded `Math.min` could return a value
*behind* the stored expiry and silently shorten a live session, which would be a worse bug than the
one being fixed.

Also removed: the bare `7 * 24 * 60 * 60` literal in `issueAuthContext`. A second copy is how the
idle window and the renewal window come to disagree — the shape of the three hardcoded tab lists.

### 6b. Session binding — **mobile uses the `sessionLess` path**

`POST /api/auth/login` issues a token storing `session_sid = req.sessionID`. For a cookie-less
caller that sid is a throwaway the client will never present again, so the binding is meaningless —
and *worse* than meaningless, because `revokeBrowserAuthContexts()` revokes every token sharing a
sid. A phone's credential would be filed under a session nobody can sign out of or audit. Same
class of defect as a row written under the wrong `domain_profile_id`: self-consistent on both
sides, joined to the wrong thing.

**Added `GET /api/auth/mobile-token`** (`sessionLess: true`, `user_agent: 'resume-master-mobile'`)
and **`POST /api/auth/revoke-mobile-token`**. Mobile signs in, exchanges, discards the login token —
exactly the extension's flow.

**Why a second endpoint rather than reusing the extension's.** The revoke keys on `user_agent`, so
sharing would make "sign out my phone" also kill the extension. Two credentials a user manages
separately must be separately revocable — **verified in the harness in both directions.**

The two handlers are deliberately near-identical rather than folded into a helper:
`test/authCredentialLifecycle.test.js` asserts the extension's guarantees as source strings *inside
its route block*, and hiding them behind a shared helper would weaken an existing guard to save
four lines. Both new routes were added to `test/authRouteGuardManifest.test.js`, which fails on any
unclassified route.

---

## 5. Real-run verification (116 checks, all passing)

`scripts/aj1MobileBearer.mjs` boots the real `server.js` against a throwaway `RM_DATA_DIR`.

**It sends no cookie, ever.** `scripts/ah1SessionIdentity.mjs` drives a *browser* — a cookie jar
**plus** a token — so a token-only regression would be invisible to it: the cookie would answer the
request and the assertion would still pass. Here there is no cookie jar to send one from, and a
check proves the omission is real by asserting an uncredentialed request is anonymous. **Every 200
is earned by the bearer token alone**, which is all a native app will have.

| Section | Result |
|---|---|
| 1. The mobile credential | Minted `sessionLess` (`session_sid` **NULL** confirmed in the DB), hashed at rest, distinct from the login token. A login-issued token confirmed **session-bound** — the reason mobile must not keep it. |
| 2. Every contract endpoint on bearer | **29/29 reached** (3 skipped by name with a stated reason). A real `GET /api/jobs/by-id` response carries **every required field of the derived Job shape and no undocumented field.** |
| 3. Cross-user denial | **19/19** user-scoped endpoints refuse a cross-user bearer (403/404). No content leaked; alice's rows survived; alice still reaches her own run. |
| 4. Admin | **16/16** admin routes refuse a non-admin bearer. The admin *does* reach one — the 403s are about role, not a dead mount. |
| 5. Sliding renewal | Six-day-old token still authenticates; `expires_at` moved **forward by 518400s**. An 89-day-old token renews to land **exactly on the cap**, 6 days short of the idle window — proof the clamp bound it. Past the cap: extends nothing, and never moves backwards. |
| 6. Revocation independence | Revoking the extension leaves the phone signed in; revoking the phone leaves the extension signed in. |
| 7. Retirements | All 6 answer **410** to a bearer client, each with prose a developer can act on. |

**AH1's cross-user guarantees hold identically on the bearer path — measured, not assumed**, which
is what the task asked for. Registered in `scripts/harnessBaseline.json` at `pass: 129`, so a
truncated future run fails.

### 5.1 The declared half was wrong ELEVEN TIMES, and that is the most useful result here

The `Job` shape is **derived**, so it cannot be wrong. The response *envelopes* are **declared** —
they are built inline in each handler, with no chokepoint to execute — and a declaration has
nothing keeping it honest unless something compares it to a real body.

I had written in `mobileSchemas.js` that the harness "asserts the top-level keys of what comes
back." **It did not. I had claimed a check I had not built.** Building it found **eleven** wrong
declarations in my own first draft:

| Endpoint | I declared | It actually returns |
|---|---|---|
| `GET /api/domain-profiles` | `{ profiles: [...] }` | **a bare array** |
| `GET /api/jobs/facets` | `{ facets: {...} }` | flat dimensions + `salaryRange`, `total` |
| `GET /api/apply/status/{jobId}` | `{ applied, status }` | `{ status, application }` |
| `POST /api/apply/approve` | `{ ok, runId, approved, queued }` | `{ ok, approved, skipped, run }` |
| `POST /api/domain-profiles/{id}/activate` | `{ ok }` | the now-active profile row |
| `GET /api/apply/runs` | `{ runs }` | + `review`, `gated`, `inFlight`, `submitted`, `stopped`, `statusCounts` |
| `GET /api/apply/runs/{runId}` | `{ run, jobs }` | + `logs` |
| `GET /api/apply/run-jobs/{id}/review` | nested under `runJob` | **flat**, 13 top-level keys |
| `POST /api/apply/answers` | `{ ok, saved: number, retried }` | `saved` is a **string[]**, + `savedOverrides`, `unblocked` |
| `GET /api/profile` | 38 columns | + 11 more (`id`, the split-name columns, `onboarded`, …) |
| `GET /api/apply/history` | `{ history, outcome }` | requires `date`; returns **two different shapes** |

`GET /api/domain-profiles` is the one to dwell on. A mobile client reading `response.profiles`
against a bare array gets `undefined`, renders an empty list, and tells a user **who has four job
profiles** that they have none. It would have looked like a data-loss bug on the phone and been
debugged on the wrong side of the boundary for a day.

**Direction matters, and the check is deliberately one-directional.** It asserts *real → declared*:
every key the server actually sent must be documented. The reverse cannot be asserted here, because
several fields are legitimately conditional — `curation` only when ranking demoted something,
`reason` only on an empty board, `group`/`jobs` only when history was asked for a slice. Requiring
them would fail on correct responses, and a check that cries wolf gets deleted. The direction that
*can* be checked without false positives is the direction all eleven defects were in.

**What this check does NOT cover, stated because a count alone would imply it did.** 22 of the 27
JSON envelopes were verified against a live body. **Five were not**, and the harness names them
rather than reporting only the 22:

```
NOTE  5 envelope(s) NOT shape-verified (no success body in this run):
      PATCH /api/jobs/{id}/visited (404), POST /api/apply/runs (409),
      POST /api/apply/approve (409), POST /api/apply/reject (409),
      POST /api/apply/run-jobs/{runJobId}/abort (409)
```

They are the **write** paths, and each refuses for a correct reason this harness cannot remove
cheaply: `runs` hits `startRun`'s prerequisite gate because a throwaway user has no integrations
configured; `approve`/`reject`/`abort` have nothing in `held_review`, because reaching that state
needs a real browser driving a real form. Seeding around those would mean asserting against a world
that does not match production setup — worse than a stated gap. Their shapes were read directly off
the handlers' `res.json()` calls, which is good evidence and is **not** the same as a live check.

The last table row was caught differently, and is worth separating: the sweep reported `status=400` for
`/api/apply/history`, which **passed the "not 401" bar while proving nothing had been exercised.**
The harness now sends valid parameters for every endpoint that requires them and asserts **200**, so
"reached" cannot again mean "rejected before doing any work". The contract also gained
`GET /api/apply/history/months/{month}`, which a date picker needs.

`HistoryRunJob` uses `extends: "RunJob"` and the generator emits `allOf` rather than restating
RunJob's twenty fields — a second copy of a published shape is the thing this whole task is against.

### 5.2 And two harness bugs, both mine, both instructive

1. **Sliding renewal reported as broken when it worked.** The harness picked alice's mobile token
   row by `user_agent`, but section 2 sweeps *every* contract endpoint — including
   `GET /api/auth/mobile-token` — so alice legitimately held two. It aged one token and renewed a
   different one. Now addressed by the SHA-256 of the specific token.
2. **A good tombstone reported as unexplained.** The check read `error || message`, which
   short-circuits on `SESSION_RETIRED`'s `error: "gone"` — a short machine code, with the sentence
   in `message`. Both conventions are live in this API, so it now takes the longer of the two.
   `RETIRED_ENDPOINTS` was corrected to record the real body shape.

---

## 6. Retirements a new client must not call (requirement 5)

All six confirmed in source **and probed live**. Published as `x-retired` in the contract, because
a greenfield client written from older documentation is exactly the client that will call them —
and this repository has form: `docs/mobile-linkedin-import.md` is written in the present indicative
about a mobile feature that has never existed.

| Endpoint | Replacement |
|---|---|
| `POST /api/scrape` | `GET /api/jobs` |
| `ALL /api/extension/save-job` | `POST /api/import/job` |
| `ALL /api/imported-jobs/*` | `GET /api/jobs?starred=true` |
| `POST /api/apply/session/save` | — (gated handoff replaced it) |
| `GET /api/apply/session/:domain` | — |
| `PATCH /api/settings/apply-mode` | — (plans control tool access) |

410 rather than 404 deliberately: 404 reads as "wrong URL, check your typing"; 410 reads as "this
is gone on purpose", which is the true statement. A client parsing a 410 must read **both**
`error` and `message`.

---

## 7. Automation tier is in the job shape (requirement 7)

`automationTier` is on every job, and `x-mobile-tier-gating` publishes the verdict per tier so the
two mobile repos do not each invent their own answer:

| Tier | Completable on mobile | Why |
|---|---|---|
| `direct` | ✅ | Single-page ATS apply. No account, no handoff. |
| `guest` | ✅ | A guest path exists; the run may still hold for review. |
| `account` | ❌ | Holds at `login_required`; a phone cannot resolve it. |
| `gated` | ❌ | **Unresolvable from a phone.** |
| `unknown` | ❌ | A promise in neither direction. |

**A gated job cannot be completed on a phone, and there is no design that fixes it.** The gated
handoff's security property *is* the desktop browser holding the portal session, borrowed for one
gesture under the extension's `activeTab`. A phone has no extension, so a `held_gate` row queued
from mobile is unresolvable. The only honest behaviours are to show it as desktop-only or to
exclude it. Agrees with `docs/SWIPE_FEED_DESIGN.md` §2.5.

The gating table is keyed off the tier vocabulary, so **a sixth tier added to
`shared/jobFilterOptions.js` with no mobile verdict fails the contract test** rather than defaulting
to "completable".

`automationTier: null` means the row predates migration 078 and has not been recomputed. It must
read exactly as `unknown` — never as `direct`.

---

## 8. What mobile needs that this API does not expose (requirement 8)

Reported, not built — each is a server change with its own design. Published **inside** the contract
as `x-mobile-gaps`, because a gap recorded only in this file is invisible to teams who consume
`contract/` and may never read `docs/`.

### 8.1 Pagination — ~~the blocking one~~ **RESOLVED, see §12**

**`GET /api/jobs` paged by offset (`page`/`pageSize`), which silently skipped jobs on a swipe feed.**

Offset pagination assumes a stable result set. **A swipe feed mutates the set it is paging
through**: every dislike sets `disliked = 1`, and the default board *excludes* disliked rows. So
each swipe shortened the list behind the reader, every subsequent row shifted up by one, and **page
2 skipped as many jobs as the user swiped away on page 1.** The user never saw them, `total` still
counted them, and nothing reported the loss. A desktop board never hits this because it does not
mutate membership while paging.

**Fixed in §12.** Send `?cursor=` and follow `nextCursor` until it is null. The entry stays in
`x-mobile-gaps` marked `severity: "RESOLVED"` rather than being deleted, so a mobile team reading an
older copy of the contract learns the fix exists instead of building the client-side workaround this
entry used to recommend.

### 8.2 Review-inbox paging — minor

`GET /api/apply/pending` caps at 100, `GET /api/apply/questions` at 50, neither pageable and
neither reporting truncation. Generous on desktop; a phone user reviewing in short bursts
accumulates a backlog past the cap with no indication it exists.

> **A third instance of this class — `GET /api/apply/gate-packets` — was found and fixed (§14),
> where the truncation was making the extension stop a batch that still had work in it. These two
> remain open.**

### 8.3 "Does a resume already exist for this job" — structurally absent

`mapJobRow` maps a *job*; resume currency is a per-`(user, job, tool, profile)` question needing a
join to `resumes` and `profile_base_resumes`. A swipe card cannot show "already generated" without
a second request per card. See `SWIPE_FEED_DESIGN.md` Finding 6.

### 8.4 No trustworthy ATS badge — and a latent defect confirmed

`sourcePlatform` *looks* like the ATS badge and is not. `mapJobRow` reads `j.sourcePlatform`
(camelCase) while the column is `source_platform`, so for any DB row it resolves to `j.source` —
**where the job was found, not what the candidate will face.** It looks right only because both
current scrapers are named after the ATSes they scrape; add one aggregator source and the badge
lies.

This is documented **in the contract itself**, on the field, so a mobile developer reading the
schema is told before building on it. `automationTier` *is* trustworthy — it is derived from
`detectPlatformFromUrl(apply_url)`.

### 8.5 No push transport

Realtime is SSE at `GET /api/sync/events`, which requires a foregrounded process. A backgrounded
iOS or Android app cannot hold one, so "your application needs approval" cannot reach a user who is
not looking at the app — precisely when it matters. APNs/FCM registration plus a server-side sender
is a real project.

---

## 9. One more finding: the swipe endpoint

**`PATCH /api/jobs/{id}/starred` and `/disliked` TOGGLE** — they read the current value and write
its opposite. A swipe is an *absolute* gesture ("save this"), and on a phone network a retried or
double-sent toggle **silently undoes the user's swipe and returns 200.**

`PATCH /api/jobs/interact` sets the value you send, so it is idempotent and safe to retry. **The
toggle routes are deliberately absent from this contract**, and the note on `/api/jobs/interact`
says why. `Idempotency-Key` is documented on all three write endpoints that support it.

---

## 10. Consumption strategy (requirement 3)

**Recommendation: copy the files in, and assert the checksum.** Full reasoning in
`contract/README.md`; the short version:

- **A git submodule** would point at this whole server repository — large, private, carrying deploy
  config a mobile CI job should not clone. Making it work means first splitting the contract into
  its own repository: real ongoing infrastructure, for a version pin a checksum already gives.
- **An npm package** only serves a JavaScript consumer. Per `MOBILE_STATE.md` §8 the platform
  choice is unmade and Capacitor is close to ruled out (the web client is a desktop-shaped tiled
  dock and is not responsive), so the likely outcome is **native Swift and Kotlin** — neither
  consumes npm.
- **Copy + checksum** is language-agnostic, needs no network at build time, and the pin is
  reviewable in a diff. `mobile-api.v1.json` drives `openapi-generator` for both platforms.

Checksums are computed over **LF-normalised** content, deliberately: this repo has
`core.autocrlf=true` and no `.gitattributes`, so a raw-byte hash would fail on a fresh Windows
checkout of byte-identical content — and a test that fails for the wrong reason gets deleted.
Copy-paste checksum tests for XCTest and JUnit are in `contract/README.md`.

Version `1.0.0`. The versioning table — including why *removing* a field is deliberately awkward —
is in `contract/README.md`.

---

## 11. Scope held — as of the contract commit

No mobile screens were built. At the point §1–§10 were written, the web client, the extension and
every existing endpoint's behaviour were unchanged except for the two auth decisions, which are
additive: two new routes, and a renewal that only ever extends an expiry.

**Not done at that point, and flagged rather than silently skipped:** the five gaps in §8 were
reported, not implemented — cursor pagination in particular being a real server change with its own
design, and building it inside a contract task would have been exactly the unbudgeted scope creep
`MOBILE_STATE.md` warned about.

> **Superseded for §8.1 only.** Pagination was then fixed on the server (**§12**) and wired into the
> web board (**§13**), in that order, as separate pieces of work. §8.2–§8.5 remain open and remain
> reported rather than built.

---

## 12. Keyset pagination — the §8.1 gap, closed

Contract **1.1.0**. Additive: `page`/`pageSize` are unchanged, so `client/` and `extension/` need
no release.

```
GET /api/jobs?pageSize=20               ->  { jobs: [...], nextCursor: "eyJ2Ijox...", paging: "offset" }
GET /api/jobs?pageSize=20&cursor=eyJ…   ->  { jobs: [...], nextCursor: "eyJ2Ijox...", paging: "cursor" }
                                        ->  nextCursor: null  means this is the last page
```

### The measurement

Both halves are asserted, and the first is what makes the second mean anything — a cursor walk over
an unchanging board passes trivially and would be measuring its own fixture. On a 25-job board with
3 swipes per page:

| | jobs skipped |
|---|---|
| offset paging | **6 of 25** — never shown, still counted in `total` |
| keyset cursor | **0** |

Asserted in `test/jobsKeysetCursor.test.js` against a fixture, and again in
`scripts/aj1MobileBearer.mjs` over real HTTP through the real handler.

### The design, and the one thing it is really protecting against

The ORDER BY and the cursor's resume predicate **must** agree key-for-key and direction-for-
direction. Written twice they drift, and the failure is silent — a mismatched cursor does not
error, it returns the wrong rows. Same shape as every other defect in this repository's history.

So `services/jobs/jobCursor.js` declares each sort **once**, as a list of `{sql, dir}` keys, and
generates the ORDER BY, the SELECT projection and the cursor predicate from that one declaration.
The eight sorts were verified to produce **character-identical SQL** to the strings they replaced,
so board ordering did not change.

Three details that each fix a real failure mode:

- **Equality is `IS`, not `=`.** SQLite's `=` yields NULL when either side is NULL, so on a row with
  no `posted_at` the lexicographic chain evaluates to NULL — falsy — and the feed *stops dead
  partway down*, reporting the end of the board in the middle of it. A third of the test fixture is
  NULL-dated for exactly this reason.
- **The `(x IS NULL)` guards are cursor keys, not decoration.** They partition null from non-null
  before the comparison on `x` is reached. Dropping them from the cursor while leaving them in the
  ORDER BY resumes in the wrong partition.
- **The cursor's values come from the database.** Each sort key is projected into the SELECT as
  `__cursor_kN`, so SQLite reports the value it actually sorted by. Re-deriving
  `COALESCE(discovered_at, scraped_at)` or the experience-level `CASE` in JavaScript would be a
  second copy of the ordering by another name.

`hasMore` is established by fetching `pageSize + 1` rows and trimming. Comparing `rows.length` to
`pageSize` cannot tell a full last page from a full page with more behind it, and a feed that
guesses either stops one page early or offers a next page that returns nothing.

### Cursors are validated, not trusted

A cursor carries a signature of the ordering it was issued under. Reuse it after changing `sort` —
or after switching domain profile, which changes the derived relevance keys — and it answers **400
`cursor_sort_mismatch`** instead of silently resuming against keys that no longer mean the same
thing. A garbage cursor is **400 `cursor_malformed`**, never a 500. Both are asserted over HTTP.

The relevance prefix participates in the cursor, and it carries bound params that appear in the
SELECT, in the predicate (twice per key) and in the ORDER BY. Placeholder binding is positional, so
a mis-ordered param list would not throw — it would return plausible wrong rows. That ordering has
its own test.

### What did NOT change, deliberately

`page`/`pageSize`/`totalPages` still work exactly as before; removing OFFSET would break two shipped
consumers to serve a third that does not exist yet. `nextCursor` is emitted on **both** modes, so an
offset client can adopt cursors mid-feed without restarting.

`paging: "cursor" | "offset"` says which mode answered. Under a cursor there is no page number to be
on, and `page`/`totalPages` are meaningless — said in the body rather than left for a client to
infer from a number that still looks valid.

### Still true, and worth stating

`total` remains a snapshot and shrinks as the user swipes. It is a progress denominator, not a
promise about how many more are coming. §8.2–8.5 are unchanged and still open.

### Two guard tests were re-pointed, not weakened

`boardOrderingTieBreak` and `filterOptionContract` anchored on source strings in `server.js`
(`const RECENCY =`, `const chosenSort = sort ===`) that no longer exist. Both now assert the same
properties **structurally** against `SORT_KEYS`, which is stronger: "every sort ends in the primary
key" is now a key-list comparison rather than a regex looking for the word `RECENCY` on the same
line, and it would have passed for a sort that merely mentioned it in a comment. `jobCursor.js` also
throws at module load if a sort is not totally ordered, so a bad sort cannot reach a request at all.

---

## 13. The web client pages by cursor

§12 fixed the API. The web board still paged by offset, and it has the same defect on its own
dislike path — so this wires it up.

### The board is a NUMBERED pager, and that decides the design

Prev · 1 2 3 … · Next · "go to page N". A keyset cursor **cannot** answer "page 17" — it has no
notion of position, which is exactly the property that makes it correct for stepping. Replacing the
pager with a cursor would delete random page access, a working feature, to fix a defect that does
not live there. So each mode answers what it is actually good at:

| Navigation | Mode | Why |
|---|---|---|
| **Next / Prev** — a *step* | **cursor** | The board may have shrunk under the reader. This is the case a cursor can answer. |
| **page 17 / go-to-page** — a *jump* | offset | The user asked for a **position**. Nothing else can answer one. |
| Refresh of the page on screen | this page's own cursor | Re-asking by offset would move content under someone who has not navigated. |

**Prev needs no backwards cursor.** Going back re-runs the request that produced the earlier page,
from a stack of the cursors already used. That stays valid even when the row a cursor was issued
from has since been disliked — a cursor carries sort **values**, not a reference to a row.

### Why the skip survived this long on the web board

It is invisible twice over. The list does not visibly shrink, because JobsPanel re-injects
session-disliked rows so they stay on screen (faded); and `total` still counts the skipped rows, so
the pager's arithmetic looks right. Nothing anywhere reports the loss.

### Verified in a real browser

`scripts/aj2BoardCursor.mjs` drives the real board in Chrome against a stub that implements a
**real keyset cursor** — same ordering as the server, cursor holding the last row's sort values,
resume strictly after them. A stub that just returned "page 2" on demand would echo whatever the
client sent and prove nothing.

60 jobs, page size 25. Pass on four jobs from page 1, then press Next:

```
page 1  (offset)          j00 … j24
passed on                 j02, j05, j11, j19
PRECONDITION — offset would skip:  j25, j26, j27, j28
Next sent                 ?cursor=WzE3ODc5MzYyOTMsImoyNCJd   ( = [1787936293,"j24"] )
page 2  (cursor)          j25 … j49        nothing skipped
Prev                      back to j00, with the four passed jobs now gone
jump to page 3            ?page=3   — offset, as it must be
```

The precondition is asserted **first**. Without it a cursor walk over an unchanging board passes
trivially and the harness would be measuring its own fixture. 16 checks, all passing, screenshots
confirming the board renders — not merely that text extraction succeeded.

### The policy is extracted, because a decision in a click handler cannot be tested

`client/src/lib/boardPaging.js` holds `planPageFetch` and `recordPageCursor`, out of a 3,800-line
component. `test/boardPagingCursor.test.js` covers the decision table in 14 tests.

Writing those tests changed the design once, which is the reason to write them: the obvious
implementation makes a **Next with no cursor available** fall through to the jump branch and wipe
the chain, purely because it happened to page the old way for one request. Nothing breaks, but the
chain is rebuilt from scratch and the reason is invisible. A step is a step; only a jump is a jump.

Two traps worth naming, both pinned by tests:

- **`stack[0]` is `null`, and `null` is a real value** meaning "page 1 was fetched by offset". A
  falsy check treats it as "no chain" and discards a good chain on every return to page 1. The test
  is against `undefined`.
- **The stack truncates on record.** Walk to page 3, go back to 2, take a different Next — without
  truncation the stack still holds page 3's cursor from the abandoned branch, and a later Prev
  replays a request belonging to a page the user never came from.

### Invalidation, and recovery

A cursor is bound to the ordering it was issued under, so any filter or sort change invalidates the
chain. The key is derived from `buildParams` itself rather than a hand-listed dependency array — a
filter added later cannot forget to invalidate it, and that omission would not throw, it would
silently resume against the wrong ordering.

If a stale cursor reaches the server anyway, the 400 `cursor_sort_mismatch` is a message to the
*client*, not to the user: it retries once by offset and logs it. Surfacing "Request failed (400)"
for a recoverable condition would be a dead end.

`cursor` is exempt from the tracked-search param contract. A saved search restores a **filter set**;
replaying a saved cursor would resume at a position that no longer means anything.

### What did not change

`page`, `pageSize` and `totalPages` are untouched, the numbered pager still works, and a board with
no cursor available simply pages the old way. The extension is not affected.

---

## 14. The gate-packet cap — a silent truncation, and the one that failed as a *completion*

### First: there was nothing to wire in the extension

Asked to apply §13's cursor work to the extension, I checked before building. **The extension never
calls `/api/jobs`.** Six `fetch` calls exist in the whole tree:

| Endpoint | Shape |
|---|---|
| `POST /api/import/job` | one job |
| `GET /api/auth/me` | auth check |
| `GET /api/apply/gate-packets` | a list — read whole, filtered by origin, `[0]` taken |
| `POST /api/apply/gate-packets/{id}/token`, `/gate-packet/exchange`, `/gate-review` | one packet |
| `GET`/`POST /api/apply/form-schema[/consent]` | one schema |

`popup.js` renders no list at all, and `buildExtension.mjs` derives its file list from the manifest,
so nothing else is bundled in. The only `cursor` matches in the extension are `cursor: pointer` in
CSS. It is a capture-and-handoff tool with no feed, so there is no offset-skip to fix — and wiring a
cursor in would have meant building a feed that does not exist.

### What was actually broken

`GET /api/apply/gate-packets` returned `ORDER BY created_at DESC LIMIT 100` over **every**
unconsumed packet across **every** portal, with nothing in the body saying the list had been cut.

**The extension's failure is the serious one.** All three of its call sites fetch that list and
immediately discard every row whose `expectedOrigin` is not the tab's. They ask *"what is queued for
THIS portal?"* and were answered with *"the newest 100 across all of them."* With a long queue, a
portal whose packets all fall outside the newest 100 comes back empty — and `background.js` turns
that into `batch_empty`, **stopping a run that has work left and telling the candidate there is
nothing to do.** A cap failing as a *completion* is the worst shape it can take.

**The panel's failure is milder and the same class.** It renders every portal from the same capped
list, so past 100 it shows fewer portals than exist and every count on them is short — a queue
surface that under-reports the queue.

### The fix is both halves

**`?origin=`** — the question every extension caller actually asks. The cap then applies to the set
the caller cares about, where 100 packets for a *single* portal is a different order of magnitude.
The filter is `AND`ed onto the existing ownership and unconsumed predicates, never substituted for
them; a filter that replaced the scope rather than narrowing it would be a disclosure, and there is
a test for exactly that.

**`total` / `truncated` / `returned` / `limit`** — always present, on both scoped and unscoped
responses. `rows.length` alone cannot distinguish a full list from a capped one, which is precisely
what let a truncated answer read as an empty queue. `truncated` is derived from the count, not from
whether `rows.length` happened to hit the limit.

Both statements are built from one `origin` local, so the list and its count cannot be scoped
differently — a `total` computed over a different scope than the rows would be worse than no total.

### Measured

`test/gatePacketsCap.test.js` builds a 140-packet queue where 20 packets for one portal are the
**oldest**, so they fall entirely outside the newest 100. That is the reported failure, not a
contrived one: a candidate works through recent portals while an older batch waits.

```
unscoped            100 of 140 returned; slowportal's packets: 0     <- reads as batch_empty
?origin=slowportal   20 of  20 returned; truncated: false            <- all of them
?origin=fastportal  100 of 120 returned; truncated: true             <- still capped, and says so
```

The panel notice is verified on screen by `scripts/abPanelUi.mjs`, whose fixture is deliberately
truncated: *"Showing the 11 most recent of **137** queued handoffs."* It names the real total rather
than merely saying some are hidden — "some are hidden" gives the candidate nothing to act on, "137
queued" tells them the backlog is the problem. That the notice is *conditional* is asserted
separately in the node test, since a browser check with a truncated fixture cannot prove a notice
does not appear when it should not.

### The extension still filters by origin itself

Deliberately, and it is not redundancy for its own sake: **an extension ships and updates
independently of the server it talks to.** A build that trusted `?origin=` to have been honoured
would fill against the wrong portal on a server that predates the parameter. Filtering twice costs
nothing; assuming version parity is how a skew becomes a wrong-portal fill.

The submission zip was rebuilt, since `test/extensionSubmission.test.js` requires every file in it
to be byte-identical to source. The manifest version is **not** bumped: v1.0.0 has never been
submitted, so bumping would imply a released version existed, and it would invalidate the filename
`STORE_LISTING.md` already cites.

### Relationship to §8.2, stated precisely

§8.2 named `/api/apply/pending` (capped at 100) and `/api/apply/questions` (capped at 50) as
unpageable and silently truncating. `gate-packets` is a **third instance of the same class** that
§8.2 did not name. It is now fixed; **those two are not.** Neither is consumed by the extension, and
neither has the origin-shaped question that made this one cheap to fix properly — so they stay
reported rather than quietly assumed handled.
