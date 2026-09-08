# AM3 — the board is back, and the brake is not deployed

**Date:** 2026-09-07
**Tasks:** S (restore the local board) · T (brake deployment + prod/dev schema) · A2 (provider verdict)
**Baseline:** 2245 passing / 0 failing before, 2245 / 0 after the restore. Migration high-water 100.

---

## The one-line version

The local board is refilled — **1291 rows restored, 1296 total / 1266 active** — and ρ now reproduces
identically from the table and from the committed fixture, which is the thing task R could not prove
on its own. Production's schema turned out to match local everywhere that matters, and the one real
difference is inert and explained. But **the cleanup brake task R landed is not on production's code
path**, and the provider verdict A2 asked for could not be measured against the model it named,
because that model no longer exists.

Two claims in `NEXT_WORK.md` were stale and are corrected at the bottom.

---

## Task S — the board is restored

### What was done

`data/evidence/resume_master_2026-08-31T06-00-00-534Z_auto-daily.db` (sha256 `ad8b5c29…9ccffc`,
re-verified against the pinned `.sha256` before use) → `scraped_jobs` in `data/resume_master.db`,
via `scripts/am3RestoreBoard.mjs`.

| | before | after |
|---|---|---|
| `scraped_jobs` | 5 rows / 5 active | **1296 rows / 1266 active** |
| distinct `location` values | 4 | **236** |
| graded postings on the board | 0 / 30 | **30 / 30** |

A `VACUUM INTO` safety copy was taken first —
`data/evidence/pre-am3-restore_2026-09-07T07-54-18-276Z.db`, 101.1 MB. `VACUUM INTO` rather than a
file copy because the live DB runs in WAL mode with a 671 KB `-wal`, and `cp` can capture a torn
page set.

### ⛔ Why this was a TABLE restore and not a file restore

The evidence DB is **five migrations behind** live — it lacks `096_usage_events_provider`,
`097_generation_deferred_to_approval`, `098_skill_synonyms`, `099_lca_company_resolutions` and
`100_form_field_mappings`. Copying it over `data/` would have rolled the schema back five migrations
and taken every user table with it, including the `usage_events` rows task A2 reconciles against.

None of those five alter `scraped_jobs`, and that was **measured, not inferred**: the preflight
compares the `CREATE TABLE` text of both databases and refuses to run if they differ. They are
byte-identical across all 63 columns.

### ⛔ Why `scraped_at` was rebased, and why that is not a falsification

Every evidence row has `scraped_at` in 2026-08-21..24. Cleanup expires on `scraped_at < now-7d`, so
a verbatim restore is **expired on arrival**. The next `node server.js` would have counted 1291 of
1296 rows deletable, task R's brake would have refused the mass delete, and it would have retired
all 1291 instead — leaving 1296 rows / **5 active** and a restore that accomplished nothing.

Rebasing is what the real refill already does. `services/jobs/aggregator.js:319` runs
`UPDATE scraped_jobs SET updated_at = ?, scraped_at = ?, is_active = 1` on every re-sight, so
`scraped_at` means **last seen by a writer**, not first discovered. `discovered_at` is first-seen
(`services/jobs/jobCursor.js:63` says so, and the board sorts on
`COALESCE(discovered_at, scraped_at)`). So `scraped_at = now` is the honest value for "the restore
put this row on the board just now", and `discovered_at`, `posted_at` and `is_active` were carried
across untouched — which preserves the true provenance *and* the true board ordering.

### Requirement 2 — no user table was altered

Asserted, not intended. Nine guard tables are counted before the transaction and re-counted
**inside** it; a mismatch throws and rolls the whole restore back.

`users` 4→4 · `domain_profiles` 2→2 · `profile_base_resumes` 2→2 · `apply_runs` 1→1 ·
`usage_events` 1414→1414 · `user_jobs` 0→0 · `company_technographics` 8690→8690 ·
`company_org_units` 697→697 · `ats_term_weights` 856→856.

### Requirement 3 — the derived tables, reconciled with a stated rule each

"Orphan" means something different in each table, and the wrong rule here is what would justify a
destructive rebuild. **Nothing was re-derived.**

| table | rule applied | result |
|---|---|---|
| `company_technographics` (8690) | keyed on `(company, skill)`, no `job_id` to join. A company fact **outlives** the posting that evidenced it, so a row is orphaned only if the company has no posting at all. | 8580 rows / 7 companies join to a live posting; **110 rows / 3 companies** have none. Stale-but-valid — kept. |
| `company_org_units` (697) | company-level liveness **plus** whether the postings each row cites in `source_postings_json` are back. The only derived table with a real per-posting join. | **1100 / 1100 citations resolve again; 697 / 697 rows fully re-evidenced.** `corroboration_count` is checkable rather than a floor. |
| `ats_term_weights` (856) | no join key exists — corpus-wide document frequencies. Validity is whether the stored `corpus_size` still matches the board it describes. | every family within 2–3 rows: `__global__` 1289 vs 1266, `engineering` 350 vs 347, `data` 98 vs 96, `pm` 94 vs 92. |

The per-family figures are compared **against the same family's live count** (classified with
`roleFamilyForTitle`, the way the weights were computed), not against the whole board. The first
version of this report held `data`'s corpus_size of 98 up against 1266 active rows and printed a
meaningless "+1168".

⛔ **`computeTermWeights`, `runHiringSignalsRollup` and `runOrgLayerRollup` are still blocked** by
`services/jobs/boardSufficiency.js`. Refilling the board does not mean the rollups should now run —
that is a separate decision, and the weights above are valid precisely *because* nothing recomputed
them.

### Requirement 4 — no enrichment was run

All **1291 restored rows arrived enriched**: 0 without `content_hash`, 0 without `enriched_at`.
1302 `enrich_job` events already exist for them; the spend already happened.

2 restored rows have no `skills_json` but *are* enriched — the model returned no extractable skills.
That is an answer, not a gap, and re-running would pay to receive it again.

The 5 pre-existing rows lack enrichment and always did: they are `aj2SeedMobileBoard`'s synthetic
band-boundary fixtures. Counting them with the restored rows would have reported a 5-row shortfall
that no enrichment run should ever be spent closing, so the report splits by provenance.

### Requirement 5 — the location guard, both halves

|  | restored board | **empty board** |
|---|---|---|
| Bangalore · Bengaluru · San Francisco · Dublin · Singapore | ✓ true | ✓ **true** |

And the inverse holds — `EMEA Marketing`, `AI team` and `Payments Infrastructure` are all correctly
**not** read as places.

The empty-board column is a real SQLite database with the same schema and no rows, not a mocked
function. Task R's `SEED_LOCATIONS` floor is doing the work there, which is the whole point: **the
corpus is now an improvement rather than the thing holding the guard up.** The
`[failsafe] the location vocabulary drew only 0 entries` warning fires on that pass and only on that
pass, which is the alarm behaving exactly as designed.

### VERIFY — ρ reproduces, and the board and the fixture agree

```
30/30 graded postings found on the restored board
30/30 descriptions byte-identical to the fixture
30/30 scores identical between board and fixture

published (2026-08-31, board of 1290)   rho 0.746
from the committed fixture              rho 0.737   (drift 0.009)
from the RESTORED BOARD                 rho 0.737   (drift 0.009)
```

**The board and the fixture agree exactly.** Task R proved ρ reproduces *from the fixture*; this
proves the fixture is a faithful copy of the table it was extracted from — the one thing task R
could not establish on its own.

Both differ from the published 0.746 by 0.009, which task R already measured and explained: the
seniority guard landed after the 30 were graded and moved 26 of the 30 individual scores. ρ measures
ordering, and the ordering largely survived. The scoring inputs are assembled exactly as
`scripts/am1GradedCorpusVerify.mjs` assembles them — including per-posting, role-family-scoped
`loadTermWeights(db, roleFamilyForTitle(p.title))` — so the two figures are comparable rather than
coincidentally similar.

---

## Task T — the schemas, and the brake

`scripts/am3ProdSchemaDiff.mjs`. Read-only: three authenticated GETs against
`https://resumemaster.one`. **No schema change was applied or proposed.**

### Requirement 3 — the migration high-water (run first, because it bounds the diff)

```
production   107 rows applied,  high-water 100
local        107 rows applied,  high-water 100
✓ IDENTICAL migration sets — no id present in one and absent in the other.
```

This is the **first real measurement of the dual-path guarantee** against a deployed database. It
also sets the expectation for the diff: with identical migration sets, any difference found must
come from something created *outside* the migration system.

### Requirement 2 — the full schema diff

Tables 60 vs 60, indexes 71 vs 72. Three differences, all explained, none of them dual-path drift.

**1. `import_extension_tokens` — production only, 3 rows.**
The extension token copy/paste flow, **removed** in `c818b9c`. SQLite does not drop a table when its
`CREATE` statement leaves the source, so production still carries it — with 3 stale token hashes
bound to `users(id)` that no code will ever expire or consume. Worth a cleanup migration; it is
credential-shaped residue of a deleted feature.

**2. `provider_eval_jobs` — local only, 0 rows.**
A deliberate scratch table created by `scripts/providerEval/db.js` with `CREATE TABLE IF NOT EXISTS`
when that harness runs. Outside the migration system by design, dev-only, empty. Not drift.

**3. `users.apply_mode` and `resumes.apply_mode` have different DEFAULTS.**

```
prod : apply_mode TEXT NOT NULL DEFAULT 'TAILORED'
local: apply_mode TEXT NOT NULL DEFAULT 'SIMPLE'
```

⛔ **This is NOT dual-path drift.** Both paths agree: `scripts/migrations.js:13`/`:44` and
`server.js:391`/`:422` all declare `DEFAULT 'SIMPLE'`, byte-identically. `'TAILORED'` was the
*original* default (`a780d91`) and `b212ca6` changed it to `'SIMPLE'`. Production's tables were
created before `b212ca6`, and **`CREATE TABLE IF NOT EXISTS` is a no-op against an existing table.**

That is the real finding, and it is a genuine hole — just not the one the task expected:

> **The dual path governs what a NEW database gets. Nothing reconciles a long-lived one.** Editing a
> `CREATE TABLE` statement silently changes nothing for any already-deployed database. A numbered
> migration would have. The byte-identity of the two paths is necessary and is not sufficient.

**Impact, measured rather than assumed: inert.**

- `resumes` — both INSERT sites (`server.js:8083`, `:8532`) pass `apply_mode` explicitly.
- `users` — only the admin seed (`server.js:3441`) omits it; `:5054`, `:5635` and `:6101` are explicit.
- and on **read**, `publicUser()` (`server.js:4921-4924`) coerces `applyMode` to
  `allowedModesForTier(planTier)[0]` whenever the stored value is not entitled.

⛔ So production's login response reporting `applyMode: "TAILORED"` is **plan coercion** (admin is
`PLUS` → `TAILORED`), **not** evidence that the column default was ever consumed. Those two
explanations are indistinguishable from outside, and asserting the stronger one would be exactly the
kind of unfounded reading task T exists to correct.

**The `cleanup_log` claim that triggered this task is settled.** Both databases:
`id, run_at, jobs_deleted, orphans_cleaned, details`. `ran_at` is present in neither. The original
note was a query typo, as `b0129f4` already suspected.

`sqlite_sequence` appeared as a fourth "difference" in the first run. It is SQLite's own
AUTOINCREMENT bookkeeping, present in any database with an AUTOINCREMENT column; the export does not
filter it while the local query did. An artifact of the comparison, now dropped on both sides.

### ⛔ Requirement 1 — THE BRAKE IS NOT DEPLOYED

The repo half is not in question. `server.js:4114` calls `assessCleanupScope` **before** the DELETE,
counting with the same predicate the DELETE uses, and retires rows instead of deleting when the
scope is refused.

The question was whether the running process is that code. There is no `/version` endpoint, so this
was settled by ancestry — task Q (`abea2c9`) landed *after* the brake (`bd95d20`) and added
`approvalCap` to `GET /api/apply/pending`:

```
GET /api/apply/pending -> keys: pending
⛔ approvalCap ABSENT.
```

Production predates `abea2c9`. Strictly that does not place `bd95d20` outside the build — it is the
earlier commit — but the two were committed **49 seconds apart**:

```
bd95d20  2026-09-06 14:47:50  task R — brake the deletion
abea2c9  2026-09-06 14:48:39  task Q — approval cap
```

A deploy that picked up one but not the other would have had to land inside that window.

> **`services/jobs/cleanupBrake.js` is in `main` and is not on production's code path.**
> `NEXT_WORK.md` asked this and named the consequence: *"until it is deployed, production is
> protected by uptime rather than by a guard."* That is the current state. **1248 live postings are
> one process start away from the id-85 predicate, with nothing counting the rows first.**
>
> ⇒ **ACTION: redeploy.** This is a deploy, not a code change.

The trigger itself is unchanged from task R's finding: `cleanup_log` id 85 (2026-09-02T02:06, 1288
rows) was the **startup** pass — `app.listen` → `setImmediate` — not the 03:00 cron, and the refill
is the 04:00 `cacheJobs` cron. Both are tied to the process, so the rule empties a board in
proportion to downtime. Reachability is gated by no route and no confirmation: it is one process
start.

---

## Corrections to `NEXT_WORK.md`

The file warns that it has been the stale thing twice in three sessions. It was stale twice more.

1. **"`GROQ_API_KEY` … is NOT in local `.env`"** — it is. `.env` carries a live `gsk_`-prefixed key,
   plus `ENRICH_PROVIDER=groq` and `ENRICH_MODEL`, exactly as task A2's prerequisite (a) asked.
   A2's owner action was already done.
2. **"the saving at stake is only ~$3.32 a pass … $3.3284 over 1303 Haiku calls"** — measured before
   this session's runs: **1302 calls, $3.3244**. Off by one call and 0.4¢; the rest of the framing
   holds.

Both prerequisites for A2 were therefore already satisfied when this session started, and A2 was
still blocked — by a third thing nobody had checked. See `docs/am3-provider-verdict.md`.

Also worth recording: `.env` has `NODE_ENV="production"` on a development machine. That is the
condition that makes the session cookie refuse to set over http, and it is a known cause of a second
tab reading as a logged-out, empty board.
