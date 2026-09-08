# Next Work

**Last reconciled:** 2026-09-08, compaction pass. Closed findings moved to
**`docs/FINDINGS_ARCHIVE.md`** — this file now holds only what is open.

**Baseline:** 2301 passing, 0 failing. Migration high-water **101** local, **101** production after
the 09-08 deploy. Contract **v1.1.1**.

> ⚠ **Re-derive state from the repo before starting anything.** This file has been the stale thing
> four times: AK2 found three of five tasks already done, AL1 found two of three, AM3 found two
> claims wrong, AM4 found the central premise of its own task inverted. Agents land work faster than
> the doc reconciles. The check has caught it every time.

---

## Open

| # | Task | Repo | Needs | State |
|---|---|---|---|---|
| **V** | Enrichment import: UI + guards, concurrency-report bug | desktop | — | **done** — see `am4-enrichment-control.md` § U5 |
| **W** | Wire the remaining ATS providers | desktop | company board lists | open |
| **X** | Clearbit is dead — logos all failing | desktop | — | open, small |
| — | iOS Phase 1 audit | ios | **a Mac** | open — `resume-master-ios/IOS.md` |

Android's open work is in `resume-master-android/ANDROID.md`: admin build flavour, backup excludes,
then the feed and review queue.

---

## Owner actions, not agent work

| | |
|---|---|
| **AF5** — 30 real applications, 10 per ATS | the only test of whether ρ = 0.746 predicts anything about **employers** rather than about your own judgement |
| **Extension submission** | ~20 min. Preflight green, screenshots taken, policy live. Needs your Google login and the `CWS_*` credentials |
| **Judge the ~2,000 in-place rewrites** | see below |
| **Jobo** | deferred to launch readiness, not pending |

---

## Enrichment drain — live

Candidates **837 → 790** over four manual passes; ~$0.10 spent. `enrichment_batches` confirms
`anthropic / claude-haiku-4-5-20251001` via `resolveProvider`.

```js
// DRY RUN — nothing sent, nothing charged
await (await fetch('/api/admin/enrichment/run', { method: 'POST', headers: {'content-type': 'application/json'}, credentials: 'include', body: JSON.stringify({ limit: 10 }) })).json()

// APPLY — run ONCE, wait for the response before running anything else
await (await fetch('/api/admin/enrichment/run', { method: 'POST', headers: {'content-type': 'application/json'}, credentials: 'include', body: JSON.stringify({ limit: 10, apply: true }) })).json()
```

⚠ **Running `apply: true` twice returns `applied:true` with all zeros and `batchId:null`.** That is
the concurrency guard refusing an overlapping invocation, reported as a completed run. Misread as a
failure twice. Fixed in task V.

⚠ **~19–25 values are CORRECTED IN PLACE per 10 rows** — overwhelmingly `summary` and
`normalized_title`, which ingestion had already filled, so they move no fill rate and are invisible
in `columnsClimbed`. That is **~2,000 rewrites** across the backlog. `normalized_title` feeds
`profileTitleSql`'s board narrowing *and* the ATS scorer, so they are not cosmetic. **Nobody has
judged whether they are improvements** — only that they differ. Before-image:
`POST /api/admin/enrichment/batches/{id}/revert {apply:false}`

**Only `skills_json` is a real gain.** `summary`, `normalized_title` and `experience_level` are
already 1255/1255 from ingestion.

---

## ⚠ The economics changed — supersedes task U's framing

Task U said export/import "does NOT save cost, because whoever enriches externally still pays the
tokens." **True of metered API credits; false now.** Enrichment runs under a flat-rate subscription,
so an external round trip costs ~$0 at the margin.

So export/import is the **primary** enrichment route, and **more ATS providers is desirable** rather
than a backlog risk — more rows to enrich at no marginal cost. Hence tasks V and W.

---

## TASK V — Enrichment import — DONE

**Outcome, against the brief below.** Task U's endpoints were sound; what was missing was the UI,
the coverage reporting, and the volume ceiling. Built: `EnrichmentTransferPanel` in the Schema
Explorer beside the two exports; per-column fill delta on both the dry run and the apply, with a
loud `columnsClimbed: 0` warning; a raw `application/x-ndjson` upload path. Concurrency guard fixed
— `POST /run` now answers **409 `{skipped:true, skippedReason:'already_running'}`** instead of
`applied:true` with zeros. Verified by 61 real-run assertions across two new harnesses.

Two of the brief's own premises turned out to be wrong and are corrected in the doc:

- **Export CSV does NOT mangle `skills_json`.** Tested on 200 real rows: a strict RFC4180 parser
  round-trips every value byte-identically. JSONL is still right, but for different reasons — CSV
  cannot distinguish "not supplied" from "explicitly null" (which the fill-nulls-only default and
  the tri-state visa flags both depend on), and it has no read-only surface.
- **The three export paths are not duplicates and none was retired.** Download .sql is DDL only,
  with no rows; Export CSV is a generic dump of 10 allow-listed tables; the JSONL export is the
  round-trip contract carrying the staleness interlock. Retiring either real one loses something.

<details><summary>Original brief</summary>

```
EXPORT ALREADY EXISTS — the Schema Explorer's Export CSV and Download .sql. Task U's export endpoint
may duplicate it: report, and retire one. Two export paths that drift is the most-repeated defect
in this codebase.

⛔ FIRST, TEST WHETHER Export CSV MANGLES skills_json. Nested array, and CSV has no nested type. If
it flattens, the round trip is broken before it starts — and skills_json is the ONLY column
enrichment actually gains.

WHAT IS MISSING IS INJECTION. No import control exists anywhere in the admin panel. Task U built
endpoints with no UI, and an endpoint nobody can find is a feature that does not exist.

GUARDS, non-negotiable:
  · FILL NULLS ONLY by default; overwrite needs an explicit deliberate flag.
  · Validate every column first — experience_level / workplace_type against the shared option
    registry (NOT free text), skills_json parses as an array, salary_* integers, visa flags
    0/1/NULL only.
  · Malformed batch FAILS AS A WHOLE, naming offending rows. Never partially apply.
  · Match on job_id. Unknown ids REJECTED, never inserted.
  · content_hash staleness check — refuse rows whose posting changed after export.
  · DRY RUN is the default.
  · Record as a batch, source='import', with a before-image so revert works identically.
  · NEVER write enriched_at where nothing was filled — that poisoning cost 120 rows once.
  · Report per-column coverage, not row counts.
  · State the practical batch size. 790 job descriptions may not fit in one request.

ALSO: the concurrency guard returns applied:true with zeros and warning:null when it refuses.
Return a distinct skipped state naming the reason.
```
</details>

---

## TASK W — Wire the remaining ATS providers

```
Only greenhouse and ashby produce rows. directApplyFilter.js's DIRECT_ATS_SOURCES names SEVEN:
greenhouse, lever, ashby, workday, smartrecruiters, workable, recruitee. Source files exist for all
of them in services/jobs/sources/.

⛔ NO NEW API KEYS ARE NEEDED. lever, workable, recruitee and smartrecruiters serve public JSON
board endpoints. What is missing is the CONFIGURED COMPANY BOARD LIST — the thing that decides which
companies get polled. Find where greenhouse's and ashby's lists live and report the shape before
adding anything.

1. Report why the other five produce zero rows: no company list, a broken fetcher, or never wired
   into the cron. Answer per source; do not assume they share a cause.
2. Workday is per-tenant and structurally different — report what it needs rather than forcing it
   into the same shape.
3. Every new writer routes through reconcileFingerprint / computeReqUid. Canonical priority is
   direct ATS > provider > aggregator > import. Grep-prove no writer bypasses it.
4. automation_tier must be derived on write, through the SAME derivation function every other
   writer uses. A new source landing NULL tier is not completable on mobile and invisible to the
   tier filters.
5. SERPAPI_KEY and THEIRSTACK_API_KEY are in the production environment. §3.5 found no write path
   produces serpapi rows. Report whether either is live, vestigial, or half-wired — an API key in
   production for a source nobody has mentioned is worth knowing about either way.
6. Report the expected row volume per source before enabling. The board is ~1255 active; adding
   five sources could multiply that, and enrichment is manual right now.
```

---

## TASK X — Clearbit is dead

```
logo.clearbit.com returns ERR_NAME_NOT_RESOLVED on every request — the service appears to be gone,
not slow. Every company logo on the board fails. services/jobs/enrichLogos.js and
shared/companyLogos.js depend on it.

Same shape as the Groq model retirement: an external service disappeared and the code kept calling
it. Cosmetic in impact, but it is a dead third-party dependency generating failed requests on every
board render.

1. Confirm it is gone rather than blocked/rate-limited.
2. Either replace the source or fall back cleanly to the lettered tile already in use — and stop
   issuing the request, rather than letting it fail per card per render.
3. Check for other external dependencies with no liveness handling. This is the third dead external
   thing found by accident (Groq model, Clearbit, and the LinkedIn API assumptions).
```

---

## Environment — current state

Present in Railway: `ANTHROPIC_KEY` · `APP_BASE_URL` · `FRONTEND_URL` · `GOOGLE_CALLBACK_URL` ·
`GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET` · `JOBO_API_KEY` · `NODE_ENV` · `PORT` ·
`PUPPETEER_EXECUTABLE_PATH` · `SERPAPI_KEY` · `SESSION_SECRET` · `THEIRSTACK_API_KEY` ·
`GROQ_API_KEY` · `GOOGLE_API_KEY`

**Nothing is missing for current operation.** Notes:

- `ENRICH_PROVIDER` / `ENRICH_MODEL` are **correctly absent** — enrichment falls back to Haiku per
  A2's verdict. ⛔ **Do not set them again without re-reading A2**: Groq scored 30.5% Jaccard on
  `skills_json`, which feeds both the technographics table and the ATS scorer.
- `GROQ_API_KEY` and `GOOGLE_API_KEY` are therefore **dormant** in production. Harmless, and correct
  to keep for when volume justifies a measured cheaper model.
- `THEIRSTACK_API_KEY` has never appeared in any audit. See task W item 5.
- Caps default in code: `APPLY_DAILY_CAP` 25, `APPLY_DAILY_QUEUE_CAP` 40,
  `APPLY_DAILY_APPROVAL_CAP` 30, `ENRICH_BATCH_SIZE` 25. Set them explicitly only to override.
- ⚠ **`ENRICH_BATCH_SIZE` 25 × one daily cron = ~6 weeks to drain 790.** The cron is a trickle; the
  manual trigger is the only thing that can clear a backlog. Worth raising, or looping the cron
  within a bounded budget.
- **No full-auto kill switch variable is visible.** AF3 specced one. Confirm whether it exists under
  another name before the first unattended run.

---

## Lessons still in force

These are load-bearing for work in progress. The full catalogue is in `docs/FINDINGS_ARCHIVE.md`.

**Assert a JSON key, never a 200.** The SPA catch-all answers 200 for any unknown path, and a
status-code probe once "confirmed" a deployment that had not happened.

**A guard never seen to fail is not evidence.** Verify by injecting a violation. Three guards have
shipped blind to the thing they guarded.

**Route by payload, not by call-site name.** `purpose classifier` sends 2000 chars of résumé;
`classify_job` does not.

**`max_tokens: 500` silently breaks reasoning models.** Seen twice, both times as HTTP 200 with a
clean usage row and nothing extracted.

**Report coverage, not counts.** `enriched: 10` is true whether ten rows gained everything or
nothing.

**Do not undo the reverted ATS floor fix.** Measured worse: ρ 0.448 → 0.242. Pinned by a test.

---

## Cross-references

`docs/FINDINGS_ARCHIVE.md` · `docs/CORRUPTION_SWEEP.md` · `resume-master-android/ANDROID.md` ·
`resume-master-ios/IOS.md` · `docs/AUTOAPPLY_PROMPTS.md` · `docs/GATED_HANDOFF_ARCHITECTURE.md` ·
`docs/PIPELINE_DIAGNOSIS.md` · per-task reports `docs/a{j,k,l,m}*.md`
