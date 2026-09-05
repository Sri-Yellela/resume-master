# AL7 (G3) — technographic canonicalisation

Run 2026-09-05. **Row count 8690 → 8278 (−412, 4.7% collapsed).** Suite **2175 → 2190 passing, 0
failing**. No model calls, no spend.

---

## The dilution is real, and it is not the one the task predicted

G3's example was *"Postgres" and "PostgreSQL" are two entries*. Measured against the corpus:

| pair | present? |
|---|---|
| `postgres` / `postgresql` | **ABSENT** / present |
| `k8s` / `kubernetes` | **ABSENT** / present |
| `js` / `javascript` | **ABSENT** / present |

`enrichJob`'s extraction already emits canonical technology names, so the abbreviation collision G3
describes **does not exist in this data**. The real dilution is case and punctuation:

```
OpenAI  "Infrastructure-as-Code" · "infrastructure-as-code" · "Infrastructure as code"
        "Infrastructure as Code" · "Infrastructure-as-code" · "infrastructure as code"
Stripe  "problem-solving" · "problem solving" · "Problem-solving"
Airbnb  "code review" · "code reviews" · "Code review"
```

Six rows for one thing, each carrying a sixth of the evidence — so every fragment ranks below
skills that happen to have a single spelling.

| stage | rows | delta |
|---|---|---|
| raw | 8690 | |
| normalisation only | 8304 | **−386** |
| + G1's 12 confirmed synonyms | 8278 | **−26** |
| *(+ all 208 proposals — unsafe, not adopted)* | *7940* | *−364* |

### This corrects my own earlier estimate

After G1 I recorded that G3 was *"near-pointless — with 12 soft-skill aliases confirmed, there is
almost nothing to collapse"*. Wrong on two counts:

1. **Normalisation does 94% of the work** and needs no synonym table at all — I had assumed the
   whole task depended on G1.
2. **The 12 confirmed aliases are technographic terms.** `mentoring`/`mentorship` is a real merge
   that reorders a company's stack.

---

## Requirement 2 — row delta and top-20, three companies

Stripe: **2467 → 2338 rows**. `(+n)` marks how many variants merged.

```
 #  BEFORE                              AFTER
 1  communication 146.7                 communication 148.9 (+1)
 2  cross-functional collab. 138.1      cross-functional collab. 140.3 (+1)
 4  relationship building 71.5          problem-solving 73.1 (+2)
 5  problem-solving 57.9                relationship building 73.0 (+2)
12  data analysis 38.9                  mentoring 40.3 (+2)
16  mentoring 23.8                      Python 24.6 (+1)
20  Ruby 21.0                           technical leadership 21.0 (+1)
```

`mentoring` moves **#16 → #12** on merged evidence, `problem-solving` overtakes `relationship
building`, `technical leadership` enters the top 20 and `Ruby` leaves it. **The ordering FE-4's
STACK block renders genuinely changes** — which is what the task was about.

OpenAI: 3502 → 3365. Figma: same pattern, smaller.

---

## Merged at READ, not at write

The obvious implementation collapses the rows in place. This does not, and the reason is specific
to this database rather than general caution:

> `cleanup_log` id 85 deleted 1288 postings, so `skills_json` survives on **5 rows** and
> **`company_technographics` cannot be rebuilt.** The raw variants are now the only surviving record
> of what each posting actually said.

Destroying them to tidy a display would trade irreplaceable provenance for a cosmetic win. A test
asserts nothing writes a merge back into the table.

---

## Requirement 3 — confidence is the merged evidence

`weight` and `posting_count` **SUM**; `last_seen` takes the most recent.

Six spellings seen once each are six postings' worth of evidence. Taking the **MAX** would report
one — which is the dilution this exists to fix, moved one level up. The variant list travels with
every merged entry (`mergedFrom` reaches the client), so a surface can disclose what was collapsed
rather than presenting six postings' evidence as one tidy row.

The posting floor is now computed over **merged** groups, which makes it honest again: before, the
most-reinforced skill might itself be one of six fragments, so the floor under-reported.

> ⚠ **The sum can double-count, and the code says so rather than hiding it.** Until the write path
> was fixed, one posting listing both "problem-solving" and "problem solving" incremented two rows,
> so merging them counts that posting twice. It cannot be corrected after the fact: `posting_count`
> is a bare integer with no per-posting provenance, and the postings are deleted.

---

## The write path was the source

`upsertTechnographics` de-duplicated on the **exact spelling**, so a single posting listing two
spellings of one skill incremented two rows *and* counted itself twice. That is where the 412 came
from.

It now de-dups on the canonical key while still **storing the raw spelling** — only the *decision*
is canonical, the *record* stays verbatim.

## Requirement 1 — build once, use twice

`canonicalSkillKey` is `normaliseAtsTerm` (the ATS scorer's own normaliser) plus G1's **confirmed**
synonyms, one hop, resolved to the lexicographically smallest member so the key cannot depend on
row order.

No second vocabulary — asserted by a test that no `normalise*` function is defined in the module. A
separate one here would let a company's stack and a candidate's match disagree about what a skill
is.

The display name is the **heaviest variant's own spelling**, not the key: the key is lowercased and
stemmed, so rendering it would print "infrastructure as code" and turn "code reviews" into "code
review" on the company card. Ties break on the raw string so the wording is stable across runs.
