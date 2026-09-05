# AL6 (task E) — cache breakpoints and batching

Run 2026-09-04. Suite **2168 → 2175 passing, 0 failing**.

---

## Requirement 1 — the breakpoints stay, and the measurement is why

The assessment said:

> *"REMOVE THE UNREAD CACHE BREAKPOINTS. The generation prefix is written at 1.25x and read at 0.1x
> — written every time, read never. A 25% surcharge buying nothing. Unconditional −8.1%."*

and requirement 1 said to *"verify before/after against real usage_events, reconciled"*. Verified.
**The premise is true of one caller and false in aggregate.**

Sonnet 5 base input is $2/MTok (verified live below). A cache write is 1.25x, so the surcharge over
plain input is **0.25x**; a read is 0.1x, so a hit saves **0.9x**.

| purpose | calls | cache writes | cache reads | surcharge paid | saved |
|---|---|---|---|---|---|
| `resume_generate` | 9 | 6,704 | **0** | $0.0034 | $0.0000 |
| `af2_claim_verify` | 3 | 14,352 | **0** | $0.0072 | $0.0000 |
| `ag2_claims_verify` | 33 | 19,136 | 138,736 | $0.0096 | $0.2497 |
| `ag3_claim_sample` | 18 | 9,632 | 76,864 | $0.0048 | $0.1384 |
| | | | | **$0.0249** | **$0.3881** |

> **Net: the breakpoints have SAVED $0.3632.** Removing them would forfeit $0.39 to recover $0.02.

The unread writes are real and are exactly where the assessment said. What the assessment did not
account for is that the callers which generate in **bursts** read the prefix heavily — the 5-minute
ephemeral window is the whole story. "Unconditional −8.1%" was computed on the interactive path
alone.

### And task D just changed the interactive path

`resume_generate` — the caller with **0 reads**, the one the recommendation was about — is precisely
the one about to become bursty. AL2 moved generation to **approval**, and approving N applications
starts N generations in quick succession. Deleting its breakpoints would lose the saving at the
moment it starts to exist.

### So it is a lever, not a deletion

`assemblePrompt(..., { cache: false })` removes every breakpoint. Default is **on** — the
measured-best status quo — and any caller that knows it is one-shot can take the −8.1%. The decision
is now cheap and explicit instead of hardcoded either way, and the measurement lives in
`services/promptAssembler.js` beside the line it justifies, because a number in a commit message is
unfindable six months later.

`test/cacheBreakpoints.test.js` re-derives the arithmetic from the pricing table, so the figures in
that comment are checkable rather than asserted — **and it fails if the net ever flips**, at which
point requirement 1's advice becomes correct and should be taken.

---

## Requirement 5 — pricing verified LIVE

Fetched from `platform.claude.com/docs/en/about-claude/pricing` on **2026-09-04**, not from memory
and not from the model catalog skill (whose own table is dated 2026-06-24 — the exact cached source
the requirement warns about).

| model | base input | 5m write | 1h write | cache read | output |
|---|---|---|---|---|---|
| Claude Sonnet 5 | $2 | $2.50 | $4 | $0.20 | $10 |
| Claude Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |

**`shared/anthropicModels.js` is exactly correct on every one of these eight numbers.** Pinned by a
test, compared in dollars-per-million with a tolerance — `0.2/1e6` is not bit-identical to the
stored `2e-7`, and a strict check would fail on floating point rather than on a price change.

The docs also confirm, in terms:

> *"The previously scheduled increase to $3/$15 per million input/output tokens on September 1, 2026
> will not occur."*

So the file's comment about the cancelled rise is current, and the assessment's finding stands.

**The 1-hour cache write is confirmed at 2x base input** ($4/MTok on Sonnet 5). There is still no
`1h` key in `ANTHROPIC_PRICING`, and a test asserts nothing sets `ttl: "1h"` — adding one without a
price key would under-report every such write by **37.5%** silently, because the model ID still
resolves and the loud unknown-key branch never fires.

---

## Requirement 2 — batching `enrich_job`: not done, and the reason is not the one anticipated

The requirement was conditional: *"IF it is still on Anthropic after task A. If task A moved it to
Groq, this requirement is moot."*

Enrichment **is** still on Anthropic — `GROQ_API_KEY` does not exist — so by the stated condition
batching is live work. It is still not done, for two reasons the assessment could not have known:

1. **There is nothing left to enrich.** The retention purge took `scraped_jobs` from 1288 rows to
   **5**. A batching optimisation for a 1302-call pass has no pass to optimise, and could not be
   verified on real traffic.
2. **The provider question is open, not closed.** Task A's routing for `enrich_job` is built but has
   never served a token (task A2). Building the Batch API path now would optimise a call site that
   may move to Groq — where the Batch API does not apply — the moment a key appears. That is the
   opposite of the order the queue intends.

What *is* asserted: the decision has not been quietly taken. No batch call exists anywhere, and
`test/modelCallGuard.test.js` still covers `messages.batches.create` — AK2's finding, and the reason
adding batching later cannot become untracked spend.

## Requirements 3 and 4 — unchanged, and worth restating

**3. The −37% / −68% figures are asymptotes.** Ten generations in one 5-minute window is −33.4%; two
is −18.5%. `resume_generate` has now run **9** times in 1414 events (it was 1 when the assessment was
written — the increase is this session's own harness runs, not user traffic). The projection still
rests on almost nothing.

**4. Not on the apply path.** Semi and auto both hold a live browser open blocking on the resume at
the upload step, against a 24-hour batch SLA. Batching wins by making CASE A (current artifact, no
model call) normal — which is what task D did. That ordering is unchanged and correct.
