# AK2 task 4 (measurement half) — what the real v4 distribution looks like

Measured 2026-08-30 against the live board: **1291 postings**, `data/resume_master.db`, scorer
`local_ats_v4`, term weights applied to **100%** of postings (not stale).

**No thresholds are set here, and that is deliberate.** Task 4's requirement 5 forbids setting bands
on self-graded data and asks for the owner's pass over a graded set first. This document is the
distribution and the consequences of it; the grading sheet is `docs/ak2-ats-grading-set.md`.

---

## Method, and how it was checked

Nothing persists `ats_score` on `scraped_jobs` — all 1291 rows are NULL — because a score is
relative to a resume. So the board was **re-scored**, reproducing `server.js`'s runtime path exactly:
`buildRuntimeAtsBasis` → `scoreAtsLocally`, with per-role-family term weights resolved the same way
`atsTermWeightsForJob` resolves them.

**Which resume matters, and it is not a detail.** Two profiles are active:

| profile | user | resume | what it is |
|---|---|---|---|
| 5 | 14 | 1466 chars | the **`John Doe fakeemail@gmail.com` placeholder** AK1 explicitly set aside as "matching almost nothing" |
| 6 | 15 | 4912 chars | the **owner's real resume** (Fullstack SE, 4 years) |

Everything below is **profile 6** unless stated. As a check on the method, AK1 measured a *synthetic*
senior-backend profile written for its evaluation and got median 28 / p75 32 / p90 38 / max 63. Two
different realistic resumes landing within a point of each other is decent evidence the measurement
is of the engine rather than of one CV.

| | AK1 (synthetic senior backend) | here (owner's real resume) |
|---|---|---|
| median | 28 | **27** |
| p75 | 32 | **32** |
| p90 | 38 | **39** |
| max | 63 | **64** |

---

## The distribution

```
min 6   p10 20   p25 22   median 27   p75 32   p90 39   p95 45   max 64   mean 28.5
```

```
   0-4       0    0.0%
   5-9       2    0.2%
  10-14     10    0.8%  ##
  15-19     88    6.8%  ##############
  20-24    326   25.3%  ###################################################
  25-29    403   31.2%  ##############################################################
  30-34    223   17.3%  ###################################
  35-39    117    9.1%  ##################
  40-44     49    3.8%  ########
  45-49     37    2.9%  ######
  50-54     22    1.7%  ###
  55-59     10    0.8%  ##
  60-64      3    0.2%
```

**73.8% of the board sits between 20 and 34.** The engine is compressed: it separates the extremes
and says very little in the middle, which is the same story ρ = 0.504 tells.

## Candidate cutpoints — populations only, nothing adopted

Requirement 2's test is that a band holding 3% or 85% is not a band. All four schemes pass it for
the three scored bands:

| cutpoints | Strong | Moderate | Weak |
|---|---|---|---|
| p90 / p50 → **≥39 / ≥27** | 144 (11.2%) | 538 (41.7%) | 608 (47.1%) |
| p85 / p55 → ≥43 / ≥29 | 203 (15.7%) | 404 (31.3%) | 683 (52.9%) |
| p80 / p50 → ≥36 / ≥27 | 278 (21.5%) | 404 (31.3%) | 608 (47.1%) |
| p75 / p40 → ≥32 / ≥24 | 360 (27.9%) | 504 (39.0%) | 426 (33.0%) |

---

## Finding 1 — the required fourth band is empty

**"Not enough signal" holds 1 posting out of 1291. 0.08%.**

The one decline is *Physical Superintelligence — Remote Member of Technical Staff Engineering*:
`Only 0 scorable terms could be extracted from this posting.` The gate is `MIN_SCORABLE_TERMS = 4`.

Requirement 1 makes this band **required**, and it should be — the scorer declining is an honest
state and must never render as a low score. But by requirement 2's own test, 0.08% *is not a band*.
Both things are true, and the resolution is that they are answering different questions:

- Keeping it is right. It is a **correctness** state, not a population to be balanced.
- It cannot be **calibrated or validated from board data**, because the board never produces it.

Where it will actually appear is the path the curated board does not cover: pasted job descriptions,
truncated scrapes, and — per task 7 — a swipe feed scoring against a base resume. Its design should
be reviewed there, not here. Anyone tuning the three scored bands to "balance" against this fourth
one is tuning against a single row.

## Finding 2 — a band is a fixed number, and the score is not fixed

The score is relative to a resume, so the same cutpoint means different things to different users.
Applying each profile's own p90/p50 cutpoints to the other, over the identical 1291 postings:

| cutpoints from | applied to | Strong | Moderate | Weak |
|---|---|---|---|---|
| profile 6 (≥39 / ≥27) | profile 6 | 11.2% | 41.7% | 47.1% |
| profile 6 (≥39 / ≥27) | **profile 5** | **0.2%** | 2.2% | **97.6%** |
| profile 5 (≥23 / ≥20) | profile 5 | 12.1% | 40.7% | 47.1% |
| profile 5 (≥23 / ≥20) | **profile 6** | **74.9%** | 17.3% | 7.7% |

Both cross-applications break requirement 2's rule in opposite directions — 0.2% Strong one way,
74.9% Strong the other.

**Read this carefully, because the obvious reading overstates it.** Profile 5 is a placeholder CV,
not a second real user, so this is not evidence that two genuine users diverge this far. What it
*is* evidence of is the mechanism, and the mechanism has a real victim: **a new user whose first
upload is thin or early-career gets a compressed distribution and an all-Weak board** — told
everything is a poor match when what actually happened is that their resume matched few terms. That
is the onboarding case, and it is common.

Two ways out, and neither is free:

- **Fixed global thresholds** — comparable between users, stable over time, and miscalibrated for
  anyone whose resume is unlike the one they were set from.
- **Per-profile percentile bands** — always well-populated, but they force a fixed proportion into
  each band, so 10% of a uniformly bad board still reads "Strong". That is a fabricated claim of the
  same family the engine's decline behaviour was built to stop.

I have not chosen between them. The choice depends on what the human grading says the bands *mean*,
which is exactly what requirement 5 asks for and why it comes first.

## Finding 3 — the auto-apply gate inherits the same problem

Out of scope for task 4 (requirement 4 keeps the gate on the number, and bands are display-only), so
this is reported, not acted on. The gate is a fixed 30 on this same resume-relative scale:

| profile | postings reaching 30 |
|---|---|
| 6 (real, 4912 chars) | 461 of 1291 — **35.7%** |
| 5 (placeholder, 1466 chars) | 9 of 1291 — **0.7%** |

A 50× difference in how much is eligible for unattended submission, driven by resume length rather
than by fit. `30` was calibrated as "just above the median" against one distribution; it is not
median-relative for anyone else.

---

## What is needed next: the grading pass

**`docs/ak2-ats-grading-set.md`** — 30 postings, stratified evenly across the engine's full range
(scores 6 to 64), shuffled with a fixed seed, **with the engine's score withheld**. Rate each 1–5.
The answer key is `docs/ak2-ats-grading-key.json`; joining before grading destroys the measurement.

**A note on AK1's set.** AK1 states its 30 were "pinned by title+company, not re-drawn per run", and
gives a good reason — re-drawing after each scorer change made runs incomparable. The set was
nevertheless **never committed**; the only fixtures in the repo are four synthetic jobs in
`test/atsRankingHonesty.test.js`. So "the same 30 postings AK1 used" cannot be recovered, and this is
a fresh draw. `scripts/ak2AtsGradingSet.mjs` is committed beside the sheet so this one is
reproducible.

Once graded, the remaining work is: compute ρ against the human pass, choose fixed-vs-percentile on
that evidence, set the cutpoints, and convert every display surface.
