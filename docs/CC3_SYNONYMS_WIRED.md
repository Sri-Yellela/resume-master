# CC3 — G1's synonym table, wired into the scorer

Implemented 2026-09-17, after CC2. Brief: `docs/CURATION_CONSOLIDATION.md`.

**Decision: option (a) — wire it in.** The effect path now exists at all eight `scoreAtsLocally`
call sites, and it is provably live. **The measured ρ delta from the 12 confirmed pairs is
`+0.0000`.** Both of those sentences are true and the second is not a reason to undo the first;
§3 explains why.

---

## 1 · The defect, confirmed

Verified rather than inherited — three of this brief's premises have already turned out stale:

| claim | measured |
|---|---|
| 12 confirmed / 196 proposed / 10 rejected | **exactly right** |
| `scoreAtsLocally` accepts `synonyms` | yes, since G1 |
| no server call site passes it | **confirmed — 0 of 8** |
| only production reader is `enrichJob` → `canonicalSkillKey` | confirmed (plus `companyProfile.js`'s stack merge) |

So the owner was being asked to review 196 proposals for a table that nothing which scores read.
"+0.000" was never a weak effect; it was **no effect path**.

---

## 2 · What was built

**All eight call sites** in `server.js` now pass `synonyms: atsSynonyms()`, and a source-scan test
fails if a new one forgets — the failure mode is a *new* call site, which no behavioural test over
the existing ones can see.

**`loadConfirmedSynonyms` is memoised per database**, because it is now read per scored job (the
ingest scorer runs batches of 25). The cache and its invalidation live in the same file, and every
writer — `confirmSynonym`, `rejectSynonym`, `recordSynonymProposals` — clears it.

⛔ **A cache that a confirmation did not clear would reproduce the exact bug CC3 fixes**: the
confirmation would take effect only after a restart, which looks identical to "synonyms have no
effect". Both directions are asserted, and so is the case that must *not* be cached — an absent
table returns an empty map without caching it, or a database that later gains the table would be
permanently synonym-less.

Requirement 2's invariants all still pass, untouched: one hop never transitive · corroboration never
promotes · a rejection is sticky · `(a,b)` and `(b,a)` are one row · a synonym cannot rescue a term
the résumé does not support · an absent table degrades rather than throwing.

Requirement 3's gate is unchanged: **confirmed rows only**. The 196 proposals stay out until a human
moves them.

### The path is LIVE, not merely wired

Proved end to end on a copy of the real board, with the owner's real profile:

```
posting: "Account Executive, AI Startups (Hunter)" @ Stripe
score before                      20
pair only PROPOSED                20    <- unchanged; the review gate holds
pair CONFIRMED                    27    <- MOVED
competencies_matched  []  ->  ["relationship building"]
```

A proposal changes nothing; a confirmation moves the score by 7 and moves the term from
`competencies_missing` to `competencies_matched`.

---

## 3 ⛔ Requirement 4 — the measured ρ delta is `+0.0000`, and here is exactly why

| profile | ρ synonyms OFF | ρ synonyms ON | delta | scores changed |
|---|---|---|---|---|
| 5 (the owner) | 0.5340 | 0.5340 | **+0.0000** | **0 of 30** |
| 6 | 0.7460 | 0.7460 | **+0.0000** | **0 of 30** |

A synonym changes a score only when **both** halves land: the scorer must *ask* about term A, and
the résumé must *contain* term B. Measured across the 30 graded postings, the scorer asks about
**311 distinct terms**:

- **4 of the 12 confirmed pairs name a term the scorer asks about** — `mentoring ↔ mentorship`,
  `backend development ↔ backend engineering`, `ambiguity tolerance ↔ comfort with ambiguity`,
  `roadmap development ↔ roadmap planning`. So the first half lands for a third of them.
- **The owner's résumé contains neither side of any of those four.** The second half never lands,
  so no bridge is ever crossed. Hence `+0.0000`, with the path fully live.

That is a different and more useful diagnosis than "the table is dead". The table is now connected;
what is missing is an intersection between *this* résumé and *these* twelve pairs.

### The actionable half — which proposals are worth reviewing

**54 of the 196 proposals name a term the scorer asks about.** Those can move a score; the other 142
cannot, for this corpus. The top of that list:

```
communication            <-> verbal communication
collaboration            <-> cross-functional collaboration
leadership               <-> technical leadership
analytical thinking      <-> data driven decision making
executive engagement     <-> stakeholder alignment
```

And **241 of the 311 terms the scorer asks about have no synonym row at all** — which is where a
synonym would actually pay. Ranked by how many postings ask:

```
11  cross functional      10  reliability       10  python        10  strategy
 9  stakeholder management 8  problem solving    7  distributed system
 5  react                  5  onboarding         5  scalability
```

So the review queue is **not** worthless — it is 28% useful and now aimed. The offline extraction
pass (`scripts/al3SkillSynonyms.mjs`) should target the 241 uncovered terms rather than the corpus
vocabulary at large.

---

## 4 ⛔ A correction to my own CC1 and CC2 reports

Both said **`basis.skills` is 0 on both active profiles**, and used it to explain the low scores.
**That was wrong, and it was my harness's fault, not the product's.**

`buildRuntimeAtsBasis` reads `signalProfile.skills` / `.keywords` — **parsed arrays**. The
`profile_simple_apply_profiles` row has `skills_json` / `keywords_json`. My measurement scripts
passed the **raw row**, so the basis came out empty. Through the real `loadSimpleApplyProfile`:

```
profile 5:  basis.skills = 28   (not 0)
profile 6:  basis.skills = 0    (genuinely — it has no simple-apply row at all)
```

**Every conclusion drawn from it is unaffected, which I checked rather than assumed:** with the
correct basis, **0 of 30 graded scores differ**, and the band distribution over all 881 enriched
rows is byte-identical (`weak 851, moderate 30`). So CC2's requirement-6 finding — *zero Strong
rows, so "24 of 69 demoted" measures 0 of 0* — stands on the corrected basis too.

The reason the 28 terms change nothing is sharper and worse than "there are none". They are:

```
["javascript","java","technical","university","college","engineering","near",
 "assistant","provided","science","tasks","adobe","bachelor","current", ...]
```

That is the noise the brief's own out-of-scope note describes — *"profile 5's stored keywords read
`near, provided, tasks, july, windows, college`"*. **28 terms in produce exactly the same scores as
0 terms in**, so the scorer's rejector is discarding essentially all of them. The two-extractors task
is the real blocker, and this is a measurement of it.

Both documents are corrected in place.

---

## 5 · Dependents, with verdicts

| dependent | verdict |
|---|---|
| all 8 `scoreAtsLocally` sites in `server.js` | **CHANGED** — each passes `synonyms`. Pinned by a source scan. |
| `enrichJob` → `canonicalSkillKey` | **UNCHANGED** — still the technographics de-dup reader. |
| `services/kb/companyProfile.js` | **UNCHANGED** — also loads the map for `mergeStackRows`; benefits from the memoisation. |
| `scripts/am1GradedCorpusVerify.mjs` | **UNCHANGED, and correctly so** — it passes `synonyms: null` explicitly, because the graded corpus was scored without them and re-scoring it with them would move the baseline it exists to pin. |
| `scripts/al3SynonymRhoEffect.mjs` | **UNCHANGED** — its own measurement harness. Its "+0.000" is now explained rather than mysterious. |
| the review UI | **UNCHANGED** — it already orders risky claims first (requirement 3). It is now a queue for a live table. |
| the scorer | **UNCHANGED** — `hasTerm`'s one-hop expansion already existed and was already tested. |

No migration. No schema change.

---

## 6 · One oddity worth recording

`normaliseAtsTerm` strips a trailing `s` from any 4+-letter word (`\b([a-z]{4,})s\b`), so
**`cross` normalises to `cros`** — `cross-functional` becomes `cros functional`. It is *internally
consistent*: both the résumé side and the JD side pass through the same function, so matching is
unaffected, and display goes through `displayTerm` instead. `kubernetes` is already special-cased
back for the same reason. Not fixed, not a defect in behaviour, but it will look wrong to the next
person who prints a normalised key — as it did to me.

---

## 7 · What this does not fix

- **The résumé side.** 28 noise terms that contribute nothing is the two-extractors task, and it is
  the gate on everything CC3 could have achieved.
- **The 241 uncovered terms.** Listed above so the extraction pass can be aimed; generating proposals
  for them is an offline model run and its own task.
- **ρ.** Still ~0.53 / ~0.75 for score↔grade, and ~0.18 for board↔score. CC2 §4 explains the latter:
  the bridge ranks in three-valued buckets and ties on recency.
