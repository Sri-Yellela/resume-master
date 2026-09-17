# Queued Prompts — RETIRED 2026-09-16

**This file is no longer a source of truth. Go to [`NEXT_WORK.md`](NEXT_WORK.md).**

It is kept as a tombstone rather than deleted, because `docs/ak2-session-report.md` cites it twice
as the origin of that session's work and a dangling link is worse than a redirect.

---

## Why it was retired (AH-4)

Two planning documents that disagree is not redundancy, it is a trap — and this one had already
sprung. From its own header, written after the fact:

> AK2 picked up five tasks and found **three of them already done** — tasks 1 and 3 had landed in
> commits this file listed as pending, and task 5's headline pricing risk was refuted by live docs
> the repo already agreed with. This file was four hours old and already wrong.

`NEXT_WORK.md` then became the live document, and this one kept its own stale copy of the state
without anyone updating it. As of retirement it was **13 days stale** and wrong in four ways that
would each have sent someone down a dead end:

| It said | Actually |
|---|---|
| Suite **2057 passing** | 2,432 |
| Migration high-water **095** | 106 |
| Blocked on **Anthropic API credit, exhausted 2026-08-25** | the key has credit; enrichment has been running at ~$0.06/day |
| Task 7 generation deferral **not started** | landed, `docs/al2-generation-deferral.md` |

The API-credit line is the worst of them. A blocker that has been cleared, still printed as a
blocker, stops work that could proceed — which is the exact inverse of what a planning doc is for.

## What was in it

Eight tasks, all resolved: outcome UI, the corruption sweep, web client cursor paging, ATS bands,
cache batching, Android Phase 2a, generation deferral, and the iOS Phase 1 audit. The last is the
only one still open and it lives in `NEXT_WORK.md` now, still blocked on a Mac with Xcode.

Nothing was lost in retiring this. Everything it tracked is either landed or carried forward.

## The rule this is an instance of

**One planning document.** When a second one appears, it is not a second opinion — it is a copy of
the state that nobody is obliged to update, and it will be believed by whoever reads it first.
`git log` is the record of what happened; `NEXT_WORK.md` is the record of what is next; a task
report in `docs/` is the record of how one piece went. There is no fourth kind.
