# AM1 — Task R: recovery

**Date:** 2026-09-05 · **Suite:** 2245 passing, 0 failing (was 2090 at the last reconcile)

The one item in the queue that got worse while nothing happened. It no longer does.

---

## R1 — the evidence is preserved, and rho reproduces from a committed file

### R1.1 · the backup is out of the rotation

```
source          data/backups/resume_master_2026-08-31T06-00-00-534Z_auto-daily.db  (110.6 MB)
sha256          ad8b5c29adf3a23714871e8182f4e0f76cab360dd1d7f05b99e6c82d2a9ccffc
pinned copy     data/evidence/resume_master_2026-08-31T06-00-00-534Z_auto-daily.db
sha256(copy)    ad8b5c29adf3a23714871e8182f4e0f76cab360dd1d7f05b99e6c82d2a9ccffc  ✓ hashed independently
```

`scripts/backup.js` only ever unlinks paths it joins directly onto `data/backups/` from
`manifest.json`, plus sidecars matching `.db-shm`/`.db-wal`. `data/evidence/` is unreachable from
it. The copy is hashed separately from the source and compared — reporting the source hash for the
destination would certify a file nobody read.

**It had one backup left.** `scripts/am1PreserveGradedCorpus.mjs` computes that rather than
asserting it: it imports the real `selectRetained()` and replays the manifest forward, prepending
one auto-daily entry the size of the live DB per step.

```
retention       survives 1 more auto-daily backup before selectRetained() drops it
```

Eight backups, 498 MB, against a 512 MB budget and 110 MB files. The next 02:00 cron evicts
2026-08-25; the one after that evicts 2026-08-31. **Roughly 48 hours.**

### R1.2 · the 30 graded postings are committed

`docs/am1-ats-graded-corpus.json` — 30/30 postings, all graded, 136 KB of description text, with
provenance and the corpus checksum recorded inside the file.

The grades were already committed (`ak2-ats-grading-key.json`, `ak2-ats-grading-set.md`). **The
postings they grade were not**, and the scorer reads the description, so the grades alone could
re-score nothing.

`ak2-ats-grading-set.md` does carry description text and is **not** a substitute: measured, every
one of its 30 descriptions is truncated to **1400 characters** (min 1399, max 1400) against a real
mean of 4652. It is a reading aid for a human grader, not a scorable corpus.

The fixture also states what it does **not** contain: scoring still needs `domain_profiles` id 6,
its base résumé, and `ats_term_weights`. Those survived the purge (they are not `scraped_jobs`
rows), and if a future purge takes them, they are the next thing to export. That is written into the
JSON rather than into a doc that can drift away from it.

### R1.3 · rho reproduces — 0.737, from the committed file

```
$ node scripts/am1GradedCorpusVerify.mjs

profile         id 6, résumé 4912 chars (key recorded 4912)
term weights    856 rows
live board      5 postings   (purged — which is why this reads the fixture and not scraped_jobs)

A. PER-POSTING   26 of 30 postings score differently (max |delta| 40)
B. AGGREGATE     published    rho 0.746   tau-b 0.594   mis-ordered 12.2%
                 from fixture rho 0.737   tau-b 0.593   mis-ordered 15.9%   n=30

✓ REPRODUCED — drift 0.009, tolerance 0.02
```

Cross-checked against `scripts/al3SynonymRhoEffect.mjs`, which scores the same 30 out of the
**110 MB backup**: `rho 0.737, tau-b 0.593, mis-ordered 15.9%` — identical to three decimals. The
committed 200 KB file and the 110 MB database are the same evidence for this purpose.

**Two things are true at once and both are reported.** The aggregate reproduces; **26 of 30
individual scores have moved**, by up to 40 points (posting 12, Figma's Winter-2027 intern role,
60 → 20 — the seniority guard landing after grading, doing exactly its job). The engine changed and
preserved the ordering. A run that reported only the aggregate would have hidden that, so
`am1GradedCorpusVerify.mjs` prints both and they can fail independently.

`al3SynonymRhoEffect.mjs` was already treating a 0.009 gap as "CONTROL OK". That is a fair
tolerance, and it is worth saying plainly that **the published figure is 0.746 and today's engine
gives 0.737** on the same data.

---

## R2 — what happened, and what it left behind

### R2.4 · `cleanup_log` id 85

```
the pass          id 85, ran 2026-09-02 02:06:12Z, jobs_deleted 1288, orphans 6
its cutoff        scraped_at < 2026-08-26 02:06:12Z   (run_at minus 7 days)
the trigger       STARTUP cleanup (server.js app.listen -> setImmediate), NOT the 03:00 cron
                  0 of the last 14 passes ran on the hour; the rest are restarts
the board then    1291 rows, of which 1291 were older than the cutoff (100.0%)
arrivals          2026-08-24: 1251   2026-08-21: 27   2026-08-23: 9   2026-08-22: 4
```

**Was it intentional?** The predicate was, and it was correct — not one row was expired wrongly.
Deleting 99.8% of the board unattended was not: there was no confirmation, no dry run and no cap,
**because the DELETE was the first thing in the pass that knew how big it was.**

**Root cause: deletion and refill share one point of failure.** The startup pass exists to catch the
window in which the server was down — which is exactly the window in which nothing was scraping
either. On boot the cleanup fires from a `setImmediate`; the crawl is up to a day away and only if
the process lives that long. 1251 of the 1291 postings arrived in a single burst on 2026-08-24 and
nothing arrived after it, so when the cutoff swept past that day it took everything at once. A
7-day expiry is sound for a board refilled daily; bolted to a refill that stops when the process
does, it empties the board in proportion to downtime.

**Can it fire again?** The rule can — every boot and every 03:00 — and it will, whenever the board
goes seven days without a crawl. **The outcome cannot.**

`services/jobs/cleanupBrake.js` counts the pass before running it and refuses to delete more than
50% of a board over 50 rows. Refused rows are **retired** (`is_active = 0`) rather than deleted:
they leave discovery, which is true of them, and the text survives, which keeps the decision
reversible. The refusal is written into `cleanup_log.details` — a pass that declined must be as
findable as id 85 was, or the next reader sees `jobs_deleted: 0` and concludes there was nothing to
do. `CLEANUP_ALLOW_MASS_DELETE=1` is the explicit confirmation this pass never had.

The brake ignores boards at or under 50 rows on purpose. Clearing 5 fixtures on a dev machine is not
an incident, and a confirmation that becomes routine is not a confirmation.

`test/cleanupBlastRadius.test.js` builds the incident's board at its real scale — 1291 rows, 1251
from the 2026-08-24 burst, 3 starred — and runs it **both ways**:

| | deleted | rows left |
|---|---|---|
| without the brake | **1288** | 3 |
| with the brake | 0 | **1291** (1288 retired, 3 active) |

The first row is the control. Without it, "the brake kept 1291 rows" could be true because the
fixture had nothing to delete.

### R2.5 · every derived table against the current 5-row board

`node scripts/am1PurgeImpactAudit.mjs` — read-only, nothing re-derived.

| table | live | corpus | state |
|---|---|---|---|
| `company_technographics` | 8690 | 8690 | INTACT but STALE |
| `company_org_units` | 697 | 697 | INTACT but STALE |
| `ats_term_weights` | 856 | 856 | INTACT but STALE |
| `company_hiring_signals` | 40 | 40 | INTACT but STALE |
| `job_role_map` | 5 | 1291 | ⛔ **LOST 1286 rows** — cascaded with the postings |
| `skill_synonyms` | 218 | — | built after the snapshot, from the corpus |
| `company_lca_sponsorship` | 22 | 20 | unaffected — DOL dataset, not the board |
| `lca_employer_periods` | 481588 | 481588 | unaffected — DOL dataset, not the board |
| `company_ats_list` | 15 | 15 | unaffected — static |

The audit classifies by `derivedFrom`, not by row count. Counting alone would have reported
`lca_employer_periods` and `company_ats_list` as casualties: they also match their snapshot exactly,
and for them that means nothing happened.

**Recoverable by re-derivation against the live board? No — for every posting-derived one.**
Re-derivation reads `scraped_jobs`. With 5 fixtures it produces an answer about those 5 and
overwrites an answer about 1291. The stale table *is* the surviving copy of the derived data, so
that second loss would be the irreversible one.

**Recoverable from the preserved corpus? Yes — all of them.** The text is what they need, and
`data/evidence/` has it.

Only `job_role_map` actually lost rows, cascaded on `job_id NOT IN (SELECT job_id FROM
scraped_jobs)`. It is one row per posting and is trivially re-derivable — from the postings, which
are in the backup.

### R2.6 · nothing was re-derived, and two clocks were stopped

Requirement 6 said report first. Nothing here re-derives anything. But **two of these derivations do
not wait to be asked**, and reporting a risk that fires on a cron at 04:00 is not the same as
handling it, so the automatic paths are now guarded (`services/jobs/boardSufficiency.js`).

| | when | risk | now |
|---|---|---|---|
| `runHiringSignalsRollup` | **04:00 cron** | ⛔ **live** | guarded |
| `runOrgLayerRollup` | **04:00 cron** | none today | guarded anyway |
| `computeTermWeights` | manual script | ⛔ **worst case** | guarded |
| `reconcileCompanyLca` | manual script | coverage only | reported |

**The live one.** `runHiringSignalsRollup` upserts on `(company, window_end)` with `window_end =
now`, so every pass writes a *new* row — and `getHiringSignals` reads `ORDER BY window_end DESC
LIMIT 1`. One unattended pass over the five fixtures would therefore have made **"Stripe: 1 open
role"** the current answer for the company panel, with the true snapshot (`open_count = 444`) still
in the table underneath it where nothing would read it. Not a deletion; a false claim about the
world laid over a true one. The five fixture companies are Stripe, Block, Datadog, Figma and
Physical Superintelligence.

**The worst case.** `computeTermWeights` opens with `DELETE FROM ats_term_weights` inside the
rebuild transaction. One `node scripts/recomputeAtsTermWeights.js` would trade 856 measured weights
for whatever four fixtures yield. The scorer would carry on, silently neutral, and rho would stop
being reproducible.

**The one that is fine.** `runOrgLayerRollup` never deletes, never demotes a confirmed unit, and
touches only clusters it re-derives — and all five fixtures have `org_unit_raw = NULL`, so today it
writes nothing at all. Guarded regardless: that is a fact about today's rows, not about the
contract, and the 697 units exist nowhere else.

**Two rules, because the two failures differ.** `assessBoardSufficiency` is a floor on the input
(200 active postings, the same figure `al3SkillSynonyms.mjs` already refuses below — two thresholds
for "is this a corpus?" would be two answers to one question). `assessRebuildScope` bounds the blast
radius of a wholesale rebuild by comparing what is about to be written against what is about to be
destroyed. The second is the right rule for `computeTermWeights` and it has a property the first
lacks: it is inert on an empty table, so the real guard runs in unit tests over small fixtures
instead of being opted out of exactly where it would first be exercised.

`ALLOW_THIN_BOARD_DERIVATION=1` overrides either. Only a literal `1`/`true`: a bare truthiness check
on the string would read `"0"` and `"false"` as permission.

---

## R3 — the silent reversion

### R3.7-9 · already fixed, verified against the live board

Landed in `ac25de2` (G4), which found the reversion while doing something else. Confirmed here
rather than taken on trust — run against the real 5-row database:

```
looksLikeLocation(db, "Bangalore")           -> true
looksLikeLocation(db, "Dublin")              -> true
looksLikeLocation(db, "Remote")              -> true
looksLikeLocation(db, "Payments Infrastructure") -> false
[failsafe] the location vocabulary drew only 1 entries from scraped_jobs (expected 200+) ...
```

- **7** — the vocabulary fell from 235 distinct locations to 4. `SEED_LOCATIONS` is a floor the
  corpus **extends** rather than constitutes, so "Bangalore" is known with no corpus at all.
- **8** — `failsafeLocationClaims.test.js` now asserts `=== true`, with the old
  `=== false` / *"with no corpus there is nothing to know"* quoted in place above it as what it was:
  the defect written down as a guarantee.
- **9** — the structural fix, plus a once-per-process warning, because the regression was invisible
  precisely in that an empty vocabulary and a healthy one look identical from the call site.

### R3.10 · the audit — measured, not grepped

The question "which behaviours depend on a table being populated?" is answerable by running them.
The audit executes 11 read surfaces against **both** the purged live database and the 1291-posting
corpus and compares the answers.

```
probe                             live (5)      corpus (1291)  verdict
looksLikeLocation('Bangalore')    true          true           agrees
looksLikeLocation('Dublin')       true          true           agrees
looksLikeLocation('Payments Infra') false       false          agrees
consistency(Stripe, résumé)       no_claim      no_claim       agrees
suggest(title, 'soft')            1             8              ⚠ DIFFERS
suggest(location, 'san')          1             8              ⚠ DIFFERS
loadTermWeights().size            594           594            agrees
companyProfile(Stripe).hasData    true          true           agrees
companyProfile(Stripe) stack      12            12             agrees
companyProfile(Stripe) orgUnits   275           275            agrees
hiringSignals(Stripe).open_count  444           444            agrees

2 of 11 probes disagree.
```

**The first version of this table was wrong and said everything agreed.** Two modules memoise —
`failsafe.js` caches the location vocabulary, and `searchSuggestions.js` caches its index **by
roleKey alone, not by database**. Neither is a product defect (one process serves one database), but
a harness handing two databases to the same module gets the first one's answer back for the second.
`suggest` reported `8` against a five-row board. Both memoisations are now defeated per probe, and
the note is in the script, because a harness that agrees for the wrong reason is the exact failure
this audit exists to catch.

**The two that differ are not the same defect as Bangalore.** The suggestion index offers nothing
rather than asserting something untrue. A degraded feature is not a false finding, and the fix for
it is a corpus, not a floor.

**No other test in the suite asserts a bug as a guarantee.** Swept `test/` for assertions whose
truth depends on data being absent; `failsafeLocationClaims.test.js` was the only one, and it has
been re-pinned.

---

## Files

| | |
|---|---|
| `scripts/am1PreserveGradedCorpus.mjs` | pins the backup, exports the fixture, forecasts retention from the real policy |
| `scripts/am1GradedCorpusVerify.mjs` | re-scores the 30 from the committed file; per-posting and aggregate, separately |
| `scripts/am1PurgeImpactAudit.mjs` | forensics, derived-table state, the differential audit. Read-only |
| `docs/am1-ats-graded-corpus.json` | **the durable artefact** — 30 postings, full text, grades, provenance |
| `services/jobs/cleanupBrake.js` | bounds one expiry pass |
| `services/jobs/boardSufficiency.js` | bounds derivations over a purged board |
| `test/cleanupBlastRadius.test.js` | the incident reproduced at 1291 rows, both ways |
| `test/derivationsRefuseAPurgedBoard.test.js` | each derivation refuses, and the previous output survives |

`am1PreserveGradedCorpus` and `am1PurgeImpactAudit` are excluded from `verify:harness` with reasons
(one copies 110 MB and rewrites a docs fixture; the other asserts nothing). **`am1GradedCorpusVerify`
stays in the suite** — it is the half that makes a claim, and it exits 1 if rho stops reproducing.

## Still the owner's

- **`data/evidence/` is untracked and on one disk.** The 30 graded postings are in git and that is
  what the measurement needs. The other 1261 postings, 8690 technographics and 697 org units exist
  in exactly one place. Off-machine is the only thing that fixes that.
- **The board is still 5 rows.** Nothing here refills it. Every derivation is now blocked until it
  is, which is correct but is a hold, not a repair.
- **The 07:00 re-scrape cron was removed in §5.12** (dead by data flow — `user_job_searches` has no
  writers). With it gone, `POST /api/admin/db/force-scrape` is the only thing that refills the
  board, so "seven days without a crawl" is now the resting state rather than an outage.
