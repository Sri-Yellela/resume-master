# Next Work

**Last reconciled:** 2026-09-08, after tasks W and X. Closed findings moved to
**`docs/FINDINGS_ARCHIVE.md`** — this file now holds only what is open.

**Baseline:** 2326 passing, 0 failing. Migration high-water **103** local, **101** production —
⚠ **102 and 103 are NOT deployed**; the new ATS company lists do nothing until they are.
Contract **v1.1.1**.

> ⚠ **Re-derive state from the repo before starting anything.** This file has been the stale thing
> four times: AK2 found three of five tasks already done, AL1 found two of three, AM3 found two
> claims wrong, AM4 found the central premise of its own task inverted. Agents land work faster than
> the doc reconciles. The check has caught it every time.

---

## Open

| # | Task | Repo | Needs | State |
|---|---|---|---|---|
| **V** | Enrichment import: UI + guards, concurrency-report bug | desktop | — | **done** — see `am4-enrichment-control.md` § U5 |
| **W** | Wire the remaining ATS providers | desktop | — | **done** — see `w1-ats-providers.md` |
| **X** | Clearbit is dead — logos all failing | desktop | — | **done** — see `x1-clearbit-dead.md` |
| **Y** | SmartRecruiters + Workday descriptions (needs an N+1 budget) | desktop | — | open — from W |
| **Z** | The board lost its ATS badge | desktop | — | open — from X |
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

## TASK W — Wire the remaining ATS providers — DONE

**Outcome.** The brief's premise held for four of five and was wrong for lever, which had a company
list all along: three active rows, five crawls of `no_results`, all three slugs 404. Mercury had
moved to greenhouse, Ramp to ashby; Retool is on no board we can find and is deactivated rather
than guessed (the 070 Rippling precedent). Per-source causes came straight out of `pipeline_runs` —
`no_results` for lever, `skipped_unconfigured` for the other four. They do not share a cause.

Bigger find, not in the brief: **live search was structurally capped at three of seven sources**.
`searchJobs` took `_ghCompanies`/`_leverCompanies`/`_ashbyCompanies` as three named parameters, so
the other four plugins could only ever be handed an empty list however many companies the table
held — invisible, because a plugin with no companies returns an empty result rather than an error.
Both call sites now group `company_ats_list` through one `groupCompaniesByAtsType()`.

Three source defects, all found by measuring field coverage on NORMALIZED rows rather than endpoint
reachability: **workable** descriptions 0/20 → 20/20 (`?details=true` returns them in the SAME
request — the code comment claiming a per-posting N+1 was needed was simply wrong), **recruitee**
was storing raw HTML, **lever** 51/60 → 60/60 with a prefix-only `slice(0,3000)` replaced by the
shared tail-preserving helper.

Enabled +141 rows, all 100% description coverage, plus Mercury 40 and Ramp 96. **Veeva (596),
Ubisoft (97), Bosch (334) and Adobe (217) are seeded INACTIVE with the measured reason recorded** —
Veeva on volume alone, the other three because SmartRecruiters' and Workday's list endpoints carry
no job text and `enrichJob.js` skips description-less rows.

Verified with a real `cacheJobs` run against a **copy** of the live database: every predicted count
matched, and 0 NULL `automation_tier`/`fingerprint`/`req_uid` on the new rows. Items 3–5 are
answered in the doc — all three production writers route through the shared derivations;
**THEIRSTACK_API_KEY is vestigial**; **SERPAPI_KEY is live but half-wired**.

---

## TASK X — Clearbit is dead — DONE

**Outcome.** Confirmed **gone, not blocked and not rate-limited**: `logo.clearbit.com` has no A
record while `clearbit.com` still resolves, and the SOA comes from Clearbit's own Route53
nameserver — Google and Cloudflare agree. No status code can report that, which is exactly why
`fetchLogoUrl`'s HEAD check missed it, and its `catch` then returned **another Clearbit URL**. The
fallback for "this provider is unreachable" was that provider; hence 1290 of 1296 rows holding a
dead address.

Replaced with DuckDuckGo icons behind a single `LOGO_HOST` — the hostname had been written out
longhand in three files, which is why retiring it was a hunt rather than an edit. The per-render
request is genuinely stopped: CompanyIcon's failure memo was component-local `useState`, so it
silenced one card while the board re-requested on every remount; it is now a module-level Set keyed
by URL. `server.js` was also silently falling through to a **Google** favicon on every call, sending
browsing to a third party the privacy policy does not name — removed, and both retired hosts are
swept by `backfillCompanyLogos` (boot + admin script, offline, feed-supplied logos never touched).

Found while verifying the backfill: `companyToDomain` matched with a bare `includes()`, so
**Physical Super*intel*ligence rendered Intel's logo** — along with Squarespace→squareup,
Applecart→apple, Metabolic→meta. Now word-boundary matched, with all 81 table entries asserted to
still resolve to themselves.

The harness had been stubbing `logo.clearbit.com` with a 1x1 PNG, so its logo assertions passed for
the entire time every logo on the board was dead. It now stubs `LOGO_HOST`.

⚠ **The general lesson is bigger than the sweep.** A DNS sweep of all 24 external hosts found
exactly one dead name — but it would have caught only one of the three failures hit so far. The
Groq model id and task W's lever slugs were **identifiers retired while their host stayed up**,
which no host probe can see and which always surface as a plausible empty success.

---

## TASK Y — SmartRecruiters and Workday descriptions

```
Both are seeded in company_ats_list but INACTIVE, because their list endpoints carry no job text:
measured 0% description coverage across Ubisoft (97 kept), Bosch (334) and Adobe (217).
enrichJob.js skips description-less rows, so enabling them today adds 648 permanently unenrichable
rows to the board.

Unlike Workable — where the fix turned out to be one ?details=true on the same request — these two
genuinely need a per-posting detail fetch:
  smartrecruiters  GET /v1/companies/{id}/postings/{id} → jobAd.sections{companyDescription,
                   jobDescription, qualifications, additionalInformation}
  workday          per-posting detail call; the CXS search response has no description field at all

1. The blocker is a BUDGET MODEL, not parsing. cacheJobs' shared crawl loop has no notion of a
   per-source request budget, and Bosch alone is 900 postings. Design that first.
2. Workday needs three more things besides descriptions — see docs/w1-ats-providers.md item 2:
   posted_at is approximated from "Posted 30+ Days Ago", locationsText is sometimes a COUNT
   ("2 Locations") rather than a place, and a wrong wd#/site is an opaque HTTP 422.
3. test/companyAtsList.test.js FAILS if either provider is activated — deliberately. Fix the
   descriptions first, then flip the seed.
4. Also inactive: lever/veeva, 596 kept rows. Nothing is wrong with it; it is +47% board size from
   one company while enrichment drains at 25/day. A volume decision, not an engineering one.
5. SmartRecruiters ids are opaque and case-sensitive, and an unknown one returns 200 with
   totalFound:0 rather than a 404 — validate a slug by asserting a non-zero count, never a status.
```

---

## TASK Z — The board lost its ATS badge

```
scripts/ae5BoardUi.mjs reports `AE5  the ATS badge survived — MISSING` on a real Chrome render.
PRE-EXISTING: it fails identically on HEAD and was not introduced by task X.
scripts/harnessBaseline.json expects 25 passes; HEAD and current both deliver 24.

The node suite is green at 2326 and cannot see this — it is a rendered fact, which is the whole
reason ae5BoardUi exists. Find when the badge disappeared, and whether the data or the render went.
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
- `THEIRSTACK_API_KEY` is **vestigial** — task W traced its only consumer to the offline
  `scripts/providerEval` harness. No production import, no write path, and it is not set locally.
  Safe to remove unless the provider eval will be re-run.
- `SERPAPI_KEY` is **live but half-wired** — the key works (probed, returned rows), but cacheJobs
  never crawls serpapi, its `search()` early-returns on the empty query the cron passes, and half
  its results are dropped by `filterDirectApplyOnly` as aggregator URLs. Zero rows have landed.
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
nothing. Task W's version: an ATS source is only wired when its NORMALIZED rows carry the fields —
workable's fetcher worked perfectly while every description came back null.

**A fallback that returns the same provider is not a fallback.** Both `fetchLogoUrl` and
`fetchCompanyIcon` answered "this provider is unreachable" with that provider's own URL. 1290 rows.

**A dead IDENTIFIER outlives its host, and no host probe sees it.** Three for three now: the Groq
model id, task W's three lever slugs, and Clearbit. Only Clearbit was a dead hostname; the other two
sat on hosts that resolve and return 200. Each failed as a plausible empty success.

**A harness that stubs a third party cannot report that third party dying.** `ae5BoardUi` answered
`logo.clearbit.com` with a 1x1 PNG — correctly — and so its logo assertions passed for the whole
time every logo on the board was dead. Stub the SHARED constant, never a hostname literal.

**Do not undo the reverted ATS floor fix.** Measured worse: ρ 0.448 → 0.242. Pinned by a test.

---

## Cross-references

`docs/FINDINGS_ARCHIVE.md` · `docs/CORRUPTION_SWEEP.md` · `resume-master-android/ANDROID.md` ·
`resume-master-ios/IOS.md` · `docs/AUTOAPPLY_PROMPTS.md` · `docs/GATED_HANDOFF_ARCHITECTURE.md` ·
`docs/PIPELINE_DIAGNOSIS.md` · per-task reports `docs/a{j,k,l,m}*.md`
