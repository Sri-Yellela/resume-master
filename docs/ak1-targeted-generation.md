# AK1 Phase 4 — Targeted generation: a design, and why its premise does not hold

**Design only. Nothing in this phase is implemented.**

The brief's hypothesis: a scorer that knows exactly which terms are missing makes generation
variable-cost — rewrite three bullets instead of a whole document. I measured the gap distribution
that would drive it. **The hypothesis does not survive the measurement**, and the saving that *is*
available comes from somewhere else entirely.

---

## 1. The cost model, verified

Pricing checked live against `platform.claude.com/docs/en/about-claude/pricing` on 2026-08-29, not
recalled. Claude Sonnet 5:

| | rate |
|---|---|
| base input | $2 / MTok |
| 5-minute cache write | $2.50 / MTok (1.25×) |
| 1-hour cache write | $4 / MTok (2×) |
| cache read | $0.20 / MTok (0.1×) |
| output | $10 / MTok |
| Batch API | 50% off input **and** output |

> Worth recording because the repo says so and the claim is now confirmed: the $2/$10 launch
> "introductory" pricing **is** the standard price — *"The previously scheduled increase to $3/$15
> per million input/output tokens on September 1, 2026 will not occur."* `shared/anthropicModels.js`
> is correct and needs no expiry handling. (A cached model table I consulted still showed the
> increase as pending, two days out. It is not.)

### The measured baseline — not an estimate

The one real `resume_generate` row in `usage_events` (id 78, Stripe, Sonnet 5):

```
input             1795 tok  × $2/MTok     = $0.003590    ( 8.6%)
cache write       6704 tok  × $2.50/MTok  = $0.016760    (40.3%)
output            2125 tok  × $10/MTok    = $0.021250    (51.1%)
                                            ─────────
                                            $0.041600   ← matches the recorded cost_usd exactly
```

**This reframes the whole phase. Input is 8.6% of the bill.** A shorter prompt is nearly worthless.
The money is in **output (51%)** and, surprisingly, in **cache writes (40%)**.

The 6704 cached tokens are the three system blocks assembled by `services/promptAssembler.js` —
layer 1 global rules (~3126 tok), layer 2 domain (~2291 tok for engineering), layer 3 mode (~360
tok), each already carrying `cache_control: {type: "ephemeral"}`. The prefix is already correctly
structured for caching. It is being **written and never read**, because generations arrive further
apart than the 5-minute TTL.

## 2. The four options, costed

| # | option | cold | warm (cache hit) | vs today |
|---|---|---|---|---|
| 0 | today | **$0.0416** | $0.0262 | — |
| A | targeted generation (~350 output tokens) | $0.0241 | $0.0086 | −42% / −79% |
| B | skip generation entirely | $0 | $0 | −100% |
| C | A + Batch API (50%) | $0.0120 | **$0.0043** | −90% |

Warm assumes a 5-minute cache hit on the 6704-token prefix. Batched at 20 generations inside one
TTL window (1 write + 19 reads), today's per-generation cost falls to **$0.0270** with no other
change; with targeted output it falls to **$0.0094**, and with the Batch API to **$0.0047**.

**The 1-hour TTL (2× write) pays for itself at two reads** and is the better setting for any queued
batch that spans more than five minutes.

## 3. What the gap list actually looks like — the finding that breaks the premise

Targeted generation needs few gaps per job. Measured across 1290 scorable postings against a
realistic backend resume:

```
heavy gaps (weight >= 1.0) per job
   0 gaps :   12 (0.9%)      6 gaps :  127 (9.8%)
   1 gap  :   14 (1.1%)      7 gaps :  132 (10.2%)
   2 gaps :   17 (1.3%)      8 gaps :  160 (12.4%)
   3 gaps :   34 (2.6%)      9 gaps :  123 (9.5%)
   4 gaps :   49 (3.8%)    10+ gaps :  510 (39.5%)
   5 gaps :  112 (8.7%)

mean 9.08 heavy gaps per job;  81.6% of jobs have >= 6
```

**The mean job is missing nine weighted terms.** "Rewrite three bullets" does not describe this
corpus. Rewriting nine gaps' worth of bullets *is* a whole-document rewrite.

### And most of those gaps must never be closed

The gap list is not the work list. A gap may only be closed by **rephrasing true experience** — the
integrity line in §5. Using "are the term's words already somewhere in the base resume" as a proxy
for "could this be honestly rephrased":

```
11845 missing skill terms across 1290 jobs

  ALL words present, phrase absent :   317 ( 2.7%)   rephrasable — the real work list
  SOME words present               :  3855 (32.5%)   needs a judgement
  NO words present                 :  7673 (64.8%)   the model must NOT invent these

mean REPHRASABLE gaps per job : 0.25       (vs 9.18 total missing)
  0 rephrasable : 1017 jobs (78.8%)
  1 rephrasable :  231 jobs (17.9%)
  2 rephrasable :   40 jobs ( 3.1%)
  3 rephrasable :    2 jobs ( 0.2%)
```

**Nearly four jobs in five have nothing a rewrite could honestly change.** The addressable market
for targeted generation is roughly *one* rephrasable gap on *one job in five*.

And 2.7% is an **over**-estimate. The proxy is the same scattered-word logic Phase 2 removed from
`hasTerm` for being wrong: `product strategy` (69×) counts as "rephrasable" only because the resume
contains "product managers" and "technical strategy" separately. It is not rephrasable; it is a
different thing. The true figure is lower.

The genuinely absent gaps are unambiguous and show what the model would be tempted to fabricate:
`reliability` (276×), `onboarding` (205×), `experimentation` (92×), `scalability` (86×),
`networking` (85×), `TypeScript` (55×).

**Conclusion: do not build targeted generation on this corpus.** Its premise — a short, honest,
per-job gap list — is not what the data contains.

## 4. Where the saving actually is

Given §3, the recommendation is the boring one, and it is worth more than the clever one:

**Recommended: cache-window batching. −37% per generation, zero product change, zero integrity
risk.** Generations already carry a correctly-structured 6704-token cached prefix that is written
and never read. Grouping queued generations so they land inside one TTL window turns a $0.016760
cache *write* into a $0.001341 cache *read* on every call after the first. $0.0416 → $0.0262
cold-to-warm, or $0.0270 amortised over a batch of 20. Nothing about the output changes, so nothing
about the resume changes.

**Second: the Batch API for queued work.** 50% off input and output, stacks with caching. The
auto-apply queue is not latency-sensitive — `APPLY_DAILY_QUEUE_CAP` already assumes jobs sit in a
queue. Combined with the above: **$0.0135 per generation, −68%,** with no change to what is
generated. This is the largest safe saving available and it needs no scorer at all.

**Not recommended: targeted generation** (§3).

**Marginal: skipping generation** (§6).

## 5. The integrity line is unchanged and absolute

Any targeted path, if it were ever built, inherits every existing rule without relaxation:

- `services/resumeClaimGuard.js` — `assertResumeClaims` (called at `server.js:7718`) refuses an
  artifact that overstates years or seniority, **before it can be persisted or sent**. A patch-based
  path must call it on the assembled document, not on the patch, or the check no longer sees what
  the candidate would submit.
- The flag-don't-fabricate rule in `prompts/layer1_global_rules.md` applies unchanged. **Knowing a
  term is missing must never become a reason to insert it.** §3 makes this concrete: 64.8% of gaps
  are things the candidate does not have, and a prompt that hands the model a gap list is a prompt
  that has just listed 9 things it would be rewarded for claiming. That is a materially more
  dangerous prompt than today's, and it is the strongest argument against building this at all.

One genuine integrity *advantage* is worth recording, in case the idea is revisited when matching
improves. A patch-based path makes the unchanged portion **provably** unchanged — the guard would
only need to verify the K new bullets plus a byte-identity check on the rest, which is a stronger
guarantee than today's "regenerate the whole document, then re-verify the whole document". If
targeted generation is ever built, that property is the reason to build it — not the token saving.

## 6. Skipping generation when the base resume is good enough

The brief calls this the largest available saving: not a cheaper generation but a skipped one. On
this data it is small, and it cannot currently be calibrated.

**Size.** Only **0.9%** of jobs have zero heavy gaps, and **3.3%** have ≤2. Whatever the threshold,
this fires on a few percent of the board.

**A score threshold is the wrong instrument.** Score and gap count are nearly independent — mean
heavy gaps run 9.59 → 9.32 → 8.79 → 7.87 across the score bands 0-20, 20-30, 30-40, 40+. A high
score does not mean few gaps. If this is ever built, gate it on the **gap list**, not the number.

**It cannot be calibrated today, and this is the blocking finding of Phase 4:**

> **The lift from generation has never been measured.** `usage_events` has `ats_score_before` and
> `ats_score_after`; `routes/admin.js:65` and `:160` read them and render an admin "avg before → avg
> after" panel. **Zero rows are populated** — `callModel` at `server.js:7600` is never passed either
> value, even though the post-generation score is computed 100 lines later at `server.js:7703`. The
> dashboard has always shown nothing.

So the question "does generation improve the ATS score, and by how much?" has no answer in this
system, and "when is the base resume good enough to skip generation?" is unanswerable until it does.
Writing those two values at the existing call site is a small change and the prerequisite for this
entire option. It is deliberately **not** made here — Phase 4 is design-only — but it is the single
highest-value follow-up in this document.

## 7. If it were built anyway — the design

Recorded for completeness; §3 says don't.

**Prompt shape.** System blocks unchanged (the cached prefix must stay byte-identical or the 6704
tokens re-write at 1.25×). The user message gains a gap block and loses the "produce a full
document" instruction:

```
<base_resume_bullets>          # each bullet with a stable id
  b7: "Instrumented services with observability tooling; reduced p99 latency 45%."
  ...
</base_resume_bullets>
<rephrasable_gaps>             # ONLY gaps pre-verified as supported by the base resume
  - "log analysis"  supported_by: b7
</rephrasable_gaps>
```

Output is a patch, not a document: `[{id: "b7", text: "..."}]`. ~350 output tokens for 3 bullets.

**The gap list must be pre-filtered server-side, never handed over raw.** Only gaps with an explicit
`supported_by` anchor may appear. This is what keeps the prompt from being a fabrication menu — the
model is asked to rephrase a specific true bullet, not to acquire a skill.

**Requires stable bullet identity**, which the current HTML pipeline does not have. That is real
work, and it is on the critical path.

## 8. Estimated cost per generation, all options

| option | per generation | vs $0.0416 | recommend? |
|---|---|---|---|
| today, cold | $0.0416 | — | current |
| **cache-window batching only** | **$0.0262** | **−37%** | **yes — safe, no product change** |
| **+ Batch API** | **$0.0135** | **−68%** | **yes — for queued work** |
| targeted generation, warm | $0.0086 | −79% | no — premise unsupported (§3) |
| targeted + batch, warm | $0.0043 | −90% | no |
| skip generation | $0 | −100% | on ~1-3% of jobs, and uncalibratable (§6) |

**Recommendation: take the −68% that requires no scorer, no prompt change, and no new integrity
surface. Revisit targeted generation only if semantic matching improves enough to move the 32.5%
"some words present" bucket into the addressable set** — which is the same recall problem Phase 3
identified as the ceiling on the whole engine.
