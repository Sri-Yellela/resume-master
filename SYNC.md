# Resume Master - Cross-Platform Sync

Last updated: 2026-05-08

## Feature Registry

| Feature | Web | iOS | Android | Notes |
|---------|-----|-----|---------|-------|
| Resume builder | ✅ | ✅ | ✅ | Core editor exists on all surfaces |
| Template picker | ✅ | ✅ | ✅ | |
| PDF export | ✅ | ✅ | ✅ | |
| User auth / profile | ✅ | ✅ | ✅ | |
| LinkedIn OIDC Import | ✅ | ✅ | ✅ | Name and email only via official OpenID Connect |
| Extension (scrape-free) | ✅ | n/a | n/a | Chrome companion sends visible JD text to ATS tool |
| Manual application tracking | ✅ | ✅ | ✅ | User submits on official employer page |
| Auto-apply queue | ❌ | ❌ | ❌ | LinkedIn automation removed |
| Job feed (Adzuna) | ✅ | ✅ | ✅ | Plugin-based aggregator; add sources in aggregator.js only |

## Pending Sync Items

### Adzuna + Indeed Job Feed
- Shipped on: not yet (stub in place)
- Missing on: Web, iOS, Android
- Priority: High
- Notes: Phase 1 of API migration puts stub at /api/jobs. Full implementation follows after Adzuna credentials are added to .env.

## Data Model Version

Current shared model version: 1.0.1

### Model changelog
- 1.0.1: LinkedIn import is OIDC name/email only; job feed is API-backed stub pending Adzuna/Indeed services.
- 1.0.0: Resume, Job, Template, SwipeAction defined.

## Phase: Scraping Removal + OIDC Migration

### Completed This Phase
| Feature | Web | iOS | Android | Extension |
|---|---|---|---|---|
| LinkedIn OIDC Import | ✅ | ✅ | ✅ | ✅ (popup button) |
| Extension scrape-free rebuild | ✅ | n/a | n/a | ✅ |
| Apify / scraping code removed | ✅ | n/a | n/a | ✅ |
| /api/jobs stub (Adzuna-ready) | ✅ | 🔲 | 🔲 | n/a |
| Job auto-apply automation removed | ✅ | ✅ | ✅ | n/a |
| Privacy docs updated | ✅ | n/a | n/a | n/a |

### Deferred to Next Phase
| Item | Tracking |
|---|---|
| DB schema rename (scraped_jobs → jobs) | docs/migration/DEFERRED_SCRAPE_CLEANUP.md |
| Admin panel scrape monitor → sync monitor | docs/migration/DEFERRED_SCRAPE_CLEANUP.md |
| Test file updates | docs/migration/DEFERRED_SCRAPE_CLEANUP.md |
| Adzuna + Indeed aggregator implementation | Next Codex prompt |

### Credentials Needed Before Next Phase
ADZUNA_APP_ID and ADZUNA_APP_KEY in .env
(Get from developer.adzuna.com — instant approval)

## Phase: Adzuna Job Aggregator — Plugin Architecture

### Shipped: 2026-05-09
| File | Role |
|---|---|
| services/jobs/schema.js | Single normalized job shape — all sources must conform |
| services/jobs/sources/base.js | Plugin interface + runtime validation |
| services/jobs/sources/adzuna.js | Adzuna source plugin — ONLY file that knows about Adzuna |
| services/jobs/aggregator.js | Composes sources; fan-out to all configured in parallel |
| server.js /api/jobs | Wired to aggregator; sanitized inputs, 500 on failure |
| iOS: Data/JobRepository.swift | Calls /api/jobs, generic attribution footer |
| Android: data/JobRepository.kt | Calls /api/jobs, maps to existing Job model |

### Adding a new job source later
1. Create `services/jobs/sources/{name}.js` — implement `name`, `isConfigured()`, `search()`
2. Add one import + one line to `SOURCES` array in `aggregator.js`
3. Done — zero frontend, iOS, or Android changes required

### Architecture rule
The frontend knows only `/api/jobs`. It never hardcodes source names, logos, or URLs.
Attribution is rendered generically from the `attribution` array in the API response.
