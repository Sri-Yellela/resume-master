# LinkedIn / Chrome Extension Pipeline — Audit & Completion Plan

**Status:** Audit (current state + next steps). Not yet executed.
**Scope:** The Chrome extension (`extension/`) and its server-side import
endpoints — the pipeline that pulls LinkedIn (and other ATS) job listings into
Resume Master and hands job descriptions to ATS scoring.

> **Important scoping note.** This extension is a **job importer + ATS-score
> launcher, NOT an apply tool.** The original form-fill/auto-apply logic that
> used to live in the extension was removed on 2026-05-08 and ported
> server-side into `services/applyAutomation.js` (see `docs/auto-apply-audit.md`).
> So "complete the extension pipeline" = complete the **import + ATS** flow.
> Auto-apply is a separate track covered by the other audit.

---

## 1. What the extension does today

Manifest v3, version 1.1.0, name "Resume Master". Three capabilities:

1. **Save a job** from a supported listing page → POST to the server →
   stored as an imported job the user sees in-app.
2. **Import saved jobs in bulk** from `linkedin.com/my-items/saved-jobs` →
   scrape the visible cards → batch POST to the server. This is the
   **highest-value** capability: the API sources (Adzuna/SerpApi/Greenhouse/
   Lever/Ashby) cannot see a user's *personal LinkedIn saved list*, so the
   extension is the only path for that data.
3. **ATS-score a job** → grab the visible JD text → open the Resume Master
   ATS-score page with the JD passed through.

Supported sites: LinkedIn, Indeed, Glassdoor, Lever, Greenhouse, Workable.

---

## 2. Architecture & components

```
[ content scripts ]                         [ popup ]                [ background ]
linkedin-content.js  ─ extract JD/title/    popup.js ─ orchestrates  background.js ─
  company/salary/logo, floating ATS button    save + bulk import +     opens RM tabs
  + SAVE_JOB → POST /api/extension/save-job    ATS handoff             (ats-score, resume,
saved-jobs-content.js ─ SCRAPE_SAVED_JOBS                              auth/linkedin)
  (scroll + read cards) → returns jobs[]
        │ bulk POST /api/extension/save-jobs-bulk
        ▼
[ server.js inline routes ]  /api/extension/save-job , /api/extension/save-jobs-bulk
        │  write → imported_jobs (source_key must = 'linkedin_extension')
        ▼
[ routes/importedJobs.js ]  GET /api/imported-jobs/linkedin , /summary , PATCH visited/starred/disliked
        ▼
[ client jobs UI ]  shows imported LinkedIn jobs alongside scraped jobs
```

### Component state

| Component | State | Notes |
|---|---|---|
| `manifest.json` | complete | MV3, host perms + content-script matches aligned. |
| `linkedin-content.js` | functional, fragile | Rich LinkedIn extractors (title/company/location/salary/logo/applyUrl), floating ATS button, SAVE_JOB. Relies on LinkedIn CSS classes (risk 5). |
| `saved-jobs-content.js` | functional, fragile | Infinite-scroll loader + multi-strategy card extraction with link-walk fallback. |
| `popup.js` / `popup.html` / `popup.css` | complete | Detects page type, shows preview, drives save + bulk import with progress UI. |
| `background.js` | complete | Service worker; opens RM tabs for ATS/resume/LinkedIn-import. |
| `routes/importedJobs.js` (read side) | complete | Reads `imported_jobs WHERE source_key='linkedin_extension'`; visited/starred/disliked toggles. |
| `/api/extension/save-job` (write) | VERIFY | Called by content script; must exist inline in server.js. |
| `/api/extension/save-jobs-bulk` (write) | VERIFY | Called by popup bulk import; returns `{ imported, skipped }`. |
| `/auth/linkedin`, `/ats-score`, `/resume` (client routes) | VERIFY | Background opens these RM URLs; must exist client-side. |
| `dist/`, `submission/` zips | present | Packaged v1.1.0 builds exist (was submitted to the store). |

---

## 3. Gaps, risks & concrete bugs

1. **Write endpoints unverified (blocker).** The entire import pipeline depends
   on `/api/extension/save-job` and `/api/extension/save-jobs-bulk` existing in
   `server.js`, cookie-authed (`credentials: 'include'`). Could not be confirmed
   by reading the 319KB monolith — Step 1 verifies them. If absent, the
   extension silently fails every save (content script treats non-200 as error).

2. **`source_key` mapping bug risk (high — likely the real bug).** The read
   route returns only `source_key='linkedin_extension'`, and it explicitly
   **blocks** `'linkedin'` and `'linkedin_saved'`. But the bulk scraper tags
   jobs `sourceLabel: 'LinkedIn Saved'` and single-save sends
   `sourceLabel: detectSource(url)`. If the write endpoint persists `source_key`
   from the client label (e.g. "LinkedIn Saved" → `linkedin_saved`), imported
   jobs are **silently filtered out of the UI**. The write endpoint MUST
   normalize all extension imports to `source_key='linkedin_extension'`
   regardless of client label. Most probable reason imports "don't show up."

3. **Domain inconsistency.** `background.js` and `popup.js` hardcode
   `https://resumemaster.one`; manifest privacy URL is `resumemaster.one/privacy`;
   the README references `resumemaster.app/privacy`. Mismatched origin → cookies
   not sent → 401 on save. Pick one canonical domain; make all agree.

4. **No local-dev switch.** `RESUME_MASTER_URL` hardcoded to prod in three files
   (commented-out localhost). A build-time/config toggle would help testing.

5. **LinkedIn DOM fragility (ongoing maintenance).** Content scripts depend on
   LinkedIn CSS class names that rotate frequently. Add JSON-LD
   (`application/ld+json` JobPosting) parsing as the primary extractor with the
   CSS selectors as fallback — far more stable.

6. **Manifest vs README permission mismatch.** README explains a `storage`
   permission; manifest only requests `activeTab` + `scripting`. Reconcile.

7. **Auth dependency is implicit.** Saves rely on being logged into RM in the
   same browser (cookie auth). The popup should detect logged-out state up front
   and surface a sign-in CTA rather than failing at save time with a 401 toast.

8. **Dedupe key.** Read route keys off `external_job_id`/`job_url`; scraper
   strips tracking params to `origin+pathname` (good). Confirm the write endpoint
   dedupes on `(user_id, external_job_id|job_url)`, bumping `last_imported_at`
   rather than duplicating (the `skipped` counter implies it does — verify).

---

## 4. Completion plan (phased)

### Step 1 — Verify/build the two write endpoints (blocker)
In `server.js`, confirm `/api/extension/save-job` and
`/api/extension/save-jobs-bulk` exist, are `requireAuth`-gated via cookie, and:
- normalize **`source_key='linkedin_extension'`** for every extension import,
- upsert into `imported_jobs` deduped on `(user_id, external_job_id|job_url)`,
  bumping `last_imported_at` and returning `{ imported, skipped }`.
If missing, implement to that contract. Add a test that posts a saved-jobs batch
and asserts they read back via `/api/imported-jobs/linkedin`.

### Step 2 — Canonical domain + dev switch
Make manifest, background.js, popup.js, linkedin-content.js, README agree on one
domain. Add a single documented `RESUME_MASTER_URL` with dev/prod switch.

### Step 3 — Harden extraction against LinkedIn churn
Add JSON-LD JobPosting parsing as the first extractor, falling back to the
current CSS selectors. Same for saved-jobs cards where structured data exists.

### Step 4 — Logged-out UX in the popup
Probe `/api/auth/me` on popup open; if unauthenticated, show "Sign in to Resume
Master" + the LinkedIn-import CTA instead of letting saves 401.

### Step 5 — Reconcile permissions + store metadata
Align README ↔ manifest on `storage`. Re-verify packaged zips match source.

### Step 6 — End-to-end verification
Load unpacked → LinkedIn job page: save single job → confirm it appears in the
in-app LinkedIn imported list. Saved-jobs page: bulk import → confirm counts and
that jobs render (catches the source_key bug). ATS button → JD lands in ATS page.

---

## 5. Bottom line

The extension's **client side is complete and capable** — its value is importing
the one job set the server APIs can't reach: a user's personal LinkedIn saved
list. The fragility is at the **seams**: (a) the two server write endpoints must
exist and **tag imports `source_key='linkedin_extension'`** or the read route
hides them — the most probable real bug; (b) the production domain must be
consistent or cookie-authed saves 401; (c) the LinkedIn DOM selectors need
JSON-LD fallbacks to survive churn. Start at Step 1.
