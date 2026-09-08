# AM3 / task A2 — the provider verdict, and the two things that stood in front of it

**Date:** 2026-09-07
**Task:** A2 — is the free tier good enough to replace Haiku for `enrich_job`?
**Spend:** **$0.2741** on the Anthropic arm across all runs (106 Haiku calls). Groq: **$0.00** (118 calls).
**Suite:** 2246 passing / 0 failing (2245 baseline + one new test pinned here).

---

## Verdict

**KEEP ENRICHMENT ON HAIKU.** Task A stands as infrastructure for later, not a live switch.

Three independent findings, each sufficient on its own:

1. **Quality — `skillsHard` Jaccard 30.5%.** The column A2 named as the deciding one. Two models
   shown the same posting with the same prompt pick overlapping skill sets less than a third of the
   time. Every column that actually carries a value agrees 57–84%; the columns reading 100% agree
   only because **neither model extracted anything on any of the 49 rows**. §4.
2. **The model task A pinned no longer exists.** `llama-3.1-8b-instant` returns
   `404 model_not_found`, and Groq's live catalogue lists **no Llama model at all**. Task A's +33
   tests could not catch it because all of them use fetch stubs. §1.
3. **The free tier cannot do a full pass.** The binding limit is **8000 tokens/minute**, not the
   30 req/min the provider spec paces against — about **two enrichment calls a minute**. A 1291-row
   pass is ~9.7 hours and would breach the 1000-request daily cap first. §3.

And one finding that is not about this decision but is the most dangerous thing here: at the
pipeline's real `max_tokens: 500`, this model returns **HTTP 200, `success: true`, a clean
`usage_events` row, and a null extraction, 49 times out of 50** — silently. §2.

---

## 1. ⛔ The pinned model was decommissioned, and the whole test suite was blind to it

The first real call task A's routing ever served returned:

```
404  {"code":"model_not_found",
      "message":"The model `llama-3.1-8b-instant` does not exist or you do not have access to it."}
```

`GET /openai/v1/models` on the live key confirms it — the Llama family is gone entirely,
`llama-3.3-70b-versatile` with it. What Groq now serves that can do this job:

```
openai/gpt-oss-20b     131072      qwen/qwen3.6-27b   131072
openai/gpt-oss-120b    131072      qwen/qwen3.8-27b   131042
groq/compound-mini     131072      groq/compound      131072
```

**This is the lesson worth keeping.** Task A shipped with +33 tests and a green suite, and
`NEXT_WORK.md` described it as "built, guarded and tested". All of it was verified against **fetch
stubs**, and *a stub answers for any model id, including one the platform has retired*. There was no
test that could have caught this, because catching it requires a real call.

> A pinned model id is a dependency on someone else's product decision. The only thing that detects
> its removal is a request.

Re-pinned to **`openai/gpt-oss-20b`** — the smallest general-purpose chat model Groq now serves, so
the nearest live stand-in for A2's actual question. It is 20B rather than 8B, which makes the
question *easier*, and the verdict has to say so.

Changed: `shared/modelProviders.js` (`defaultModel`, `models` allowlist, `FREE_TIER_PRICING`),
`.env` (`ENRICH_MODEL`), and the model fixtures in `test/providerRouting.test.js`.

### The retired ids stay priced but are no longer selectable

Two lists, two jobs — and the incident showed why conflating them is a bug either way:

| list | job | retired id |
|---|---|---|
| `models` allowlist | decides what **may be sent** | **removed** — must be refused, loudly |
| `FREE_TIER_PRICING` | answers for what **was sent** | **kept** — must still price, silently |

6 `usage_events` rows carry `llama-3.1-8b-instant` from the 2026-09-07 attempt. Dropping its
pricing entry would make `calculateCost` warn on every historical row; keeping it selectable would
let a 404 back into the enrichment path. Pinned as a test:

```
✔ a DECOMMISSIONED model id is refused for sending yet still prices historical rows
```

---

## 2. ⛔ `max_tokens: 500` is not a neutral budget — it is a budget for a non-reasoning model

The first paired 50-row run produced a result that looks like a working comparison and is not one:

```
parsed OK: free 1/50   anthropic 50/50
failures:  free 0      anthropic 0
```

**Every Groq call succeeded. 49 of 50 were unparseable.** `outputTokens` sat at exactly **500** —
the ceiling — on nearly every row.

`openai/gpt-oss-20b` is a **reasoning model**. It returns `message.reasoning` alongside
`message.content`, and those reasoning tokens are charged against `max_tokens`. Measured directly on
a trivial prompt:

```
prompt: Return ONLY JSON: {"a":1}
completion_tokens: 117   of which reasoning_tokens: 103
```

On a ~1100-token posting the reasoning consumed the whole 500-token budget and the JSON was
truncated mid-object. Raising the ceiling fixes it completely — at `--max-tokens 2500`, free-arm
parsing goes **12/12**, with real outputs spanning **706–1433 tokens**, i.e. **2–3× what the
pipeline allows**.

⛔ **This failure mode is silent and dangerous in production.** The provider returns HTTP 200, the
transport records `success: true`, `usage_events` gets a clean row, and the extraction is `null`.
Nothing anywhere says "the answer did not fit". If enrichment had been switched to this model on the
strength of task A's green suite, it would have written 1291 clean usage rows and enriched almost
nothing — the `cacheJoboFeed` shape (`"sync complete — 0 jobs cached"`) that
`shared/modelProviders.js` already warns about in its own comments.

A `--max-tokens` flag was added to the harness so a budget failure can be told apart from a model
failure. **The default stays 500**, the value the pipeline actually uses, so the headline comparison
keeps measuring what production would do.

---

## 3. ⛔ The rate limits, which no amount of quality would fix

`PROVIDERS[GROQ].requestsPerMinute` is 30, and the header comment already notes enrichment paces at
~240 req/min — eight times over. **That is the wrong limit to be pacing against.** Read live off the
response headers mid-run:

```
x-ratelimit-limit-requests:      1000        x-ratelimit-limit-tokens:      8000
x-ratelimit-remaining-requests:   901        x-ratelimit-remaining-tokens:  7878
x-ratelimit-reset-requests:   2h22m33s       x-ratelimit-reset-tokens:       915ms
```

So requests are capped at **1000/day** and tokens at **8000/minute**. An enrichment call is
~1100 input + up to ~1400–2500 output ≈ **3600 tokens**, which means the token ceiling allows about
**two calls per minute** — not thirty. The request throttle is pacing on the wrong quantity, and it
is the reasoning tokens from §2 that make the gap this wide.

What that did to the run, visible in `usage_events.duration_ms`:

```
groq call durations, in order, from the 50-row paired run
  11.3s  12.0s  13.0s  13.3s  …  280.6s  503.7s  712.0s
```

Those long calls carry `success: 1` and no `error_text`: the transport's documented
back-off-and-retry is working exactly as designed, absorbing 429s until the token window clears. It
is correct behaviour reporting an incorrect plan.

**A 1291-row pass costs 1291 × ~3600 ≈ 4.6M tokens. At 8000/minute that is ~9.7 hours** — and it
would breach the 1000-request daily cap at row 1000 regardless. The saving at stake is ~$3.32.

⇒ Two follow-ups worth having regardless of which model is chosen: **`requestsPerMinute` should be
joined by a tokens-per-minute budget** in the provider spec, and the transport should pace on
whichever binds. A 50-row harness run took over an hour because nothing in the code knows the token
limit exists.

---

## 4. Per-column agreement — the quality question itself

Measured at `--max-tokens 2500` (not the pipeline's 500 — see §2; this is the most favourable
condition for the free model, deliberately). **49 of 50 rows usable** — row 31's free arm exhausted
its retries on a real TPM 429.

```
PER-COLUMN AGREEMENT over 49 postings          gpt-oss-20b  vs  claude-haiku-4-5

  column                  agree    disagree
  normalizedTitle          57.1%   21
  experienceLevel          53.1%   23
  workplaceType            87.8%    6
  salaryMinUsd            100.0%    0
  salaryMaxUsd            100.0%    0
  salaryPeriod             93.9%    3
  isH1bSponsor            100.0%    0
  requiresWorkAuth         98.0%    1
  isClearanceRequired     100.0%    0
  orgUnit                  59.2%   20

  skillsHard (Jaccard)     30.5%   <- feeds company_technographics AND the ATS scorer
  skillsSoft (Jaccard)     17.4%
```

### ⛔ Read the 100% rows correctly: they are agreement on ABSENCE

The harness counts two nulls as agreement, which is right — a model correctly declining on a silent
posting is the common correct case — but it means a column where nothing is ever extractable scores
100% while telling you nothing. Decomposed:

| column | agree | rows where **both** returned a value | agreement **among those** |
|---|---|---|---|
| `salaryMinUsd` | 100.0% | **0** of 49 | n/a |
| `salaryMaxUsd` | 100.0% | **0** of 49 | n/a |
| `isH1bSponsor` | 100.0% | **0** of 49 | n/a |
| `isClearanceRequired` | 100.0% | **0** of 49 | n/a |
| `requiresWorkAuth` | 98.0% | **0** of 49 | n/a |
| `salaryPeriod` | 93.9% | **0** of 49 | n/a |
| `workplaceType` | 87.8% | 32 | **84.4%** |
| `orgUnit` | 59.2% | 36 | **58.3%** |
| `normalizedTitle` | 57.1% | **49** | **57.1%** |
| `experienceLevel` | 53.1% | 29 | **72.4%** |

**Every column at or near 100% has zero rows in which either model extracted anything.** All six are
agreement that this corpus does not state salary, sponsorship or clearance — a true and useless
result. The four columns that actually carry values agree **57.1% – 84.4%**.

### The verdict on `skills_json`, which is the question A2 was written to answer

**`skillsHard` Jaccard = 30.5%.** Two models shown the same posting with the same prompt pick
overlapping skill sets less than a third of the time. `skillsSoft` is worse at 17.4%.

That column feeds `company_technographics` (8690 rows, and the STACK block every company card
renders) **and** the ATS scorer's term matching — the engine whose ρ = 0.737 was just re-established
in task S at some effort. `normalizedTitle` at 57.1% and `experienceLevel` at 72.4% feed the
band cutpoints.

⛔ **A2's own instruction applies exactly as written:** *"IF AGREEMENT IS MATERIALLY WORSE, SAY SO
AND KEEP ENRICHMENT ON HAIKU. Degrading the input to the ATS engine to save three dollars is a bad
trade, and reporting that is the correct outcome, not a failure."*

It is materially worse. Enrichment stays on Haiku.

⚠ **And note what agreement is not.** 30.5% overlap does not establish that Haiku is right and
gpt-oss wrong — only that they differ. Deciding which is correct needs a human reading postings
against extractions, and that work is not done here. What the number does establish is that the two
are **not interchangeable**, which is the only thing the switch decision required.

---

## 5. Requirement 3 — `usage_events` records provider and $0, and the cost queries reconcile

Confirmed on real calls, not stubs.

`usage_events` grouped by `(provider, model)` for `event_type='enrich_job'`, after everything above:

| provider | model | calls | `SUM(cost_usd)` |
|---|---|---|---|
| `anthropic` | `claude-haiku-4-5-20251001` | 1302 → **1408** | $3.3244 → **$3.5984** |
| `groq` | `openai/gpt-oss-20b` | 0 → **112** | **$0.0000** |
| `groq` | `llama-3.1-8b-instant` | 0 → **6** (the 404 attempt) | **$0.0000** |

Grand total across all event types: **1638 rows, $6.1889** — and `$6.1889` is entirely Anthropic,
because `SUM` over the 118 Groq rows contributes exactly zero.

That is the reconciliation holding: the `provider` column is populated on every row, the free tier
prices at **explicit zero rather than NULL**, the two providers stay separable in one table, and
adding 118 free calls changed the row count without changing the bill. This is what migration
`096_usage_events_provider` was for, now exercised by real traffic from two providers instead of
one.

⚠ **Note the 6 rows that cost $0 and produced nothing** — the `llama-3.1-8b-instant` 404s. They are
correctly recorded as `success: false` with zero tokens. A cost report reconciles perfectly across
them, which is worth knowing: **reconciled cost is not evidence that the calls worked.**

⚠ **A correction to `NEXT_WORK.md` while here.** It states the reconciliation as "$3.3284 over 1303
Haiku calls". Measured before any of this session's runs: **1302 calls, $3.3244**. Off by one call
and 0.4¢. The framing is right, the figures were slightly stale.

---

## 6. Requirement 4 — a real 429 leaves the row retryable

Task A2 asked for this against Groq's actual rate limiter rather than a stub, and §3 supplied a live
one. **A real persistent 429 did occur** — row 31 of the paired run:

```
[31] free arm failed: Groq rate limited: {"error":{"message":"Rate limit reached for model
     `openai/gpt-oss-20b` in organization `org_…` service tier `on_demand` on tokens per minute
     (TPM): Limit 8000, Used 5301, Requ…

usage_events: model openai/gpt-oss-20b, inputTokens 0, outputTokens 0, costUsd 0, success FALSE
```

So the terminal path was reached by a genuine rate limiter, not a stub, and it behaved correctly at
the two points this harness can see: the retries were exhausted rather than the error being
swallowed, and the call was **recorded as a failure** with zero tokens and zero cost rather than
dropped. That matches the existing test `a rate-limited call is RECORDED as a failure, not dropped`.

⚠ **What this still does not prove.** This harness never writes the enrichment columns — it calls
the model and compares JSON — so it cannot show that the *row* stayed retryable. The claim that a
real 429 leaves `content_hash` and `enriched_at` unset therefore still rests on
`a 429 during enrichment leaves the row a candidate — it is never stamped enriched`, which is a
stub test. Closing that properly means running `runEnrichment` against a rate-limited Groq and
inspecting the row, which would spend the daily quota to confirm a path the code demonstrably takes.

**Stated plainly so it is not read as more than it is: requirement 4 is satisfied for the transport
and still stub-only for the row.**

---

## What would have to be true to revisit this

1. A free model that fits the extraction contract at a sane token budget, or a decision to raise
   `max_tokens` for enrichment and accept the latency.
2. A rate limit that permits a 1291-row pass. This is the binding constraint and it is not about
   quality at all.
3. A quality bar met on `skills_json` specifically — it feeds `company_technographics` (8690 rows)
   and the ATS scorer's term matching, and degrading it to save $3.32 is a bad trade.

Until then task A's routing is correct, tested, and idle — which is a fine thing for it to be. The
guard that refuses to compare Haiku against Haiku did its job: it kept this from being reported as
100% agreement.
