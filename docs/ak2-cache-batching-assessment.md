# AK2 task 5 (non-cost half) — cache batching, assessed before it is built

Assessed 2026-08-31. Test baseline re-derived first: **2035 passing, 0 failing**.

**Requirement 2 is not met here and cannot be.** It asks for measured before/after cost from a real
run. The Anthropic key has been out of credit since **2026-08-25** — recorded in the repo's own
data, not from memory: nine `ai1_summary_verify` rows carry
`"Your credit balance is too low to access the Anthropic API"`. Everything below is measured from
**historical `usage_events`** or reconciled arithmetic, and each claim says which.

Nothing is adopted. Requirement 3 says not to adopt the Batch API unilaterally, and requirements 1
and 4 turn out to have prerequisites worth landing first.

---

## Requirement 5 — pricing, verified live (and the cached table was wrong again)

Fetched from `platform.claude.com/docs/en/about-claude/pricing` today.

| | live docs | `shared/anthropicModels.js` | |
|---|---|---|---|
| Sonnet 5 input | $2 / MTok | `0.000002` | ✅ |
| Sonnet 5 output | $10 / MTok | `0.00001` | ✅ |
| Sonnet 5 cache read | $0.20 / MTok | `0.0000002` | ✅ |
| Sonnet 5 5-min cache write | $2.50 / MTok | `0.0000025` | ✅ |
| Sonnet 5 **1-hour cache write** | **$4 / MTok** | **absent** | ⚠️ see requirement 4 |
| Haiku 4.5 | $1 / $5, read $0.10, 5m write $1.25 | matches | ✅ |
| Batch API | **50%** off input *and* output | n/a | — |

**The repo is right and my own cached reference was wrong** — which is the exact trap requirement 5
was written for, sprung again on the last day it could be. A cached model table dated 2026-06-24
still says Sonnet 5 is *"$3.00 ($2.00 intro through 2026-08-31)"*. Today is 2026-08-31. Had I
trusted it I would have reported a 50% price rise landing tomorrow. The live page settles it:

> The $2/$10 per million input/output token pricing for Claude Sonnet 5, announced at launch as
> introductory pricing through August 31, 2026, **is now the standard price**. The previously
> scheduled increase to $3/$15 per million input/output tokens on September 1, 2026 **will not
> occur**.

`shared/anthropicModels.js` already records exactly this. No pricing change is needed.

Also confirmed live, and load-bearing for requirement 1: caching multipliers are **1.25x for a
5-minute write, 2x for a 1-hour write, 0.1x for a read**, and *"these multipliers stack with other
pricing modifiers, including the Batch API discount"*.

---

## Requirement 1 — the window, and what the prefix is actually doing

**The window is 5 minutes.** `services/promptAssembler.js` sets `cache_control: {type: "ephemeral"}`
with no `ttl`, which is the default. A 1-hour window is available at 2x write instead of 1.25x.

**The prompt is correctly structured** — AK1's read is right. Three stable system blocks (global
layer, domain module, mode overlay), each with a breakpoint, three of the four allowed; the volatile
runtime inputs go in the user message, after the last breakpoint. Flag resolution is applied to a
copy, so `SUMMARY` produces two byte-stable variants rather than one drifting string.

### The cost model reconciles exactly

Against the recorded generation row (`resume_generate`, prefix 6704, input 1795, output 2125):

| component | tokens × rate | cost | share |
|---|---|---|---|
| output | 2125 × $10/MTok | $0.021250 | **51.1%** |
| cache write | 6704 × $2.50/MTok | $0.016760 | **40.3%** |
| input | 1795 × $2/MTok | $0.003590 | **8.6%** |
| | | **$0.041600** | recorded: **$0.041600** |

AK1's split is independently reproduced. A shorter prompt really is nearly worthless: the whole
input line is 8.6%.

### The finding AK1 stopped one step short of

The 6704-token prefix is written at **1.25x** and read at **0.1x**. It is currently written every
time and read never — so the caching is not merely unhelpful, it is a **25% surcharge on the prefix,
paid on every generation, buying nothing**:

| | per generation | vs today |
|---|---|---|
| today (write the prefix, never read it) | $0.041600 | — |
| **caching switched OFF entirely** | **$0.038248** | **−8.1%** |
| batched, N=10 in one window | $0.027723 | −33.4% |
| batched, N→∞ (the asymptote) | $0.026181 | **−37.1%** |
| asymptote + Batch API 50% | $0.013090 | **−68.5%** |

AK1's −37% and −68% are exactly right, and are the **asymptotic** case. At a realistic ten
generations in one five-minute window the saving is **−33.4%**; at two, **−18.5%**. Worth stating,
because "−37%" reads like a per-call number and it is a limit.

**Removing the breakpoints is an unconditional −8.1% available today**, with no batching, no new
machinery, and no behaviour change. If batching slips, that is the fallback — and it is strictly
better than the status quo for any workload that does not cluster.

### But "written and never read" is about arrival rate, not structure

`resume_generate` has run **once, ever**, in 1367 recorded events. A single isolated call *cannot*
get a cache read; there is no second call to read it. The prefix is not structurally unreadable —
elsewhere in the same account the same mechanism works well:

| purpose | calls | cache written | cache read | read/write |
|---|---|---|---|---|
| `ag2_claims_verify` | 33 | 19,136 | 138,736 | **7.25x** |
| `ag3_claim_sample` | 18 | 9,632 | 76,864 | **7.98x** |
| `af2_claim_verify` | 3 | 14,352 | 0 | 0 |
| `resume_generate` | **1** | 6,704 | 0 | 0 |

Those are harness runs firing many calls back to back — i.e. they are *already* accidentally doing
what batching would do deliberately, and getting 7–8 reads per write. That is the real evidence the
thesis works. It also means the whole −37% projection rests on **one** observed generation, and the
first real batch should be treated as a measurement, not a confirmation.

---

## The thing this task is pointed at the wrong target

Ranked by actual recorded spend, all 1367 events:

| purpose | model | calls | cost | share | caching |
|---|---|---|---|---|---|
| **`enrich_job`** | Haiku 4.5 | **1302** | **$3.3244** | **60.2%** | **none at all** |
| `ag2_claims_verify` | Sonnet 5 | 33 | $1.3007 | 23.6% | working (7.25x) |
| `ag3_claim_sample` | Sonnet 5 | 18 | $0.7028 | 12.7% | working (7.98x) |
| `af2_claim_verify` | Sonnet 5 | 3 | $0.1449 | 2.6% | written, unread |
| `resume_generate` | Sonnet 5 | 1 | $0.0416 | 0.8% | written, unread |
| `import_job` | Haiku 4.5 | 1 | $0.0040 | 0.1% | none |
| | | | **$5.5184** | | |

Task 5 optimises the row that has run **once** and is 0.8% of spend. **`enrich_job` is 60%** — one
call per job across the whole board — and uses no prompt caching whatsoever.

**And it cannot.** `buildPrompt` in `services/jobs/enrichJob.js` interleaves stable and volatile
content in a single user message, with the job text in the *middle* and the JSON schema *after* it.
Caching is a prefix match, so only the 61-token preamble is even a candidate. Measured:

```
preamble (before the volatile job text)   245 chars   ~61 tokens
schema   (after  the volatile job text)  1141 chars  ~285 tokens
total static content if reordered        1386 chars  ~347 tokens
minimum cacheable prefix                             ~1024 tokens
```

At ~347 tokens of static content, **`enrich_job` is below the minimum cacheable prefix even if
perfectly restructured** — the reorder would be work with no payoff, and shorter prefixes silently
don't cache rather than erroring. Its saving has to come from somewhere else, and there is an
obvious somewhere: it is a background pass attributed to `SYSTEM_USER_ID` with no human anywhere
near it. **The Batch API's 50% applies cleanly and costs nothing in UX.**

---

## Requirement 3 — can the pipeline tolerate async? Not where generation runs today

Read `routes/apply.js` by branch:

- **CASE B — semi, no artifact:** *"Generation and browser run in parallel; browser starts
  immediately in semi mode so the user can review the pre-filled form while generation completes in
  the background."*
- **CASE C — auto, no artifact:** *"Browser and generation run in parallel; browser awaits
  `resumePathPromise` at the upload step."*

In both, a **live Puppeteer browser session is already open and blocks on the resume at the upload
step**. The Batch API is asynchronous with a 24-hour completion SLA. Holding a browser open — in
semi, with a human watching it — against that is not viable. **The Batch API cannot be adopted for
generation on the apply path as it stands.**

But the constraint is where generation sits, not what generation is. **CASE A** already exists: *"a
current artifact — ATS gate, then PDF convert and apply"*, chosen by `artifactCurrency`, with no
model call at all. Batching wins by making CASE A the normal path — the artifact is ready before the
run starts, so nothing blocks.

That is the same move **task 7** is already committed to (generation deferred from queue to
approval). These two tasks are one design, and task 5 should not build a batching path that task 7
then has to move. Recommend sequencing 5 behind 7, or landing them together.

**Viable for the Batch API today, with no UX change at all:** `enrich_job` (no user, background,
60% of spend) and `import_job`.

---

## Requirement 4 — batching *would* create an untracked path, and the guard would stay green

`test/modelCallGuard.test.js` is the tracking guarantee. It has three tests, and the load-bearing
one scans every source file for `/\.messages\.create\s*\(/` outside the wrapper. Tested against the
call shapes batching would introduce:

```
CAUGHT   client.messages.create(
CAUGHT   client.beta.messages.create(
MISSED   client.messages.batches.create(
MISSED   anthropic.messages.batches.results(
```

The Batch API is `messages.batches.create` — `.messages.create` is not a substring of it, so **the
guard does not fire**. Adding batching would create exactly the untracked-spend defect that guard
exists to prevent, and the suite would stay green while it happened. That is Shape 5 waiting to
happen: a test that appears to cover a thing it structurally cannot see.

**Two prerequisites, both cheap, both before any batching code:**

1. **Extend the guard regex** to `\.messages\.(batches\.)?(create|results)\s*\(` (and keep
   `beta\.`), so a batch call site is an offender until it is routed through the wrapper. `callModel`
   is built around one request and one response and will need a batch-shaped sibling that records
   one `usage_events` row per `custom_id` — batch results carry per-request `usage` and **arrive in
   any order**, so rows must be keyed by `custom_id`, never by position.
2. **Add the 1-hour cache-write price.** `ANTHROPIC_PRICING` has `cache_write` only, which is the
   5-minute 1.25x rate. Cache-window batching is the exact circumstance that motivates a 1-hour TTL
   (2x write, $4/MTok on Sonnet 5). If a 1h TTL ships against the current table, `calculateCost`
   prices those writes at $2.50 instead of $4.00 and **under-reports by 37.5% on every batched
   write** — silently, because the model ID still resolves and nothing warns. `usage_events` would
   stop reconciling in precisely the task whose requirement 4 is that it must not.

One good note: the tracker is honest under failure. The nine credit-exhausted calls are recorded
with `success: 0`, the provider's error text, and `cost_usd: 0` — failures are logged, not dropped.

---

## Recommendation

1. **Take the −8.1% now.** Remove the cache breakpoints, or make them conditional on a batch
   actually being in flight. Today they are a 25% surcharge on the prefix that is never read back.
2. **Land the two requirement-4 prerequisites before any batching code** — guard regex, 1h price.
   Both are small; both are unfixable-in-hindsight if batching ships first, because the evidence they
   protect is the cost data itself.
3. **Batch `enrich_job` through the Batch API.** 60% of recorded spend, no human in the loop, no UX
   consequence. This is the largest available saving and it is not what the task was aimed at.
4. **Sequence generation batching behind task 7**, so it is built against approval-time generation
   and the CASE A artifact path rather than against a branch that is about to move.
5. **Treat the first real batch as a measurement.** The −37% rests on one generation row.
