# AK1 Phase 3 — Is the ranking honest?

Phase 2 without this is untested opinion. Every number here is a real run against the live board
(1291 postings, `data/resume_master.db`) under `local_ats_v4`.

**Headline: Spearman ρ = 0.504, Kendall τ-b = 0.357, and 31.6% of pairs are still mis-ordered.**
That is a real, moderate correlation — clearly better than chance, clearly not good enough to
present as a confident number. The inversions below say exactly where it breaks and why.

---

## 0. What this evaluation is, and the one thing it is not

30 postings, stratified evenly across the engine's score range, then shuffled before judging. I
recorded a fit judgement for each from its title and job description **before seeing any engine
score**, then joined the two.

**The judgements are mine — a model's — not an independent human's.** The brief asked for human
judgement and this is the honest substitute, not a stand-in for it. It shares a failure mode with
the thing it grades: both read the same text, so anywhere the posting's *wording* misleads, it may
mislead us both, and the correlation would be flattered. The inversions in §2 are the durable part
of this phase; ρ is the summary. A human pass over the same 30 would be worth doing and would
mostly confirm or move §2, not §1.

The evaluation set is **pinned by title+company**, not re-drawn per run. An earlier version re-drew
the stratified sample after each scorer change, which silently re-selected different postings and
made two runs incomparable. A fixed set is the only way an A/B here means anything.

The profile scored against is a realistic senior backend engineer (Python/Go/K8s/AWS/distributed
systems, 7 years), written for this evaluation. The one profile on the live board carries a
placeholder resume (`john doe fakeemail gmail com`) that matches almost nothing, which would have
confounded "is the ranking good" with "is this resume empty".

## 1. Rank correlation, and what each change actually bought

| variant | Spearman ρ | Kendall τ-b | mis-ordered pairs |
|---|---|---|---|
| v3 (before AK1) | — | — | — |
| v4 as committed in Phase 2 | 0.448 | 0.322 | 33.6% |
| **+ ambiguous-token fix (shipped)** | **0.504** | **0.357** | **31.6%** |
| + component renormalisation (**measured, rejected**) | 0.242 | 0.176 | 41.0% |

Independently, over all 1291 postings, AUC for "ranks an engineering role above a non-engineering
one" given a backend resume moved **0.700 (v3) → 0.719 (v4 structural) → 0.725 (v4 weighted)**.

### The rejected change is the most useful result in this phase

Experience contributes a flat 85% of its budget when a posting states no years requirement — which
most do. That puts a constant under every score, and it is why a zero-overlap job still floors
around 26. The obvious fix is to **renormalise**: drop a component that carries no information from
both numerator and denominator.

I implemented it. It made the ranking substantially worse — **ρ 0.448 → 0.242**.

The reason is worth keeping, because it is counter-intuitive:

- It did lower the floor correctly. `Community & Culture Program Manager` 26 → 10, `Staff UX
  Researcher` 30 → 9.
- But it also amplified the **skill component's noise**, and skill recall on this corpus is poor —
  postings describe requirements abstractly ("multiple programming languages", "full-stack software
  engineering") that no concrete resume matches lexically. Excellent matches collapsed with the bad
  ones: `Software Engineer, Payments, Risk` 28 → 12, `TechOps Integration Reliability` 23 → 5.
- Worst, it handed the ranking **back to the experience flag from the other direction**. Postings
  that *do* state a satisfied year requirement kept a full-weight component and floated up, which is
  how a Fraud Strategist and two Sales Manager roles came to outrank a backend engineering job.

A constant under every score is a **floor**, which is cosmetic. A component whose weight depends on
whether the posting happened to mention years is a **ranking** problem, which is the one that
matters. The flat rate stays until skill recall can carry the extra variance. This is recorded in
`services/localAtsScorer.js` with the numbers, and asserted in a test, so it is not re-attempted.

## 2. Every inversion, diagnosed

Flagged where engine rank and judged rank differ by ≥8 places out of 30.

### Engine too HIGH — the expensive direction

| eng | judged | posting | diagnosis |
|---|---|---|---|
| 40 (#3) | 15 (#18) | Fraud Strategist @ Stripe | **Real term overlap, wrong discipline.** Genuinely matches `Python`, `SQL`, `machine learning` — all on the resume. The engine has no concept of the *role* those skills are being asked for. Also holds a satisfied 5-year requirement. |
| 33 (#5) | 18 (#17) | Data Analyst @ Stripe | Same cause. Python/SQL overlap with an analytics role. |
| 31 (#8) | 10 (#21) | TPM, Rack Delivery @ OpenAI | Generic competency matches (`strategy`, `planning`) plus a satisfied years requirement. Zero real skill overlap. |
| 30 (#9) | 12 (#19) | PM, Developer Platform @ Figma | `API design` matches genuinely — the PM owns an API product. Vocabulary is right, role is not. |
| 27 (#15) | 1 (#29) | Tax Director @ OpenAI | Matched exactly `planning` + the competency `strategy`, out of 21 scored terms. The other 19 are tax vocabulary. Ratio is near-zero yet the floor holds it at 27. |
| 26 (#18) | 2 (#26) | Staff UX Researcher @ Airbnb | Was **#11 before the ambiguous-token fix** — the registry admitted `Go` from the English word "go". Now only the `strategy` competency. Residual is pure floor. |
| 26 (#18) | 1 (#29) | Community & Culture PM @ Airbnb | **Zero skills matched and zero skills missing** — the skills bucket is empty. One generic competency out of nine. Everything else is floor. |

**One root cause dominates: the floor.** Experience (flat 85%) plus a generic competency or two puts
~26 under any posting, however irrelevant. Five of the seven would rank correctly if the floor were
gone — and §1 explains why removing it naively costs more than it saves.

**A second, narrower cause:** the competency `strategy` matched on four of these seven, off the
resume's "drove technical strategy". It sits below the DF floor (`MIN_DF=5`) so it carries neutral
weight rather than being demoted. That is the weighting working as designed and the design being
wrong for this term — a competency generic enough to appear across four unrelated disciplines
should be damped by *genericness*, which document frequency in a 1289-posting corpus is too coarse
to detect.

### Engine too LOW — the recall direction

| eng | judged | posting | diagnosis |
|---|---|---|---|
| 23 (#25) | 70 (#6) | TechOps Integration Reliability Eng @ Stripe | **Worst inversion, −19 ranks.** 22 scored terms, exactly one matched (`SQL`). The JD asks for `log analysis`, `code debugging`, `API troubleshooting`, `anomaly detection systems`. The resume says "Instrumented services with observability tooling" — the *same work*, zero lexical overlap. |
| 28 (#13) | 92 (#3) | SWE, Payments/Risk @ Stripe | Only 9 scored terms, and they are abstractions: `full-stack software engineering`, `multiple programming languages`, `data analysis and SQL`. A concrete resume cannot literally contain "multiple programming languages". |
| 21 (#26) | 40 (#12) | Network Operations Engineer @ OpenAI | Infra overlap (K8s, Linux, on-call) described in networking vocabulary. |
| 25 (#21) | 45 (#11) | Forward Deployed Engineer, GTM @ Notion | Engineering work described in go-to-market language. |
| 20 (#28) | 20 (#16) | Camera SWE, Consumer Devices @ OpenAI | Judged and scored the same (20); the rank gap is a tie artifact, not a real inversion. |

**Single root cause: lexical matching cannot see that "observability tooling" ≡ "log analysis".**
This is the ceiling on the whole approach, and it is the strongest argument in this work for the
conservative semantic-equivalence layer the brief asks for — a synonym table covers `JS`/`JavaScript`
and `K8s`/`Kubernetes`, but not this. The honest statement is that these five inversions are not
fixable by re-weighting; they need either embeddings or a much richer equivalence vocabulary, and
both carry the false-equivalence risk the brief warns costs the most trust.

## 3. Adversarial cases — all four behave correctly

Asserted in `test/atsRankingHonesty.test.js` on synthetic postings (the live board is not in the
repo, and a test that passes when the DB is absent proves nothing). Live-board numbers here.

**1. A senior role far above the profile.** With term overlap held identical and only the years
changed, the over-levelled posting scores lower. On the board, against a 7-year profile:

```
Staff Engineer, Core Infrastructure   (3+ yrs)   senior 42   junior 18
Staff Engineer, Revenue & Finance     (12+ yrs)  senior 18   junior  2
```

A 12-year ask correctly collapses a 7-year candidate to 18. The junior profile scores below the
senior one on every senior posting. **The engine is not measuring vocabulary alone here.**

**2. A different discipline sharing vocabulary.** Four Python-heavy data roles against four backend
roles, same backend resume: **mean data 32.0 vs mean backend 41.8.** Correct on average — but the
ranges overlap (`Backend Engineer, Billing/Tax` scores 17, below every data role), which is the same
weakness §2 diagnoses. Directionally right, not cleanly separable.

**3. Mostly company boilerplate.** Declines outright:
`score=null, scorable=false, "Only 0 scorable terms could be extracted from this posting."`
Under v3 this returned ~50, because `ratio()` yields 1 on an empty denominator.

**4. Near-duplicate postings from the same company.** Stable:

```
n=5  spread 26..28  sd 0.75   Applied AI Engineer @ OpenAI
n=4  spread 25..25  sd 0.00   Applied AI Architect @ OpenAI
n=3  spread 25..30  sd 2.36   Applied AI Engineer, Cyber @ OpenAI
n=3  spread 24..25  sd 0.47   Applied AI Engineer, Digital Natives @ OpenAI
```

## 4. Consistency — asserted, not assumed

`test/atsEngineWeighting.test.js` scores the same job/resume pair ten times and asserts the full
report is byte-identical, weighted and unweighted. The scorer makes no model call, reads no clock,
and iterates no unordered structure whose order it depends on.

## 5. Ground truth — recordable now, claimed from never

Migration **094** adds to `job_applications`:

```
ats_score_at_apply   INTEGER
ats_scorer_version   TEXT
ats_report_at_apply  TEXT
ats_scored_at        INTEGER
```

**n is zero. No validation is claimed from this and none can be yet.** The fields exist because the
score half of a (score, outcome) pair is *unrecoverable* after the fact — the resume changes, the
profile changes, the corpus weights change, and the scorer changes. Re-scoring an old application
next year answers a different question.

Three decisions worth stating:

- **`ats_scorer_version` is not optional, and this task is the proof.** The same fit that scored 45
  under v3 scores ~28 under v4. Pooling across that boundary would silently mix two scales and
  produce a confident, meaningless correlation. The version stamped is read from the *stored
  report's own* `source`, not from today's constant — those differ exactly when a cached report
  predates a scorer change, which is the case the column exists for.
- **Null stays null.** A job that was never scored, or one the scorer declined, records no score.
  Writing 0 would inject a fabricated point into the only dataset that can ever validate this number.
- **The first stamp wins** (`COALESCE` on conflict). Re-recording an application must not overwrite
  the score that was true when it was sent.

Both writers stamp it — `routes/apply.js` (manual) and `server.js` (auto) — asserted in a test,
because a hole shaped like "whichever route the candidate used" would be invisible until analysis.

### The employer's half — migration 095

The score half above was useless alone. `job_applications` recorded `auto_status` — whether *we*
managed to submit — and nothing about whether anyone replied. Migration 095 adds the other half,
with the vocabulary in `shared/applicationResponse.js`.

**It is a different axis from `shared/applyOutcomeGroups.js`, and conflating them would be the
obvious mistake.** That file answers "did we manage to submit?" and ends when the form is sent. This
one answers "did the employer respond?". A run can be `submitted` and be ghosted; a run can be
`held_review`, get sent by hand, and produce an interview. Neither derives from the other.

Three columns, because they answer three questions and none derives from another:

| column | question |
|---|---|
| `first_response_at` | Did they engage at all, and how fast? Set once, never moved. |
| `furthest_stage` | How far did it get? Monotonic — `screen` → `interview` → `rejected` must not read as though it were rejected off the resume. |
| `response_outcome` | How did it end? |

Two calls worth stating because they are the ones that decide whether the eventual number means
anything:

- **A rejection counts as a response.** An ATS score is a resume-*screening* score; the only thing it
  could plausibly predict is "did something read this and reply". Filing rejections with silence
  would measure hiring outcomes instead, and make a resume that reliably draws rejections look
  identical to one that vanishes.
- **NULL is not "no response".** An application sent yesterday with nothing recorded is
  **unresolved**, not a negative. `MATURITY_DAYS = 30` separates the two, and `responseBucket()`
  applies it. Without this, an early response rate reads near zero — worst exactly when someone
  first looks at it and concludes the resume is bad.

`GET /api/apply/response-correlation` is the query that uses the pair, with the maturity window and
a per-scorer-version split already applied, and it ships its caveats in the response body rather
than in a doc nobody opens. It reports `sufficient: false` until there are ≥20 rows on each side.

**Two honest gaps remain.** **n is zero** — nothing can be concluded until real applications
accumulate. And **no UI consumes any of this**: nothing in `client/src` reads
`/api/apply/applications`, so outcomes are recordable only over the API today. Building an
applications view is a much larger piece of work than the field it would display, and the data
cannot be backfilled later — which is why the recording path exists ahead of the screen.

## 6. Honest summary

- ρ = 0.504 is **usable for ordering a feed, not for showing a number.** The top of the ranking is
  reliable (both Backend Engineer roles ranked #1 and #2 against a backend resume); the middle is
  not.
- The **floor** (~26 from experience + generic competencies) is the largest remaining source of
  confidently-wrong-high, and the naive fix for it is measured worse.
- **Lexical recall** is the largest source of wrong-low and is a ceiling on the approach, not a bug.
- The engine now **declines** rather than fabricating, is **stable** on near-duplicates, and is
  **not fooled** by over-levelled roles — the three adversarial properties that matter most for a
  swipe feed.
- For the swipe feed's free fit signal, the defensible presentation is a **coarse band** (strong /
  possible / weak) rather than a two-digit number. ρ = 0.504 supports three buckets; it does not
  support telling someone this job is a 43.

## 7. The auto-apply threshold was re-derived onto this scale: 50 → 30

`ATS_AUTO_APPLY_THRESHOLD` was calibrated against v3, whose comment recorded median 48 / p75 54. v4
gives **median 28, p75 32, p90 38, max 63** for the same 1291 postings. At 50 on the new scale only
~2% of postings could auto-send, against the 44% the owner had deliberately chosen — a gate holding
almost everything, which is the same failure the earlier 65 → 50 change was made to fix.

**30 restores the stated intent unchanged** — "just above the median; roughly average-or-better goes
unattended, the rest queue for a human." Against a v4 median of 28 it sits where 50 sat against v3's
median of 45. The policy did not change; the scale under it did.

This does send more applications unattended than 50 did, which is the point, and it was adopted
explicitly rather than as a side effect of the scorer work. It stays env-configurable, and the test
covering it deliberately pins the *behaviour* (below-threshold holds for a human, and the number is
tunable without a deploy) rather than the number — a test that copies whatever constant it finds
cannot fail for a reason anyone cares about.

**Re-measure before moving it again.** The distribution above is one profile and one resume, and it
moves with both.
