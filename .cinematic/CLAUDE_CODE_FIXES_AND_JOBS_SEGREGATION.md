# Resume Master — Fix-batch commit + Jobs Segregation rebuild

You are working on `main` in `resume-master`. Two streams of work, in order:

- **Phase 0** — Three bug fixes are already applied to the working tree
  (uncommitted). Verify them and commit as three clean `fix:` commits.
- **Phases 1–6** — Rebuild the jobs classification / segregation / filtering
  per `docs/jobs-segregation-architecture.md`, incorporating the two policy
  decisions recorded below.

Phase 0 runs straight through. Phases 1–6 follow the per-phase loop with a
PAUSE after each commit for review.

---

## Anchor first

```bash
cd /c/Users/duggi/WebstormProjects/resume-master
git branch --show-current        # expect: main
git status --short               # expect modified (uncommitted): 
                                 #   client/src/components/InlineLoginPopover.jsx
                                 #   client/src/lib/api.js
                                 #   client/src/components/UnifiedSearchBar.jsx
                                 #   client/src/components/UnifiedSearchBar.css
                                 #   client/src/App.jsx
                                 #   (and possibly .claude/settings.local.json — never stage it)
ls docs/jobs-segregation-architecture.md   # the architecture spec — READ IT before Phase 1
```

If the five files above are NOT modified in the working tree, Phase 0's edits
were lost — STOP and tell the user (they were applied via a direct file editor,
not committed). Otherwise proceed.

## Environment (Windows + Git Bash)

- `npm` not on default PATH. Prefix every npm/node command:
  `PATH="/c/Program Files/nodejs:$PATH" <cmd>`
- Repo root: `/c/Users/duggi/WebstormProjects/resume-master`
- Build: `PATH="/c/Program Files/nodejs:$PATH" npm --prefix client run build 2>&1 | tail -15`
- Tests: `PATH="/c/Program Files/nodejs:$PATH" npm test 2>&1 | tail -30`
- `.claude/settings.local.json` floats as M — NEVER stage it.

## Policy decisions (from the product owner — bake into the classifier)

1. **Supervisory blue-collar titles → DROP (eject as blue).** "Warehouse
   Manager", "Restaurant Manager", "Construction Superintendent", etc. are
   treated as blue-collar and ejected. A generic white-collar noun
   ("manager", "coordinator", "supervisor") does NOT rescue a blue-collar
   title — only a *strong* white-collar role anchor (engineer, analyst,
   scientist, designer, attorney, accountant, counsel, etc.) does.
2. **Unclassified-but-white-collar → pool in "general", as a RARITY.** The
   classifier must be tight enough that very few jobs land in "general".
   Lean hard on telltale title tokens. A job only reaches "general" if it is
   clearly white-collar (no blue anchor, or a blue anchor overridden by a
   strong white anchor) yet cannot be confidently bucketed into a specific
   role family. If a job is neither confidently bucketable NOR carries any
   white-collar signal, **drop it** (do not pool).

---

# Phase 0 — Verify + commit the three fixes

The three fixes already on disk:

**Fix A — inline login popover** (`client/src/components/InlineLoginPopover.jsx`)
The success check was `if (d.success && d.user)`, but `/api/auth/login` returns
`{ user, authContext }` with no `success` field, so login always fell through to
the error branch. Changed to `if (d.user)` (matches `AuthScreen`), added
`username.trim()`.

**Fix B — session auth leak** (`client/src/lib/api.js`)
`setAuthContext()` persisted the auth-context token to `localStorage`, an
immortal credential that survived browser restarts and silently re-authenticated
the user via `X-RM-Auth-Context`. Now sessionStorage-only, with a module-load
purge of any legacy `localStorage` token. Durable login now correctly depends on
the HTTP-only session cookie.

**Fix C — dashboard search bar overlap** (`UnifiedSearchBar.jsx`,
`UnifiedSearchBar.css`, `App.jsx`)
`.usb` was `position: fixed` in both modes, floating over the dashboard cards
("embossing upon content"). Added an `inline` variant using
`position: sticky; top: 56px` (in-flow, no overlap, still pins on scroll);
`AppDashboard` now passes `variant="inline"` and dropped the obsolete dock
padding. Marketing landing untouched (default `floating` variant).

## Verify

```bash
PATH="/c/Program Files/nodejs:$PATH" npm --prefix client run build 2>&1 | tail -15
```

Expect exit 0, no new warnings beyond the known pre-existing set.

Manual smoke (dev) — `PATH="/c/Program Files/nodejs:$PATH" npm --prefix client run dev`:
- Click "Sign In" on the landing nav → popover → valid creds log you in (no
  false "Login failed").
- Log in, close the browser/tab, reopen the site root → you land on the
  marketing page, NOT `/app` (no auth leak). (If a long-lived session cookie
  still auto-logs-in, that's a separate server cookie-lifetime decision — note
  it, don't fix it here.)
- On the dashboard, the search bar sits between the "Your jobs." hero and the
  cards without covering them; scrolling pins it under the TopBar without
  overlapping cards.

## Commit — three separate `fix:` commits

```bash
git add client/src/components/InlineLoginPopover.jsx
git commit -m "fix: inline login popover treated success as failure

/api/auth/login returns { user, authContext } with no success field, so the
popover's 'if (d.success && d.user)' was always false on success and showed
'Login failed' despite logging in server-side. Match AuthScreen: check d.user.
Also trim username for parity."

git add client/src/lib/api.js
git commit -m "fix: session auth leak via immortal localStorage token

setAuthContext persisted the X-RM-Auth-Context token to localStorage, which
never expires; on reload /api/auth/me re-authenticated via that token and
dropped the user straight into /app. Token is now sessionStorage-only (cleared
on browser close) with a module-load purge of any legacy localStorage copy.
Durable session now depends on the HTTP-only cookie's server-controlled
lifetime, as intended."

git add client/src/components/UnifiedSearchBar.jsx client/src/components/UnifiedSearchBar.css client/src/App.jsx
git commit -m "fix: dashboard search bar overlapped cards/content

.usb was position:fixed in both hero and dock modes, floating over dashboard
content that is visible above the fold. Added an 'inline' variant
(position:sticky; top:56px) that keeps the bar in normal flow — no overlap,
still pins on scroll. AppDashboard uses variant=inline and drops the obsolete
dock padding. Marketing landing keeps the default floating variant unchanged."

git log --oneline -5
```

Print the three SHAs, then **PAUSE** for user review before Phase 1.

---

# Phases 1–6 — Jobs segregation rebuild

**Read `docs/jobs-segregation-architecture.md` in full before starting.** It is
the authoritative spec; the phases below are the execution checklist. The core
principle: **classify each job once at ingest into a single canonical verdict,
store it on the row, and filter by the stored verdict — never re-derive
classification at query time.**

Per-phase loop:
```
re-anchor → read affected files → implement → build + test → commit → PAUSE
```
After each commit print:
```
Phase N complete. SHA: <sha>
Build: exit 0 | Tests: <pass/fail counts>
Ready for Phase N+1 review.
```

Hard constraints (unchanged): every `api()` endpoint/path, hook signatures,
router paths, job/ATS/resume data shapes, HTTP-only cookie + X-RM-Auth-Context,
OAuth gating — all preserved.

## Phase 1 — Unified taxonomy module (non-breaking)

Create `services/jobs/jobTaxonomy.js` as the single source of truth for role
families. Adopt **Taxonomy B** (the `jobClassifier.js` SIGNALS taxonomy:
engineering, data, pm, design, marketing, finance, hr, legal, operations,
healthcare, engineering_embedded_firmware) and **add the missing `sales`
family** (account executive, BDR/SDR, sales engineer, customer success,
partnerships, revenue ops — pull anchors from the retired Taxonomy A
`sales_biz_dev` set in `services/jobs/classifier.js` and `profileMatcher.js`).

Export: `SIGNALS` (moved/owned here), `ROLE_FAMILIES` (the canonical key list),
and re-export `classifyTitle`, `classifyForIngest`, `getRoleKeyForProfile`,
`getRoleFamilyDomainForKey`, `roleTitleSql` (import from jobClassifier.js for
now; they move here in a later phase). No behavior change yet.

Tests: extend `test/jobClassifier.test.js` (or new `test/jobTaxonomy.test.js`)
to assert the merged family list includes `sales` and that representative sales
titles classify correctly.

Commit: `step jobs-1: unified taxonomy module (add sales family)`. PAUSE.

## Phase 2 — Collar classifier + unified classifyJob (non-breaking)

Create `services/jobs/collarClassifier.js`:
- `BLUE_COLLAR_ANCHORS` — seed from the blocklist in
  `services/jobs/relevanceFilter.js` (driver, CDL, warehouse associate, line
  cook, barista, electrician, plumber, welder, HVAC, janitor, custodian,
  cashier, stocker, farm worker, mover, home health aide, etc.), plus the
  supervisory blue-collar titles per Policy #1 (warehouse manager, restaurant
  manager, construction superintendent, kitchen manager, store manager when not
  qualified by a white anchor).
- `STRONG_WHITE_ANCHORS` — the `strongAnchors` role phrases from the taxonomy
  SIGNALS (engineer, analyst, scientist, designer, attorney, accountant,
  counsel, controller, recruiter, etc.).
- `detectCollar(title, description) → 'white' | 'blue'`:
  1. No blue anchor → `'white'`.
  2. Blue anchor present AND a strong white anchor present → `'white'`.
  3. Blue anchor present, no strong white anchor → `'blue'`.
  Word-boundary matching; title-weighted (description only as weak support).

Create `classifyJob(title, description, company)` (in `jobTaxonomy.js` or a new
`services/jobs/classifyJob.js`):
```
collar = detectCollar(title, description)
if collar === 'blue' → { collar:'blue', roleKey:null, ... }   // eject signal
else:
  { roleKey, confidence, matchedBy } = classifyTitle(title, description)
  // Policy #2: tight gating.
  if confidence >= INGEST_CONFIDENCE_THRESHOLD → roleKey as-is
  else if (clearly white-collar via strong white anchor) → roleKey = 'general'
  else → roleKey = null  // drop: white-ish but no signal at all
  return { collar:'white', roleKey, domain, seniority, confidence, matchedBy }
```

Tests: `test/collarClassifier.test.js` with a labeled fixture set —
Delivery Driver→blue, Warehouse Associate→blue, Warehouse Manager→blue (policy),
Line Cook→blue, Warehouse Operations Analyst→white, Engineering Manager→white,
Security Engineer→white, Field Service Engineer→white, plus `general`/drop cases.

Commit: `step jobs-2: collar classifier + unified classifyJob`. PAUSE.

## Phase 3 — Migration (non-breaking, additive)

Add a migration (follow the existing migration pattern in `scripts/migration.js`
/ the migrations the app runs at startup):
```sql
ALTER TABLE scraped_jobs ADD COLUMN collar TEXT;
ALTER TABLE scraped_jobs ADD COLUMN classification_confidence REAL;
CREATE TABLE IF NOT EXISTS rejected_jobs (
  job_id TEXT PRIMARY KEY, title TEXT, company TEXT, source TEXT,
  reason TEXT, rejected_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rejected_at ON rejected_jobs(rejected_at);
```
Verify the app boots and the migration is idempotent.

Commit: `step jobs-3: migration — collar, confidence, rejected_jobs`. PAUSE.

## Phase 4 — Wire the gate into every ingest point (BEHAVIOR CHANGE: eject blue)

Find every ingest point:
```bash
grep -rn "INSERT INTO scraped_jobs\|INSERT OR REPLACE INTO scraped_jobs" --include=*.js . | grep -v node_modules
```
Cover at minimum `services/jobs/aggregator.js` (`cacheJobs`) and the
server scrape/search flow in `server.js`. At each:
- Run `classifyJob` once per job.
- `collar === 'blue'` → do NOT insert; DELETE any existing `scraped_jobs` +
  `job_role_map` rows for that job_id; upsert a `rejected_jobs` row
  (reason `'blue_collar'`); increment an ejected counter (log per source).
- `roleKey === null` (white but no signal) → drop (skip insert), per Policy #2.
- else → insert with `bucket_role=roleKey`, `bucket_domain=domain`,
  `bucket_seniority=seniority`, `collar='white'`, `classification_confidence`,
  and upsert `job_role_map` from the same verdict (role_key = roleKey, or
  `general`).
- Replace the old `classify()` (Taxonomy A) call in the aggregator with
  `classifyJob`. Keep `isResumeRelevant` only as a redundant safety net for now
  (it's superseded; removed in Phase 6).

Tests: extend `test/jobsPipelineHardening.test.js` — seed mixed blue/white jobs
through ingest; assert `scraped_jobs` has zero blue rows and `rejected_jobs`
has the seeded blue count.

Commit: `step jobs-4: eject blue-collar at ingest; unified verdict on the row`.
PAUSE.

## Phase 5 — Backfill existing data

Create `scripts/reclassifyJobs.js`: iterate all `scraped_jobs`, run `classifyJob`
on each:
- blue → move to `rejected_jobs`, DELETE from `scraped_jobs` + `job_role_map`.
- null roleKey → DELETE (drop).
- else → rewrite bucket_* / collar / confidence, upsert `job_role_map` with the
  canonical roleKey.
Print a report: ejected per source, reclassified count, dropped count, now-`general`
count. Run it. Expect Adzuna + SerpAPI to account for most ejections.

Commit: `step jobs-5: backfill reclassification + eject existing blue-collar`.
PAUSE.

## Phase 6 — Query by stored verdict; retire the loose re-derivation

- Switch the board query (in `server.js`, the `/api/jobs` family) to join
  `job_role_map` and filter `WHERE m.role_key = @roleKey` instead of calling
  `roleTitleSql()`. Keep `roleTitleSql` behind a flag only if any jobs remain
  unmapped post-backfill; otherwise delete it.
- Delete Taxonomy A: remove `services/jobs/classifier.js` `classify()` and the
  `SKILL_TO_ROLE` map in `services/jobs/profileMatcher.js`; `scoreJob` keeps
  recency/location/seniority ranking but drops the role re-derivation (the board
  is already role-correct from the join).
- Demote `profileTitleSql()` to an *additive* narrowing within an
  already-bucketed board (user's explicit target titles), never the role gate.
- Remove the now-superseded `isResumeRelevant` call from ingest (the collar gate
  replaces it).

Tests: extend `test/profileIsolation.test.js` — a data profile returns zero
PM/ops/sales rows from a seeded mixed set; `test/jobsUiProfileFilters.test.js`
stays green.

Commit: `step jobs-6: query by job_role_map; retire roleTitleSql + Taxonomy A`.
PAUSE.

---

# Failure handling

- Build/test fails → read the error; fix forward unless the approach is wrong,
  then `git restore` the phase's files and resurface.
- Any `api()` endpoint/path or data-shape change shows up in a diff → STOP; the
  rebuild must be classification-only, not contract-changing.
- Unsure whether a title is blue or white at the boundary → default per Policy #1
  (blue unless a strong white anchor), add the case to the test fixture, and note
  it in the commit so the lists can be tuned from real `rejected_jobs` data.
- Compaction mid-phase → STOP, re-read this prompt + `docs/jobs-segregation-architecture.md`
  + the current phase, resume from that phase's anchor.

Begin with Phase 0's anchor commands.
