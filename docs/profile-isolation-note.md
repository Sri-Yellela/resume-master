# Profile Isolation Developer Note

Root causes found:

- Legacy migrations tagged `user_jobs` to the user's active profile and later tagged `scraped_jobs` from `user_job_searches`. That can misclassify historical rows because a search string is not a safe profile boundary.
- Read paths trusted `user_jobs.domain_profile_id` alone. A contaminated `user_jobs` row could surface a `scraped_jobs` row whose profile tag was null, stale, or assigned to another profile.
- State mutation routes could create `user_jobs` rows without `domain_profile_id`, leaving null-tagged state rows behind.
- The admin force-scrape route passed `userId` into `scrapeJobs()` where a `domain_profile_id` was expected.

Current contract:

- `scraped_jobs` is the shared 7-day job pool.
- `job_role_map` maps shared jobs to shared role/profile keys such as `engineering`, `pm`, and `data`.
- Profile-scoped reads use `job_role_map.role_key`, derived from the user's active domain profile, instead of treating a user-owned `domain_profiles.id` as the global classifier.
- `user_jobs` is user-specific state only and should be created when a user interacts with a job, not just because a job is visible.
- User job state remains keyed by `user_id`; one user's starred, visited, disliked, applied, saved, or pending state must not affect another user's rows.
- Legacy `user_job_searches` can record search intent, but it must not be used to inject jobs into active boards.

Cleanup tradeoff:

- Migration `030_repair_profile_isolation_contamination` removes non-applied `user_jobs` links that cannot be proven to match the owning user and scraped-job profile. It also nulls obvious engineering, PM, and data cross-domain scraped-job tags when no user has applied to the job. Applied records are preserved.
- Migration `031_shared_job_role_map` creates the shared mapping table and backfills from historical profile tags plus conservative title heuristics. Historical `scraped_jobs.domain_profile_id` remains only as transitional provenance.
