# CC4 — user-claimed terms reach curation

Implemented 2026-09-17, after CC1–CC3. Brief: `docs/CURATION_CONSOLIDATION.md`.

**The change in one line:** a term the candidate claims now counts toward their ATS band *and*
toward where jobs rank on their board — not only toward the next generated résumé.

---

## 1 · The defect, confirmed

`listProfileClaims` had **exactly one consumer**: the generation prompt (`server.js:8436`). Verified
rather than inherited:

| claim | measured |
|---|---|
| a claim writes `profile_signal_suggestions.assertion='claimed'` | yes |
| `listProfileClaims` feeds generation **and nothing else** | **confirmed — 1 consumer** |
| AG2's copy "It does not change this score" is still literally true | **it was** |
| `PUT /:id/signals` writes `profile_simple_apply_profiles` | yes — the "Extracted …" textarea |
| `/signals/refresh` silently overwrites those edits | yes, via `upsertSimpleApplyProfile` |

And one the brief did not mention: **`profile_signal_suggestions` is empty and every
`selected_keywords`/`tools`/`verbs` is `'[]'`.** There were no claims at all to carry, so this is a
path being built, not a migration of existing data.

---

## 2 ⛔ The conflict this had to resolve, stated plainly

The code I changed carried an explicit argument for the *opposite* of requirement 1:

> **WHY IT DOES NOT WRITE domain_profiles**
> `buildRuntimeAtsBasis` folds `selected_tools`/`selected_keywords` straight into the text the ATS
> report scores the résumé against. Writing a claim there would mean ticking a box raised your own
> score with no résumé evidence behind it — which is exactly the "add this to improve your score"
> incentive this feature must not create. **A claim informs GENERATION; it never scores itself.**

Requirement 1 requires claims to affect the band and the board. Requirement 2 answers the objection
directly: the integrity line holds through **provenance and framing** — the system may suggest, only
the user may claim, nothing is pre-checked, and the copy reads "I have this".

**CC4 reverses the conclusion and keeps the concern.** A claim counts, because a person's fit is not
limited to what their current document happens to spell out. What replaces the old guarantee is not
nothing:

- **The scorer keeps two indexes.** `evidenceText` is what the résumé and profile actually say;
  `matchText` adds the claims. Scoring runs against `matchText`, so a claim counts — but anything
  matched by `matchText` and **not** by `evidenceText` rested on the candidate's word alone, and the
  report names it in **`claimed_matches`**. The effect is real and never hidden.
- **The incentive is fought where it is created** — in the interaction. Nothing is pre-checked, and
  the copy asks for the truth rather than offering a reward.

Without that second index this change would have been a silent self-inflation channel. It is the
reason I consider the reversal defensible rather than merely instructed.

---

## 3 · What was built

| requirement | what changed |
|---|---|
| **1** claims reach both scorers | `buildRuntimeAtsBasis` takes `claims`; all **8** basis call sites pass `atsClaims(profile)`; the bridge receives them too |
| **2** copy and never pre-checked | `ATSPanel.jsx` now says a claim **counts**, and asks "only if it is true of you". The old promise is gone. Nothing pre-selected (unchanged) |
| **3** one store | **`profile_signal_suggestions` is canonical.** `selected_*` is read-only legacy: still read for backwards compatibility, never written with a new assertion |
| **4** stop the silent overwrite | Claims are **safe by construction** — they live in a table `refresh` does not touch. The response now states `replaced: "extracted"`, `preserved: "claims"` |
| **5** withdrawal must work | An `'applied'` term is now withdrawable, and the withdrawal prunes **both** stores in one transaction |
| **6** the bridge reads it | claimed skills are **prepended** to the derived list |
| **7** per-profile output | **Not fixed, as instructed** — noted as the CC5 dependency |

### ⛔ `atsClaims` is keyed off `profile.user_id`, not a `userId` in scope

Eight call sites with eight different local variable names is eight chances to pass the wrong one. A
profile's claims belong to its owner by definition, so reading the owner off the row makes the
mistake impossible rather than unlikely.

### ⛔ Claims are PREPENDED to the bridge's derived skills

`profileFilterBridge` caps derived skills at `MAX_DERIVED_SKILLS = 6` by taking the **first** six, so
appending would mean a profile with six extracted terms silently drops every claim. An explicit
assertion outranks an extraction — and CC2 measured that extraction to be largely noise
(`near`, `provided`, `tasks`, `college`). They are merged into a **separate** object, not into
`signals`, which has another reader (the YoE constraint).

### ⛔ Requirement 5 is fixable *because* of requirement 3

The old code matched `assertion = 'claimed'` only, and said why: an `'applied'` term "also lives in
`domain_profiles.selected_tools`, and silently un-claiming it here would leave the two stores
disagreeing; that legacy path has never had a remove and this is not the place to add one." That was
an acknowledged omission whose effect was a **one-way door on the user's own assertion about
themselves** — the one thing this feature must not have.

Unifying the stores is what makes it fixable: withdrawal now removes the term from both, in one
transaction, matched on the **normalised signal key** (the two stores were written by different paths
and do not agree on spelling or case). A no-op withdrawal touches neither store, because the prune is
a consequence of a withdrawal rather than an independent delete.

---

## 4 · Verification — the brief's own list, against the real server

```
=== 0 · NOTHING IS PRE-CHECKED ===
  rows for a fresh profile: 0

=== 1 · BOARD BEFORE ===
  total=849  rankedKeys=["q","role_key","target_title_exact","target_title_role"]
  top 3: recruitee::2548164 | recruitee::2622523 | workable::B02DA69C8F

=== 2 · CLAIM "Kubernetes" ===
  POST /api/domain-profiles/:id/claims -> 200
  rows: [{"signal_label":"Kubernetes","assertion":"claimed"}]

=== 3 · BOARD AFTER ===
  rankedKeys=[…,"skills_include"]      skills_include now ranked: true (was false)
  top 3: ashby::a90cdb7c… | ashby::b9dee2a0… | greenhouse::8055701
  ORDER CHANGED: true        demoted 372 -> 526

=== 4 · WITHDRAWN ===
  assertion: none      rankedKeys back to 4 keys
  ORDER REVERTED to the before state: true

=== 5 · /signals/refresh ===
  replaced=extracted  preserved=claims
  claim rows before 1, after 1      CLAIM SURVIVED: true
```

**The band** is covered by unit tests over the real scorer: a claimed term moves the score up, the
claimed term moves from `missing` to `matched`, withdrawing puts the score back **exactly**, a claim
for something the job never asked about changes nothing, and a claims-only profile is still scorable.

**Generation still works** — asserted, because CC4 adds consumers and must not lose the original.

2,512 tests pass (10 new in `test/claimedTermsReachScorers.test.js`, 3 rewritten in
`test/profileSignalClaims.test.js`).

---

## 5 · Tests that changed meaning, and were not relaxed

Three tests asserted behaviour CC4 deliberately reverses. Each was **rewritten to assert the new
truth plus the property the old assertion was protecting**, rather than deleted:

- `test/profileSignalClaims.test.js` — "a term applied through the old one-way path still reads as a
  claim" asserted that it was **not** withdrawable. It now asserts that it **is**, *and* that both
  stores moved, which is the disagreement the old comment feared.
- `test/localAtsScorer.test.js` — required the panel to say "It does not change this score". Now
  requires it to say a claim **counts**, to **not** carry the old promise, and to ask for the truth.
  The anti-bait check (`improve/boost/increase your score`) is unchanged and is now the whole of the
  incentive guard.
- `test/atsTermCategories.test.js` — same sentence list, same treatment.

Two **harnesses** pinned the old copy too (`scripts/ag2ClaimsUi.mjs`, `scripts/ah3TermPanelShots.mjs`)
and were updated the same way.

---

## 6 · What was NOT done, and one thing I could not verify

- **Requirement 7 (per-profile output).** Explicitly out of scope: *"Note the dependency; do not fix
  it here."* It is CC5's — `scraped_jobs.ats_score` is one cell per job, shared across all users and
  profiles.
- **A screenshot of the claim surface, and this one matters more than in CC1–CC3** because CC4
  changes user-visible copy. `scripts/ag2ClaimsUi.mjs` is the harness that drives the real panel in a
  browser, and **it cannot run on this board**: it requires `scraped_jobs id=1974`,
  `domain_profiles id=1` and a base résumé for profile 1 — none of which exist. Those fixtures were
  destroyed by the deletion recorded in `docs/am1-recovery.md`, so this is a **pre-existing
  breakage**, not something CC4 caused. Consequence to be honest about: **the copy assertions I
  updated inside that harness are themselves unexecuted.** The copy is still verified, at the source
  level, by the two node tests above — which do run and do pass. The in-browser render is not.
- **Nothing backfills claims**, because there are none to backfill.

---

## 7 · A note for CC5

CC4 makes a claim change the band. `scraped_jobs.ats_score` is a **cross-user cache** — one cell per
job — so the *stored* score cannot express a per-profile claim even in principle. Until CC5 keys
those caches on `(user_id, domain_profile_id, job_id)`, the band a claim moves is the one computed
**per request**, not the one persisted on the row. That is not a defect introduced here; it is the
reason CC5 exists, and it now has a second caller depending on it.
