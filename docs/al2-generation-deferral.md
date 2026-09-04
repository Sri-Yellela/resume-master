# AL2 — Generation deferred to approval, and a free band at the swipe

Run 2026-09-04. Desktop suite **2090 → 2111 passing, 0 failing** (+21).
Migration high-water **096 → 097**. New harness `al2GenerationDeferral` — **19 checks, all passing**
against a real browser and a real (fake) ATS.

---

## What changed

Generation was ~$0.04 on Sonnet and fired when a job was **queued**. A swipe is about a second, so
five idle minutes of swiping was ~60 jobs and **~$2.40 spent by a gesture that decided nothing** —
on applications the user had not seen and had not agreed to send.

It now fires on **approval**. Queueing is free.

**Only the preview path defers.** The other two keep generating exactly when they did, and the
reasons are not symmetric:

| path | defers? | why |
|---|---|---|
| `auto` + `approval_mode: required` (the default) | **yes** | a human will see it before it is sent, so the spend can wait for them |
| `semi` | **no** | a live human is standing at an open browser; a resume that does not exist cannot be uploaded, and the hold it produces (`manual_review`) is not approvable anyway |
| `approval_mode: auto` / `approved` | **no** | nobody approves it later — `auto` opted out of review, and `approved` *is* the approval |

The **cover letter is deferred too**. It is a model call as well, and deferring only the resume
would have left most of the cost exactly where it was.

## The free half: a user cannot approve blind

`scoreAtsLocally` runs with no model call, no artifact and no network, so the approval screen shows
a real fit **band** computed against the **base** resume, plus the matched/missing terms behind it.

**It is a more honest number than the one it replaces.** The old score was computed against the
*generated* resume — so the preview flattered exactly the thing it was asking the user to pay for.
A base-resume band is a **floor**: tailoring at approval can only raise it.

Null is preserved as null. The scorer *declines* (score null, `decline_reasons` set) when there is
too little signal to judge; that surfaces as `not_enough_signal`, never as a zero.

---

## Two defects found, both of which would have made the feature useless

Neither was reachable by any unit test. Both were found by real runs.

### 1 · `resumePathPromise` would have made every preview a dead end

`autoApply` treats `preview` as **unattended**, and holds on:

```js
isUnattended && resumePathPromise && !effectiveResumePath   // -> 'ats_held' / 'resume_unavailable'
```

`Promise.resolve(null)` is the obvious way to say "no resume yet" — and it turns **every** deferred
preview into a hold that the approve endpoint cannot release, because only `awaiting_approval` rows
are approvable. Omitting the option entirely is what tells `autoApply` there was never a resume
coming, which is the truth. Caught while reading the gate; pinned by a test that scans the branch's
**code** (its own comment names the trap, so a raw scan matches its own warning).

### 2 · The completeness gate held every deferred preview as `incomplete_form`

**This one shipped past every unit test and was caught by the new harness on its first run.**

A1 finding N2 made required FILE inputs count towards completeness — a form with no resume used to
pass the gate and then be silently unsubmittable. Correct in general, and wrong here: a deferred
preview reaches the form with no resume *on purpose*. So the row parked as `incomplete_form`
instead of `awaiting_approval`, and — again — only `awaiting_approval` is approvable.

Every deferred preview was unapprovable. **The entire queue-then-approve flow dead-ended, while the
run history blamed the employer's form.**

Fixed with an explicit `documentsDeferred` option, and the scoping matters:

- **FILE inputs only.** Every other required field is still the candidate's to answer and still
  holds the run.
- **Opt-in, default `false`.** A default-on exemption would silently restore the pre-A1 defect.
- **Excluded from the GATE, not from the record.** `blanks` is still built from the unfiltered
  field list, so the preview still shows what was empty.
- **Exactly one call site may set it**, asserted, and it must be inside the deferred branch.

> The pattern is worth naming: both defects were a gate doing its job correctly against a state it
> had never been told about. Neither was a bug in the gate.

---

## A third, caught by a guard that was silently vacuous

Adding `domain_profiles` to `test/harnessSchemaCoverage.test.js` produced **no test at all**. Its
extractor discovers columns by finding `FROM <table> <alias>` and sweeping for `alias.column`; my
query was unaliased, so `requiredColumns` came back empty, the loop `continue`d, and the table went
unchecked while reporting green.

Two changes, because the guard's failure mode here was silence:

1. The query is **aliased** (`FROM domain_profiles dp`) so the extractor can see it.
2. A table yielding **no** required columns is now a **failure**, not a `continue` — plus a named
   anchor test (`routes/apply.js really does read the column that broke a9ApprovalFlow`) mirroring
   the existing `hidden_at` one.

The guard immediately earned it back: it flagged seven harness fixtures missing
`generate_at_queue`, and then flagged **this task's own new harness** for two unrelated columns.

`a9ApprovalFlow` had already failed loudly with `no such column: generate_at_queue` at check 2 of
15 — the third time in this repo's history that `npm test` was green over a real pipeline defect.

---

## The toggle

`domain_profiles.generate_at_queue`, **default 0**, beside `include_summary` (092) because it is the
same kind of thing: a per-profile choice about what a run does. Coerced the same way and in the same
direction — anything that is not an explicit affirmative lands on OFF, which is the cheap side.

The UI copy states the **cost**, not the schedule:

> On. A tailored resume is written as soon as a job is queued — about $0.04 each, spent whether or
> not you go on to approve it.

## The approval row, and the AJ2 shape avoided

`AutoApplyPanel` rendered the band from `p.resume.atsScore`. With generation deferred that is null
on **every** waiting row, so the panel would have printed "No signal" on 100% of them — the exact
shape AJ2 found when `Job.matchScore` was always null and a correct client rendered "Not enough
signal" for every job on the board. The row now branches on `generationDeferred`, reads the base
band, and **says which resume the band is of**. It also explains the absent Resume PDF button:
"not generated yet" and "generation failed" are indistinguishable from a missing button, and they
need opposite responses.

---

## Requirement 4 — the queue cap, reported not changed

`APPLY_DAILY_QUEUE_CAP` is **still 40**. Changing it is the owner's call.

But what it protects has changed, and that is the finding. It was sized for generate-at-queue, where
40 queued applications meant 40 generations and ~$1.60. **With generation deferred, queueing 40 jobs
costs nothing** — so the cap now bounds how many previews may be opened (a browser-time concern),
and the meaningful *cost* limit is the number of **approvals**, which nothing bounds.

Its user-facing message did have to change, because it asserted a reason that is now false:

- was: *"Each queued application generates a resume, so this limit protects your usage."*
- now: *"This limit bounds how many applications can be opened and previewed per day."*

A limit that explains itself with a false reason is worse than a bare number. Both caps stay in the
structured payload with `limit` and `remaining`, asserted (requirement 5).

**Open for the owner:** whether to add an approvals cap, and whether 40 previews/day is still the
right number now that it is not a spend gate.

---

## VERIFY — the counts the task asked for

`scripts/al2GenerationDeferral.mjs`, real browser, real fake-ATS, generator replaced by a
**counting stub** because the claim is a count:

```
=== 1. queueing generates NOTHING ===
PASS  ZERO generations at queue time  — count=0
PASS  nothing reached the ATS
PASS  the job is parked awaiting approval  — status=held_review reason=awaiting_approval
PASS  no resume artifact exists yet  — id=null
PASS  the FREE base score was recorded instead  — score=31
PASS  the run SAYS it deferred rather than silently skipping

=== 2. the approval screen is not blind ===
PASS  it carries the base band  — band=moderate
PASS  the terms behind the band are shown  — missing=["terraform","go"]

=== 3. approving generates exactly once ===
PASS  EXACTLY ONE generation, and it happened at APPROVAL  — count=1
PASS  exactly one submission reached the ATS

=== 4. generate_at_queue=1 restores generate-at-queue ===
PASS  the toggle ON generates AT QUEUE  — count=1
```

`a9ApprovalFlow` re-run: **ALL CHECKS PASSED** (17), so the ordinary approval path is unregressed.

**What this does NOT prove:** the base-resume *scorer* itself. `scoreBaseResumeForApply` lives in
`server.js` (it needs the profile, signal and term-weight loaders hanging off the app), so the
harness injects a stub with the real return shape. The harness proves the pipeline **calls** it,
**persists** what it returns and **surfaces** it. The scorer's arithmetic is covered by
`test/localAtsScorer.test.js` and the band mapping by `test/atsBandSurfaces.test.js`; the wiring in
`server.js` is unexercised by any automated run and is the one part of this task verified only by
reading.
