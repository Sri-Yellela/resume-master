# TASK A3 — Submit guards: idempotency, rate limit, audit trail, kill switch

Follows `docs/auto-apply-a2-provenance.md`. Verified by real runs through the full chain
`POST /api/apply/runs → processRun → processRunJob → autoApply → scripts/fakeAts.js`. The only
`apply_url` used is `http://localhost:4599/*`; nothing reached an employer.

## Migration id: 072, not 069

**The task's stated high-water is stale.** It says "high-water 068, next id 069", but `069_pipeline_runs`,
`070_fix_dead_ats_slugs` and `071_drop_refresh_log` all already exist in both migration files. Using
069 would have collided with an applied migration. This ships as **`072_apply_submit_guards`**.

Additive only — two `CREATE TABLE IF NOT EXISTS` and six `ALTER TABLE … ADD COLUMN`, no drops or
renames. Byte-identical in `server.js` and `scripts/migrations.js` (asserted by test, and md5-equal).

`scripts/migration.js` (singular, what `npm run migrate` runs) is a 54-line runner that imports
`MIGRATIONS` from `migrations.js`, so there are exactly two copies of the list — dual-path is
satisfied by editing both files, as the convention says.

Verified for real, not simulated: applied against a **copy** of the production DB (all 3 structures
present afterwards, re-run pending count 0), and applied through the server boot path
(`[migrate] ✓ 072_apply_submit_guards`, listener bound).

## What was implemented

**1. Idempotency** — `Idempotency-Key` on `POST /api/apply` and `POST /api/apply/runs`. A repeat key
returns the original response with `idempotentReplay: true` and the original status, queueing
nothing. Keyed per user rather than per endpoint: a key reused against a *different* endpoint is a
**409** rather than being answered with the wrong body. **Only 2xx responses are recorded** — caching
a 4xx would pin a transient rejection (a cap that has since reset) as that key's permanent answer.

**2. Cap and concurrency, both configurable** — `APPLY_DAILY_CAP` (default 25) counts submissions in
the trailing 24h; `APPLY_MAX_ACTIVE_RUNS_PER_USER` (default 1) stops stacked runs;
`APPLY_WORKER_LIMIT` (default 2) was hardcoded and is now overridable. Every rejection is an explicit
429 carrying `submittedLast24h`, `limit` and `remaining`. Re-checked **per job** inside
`processRunJob`, because a long run can cross the cap after admission — those jobs are held with
reason `daily_cap_reached`, visible in `/api/apply/review`, never silently dropped. Semi mode is
deliberately exempt: a human submits those.

**3. Audit trail** — on the `apply_run_jobs` row itself: `answers_json` (A2's provenance and
confidence, values included), `resume_artifact_id` + `resume_ats_score` (the temp PDF is deleted, so
the reconstructable reference is the `resumes` row it was rendered from), `screenshot_path`, and
`submit_verified` + `submit_evidence`. Terminal `status`/`reason_code` were already there. Verified
populated by a real run: `submit_verified=1`, `evidence=confirmation_page,url_changed`,
`resume_artifact_id=1 ats=80`, 6 answers each carrying provenance.

**4. Kill switch** — `fullAutoDisabled()` checks the `app_settings.apply_full_auto_disabled` row
first, falling back to `APPLY_FULL_AUTO_DISABLED`. The DB row wins, so it flips **with no restart and
no deploy**; it is read at request time and never cached. Full-auto gets a 503 with
`retryWithMode: "manual"`; semi keeps working. Also re-checked per job, so flipping it mid-run holds
the remaining jobs instead of submitting them.

## A1's two carried-forward findings, both closed

**N1 — `submitted` claimed without verification (was the highest-ranked open finding).** `autoApply`
set `submitted = true` immediately after clicking a submit-shaped button. A form blocked by HTML5
validation therefore reported `status:'submitted'` with zero submissions recorded — a silent
non-application, self-concealing because the duplicate guard then treats the job as done forever.
Now the click is followed by a navigation wait and post-click evidence is required
(`confirmation_page` from `classifyFlowState`, or `url_changed`). Clicked-with-no-evidence is
`filled_not_submitted` with the new reason `submit_unverified`, and the route's mapping was changed
to stop flattening that into the much milder `no_submit_button`.

**N2 — the completeness gate exempted `type:'file'`.** A form with no resume attached passed the gate
while the browser refused to submit it. File inputs expose a readable value (`''` when empty), so
they are now checked like any other required control. **The test asserting the old behaviour had to
be reversed** — `applyPipeline.test.js` literally asserted "must skip file fields in completeness
check", i.e. it was pinning the bug in place.

## Route inventory, as asked

The two `/api/apply/session/*` routes **are placeholders**: `save` returns `{ok:true}` and does
nothing, `:domain` always returns `{exists:false}`. Neither has any caller in the client. They are
dead surface in the shape of §5.4 — harmless, but they will read as working session persistence to
anyone who finds them.

## Findings for the next task

**The clear errors did not reach the user — FIXED, and the mechanism was worse than described here.**

This entry originally said `api.js` "replaces the body's message with generic copy". That was wrong:
`payload.error` was already *preferred* at every throw site, and the generic copy was only a fallback.
The real defect was worse. The guards answer with a machine code in `error` and the sentence in
`message`:

```json
{ "error": "daily_cap_exceeded", "message": "Daily application cap reached: 2 of 3 used in the last 24h" }
```

So the user was shown **`daily_cap_exceeded`** verbatim — a raw code that reads like a crash, not a
generic-but-human fallback. Same for `full_auto_disabled` and `upgrade_required`.

Fixed globally in `client/src/lib/api.js` with one helper, `errorMessage(payload, fallback)`, used by
all four throw sites: `message` → `error` → generic. Older endpoints that put the sentence in `error`
and send no `message` are unaffected, and the generic copy still covers bodies carrying neither. The
`payload` remains attached, so `JobsPanel`'s `e.payload?.missingPrerequisites` path is untouched — no
change was needed in any caller. Covered by `test/apiErrorMessages.test.js`, whose absence guard was
confirmed to fail against the old precedence.

**`PLATFORM_LABEL_MAPS.ashby` has no `"Name"` entry** — only `"First Name"`/`"Last Name"`. Ashby's real
control is a single `_systemfield_name` labelled "Name", so once the provider is correctly detected
as `ashby`, `full_name` cannot resolve it and the completeness gate holds the run. This surfaced only
because the integration fixture presents a provider-shaped URL; every earlier run detected `generic`,
whose map *does* have `"Name"`. A resolution concern rather than a submit guard, and
`platformDetector` is shared, so it is reported rather than patched here. **A5 should expect this on a
real Ashby posting.**

**Reaching the local harness through the route needs a provider-shaped URL.** `processRunJob` gates
full-auto on `detectPlatformFromUrl`, and a bare `localhost` URL is `generic` → `provider_review_only`.
`detectPlatformFromUrl` substring-matches the whole URL, so the fixture carries the token in the query
(`/ashby?ats=ashbyhq.com`) while still hitting localhost. No production code is bent for it.

Still open from A2: the `label_exact` provenance tier (needs sign-off — it changes the fixed enum),
and trap 3's toggle half (the fixture has a checkbox but no `role="switch"`, and for a non-input
element the toggle branch sets `.checked`, which does nothing).

## Verification

`scripts/a3GuardsIntegration.mjs` — real chain, **all checks passed**:

```
duplicate POST, same Idempotency-Key -> replay returns original runId, one run row,
                                        EXACTLY ONE submission at the ATS (count=1)
audit                                -> submit_verified=1, evidence=confirmation_page,url_changed,
                                        resume_artifact_id=1 ats=80, screenshot recorded,
                                        6 answers with provenance
daily cap                            -> 429 daily_cap_exceeded, nothing queued, 0 submissions
kill switch                          -> full-auto 503, 0 submissions; semi 202 and recorded as semi
```

Run it with `node scripts/fakeAts.js` up, then
`A1_RESUME=/path/to/any.pdf node scripts/a3GuardsIntegration.mjs`.

`test/applyGuards.test.js` adds 10 in-suite tests over real HTTP against an in-memory DB (admission
control, replay, cap boundaries including the 24h window, concurrency, both kill-switch paths, and
the migration's shape/byte-identity).

## Regression review

| Surface | Verdict |
|---|---|
| `/api/jobs` | **Byte-compatible.** The `server.js` diff is +25 lines / −0, the migration block only, with **zero** `/api/jobs` references. |
| `POST /api/apply` (JobDetailPanel:156) | **Unaffected.** The client sends no `Idempotency-Key`; an empty key short-circuits both the lookup and the record, so behaviour is identical. |
| `POST /api/apply/runs` (JobsPanel:2071) | **Behaviour change, intended.** Can now return 503 (kill switch) or 429 (cap / concurrency). Success shape is unchanged plus an additive `dailyCap` object. See the flattening finding above. |
| `POST /api/apply/close/:jobId` (JobDetailPanel:177) | Untouched. |
| `GET /api/apply/runs`, `/runs/:runId`, `/readiness` (JobsPanel) | Untouched. |
| `/api/apply/session/*` | Untouched; confirmed placeholders with no callers. |
| `services/applyAutomation.js` | Importers `routes/apply.js`, 2 scripts, 5 test files. Result shape is additive (`submitVerified`, `submitEvidence`, conditional `reasonCode`). |

Three stale assertions were updated in the same pass — `out.status(...)` instead of `res.status(...)`
for the two wrapped handlers, the configurable `APPLY_WORKER_LIMIT`, and the N2 reversal above.

**Baseline: 611 pass / 0 fail before → 621 pass / 0 fail after (10 added). Introduced failures: 0.**
`node --check` clean on both modified services; server boots and binds.
