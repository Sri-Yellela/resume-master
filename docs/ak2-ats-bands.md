# AK2 task 4 — ATS bands, set from the owner's graded 30

Run 2026-08-31. Baseline re-derived first: **2038 passing, 0 failing**. After: **2050 passing, 0
failing**. Introduced failures: **0**. Client build clean. No migration.

This completes task 4. The measurement half is `docs/ak2-ats-band-distribution.md`; the grading
sheet is `docs/ak2-ats-grading-set.md`, now filled in.

---

## The joined result, reproduced independently

| | |
|---|---|
| Spearman ρ | **0.643** |
| mis-ordered | **16.1%** of all 435 pairs |
| Kendall τ | **0.444** |

Reproduced from the sheet rather than taken on trust. One precision note: **τ = 0.444 is tau-a**;
tau-b is **0.507**. It matters because AK1 quoted τ-**b** = 0.357, so the like-for-like comparison is
0.357 → 0.507, not 0.357 → 0.444.

`#12 Figma SWE Intern` is confirmed the worst inversion — human 2, engine 60, a rank gap of **+21.0**,
nearly twice the next worst.

---

## 1. The seniority guard

**ρ 0.643 → 0.746. τ-b 0.507 → 0.594. Mis-ordered 16.1% → 12.2%.**

Two things stack to produce the defect, and neither is a bug alone. An intern posting states no years
requirement, so `experienceRatio` returns null and AK1's flat 85% neutral credit applies; and an
intern JD at a strong engineering company is written in dense engineering vocabulary, so the skill
component scores well too. Term overlap is genuinely high. The posting is still wrong for the
candidate, for a reason no amount of term matching can see.

A **cap**, not a penalty — subtracting points would leave a well-worded internship outranking a
mediocre senior role, and the mismatch is categorical rather than a matter of degree.

### It is keyed on profile seniority, not years — and that was measured, not preferred

The obvious implementation reads `years_of_experience`. Two findings killed it:

1. **`extractUserYearsExperience` returns null for the owner's real resume.** It says *"4 years
   building scalable, high-performance systems"* and all five patterns require the literal word
   *"experience"*. A years-keyed guard would have been **dead code that never fires** — and the
   +0.103 I would have reported for it, fiction.
2. **Repairing the extractor makes ranking worse: ρ 0.643 → 0.552.** Supplying `years = 4` lifts
   every non-engineering posting that states a satisfied year requirement — Program Manager +10,
   Account Executive +10, Risk Strategist +5 — while dropping an Analytics Engineer the owner graded
   4. That is precisely the failure AK1 recorded when it reverted renormalisation: *"it handed the
   ranking back to the experience flag from the other direction."*

| variant | ρ | τ-b | mis-ordered |
|---|---|---|---|
| baseline | 0.643 | 0.507 | 16.1% |
| + years extractor repaired | **0.552** | 0.433 | 19.1% |
| + guard keyed on years (never fires) | 0.643 | 0.507 | 16.1% |
| + both | 0.648 | 0.507 | 15.9% |
| **+ guard keyed on `domain_profiles.seniority`** | **0.746** | **0.594** | **12.2%** |

`seniority` is already populated (`"mid"`), says exactly what is needed, and costs the experience
component nothing. **The years-extractor bug is real and is left unfixed on purpose** — fixing it in
isolation is a net loss, and it is recorded here rather than silently carried.

### The detector reads titles, and that is load-bearing

Scanning descriptions fired on three senior backend roles whose opening line reads *"if you are an
intern, new grad, staff, frontend or fullstack applicant, **please do not apply using this link**"* —
a posting **excluding** interns, read as evidence that it is one. Title-only fires on **11 of 1291**
(0.9%), all genuinely junior-titled.

### The cap value

The cap sweep is flat from 5 to 20 (ρ 0.740–0.746) and falls away above it. **20** is the top of that
plateau, and three things independently agree with it: it sits below the auto-apply gate (30) so an
over-qualified candidate never auto-applies to an internship; below the board median (27) so junior
postings land in Weak, matching the human's 2/5; and high enough to preserve ordering among junior
postings, which a cap of 5 would flatten.

**Stated plainly: the cap is tuned on ONE posting.** Only `#12` fires it in the graded 30. The
plateau is why the exact value is not load-bearing, but the first junior posting a future grading
set contains should be treated as a test of this number, not a confirmation of it.

---

## 2. The cutpoints

**Strong ≥ 44 · Moderate ≥ 26 · Weak < 26 · Not enough signal = null**

Strong is chosen for **precision**, as directed. 44 is the lowest cutpoint at which precision against
"the owner graded this 4 or 5" reaches **100%**:

| cutpoint | precision (human ≥4) | recall of human-5s | 5s excluded |
|---|---|---|---|
| 40 | 91% | 67% | 4 of 12 |
| 42 | 90% | 67% | 4 of 12 |
| **44** | **100%** | **67%** | **4 of 12** |
| 46 | 100% | 58% | 5 of 12 |

**The accepted cost, explicitly: 4 of the 12 postings the owner graded 5 do not reach Strong** —
33%. They render Moderate. Below 44 the band admits a posting the owner rated poorly; above 44 it
only loses good ones.

Weak < 26 is chosen for **calibration against the human** rather than separation alone. The owner
graded 36.7% of the sample 1-or-2; 26 puts 40.8% of the board in Weak, the closest available match.
A cutpoint of 30 separates the graded set slightly better but swells Weak to 64.9% — markedly more
pessimistic than the human it is meant to agree with. (30 would also collide numerically with the
auto-apply gate, inviting exactly the coupling requirement 5 forbids.)

### Band populations across all 1291 postings

| band | count | share |
|---|---|---|
| Strong | 72 | 5.6% |
| Moderate | 691 | 53.5% |
| Weak | 527 | 40.8% |
| Not enough signal | 1 | 0.1% |

---

## 3. The thin-resume case — a distinct state

Profile 5's placeholder resume runs median 20 / max 42, so under a fixed cutpoint it would see
**zero Strong and an almost entirely Weak board**. Three options were available:

- **profile-relative cutpoints** — rejected. Forcing ~6% of any board into Strong invents a strong
  match where there may be none, the same fabrication the decline behaviour exists to prevent, and
  it makes two users' "Strong" incomparable.
- **a floor** — rejected. Arbitrary, and it lies in the same direction.
- **a distinct state** — chosen. It is honest about which side the problem is on, and unlike the
  other two it is **actionable**: a user can fix a thin resume and cannot fix a miscalibrated band
  they cannot see.

`resumeDepthWarning()` is computed on the basis (not per job, so it cannot flicker) and rides on the
report. It renders **above** the band, not instead of it — the user still gets the ordering, plus the
reason the board looks flat.

---

## 4. Every surface

**Five** copies of `ATS {score}` existed, each with its own `>=80` green / `>=60` amber ramp carried
over from v3. Under v4 (median 27, max 64) **nothing on the board ever cleared 60, so every row
painted red** — the badge read "every job is bad" when it was only a different scale.

| surface | file |
|---|---|
| job card badge | `components/JobCard.jsx` |
| board badge | `panels/JobsPanel.jsx` |
| job detail | `components/JobDetailPanel.jsx` |
| review screen + attempt rows + compact company rows | `panels/AutoApplyPanelSections.jsx` (3 sites) |
| pending list | `panels/AutoApplyPanel.jsx` |
| ATS report panel | `panels/ATSPanel.jsx` |
| standalone generator | `pages/tools/GenerateToolPage.jsx` |

All now read `shared/atsBands.js`. The **score donut is gone** from the ATS panel — a ring filled to
43/100 in a colour ramp was the most precise-looking thing on the screen.

**The mobile contract** marks the number internal in three places (`Job.matchScore`,
`PendingResume.atsScore`, `RunJob.atsScore`), regenerated through the generator so the `--check` on
every `npm test` still passes.

**The gate is untouched.** `ATS_AUTO_APPLY_THRESHOLD` stays a number at 30, and a test asserts it is
not equal to the Strong cutpoint and that nothing gates on `band === "strong"` — coupling them would
cut auto-apply volume from ~36% of the board to ~6% as a side effect of a copy decision.

---

## 5. ML/AI — not adjusted, as directed

Dropping ML rows moves ρ by 0.007. **No adjustment made.** Recorded for the profile work instead:
ML/AI postings should be scored against a **Data Science** `domain_profile`, not the engineering one.
This is a profile-routing question, not a scoring one.

---

## Verification

`scripts/ak2BandSurfaces.mjs` drives the **real board in a real browser** against a stub whose scores
sit **on** the cutpoints — 44 and 43, 26 and 25, plus a null. **14/14 checks pass.**

It earned its keep immediately. The badge had been taught to render a null score, but **both call
sites in JobCard still read `score != null`**, so "Not enough signal" could never have appeared on a
card. No source test could see that — they assert the component, not the caller. Fixed, and the
screenshot now shows all four bands with "No signal" in grey, off the green–amber–red axis:

```
rendered "No signal"  rgb(229,231,235)/rgb(75,85,99)
rendered "Weak"       rgb(254,226,226)/rgb(153,27,27)
```

`test/atsBandSurfaces.test.js` adds 12 tests: a null is never Weak and never zero, the cutpoints
match the evidence, the gate is decoupled in both directions, no surface prints the number, the
detector ignores postings that exclude interns, the cap is a ceiling that reports what it capped, and
the guard does not read years again.
