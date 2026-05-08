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
| Adzuna + Indeed job feed | ❌ | ❌ | ❌ | Stub is live at /api/jobs; provider services pending |

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
