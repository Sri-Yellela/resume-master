# Mobile Swipe Feed — Design + Phase-1 Audit

**Status: DESIGN ONLY — no swipe feed has been built.**
Audit performed against the working tree at commit `5c76ba1`, with live counts from
`data/resume_master.db`.

**One exception, added 2026-08-27:** the generation-cap hole in **Finding 4** has since been
**fixed in code** at the owner's instruction, because it was an unmetered-spend bug on the
*existing* surface and not specific to the feed. Everything else here remains unbuilt design.
See also `docs/MOBILE_STATE.md`, which supersedes Gate C — and finds that no mobile client exists.

---

## 0. THE HARD CONSTRAINT

> **A SWIPE QUEUES. IT DOES NOT SUBMIT.**

Every safeguard in this system assumes a human reviews before an application reaches an employer:
semi mode, the G3 provenance overlay, the four pre-submit gates (ATS, completeness,
low-confidence, drift), and the panel's own promise, which is a literal string in
`client/src/contexts/AutoApplyContext.jsx:616`:

    "N jobs queued — nothing is sent until you approve each one."

A swipe is a one-bit gesture with no review attached, and it is the easiest gesture on a phone to
fire by accident. Therefore this design contains **no** auto-submit-after-N-seconds, **no** undo
window that expires into a submission, and **no** setting that converts swipe into submit. If a
future revision of this document produces an application sent by a swipe alone, that revision is
wrong.

The good news from the audit: **the server already enforces this by default**, and the constraint
is a matter of *keeping* a property rather than adding one. See Finding 1.

---

## 1. PRECONDITIONS — GATES ON IMPLEMENTATION, NOT PROBLEMS TO WORK AROUND

### Gate A — Unattended full-auto has never run against a real employer

The owner's bar is **10 semi runs per ATS across 10 distinct jobs each**. That bar is not partly
met; it is unstarted. The entire `apply_run_jobs` table contains **one row, in status `failed`
with `reason_code='internal_error'`**. There is no corpus of successful real applications at all.

A swipe feed's whole purpose is to make queueing fast. Queueing faster than the pipeline has been
validated converts an unproven pipeline into an unproven pipeline pointed at thirty employers.
**The feed must not ship before Gate A is met.** It may be built behind a flag; it may not be
enabled.

### Gate B — The gated handoff cannot exist on mobile

`docs/GATED_HANDOFF_ARCHITECTURE.md` §2: the security property is that the user's own desktop
browser holds the authenticated portal session, and the extension borrows it for exactly one
gesture under `activeTab`. The extension pulls; nothing pushes in (`externally_connectable`
"stays absent" — §2). There is no Chrome extension on mobile, so **`activeTab` cannot be granted
and a `held_gate` row is unresolvable from a phone.** This is not a porting problem. It is the
mechanism.

Consequence, designed for in §2.5 below: a phone can *create* work it cannot *finish*.

### Gate C — the mobile audit — **NOW DONE, AND IT CHANGES THE PICTURE**

*Superseded 2026-08-27: `docs/MOBILE_STATE.md` now exists.* When this document was written the
mobile audit had not been done, so no implementation cost was stated. **No estimates have been
added, and the reason is now stronger rather than weaker:**

The audit found that **no mobile client exists — and none ever has, in any commit on any branch.**
There is no React Native, Expo, Capacitor, Cordova, native, or even PWA surface. The verdict is
*literally* greenfield.

So this feed is not a feature to add to a mobile app. **There is no mobile app to add it to.** Two
consequences for this design:

- Everything below still holds as a design for a swipe surface, but it presupposes a mobile client
  that must be built first, on a platform not yet chosen.
- One finding constrains that choice directly: the web client is a desktop-shaped tiled dock with
  only 13 media-query occurrences in total, so **Capacitor-wrapping the existing Vite build would
  ship an unusable app.** The cheapest route to a swipe feed is likely unavailable.

The audit also **removed the expected auth blocker**: a bearer-token path already exists end to end
(`POST /api/auth/login` returns `authContext`; `requireAuth` accepts it without a cookie). That is
good news for this design — the review step in §2.3 is reachable from a phone.

---

## PHASE 1 — FINDINGS FROM THE CODE

### Finding 1 — What queueing does today, and the one path a swipe must use

`POST /api/apply/runs` (`routes/apply.js:1282`) is a thin wrapper. All logic lives in
**`startRun()` (`routes/apply.js:1145`)**, which is also called by the answers-retry path
(`:2870`) and the approve path (`:2624`). Trace:

| # | Step | Where |
|---|---|---|
| 1 | `withIdempotency` — per-user key replay guard | `:1283` |
| 2 | `jobIds` non-empty, **max 25 per run** | `:1287`, `:1289` |
| 3 | `approvalMode === 'approved'` rejected from clients (`approval_mode_reserved`) | `:1293` |
| 4 | mode normalise: `manual`\|`semi` → `semi`, else `auto` | `:1156` |
| 5 | tool normalise + A+ entitlement 403 | `:1161`, `:1176` |
| 6 | **approval resolve** — see below | `:1169` |
| 7 | kill switch: `auto` + `fullAutoDisabled()` → 503 | `:1190` |
| 8 | concurrency: `activeRunCount >= APPLY_MAX_ACTIVE_RUNS` → 429 | `:1198` |
| 9 | prerequisites: base resume / active profile / name+email → 409 | `:1213` |
| 10 | **duplicate filter** — see Finding 5 | `:1222` |
| 11 | daily cap — see Finding 4 | `:1236` |
| 12 | INSERT `apply_runs` (`status='queued'`) + `apply_run_jobs` rows | `:1245`, `:1256` |
| 13 | `setImmediate(processRun)` → `processRunJob` per job | `:1264`, `:475` |

**Step 6 is the load-bearing safeguard.** `routes/apply.js:1169`:

```js
const resolvedApproval = resolvedMode === "semi" ? "auto"
  : approvalMode === "auto" || approvalMode === "approved" ? approvalMode
  : "required";
```

Omitting `approvalMode` yields `"required"`. In `processRunJob` (`:481`–`:483`):

```js
const needsApproval = mode === "auto" && approvalMode === "required";
const applyMode = mode !== "auto" ? "semi" : needsApproval ? "preview" : "full";
```

`preview` is "full-auto minus the click": it generates, opens the form, fills it, runs every gate,
and stops. The row lands `held_review` / `reason_code='awaiting_approval'`, and only
`awaiting_approval` rows are releasable by `POST /api/apply/approve`.

> **Design consequence.** A swipe must POST to `/api/apply/runs` **omitting `approvalMode`
> entirely**. It then physically cannot submit. The existing client already does exactly this
> (`AutoApplyContext.jsx:611` sends only `jobIds`, `mode`, `tool`), and its own comment says both
> its buttons "post mode:'auto' and omit approvalMode, so the server's approval-required default
> applies."
>
> **Recommended hardening (a real gap):** the *default* is safe, but the *route* still accepts
> `approvalMode:'auto'` from any client. Today nothing sends it. A swipe feed adds a second caller
> and this project has twice been bitten by exactly that shape of drift — popup vs hotkey writing to
> different tables; three hardcoded tab lists. Add a **per-surface refusal**: a request carrying the
> feed's surface marker may not set `approvalMode` at all, rejected the same way `'approved'`
> already is at `:1293`. One queue mechanism, two triggers, and the trigger that cannot review is
> not permitted to ask for no review.

### Finding 2 — What the card needs vs. what `mapJobRow` returns

`services/jobs/mapJobRow.js` is the whitelist and the binding constraint — it is the only shape
`/api/jobs`, `/api/jobs/by-id`, and `routes/importJob.js` emit.

| Card element | In `mapJobRow`? | Field |
|---|---|---|
| Company | ✅ | `company` |
| Role | ✅ | `title` |
| Logo | ✅ | `companyIconUrl` (falls back to `thumbnail`) |
| Location | ✅ | `location` |
| Salary | ✅ | `salaryMin` / `salaryMax` / `salaryCurrency` |
| Freshness | ✅ | `postedAt`, `discoveredAt`, `validThrough` |
| Work model | ✅ | `workplaceType`, `remote` |
| Listing still live | ✅ | `isActive` |
| `automation_tier` | ✅ | `automationTier` |
| **ATS badge** | ⚠️ **effectively missing — see below** | — |
| **Resume already exists for this job** | ❌ **absent** | — |

**Two gaps, one of them a latent bug.**

**(a) The ATS badge is not reliably available, and `sourcePlatform` is mislabelled.**
`mapJobRow.js:34`:

```js
sourcePlatform: j.source || j.source_label || j.sourcePlatform || 'direct',
```

`scraped_jobs` has a real **`source_platform`** column (snake_case). This line reads
`j.sourcePlatform` — **camelCase — which never matches the DB column**, so for any DB row the
expression resolves to `j.source`. Confirmed against live data: `source_platform` is
**NULL for all 1261 active rows**, and `source` holds `greenhouse` (634) / `ashby` (626) /
`import` (1).

So `sourcePlatform` today reports **where we found the job**, not **which ATS the candidate will
face** — it is an alias for `source` wearing a different name. It *looks* correct right now only
because this board's two ingest scrapers happen to be named after the ATSes they scrape. Add one
aggregator source (jobo, adzuna) and `sourcePlatform` starts reporting the aggregator while the
apply destination is a Workday tenant.

The correct derivation already exists and is already used: `detectPlatformFromUrl(apply_url)`
(`services/platformDetector.js`), which is what `deriveAutomationTier()` itself calls. The badge
should come from that — persisted, or mapped — **not** from `sourcePlatform`.

**(b) "Does a resume already exist for this job" is structurally absent.** `mapJobRow` maps a job
row; resume currency is a per-`(user, job, tool, profile)` question requiring a join to `resumes`
and `profile_base_resumes`. `/api/jobs/pending` (`server.js:7019`) already does a version of this
join (`LEFT JOIN resumes r`, plus `uj.resume_generated`), but `/api/jobs` does not, and
`uj.resume_generated` is a bare boolean, not the AH5 rule. See Finding 6.

### Finding 3 — Automation-tier gating: the real distribution

Queried live, `is_active = 1`:

| tier | count | share |
|---|---|---|
| `direct` | **1260** | **99.92%** |
| `unknown` | 1 | 0.08% |
| `guest` | 0 | — |
| `account` | 0 | — |
| `gated` | 0 | — |

(All 1291 rows including retired: `direct` 1290, `unknown` 1.)

**The premise "~95% of the board" understates it, and the more important fact is the zeros.**
There are currently **no** `guest`, `account`, or `gated` rows at all.

I am not deciding this. Both options, with the counts:

**Option A — `direct` only.**
Excludes **exactly 1 job of 1261**. The feed's promise ("swipe right and it gets queued and
previewed") is true for every card shown, with no exceptions to explain. Cost: one job invisible
on mobile.

**Option B — show all tiers, with an explicit "finish on desktop" state.**
Excludes nothing. Costs a second card state and a second mental model, which today would render
on **1 row**, whose tier is `unknown` — and `unknown` is documented in
`services/jobs/automationTier.js` as *"presented as a promise in NEITHER direction"*. So Option B
today buys one card that must honestly say "we don't know", which is the weakest possible case for
the extra state.

**My recommendation, for the owner to accept or reject:** ship **Option A** for the feed surface,
but **build the "finish on desktop" state anyway and leave it unreachable**. Reason: this
distribution is an artifact of having only Greenhouse and Ashby scrapers, not a property of the
job market. `PLATFORM_TIER` already maps `workday`/`icims`/`taleo`/`jobvite` → `account` and
`linkedin` → `gated`. The day any such source is added, the population flips from 0 to
substantial, and a feed that filters to `direct` will *silently shrink* rather than misrepresent —
the safe direction. A feed built on Option B with no test population would ship an untested state.

Note also `automationTier` may be **`null`** (row predates migration 078). `mapJobRow`'s own
comment: the client must read `null` exactly as it reads `'unknown'`, **never as `direct`**. A
feed filtering `tier === 'direct'` gets this right by construction; a feed filtering
`tier !== 'account'` would get it wrong.

### Finding 4 — Resume-generation timing and cost exposure: **THIS IS A FINDING**

**The AF3 guards cap RUNS and SUBMISSIONS. They do not cap GENERATIONS.**

Queueing triggers generation immediately: `processRunJob` calls
`generateResumeForApply` (`routes/apply.js:711`, `:831`) and — in **all three** branches
(`:679`, `:738`, `:868`) — also `generateCoverLetterForApply`. So **every queued job is two model
calls, not one**; the ~$0.04 figure covers the resume only.

Critically, this happens **on the preview path too**. `applyMode='preview'` stops short of the
click, not short of generation. Money is spent at *queue* time, and a preview that the user later
rejects has already been paid for in full.

Now the caps (`routes/apply.js:169`–`170`, `222`):

```js
const APPLY_DAILY_CAP       = envInt("APPLY_DAILY_CAP", 25);
const APPLY_MAX_ACTIVE_RUNS = envInt("APPLY_MAX_ACTIVE_RUNS_PER_USER", 1);

function submittedLast24h(userId) {          // ← counts SUBMITTED
  return db.prepare(`SELECT COUNT(*) AS n FROM apply_run_jobs
    WHERE user_id=? AND status='submitted' AND COALESCE(finished_at,0) >= unixepoch()-86400`)...
}
```

and the admission check (`:1236`):

```js
if (resolvedMode === "auto" && used + filtered.length > APPLY_DAILY_CAP)
```

**The hole.** In the approval-required world that is now the default, `status='submitted'` stays at
**0** until a human approves. So `used` is 0, essentially always. The check becomes
`0 + filtered.length > 25` — which 25 jobs pass. Approve nothing, and `used` stays 0, and the next
25 pass too. `APPLY_MAX_ACTIVE_RUNS = 1` only *serialises* runs; it is a rate limiter, not a
ceiling. **Generation is therefore bounded only by how fast the user can queue and how fast the
pipeline drains** — and each preview also launches a real browser per job.

The one limit that *would* bind, `checkLimit(db, userId, 'resume_generate')` — which has both
`daily_resumes` and `monthly_resumes` in `services/limitEnforcer.js`'s `LIMIT_MAP` — **is never
called on this path.** It has exactly one call site, `server.js:7818`, inside the HTTP
`/api/generate` route. `generateResumeForApply` (`server.js:7618`) calls `coreGenerateResume`
directly, and `coreGenerateResume`'s own header comment says so:

> *"Does NOT do HTTP req/res or rate-limit checks — those live in the caller."*

So the apply pipeline is the caller that doesn't. (Note too: `checkLimit` returns
`{allowed:true}` when the user has no `user_limits` row at all.)

**Exposure, stated plainly.** A swipe feed makes queueing a two-second gesture. 40 swipes in two
minutes = 40 resumes + 40 cover letters = **80 model calls, none of which any cap prevents, before
a single application is submitted or even approved.** Today's manual UI hides this only because
selecting 25 jobs by hand is slow.

**This must be fixed before the feed exists, not by the feed.** The fix belongs in
`generateResumeForApply` / `startRun`, so it protects the existing surface too.

> ### ✅ FIXED — 2026-08-27, both halves
>
> **1. `startRun` now has a generation-aware admission gate.** New
> `APPLY_DAILY_QUEUE_CAP` (`envInt`, default **40**) and `queuedLast24h(userId)`, which counts
> `apply_run_jobs` rows by `created_at` in the trailing 24h **regardless of terminal status** —
> because a job that generated and then held cost exactly as much as one that submitted. Refuses
> with `429 queue_cap_exceeded`, in the same explicit shape as the other limits, and reports
> `queueCap: { limit, queuedLast24h, remaining }` in the 202 body so a caller can show the budget
> instead of discovering it by being refused.
>
> It sits **above** `APPLY_DAILY_CAP` (25) deliberately: every submission needs a queue first, so a
> queue cap at or below the submission cap would make the submission cap unreachable. The 15 of
> headroom covers legitimate re-queues (the answers path, a retry after a hold).
>
> It **excludes `approval_mode='approved'` runs.** That run reuses the artifact the preview just
> generated (`artifactCurrency` → CASE A), so counting it would cost two against the cap per
> application and turn the guard into a refusal to submit work the user had already reviewed.
>
> **2. `generateResumeForApply` now calls `checkLimit(db, userId, 'resume_generate')`** before
> `coreGenerateResume` — closing the gap where the apply pipeline was the one generation path a
> user's plan limits did not reach. Placed **after** the reuse and in-flight checks, so reusing a
> current artifact and attaching to an in-flight generation are never refused; only a genuinely new
> model call is metered. Returns the same structured shape as an upstream failure with
> `errorCode: 'generation_limit_reached'` and `errorPermanent: true` (a limit does not clear on
> retry), which `processRunJob` already reads into `genFailure` and files as `held_review` — so the
> run reports the limit against the job it happened to, rather than dying as a browser error.
>
> **Verified:** suite unchanged at **1915 passing / 0 failing**; the new SQL validated against the
> live schema; boundary arithmetic checked (`0+25` admits, `25+15` admits, `25+16` refuses). The
> old hole is closed at the case that defined it — two consecutive 25-job runs previously *both*
> admitted (50 unbounded generations); the second is now refused.
>
> **Still open, and deliberately not changed here:** `checkLimit` returns `{allowed:true}` when the
> user has no `user_limits` row at all. Ensuring every user has one (or making the null case a
> default rather than unlimited) is a provisioning/product decision, not a code fix, and it is the
> owner's call.

### Finding 5 — Duplicate protection: **insufficient for a feed, and a second finding**

Two mechanisms exist. Neither does what the feed requires.

**(a) `startRun`'s filter (`routes/apply.js:1222`) — queue-time only, three statuses:**

```sql
SELECT job_id FROM apply_run_jobs
WHERE user_id=? AND status IN ('submitted','running','queued')
```

Missing from that list: **`held_review`, `held_gate`, `failed`, `cancelled`, `dismissed`,
`superseded`**. Re-queueing a `held_review` job is *deliberate* — that is how the retry and answers
flows work — but it means the filter is not an "already dealt with" test. It is also
**per-user, not per-profile**, while the board is scoped per `domain_profile_id`.

**(b) The board's chip — annotation, not exclusion, and client-side.**
`client/src/contexts/AutoApplyContext.jsx:629` builds `applyStateByJobId` by folding five
already-loaded apply feeds, and `JobCard.jsx:128` renders `boardApplicationChip(...)`. Its own
comment: *"This is the join, done here from feeds already loaded rather than by widening
GET /api/jobs — so it costs no request."* That is a good trade for a board. For a feed it fails
three ways:

1. **It annotates; it does not exclude.** An already-applied job still appears, wearing a chip. On
   a swipe surface, a chip on a card you dismiss in two seconds is not protection.
2. **It is windowed, and worse, it is user-erasable.** All five feeds come from a single
   `GET /api/apply/runs` (`AutoApplyContext.jsx:100`–`106`). The sub-feeds *are* correctly
   cross-run — `WHERE rj.user_id=?`, not scoped to the 20 runs, exactly as the endpoint's comment
   intends — but each is **`LIMIT 50`** (`routes/apply.js:1379`–`1421`), so the 51st-oldest
   submitted application drops out of the dedup source. And every feed carries
   **`AND rj.hidden_at IS NULL`**, while `DELETE /api/apply/run-jobs/:runJobId`
   (`routes/apply.js:2049`) sets `hidden_at`. **So a user who tidies a submitted application out
   of their panel deletes the only signal that they applied to that job** — and since the pipeline
   never writes `user_jobs.applied` either (point c), the job comes back to the board with no chip
   and nothing marking it applied. `statusCounts` is unwindowed but carries no `job_id`s, so it
   cannot dedup anything.
3. **Client-side filtering cannot drive server-side pagination.** If the server returns 20 and the
   client hides 6, the feed serves short pages and reports a count that disagrees with the list —
   the same class of defect as a correct job count over an empty list.

**(c) THE FINDING — the auto pipeline never records that it applied.**
`/api/jobs` excludes **only** `disliked` (`server.js:6283`):

```sql
AND (uj.disliked IS NULL OR uj.disliked = 0)
```

There is no applied-exclusion. `appliedSql` (`server.js:6048`) is an **inclusion** filter:

```js
const appliedSql = applied === '1' ? `AND uj.applied = 1` : '';
```

— it powers the search bar's Status → "Applied" tab. And the flag it reads is never set by the
auto pipeline. `user_jobs.applied = 1` is written in exactly two places, both **manual**:
`server.js:8028` (the application tracker) and `routes/apply.js:129` — which writes
`apply_mode='MANUAL', auto_status='manual'`. On a successful auto submit, `processRunJob`
(`routes/apply.js:918`–`975`) writes `apply_run_jobs` and the event log **and nothing else**: no
`job_applications` row, no `user_jobs.applied`.

So: **an application successfully submitted by the auto pipeline leaves the board's own
already-applied flag untouched.** The sibling endpoints that *do* exclude applied jobs
(`/api/jobs/facets` `server.js:5796`, `server.js:6721`, `/api/jobs/pending` `server.js:7028`)
are all reading a flag the pipeline does not write. This is the AH5-shaped silent staleness on
this surface, and it is upstream of the feed.

**Required before the feed:** a server-side exclusion, in the query, driven by a fact the pipeline
actually writes. Concretely — have `processRunJob` write `user_jobs.applied=1` (and a
`job_applications` row with `auto_status`) on `submitted`, and add a `NOT EXISTS` against
`apply_run_jobs` for live statuses to the feed's own query. Server-side because of point 3 above.

### Finding 6 — A job whose resume does not exist yet

**Do not invent a second freshness rule.** `services/resumeCurrency.js` already is the one
definition, and its header says why: two call sites each ran their own
`SELECT ... FROM resumes` with no rule, and both reused artifacts built under a different profile
or from a since-rewritten base resume.

```js
artifactCurrency(db, { userId, jobId, tool })
// → { current: boolean, reason: string, detail?: string, artifact: object|null }
```

The rule, in full: **same user + same job** (`resumes` is `UNIQUE(user_id, job_id)`), **same tool**
(`apply_mode`: `TAILORED` vs `CUSTOM_SAMPLER`), **same profile** (`resumes.domain_profile_id` vs
the active profile), **and generated after the last base-resume change**
(`resumes.updated_at >= profile_base_resumes.updated_at`). `reason` values:
`no_artifact`, `different_tool`, `different_profile`, `base_resume_changed`, `reused`,
`reused_unknown_profile`.

`processRunJob:656` and `generateResumeForApply:7622` both already call it. **The feed is the
third caller and must call the same function** — not `uj.resume_generated`, which is a bare
boolean that knows nothing about profile or base-resume drift.

**How the feed uses it — and how it does not.** Resume existence is **not** a gate on swiping.
`artifactCurrency` returning `current:false` is the *normal* case and simply means this job's
queue will generate. Its role on the card is honesty about what a swipe will cost:

- `current: true` → card may show "resume ready"; queueing this job is cheap (reuse, no model call).
- `current: false` → no badge. Queueing generates. This is the default and needs no warning.

It must **not** be surfaced as a blocker, and the reason string must **not** be rendered raw on a
card — `currencySentence()` exists for prose, and prose belongs in the review step, where the run
already logs `resume_reused` / `resume_regenerating`.

---

## PHASE 2 — THE DESIGN

### 2.1 Gesture map

| Gesture | Action | Backing call | Reversible? |
|---|---|---|---|
| **Right** | Queue for auto-apply *(preview + approval required)* | `POST /api/apply/runs`, `approvalMode` **omitted** | Yes — until approved |
| **Left** | Pass | set `user_jobs.disliked = 1` | Yes — un-pass |
| **Up** or **tap** | Detail (full JD, provenance, ATS) | `GET /api/jobs/by-id/:jobId` | n/a |
| **Down** | *unassigned — deliberately* | — | — |

**`pass` is confirmed as `user_jobs.disliked`**, added by migration
`008_disliked_and_linkedin_sessions` (`server.js:550`) with index
`idx_user_jobs_disliked ON user_jobs(user_id, disliked)`. It is already excluded from `/api/jobs`
unconditionally (`server.js:6283`), so a passed job stops appearing with no new machinery. The
board's pass affordance is `PATCH /api/jobs/:id/disliked` (`server.js:6882`).

> **Do not use `PATCH /api/jobs/:id/disliked` from the feed.** It is a **toggle**:
> `newDisliked = current ? (current.disliked ? 0 : 1) : 1` (`server.js:6889`). Toggles are wrong
> for a gesture stream — a retried or double-fired swipe-left silently *un-passes* the job and it
> returns to the feed. Use the explicit-value sibling **`PATCH /api/jobs/interact`**
> (`server.js:6616`), which takes `{ jobId, url, starred, disliked }` as *values* rather than
> toggling — and which already resolves a URL against `scraped_jobs` rather than inventing a
> row. Or add an idempotent `PUT`. **Left-swipe must be idempotent.**

**Down is left unassigned on purpose.** A four-way gesture map on a phone means the two most
accident-prone directions are both bound. Three actions and a dead zone is a safety margin, not an
omission.

**Undo, defined explicitly.**

- **Left (pass):** undo by un-passing. Cheap, no side effects, no time limit.
- **Right (queue):** undo = `POST /api/apply/run-jobs/:runJobId/abort` (`routes/apply.js:1949`).
  It claims the row only from `OUTCOME_STATUSES[PENDING]` — `queued`, `running`, `held_review`,
  `held_gate` — sets `status='cancelled'`, `reason_code='user_aborted'`,
  `reason_detail='You stopped this application. Nothing was submitted.'`, voids unconsumed gate
  packets, and stops the browser. If the row already moved on it returns **409 `not_abortable`**
  with the status it actually reached.

**Undo has no expiry, and undo is explicitly NOT the safeguard.** Three separate statements,
because they are three separate claims:

1. **There is no countdown.** A queued job sits in `held_review`/`awaiting_approval` indefinitely.
   Nothing expires into a submission — there is no code path that could, because only
   `POST /api/apply/approve` releases an `awaiting_approval` row and it requires a human request.
2. **Undo is a convenience, not a gate.** The gate is the approval step (§2.3). Even if undo were
   never implemented, no swipe could reach an employer. If the only thing standing between a swipe
   and an employer were a five-second undo bar, this design would be wrong.
3. **Undo cannot recall a submission** — and correctly says so: *"This one was submitted before the
   abort reached it. It cannot be recalled."* Since a swipe never submits, this branch is
   unreachable from the feed. It stays as the honest answer for the desktop approve path.

**What undo does not undo:** generation. Money is spent at queue time (Finding 4), so an
abort 20 seconds after a swipe has likely already paid for a resume and a cover letter. The undo
affordance must not imply a refund. This is an argument for §2.6's ceiling, and for a **short
pre-generation grace window** — hold the `setImmediate(processRun)` dispatch for a few seconds so
a *fast* undo is genuinely free. That window delays generation only; it is not a submit timer.

### 2.2 What the card shows

A swipe is a two-second decision, so the card carries exactly what that decision needs. Each
element justified; anything not justified is cut.

**On the card:**

| Element | Source | Why it earns its place |
|---|---|---|
| Role title | `title` | The decision. Nothing else is evaluable without it. |
| Company + logo | `company`, `companyIconUrl` | The other half of the decision; the logo is recognition at a glance, which is what a two-second read runs on. |
| Location + work model | `location`, `workplaceType`/`remote` | Hard filter for most candidates. Getting this wrong wastes the whole application, and it is one line. |
| Salary | `salaryMin/Max/Currency` | The most common single reason to pass. Omit when null — never render a range from one bound, and never imply absence means low. |
| Freshness | `postedAt`, `discoveredAt` | A three-day-old Greenhouse posting and a sixty-day-old one are different propositions. Relative ("2d ago"). |
| ATS badge | `detectPlatformFromUrl(applyUrl)` — **not** `sourcePlatform` (Finding 2a) | It is the feed's promise about what queueing will do. Must be derived correctly or omitted; a wrong badge is worse than none. |
| "Resume ready" | `artifactCurrency().current` (Finding 6) | Only when `true`. Tells the user this swipe is free. Absent otherwise — silence, not a warning. |

**Deliberately NOT on the card:**

- **The full JD.** It is the reason the detail view exists. A JD on a swipe card either doesn't fit
  or invites reading, and reading is not a two-second gesture.
- **ATS match score.** It is the pipeline's own gate at `ATS_AUTO_APPLY_THRESHOLD` (50), and
  surfacing a score the user cannot act on invites them to optimise against a number that is
  documented as candidate-specific and calibration-sensitive. It belongs in detail and review.
- **`automationTier`,** under Option A. If every card shown is `direct`, a badge saying so on every
  card is noise. It appears only if Option B is adopted, and then only as the "finish on desktop"
  state.
- **Skills / H-1B / clearance / experience-level chips.** These are `null`-heavy enrichment fields,
  and `mapJobRow`'s own comment warns `null` must never render as a false negative. Six chips that
  are usually absent is not a decision aid. They belong in detail.
- **Any count of "how many you've queued today."** That is the review surface's job, and putting a
  running total on the card gamifies volume — the opposite of what §2.6 is for.

### 2.3 The review step is the product's promise

**Reuse the Auto Apply panel's model. Do not invent a mobile grouping.**
`shared/applyOutcomeGroups.js` is already shared *specifically* so both sides agree — its header:
*"A copy on each side is how 'COMPLETED' comes to mean two things."* Mobile is a third consumer of
that same contract, not a reason to fork it.

The partition is total and asserted by `test/applyRunHistory.test.js`:

| Group | Statuses |
|---|---|
| `COMPLETED` | `submitted` |
| `PENDING` | `queued`, `running`, `held_review`, `held_gate` |
| `ABORTED` | `failed`, `dismissed`, `superseded`, `cancelled` |

and the panel's obstacle sections come from `client/src/lib/applyObstacles.js:190`:
`IN_FLIGHT = {queued, running}`, `NEEDS_YOU = {held_review, held_gate}`, via `sectionFor(status)`.

**The mobile review surface is four lists, in this order** — needs you first, because it is the
only one with an action:

1. **Needs you** — `held_review` (`awaiting_approval` and the answer-needed holds) + `held_gate`.
2. **In flight** — `queued`, `running`.
3. **Submitted** — `submitted`.
4. **Problems** — the `ABORTED` group, `splitByFault()` for blame.

**Approving on mobile is viable, and this is already designed.** `AutoApplyContext.jsx`'s comment
above `startApplyRun` states the approval flow *"keeps the same promise in a way that works
remotely: the server fills and verifies, then shows every resolved answer with its provenance, the
resume PDF and a screenshot of the filled form, and submits only when you approve."* Every artifact
that requires is already served over HTTP and is phone-renderable:

- `GET /api/apply/run-jobs/:runJobId/review` — resolved answers + provenance (G3)
- `GET /api/apply/run-jobs/:runJobId/fill-log` — what was filled
- `GET /api/apply/run-jobs/:runJobId/resume` — the PDF
- `GET /api/apply/run-jobs/:runJobId/screenshot` — the filled form
- `POST /api/apply/approve` / `POST /api/apply/reject` — the decision

**Approval must remain a per-application, deliberate act.** No swipe-to-approve — that would
smuggle the one-bit gesture past the review step and violate §0. The approve control is an explicit
button behind the provenance view, and it should require the screenshot to have actually been
viewed. A bulk "approve all" is out of scope for mobile; the whole point of the review step is that
each application was looked at.

**Per-portal amortisation on mobile: PARTIALLY, and the differentiated half does not survive.**
`routes/apply.js:2098`–`2113` groups gate-crossing packets by `expected_origin`, biggest batch
first — the "sign in once to `boards.greenhouse.io` → 4 applications ready" framing, called the
highest-leverage item in the architecture doc. The grouping rule is explicit:

> group by **OBSTACLE** when one action unblocks MANY applications (a portal sign-in)
> group by **APPLICATION** when many obstacles block ONE application (a held review)

- **The grouping is server-side and renders fine on a phone.** "4 applications waiting on
  greenhouse.io" is displayable, and `CO_RESOLVABLE_GATE_REASONS = {login_required}` already marks
  which are co-resolvable.
- **The payoff cannot be collected on a phone.** Collecting it means crossing the gate in a browser
  that holds the portal session, with the extension injecting under `activeTab` — **Gate B**.

So mobile can *show* "4 ready on greenhouse.io" and can *route* the user to their desktop. It
cannot *release* them. Displaying the group without saying that would be a promise the phone
cannot keep. **The mobile portal group must be labelled as a desktop action from the start** — not
a button that fails.

### 2.4 Eligibility answers are not swipeable

**Work authorisation, sponsorship, years of experience and custom answers are attestations made by
the candidate under their own name. A swipe cannot make an attestation** — it carries one bit and
no informed consent. They come only from stored, deliberately-entered state:

- the stored profile (`user_profile`, `simple_apply_profiles` via `loadSimpleApplyProfile`)
- the **AF1 custom-answers store** — `services/customAnswers.js`: `readAnswerStore(profile)`,
  `resolveForCompany(store, company)`, `effectiveCustomAnswers(store, company)`, with
  `{company}` template expansion and per-company overrides

**A job whose form needs an answer the store lacks must surface as a review item.** It must not
silently blank the field, and must not guess. The machinery exists and the feed must route into it
rather than around it:

- `processRunJob`'s **completeness gate** (`services/applyAutomation.js:2839`) re-discovers all
  frames and holds if any required non-file field is still empty.
- The **low-confidence gate** (`:1497`, `:1587`) refuses to type a value policy won't stand behind
  — `low_confidence_answers`, `low_confidence_optional`.
- The hold carries `open_questions_json` (`routes/apply.js:961`), and `publicRunJob` exposes
  `missingRequired` (`:1349`, and again on the review row at `:1540`) — named on the row precisely
  because *"a hold reading 'Required fields were left empty' that does not say WHICH is a hold the
  candidate cannot act on."*
- `GET /api/apply/questions` → `POST /api/apply/answers` is the resolution path. Its own comment
  (`:2772`) is the rule this section restates: *"answering questions unblocks the job, it does not
  authorise the submission."*

**Answering a question on mobile is fine** — it is typed, deliberate input into the answer store,
not a gesture. It is `POST /api/apply/answers`, which re-queues via `startRun` and therefore
re-enters approval. Typing is consent; swiping is not.

**One consequence to accept:** the feed cannot promise a swipe-right will complete. Some fraction
will land in "needs you" with a question. That is correct behaviour and the card should not pretend
otherwise — which is a further argument against putting an "eligible ✓" badge on cards.

### 2.5 `held_gate` jobs queued from a phone

**They cannot be resolved there (Gate B).** Under Option A they are also *nearly* unreachable —
`gated`/`account` tier count is **0** today — but `held_gate` is assigned by
`detectGate()` **at run time**, not from the tier. A `direct`-tier Greenhouse posting that happens
to put up a login wall or a CAPTCHA still lands `held_gate`. **So this state is reachable from the
feed regardless of tier filtering, and must be designed.**

The two options, and my recommendation:

- **Exclude from the feed** — impossible in the strong sense. You cannot pre-filter a status that
  is discovered mid-run. Tier filtering reduces the rate; it cannot eliminate it.
- **Queue with "finish on desktop"** — **recommended, because it is the only honest option.**

Design:

1. The job is queued and previewed like any other. It becomes `held_gate` when `detectGate` fires.
2. It appears in **Needs you**, sectioned there already by `NEEDS_YOU_STATUSES`
   (`applyObstacles.js:191`), with `attemptStatusChip('held_gate')` → **"Sign in"**.
3. On mobile the card reads: **"Needs a sign-in on your computer."** Grouped by portal
   (§2.3) so the desktop trip clears several at once. `oldestAt` is already on the group, so it can
   say how long it has waited.
4. **No handoff control is offered on mobile.** Not disabled-with-a-tooltip — absent. A greyed
   button invites a tap and teaches the user the product is broken; an honest sentence does not.
5. Optional, and worth it: a "remind me on desktop" that surfaces the pending portal groups the
   next time the desktop panel loads. This is the correct place to spend effort — the phone's job
   is to *not lose* the work, not to finish it.
6. Packets expire (`PACKET_STALE_MS`, `packetFreshness`). A `held_gate` job queued from a phone and
   never taken to a desktop **must age out visibly**, not sit forever looking actionable. `stale` is
   already computed and served.

### 2.6 Rate and volume

**Thirty applications swiped in five minutes is thirty real applications.** The existing caps were
sized for a UI where selecting 25 jobs is slow, and as Finding 4 shows they do not bind the
expensive part at all. Inheriting them would be inheriting a number nobody chose for this surface.

Existing, for reference: `APPLY_DAILY_CAP = 25` (submissions/24h, `auto` only),
`APPLY_MAX_ACTIVE_RUNS_PER_USER = 1`, max **25 jobs per run**, `APPLY_WORKER_LIMIT = 2`.

**Recommendation — a feed-specific ceiling, separate from the submission cap:**

| Limit | Value | Reasoning |
|---|---|---|
| **`FEED_DAILY_QUEUE_CAP`** | **15 / 24h** | The binding limit, and it counts **queues (generations)**, not submissions — the gap Finding 4 identified. Below `APPLY_DAILY_CAP` (25) on purpose: the feed is the cheapest way to spend money in the product, so it gets the tighter budget. 15 tailored applications a day is already more than a careful human sends. |
| **`FEED_BURST`** | **5 per 10 min** | Rate, not just volume. Caps the accidental-swipe-streak failure mode, which volume alone does not. |
| Batch size | **5 per run** | Not 25. Smaller runs reach the review surface sooner, so the user sees what queueing produced before spending the rest of the budget. |
| Concurrency | inherit `1` | Already correct; serialises browser load. |

**Behaviour at the ceiling: the feed stops dealing cards and says why.** It must not keep accepting
swipes into a queue that will 429 — a swipe that silently does nothing is worse than no swipe. Show
remaining budget only *near* the limit; an always-visible counter turns the cap into a target.

**These are product decisions and the owner's to set.** They are named as configurable constants
in the `envInt` style the file already uses, deliberately: `routes/apply.js:161` — *"every limit
here is configurable and every rejection is explicit."* Note the `envInt` gotcha — it accepts only
`n > 0`, so `0` falls back to the default rather than meaning "block everything".

---

## 3. WHAT MUST BE TRUE BEFORE ANY OF THIS IS BUILT

Ordered. The first three are the preconditions; the next three are audit findings that are upstream
of the feed and would be bugs in the feed if left unfixed.

1. **Gate A — full-auto validated.** 10 semi runs per ATS across 10 distinct jobs each. Currently
   at one `failed` row, total. *Blocks enablement, not construction.*
2. **Gate B — accept that `held_gate` is desktop-only.** Designed for in §2.5. *Not fixable.*
3. ~~**Gate C — `docs/MOBILE_STATE.md` written.**~~ **DONE**, and it raises a bigger gate: there is
   **no mobile client at all**, and never has been. A swipe feed presupposes one. Platform choice is
   unmade, and wrapping the desktop-shaped web UI is likely not viable. See `docs/MOBILE_STATE.md`.
4. ~~**Finding 4 — cap generations, not just submissions.**~~ **FIXED** — `APPLY_DAILY_QUEUE_CAP` +
   `queuedLast24h` in `startRun`, and `checkLimit` on the apply generation path. One residual item
   (users with no `user_limits` row are unlimited) is left as an owner decision.
5. **Finding 5 — server-side exclusion of already-applied and in-flight jobs, driven by a fact the
   pipeline writes.** Today the auto pipeline never sets `user_jobs.applied`, and the board only
   annotates. *"The feed must never show it again" is currently unimplementable.*
6. **Finding 2a — derive the ATS badge from `detectPlatformFromUrl(applyUrl)`, and fix or retire
   `mapJobRow`'s `sourcePlatform`,** which reads a camelCase key that never matches the
   `source_platform` column and silently returns `source` instead.

**And the constraint that outranks all six: a swipe queues, it does not submit.**

---

## 4. OWNER DECISIONS THIS DOCUMENT DOES NOT MAKE

1. **Finding 3 — tier gating.** Option A (`direct` only, hides 1 of 1261) vs Option B (all tiers
   with "finish on desktop", 0 rows to test against). Recommended: A now, B's state built and left
   unreachable.
2. **§2.6 — the numbers.** 15/24h, 5/10min, batch 5. Deliberate rather than inherited, but they are
   the owner's to set.
3. **Whether the feed is worth building before Gate A is met at all.** The honest framing: this
   design makes queueing dramatically faster for a pipeline with one recorded run, and that run
   failed.
