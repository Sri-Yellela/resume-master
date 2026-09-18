# Part 1 — Reconciliation audit, re-run 2026-09-18

Prompt: `docs/RECONCILE_AND_RESIDUAL.md` Part 1. Previous run: `docs/PART1_RECONCILED.md`
(2026-09-09). **Read-only — nothing was changed by this audit.**

Re-run because the board nearly doubled (1,266 → 2,610 active in production) and 35 commits landed
since `339c9d1`, 13 of them today.

> **The headline: two of the five "most likely stale" claims are stale again, in the direction
> nobody expected, and item 4's unjudged decision is now judgeable — with opposite answers for its
> two columns.**

---

## 1 · Ground truth

| | doc's claim | measured | |
|---|---|---|---|
| tests / failures | 2,301 | **2,559 / 0** | stale by 258 |
| migration high-water LOCAL | — | **108** | |
| migration high-water PRODUCTION | 102/103 "reported local-only" | **108** | **match** |
| contract version | — | **1.1.1**, 30 paths | |
| commits since `339c9d1` | — | **35** | |

⛔ **Production's high-water was confirmed by a JSON key, not a 200** — per the prompt's own
warning. `/api/version` returns `migrations.highestNumbered`. That warning earned itself again
today: querying the admin API at `/api/admin-db` (wrong — it is `/api/admin/db`) returned **HTTP
200 with the SPA shell**, and only `.json()` failing revealed it.

---

## 2 · Per-task status

⛔ **I did not re-verify A–X individually, and will not pretend to.** The 2026-09-09 per-task table
stands except where today's evidence contradicts it. What changed since:

| task | 09-09 status | now |
|---|---|---|
| **Y** | open | **Phase 1 probed + Phase 2 built** (`eecbe09`, `e71a602`). Sources still off by default. Phase 1 of `DETAIL_FETCH_ECONOMICS.md` still unrun |
| **Z** | open | **DONE** — `f670b24`. The board never lost its badge; the harness had |
| **CC1–CC5** | did not exist | **all DONE + deployed**, plus CC1b |
| **AH-1/2/4, AF residual** | open | DONE |
| **AB-1** THEIRSTACK | vestigial, owner action | **still outstanding** — see 3e |
| iOS Phase 1, Android admin flavour / backup excludes | open | **unchanged, still open** |

---

## 3 · The claims most likely to be stale

### a · Active sources and row counts — **5 sources, 2 of them vestigial**

| source | active rows | first seen | last seen |
|---|---|---|---|
| greenhouse | 1,680 | 2026-08-06 | 2026-09-18 |
| ashby | 784 | 2026-08-11 | 2026-09-18 |
| lever | 136 | 2026-09-09 | 2026-09-18 |
| **workable** | **6** | 2026-09-09 | 2026-09-18 |
| **recruitee** | **4** | 2026-09-09 | 2026-09-18 |

All five crawled today, so the cron is alive. `company_ats_list` configures **29 slugs** across 7
ATS types; smartrecruiters (2) and workday (1) produce nothing, correctly — task Y left them off.

⛔ **JOBO HAS NEVER WRITTEN A ROW.** `JOBO_API_KEY` is set locally and `source='jobo'` returns
**0 rows, ever**. The cron now distinguishes `skipped_unconfigured` from a zero-row sync — that fix
landed — but the outcome is still zero, and this audit cannot see production's logs to say which
branch it takes. **Worth one look at the deploy log**; it is the exact provider the docs say "went
undetected for months".

⛔ **workable 3 slugs → 6 rows and recruitee 2 slugs → 4 rows** are the item-6 shape (below): a
retired slug and a genuinely tiny board are indistinguishable from here.

### b · The `_ghCompanies` cap — **fixed, confirmed**

The named-parameter signature survives only in comments explaining its removal. Grouping is by
`ats_type` over one shared function, so live search and the cron cannot diverge again. ✓

### c · One logo provider — **confirmed**

`LOGO_HOST = 'https://icons.duckduckgo.com/ip3'`, single definition in `shared/companyLogos.js`.
`logo.clearbit.com` and `google.com/s2/favicons` appear only in `RETIRED_LOGO_HOSTS`, the repair
list. No second provider. ✓

### d · ⛔ Enrichment backlog and coverage — **BOTH FIGURES IN CIRCULATION ARE WRONG**

| column | active rows covered | % |
|---|---|---|
| `skills_json` | 1,140 / 2,610 | **43.7%** |
| `summary` | 2,608 / 2,610 | 99.9% |
| `normalized_title` | 2,610 / 2,610 | 100% |
| `experience_level` | 2,610 / 2,610 | 100% |
| `description` | 2,608 / 2,610 | 99.9% |

- The docs' **37%** is wrong. The corrections register's **99.8%** is also wrong. It is **43.7%**,
  and both earlier figures were right about boards that no longer exist.
- **The backlog is 1,470, not 790.** It nearly doubled because the crawl outran enrichment:
  `usage_events` shows **1,373 `enrich_job` events in 30 days**, so the drain is working hard and
  still losing ground.
- The prompt's note holds exactly: *"Only `skills_json` is a real gain — summary,
  normalized_title and experience_level were 1255/1255 from ingestion."* Confirmed, ~100% each.

### e · THEIRSTACK / SERPAPI — **unchanged, action still outstanding**

`THEIRSTACK_API_KEY` is still in `.env`; its only consumers remain `scripts/providerEval/*`, which
is offline. Still an owner action. `SERPAPI_KEY` present; AB-2's "half-wired" premise was already
disproved and nothing has changed it.

---

## 4 · ⛔ The unjudged decision — judged, and the two columns disagree

829 rows are recorded across 40 batches; **787 of them (95%) record at least one in-place
correction**. The prompt's premise is confirmed, not refuted.

*(An earlier pass of this audit reported "zero corrections" from a bad `LIKE` pattern —
`corrected` holds column **names**, not objects. Corrected here rather than quietly fixed.)*

Columns touched across the recorded rows: `summary` 786 · `normalized_title` 478 ·
`experience_level` 312 · `skills_json` 811.

### `summary` — the rewrites are an **improvement**

```
old: About Anthropic

     Anthropic's mission is to create reliable, interpretable, and steerable AI systems. We want…
new: Staff engineer to lead Inference Developer Productivity at Anthropic, owning toolchains,
     dev environments, and CI/CD across multiple accelerator platforms
```

Ingestion stored the same boilerplate paragraph on every posting from a given company. Enrichment
replaces it with something specific to the posting. Unambiguously better; no reason to revert.

### `normalized_title` — the rewrites are **lossy, and it feeds three consumers**

Measured over 200 recorded rewrites with both values present:

| | |
|---|---|
| changed | **200 of 200 (100%)** |
| **shorter than before** | **197 (99% of changes)** |
| longer | 3 |
| **seniority token changed or lost** | **17 (9% of changes)** |

Ten pairs, verbatim:

| old | new |
|---|---|
| staff+ software engineer, inference velocity | staff software engineer, inference |
| staff+ software engineer, identity & access controls | staff software engineer, identity & access controls |
| staff software engineer, gtm systems | **staff software engineer** |
| staff+ software engineer, grc platform | **software engineer, grc platform** |
| staff+ software engineer, experimentation | staff software engineer, experimentation |
| staff+ software engineer, enterprise knowledge work | **staff software engineer** |
| staff+ software engineer, enterprise ai products | **staff software engineer** |
| staff software engineer, education | **staff software engineer** |
| staff+ software engineer, developer productivity | staff software engineer, developer productivity |
| staff+ software engineer, developer experience | staff software engineer, developer experience |

Two distinct losses: the `staff+` → `staff` demotion (and once `staff+` → plain
`software engineer`), and the dropped specialisation suffix.

⛔ **This is not cosmetic.** `normalized_title` feeds:
1. `profileTitleSql` — board membership ranking (CC1);
2. the ATS scorer's `detectSeniority`, which reads the title for `staff|principal|senior`;
3. `roleFamilyForTitle` — which buckets the **term-weight table**, and which I found today is
   already failing to build per-family weights in production.

**Recommendation — and it is the owner's call, not mine:** keep the `summary` rewrites, stop
enrichment writing `normalized_title`. It is 100% covered from ingestion, so enrichment is not
filling a gap there; it is overwriting a good value with a shorter one. That is a one-line change
to the enrichment column set, but it changes the board and the scorer, so it wants its own measured
task.

---

## 5 · Guards that may be blind — candidates only

The four named in the prompt are fixed, and the class now has a standing guard:
`test/sourceAnchorGuard.test.js` fails any test that carves a source region with a bare `indexOf`.
It caught one of **my own** tests today, which is the evidence that it works.

Remaining candidates, by the crude ratio of stub-points to assertions. **This is a heuristic, not a
verdict** — `aj2BoardCursor` looks worst on it and demonstrably passes 16 real assertions through a
different helper:

| harness | stub points | assertions |
|---|---|---|
| `aj2BoardCursor` | 5 | 1 |
| `ah6RecentRunDefault` | 5 | 2 |
| `ak2ApplicationsOutcomeUi` | 3 | 1 |
| `ak2BandSurfaces` | 3 | 2 |
| `abPanelUi` | 7 | 12 |

`ak2BandSurfaces` is the one already caught once (it stubbed `baseAtsScore`, a key the endpoint has
never emitted) and is worth re-reading first. Nothing fixed here, per the prompt.

---

## 6 · Identifier retirement — where a host stays up and an ID dies

| surface | can an ID retire silently? | would anything notice? |
|---|---|---|
| **Anthropic model ids** | yes | **GUARDED** — `PINNED_MODEL_GONE` → `process.exit(1)` at boot (task AD) |
| **Groq model id** | yes | guarded by the same liveness check — boot logs `LIVE` |
| **Google / Gemini id** | yes | ⛔ **NO** — boot logs `UNSUPPORTED — no catalogue endpoint for wire "gemini"`. The liveness check cannot verify it |
| **ATS company slugs (29)** | yes — a slug 404s while the ATS is up | ⛔ **NO per-company signal.** Per-*source* counts are logged; a single dead slug inside a live source is invisible. Lever's three slugs all 404'd once already |
| **Jobo API key / feed** | — | logs `skipped_unconfigured` vs failure vs zero — fixed, but the outcome is still 0 rows ever |
| **Logo host path** (`/ip3/{domain}.ico`) | yes — path shape, not host | ⛔ no check; `backfillCompanyLogos` only repairs *known-retired* hosts |
| **OAuth client ids** | yes | partial — boot logs `configured` / `missing` per provider |

The generalisable gap is unchanged from task X's observation: **host liveness is the easy check and
the rare failure.** The two live holes are the Gemini id and per-company ATS slugs.

---

## Doc corrections needed

1. `CORRECTIONS_REGISTER.md` — the `skills_json` row says 99.8%. It is **43.7%**; both prior
   figures described boards that no longer exist. This is the *third* value for this metric.
2. `NEXT_WORK.md` — test baseline 2,301 → **2,559**; migration 106 → **108**; `skills_json` 99.8%
   → 43.7%.
3. `RECONCILE_AND_RESIDUAL.md` item 3d — backlog "790 candidates" → **1,470**.
4. `DETAIL_FETCH_ECONOMICS.md` — "1,266 active rows · `skills_json` ~37% · `ats_score` 4 of 1,266".
   All three wrong: **2,610 active · 43.7% · `ats_score` 0** (retired by CC5).
5. Anywhere claiming Part 1 was run "2026-09-09" as current — it is superseded by this file.

## Recommended order for Part 2

1. **Stop enrichment rewriting `normalized_title`** (§4). Smallest change, clearest evidence, and
   it feeds the two systems most recently worked on.
2. **The enrichment backlog: 1,470 and growing** (§3d). The crawl is outrunning the drain. This is
   also the binding constraint `DETAIL_FETCH_ECONOMICS.md` names — adding SmartRecruiters/Workday
   before fixing it makes it worse, exactly as that doc warns.
3. **Per-company slug yield** (§6). One aggregation over existing tables; it is the scrape-monitor
   repurpose the prompt says has been deferred "roughly fifteen times".
4. **Jobo: 0 rows ever** (§3a). One look at a production log line.
5. Board order tracking score, and the two-extractors problem — unchanged in priority, but both
   now sit downstream of §1, because `normalized_title` feeds the scorer.
