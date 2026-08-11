# Resume Master — UI commit + Auto-Apply + LinkedIn-Extension execution

You are on `main` in `resume-master`. Three streams of work, in order:

- **Phase 0** — UI fixes already applied to the working tree (uncommitted):
  logo outer-rectangle removal + 100%-translucent top bar. Verify + commit.
- **Phase A** — Auto-apply: the IN-SITE feature (not the browser extension)
  where a user queues jobs into an apply-run list and "Run Auto Apply"
  autonomously completes each application end-to-end — text fields, resume
  upload, AND cover-letter upload — with zero user intervention. Every answer
  is sourced from the user's stored profile (`user_profile` table) via
  `buildAutofillPayload`. Verify what survived the revert, then reconnect the
  queue and fill the cover-letter gap. Spec: `docs/auto-apply-audit.md`.
- **Phase B** — LinkedIn extension import pipeline: verify the write endpoints
  and fix the `source_key` bug. Spec: `docs/linkedin-extension-audit.md`.

Phase 0 runs straight through. Phases A and B each start with a **read-only
verification step** whose result determines the work — STOP after each
verification and report before implementing, then PAUSE after every commit.

---

## Anchor first

```bash
cd /c/Users/duggi/WebstormProjects/resume-master
git branch --show-current        # expect: main
git status --short               # expect modified (uncommitted):
                                 #   client/src/components/StampLogo.jsx
                                 #   client/src/components/TopBar.jsx
                                 #   (and untracked: docs/auto-apply-audit.md,
                                 #    docs/linkedin-extension-audit.md,
                                 #    docs/jobs-segregation-architecture.md if not yet committed)
                                 #   (never stage .claude/settings.local.json)
ls docs/auto-apply-audit.md docs/linkedin-extension-audit.md   # specs — READ BOTH before their phases
```

If `StampLogo.jsx` and `TopBar.jsx` are NOT modified, Phase 0's edits were lost
— STOP and tell the user. Otherwise proceed.

## Environment (Windows + Git Bash)

- `npm` not on default PATH. Prefix every npm/node command:
  `PATH="/c/Program Files/nodejs:$PATH" <cmd>`
- Repo root: `/c/Users/duggi/WebstormProjects/resume-master`
- Build: `PATH="/c/Program Files/nodejs:$PATH" npm --prefix client run build 2>&1 | tail -15`
- Tests: `PATH="/c/Program Files/nodejs:$PATH" npm test 2>&1 | tail -40`
- `server.js` is a 319KB monolith with very long embedded lines — use
  `grep -n` to locate things; do NOT try to read it top-to-bottom.
- `.claude/settings.local.json` floats as M — NEVER stage it.

---

# Phase 0 — Verify + commit the UI fixes

Two fixes already on disk:

**Fix A — logo outer rectangle removed (throughout the site).**
`client/src/components/StampLogo.jsx` and the `AnimatedLucyLogo` in
`client/src/components/TopBar.jsx` each had an absolutely-positioned accent
rectangle (`background: var(--color-primary)` / `theme.accent`, `rotate(-3deg)`)
behind the white stamp. Both removed; the inner white stamp remains.
(`AuthScreen.jsx`'s `AtomEmblem` is a different mark — intentionally untouched.)

**Fix B — top bar 100% translucent at rest.**
`TopBar.jsx` Pill 1 background/border/blur now collapse to
transparent / transparent / 0 when scroll progress `p < 0.02`. The glass
treatment only forms as the bar converges to the centered pill on scroll. At the
top of the page the logo + utility icons float over the cinematic background
with nothing behind them.

## Verify

```bash
PATH="/c/Program Files/nodejs:$PATH" npm --prefix client run build 2>&1 | tail -15
```

Expect exit 0, no new warnings. Dev smoke
(`npm --prefix client run dev`): logo shows only the white stamp (no colored
rectangle) in the top bar and on the marketing nav; at the top of the dashboard
the top bar is invisible (only logo + icons), and a faint glass pill forms as
you scroll.

## Commit

```bash
git add client/src/components/StampLogo.jsx client/src/components/TopBar.jsx
git commit -m "fix: remove logo outer accent rect + make top bar translucent

StampLogo and TopBar's AnimatedLucyLogo dropped the absolutely-positioned accent
rectangle behind the white stamp (kept the inner stamp) — applied site-wide.
TopBar Pill 1 background/border/blur now collapse to fully transparent at rest
(p<0.02) and only form the glass pill on scroll, so the bar reads as 'nothing is
there' at the top of the page. AuthScreen AtomEmblem intentionally untouched."

# Commit the audit docs too (untracked), if not already committed:
git add docs/auto-apply-audit.md docs/linkedin-extension-audit.md docs/jobs-segregation-architecture.md 2>/dev/null
git commit -m "docs: auto-apply, linkedin-extension, jobs-segregation audits" || true

git log --oneline -5
```

Print the SHA(s), then **PAUSE** for review before Phase A.

---

# Phase A — Auto-apply pipeline (spec: docs/auto-apply-audit.md)

**What this feature is (do not confuse with the Chrome extension in Phase B).**
Auto-apply is a server-side feature inside the app: the user queues jobs into an
apply-run list and triggers "Run Auto Apply"; the server then, for each job and
with NO user intervention, opens the application, fills every text field,
uploads the resume, and uploads a cover letter, then submits (full mode) or
leaves it for review (semi mode). The data that answers the form lives in the
user's profile:

- `user_profile` table (confirmed columns): `full_name, email, phone,
  linkedin_url, github_url, location, address_line1, address_line2, city, state,
  zip, country, gender, ethnicity, veteran_status, disability_status,
  requires_sponsorship, has_clearance, clearance_level, visa_type, work_auth`.
- `buildAutofillPayload(profile, applyMode)` (in server.js) converts that row
  into the `{ field_map, dropdown_map }` the `autoApply` engine consumes; it is
  already exposed at `GET /api/autofill`. The apply worker MUST reuse this same
  builder so the queued run fills from the profile exactly like the manual path.
- Resume + cover letter are generated per-job (tailored to the JD) and uploaded
  as files; everything else is filled from the profile payload.

The engine (`services/applyAutomation.js`) already fills text fields, dropdowns,
and sponsorship/clearance radios from `field_map`/`dropdown_map`, and uploads a
resume — but it does NOT generate or upload a cover letter, and it only targets
the first file input. Closing those gaps is A4.

**Architecture target (from `docs/jobo-auto-apply-analysis.md` — READ IT before
A3).** The current engine fills *blind*: it injects a function and guesses each
control from name/id/placeholder/aria-label heuristics. That silently
under-fills modern ATS widgets (typeahead/combobox, multi-select, rich-text,
toggles) and can wrong-submit. We are moving the engine to a
**discover → answer → validate → advance** loop modeled on Jobo's session API:

1. **Discover** the current page's fields as structured descriptors
   `FormFieldInfo { field_id, type, label, is_required, options[], handler_type }`
   where `type` is from a fixed taxonomy and `handler_type` is a semantic tag
   (`first-name`, `email`, `resume`, `cover-letter`, …) resolved per provider.
2. **Answer** by mapping each descriptor to a value from the profile payload
   (match on `handler_type` first, then `label`, then `custom_answers`), producing
   typed `FieldAnswer { field_id, type, value, typeahead_selection?, clear_first }`.
3. **Validate**: after applying, re-read required fields / on-page errors; if any
   required field is still empty or the page reports an error, do NOT advance —
   divert to review (this is the real completeness gate, A5).
4. **Advance** through multi-page flows; classify the outcome with an explicit
   **flow-state** enum (`form_ready, next_available, submit_ready, submitted,
   login_required, captcha_required, expired, redirected, redirect_required,
   error`) — the terminal human-intervention states route to the review queue
   instead of being treated as generic failures.

This is A3 (the engine rewrite). A4 then layers cover-letter generation +
handler-typed file routing on top; A5 makes validation/flow-states the gate.

## A0 — Verify what survived the 2026-05-08 revert (READ-ONLY — report, then stop)

```bash
grep -n "function coreGenerateResume\|function generateResumeForApply\|pendingGenerationPromises" server.js
grep -n "CREATE TABLE IF NOT EXISTS apply_runs\|apply_run_jobs\|apply_job_logs" server.js
grep -n "applyRoutes(app, db, requireAuth" server.js
grep -n "buildAutofillPayload\|htmlToPdf" server.js | head
grep -n "function applyRoutes" routes/apply.js
# Profile-as-autofill-source + cover-letter substrate:
grep -n "function buildAutofillPayload" server.js
grep -n "first_name\|last_name\|field_map\|dropdown_map" server.js | head
grep -n "CREATE TABLE IF NOT EXISTS user_profile\|cover_letter\|generateCoverLetter\|coverLetter" server.js | head
# Engine shape (for the A3 discover→answer rewrite):
grep -n "FILL_FN_SRC\|handleResumeUpload\|field_map\|dropdown_map\|HINT_MAP\|typeahead\|getPlatformLabelMap" services/jobs/applyAutomation.js services/applyAutomation.js 2>/dev/null | head -30
grep -n "custom_answers\|highest_degree\|desired_salary\|willing_to_relocate\|current_job_title" server.js | head
PATH="/c/Program Files/nodejs:$PATH" npm test -- applyPipeline 2>&1 | tail -40
```

Interpret and **report to the user before writing any code**:
- **If** `coreGenerateResume`, `generateResumeForApply`, the `apply_runs` DDL,
  and a 6-arg `applyRoutes(app, db, requireAuth, buildAutofillPayload,
  generateResumeForApply, htmlToPdf)` call all exist in `server.js` → the
  orchestration survived; only `routes/apply.js` regressed. **Path = RESTORE**
  (A1–A2 below, ~2 sessions).
- **Else** → orchestration was stripped. **Path = REBUILD** (A1–A4, larger).
  The engine (`applyAutomation.js`, `browserLauncher.js`, `platformDetector.js`,
  `simpleApplyProfile.js`) is intact either way.

State which path the evidence indicates and which `applyPipeline` assertions
pass/fail. Also report: (a) does `buildAutofillPayload` split `full_name` into
`first_name`/`last_name` (the engine's HINT_MAP expects both) and emit EEO +
dropdown entries; (b) is there ANY cover-letter generation helper, or is cover
letter entirely absent (expected: absent); (c) does `user_profile` already have
any of `custom_answers`, education (`highest_degree`/`field_of_study`/
`university`/`graduation_year`), `desired_salary`, `willing_to_relocate`,
`available_start_date`, `current_job_title`/`current_company` (expected: none —
A3 adds them); (d) confirm the engine still fills blind via `FILL_FN_SRC` with no
field-discovery / `handler_type` / `typeahead` concept (expected: yes). **STOP
for user confirmation of the path before A1.**

## A1 — Apply-queue schema + helpers (only if missing)
Idempotent boot DDL mirroring the other tables:
`apply_runs(id, user_id, mode, status, created_at, …)`,
`apply_run_jobs(id, run_id, job_id, status, reason_code, ats_score, …)`,
`apply_job_logs(id, run_job_id, ts, status, message)`, plus
`idx_apply_runs_user_status`. Expose all three in `routes/adminDb.js`.
If `coreGenerateResume`/`generateResumeForApply`/`pendingGenerationPromises` are
absent, extract `coreGenerateResume` from the `/api/generate` handler and add
`generateResumeForApply` (cache hit → resolved promise with `fromCache: true`;
attach to in-flight HTTP generation via `generationInFlight`; worker in-flight
via `pendingGenerationPromises`; handle `generation_timed_out`).
Commit: `step apply-1: apply-queue schema + generation helpers`. PAUSE.

## A2 — Rebuild routes/apply.js as the async queue
6-arg signature `applyRoutes(app, db, requireAuth, buildAutofillPayload,
generateResumeForApply, htmlToPdf)`. `POST /api/apply/runs` enqueues, returns
`202` + `runId`; worker pool `APPLY_WORKER_LIMIT = 2`. Per job: dedupe (the
`duplicates`/`duplicateSet` pattern the tests expect) → resolve/generate resume
→ ATS gate `ATS_AUTO_APPLY_THRESHOLD = 65` (below → `status='held_review'`,
`reason_code` `ats_below_threshold`) → `htmlToPdf` to `os.tmpdir()` temp file →
build the profile autofill payload with `buildAutofillPayload(userProfileRow,
applyMode)` (same builder as `/api/autofill`; load the row via
`INSERT OR IGNORE INTO user_profile … ; SELECT * FROM user_profile`) →
`autoApply(url, payload, { mode, resumePathPromise, resumePath, coverLetterPath })`
→ record result + `apply_job_logs` (`generation_started`/`site_visit_started`/
`generation_ready`/`submitted`/…) → `unlinkSync` the temp PDFs (resume + cover).
The payload that fills text fields/dropdowns/radios comes ENTIRELY from the
user profile via `buildAutofillPayload` — the worker never invents answers.
CASE B (no artifact + manual) = parallel generation + `mode:"semi"` via
`Promise.allSettled`, no `resume_required` early-fail. CASE C (no artifact +
auto) = browser launches in parallel with generation, ATS gate embedded in the
`resumePathPromise` chain. `GET /api/apply/runs`, `/runs/:runId`, `/review`.
Update the `applyRoutes(...)` call in server.js to the 6-arg form.
Commit: `step apply-2: async apply queue route reconnected`. PAUSE.

## A3 — Field-discovery engine + profile extension (the Jobo model)
Read `docs/jobo-auto-apply-analysis.md` first. This replaces blind fill with a
structured discover→answer loop and extends the profile to answer real forms.

1. **Field-type taxonomy + descriptors.** In `services/applyAutomation.js`,
   define the field-type set (`text, text_area, select, multi_select, radio,
   checkbox, file, date, number, typeahead, toggle, rich_text, hidden, password,
   static, complex, unknown`) and a `discoverFields(pageOrFrame, provider)` that
   walks the DOM and returns `FormFieldInfo[] { field_id (stable selector/uuid),
   type, label, is_required, options:[{value,text}], handler_type }`. Derive
   `handler_type` from `platformDetector` label maps + name/id/autocomplete
   (`first-name, last-name, full-name, email, phone, linkedin, website,
   portfolio, resume, cover-letter, address1, address2, city, state, zip,
   country, sponsorship, work-auth, gender, ethnicity, veteran, disability,
   salary, start-date, relocate, degree, school, grad-year, years-experience,
   current-title, current-company`). Unknowns get `handler_type: null`.
2. **Answer mapping.** Add `buildAnswers(fields, profilePayload)` that maps each
   descriptor to a typed `FieldAnswer { field_id, type, value,
   typeahead_selection?, clear_first:true }` by: (1) `handler_type` match, then
   (2) fuzzy `label` match, then (3) `custom_answers[label]`. Type-aware value
   formatting: `select/radio` → option `value`; `multi_select`/checkbox-group →
   comma-joined values; `checkbox`/`toggle` → `"true"/"false"`; `date` →
   `YYYY-MM-DD`; `file` → local path; `rich_text` → text/HTML; `static` → skip.
3. **Typeahead/combobox handling.** For `typeahead`, type `value` to trigger the
   dropdown, wait, then click the option matching `typeahead_selection` (or the
   closest option). This is the class of field (Workday/Ashby location & school
   pickers) the blind setter silently fails today.
4. **Apply + the discover→answer→advance loop.** Replace the one-shot
   `fillAllFrames`/`FILL_FN_SRC` flow with: discover → build answers → apply
   per-field with the type-aware handlers (across frames) → re-discover to
   confirm → advance (`clickNext`) → repeat. Keep `FILL_FN_SRC` only as the
   low-level setter for simple inputs invoked by the per-field handlers.
5. **Flow-state classification.** Add `classifyFlowState(page)` returning one of
   `form_ready, next_available, submit_ready, submitted, login_required,
   captcha_required, expired, redirected, redirect_required, error`. Detect
   login walls, CAPTCHA iframes/widgets, expired-posting text, and cross-domain
   redirects. `autoApply` returns the terminal flow-state as its `status` and a
   matching `reasonCode`.
6. **Profile extension (server.js + migration).** Add to `user_profile`:
   `website_url, portfolio_url, desired_salary, salary_currency,
   available_start_date, willing_to_relocate, highest_degree, field_of_study,
   university, graduation_year, current_job_title, current_company`, and a
   `custom_answers` store (JSON text column on `user_profile`, or a
   `user_profile_custom_answers(user_id, question, answer)` side table). Idempotent
   boot DDL. Update `POST /api/profile` to accept/persist them and the Profile UI
   (`ProfilePanel.jsx`) to edit them, including a key/value editor for
   `custom_answers`. Extend `buildAutofillPayload` to emit `handler_type`-keyed
   values for all new fields (and split `full_name` → first/last if A0 showed it
   doesn't), so `buildAnswers` can resolve them. Keep existing keys intact.
Tests: `test/applyFieldDiscovery.test.js` — given a fixture HTML form, assert
`discoverFields` returns correct types + `handler_type`s, `buildAnswers` fills
from a full profile (incl. a `custom_answers` question and a `typeahead`), and
`classifyFlowState` detects `login_required`/`captcha_required` fixtures.
Commit: `step apply-3: field-discovery engine + profile extension (custom_answers, education, availability)`. PAUSE.

## A4 — Cover-letter generation + handler-typed file upload
This closes the "everything inclusive" gap so a run needs zero intervention.

1. **Cover-letter generation (worker side).** Add `generateCoverLetterForApply`
   mirroring `generateResumeForApply`: generate a JD-tailored cover letter for
   the job, `htmlToPdf` it to an `os.tmpdir()` temp file, return the path (or
   null on failure). Run it in parallel with the resume generation. Pass the
   result to `autoApply` as `coverLetterPath` (and a `coverLetterPathPromise`
   for the parallel case). Cover-letter failure is non-fatal: proceed with the
   resume; log `cover_letter_unavailable`.
2. **Handler-typed file routing (engine side).** Now that A3 produces
   `FormFieldInfo` with `handler_type`, replace the single `handleResumeUpload`
   (first `input[type=file]`) with routing by descriptor: upload `resumePath` to
   the field whose `handler_type === 'resume'` (or a lone generic file input),
   and `coverLetterPath` to `handler_type === 'cover-letter'`. Re-run after each
   `clickNext` page. Keep the DataTransfer/change-event dispatch.
3. **`autoApply` signature.** Accept `coverLetterPath` +
   `coverLetterPathPromise` in `options`; await alongside the resume promise
   before the upload pass; thread both into the file-routing step.
Tests: extend the apply tests to assert the worker passes a `coverLetterPath`
and that resume vs cover-letter inputs are routed by `handler_type`.
Commit: `step apply-4: cover-letter generation + handler-typed file upload`. PAUSE.

## A5 — Completeness gate + review hand-off (validation + flow-states)
Make A3's validation + flow-states the submit gate. Before any full-auto submit,
re-discover the page: if any `is_required` field is still empty or the page shows
validation errors, do NOT submit — set `status='held_review'`,
`reason_code='incomplete_form'`, leave the browser in `semi`/review state, and
surface via `/api/apply/review`. Terminal flow-states `login_required`,
`captcha_required`, `expired`, `redirected` likewise route to review with their
reason_code (never a blind submit). Add post-submit success detection
(confirmation page/text) → `submitted`. Always release the browser on terminal.
Commit: `step apply-5: completeness gate + flow-state review hand-off`. PAUSE.

## A6 — Production browser + readiness UX
Ensure the deploy target has Chromium (Dockerfile/buildpack or
`PUPPETEER_EXECUTABLE_PATH`). Gate the auto-apply UI on
`probeBrowserAvailability()` — if unavailable, hide full-auto, offer
review-only with a clear reason. Scope v1 platforms to greenhouse/lever/ashby
(the providers with the most reliable `handler_type` resolution); everything
else → review. Throttle + jitter; audit every submit in `apply_job_logs`.
Commit: `step apply-6: prod browser readiness + v1 scope`. PAUSE.

## A-final — Green the suite
Drive `test/applyPipeline.test.js` + `test/applyFieldDiscovery.test.js` to
passing; add a completeness-gate test (required-field-empty → held_review).
Commit: `step apply-7: apply pipeline tests green`. PAUSE.

---

# Phase B — LinkedIn extension import (spec: docs/linkedin-extension-audit.md)

## B0 — Verify the write endpoints + source_key (READ-ONLY — report, then stop)

```bash
grep -n "/api/extension/save-job\b\|/api/extension/save-jobs-bulk" server.js
grep -n "source_key" server.js | grep -i "extension\|linkedin" | head
grep -n "linkedin_extension\|linkedin_saved\|'linkedin'" routes/importedJobs.js
```

Determine and **report before coding**:
- Do `/api/extension/save-job` and `/api/extension/save-jobs-bulk` exist?
- What `source_key` do they write? The read route
  (`routes/importedJobs.js`) returns ONLY `source_key='linkedin_extension'` and
  blocks `'linkedin'`/`'linkedin_saved'`. **If the write path stores anything
  other than `linkedin_extension`, imported jobs are silently hidden — that is
  the bug to fix.**

**STOP for user confirmation before B1.**

## B1 — Fix/build the write endpoints
Ensure both endpoints exist, are `requireAuth` cookie-authed, and **normalize
`source_key='linkedin_extension'` for every extension import** regardless of the
client's `sourceLabel`. Upsert into `imported_jobs` deduped on
`(user_id, external_job_id)` falling back to `(user_id, job_url)`, bumping
`last_imported_at`; bulk returns `{ imported, skipped }`. Add a test: POST a
saved-jobs batch → assert they read back via `GET /api/imported-jobs/linkedin`.
Commit: `step ext-1: extension write endpoints + source_key normalization`. PAUSE.

## B2 — Canonical domain + dev switch
Make `extension/manifest.json`, `background.js`, `popup.js`,
`linkedin-content.js`, and `README.md` agree on ONE production domain. Add a
single documented `RESUME_MASTER_URL` constant with a dev/prod switch.
Commit: `step ext-2: canonical domain + dev switch`. PAUSE.

## B3 — Harden extraction against LinkedIn churn
In `linkedin-content.js` (and saved-jobs where available), add JSON-LD
(`<script type="application/ld+json">` JobPosting) parsing as the FIRST
extractor, falling back to the existing CSS-class selectors.
Commit: `step ext-3: JSON-LD extraction fallback`. PAUSE.

## B4 — Logged-out popup UX + permission reconcile
Popup probes auth on open (`/api/auth/me` or a light `/api/extension/ping`); if
unauthenticated, show a sign-in CTA instead of failing saves with 401. Reconcile
README ↔ manifest on the `storage` permission.
Commit: `step ext-4: logged-out UX + permission reconcile`. PAUSE.

## B-final — End-to-end verification
Load unpacked. LinkedIn job page → save single → appears in the in-app LinkedIn
imported list. Saved-jobs page → bulk import → counts correct and jobs RENDER
(this catches the source_key bug). ATS button → JD lands in the ATS-score page.
Report results. PAUSE.

---

# Per-step rules

After every commit print:
```
Step <id> complete. SHA: <sha>
Build: exit 0 | Tests: <pass/fail>
Ready for next step review.
```
**PAUSE after each commit.** Preserve all `api()` endpoints/paths, hook
signatures, router paths, data shapes, HTTP-only cookie + X-RM-Auth-Context,
and OAuth gating throughout.

# Failure handling
- Build/test fails → read the error; fix forward unless the approach is wrong,
  then `git restore` the step's files and resurface.
- A0/B0 are READ-ONLY — never edit during verification; report and stop.
- Contract change appears in a diff (endpoint/path/shape) → STOP and surface.
- Compaction mid-step → STOP, re-read this prompt + the relevant
  `docs/*-audit.md` + current step, resume from that step's anchor.

Begin with Phase 0's anchor commands.
