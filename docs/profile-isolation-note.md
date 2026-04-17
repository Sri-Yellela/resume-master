# Profile Isolation Developer Note

Root causes found:

- Legacy migrations tagged `user_jobs` to the user's active profile and later tagged `scraped_jobs` from `user_job_searches`. That can misclassify historical rows because a search string is not a safe profile boundary.
- Read paths trusted `user_jobs.domain_profile_id` alone. A contaminated `user_jobs` row could surface a `scraped_jobs` row whose profile tag was null, stale, or assigned to another profile.
- State mutation routes could create `user_jobs` rows without `domain_profile_id`, leaving null-tagged state rows behind.
- The admin force-scrape route passed `userId` into `scrapeJobs()` where a `domain_profile_id` was expected.

Current contract:

- Profile-scoped reads must require both `user_jobs.domain_profile_id` and `scraped_jobs.domain_profile_id` to equal the user's active profile.
- Sync must populate `user_jobs` only from `scraped_jobs` rows tagged to the active profile.
- User job state remains keyed by `user_id`; one user's starred, visited, disliked, applied, saved, or pending state must not affect another user's rows.
- Legacy `user_job_searches` can record search intent, but it must not be used to inject jobs into active boards.

Cleanup tradeoff:

- Migration `030_repair_profile_isolation_contamination` removes non-applied `user_jobs` links that cannot be proven to match the owning user and scraped-job profile. It also nulls obvious engineering, PM, and data cross-domain scraped-job tags when no user has applied to the job. Applied records are preserved.
