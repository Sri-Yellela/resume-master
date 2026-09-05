# AL4 — G2 (LCA identity resolution) and G4 (org units)

Run 2026-09-04. Suite **2129 → 2147 passing, 0 failing** (+18). Migration **099**. Spend ~$0.01.

---

## G2 — the gap is not the one the task described

> *"The unmatched 25% are legal-entity vs brand mismatches — META PLATFORMS, INC. vs Meta,
> subsidiaries, DBAs, multiple entities per brand."*

Measured, that is not what they are. Tier A already strips legal suffixes and tier B already reads
`d/b/a` fields, so those cases match today. The six unresolved rows split cleanly, and **the split
decides what a model can even be asked**:

| | companies | candidates in 144,584 employers | can a model help? |
|---|---|---|---|
| **unmatched** | Bolt Farm Treehouse · Epia Neuro · Physical Superintelligence | **zero** | **no** — there is nothing to resolve *to* |
| **ambiguous** | Linear · Mercury · Ramp | real, colliding | **yes** — this is the only place |

`scripts/al4LcaResolution.mjs` therefore **does not ask about unmatched companies at all**. That is
a correctness decision, not a cost saving: a model asked to resolve a company with no candidates
can only invent one, and an invented match here is a sponsorship claim about a company that has
never filed.

### Result

**Like-for-like on the original 20: 14 → 15 matched, 70% → 75%.** One company — Ramp, to
*Ramp Business Corporation*.

The board's own count now reads **17/22 = 77.3%**, but two of the three extra matches are new
companies (Block, Datadog, both tier A), not resolutions. Reporting 77.3% as the gain would be
false.

### The model got the trap right

| company | proposed | model confidence |
|---|---|---|
| Linear | **none of these** | 0.95 |
| Mercury | **none of these** | 0.95 |
| Ramp | Ramp Business Corporation | 0.70 |

The corpus contains `Linear Labs LLC` (electric motors, 17 certified) and `Mercury Insurance
Services, LLC` (89 certified). `lcaMatch.js`'s header records an earlier candidate-set check
attributing Linear.app to the motor company — which has never filed an LCA. **"None" is a
first-class answer in the prompt**, because a model asked to pick from a list will pick from the
list.

Confirmed: Linear (as a recorded *negative*) and Ramp. Mercury left proposed — the fintech really
is `Mercury Technologies, Inc.`, but the model declined and that is the owner's call to overturn,
not mine.

### Tier R is placed, not tuned

Every other tier's confidence is the measured ambiguity of a rule applied to the filing data. **R is
the only tier whose evidence is not in the data at all** — it rests on a person knowing that Ramp is
registered as "Ramp Business Corporation".

```
0.60  PRESENTABLE_MIN   ── below this, never rendered as a statement
0.70  TIER R            ── shown, but with the matched legal entity NAMED INLINE
0.80  HIGH_CONFIDENCE   ── above this, renders as prose with a bare count
0.95  TIER A            ── exact legal-name match
```

A claim resting on outside knowledge must show its working, so the reader can check the entity
themselves. Three further guards, each a test:

- **It never overrides tiers A/B/C.** Where the data answers, the data wins — otherwise one review
  mistake silently replaces the strongest evidence the corpus has.
- **A resolution naming an entity absent from the corpus is refused**, not applied. Otherwise a typo
  becomes a sponsorship claim backed by zero filings.
- **A confirmed NULL is honoured as a decision.** Linear stays ambiguous, but its reason now reads
  *"reviewed by owner: none of the candidates is this company"* — a different fact from nobody
  having looked.

Requirement 3's integrity line is untouched and asserted: the resolution module never references
`is_h1b_sponsor`, and nothing in the company-level path writes a posting's own visa signal. Two
facts, two columns.

---

## G4 — requirements 1 and 5 were already done, and the audit found the real work

`AH4` had already stripped locations before matching and gated the "closest:" suggestion behind
`NAME_CLOSEST_MIN_SIMILARITY`. And the task's premise —

> *"orgLayer.js proposes org units from postings by deterministic parsing. An LLM extracts team
> names better"*

— is **already true**: `scraped_jobs.org_unit_raw` is written by `enrichJob`'s LLM (`orgUnit` in its
prompt), and `orgLayer` only *clusters* it deterministically. There is no deterministic extraction
to replace.

So requirement 2's audit was the work, and it found two things.

### ⛔ 1. AH4's fix had silently reverted on the live database

Its location vocabulary is read from `scraped_jobs.location` — and the retention purge took that
table from 1288 rows to 5.

| | distinct locations | `looksLikeLocation("Bangalore")` |
|---|---|---|
| backup 2026-08-31 | 235 | `true` |
| **live, today** | **4** | **`false`** |

**The exact false finding AH4 was written to remove was live again** — no error, no warning, and a
green test suite.

Because `test/failsafeLocationClaims.test.js` *asserted the broken behaviour*:

```js
assert.equal(looksLikeLocation(db, "Bangalore"), false, "with no corpus there is nothing to know");
```

That was not a degradation being documented. **It was the bug, written down as a guarantee.** A
guard whose evidence is a purgeable table is a guard a cron job can delete.

Fixed with a `SEED_LOCATIONS` floor **unioned beneath** the corpus — never substituted, so a new
market the corpus learns still works exactly as before — plus a once-per-process warning when the
corpus contributes fewer than 25 entries. The warning matters as much as the floor: the regression
was invisible precisely because an empty vocabulary and a healthy one look identical from the call
site. Both just return `false`.

The file's original reasoning against a hand-list ("a second source of truth that goes stale") was
right, and silently assumed the board would continue to exist.

### 2. The same class, running the other way

The region rule was *"starts with a region word"*, so these were classified as **locations**:

`EMEA Marketing` · `APAC Sales` · `UK Enterprise sales team` · `AMER Sales Development` · `AI team`

All real units, sitting in `company_org_units` — **10 of the 697**. `extractTeamClaim` strips
trailing places, so a résumé claiming *"Stripe | EMEA Marketing"* had its team claim **silently
deleted and never checked**. Bangalore produced a wrong finding; this produced *no* finding, which
nothing on any screen can show.

- The region must now be the **whole segment**, or be followed only by another place word
  (`US - Remote`, `EMEA HQ`) — never by a business function.
- The bare two-letter shape is tested against the **raw** segment. `normalizeOrgUnitKey` strips a
  trailing `team`/`org`, so `AI team` → `ai`, which a key-level check read as a country code.

### Requirements 3 and 4, verified

**0 of 697 org units is a location** after the change (was 10). Grep-proved as a test: no module
outside `orgLayer` writes `company_org_units`, and `orgLayer` reads `scraped_jobs` and none of the
seven candidate-owned tables — if a résumé claim could become an org unit, the failsafe would check
claims against a table the claims wrote, and every fabrication would corroborate itself.

Promotion thresholds asserted unchanged: **3 postings, 0.6 confidence**.

---

## What is not done

**G3 (technographic canonicalisation)** is specified as *"apply G1's synonym table"*. With 12
confirmed soft-skill aliases there is almost nothing to collapse, so its expected row-count delta is
near zero — for the same reason G1's rho did not move. It is left open deliberately rather than run
for the sake of a number.

**Mercury** remains an unconfirmed proposal. The model declined; the fintech is genuinely
`Mercury Technologies, Inc.`; overturning a decline is the owner's call.
