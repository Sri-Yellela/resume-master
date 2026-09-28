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

## How a repository consumes it

- **draft** holds the source of truth and depends on it as `"file:packages/ats-scorer"`.
- **Any other repository vendors a copy** of this directory and runs `npm test` inside it. One of
  those tests re-hashes every file against `CHECKSUMS.json` (LF-normalised). So a hand-edit to a
  vendored copy fails, and so does an edit here without `npm run checksums`. Change it in draft,
  regenerate, and copy it across.
