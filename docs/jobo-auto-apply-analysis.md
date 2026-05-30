# Jobo.world Auto-Apply — Analysis & Lessons for Resume Master

**Source:** https://jobo.world/docs (auto-apply API reference + profiles + field
types + flow states + providers). Fetched for design comparison only — Jobo is a
commercial API (their Auto Apply is currently paused / `503`, 200 credits ≈ $0.20
per session when live). We are NOT integrating Jobo; we're learning from how a
mature, multi-ATS auto-apply system is *architected* and applying those lessons
to our own server-side engine (`services/applyAutomation.js` + the apply queue).

---

## 1. What Jobo is (one line)

A unified REST layer over 57 ATS platforms for job *data* (search/feed/export),
plus an **Auto Apply** API that drives real applications across 25 ATS providers
via a **session-based, field-discovery-first** workflow backed by reusable
**applicant profiles**.

## 2. The architecture that matters to us — field discovery, not blind fill

Our engine injects a fill function and guesses fields by name/id/placeholder/
label heuristics (`FILL_FN_SRC` + `HINT_MAP`). Jobo inverts this: the server
**discovers and returns the form's fields as structured data**, the caller
supplies typed answers keyed by `field_id`, and the server advances the flow.

Jobo's lifecycle:

```
POST /start  {apply_url}
   → { session_id, provider_id, status, fields:[FormFieldInfo], is_terminal }
POST /set-answers  {session_id, answers:[FieldAnswer]}
   → { status, fields:[...next page...], validation_errors, is_terminal }
   (repeat while status ∈ {form_ready, next_available})
   → status:"submitted"  (terminal ✓)
DELETE /sessions/{id}   (release browser; always call on terminal error)
```

Plus a one-shot: `POST /run {profile_id, apply_url}` that does the whole loop
server-side from a saved profile and returns a `step_log[]` + `fields_filled` +
`steps_completed` + `duration_ms`.

### 2a. `FormFieldInfo` — the structured field contract (the key idea)

```
field_id     string            stable handle used in the answer
type         FieldType enum     see §3
label        string            human label as rendered
is_required  boolean
options      [{value,text}]     for select/radio/multi_select/typeahead
handler_type string|null       ATS-specific semantic hint: "first-name",
                               "email", "resume", "cover-letter", ...
```

`handler_type` is the breakthrough we lack. It's a **semantic tag** that maps a
form control to a known meaning, independent of the site's DOM naming. Our
engine reverse-engineers meaning from `placeholder`/`aria-label` strings every
time; Jobo resolves it once per provider and hands it over. That's what lets the
same profile fill Greenhouse, Lever, Ashby, Workday, etc. reliably.

### 2b. `FieldAnswer` — typed answers keyed by discovered field

```
field_id             string   (from the discovered fields)
type                 FieldType
value                string   (format depends on type — see §3)
typeahead_selection  string?  (the dropdown option text to click)
handler_type         string?  (copied back from FormFieldInfo)
clear_first          boolean = true
```

Answers are **explicit and validated**: `set-answers` can return
`validation_errors:[{field_id,message}]` and keep `status:"form_ready"` so the
caller corrects and resubmits — a real feedback loop, versus our fire-and-hope
fill that only learns it failed by screenshotting the end state.

## 3. Field-type taxonomy (adopt this vocabulary)

`text, text_area, select, multi_select, radio, checkbox, file, date, number,
typeahead, toggle, rich_text, hidden, password, static, complex, unknown`

Each has a defined value format. Highlights vs. our engine:
- **`typeahead`** (location/school autocompletes): needs *type text* + *click the
  option* (`value` + `typeahead_selection`). Our engine has no concept of this —
  it just `setNativeValue`s, which fails on React-Select/combobox widgets
  (exactly the Workday/Ashby class of fields that silently under-fill today).
- **`file`** = a local path; Jobo distinguishes resume vs cover-letter file
  inputs via `handler_type` (`"resume"` / `"cover-letter"`). Our engine uploads
  one file to the first `input[type=file]` — the gap we already flagged in the
  auto-apply audit (A3).
- **`rich_text`** (Quill/TinyMCE), **`toggle`**, **`multi_select`**,
  **`checkbox` group** (comma-separated) — all need handlers our blind setter
  doesn't have.
- **`static`** = skip; **`complex`/`unknown`** = provider-specific/ punt.

## 4. Flow states (adopt this state machine)

Active: `form_ready`, `next_available`, `submit_ready`, `redirect_required`.
Terminal: `submitted ✓`, `login_required`, `captcha_required`, `expired`,
`redirected`, `error`.

Lessons for our worker's `apply_run_jobs.status` / `reason_code`:
- **`login_required` / `captcha_required` are first-class terminal states**, not
  generic failures. Jobo *detects* them and ends cleanly with a reason → the
  caller routes to human/review. Our engine currently has no detection; it would
  fill blanks and maybe wrong-submit. We must add these as detected outcomes that
  divert to the review queue (matches our A3/A4 "completeness gate + review
  hand-off").
- **`redirect_required`** (aggregator → real ATS) is explicit: start a new
  session against `redirect_url`. Our engine follows redirects implicitly and can
  end up on an unsupported page; we should detect provider re-resolution.
- **`expired`** as a terminal short-circuits wasted work — cheap to check, we
  don't.
- Always **release the browser on terminal** (their explicit `DELETE /sessions`
  warning). Our `inProgress` map + `closeSemiBrowser` is the equivalent; ensure
  every terminal path closes it (today the `ats_held`/error paths do, but a
  detected login/captcha path doesn't exist yet).

## 5. Provider model — detect from URL, scope explicitly

Jobo maps **25 apply providers** by URL pattern (`boards.greenhouse.io/*`,
`jobs.lever.co/*`, `jobs.ashbyhq.com/*`, `apply.workable.com/*`, …) and returns
`provider_unsupported` as a clean terminal state for anything else. This matches
our audit's "v1 scope = greenhouse/lever/ashby, everything else → review."
Their per-provider `handler_type` resolution is the thing that makes 25 providers
tractable — a provider adapter resolves DOM → semantic handler, then a shared
filler consumes handlers. Our `platformDetector.js` already detects 12 providers
and has per-platform label maps; the missing half is turning those into
**handler-typed field descriptors** the way Jobo does.

## 6. Profile schema — near-superset of our `user_profile`

Jobo's profile (`POST /api/auto-apply/profiles`) is the reusable answer store.
Compared to our `user_profile` table:

| Jobo profile field | Our `user_profile` | Gap |
| --- | --- | --- |
| first_name, last_name, email, phone | full_name (split needed), email, phone | **split full_name** |
| linkedin_url, website_url, portfolio_url | linkedin_url, github_url | add website/portfolio |
| address_line1/2, city, state, country, zip_code | same | ✓ |
| resume_text, resume_file_path, cover_letter_template | (generated per-job) | we generate; they store a template |
| work_authorization, requires_sponsorship | work_auth, requires_sponsorship, has_clearance, clearance_level, visa_type | we're richer here |
| gender, ethnicity, veteran_status, disability_status | same | ✓ |
| desired_salary, salary_expectation_currency | — | **add** |
| available_start_date, willing_to_relocate | — | **add** |
| highest_degree, field_of_study, university, graduation_year | — | **add (education block)** |
| years_of_experience, current_job_title, current_company | (years derived from resume) | **add title/company** |
| **custom_answers** (key→value map) | — | **add — the important one** |

**Biggest profile lesson: `custom_answers` (a string→string map).** Real ATS
forms ask idiosyncratic questions ("How did you hear about us?", "Why this
company?", "Are you 18+?"). A fixed schema can never cover them; a free-form
key/value bag, matched against discovered field labels, can. We should add a
`custom_answers` store to `user_profile` (or a side table) and have the filler
fall back to it by label/handler match. Education + availability + comp +
current-role fields are also common required fields we don't store yet.

## 7. Operational design notes worth copying

- **One-shot `run` returns a `step_log[]`** ({step, action, status,
  fields_count, error, timestamp}) + `fields_filled`/`steps_completed`/
  `duration_ms`. That's exactly the shape our `apply_job_logs` table should take
  for observability and for the review UI to show *what happened*.
- **Charge/commit at session start; nothing on `503`.** Analogous to our ATS
  gate: decide go/no-go *before* spending the expensive browser step.
- **Validation loop** (`validation_errors` + stay `form_ready`) — our engine
  should re-read the page after fill and, if required fields are still empty or
  the page shows errors, treat it as "incomplete → review" rather than submit.

## 8. Concrete changes this implies for our pipeline (folds into the A-series)

1. **Field discovery pass before fill.** Add a `discoverFields(page, provider)`
   that returns `FormFieldInfo[]` (field_id, type, label, is_required, options,
   handler_type) using `platformDetector` label maps to assign `handler_type`.
   Fill from that descriptor instead of blind DOM heuristics. (Engine rewrite,
   biggest item — but it's what makes multi-ATS reliable.)
2. **Adopt the field-type taxonomy** incl. `typeahead` (type + select option),
   `multi_select`, `checkbox` group, `rich_text`, `toggle` — handlers per type.
3. **Resume vs cover-letter routing by `handler_type`** ("resume"/"cover-letter")
   — already in our A3; Jobo confirms the approach.
4. **Detect terminal states**: `login_required`, `captcha_required`, `expired`,
   `redirect_required` → map to `apply_run_jobs.reason_code` and route to the
   review queue instead of submitting. (Strengthens A3/A4.)
5. **Validation feedback loop**: after fill, collect unfilled required fields /
   on-page errors → if any, divert to review (don't auto-submit). This is the
   real "completeness gate."
6. **Extend the profile** with `custom_answers` (key/value), education block,
   availability, desired salary, current title/company, website/portfolio; split
   `full_name`. Feed these into `buildAutofillPayload`.
7. **Keep our differentiators**: we generate tailored resume + cover letter
   per-job (Jobo stores static text/templates), and we gate on ATS score. Our
   value-add is *content generation*; Jobo's is *form mechanics*. The lesson is
   to make our form mechanics as structured as theirs.

## 9. Build-vs-buy note

Jobo's Auto Apply is paused and metered ($0.20/session). It is not a dependency
we should take for the core flow, but its **API shape is an excellent spec** for
our own engine: session/field-discovery/answers/flow-states is a cleaner, more
testable contract than our monolithic `autoApply()`. If we ever want a fallback
for unsupported providers, their `/run` could be an optional adapter — but the
primary lesson is architectural, not integrational.
