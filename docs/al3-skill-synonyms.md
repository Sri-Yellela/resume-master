# AL3 (G1) — the skill synonym table, and the measurement that says it does not work

Run 2026-09-04. Desktop suite **2115 → 2129 passing, 0 failing** (+14).
Migration high-water **097 → 098**. Model spend: **~$0.10** (2 × 18 Haiku calls; the first run's
output was lost — see below).

---

## The headline: rho did not move, and the table has not earned its keep

Requirement 5 said *"If rho does not move, the table is not earning its keep — say so."* Saying so.

| table | ρ | τ-b | mis-ordered |
|---|---|---|---|
| none (control) | **0.737** | 0.593 | 15.9% |
| 12 confirmed pairs | **0.737** | 0.593 | 15.9% |
| all 218 proposals, incl. known-false | 0.747 | 0.603 | 15.2% |

**+0.000 with the reviewed table. +0.010 even if every unreviewed pair were adopted**, and that
figure is contaminated by pairs that are demonstrably wrong.

### Why — measured, not guessed

> **Of 240 missing terms across the graded 30, the proposed table has an equivalent present in the
> résumé for 2 — 0.8%.**

The table cannot move this measurement whatever its quality, because it does not cover the gaps.
G1 was billed as *"the ONLY item on the horizon that moves rho upward rather than sideways"*. On
this graded set, at this corpus, **it does not.**

The two hits were both `cloud infrastructure → terraform`.

### What the extraction actually found

The corpus vocabulary at df ≥ 3 (1062 terms) is dominated by **soft-skill phrasing**, not the
technical aliases the ceiling story was about. The 45 proposed `alias` pairs are things like
`mentoring = mentorship`, `analytic = analytical skill`, `roadmap development = roadmap planning`.
Real, harmless, and irrelevant to whether a backend engineer matches a backend posting.

The AK1 case that motivated the whole task — *"log analysis" vs "observability"* — was **nearly**
found (`log analysi ~ monitoring`, `incident response ~ observability`) but not as that pair.

---

## The safety design earned itself immediately

⛔ **The model proposed false equivalences its own prompt explicitly forbade**, at 25 corroborating
postings each:

| proposed pair | why it is wrong |
|---|---|
| `mysql ~ postgresql` | competing databases. The prompt said *"aws and azure are NOT equivalent — they are competitors, not synonyms"* |
| `ci cd ~ production debugging` | unrelated activities |
| `data engineering ~ data visualization` | different disciplines |
| `backend system ~ c c++` | a system is not a language |
| `customer partnership ~ user research` | unrelated |
| `ai tool ~ llms` | a category is not an instance |

Had corroboration promoted rows the way `company_org_units` does (3 postings, 0.6 confidence),
**every one of these would be live**, silently shifting every posting mentioning either term in the
same direction. A wrong org unit is a wrong label on one company card; a wrong synonym is a wrong
number everywhere at once, with nothing on screen to indicate it.

So this table is **stricter than the rest of the KB, deliberately**:

- **Corroboration never promotes.** Confidence orders the review queue and does nothing else.
- **`confirmSynonym()` is the only path to `confirmed`**, and only `confirmed` rows reach the scorer.
- **Rejection is sticky.** The corpus that produced a bad pair will keep producing it; without this,
  every review decision would have to be re-made every pass and the one that slipped through would
  be the one nobody re-checked.
- **`alias` and `related` are separate claims.** `related` is where the rho would come from and where
  the false matches come from, so it is reviewed harder. A later pass can downgrade `alias` →
  `related` but never the reverse.

## One hop, never transitive

`a~b` and `b~c` must not make `a~c`. Two reviewed equivalences would chain into a third no human
ever saw: *log analysis ~ observability ~ monitoring ~ alerting ~ pagerduty*, and a résumé
mentioning PagerDuty now "has" log analysis. Each equivalent is checked against the résumé
**directly**, through the same adjacency-and-window matcher AK1 added to kill the 22.8% false-match
rate — the expansion is not a second, looser matcher. Pinned by a test.

The scorer stays free, instant and deterministic: it takes a prepared `Map` and never imports the
KB, exactly as it never imports `atsTermWeights`. Asserted.

---

## ⛔ The finding that outranks all of it: the board is gone

**`cleanup_log` id 85 deleted 1288 rows from `scraped_jobs` on 2026-09-02T02:06.**

`scraped_jobs` now holds **5** rows — fixtures. Every derived table still describes the board that
produced them: 8690 `company_technographics`, 856 `ats_term_weights`, 697 `company_org_units`, 1302
`enrich_job` usage events. So every doc's *"1291 postings"* remains true of the **evidence** and is
no longer true of the **table**.

**0 of the 30 graded postings survive.** The JD text is what the scorer reads, so the graded set
cannot be re-scored against the live database at all — this task's own requirement 5 is impossible
there.

This is not a bug in the retention rule (server.js deletes rows older than the cutoff that are
neither applied nor starred; the graded 30 were neither). It is a **consequence nobody had priced**:
the ATS engine's only independent measurement baseline is a set of postings the retention job is
free to delete.

### It is recoverable — from backup, and only just

`data/backups/` retains eight snapshots. Surveyed:

| snapshot | active | with skills_json | graded 30 |
|---|---|---|---|
| 2026-08-20 | 35 | 35 | 3/30 |
| 2026-08-21 | 1254 | 75 | 30/30 |
| 2026-08-22 | 1261 | 1259 | 30/30 |
| **2026-08-31** | **1261** | **1259** | **30/30** |
| 2026-09-02 | 5 | 4 | 0/30 |

**`resume_master_2026-08-31T06-00-00-534Z_auto-daily.db` is the snapshot the grading was done
against** (grading key generated 2026-08-31, profile 6, 4912-char résumé — all present). Both new
scripts read it **read-only**; nothing was restored and the live database was not touched.

> **For the owner:** the 09-02 snapshot is already post-deletion. When backup retention rotates the
> 08-31 file out, ρ = 0.746 becomes an unreproducible number — the engine's only human-graded
> baseline, with no way to re-derive it. Worth pinning that file out of the rotation, or exporting
> the 30 postings' text to `docs/`.

---

## What was built

| file | what |
|---|---|
| migration **098** | `skill_synonyms` — confidence + provenance following `orgLayer.js`, plus `relation` and `status` |
| `services/kb/skillSynonyms.js` | record / confirm / reject / load. Pure SQL, no model call, asserted |
| `services/localAtsScorer.js` | optional `synonyms` Map; one-hop expansion in `hasTerm` |
| `scripts/al3SkillSynonyms.mjs` | the offline pass, the review sheet, confirm/reject |
| `scripts/al3SynonymRhoEffect.mjs` | the before/after measurement, **with a control** |
| `docs/al3-skill-synonym-review.md` | 196 pairs awaiting the owner |

**The control is the part that makes the null result trustworthy.** The no-synonym run reproduces
the published figure — ρ 0.737 vs 0.746, τ-b 0.593 vs 0.594 — so the harness is measuring the
shipped engine. A before/after where only the "after" is trusted is not a measurement, and the
script refuses to report a delta if the control drifts more than 0.02.

### The extraction reads the vocabulary, not the JDs

The task said *"offline pass over the ~1291 active postings' JD text"*. This reads
`scraped_jobs.skills_json` — the per-posting skill terms enrichment already extracted from exactly
those JDs. Deliberate, and it is why the run cost $0.05 rather than ~$3.32:

- it is **the same vocabulary the scorer matches against**, so a pair it produces can actually fire;
  pairs mined from raw prose would name words the scorer never sees;
- 18 calls instead of 1291;
- provenance survives exactly — which postings support a pair is recovered from which postings
  contain the terms.

Given the 0.8% coverage result, mining the raw JD text is the obvious next hypothesis. It would cost
~$3.32 and is **not** recommended before someone decides the ceiling story is still worth chasing.

### Two self-inflicted defects, both now guarded

1. **The first proposal run spent 18 Haiku calls and threw the result away** — migration 098 had not
   been applied to the live database, and the failure surfaced at write time, after the money was
   gone. The script now checks its destination table *before* the first model call.
2. **A corpus pass against the live board would have silently succeeded** on 7 distinct terms and
   reported a table built from nothing. The corpus is now counted, printed, and a board under 200
   postings is a hard refusal naming the backup to use.

---

## Requirement 6 — no model call entered the scoring path

`test/localAtsScorer.test.js`'s existing assertion still holds, and two more were added: the scorer
does not import the KB, and the KB module contains no `callModel`, no `messages.create` and no
`fetch`.

## Requirement 4 — normalisation reused

`normaliseAtsTerm` from the scorer, as the base vocabulary. No third normaliser was written, and
`buildApifyQueriesFromProfile` was not touched.

**A trap worth recording:** the normaliser *stems*. `log analysis` is keyed as `log analysi`, so a
synonym Map assembled from raw strings never matches anything. The first version of the
miss-to-match test did exactly that and "passed" the mechanism while asserting nothing; it now
drives the real KB path, where `canonicalPair` normalises on the way in.

---

## Recommendation

**Do not adopt the table on this evidence.** Twelve conservative aliases are confirmed and live;
they change no score on the graded set and are harmless. 196 pairs await review in
`docs/al3-skill-synonym-review.md`, ten are rejected.

The machinery is built, tested and safe, and it is the right shape for G3 to consume. But the
hypothesis that a synonym table lifts ρ is **not supported at this corpus and this vocabulary**, and
G1's claim to be the only rho-moving item on the roadmap should be treated as **disproved until
someone tries the raw-JD variant** and measures it the same way.

**G3 inherits this.** It is specified as "apply G1's synonym table" — with 12 soft-skill aliases
confirmed, technographic canonicalisation has almost nothing to collapse, and its expected row-count
delta is near zero for the same reason.
