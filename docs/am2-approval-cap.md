# AM2 — Task Q: the cap moved, and now something follows it

**Date:** 2026-09-05 · **Suite:** 2245 passing, 0 failing · **Contract:** v1.1.0 → **v1.1.1** (additive)

---

## The hole

AL2 deferred generation from queue time to approval time. Correct change. It left the cost outside
every counter.

```
QUEUE   → CASE D  "Nothing here calls a model"        $0     bounded by APPLY_DAILY_QUEUE_CAP (40)
APPROVE → CASE C  generateResumeForApply
                + generateCoverLetterForApply         ~$0.04  bounded by nothing
```

`APPLY_DAILY_QUEUE_CAP` was written as a spend cap and said so in its own comment — *"at two model
calls per queued job (resume + cover letter), 40 is already ~80 calls a day"*. That was true when it
was written. It became false without anything editing it.

Meanwhile `queuedLast24h` **excludes** `approval_mode='approved'`, deliberately and correctly: when
an approval reused the preview's artifact, counting it would have charged the user twice for one
application. After the deferral there *is* no artifact at approval time, so the same exclusion means
**the only action that spends money is the only one no cap counts.**

Nothing broke. The cost walked out from under the guard.

---

## 1 · A cap on approvals

`APPLY_DAILY_APPROVAL_CAP`, default **30**, enforced in `startRun` on the `approval_mode='approved'`
branch — the branch the queue cap deliberately skips.

**In `startRun`, not in `POST /api/apply/approve`**, because `/approve` is not the only caller: the
answers/retry path reaches `startRun` with `approvalMode` too. A cap installed at one of two doors
is a cap on one of two doors. `/approve` already restores its approvals on any non-202, so a refusal
here loses nothing — asserted, not assumed.

**It counts run-jobs, not requests.** One `POST /api/apply/approve` with eight `runJobIds` starts
one run of eight jobs and generates eight resumes. Counting requests would bound the wrong thing by
a factor of eight — a cap that reports a limit and enforces nothing.

`approvedLast24h` is the exact complement of `queuedLast24h`'s exclusion, so between them the two
counters partition every run-job and no spending action can fall through the gap that opened in
AL2. Both window on `created_at` regardless of outcome: a job that generated and then held cost
exactly as much as one that submitted.

```
429 approval_cap_exceeded
{ approvedLast24h: 3, requested: 1, limit: 3, remaining: 0,
  message: "Daily approval limit reached: 3 of 3 approved in the last 24h, 1 requested.
            Approving generates a tailored resume and cover letter for each application, and this
            limit bounds that cost. Previewing more applications is unaffected." }
```

The message names the cost it protects. The queue cap's old message explained itself with a cost
that was no longer incurred; this one must not acquire the opposite problem.

---

## 2 · The queue cap: re-scoped, kept, and told the truth

**Kept.** Queueing is free of *model* spend, not free. Every preview opens a real browser, navigates
a real employer's form and fills it — CPU, wall time, disk, and traffic to a third party under the
candidate's name. A ceiling on how many of those one user starts per day is worth having on its own
terms.

**The number is unchanged at 40.** Task D's requirement 4 said not to change it unilaterally, and
this task does not: what changes is its stated meaning. It is a **session/rate limit**, not a
budget, and its block comment now says so and says why the old rationale went stale.

The user-facing message was already corrected by AL2 and is pinned so it stays that way: `assert
.doesNotMatch(body.message, /generat/i)` against the live 429, not against the source string.

**It never blocks the free action for the wrong reason.** Verified: with the *spend* budget fully
exhausted, queueing still returns 202.

---

## 3 · Surfaceable, on the screen where it is spent

`ApprovalCap { limit, approvedLast24h, remaining }` — `services/api/mobileSchemas.js`, regenerated
into `contract/mobile-api.v1.json` and `.d.ts`. Additive, so **v1.1.0 → v1.1.1**. `QueueCap`'s
description is corrected in the same place: it had been documented as "the GENERATION cost budget".

It rides on:

- **every** `RunQueuedResponse`, not only on approvals — a user planning a queueing session needs to
  know how many of those previews they will be able to act on. Counted *after* this run's rows, like
  `queueCap`, because the client renders "what is left now".
- **`GET /api/apply/pending`** — the approval queue is the screen where approving happens.

### It reaches pixels

`test/approvalCap.test.js` proves the server sends it and the JSX contains the branches. That is not
the same claim: a source-string test passes over a card that never renders, a `detail` prop the
component ignores, and a context value that never arrives — which is exactly *"a cap that fails as a
silent drop"*.

`scripts/am2ApprovalCapUi.mjs` drives the real `App`, the real `AutoApplyContext` and the real
`AutoApplyPanel` in Chrome, four times, and reads the rendered text back.

```
── HEADROOM  (3 waiting, 27 of 30 left)
PASS  the approval card renders
PASS  states the remaining budget
PASS  does NOT warn when the whole queue is approvable

── SHORTFALL  (6 waiting, 2 of 30 left)
PASS  warns that fewer are approvable than are waiting

── EXHAUSTED  (4 waiting, 0 of 30 left)
PASS  says the budget is spent
PASS  promises the queue is kept

── NO-CAP  (server sends no cap)
PASS  no invented limit
PASS  the original sentence survives

✓ every check passed
```

Rendered, in the shortfall state:

> **6 applications waiting for your approval**
> Read one before you approve it — approving submits it to the employer and cannot be undone.
> **2 of 30 approvals left today, fewer than the 6 waiting.**

Three sentences, and the middle state is the one that matters: a user with 6 pending and 2
approvals needs that **before** selecting all six, not from a 429 after. At zero it says the queue
**stays here until the limit resets** — without that, "you cannot approve" reads as "these are
lost", which is the shape of a silent drop.

The `no-cap` scenario is the compatibility state: an older server omits the key, and the panel must
fall back to its original sentence rather than rendering "0 of undefined approvals left". A client
that invents a limit it was not told is worse than one that says nothing.

---

## 4 · The three caps stay reachable

`queue ≥ approval ≥ submission` is the pipeline's own order: a submission needs an approval, an
approval needs a preview.

| cap | default | bounds | changed by this task |
|---|---|---|---|
| `APPLY_DAILY_QUEUE_CAP` | 40 | previews opened | meaning only — number unchanged |
| `APPLY_DAILY_APPROVAL_CAP` | **30** | **model spend** | **new** |
| `APPLY_DAILY_CAP` | 25 | submissions | **unaffected** |

30 sits above 25 for the identical reason 40 sat above 25 — an approval cap at or below the
submission cap would make the submission cap unreachable. The 5 of headroom is for approvals that
do not end in a submission: a hold, a form that stopped resolving, a retry through the answers path.

All three are env-overridable, so the ordering is a property of the *defaults* and not of any given
deployment. `assertCapOrdering()` runs when the routes are wired and names any broken relation. It
**warns rather than throws**: refusing to boot over a cap ordering would take the product down for a
misconfiguration that degrades one flow, and an operator who wants a tight queue for a day should be
able to have one. But it must be said, once, loudly.

```
[applyRoutes] ⛔ CAP ORDERING: APPLY_DAILY_QUEUE_CAP (1) is below APPLY_DAILY_APPROVAL_CAP (30)
              — an approval needs a queued preview first, so the approval cap is unreachable.
```

Both directions are tested: a misordered configuration produces exactly one warning naming the
broken relation, and a correctly ordered one produces none. A warning that fires when nothing is
wrong is a warning people stop reading.

---

## Verification

**14 tests** in `test/approvalCap.test.js`, every one through a real express listener, real SQLite
rows and the real route module — not source strings, except the four that are explicitly about
source structure.

| | |
|---|---|
| the cap binds | 3 spent of 3 → the 4th is 429 with `remaining: 0` |
| a refusal loses nothing | the row returns to `held_review` / `awaiting_approval` and is still on `/pending` |
| batching does not evade it | 6 ids in one request exceeds a cap of 5 |
| under the cap | 202, unchanged |
| the free action stays free | spend exhausted, queueing still 202 |
| the queue cap still bounds previews | 429, and its message says nothing about generation |
| all three surface | `limit` + `remaining` + a used-count on each |
| `/pending` carries the budget | 3 spent of 4, 3 waiting → `remaining: 1` |
| the client renders it | four states, real Chrome, `am2ApprovalCapUi.mjs` |
| defaults are ordered | read from source, so a change has to come past it |
| a misorder is reported | injected, exactly one warning |
| a correct order is silent | injected |
| the counters partition | `!= 'approved'` and `= 'approved'`, both on `created_at` |
| enforced in `startRun` | and before the run row is written |

### Two things this cost, worth recording

**A prose mention of `CASE D:` broke three unrelated tests.** `test/generationDeferral.test.js`
slices the deferred branch with `at(applyRoute, "CASE D:")`. A comment I added 900 lines earlier
containing that exact string moved the anchor to it, silently widening the slice to most of
`routes/apply.js` — and three `doesNotMatch` assertions then failed against code they were never
about. The comment is reworded and says why. **Third time this repo has produced this shape**; the
lesson `test-support/sourceAnchors.js` was written for is that an anchor is API.

**The harness could not start vite for 60 seconds.** Its ANSI stripper removed `[36m` and left the
ESC byte, which lands between `localhost:` and the port because vite bolds the port — so
`/localhost:5203/` never matched, against a banner that visibly contained it. Copied verbatim from
`abPanelUi.mjs`, where the same latent bug has not fired.

---

## Files

| | |
|---|---|
| `routes/apply.js` | `APPLY_DAILY_APPROVAL_CAP`, `approvedLast24h`, `assertCapOrdering`, the 429, three caps on the payload, `approvalCap` on `/pending` |
| `services/api/mobileSchemas.js` | `ApprovalCap`; `QueueCap`'s description corrected |
| `contract/*` | regenerated, v1.1.1 |
| `client/src/contexts/AutoApplyContext.jsx` | `approvalCap`, null unless the server sent one |
| `client/src/panels/AutoApplyPanel.jsx` | four-branch `detail` on the approval card |
| `test/approvalCap.test.js` | 14 tests |
| `scripts/am2ApprovalCapUi.mjs` | four states in real Chrome |
