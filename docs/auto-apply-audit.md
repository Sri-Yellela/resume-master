# Auto-Apply Pipeline — Audit & Implementation Plan

**Status:** Audit (current state + next steps). Not yet executed.
**Scope:** The autonomous "apply to jobs for the user" pipeline — server-side
browser automation, the apply queue, resume generation gating, and the UI that
drives it.

---

## 1. Executive summary

The auto-apply system is **built as an engine but disconnected at the wiring**.

**What it is:** an in-site feature (NOT the Chrome extension) where the user
queues jobs into an apply-run list and "Run Auto Apply" autonomously completes
each application end-to-end with no intervention — text fields, resume upload,
and cover-letter upload. Form answers are sourced from the user's stored
`user_profile` row (contact, address, links, EEO, work-auth) via
`buildAutofillPayload`, which is already wired to `GET /api/autofill`. Two
built-engine gaps for true "everything inclusive": (1) **cover letter is never
generated or uploaded** — the engine uploads only the resume, to the first file
input; (2) **single-file upload only** — forms with separate resume + cover
inputs aren't handled. Both are addressed in the execution plan (A3).

- The **automation engine is complete and production-aware**: a Puppeteer
  form-filler (`services/applyAutomation.js`), an environment-aware browser
  launcher with readiness probing and structured error codes
  (`services/browserLauncher.js`), ATS platform detection for 12 platforms
  (`services/platformDetector.js`), and the autofill data model
  (`services/simpleApplyProfile.js`).
- The **route layer is reverted to manual-only**. `routes/apply.js` carries the
  comment "LinkedIn automation removed 2026-05-08 / Auto-apply … is a future
  feature" and stubs every queue endpoint (`/api/apply/runs`, `/review`,
  `/close`, `/session`) with `410 Gone`. Its function signature is the 3-arg
  `applyRoutes(app, db, requireAuth)`.
- The **test suite (`test/applyPipeline.test.js`) describes the full intended
  pipeline** that the route layer no longer implements — async runs returning
  `202`, an `apply_runs` / `apply_run_jobs` / `apply_job_logs` schema, a
  worker pool (`APPLY_WORKER_LIMIT = 2`), an ATS gate
  (`ATS_AUTO_APPLY_THRESHOLD = 65`), parallel resume generation (CASE B/C),
  and a 6-arg `applyRoutes(app, db, requireAuth, buildAutofillPayload,
  generateResumeForApply, htmlToPdf)`. **These tests are currently failing**
  against the reverted route file.

So the work to finish is mostly **re-wiring the engine to the queue and the
UI**, plus the production-hardening that any autonomous form-submitter needs.
This is much smaller than a from-scratch build — the hard parts (browser
lifecycle, fill heuristics, platform maps, ATS gating, resume generation reuse)
already exist.

---

## 2. Component-by-component state

### Built and solid (the engine)

**`services/applyAutomation.js`** — `autoApply(jobUrl, autofillData, options)`.
- Modes: `full` (headless, auto-submits) and `semi` (visible, user reviews).
- Injects a fill function into the page + every iframe; fills by name/id/
  autocomplete, placeholder/aria-label heuristics, ATS label maps, dropdowns,
  and sponsorship/clearance radios.
- Handles resume file upload, multi-step pagination (up to 8 "Next" clicks),
  screenshots, and an in-memory `inProgress` status map.
- **ATS gate:** accepts a `resumePathPromise`; in full-auto, if it resolves to
  null (generation failed / below threshold), returns `ats_held` instead of
  submitting. Enables parallel site-visit + generation.
- `getApplyStatus()` / `closeSemiBrowser()` for the semi flow.

**`services/browserLauncher.js`** — production-aware.
- Resolves the binary across env override → Linux system paths →
  `@sparticuz/chromium` bundle → Windows Chrome.
- Container-safe launch args; manual vs auto arg profiles.
- `classifyLaunchError()` → `browser_binary_not_found` /
  `browser_runtime_missing_dependency` / `browser_timeout` /
  `browser_launch_failed`.
- `probeBrowserAvailability()` cached readiness probe (run at server boot per
  the `app.listen` callback).

**`services/platformDetector.js`** — URL + page detection for greenhouse,
lever, workday, icims, linkedin, taleo, ashby, jobvite, smartrecruiters,
workable, bamboohr, + generic; per-platform label→field maps; `usesIframe()`.

**`services/simpleApplyProfile.js`** — derives the autofill signal profile
(titles, skills, keywords, years-of-experience, structured facts like work
auth / sponsorship / clearance) from the user's resume, profile-scoped with
legacy seeding. This is the data the fill function consumes.

### Reverted / stubbed (the wiring)

**`routes/apply.js`** — manual tracking only:
- `POST /api/apply` (record a manual application), `GET /api/apply/status/:jobId`,
  `GET /api/apply/applications` — these work.
- `POST /api/apply/runs`, `GET /api/apply/runs/:runId`, `GET /api/apply/review`,
  `POST /api/apply/close/:jobId`, `POST /api/apply/session/save` → all return
  `410` via the `automationRemoved` handler.
- 3-arg signature; does not receive `buildAutofillPayload`,
  `generateResumeForApply`, or `htmlToPdf`.

### Unverified (must check first — see Step 0)

**`server.js`** (319KB monolith) — the tests assert it contains the
orchestration helpers (`coreGenerateResume`, `generateResumeForApply`,
`pendingGenerationPromises`, the `apply_runs`/`apply_run_jobs`/`apply_job_logs`
DDL, and the 6-arg `applyRoutes(...)` call). Whether those survived the
2026-05-08 revert or were stripped alongside the route layer **determines the
size of the remaining work** and is the first thing to confirm.

### Legacy (to retire)

**`extension/`** — the old Chrome extension (`background.js`,
`linkedin-content.js`, `popup.js`, `saved-jobs-content.js`). The fill logic was
ported into `applyAutomation.js`; the extension is superseded. Decide: keep as
an optional user-side filler, or remove to avoid confusion.

### UI entry points

Per the tests, `client/src/panels/JobsPanel.jsx` has `applyQueue` state, "Run
Auto Apply" and "Autofill for Review" actions, and posts to `/api/apply/runs`;
`client/src/components/JobDetailPanel.jsx` has "Queue Auto" and a single
"Apply" (semi) action. So the **front end already has the controls** — they're
calling endpoints that currently 410.

---

## 3. The gap, precisely

```
[ JobsPanel / JobDetailPanel ]   UI: Queue Auto, Run Auto Apply  ✅ present
            │  POST /api/apply/runs
            ▼
[ routes/apply.js ]              ❌ returns 410 (manual-only stub)
            │  (intended)
            ▼
[ apply_runs queue + worker ]    ❓ DDL + worker may exist in server.js (verify)
            │
            ├── generateResumeForApply ──► coreGenerateResume  ❓ verify in server.js
            │        │ ATS gate (≥65)
            │        ▼ htmlToPdf → temp PDF
            ▼
[ services/applyAutomation.autoApply ]   ✅ complete engine
            │  launchBrowser → fill → upload → (submit | hold)
            ▼
[ apply_run_jobs / apply_job_logs ]      ❓ verify in server.js
```

The only certainly-broken link is `routes/apply.js`. Everything below it (the
engine) is built; everything above it (the UI) is built. The orchestration in
the middle (queue worker, generation reuse, ATS gate, PDF conversion) is what
Step 0 verifies.

---

## 4. Production risks (must be designed for, not discovered)

Autonomous form submission against third-party ATS sites carries risks the
current engine only partially addresses:

1. **Browser in production.** The launcher handles missing-binary and
   missing-libs, but a headless Chromium submitting forms needs a real browser
   in the deploy environment (Render/Fly/containers): install Chromium + libs
   or set `PUPPETEER_EXECUTABLE_PATH`. The boot probe already reports
   readiness — surface it to the user before offering auto-apply.
2. **Anti-bot / CAPTCHA.** Greenhouse/Lever are tolerant; Workday/iCIMS/Taleo
   use heavy JS, multi-page flows, and sometimes bot detection. The fill
   heuristics will silently under-fill these. Need per-platform success
   detection and a "couldn't complete → hand to user" path (the `semi`/review
   flow is the right escape hatch).
3. **Wrong-submit risk.** Full-auto submission of an incompletely-filled form
   is the worst failure (a bad application sent under the user's name). The ATS
   gate guards resume quality but not form completeness. Need a
   **completeness check** (required fields filled, resume attached) before any
   auto-submit, else divert to review.
4. **Account/session requirements.** Many ATS require a logged-in account or
   email verification mid-flow. `storageStatePath` exists for cookie reuse but
   there's no acquisition flow. Scope v1 to no-login direct-apply platforms
   (greenhouse/lever/ashby) and route the rest to review.
5. **ToS / rate.** Automated submission may violate some sites' terms; throttle
   (the worker limit of 2 helps), randomize timing, and keep an audit log
   (`apply_job_logs`) per submission for accountability.
6. **Idempotency / duplicates.** A run must not double-apply to the same job;
   the test references a `duplicateSet` — ensure dedupe by (user, job) before
   enqueue and before submit.

---

## 5. Suggested next steps (phased)

### Step 0 — Verify the orchestration substrate (1 session, no behavior change)
Confirm in `server.js` whether these exist: `coreGenerateResume`,
`generateResumeForApply`, `pendingGenerationPromises`, the
`apply_runs`/`apply_run_jobs`/`apply_job_logs` table DDL, `buildAutofillPayload`,
`htmlToPdf`, and the call `applyRoutes(app, db, requireAuth, buildAutofillPayload,
generateResumeForApply, htmlToPdf)`. Run `npm test -- applyPipeline` to see
which assertions pass.
- **If present:** the engine + orchestration survived; only `routes/apply.js`
  regressed → Steps 1–2 restore it. Small job.
- **If absent:** the orchestration was stripped → Steps 1–4 rebuild it from the
  engine up. Larger, but the engine still saves the hard part.

### Step 1 — Restore the apply-queue schema + helpers (if missing)
`apply_runs` (id, user_id, mode, status, created_at, …),
`apply_run_jobs` (run_id, job_id, status, reason_code, ats_score, …),
`apply_job_logs` (run_job_id, ts, status, message). Idempotent DDL at boot,
mirroring the other tables. Expose in `routes/adminDb.js` for inspection.

### Step 2 — Rebuild `routes/apply.js` as the async queue
- 6-arg signature; `POST /api/apply/runs` enqueues and returns `202` with a
  `runId`; a worker pool (limit 2) processes jobs off the queue.
- Per job: dedupe → resolve/generate resume (`generateResumeForApply`, reusing
  cached artifact or attaching to in-flight generation) → ATS gate (≥65, else
  `held_review`) → `htmlToPdf` to a temp file → `autoApply(url, payload,
  { mode, resumePathPromise, resumePath })` → record result + logs → cleanup
  temp PDF.
- `mode: 'semi'` for manual/review; `mode: 'full'` only when completeness +
  ATS gates pass.
- `GET /api/apply/runs`, `/runs/:runId`, `/review` for status + the review
  queue.

### Step 3 — Completeness gate + review hand-off
Before any full-auto submit, verify required fields are filled and the resume
is attached; on failure, leave the browser in `semi`/review state and surface
it in `/api/apply/review` rather than submitting. Add per-platform success
detection (post-submit confirmation heuristics).

### Step 4 — Production browser + readiness UX
Ensure the deploy target has Chromium (Dockerfile/buildpack or
`PUPPETEER_EXECUTABLE_PATH`). Gate the auto-apply UI on
`probeBrowserAvailability()` — if unavailable, hide full-auto and offer
review-only with a clear reason.

### Step 5 — Scope, throttle, retire the extension
- v1 platforms: greenhouse, lever, ashby (no-login direct apply). Everything
  else → review queue.
- Throttle + jitter submissions; audit every submit in `apply_job_logs`.
- Decide the `extension/` fate (keep as optional client-side filler or remove).

### Step 6 — Make the test suite green
`test/applyPipeline.test.js` is the spec. Drive Steps 1–3 until it passes; add
a completeness-gate test and a per-platform fill fixture.

---

## 6. Bottom line

This is not a greenfield build — it's a **reconnection plus hardening**. The
risky, high-effort pieces (browser lifecycle, multi-strategy form fill, 12
platform maps, ATS-gated parallel generation, structured error handling) are
already implemented in the service layer. The remaining work is: confirm what
orchestration survived the revert (Step 0), rebuild the queue route that was
stripped (Steps 1–2), add the completeness/review safety gates that autonomous
submission demands (Step 3), and make sure a real browser exists in production
(Step 4). Start at Step 0 — it determines whether this is a 2-session restore
or a 5-session rebuild.
