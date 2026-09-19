# The enrichment backlog — it is a billing problem, and the monitor already knew

2026-09-18. Follow-up to `docs/PART1_RECONCILED_2026-09-18.md` §3d, which reported the backlog at
**1,470 and growing**.

> **Headline: the drain is not broken, under-budgeted, or mis-tuned. The Anthropic account ran out
> of credit on 2026-09-17 and every enrichment call has failed since. The pipeline health monitor
> detected it, named it precisely, and nobody was looking.**

---

## 1 · What the daily record actually shows

| day | written | failed | recorded status |
|---|---|---|---|
| 09-18 | **0** | 25 | `ok` |
| 09-17 | **0** | 25 | `ok` |
| 09-16 | 299 | 9 | ok |
| 09-15 | 300 | 0 | ok |
| 09-09 … 09-14 | 25/day | 0 | ok |
| 09-07, 09-06, 09-05 | **0** | 25 | `ok` |

Three distinct regimes, and only the middle one is the system working as designed:

- **09-09 → 09-14, 25/day.** The pre-AE single-pass path (`runEnrichment`), one batch per night.
  Its run detail carries `batchId` and `gatedOut`; the drain's carries `passes` and `batchIds`.
  Task AE (`1e1f91a`) replaced it, and the first drain nights are 09-15 and 09-16.
- **09-15 / 09-16, 300 and 299 rows, $0.80 spent, 14 passes.** The drain working exactly as
  designed. The 300-row budget is not the constraint; it was reached.
- **09-17 → now, 0 written, 25 failed, zero tokens, 10-second runs.**

## 2 · The cause, from the recorded error

```
400 invalid_request_error
"Your credit balance is too low to access the Anthropic API.
 Please go to Plans & Billing to upgrade or purchase credits."
```

50 `enrich_job` events since 09-17, **every one `success = 0`, `input_tokens = 0`**. A 10-second run
for 25 rows is 400ms each — an immediate error, not a timeout. Boot-time model liveness still passes
because the catalogue endpoint is free; a zero-balance key authenticates fine and fails on inference.

**Jobo is in the same state**, independently:

```
HTTP 402 — "Insufficient credits. This request needs 30 credits ($0.03).
            Your wallet balance is 0 credits ($0)."
```

which also answers the audit's open question about jobo's zero rows. It is not a silent failure and
never was — see §4.

⛔ **Nothing in this repository can fix either.** Both need a card. Until then the backlog grows by
whatever the crawl adds each night.

---

## 3 · The one real code defect: a run that wrote nothing said `ok`

`status: stopReason === 'refused' ? 'skipped_unconfigured' : 'ok'` — the only non-`ok` branch was a
refusal, so "every row errored" fell through to `ok`. Five days of it.

Fixed, and **deliberately narrowly**:

```js
status: stopReason === 'refused'        ? 'skipped_unconfigured'
      : (enriched === 0 && failed > 0)  ? 'failed'
      : 'ok'
```

- a **partial** run stays `ok` — 299 written against 9 failed is a working drain, and promoting it
  would be an alarm nobody reads;
- an **empty queue** stays `ok` — a drained backlog is the goal state;
- a **refusal** still outranks the failure branch, because two drains are scheduled in the same
  04:00 tick and the second is routinely refused by the concurrency guard.

The health check already caught this downstream. That does not excuse the row: `pipeline_runs.status`
has other readers, and a status contradicting its own `failed` column is a trap for the next one.

---

## 4 · ⛔ Two corrections to my own audit, both in the same direction

`docs/PART1_RECONCILED_2026-09-18.md` §6 claimed there is **"no per-company signal"** and that a
retired ATS slug is invisible. **Wrong.** The monitor raises per-company freshness alerts:

```
[warn] company/lever/wealthfront : no row seen in 234h (threshold 48h)
[warn] company/lever/openx       : no row seen in 234h (threshold 48h)
[warn] company/ashby/linear      : no row seen in  66h (threshold 48h)
```

§3a said jobo's zero rows were worth "one look at the deploy log" to tell an unconfigured key from
an empty feed. The monitor had already made that distinction and recorded the exact 402 body.

I audited the pipeline for blind spots and reported as missing two signals that exist. The scrape
monitor the prompt calls "deferred roughly fifteen times" **was built**, and it works.

---

## 5 · So what is actually missing

Every failure in this report was detected, classified and described in precise language by
`GET /api/admin/db/pipeline-health`, including:

```
[critical] enrichment/consecutive failures: the last 2 enrichment runs wrote nothing
           — this is the shape that ran for three days undetected
```

That alert names its own history. It is correct, it is current, and it has been sitting behind an
admin route that nothing polls and nobody opens.

**The gap is not detection. It is delivery.** Nothing reads the monitor on a schedule, and nothing
tells anybody. That is a genuinely different task from the ones in the audit's Part 2 list, it is
small, and it would have turned five days of silent failure into one message.

---

## 6 · Not done

- **Top up Anthropic and Jobo.** Owner action; no code can substitute.
- **Deliver the alerts.** The monitor exists and is right; nothing carries its output anywhere.
  Recommended next, ahead of anything else on the backlog, because it is what makes the rest
  self-reporting.
- **The backlog itself** (1,470) needs no new engineering. At 300 rows/night the drain clears it in
  ~5 days net of inflow, which is what 09-15 and 09-16 demonstrated before the credit ran out.
- **workable (23 fetched → 0 written) and recruitee (16 → 0)** are flagged critical by the same
  monitor and are a separate defect from this one.
