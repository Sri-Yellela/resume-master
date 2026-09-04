# AL1 — Multi-provider routing and the widened call guard

Run 2026-09-04. Desktop suite **2057 → 2090 passing, 0 failing** (+33).
Migration high-water **095 → 096**.

Tasks B and C of `docs/NEXT_WORK.md` were **already complete when this run started** — see the
reconciliation at the bottom. This document covers task A, which was the only one still open.

---

## The finding that outranks the rest: the guard could never have seen a `fetch`

Requirement 2 said to widen `test/modelCallGuard.test.js` before adding a provider, and to verify it
by **injecting** a violation per provider shape. The injection test was written first, and it failed
immediately — not on a shape that had been forgotten, but on one that was **structurally
unreachable**.

The scan stripped comments with:

```js
const code = line.replace(/\/\/.*$/, "")
```

`https://api.groq.com/openai/v1/chat/completions` contains `//`. Every URL-shaped provider call was
therefore **erased as a "comment" before the scan ever ran**, and no hostname pattern added to that
regex could ever have matched anything.

This is the worst possible place for it. No Groq or Gemini SDK is installed in this repo — they are
OpenAI-compatible and Gemini is plain REST, so an untracked call to either **would not look like an
SDK method at all**. It would look like a `fetch`. The one shape the guard most needed to catch was
the one it could not see, and a hostname arm added without the injection test would have been
inert while reading as protection.

Fixed by requiring the character before `//` not to be a colon:

```js
const code = line.replace(/(^|[^:])\/\/.*$/, "$1")
```

**This is the argument for the injection requirement, in one defect.** A guard extended by reading
it and adding patterns would have shipped with the hole intact and the suite green.

### What the guard covers now

| shape | example | why |
|---|---|---|
| anthropic sdk | `.messages.create(`, `.messages.batches.create(` | pre-existing |
| openai-compatible sdk | `.chat.completions.create(` | Groq's entire interface; SambaNova; any `new OpenAI({ baseURL })` |
| openai responses sdk | `.responses.create(` | the other OpenAI surface |
| google genai sdk | `.generateContent(`, `.generateContentStream(` | Gemini |
| direct http | `api.groq.com`, `generativelanguage.googleapis.com`, `api.anthropic.com`, + 5 more hosts | **the one that matters — no SDK is installed** |

12 injected violations, one per shape plus the Anthropic variants that have bitten before, each
written into a real `.js` file inside the real tree and run through the **live** scan function. The
scan is now defined **once** and shared between the guard and the injection test; it was previously
written out twice, so the copy could agree with itself while the live one narrowed — which is
precisely the failure the earlier coverage test was added to prevent and could not detect.

### Two follow-on holes, closed

1. **The catalog is exempt, and the exemption is paid for.** `shared/modelProviders.js` holds the
   base URLs as data, so it trips the hostname arm. It is exempt — and a test asserts it contains
   **no network call of any kind** (`fetch`, `axios`, `http.request`, `XMLHttpRequest`, `undici`).
   Exempting a file that *could* call something is how a guard acquires its first real hole.
2. **A base URL is a capability.** The hostname scan cannot see
   ``fetch(`${spec.baseUrl}/chat/completions`)`` — the host is in the catalog, not at the call site,
   so any module could import `PROVIDERS` and reach a provider in two lines that no hostname regex
   would match. **Only the transport may read `.baseUrl`**, asserted separately. Scoped to files
   that import the catalog *and* to a property read, because `baseUrl` is an ordinary name here —
   server.js builds a password-reset link with one, and flagging it would have made the guard noise.

---

## The split

Routing is by **whose data it is**, and it lives in `callModel()` and nowhere else.

```
PUBLIC     enrich_job     1302 of 1367 events (95.2%), 60.2% of spend
           classify_job   title + 600 chars of the posting's description
           import_job     the fetched text of an open-web posting
CANDIDATE  everything else — 11 sites
```

**The default is CANDIDATE.** A site that declares nothing stays on Anthropic. Forgetting to
annotate a public site costs a fraction of a cent; forgetting to annotate a resume-touching one
would send a person's home address and work authorisation to a tier whose training policy is not
stated on any public page. All 14 sites now declare explicitly, and a test requires it — the default
protects production, the assertion protects intent.

### A near-miss worth recording: `classifier` vs `classify_job`

`NEXT_WORK.md` lists `classify_job` as free-tier eligible, and it is: `server.js` sends a title and
600 characters of the posting. But `services/classifier.js` has purpose **`classifier`** — one word
apart, adjacent in every cost report — and it sends:

```js
Resume (first 2000 chars):
${resumeText.slice(0, 2000)}
```

**2000 characters of the candidate's resume.** Routing by the name rather than the payload would
have leaked resumes on the first pass. It is annotated CANDIDATE, and a test pins it to the fact
that `resumeText.slice` is actually there, so the assertion cannot outlive the reason for it.

---

## Requirements 3–7

**3 · Pricing.** Free-tier models are priced **at zero, explicitly**, in `FREE_TIER_PRICING`.
Not absent, and not an exception: an absent entry fires `calculateCost`'s loud unknown-key warning
on all 1302 enrichment calls a pass, and the only way to quiet that would be to special-case "free"
inside the pricing function — which would then silence a genuinely dead model ID too. Asserted both
ways: a free model prices at $0 **silently**; `some-model-nobody-added` still warns. Anthropic
pricing is unchanged (Haiku $1/MTok in, Sonnet $10/MTok out, re-asserted).

A second test requires **every pinned model of every provider to have a pricing entry**, so adding a
callable model forces a pricing decision in the same edit.

**4 · `usage_events` records provider AND model.** Migration **096**, applied to a copy of the real
database: the column lands and all **1367** existing rows backfill to `anthropic`. Backfilled rather
than left NULL because every row that exists predates routing and *was* an Anthropic call — NULL
would say "unknown", which is a different and false claim.

The model recorded is the one **actually called**, not the one the call site asked for; they differ
on every routed call, and recording the requested one would reconcile cost against a model that was
never invoked. `routes/admin.js` now groups by provider as well as model, and adds a `byProvider`
block — a free-tier row costs $0, so a cost-ordered by-model list sinks it to the bottom and reads
as though it never happened.

**5 · Unconfigured is loud.** Four distinguishable states, because "not configured" and "configured
but keyless" are different bugs:

| reason | result | warns |
|---|---|---|
| `not_configured` | Anthropic | no — this is the documented default |
| `missing_key` | Anthropic | **yes** — names the env var |
| `unknown_provider` | Anthropic | **yes** — a typo (`grok`) must not take enrichment down, but must not be invisible |
| `configured` | the free tier | — |

The warning fires **once per process**, not once per row: 1302 identical lines would bury every
other log line, and the usual response to that is to delete the warning.

**6 · The model is pinned.** An `ENRICH_MODEL` outside the catalog **throws** (`UNPINNED_MODEL`)
rather than falling back. A quiet fallback would mean the free tier silently stopped being used and
the bill silently returned with every dashboard green — the `cacheJoboFeed` shape. Safe to throw on,
because enrichment's failure path leaves `content_hash`/`enriched_at` unset and the row stays a
candidate.

**7 · 429.** Groq is 30 req/min; enrichment paces at 25 per batch with a 250 ms delay, which is
**240 req/min — eight times the ceiling**. Without pacing the first real pass would be a wall of
429s. A client-side limiter lives in the transport, not in `enrichJob`, so the next PUBLIC call site
inherits it rather than rediscovering it. On 429: honour `Retry-After`, else 1s/2s/4s with jitter,
3 retries, then throw `ProviderRateLimitError`.

**Confirmed by a real test, not by reading the code:** a 429 through the full `runEnrichment` path
leaves `content_hash` NULL, `enriched_at` NULL and `summary` NULL, so the row stays a candidate —
and the failed attempt still appears in `usage_events` with `success = 0` and `provider = 'groq'`.
That behaviour already held, but it held *by accident of the current code*; it is now pinned,
because the cost of it quietly ceasing to hold is a row that leaves the candidate pool permanently
(the hash only changes when the title or description does).

> **A consequence worth stating before anyone runs the pass:** at 30 req/min, 1302 rows takes
> **~43 minutes minimum**. It fits the 14,400/day allowance easily. It is not a fast operation.

---

## ⛔ Requirement 8 is NOT done — no key exists

`NEXT_WORK.md` states *"Env now injected: `GROQ_API_KEY` · `GOOGLE_API_KEY`"*. **That is not true of
this working copy.** Neither variable is in `.env` and neither is in the process environment:

```
GROQ_API_KEY ABSENT     GOOGLE_API_KEY ABSENT
ENRICH_PROVIDER ABSENT  ENRICH_MODEL ABSENT
```

So the following, all of which the task's VERIFY block requires, **have not been done**:

- 50 rows through Groq
- `usage_events` rows carrying `provider = 'groq'` at $0 **from a real call**
- per-column agreement of Groq vs Haiku on the extracted fields

**The routing has never served a real token.** Everything above is verified against fetch stubs and
the live `callModel` path; nothing here is evidence about Groq's actual behaviour, its actual rate
limiting, or its extraction quality.

`scripts/al1ProviderQualityDiff.mjs` is written and ready:

```
ENRICH_PROVIDER=groq GROQ_API_KEY=gsk_... node scripts/al1ProviderQualityDiff.mjs --rows 50
```

It refuses to run unconfigured — exiting 2 rather than comparing Haiku against Haiku and reporting
100% agreement, which is the false green requirement 8 exists to prevent. It imports enrichment's
**own** `buildPrompt` rather than copying it, so it cannot drift into measuring a prompt the
pipeline does not use. It reports per-column agreement plus Jaccard overlap on `skillsHard` and
`skillsSoft` (a set, so exact-match agreement would read as 0%), and it says in its own output that
**agreement is not accuracy** — it establishes that two models say the same thing, not that either
is right.

Excluded from `verify:harness`: the Anthropic arm spends real tokens on every row.

> The decision requirement 8 asks for — *is an 8B model good enough for `skills_json`, which feeds
> `company_technographics` and the ATS scorer?* — **remains open**. The saving at stake is ~$3.32
> per pass. Do not switch `ENRICH_PROVIDER` on a deployment until this has been run.

---

## What was already done — the doc was stale on two of three tasks

`NEXT_WORK.md` opens by warning that its predecessor listed five tasks of which three were already
complete. The same held here.

**TASK B — ATS bands: COMPLETE before this run.** `shared/atsBands.js` carries all four bands with
`NOT_ENOUGH_SIGNAL` as a distinct correctness state, cutpoints Strong ≥ 44 / Moderate ≥ 26 chosen
for precision (100% precision against human ≥ 4, at an explicitly accepted cost of 4 of 12
human-graded 5s), the thin-resume state, and the gate left decoupled at 30.
`services/localAtsScorer.js` carries the seniority guard (ρ 0.643 → **0.746**, mis-ordered 16.1% →
**12.2%**). 12 tests in `test/atsBandSurfaces.test.js`, all passing. Written up in
`docs/ak2-ats-bands.md`.

**TASK C — Android Phase 2a: COMPLETE before this run.** All four steps, verified on a real
emulator against the real local server; 40 JVM + 13 instrumented tests. Android commits `e35b6f8`
… `2bbd242`. Written up in `docs/aj2-android-phase2a.md`. The head commit of *this* repo when the
run started was literally `docs: Phase 2a is complete`.

Neither was re-done. The baseline was re-derived first, as the doc instructs, and that is what
turned three tasks into one.
