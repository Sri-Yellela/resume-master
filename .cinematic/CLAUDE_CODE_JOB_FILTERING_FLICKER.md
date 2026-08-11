# Resume Master — Job filtering (flicker) + SWE population + Adzuna volume

You are on `main` in `resume-master`. Fix three linked problems in the jobs
board, in order, each gated by a **read-only verification step** (report and
STOP before coding), then PAUSE after every commit.

- **W1 — Flicker:** jobs appear then vanish because filtering happens on the
  CLIENT (and/or an optimistic cached list is replaced by a smaller fetch).
- **W2 — SWE under-population:** a SWE search doesn't show all engineering jobs
  that pass filters because the board re-derives role at query time with loose
  `roleTitleSql` LIKE patterns instead of the canonical verdict already stored
  in `job_role_map` by `classifyJob` (the jobs-segregation P6 step never landed).
- **W3 — Adzuna volume:** the Adzuna source fetches a single page of ≤50
  results, capping how many SWE rows can ever populate.

## Environment (Windows + Git Bash)

- `npm` not on PATH: prefix `PATH="/c/Program Files/nodejs:$PATH" <cmd>`.
- Build: `PATH="/c/Program Files/nodejs:$PATH" npm --prefix client run build 2>&1 | tail -15`.
- Tests: `PATH="/c/Program Files/nodejs:$PATH" npm test 2>&1 | tail -40`.
- `server.js` is a 319KB monolith with very long lines — use `grep -n`, never
  read top-to-bottom. `client/src/panels/JobsPanel.jsx` (~173KB) is the same —
  `grep -n` for the filter memo and fetch logic rather than reading wholesale.
- `.claude/settings.local.json` floats as M — NEVER stage it.

## Confirmed facts (do not re-derive; verify only the unknowns below)

- Ingest is consistent on one taxonomy: `services/jobs/classifyJob.js` →
  `classifyTitle` (Taxonomy B). SWE → `roleKey='engineering'`, stored on
  `scraped_jobs.bucket_role` AND in `job_role_map(role_key,role_family,domain,
  confidence)`. Blue-collar ejected; `roleKey===null` dropped.
- `getRoleKeyForProfile` returns `engineering` for an engineering profile.
- `services/jobs/sources/adzuna.js`: `results_per_page = Math.min(pageSize,50)`,
  single `page=1`, `what=query`. No pagination, no category mapping.
- `services/jobs/aggregator.js` `searchJobs` default `pageSize=10`; live results
  are classified and filtered to `collar==='white' && bucket_role!==null`.

---

# W0 — Verify the board query + client filtering (READ-ONLY — report, then stop)

```bash
# Does the board filter by the STORED verdict (job_role_map) or re-derive via roleTitleSql?
grep -n "roleTitleSql\|job_role_map\|getRoleKeyForProfile" server.js | head -40
grep -n "\"/api/jobs\"\|'/api/jobs'\|/api/jobs/poll\|/api/jobs/facets\|\"/api/scrape\"" server.js | head
# How many Adzuna results / pages does the live scrape request?
grep -n "pageSize\|results_per_page\|searchJobs(" server.js services/jobs/aggregator.js | head -30
# Client-side filtering + optimistic cache (the flicker):
grep -n "roleFilter\|catFilter\|srcFilter\|minYoe\|maxYoe\|ageFilter\|visibleJobs\|filteredJobs\|useMemo\|profileCacheRef\|readProfileUiCache" client/src/panels/JobsPanel.jsx | head -60
```

**Report before any code:**
1. Does `/api/jobs` (and `/poll`, `/facets`, `/scrape` count) filter via
   `roleTitleSql(column, roleKey)` or via a `job_role_map` join on `role_key`?
   (Expected: still `roleTitleSql` — confirm.)
2. In `JobsPanel`, list which filters are applied CLIENT-side after fetch
   (the `visibleJobs`/`filteredJobs` memo) vs sent to the server as query params.
3. Is there an optimistic render from `profileCacheRef`/`readProfileUiCache`
   that is later replaced by the server fetch (a second flicker source)?
4. What `pageSize`/page count does the live SWE search pass to Adzuna?

**STOP and confirm the findings with the user before W1.**

---

# W1 — Make filtering authoritative server-side (fix the flicker)

Goal: the server returns the final, already-filtered, already-paginated list;
the client renders it as-is. The only client-side narrowing that remains is the
instant free-text box (`localSearch`) and sort — neither of which should remove
whole role/bucket swaths after paint.

1. **Move board filters to the server query.** Extend `/api/jobs` to accept the
   filters currently applied client-side (role/bucket is implicit from the
   active profile; plus `location`, `workType`, `employmentType`, `minYoe`,
   `maxYoe`, `ageDays`, `source`, `boardTab` = all/saved/pending, `page`,
   `pageSize`). Apply them in SQL. Return `{ jobs, total, page, pageSize }`.
2. **Strip post-fetch filtering from `JobsPanel`.** The `visibleJobs` memo must
   no longer drop jobs by role/category/source/yoe/age/workType — those now
   arrive pre-filtered. Keep only: instant `localSearch` substring match over
   the current page, and client sort if the server didn't sort. Filter controls
   now set query params and refetch (debounced), rather than trimming a list.
3. **Kill the optimistic-then-replace flicker.** If a cached snapshot is shown
   first, do not replace a larger cached list with a smaller fresh list in a way
   that visibly removes cards; render a subtle loading state and swap atomically
   when the fetch resolves (or render only the fetched list). Preserve the
   profile UI cache for filter *settings*, not for stale job rows that get
   culled on screen.
4. Preserve every existing `/api/jobs` response field `JobsPanel`/`JobCard`
   consume (`normalizeApiJob` shape). Do not change endpoint paths.

Verify: search a role → cards appear and stay (no flicker); toggling a filter
refetches and the returned set is what renders. Build clean.
Commit: `fix: server-side job filtering (eliminate board flicker)`. PAUSE.

---

# W2 — Filter by the stored verdict, not roleTitleSql (finish P6)

Switch the board's role gate from query-time LIKE re-derivation to the canonical
`job_role_map.role_key` written at ingest by `classifyJob`.

1. In the `/api/jobs` (+ `/poll`, `/facets`, and the `/api/scrape` DB-first
   count) query, replace `roleTitleSql(column, roleKey)` with a join:
   ```sql
   JOIN job_role_map m ON m.job_id = j.job_id
   WHERE m.role_key = @roleKey
   ```
   where `@roleKey = getRoleKeyForProfile(activeProfile)`. This makes the board
   show exactly what was bucketed at ingest — no looser, no tighter.
2. Keep `roleTitleSql` available ONLY as a transitional fallback for rows with
   no `job_role_map` entry (pre-classifier cache). After confirming coverage
   (`SELECT COUNT(*) FROM scraped_jobs j LEFT JOIN job_role_map m ON
   m.job_id=j.job_id WHERE m.job_id IS NULL`), remove the fallback.
3. `general`-bucket jobs surface only on the General profile (per the
   segregation policy), never on a specific role board.

Verify: with an engineering profile, `/api/jobs` returns exactly the
`role_key='engineering'` rows; counts match
`SELECT COUNT(*) FROM job_role_map WHERE role_key='engineering'` (minus board-tab
/ other filters). Extend `test/profileIsolation.test.js` to assert the join path
returns zero non-engineering rows from a seeded mixed set.
Commit: `fix: board filters by job_role_map.role_key (retire roleTitleSql gate)`. PAUSE.

---

# W3 — Adzuna volume + plugin audit (populate all passing SWE roles)

`services/jobs/sources/adzuna.js` + the live search path in `aggregator.js`.

1. **Paginate Adzuna.** Add a `pages` (or `maxResults`) option to the plugin's
   `search`; loop pages (`/{country}/search/{page}`) with
   `results_per_page=50` until `maxResults` (e.g. 150–250) or results run out,
   concatenating jobs. Respect Adzuna rate limits (small delay between pages).
2. **Raise the live `searchJobs` pageSize** for the interactive SWE search path
   so it requests enough per source (e.g. 50) and enough Adzuna pages to fill a
   board, rather than the default 10.
3. **Verify the `what` mapping.** Confirm the profile's search terms / typed
   query map to Adzuna `what` correctly; consider `what_or` for multiple SWE
   title variants ("software engineer", "backend engineer", …) to broaden
   recall, and the Adzuna `category` (`it-jobs`) as an optional narrowing.
   Keep the post-fetch `remote` filter behavior.
4. Confirm classification keeps the broadened set sane: live results still pass
   `collar==='white' && bucket_role!==null`, so blue-collar/junk won't leak.
5. Mind dedupe: the aggregator dedups by URL — ensure paginated Adzuna pages
   don't double-count and that `total` reflects the real Adzuna `count`.

Verify: a SWE search now returns materially more engineering rows (bounded by
the cap), all bucketed `engineering`, with no blue-collar leakage. Build clean.
Commit: `feat: paginate Adzuna + raise live search volume`. PAUSE.

---

# Per-step rules
After each commit print `SHA / build / tests / ready for next`. **PAUSE** after
each. Preserve all `/api/*` paths, response shapes (`normalizeApiJob`), hook
signatures, the HTTP-only cookie + X-RM-Auth-Context, and OAuth gating.

# Failure handling
- W0 is READ-ONLY — report and stop; no edits during verification.
- If moving a filter server-side would change an endpoint's response shape, keep
  the shape and add fields additively; surface any unavoidable change and STOP.
- Compaction mid-step → re-read this prompt + `docs/jobs-segregation-architecture.md`
  + the current step, resume from that step's verification.

Begin with W0.
