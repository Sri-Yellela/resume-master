# @draft/ats-scorer

The local ATS scorer, extracted from draft in Phase A1. **Deterministic, free, local**: no database,
no network, no model call. Scoring 1,000 board rows costs nothing but CPU (~10 ms/row measured).

## What is in it

The scorer and everything it needs to score: `normaliseAtsTerm`, compound detection, the term
rejector, the ambiguity guard, the competency registry, `candidateTermsFromJob`, the seniority
guard, and the two term registries in `data/`. **A missing registry throws.** It does not fall
back to an empty vocabulary; that fallback silently changed 27 of 30 graded scores.

## What is NOT in it

- **Loading term weights or synonyms.** Those read a database. Each product loads its own and
  passes them in.
- **Bands and presentation.** The score is a fact about a résumé and a posting. A band (Strong /
  Moderate / Weak, the thin-résumé warning) is a product's decision, calibrated against that
  product's board. Each product builds its own.

## The signature

```js
import { scoreAtsLocally, buildRuntimeAtsBasis } from "@draft/ats-scorer";
const basis = buildRuntimeAtsBasis({ resumeText, signalProfile, domainProfile });
scoreAtsLocally({ job, runtimeBasis: basis, termWeights, synonyms });
```

| argument | accepted | anything else |
|---|---|---|
| `termWeights` | `null` (unweighted on purpose), a `Map<term, weight>`, or `{ weights: Map, stale }`. A stale envelope is refused and scores unweighted | **TypeError** |
| `synonyms` | `null`, or a `Map<normalisedTerm, string[]>` of CONFIRMED rows. Applied one hop, never transitively | **TypeError** |

## Facts read from résumé text (A81) — opt-in

`buildRuntimeAtsBasis({ …, factsFromText: true })` fills what `signalProfile` leaves unset from the
résumé text: **years of experience** from its dated roles (the union of the date ranges in the
experience section, whole years rounded down; a stated "N years of experience" only when no role is
dated) and a **security clearance** it states is held (a hedged line — "eligible", "able to obtain",
"expired", "requiring" — is not one). A fact the profile states always wins. The report then carries
`facts_from_text` saying what was read.

- **Off by default.** Without the flag the basis and the report are exactly what they were — no key
  added — so a product whose users have a profile (draft) does not move.
- ⛔ **Citizenship is never read from text.** It is sensitive, and inferring it is unreliable; a
  citizenship requirement stays a stated miss. `facts_from_text.not_read` says so.

## Experience: meeting a requirement is neutral (1.2.0, `local_ats_v5`)

A posting's years requirement that the candidate **meets** pays exactly what a posting with **no**
requirement pays (`MEETS_EXPERIENCE_RATIO === NO_REQUIREMENT_EXPERIENCE_RATIO`, 0.85 of the 22
experience points). Until 1.1.0 it paid the full 22 — a bonus for a gate passed, which the years
cannot earn: they do not see whether the role fits. A **shortfall** still costs, graded by how far
short; unknown years still score the incomplete-profile rate. The measurement is in `src/scorer.js`
at `MEETS_EXPERIENCE_RATIO`. Scores move only where years are known and met (or far exceeded), by 1 to 4 points down.

## Vocabulary: eight engineering disciplines (1.3.0, D126 P3)

The closed vocabulary (data/DOMAIN_METADATA_REGISTRY.json) gains mechanical, electrical, civil, chemical, industrial,
aerospace, biomedical and hardware engineering — their tools as postings name them (seeded from O*NET 30.0 Technology
Skills for SOC 17-2xxx, vendor prefixes dropped) and the named practices a posting asks for (GD&T, DFMEA, HAZOP, UVM …).
Before it a mechanical posting yielded 0 scorable terms and every non-software engineering score was declined. Terms
generic enough to appear in software postings were left out, so computing scores do not move (the graded corpus's ρ
is unchanged; see draft's test/d126AtsDisciplines.test.js).

## Vocabulary: every professional field (1.4.0, A111 P2)

Twenty more domains for the fields beyond computing and engineering: accounting and audit, FP&A, consulting, business
analysis, procurement, compliance (BSA/AML), HR and recruiting, operations, project and general management, digital
marketing, sales, legal practice, contracts, graphic / visual / product design, writing and editing, PR and
communications, life-sciences research, laboratory chemistry / QC, and economics. Tools are seeded from O*NET 30.0
Technology Skills for each SOC group (vendor prefixes dropped; office software used by more than 60 occupations left
out), practices are the named ones postings ask for (US GAAP, ASC 842, BSA/AML, MEDDIC, AP style, qPCR, HPLC, Stata …).
Before it, an accountant, compliance, sales, writing, life-sciences or economics posting yielded fewer than 4 scorable
terms and was declined. ⛔ The vocabulary is ONE pooled set, so a new term that a software posting also uses would move
that posting's score: every new term was measured against 1,241 real computing postings, 43 engineering postings and
the graded 30 and kept only when it occurs in none of them, and every new domain's verbs are verbs the registry already
had. Measured: 0 of 1,284 computing / engineering reports changed in any field; the graded 30 score identically
(see draft's test/a111ProfessionalVocabulary.test.js).

## How a repository consumes it

- **draft** holds the source of truth and depends on it as `"file:packages/ats-scorer"`.
- **Any other repository vendors a copy** of this directory and runs `npm test` inside it. One of
  those tests re-hashes every file against `CHECKSUMS.json` (LF-normalised). So a hand-edit to a
  vendored copy fails, and so does an edit here without `npm run checksums`. Change it in draft,
  regenerate, and copy it across.

## The contextual score (1.5.0, D192 (4) — ATS contract 2.0.0)

`scoreContextual({ skillMatch, skillsBoth, posting, resume, company, weights })` (`src/contextual.js`) adds a second
number beside the skill match. **It never changes `scoreAtsLocally`'s report.** It is pure: no model, no embedding, no
network, no database. Every input is an argument. The caller reads its own placements and the company's stack and
passes them in.

| part | default weight | what it reads |
|---|---|---|
| `skill_match` | 0.50 | the report's `score`, unchanged |
| `role_fit` | 0.20 | the posting's subcategory and level vs the résumé's placement. Same role = 100, the role the résumé also fits = 85, same family = 65, another family = 20. The level gap then costs 10 / 25 / 40 for 1 / 2 / 3 steps short, and half that over-levelled. A shared industry adds 10; a different one is listed, never a penalty |
| `responsibility_overlap` | 0.15 | the posting's responsibility lines (the *What you'll do* section, else its bullets) as short phrases. A phrase counts when one résumé line has at least 2 and at least half of its core tokens |
| `tech_stack` | 0.15 | `company.techStack [{ name, category, postingShare }]`, each item weighted by its share of the company's postings. An exact match earns it, a same-purpose match (`ECOSYSTEMS`: Airflow ↔ Prefect) earns half, a gap earns nothing. The résumé's extras are neutral |

A part with no data (no placement, no responsibility lines, no stack) is left out, and the other weights are rescaled.
Weights come from the caller (`resolveContextualWeights` refuses unknown parts and negatives). The block also lists
**similarities** (skills, stack, ecosystem pairs, domains, role, responsibilities) and **dissimilarities**, each with
a `kind`, a `penalty` flag and an `action` where one exists (`learn` for a stack gap, `evidence` for a responsibility).

**1.5.1 (46x, the owner's display pick):** what the block LISTS is tidier. Its numbers do not change. A stack gap is listed only from 10 % of their postings (`GAP_MIN_SHARE`), so a payments company's Excel at 5 % is not advice. Every gap still costs in `parts.tech_stack` at its own share. A same-purpose pair is not listed when your side already matches exactly. A responsibility phrase is the line cut on a word at 90 characters (`PHRASE_CHARS`).

## Claim plausibility (1.6.0, D192 (4d))

`experienceEntries(text)` reads the résumé's experience entries: header, title, dates and bullets.
`checkPlausibility({ entries, companyFor, vocabulary, asOf })` checks each entry's bullets against what the caller knows
about that employer. Four checks:
- **tech:** confirmed when the employer's own postings name the technology. Unlikely only when its stack is known (at
  least 3 technologies) and neither the technology nor anything of the same purpose is in it.
- **domain:** sales incentives, payroll, patient care and similar work are unlikely when the employer has at least 10
  classified postings and none in a family that does that work.
- **role:** leading 5 or more people as an intern or junior, or at a company with fewer than twice that many people.
- **timeline:** a technology named in a role that ended before it first existed (`TECH_FIRST_YEAR`).

An employer with no record is never flagged on tech or domain. A flag is a warning and never changes a score: no scorer
reads this module. Each flag carries a stable `key`, so a dismissal survives a re-score. The module is pure: no model,
no network, no database.
