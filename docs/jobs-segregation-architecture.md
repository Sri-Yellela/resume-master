# Jobs Segregation & Filtering — Architecture Plan

**Status:** Proposed (analysis + design; not yet implemented)
**Author:** planning pass
**Scope:** How jobs are classified, bucketed, matched to user profiles, and
filtered — plus a blue-collar eject bucket that removes non-target jobs from
the system entirely.

---

## 1. Use case — what the system is supposed to do

Resume Master is a resume/application product for **white-collar knowledge
workers**. A user picks (or is assigned) a **domain profile** — engineering,
data, design, finance, HR, legal, marketing, operations, PM, etc. Their job
board should show **only jobs relevant to that profile**.

The intended flow:

```
job sources → classify each job into a profile bucket → store →
user with profile P sees only jobs bucketed to P
```

Two failure modes the user reported:
1. **Boards show irrelevant jobs** — a data profile sees PM/ops/sales jobs;
   boards are polluted with off-target roles.
2. **Blue-collar jobs leak in** — driver, warehouse, line cook, trades,
   janitorial, etc. appear in a product meant for resume-based white-collar
   roles. These should be **ejected from the system**, not just hidden.

---

## 2. Current architecture — six mechanisms, two taxonomies

Classification and filtering are spread across six independent pieces of code
that do **not** agree with each other:

| # | File | Produces | Taxonomy | When |
|---|------|----------|----------|------|
| 1 | `services/jobs/classifier.js` → `classify()` | `bucket_role` | **A**: software_engineer, data_scientist, data_engineer, designer, devops, mobile_engineer, product_manager, sales_biz_dev, … (17 keys) | ingest (every job, always assigns, default `other`) |
| 2 | `services/jobClassifier.js` → `classifyTitle()/classifyForIngest()` | `job_role_map.role_key` + confidence | **B**: engineering, data, pm, design, marketing, finance, hr, legal, operations, healthcare, engineering_embedded_firmware (11 keys) | ingest (only if confidence ≥ 0.75) |
| 3 | `services/jobClassifier.js` → `roleTitleSql()` | SQL `LIKE` fragment | **B** (loosely) | query time |
| 4 | `services/jobs/profileMatcher.js` → `scoreJob()` | in-memory rank | **A** via `SKILL_TO_ROLE` | query time (ranking) |
| 5 | `services/profileTitleFilter.js` → `profileTitleSql()` | SQL `LIKE` from user's `target_titles` tokens | free-text tokens | query time |
| 6 | `services/jobs/relevanceFilter.js` → `isResumeRelevant()` | boolean keep/drop | allowlist-vs-blocklist | ingest |

**The two-taxonomy problem is the heart of the rot.** Mechanisms 1 and 4 use
Taxonomy A (`software_engineer`, `data_scientist`, `product_manager`).
Mechanisms 2 and 3 use Taxonomy B (`engineering`, `data`, `pm`). They do not
map to each other. The **domain profiles** users actually pick
(`prompts/layer2_domains/`: data, design, engineering, finance, hr, legal,
marketing, operations, pm_*) align with Taxonomy B — but the in-memory ranker
scores against Taxonomy A's `bucket_role`. So the board is filtered by one
taxonomy and ranked by another.

---

## 3. Root-cause diagnosis — why irrelevant jobs leak

### 3a. Query-time re-derivation is far looser than ingest classification

`roleTitleSql('title', 'pm')` matches titles `LIKE`:
`% manager%`, `%coordinator%`, `%director%`, `%product%`, `%project%`,
`%program%`, `%delivery%`. That means a PM board pulls in:
- "Warehouse **Manager**"
- "Construction **Project** **Manager**"
- "**Delivery** **Coordinator**"
- "Operations **Director**"
- "**Product**ion Supervisor"

The `data` filter matches `% analyst%`, `%data%`, `%scientist%` → "Lab Data
Technician", "Research Assistant", "Inventory Data Clerk" all leak onto the
data board. **Query time re-derives classification with much broader rules
than ingest used, so ingest correctness is discarded.**

### 3b. The relevance gate is allowlist-first with catch-all white-collar terms

`isResumeRelevant()` checks the allowlist **before** the blue-collar blocklist,
and the allowlist contains bare catch-alls:
`/\bmanager\b/`, `/\banalyst\b/`, `/\bcoordinator\b/`, `/\bspecialist\b/`,
`/\bconsultant\b/`. Any blue-collar title carrying one of those words wins the
allowlist and bypasses the blocklist entirely:
- "Warehouse **Manager**" → allowlist hit → **kept**
- "Construction **Coordinator**" → allowlist hit → **kept**
- "Field Service **Specialist**" → allowlist hit → **kept**
- "Logistics **Analyst**" (a real warehouse-floor role at many shops) → kept

So the blocklist that *looks* like it rejects blue-collar work is silently
overridden for any title with a generic white-collar noun.

### 3c. No terminal reject — `other`/`unclassified` jobs still live in the DB

`classify()` defaults unmatched jobs to `bucket_role = 'other'`. Those rows are
still inserted into `scraped_jobs`. `profileMatcher` down-weights `other` to
0.1 when a profile exists, but they remain in the table and surface through:
- the "general" profile board,
- any query path that uses `roleTitleSql`/`profileTitleSql` rather than
  `bucket_role`,
- facet counts and totals.

There is **no mechanism that removes a job from the system**. The closest thing,
`isResumeRelevant`, is leaky (3b) and only runs in the ATS cache warm path —
not necessarily every ingest point.

### 3d. Confidence is computed then ignored

`classifyForIngest` respects a 0.75 confidence threshold for `job_role_map`, but
`classify()` (which fills `bucket_role`) has no confidence concept and always
assigns. The board can be built from either, so the conservative path is
undermined by the always-assign path.

**Summary:** jobs are classified at ingest by one or two systems, then
**re-classified at query time by looser SQL `LIKE` patterns**, with a relevance
gate whose allowlist neutralizes its own blue-collar blocklist, and no way to
actually delete an off-target job. The result is exactly what was reported:
boards full of irrelevant and blue-collar jobs.

---

## 4. Target architecture — classify once, store the verdict, filter by it

**Principle: a job is classified exactly once, at ingest, into a single
canonical verdict that is stored on the row. Every downstream consumer reads
the stored verdict. Nothing re-derives classification at query time.**

### 4a. One unified classifier, one taxonomy

Create `services/jobs/jobTaxonomy.js` as the single source of truth, and a
single entry point:

```js
classifyJob(title, description, company) → {
  collar:     'white' | 'blue',          // gate; 'blue' → eject
  roleKey:    <canonical> | 'unclassified',
  domain:     <industry domain>,         // fintech/healthtech/etc (unchanged)
  seniority:  <level>,
  confidence: 0..1,
  matchedBy:  'strong_anchor' | 'desc_anchor' | 'ambiguous' | 'weak' | 'none',
}
```

**Adopt Taxonomy B as the one true taxonomy** (engineering, data, pm, design,
marketing, finance, hr, legal, operations, healthcare, sales, +
engineering_embedded_firmware). Reasons:
- It already aligns with the domain profiles users actually select.
- It already has the rigorous scoring engine (`classifyTitle`) with strong
  anchors, description anchors, weak signals, exclusions, and confidence.
- It maps cleanly to `job_role_map` which the board query already joins.

Taxonomy A (`bucket_role`: software_engineer/data_scientist/…) is **retired**.
`classify()` and `SKILL_TO_ROLE` are deleted. (Add `sales` to Taxonomy B —
it's currently missing from `jobClassifier.SIGNALS` but present in A.)

### 4b. The collar gate (the blue-collar eject bucket)

New module `services/jobs/collarClassifier.js`:

```js
detectCollar(title, description) → 'white' | 'blue'
```

Logic (two-signal, reject-aware — fixes 3b):

1. Test title against `BLUE_COLLAR_ANCHORS` (word-boundary regex): driver, CDL,
   courier, forklift, warehouse associate/worker/picker/packer, line/prep cook,
   barista, bartender, server, dishwasher, carpenter, electrician, plumber,
   welder, HVAC, roofer, landscaper, janitor, custodian, housekeeping, security
   guard, cashier, stocker, retail associate, farm worker, mover, home health
   aide, nanny, hairdresser, barber, nail tech, etc. (seed from the existing
   blocklist in `relevanceFilter.js`).
2. If **no** blue anchor → `white` (default-include, unchanged behavior).
3. If a blue anchor **is** present, test for a **strong white-collar role
   anchor** (the `strongAnchors` from `jobTaxonomy` SIGNALS — "engineer",
   "analyst", "scientist", "attorney", "accountant", "designer", "counsel",
   etc.). If a strong white anchor is also present → `white` (so "Warehouse
   Operations **Analyst**", "Fleet **Software Engineer**" stay white).
4. Otherwise → `blue` (eject).

This inverts the broken precedence in 3b: a generic noun like "manager" no
longer rescues "Warehouse Manager"; only a **strong role anchor** does. Pure
supervisory blue-collar titles ("Warehouse Manager", "Restaurant Manager",
"Construction Superintendent") resolve to `blue` by default — a policy choice
appropriate for a white-collar resume product, and tunable (see 4f).

### 4c. Eject mechanism — remove from the system

When `classifyJob().collar === 'blue'`, at **every ingest point**:
- **Do not insert** into `scraped_jobs` or `job_role_map`.
- If the `job_id`/`url` already exists (prior runs), **DELETE** from
  `scraped_jobs` and `job_role_map`.
- Record a compact row in a new **`rejected_jobs`** audit table:
  `(job_id, title, company, source, reason, rejected_at)` — no description, so
  it stays tiny. Purpose: let admins audit false-positives and tune the anchor
  lists. Rotated/capped (e.g. keep last 5k rows).
- Increment an in-memory + persisted counter per source for observability.

"Throw them out of the system every time a job is sorted into it" → satisfied:
the job never persists as a live job, and any previously-cached copy is deleted
on next encounter. The audit table is not a live job store; it's a tuning log.

### 4d. Storage — the row carries its own verdict

`scraped_jobs` already has `bucket_role`, `bucket_seniority`, `bucket_domain`.
Repurpose:
- `bucket_role` ← canonical `roleKey` (Taxonomy B) — **not** the retired A keys.
- `bucket_seniority` ← `seniority`.
- `bucket_domain` ← `domain`.
- Add `classification_confidence REAL` and `collar TEXT` columns (migration).

`job_role_map` remains the join table for query-time filtering; it is written
from the same single verdict (no more separate `classifyForIngest` pass with a
different code path).

Jobs with `roleKey === 'unclassified'` (white-collar but not confidently
bucketed): stored, mapped to role_key `general`, surfaced **only** on the
"general" profile board — never injected into a specific profile's bucket.

### 4e. Query time — read the stored verdict, delete the LIKE re-derivation

Board for a profile resolving to role_key `R`:

```sql
SELECT j.*
FROM scraped_jobs j
JOIN job_role_map m ON m.job_id = j.job_id
WHERE m.role_key = @R
  AND j.url NOT IN (<disliked>)
ORDER BY j.scraped_at DESC
LIMIT @n OFFSET @off
```

- **Delete `roleTitleSql()`** (mechanism 3) — the looser-than-ingest LIKE
  re-derivation that caused 3a. (Keep behind a feature flag only during the
  migration window for jobs not yet in `job_role_map`; remove after backfill.)
- `profileTitleSql()` (mechanism 5) becomes an **optional, additive** narrowing
  *within* a correctly-bucketed board (user typed specific target titles), never
  the primary role gate.
- `profileMatcher.scoreJob()` keeps ranking **within** the board (recency,
  location, seniority, salary) but its `role_match` term and `SKILL_TO_ROLE`
  map are deleted — the board is already role-correct from the SQL join.

### 4f. Tuning & policy surface

- Anchor lists (blue-collar, strong-white) live in one module with clear
  comments and are unit-tested with labeled fixtures.
- Optional admin endpoint to (a) view recent `rejected_jobs`, (b) flag a
  false-positive, (c) add a title to an allow-exception list. This closes the
  loop so the lists improve from real data instead of guesswork.
- The "supervisory blue-collar" policy (Warehouse Manager etc.) is a single
  documented switch, defaulting to eject.

---

## 5. Data model changes

```sql
-- migration NNN_jobs_segregation.sql

ALTER TABLE scraped_jobs ADD COLUMN collar TEXT;                  -- 'white'|'blue' (blue rows never persist; column documents white)
ALTER TABLE scraped_jobs ADD COLUMN classification_confidence REAL;

CREATE TABLE IF NOT EXISTS rejected_jobs (
  job_id      TEXT PRIMARY KEY,
  title       TEXT,
  company     TEXT,
  source      TEXT,
  reason      TEXT,            -- 'blue_collar' | future reasons
  rejected_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rejected_at ON rejected_jobs(rejected_at);

-- job_role_map unchanged in shape; now always written from the unified verdict.
```

---

## 6. Migration / backfill

1. Ship the unified classifier + collar gate behind the ingest path.
2. **Backfill pass** (`scripts/reclassifyJobs.js`): iterate all `scraped_jobs`,
   run `classifyJob` on each:
   - `collar === 'blue'` → move to `rejected_jobs`, DELETE from `scraped_jobs`
     + `job_role_map`.
   - else → rewrite `bucket_role/bucket_seniority/bucket_domain/collar/
     confidence`, upsert `job_role_map` with canonical `roleKey`.
3. Report: counts ejected per source (expect Adzuna + SerpAPI to dominate),
   counts reclassified, counts now `unclassified`.
4. Flip the board query from `roleTitleSql` to the `job_role_map` join; remove
   the LIKE re-derivation once backfill confirms full coverage.

---

## 7. Testing

- **Collar fixtures** (`test/collarClassifier.test.js`): labeled set —
  "Delivery Driver"→blue, "Warehouse Associate"→blue, "Line Cook"→blue,
  "Warehouse Operations Analyst"→white, "Engineering Manager"→white,
  "Security Engineer"→white, "Construction Project Manager"→blue (policy),
  "Field Service Engineer"→white, etc.
- **Taxonomy fixtures**: extend `test/jobClassifier.test.js` with the merged
  taxonomy (add sales; verify A-keys gone).
- **Query isolation** (extend `test/profileIsolation.test.js`): a data profile
  must return zero PM/ops/sales rows from a seeded mixed set.
- **No-leak regression** (`test/jobsPipelineHardening.test.js`): seed 50 mixed
  blue/white jobs, run ingest, assert blue count in `scraped_jobs` == 0 and in
  `rejected_jobs` == seeded blue count.

---

## 8. Rollout phases (each its own commit + verification)

- **P1** — Add `jobTaxonomy.js` (unify taxonomy, add `sales`) + unit tests.
  No behavior change yet (classify() still in place, delegates to it).
- **P2** — Add `collarClassifier.js` + `classifyJob()` + tests.
- **P3** — Migration: `collar`, `classification_confidence`, `rejected_jobs`.
- **P4** — Wire the collar gate + unified verdict into **all** ingest points
  (grep `INSERT INTO scraped_jobs`; cover `aggregator.cacheJobs` and the
  server scrape/search flow). Eject blue at ingest.
- **P5** — Backfill script; run; report ejected/reclassified counts.
- **P6** — Switch board query to the `job_role_map` join; retire
  `roleTitleSql`; delete Taxonomy A (`classify()`, `SKILL_TO_ROLE`); demote
  `profileTitleSql` to additive-only.
- **P7** — Admin rejected-jobs view + false-positive flagging (optional, can
  follow later).

Each phase is independently verifiable and reversible. P1–P3 are non-breaking
(additive). The behavior change lands at P4 (eject) and P6 (query switch).

---

## 9. What this fixes, mapped to the report

- "Boards display all sorts of irrelevant jobs" → fixed by P6: boards read the
  authoritative `job_role_map` role_key instead of loose query-time `LIKE`
  re-derivation; one taxonomy end to end.
- "Create a blue-collar bucket and throw them out every time" → P2+P4: the
  collar gate classifies blue-collar and the ingest path ejects them (never
  persisted; prior copies deleted), with a tuning audit log.
- "Devise a plan that works, need not stick to current approach" → the six
  mechanisms collapse to: one classifier → one stored verdict → one query
  filter → one in-board ranker. Two taxonomies become one.
