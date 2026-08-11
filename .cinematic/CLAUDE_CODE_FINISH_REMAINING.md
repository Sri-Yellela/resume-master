# Resume Master — Remaining Work: Audit + Final Execution Prompt

Generated after reading the live code state at HEAD `f9b7727`
("step apply-4"). This supersedes the pending portions of:
`.cinematic/CLAUDE_CODE_UI_AUTOAPPLY_EXTENSION.md`,
`.cinematic/CLAUDE_CODE_JOB_FILTERING_FLICKER.md`,
`.cinematic/CLAUDE_CODE_FIXES_AND_JOBS_SEGREGATION.md`.

---

## PART 1 — AUDIT OF PENDING CHANGES (what's done vs. what's left)

### ✅ Landed on `main` (verified in code)
- **Cinematic Sprint (steps 14–19)**: theme framework, inline login, emoji
  removal, poster relocate, portaled drawer, unified home. Committed.
- **3 live bug fixes**: inline-login success check, session auth leak
  (localStorage→sessionStorage), dashboard search-bar overlap. Committed.
- **Jobs segregation (jobs-1 … jobs-6)**: `jobTaxonomy.js` (+sales),
  `collarClassifier.js`, `classifyJob.js`, migration (collar/confidence/
  rejected_jobs), eject-at-ingest, backfill, and **board query switched to
  `job_role_map` retiring roleTitleSql/Taxonomy A**. Committed.
- **Logo + TopBar**: outer accent rect removed (StampLogo + TopBar);
  TopBar transparent at rest. Committed.
- **Auto-apply (apply-2 … apply-4)** — far more complete than the prompt
  assumed. Verified present in `routes/apply.js` + `services/applyAutomation.js`:
  - `apply_runs`/`apply_run_jobs`/`apply_job_logs` schema + worker pool
    (`APPLY_WORKER_LIMIT`), `POST /api/apply/runs` (202), `/runs`, `/runs/:id`,
    `/review`, `/close/:jobId`, dedupe, ATS gate (`ATS_AUTO_APPLY_THRESHOLD`),
    CASE C parallel generation, `apply_job_logs` events.
  - 7-arg `applyRoutes(app, db, requireAuth, buildAutofillPayload,
    generateResumeForApply, htmlToPdf, generateCoverLetterForApply)`.
  - Engine: `discoverFields` + `DISCOVER_FN_SRC`, `buildAnswers`,
    `applyTypeaheadAnswer`, `classifyFlowState` (login/captcha/expired/
    redirect/submit/next), handler-typed multi-file upload
    (`handleTypedFileUploads` routes resume vs cover-letter), cover-letter
    generation wired. FIELD_TYPES / HANDLER_BY_ATTR / PROFILE_KEY_TO_HANDLER.
- **Extension (ext-1, ext-1b)**: `source_key` normalization fix in
  save-jobs-bulk + import pipeline tests. Committed.
- **Docs**: auto-apply, linkedin-extension, jobs-segregation, jobo analysis.

### ❌ Still pending (the work this prompt finishes)

**A. Auto-apply tail (from the apply A-series):**
- **A5 — completeness gate**: `autoApply` full-mode currently clicks submit
  whenever a submit button exists; on no-submit it returns
  `filled_not_submitted` but there is **no required-field completeness check
  before submitting**. Need: before any full-auto submit, re-discover the page
  and if any `is_required` field is still empty → do NOT submit, return
  `held_review`/`incomplete_form`. Also map `filled_not_submitted` →
  held_review in the worker (today the worker treats unknown non-submitted as
  held_review generically, but `incomplete_form` reason is never produced).
- **A6 — production browser readiness UX**: `probeBrowserAvailability()` exists
  in `browserLauncher.js` and runs at boot, but the auto-apply UI is **not
  gated** on it, and there's no v1 provider scoping (greenhouse/lever/ashby →
  auto, others → review). No throttle/jitter beyond worker limit.
- **A7 — green the suite**: `test/applyPipeline.test.js` +
  `test/applyFieldDiscovery.test.js` must pass; add a completeness-gate test.
- **apply-1 schema commit was folded into apply-2** (no separate commit) — fine,
  schema exists; just confirm `routes/adminDb.js` exposes the 3 apply tables.

**B. Job-board flicker + Adzuna volume (CLAUDE_CODE_JOB_FILTERING_FLICKER.md —
NOT STARTED):**
- **W1 — flicker**: filtering is still client-side in `JobsPanel.jsx`
  (roleFilter/catFilter/srcFilter/yoe/age/workType memo) + optimistic cache
  replace → jobs render then vanish. Move authoritative filters to the
  `/api/jobs` query; client keeps only instant text + sort.
- **W3 — Adzuna volume**: `adzuna.js` `search()` still fetches a **single page**
  (`/{country}/search/${page}` with `page=1`), `pageSize` default 10. Add
  pagination loop (results_per_page=50, up to a cap) + raise live pageSize +
  verify `what` mapping.
- (W2 already effectively done by jobs-6 — board now joins `job_role_map`.
  Verify no client re-derivation remains.)

**C. LinkedIn extension hardening (ext B2–B4 — NOT STARTED):**
- **B2 — canonical domain + dev switch**: `background.js`, `popup.js`,
  `linkedin-content.js` hardcode `https://resumemaster.one` with a commented
  localhost line; README references `resumemaster.app`. Unify to one domain +
  one shared/ documented dev switch.
- **B3 — JSON-LD extraction fallback**: `linkedin-content.js` relies on
  CSS-class selectors only; add `<script type="application/ld+json">`
  JobPosting parsing as the first extractor.
- **B4 — logged-out popup UX + permission reconcile**: popup should probe auth
  and show a sign-in CTA instead of 401-on-save; reconcile README ↔ manifest
  `storage` permission.

**D. Encoding regression (NEW — found in audit):**
- `services/applyAutomation.js` has mojibake in comments: line 1
  `// SCRAPING � SCHEDULED FOR REMOVAL...` and several box-drawing rule
  comments contain replacement chars (`�` / broken `─` runs). Cosmetic but
  committed; fix to ASCII. (Same CP1252→UTF-8 class as the earlier JobCard fix.)

**E. STATE.md drift (NEW — found in audit):**
- `.cinematic/STATE.md` only documents through Step 19; nothing for jobs-*,
  apply-*, ext-*, logo/topbar. Append a catch-up section so the journal matches
  `git log`.

---

## PART 2 — EXECUTION PROMPT (paste into a fresh Claude Code session)

You are on `main` in `resume-master` at/after HEAD `f9b7727`. Finish the
remaining work below. Each step: implement → build/test → commit → **PAUSE**.
Steps are ordered so the riskiest engine change (A5) is verified before the
broad UI refactor (W1).

### Environment (Windows + Git Bash)
- `npm` not on PATH: prefix `PATH="/c/Program Files/nodejs:$PATH" <cmd>`.
- Build: `PATH="/c/Program Files/nodejs:$PATH" npm --prefix client run build 2>&1 | tail -15`.
- Tests: `PATH="/c/Program Files/nodejs:$PATH" npm test 2>&1 | tail -40`.
- `server.js` (319KB) + `client/src/panels/JobsPanel.jsx` (173KB) have very long
  lines — use `grep -n`, never read top-to-bottom.
- `.claude/settings.local.json` floats as M — NEVER stage it.
- Preserve all `/api/*` paths, response shapes, hooks, the HTTP-only cookie +
  X-RM-Auth-Context, and OAuth gating throughout.

### Anchor
```bash
cd /c/Users/duggi/WebstormProjects/resume-master
git branch --show-current   # main
git log --oneline -3         # top: f9b7727 step apply-4 …
git status --short           # expect clean (or only .claude/settings.local.json)
```

---

### Step 1 — Fix encoding regression in applyAutomation.js (quick, safe)
`grep -nP '[^\x00-\x7F]' services/applyAutomation.js` to find the mojibake.
Replace line-1 `// SCRAPING � SCHEDULED FOR REMOVAL AFTER MIGRATION` and every
broken box-drawing comment rule with clean ASCII (e.g. a run of `─` or plain
`//----`). Comments only — do NOT touch code. Build to confirm nothing breaks.
Commit: `fix: restore ASCII in applyAutomation.js comments (mojibake)`. PAUSE.

### Step 2 — A5: completeness gate before full-auto submit
In `services/applyAutomation.js` `autoApply`, before the full-auto submit loop:
re-run `discoverFields` across page+frames, collect `is_required` fields, and
build the same answer set to know which required fields are still empty
(empty = required field whose value is blank AND not a `file` already uploaded).
If any required field is unfilled, do NOT click submit — return
`{ status:'held_review', reasonCode:'incomplete_form', flowState:'form_ready',
fieldsFilled, missingRequired:[labels], ... }` and close the browser (full mode).
Keep `filled_not_submitted` only for the case where required fields are all
filled but no submit button matched; map that to `held_review` /
`reason_code:'no_submit_button'` in the worker.
In `routes/apply.js` `processRunJob`, extend the final-status mapping so
`incomplete_form` and `no_submit_button` are recorded as `held_review` with
those reason codes (today they collapse to a generic held_review).
Tests: add to `test/applyPipeline.test.js` (or a new `applyCompleteness` test) a
fixture form with an empty required field → assert `held_review` /
`incomplete_form`, and a fully-filled fixture → assert submit attempted.
Commit: `step apply-5: completeness gate (no submit on missing required fields)`. PAUSE.

### Step 3 — A6: production browser readiness + v1 provider scope
- Add `GET /api/apply/readiness` (requireAuth) returning
  `{ available: <probeBrowserAvailability()>, reason }`. Reuse the cached probe
  from `browserLauncher.js`.
- In the apply UI (the Run Auto Apply control in `JobsPanel.jsx` /
  `JobDetailPanel.jsx`): call readiness on mount; if unavailable, disable the
  full-auto action and show the reason, leaving review/semi available.
- v1 scope: in the worker, before a `full` run, detect provider via
  `detectPlatformFromUrl`; if NOT in {greenhouse, lever, ashby}, force
  `mode:'semi'` (review) with `reason_code:'provider_review_only'` rather than
  auto-submitting an unproven ATS. Keep auto for the three.
- Add a small per-job jitter delay (e.g. 1–3s random) in `processRun` before
  each job to avoid hammering a provider.
Commit: `step apply-6: prod browser readiness gate + v1 provider scope + jitter`. PAUSE.

### Step 4 — A7: green the apply suite
Run `PATH="/c/Program Files/nodejs:$PATH" npm test -- applyPipeline` and (if it
exists) `applyFieldDiscovery`. Fix failures introduced by Steps 2–3; ensure the
new completeness + readiness behavior is covered. Confirm
`routes/adminDb.js` exposes `apply_runs`/`apply_run_jobs`/`apply_job_logs`.
Commit: `step apply-7: apply pipeline tests green`. PAUSE.

### Step 5 — W0 (read-only): confirm board filtering + Adzuna paths, report, STOP
```bash
grep -n "roleTitleSql\|job_role_map\|getRoleKeyForProfile" server.js | head -40
grep -n "\"/api/jobs\"\|'/api/jobs'\|/api/jobs/poll\|/api/jobs/facets\|/api/scrape" server.js | head
grep -n "roleFilter\|catFilter\|srcFilter\|minYoe\|maxYoe\|ageFilter\|visibleJobs\|filteredJobs\|useMemo\|profileCacheRef" client/src/panels/JobsPanel.jsx | head -60
grep -n "page = 1\|results_per_page\|searchJobs(" services/jobs/sources/adzuna.js services/jobs/aggregator.js | head
```
Report: (a) confirm `/api/jobs` now joins `job_role_map` (jobs-6) and whether any
client-side role/relevance filtering remains in `JobsPanel`; (b) which filters
are client-side vs server query params; (c) Adzuna page count. **STOP for user
confirmation before Step 6.**

### Step 6 — W1: move board filters server-side (kill the flicker)
Extend `/api/jobs` to accept the filters currently applied client-side
(`location, workType, employmentType, minYoe, maxYoe, ageDays, source,
boardTab, page, pageSize`) and apply them in SQL; return
`{ jobs, total, page, pageSize }`. Strip the post-fetch filtering memo in
`JobsPanel.jsx` so it no longer drops rows by role/cat/src/yoe/age/workType —
those arrive pre-filtered; keep only instant `localSearch` substring + sort.
Filter controls now set query params + refetch (debounced). Eliminate the
optimistic-then-smaller-replace: render fetched list atomically (subtle loading
state), keep the profile cache for filter *settings* only, not stale rows.
Preserve every field `JobCard`/`normalizeApiJob` consume.
Commit: `fix: server-side job filtering (eliminate board flicker)`. PAUSE.

### Step 7 — W3: Adzuna pagination + live volume
In `services/jobs/sources/adzuna.js` `search()`, add a `pages`/`maxResults`
option; loop `/{country}/search/{n}` with `results_per_page=50`, concatenating
until `maxResults` (≈150–200) or results run out, with a small delay between
pages; dedupe by URL; `total` from Adzuna `count`. Raise the live `searchJobs`
pageSize in `aggregator.js` for the interactive path. Verify `what` maps the
typed query/profile terms; optionally `what_or` across SWE title variants.
Confirm classification still gates results (`collar==='white' && roleKey`).
Commit: `feat: paginate Adzuna + raise live search volume`. PAUSE.

### Step 8 — B2: extension canonical domain + dev switch
The canonical production domain is **`https://resumemaster.one`** (decided).
Make `extension/manifest.json`, `background.js`, `popup.js`,
`linkedin-content.js`, and `README.md` all agree on `resumemaster.one` —
replace every `resumemaster.app` reference in the README (and anywhere else)
with `resumemaster.one`. Introduce a single `extension/config.js` (or a shared
top-of-file constant block) exporting
`RESUME_MASTER_URL = 'https://resumemaster.one'` with a clearly commented dev
switch (the existing `// const RESUME_MASTER_URL = 'http://localhost:3000';`
line), and import/refer to it everywhere the constant is currently duplicated
(background.js, popup.js, linkedin-content.js) so there is ONE source of truth.
Also confirm `manifest.json` `privacy_policy_url` and any hardcoded URLs point
at `resumemaster.one`.
Commit: `step ext-2: canonical domain (resumemaster.one) + dev switch`. PAUSE.

### Step 9 — B3: JSON-LD extraction fallback
In `linkedin-content.js`, add a JSON-LD extractor that reads
`<script type="application/ld+json">` and pulls `JobPosting.description`
(+ title/company where present) as the FIRST strategy, falling back to the
existing per-site CSS selectors. Same for saved-jobs cards where JSON-LD exists.
Commit: `step ext-3: JSON-LD JobPosting extraction fallback`. PAUSE.

### Step 10 — B4: logged-out popup UX + permission reconcile
Popup probes auth on open (`GET /api/auth/me` with `credentials:'include'`, or a
light `/api/extension/ping`); if unauthenticated, render a "Sign in to Resume
Master" CTA (opens `${RESUME_MASTER_URL}/login`) instead of letting save actions
fail with a 401 toast. Reconcile README ↔ manifest on the `storage` permission
(add it if used, else drop the README claim).
Commit: `step ext-4: logged-out popup UX + permission reconcile`. PAUSE.

### Step 11 — STATE.md catch-up
Append a concise section to `.cinematic/STATE.md` documenting everything since
Step 19 (jobs-1…6, logo/topbar, apply-2…7, ext-1…4, flicker W1/W3, encoding
fix) with the commit SHAs from `git log`, so the journal matches history.
Commit: `state: catch up STATE.md through apply/ext/flicker work`. PAUSE.

---

### Per-step rules
After each commit print `Step <id> complete. SHA / build / tests / ready`.
**PAUSE** after each. A read-only step (Step 5/W0) never edits — report and stop.

### Failure handling
- Build/test fails → read error; fix forward unless the approach is wrong, then
  `git restore` the step's files and resurface.
- Any change to an `/api/*` path or response shape → STOP and surface.
- Compaction mid-step → re-read this file + the relevant `docs/*.md` + the
  current step, resume from that step's anchor.

Begin with Step 1.
