// Shared migration definitions — single source of truth for both server.js's boot-time
// migration runner and the standalone scripts/migration.js CLI runner.
// Additive-only: append new {id, sql} entries at the end; never edit or remove an applied one.
export const MIGRATIONS = [
    {
      id: "001_initial_schema",
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          is_admin INTEGER NOT NULL DEFAULT 0,
          apply_mode TEXT NOT NULL DEFAULT 'SIMPLE',
          apify_token TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS user_profile (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          full_name TEXT, email TEXT, phone TEXT,
          linkedin_url TEXT, github_url TEXT, location TEXT,
          address_line1 TEXT, address_line2 TEXT,
          city TEXT, state TEXT, zip TEXT, country TEXT DEFAULT 'United States',
          gender TEXT, ethnicity TEXT, veteran_status TEXT, disability_status TEXT,
          requires_sponsorship INTEGER NOT NULL DEFAULT 0,
          has_clearance INTEGER NOT NULL DEFAULT 0,
          clearance_level TEXT, visa_type TEXT, work_auth TEXT,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS job_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          search_query TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'combined',
          scraped_at INTEGER NOT NULL,
          jobs_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resumes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          company TEXT NOT NULL,
          role TEXT NOT NULL,
          category TEXT,
          apply_mode TEXT NOT NULL DEFAULT 'SIMPLE',
          html TEXT NOT NULL,
          ats_score INTEGER,
          ats_report TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, job_id)
        );
        CREATE TABLE IF NOT EXISTS resume_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          company TEXT NOT NULL,
          role TEXT NOT NULL,
          category TEXT,
          html TEXT NOT NULL,
          ats_score INTEGER,
          ats_report TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS base_resume (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          name TEXT,
          content TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS job_applications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          company TEXT NOT NULL,
          role TEXT NOT NULL,
          job_url TEXT,
          source TEXT,
          location TEXT,
          apply_mode TEXT,
          resume_file TEXT,
          applied_at INTEGER,
          notes TEXT,
          UNIQUE(user_id, job_id)
        );
        CREATE TABLE IF NOT EXISTS refresh_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          query TEXT NOT NULL,
          refreshed_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `,
    },
    {
      id: "002_scraped_jobs_pool",
      sql: `
        CREATE TABLE IF NOT EXISTS scraped_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL UNIQUE,
          search_query TEXT NOT NULL,
          company TEXT NOT NULL,
          title TEXT NOT NULL,
          category TEXT,
          location TEXT,
          work_type TEXT,
          source TEXT,
          url TEXT,
          posted_at TEXT,
          description TEXT,
          ghost_score INTEGER DEFAULT 0,
          years_experience INTEGER,
          is_frequent_repost INTEGER DEFAULT 0,
          _hash TEXT NOT NULL,
          scraped_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_scraped_jobs_query
          ON scraped_jobs(search_query, scraped_at);
        CREATE INDEX IF NOT EXISTS idx_scraped_jobs_hash
          ON scraped_jobs(_hash);
      `,
    },
    {
      id: "003_user_job_views",
      sql: `
        CREATE TABLE IF NOT EXISTS user_job_views (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          viewed_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, job_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_job_views_user
          ON user_job_views(user_id, job_id);
      `,
    },
    {
      id: "004_user_job_searches",
      sql: `
        CREATE TABLE IF NOT EXISTS user_job_searches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          search_query TEXT NOT NULL,
          last_scraped_at INTEGER,
          UNIQUE(user_id, search_query)
        );
      `,
    },
    {
      id: "005_scraped_jobs_new_columns",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN compensation TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN company_icon_url TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN source_platform TEXT;
        UPDATE scraped_jobs SET source_platform = LOWER(source) WHERE source IS NOT NULL;
      `,
    },
    {
      id: "006_user_jobs",
      sql: `
        CREATE TABLE IF NOT EXISTS user_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          visited INTEGER NOT NULL DEFAULT 0,
          applied INTEGER NOT NULL DEFAULT 0,
          starred INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, job_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_jobs_user ON user_jobs(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_jobs_job ON user_jobs(job_id);
        INSERT OR IGNORE INTO user_jobs (user_id, job_id, applied)
          SELECT user_id, job_id, 1 FROM job_applications;
      `,
    },
    {
      id: "007_scraped_jobs_v5_columns",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN apply_url TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN salary_min REAL;
        ALTER TABLE scraped_jobs ADD COLUMN salary_max REAL;
        ALTER TABLE scraped_jobs ADD COLUMN salary_currency TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN description_html TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN applicant_count INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN min_years_exp REAL;
        ALTER TABLE scraped_jobs ADD COLUMN max_years_exp REAL;
        ALTER TABLE scraped_jobs ADD COLUMN exp_raw TEXT;
      `,
    },
    {
      id: "008_disliked_and_linkedin_sessions",
      sql: `
        ALTER TABLE user_jobs ADD COLUMN disliked INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_user_jobs_disliked ON user_jobs(user_id, disliked);
        CREATE TABLE IF NOT EXISTS user_linkedin_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          cookies_enc TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `,
    },
    {
      id: "009_profile_name_split_and_pending",
      sql: `
        ALTER TABLE user_profile ADD COLUMN first_name TEXT;
        ALTER TABLE user_profile ADD COLUMN middle_name TEXT;
        ALTER TABLE user_profile ADD COLUMN last_name TEXT;
        ALTER TABLE user_profile ADD COLUMN name_suffix TEXT;
        ALTER TABLE user_jobs ADD COLUMN resume_generated INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      id: "010_apply_automation",
      sql: `
        ALTER TABLE job_applications ADD COLUMN auto_status TEXT;
        ALTER TABLE job_applications ADD COLUMN screenshot_path TEXT;
      `,
    },
    {
      id: "011_cleanup_log",
      sql: `
        CREATE TABLE IF NOT EXISTS cleanup_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_at INTEGER NOT NULL DEFAULT (unixepoch()),
          jobs_deleted INTEGER NOT NULL DEFAULT 0,
          orphans_cleaned INTEGER NOT NULL DEFAULT 0,
          details TEXT
        );
      `,
    },
    {
      id: "012_clear_all_dislikes",
      sql: `UPDATE user_jobs SET disliked = 0 WHERE disliked = 1;`,
    },
    {
      id: "013_employment_type",
      sql: `ALTER TABLE scraped_jobs ADD COLUMN employment_type TEXT;`,
    },
    {
      id: "admin_usage_events",
      sql: `
        CREATE TABLE IF NOT EXISTS usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          event_subtype TEXT,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_creation_tokens INTEGER DEFAULT 0,
          cached INTEGER NOT NULL DEFAULT 0,
          model TEXT,
          cost_usd REAL DEFAULT 0,
          ats_score_before INTEGER,
          ats_score_after INTEGER,
          duration_ms INTEGER,
          job_id TEXT,
          company TEXT,
          success INTEGER NOT NULL DEFAULT 1,
          error_text TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_usage_events_user
          ON usage_events(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_usage_events_type
          ON usage_events(event_type, created_at);
      `,
    },
    {
      id: "admin_user_limits",
      sql: `
        CREATE TABLE IF NOT EXISTS user_limits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          monthly_resumes INTEGER,
          monthly_ats_scores INTEGER,
          monthly_job_scrapes INTEGER,
          monthly_pdf_exports INTEGER,
          monthly_apply_runs INTEGER,
          monthly_token_budget INTEGER,
          daily_resumes INTEGER,
          daily_job_scrapes INTEGER,
          warning_threshold REAL DEFAULT 0.8,
          notes TEXT,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_by INTEGER REFERENCES users(id)
        );
      `,
    },
    {
      id: "admin_cache_events",
      sql: `
        CREATE TABLE IF NOT EXISTS cache_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          layer TEXT,
          domain_module TEXT,
          tokens_in_cache INTEGER DEFAULT 0,
          tokens_saved INTEGER DEFAULT 0,
          cost_saved_usd REAL DEFAULT 0,
          model TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_cache_events_user
          ON cache_events(user_id, created_at);
      `,
    },
    {
      id: "admin_scrape_events",
      sql: `
        CREATE TABLE IF NOT EXISTS scrape_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          search_query TEXT NOT NULL,
          raw_count INTEGER DEFAULT 0,
          filtered_count INTEGER DEFAULT 0,
          inserted_count INTEGER DEFAULT 0,
          duplicate_count INTEGER DEFAULT 0,
          ghost_count INTEGER DEFAULT 0,
          irrelevant_count INTEGER DEFAULT 0,
          duration_ms INTEGER,
          success INTEGER NOT NULL DEFAULT 1,
          error_text TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_scrape_events_user
          ON scrape_events(user_id, created_at);
      `,
    },
    {
      id: "ats_only_reports",
      sql: `
        CREATE TABLE IF NOT EXISTS ats_only_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          ats_report TEXT NOT NULL,
          ats_score INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, job_id)
        );
      `,
    },
    {
      id: "contact_messages",
      sql: `
        CREATE TABLE IF NOT EXISTS contact_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          subject TEXT,
          message TEXT NOT NULL,
          read INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `,
    },
    // â”€â”€ Phase 2A: Domain profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      id: "013_domain_profiles",
      sql: `
        CREATE TABLE IF NOT EXISTS domain_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          profile_name TEXT NOT NULL,
          role_family TEXT NOT NULL,
          domain TEXT NOT NULL,
          seniority TEXT NOT NULL DEFAULT 'mid',
          target_titles JSON NOT NULL DEFAULT '[]',
          selected_keywords JSON NOT NULL DEFAULT '[]',
          selected_verbs JSON NOT NULL DEFAULT '[]',
          selected_tools JSON NOT NULL DEFAULT '[]',
          is_active INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_domain_profiles_user
          ON domain_profiles(user_id, is_active);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_profiles_active
          ON domain_profiles(user_id) WHERE is_active = 1;
      `,
    },
    {
      id: "014_profile_onboarding_flag",
      sql: `
        ALTER TABLE users ADD COLUMN domain_profile_complete INTEGER NOT NULL DEFAULT 0;
      `,
    },
    // â”€â”€ Phase 5A: Standalone users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      id: "015_standalone_users",
      sql: `
        CREATE TABLE IF NOT EXISTS standalone_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE,
          phone TEXT UNIQUE,
          google_id TEXT UNIQUE,
          display_name TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS standalone_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          standalone_user_id INTEGER REFERENCES standalone_users(id) ON DELETE CASCADE,
          session_id TEXT,
          service TEXT NOT NULL,
          used_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_standalone_usage_user
          ON standalone_usage(standalone_user_id, service);
        CREATE INDEX IF NOT EXISTS idx_standalone_usage_session
          ON standalone_usage(session_id, service);
      `,
    },
    // â”€â”€ Phase 6A: Profile-isolated job pools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      id: "016_scraped_jobs_profile_tag",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN
          domain_profile_id INTEGER REFERENCES domain_profiles(id) ON DELETE SET NULL;
        ALTER TABLE user_jobs ADD COLUMN
          domain_profile_id INTEGER REFERENCES domain_profiles(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_scraped_jobs_profile
          ON scraped_jobs(domain_profile_id);
        CREATE INDEX IF NOT EXISTS idx_user_jobs_profile
          ON user_jobs(user_id, domain_profile_id);
      `,
    },
    // â”€â”€ Phase 6B: ATS scoring at scrape time â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      id: "017_scraped_jobs_ats",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN ats_score INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN ats_report TEXT;
      `,
    },
    // â”€â”€ Phase 6C: Resume Enhancer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      id: "018_base_resume_enhance",
      sql: `
        ALTER TABLE base_resume ADD COLUMN enhanced_at INTEGER;
        ALTER TABLE base_resume ADD COLUMN enhanced_content TEXT;
        ALTER TABLE base_resume ADD COLUMN enhanced_ats_delta INTEGER;
        ALTER TABLE users ADD COLUMN enhance_used INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN enhance_paid INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      id: "019_notifications",
      sql: `
        CREATE TABLE IF NOT EXISTS notifications (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type       TEXT    NOT NULL,
          message    TEXT    NOT NULL,
          payload    TEXT,
          read       INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_user
          ON notifications(user_id, created_at);
      `,
    },
    {
      id: "020_dock_preferences",
      sql: `
        CREATE TABLE IF NOT EXISTS dock_preferences (
          user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          items_json TEXT    NOT NULL DEFAULT '["profile_switcher","notifications","quick_actions","settings","user_avatar"]',
          dock_enabled INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `,
    },
    // â”€â”€ Phase 7: Profile isolation backfill â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      id: "021_backfill_profile_tags",
      sql: `
        -- Disable foreign key enforcement for this migration
        -- The -1 sentinel approach violates the FK constraint
        -- on domain_profile_id. Use NULL instead of -1 for
        -- unmatched legacy rows and handle exclusion in queries.

        -- Best-effort tag: assign user_jobs rows to the user's
        -- active profile where one exists
        UPDATE user_jobs
        SET domain_profile_id = (
          SELECT dp.id
          FROM domain_profiles dp
          WHERE dp.user_id = user_jobs.user_id
            AND dp.is_active = 1
          LIMIT 1
        )
        WHERE domain_profile_id IS NULL;
      `
    },
    {
      id: "022_clear_legacy_user_jobs",
      sql: `
        -- Remove user_jobs rows that could not be matched
        -- to any domain profile (domain_profile_id still NULL
        -- after backfill means no active profile exists for
        -- that user â€” safe to clear, they will re-populate
        -- on next search with a profile set)
        DELETE FROM user_jobs
        WHERE domain_profile_id IS NULL
          AND job_id NOT IN (
            SELECT job_id FROM job_applications
          );
        -- Applied jobs are always protected regardless
      `
    },
    {
      id: "023_clean_wrong_profile_jobs",
      sql: `
        -- Keep only user_jobs that belong to a valid profile or are applied.
        -- Uses temp table to avoid correlated-subquery limitations in older SQLite.
        CREATE TEMP TABLE IF NOT EXISTS jobs_to_keep AS
          SELECT uj.rowid FROM user_jobs uj
          WHERE uj.domain_profile_id IN (
            SELECT id FROM domain_profiles WHERE user_id = uj.user_id
          )
          OR uj.job_id IN (SELECT job_id FROM job_applications);

        DELETE FROM user_jobs
        WHERE rowid NOT IN (SELECT rowid FROM jobs_to_keep);

        DROP TABLE IF EXISTS jobs_to_keep;
      `
    },
    {
      id: "024_clean_crossprofile_jobs",
      sql: `
        -- Remove user_jobs rows whose domain_profile_id belongs to a different user
        DELETE FROM user_jobs
        WHERE rowid IN (
          SELECT uj.rowid FROM user_jobs uj
          WHERE uj.domain_profile_id IS NOT NULL
            AND uj.domain_profile_id NOT IN (
              SELECT id FROM domain_profiles WHERE user_id = uj.user_id
            )
            AND uj.job_id NOT IN (
              SELECT job_id FROM job_applications WHERE user_id = uj.user_id
            )
        );

        -- Remove NULL-tagged rows that are not applied jobs
        DELETE FROM user_jobs
        WHERE domain_profile_id IS NULL
          AND job_id NOT IN (
            SELECT job_id FROM job_applications WHERE user_id = user_jobs.user_id
          );
      `
    },
    {
      id: "025_clean_wrong_profile_jobs",
      sql: `
        -- Remove user_jobs rows with NULL profile tag
        -- that are not applied jobs.
        -- These were inserted by the old search_query
        -- sync before this fix and will never match
        -- any profile filter.
        DELETE FROM user_jobs
        WHERE domain_profile_id IS NULL
        AND job_id NOT IN (
          SELECT job_id FROM job_applications
          WHERE user_id = user_jobs.user_id
        );
      `
    },
    {
      id: "026_backfill_scraped_jobs_profile_tag",
      sql: `
        -- Tag scraped_jobs to the active profile of the user whose
        -- search_query matches, using user_job_searches as the link.
        -- Not perfect for historical data but far better than NULL.
        UPDATE scraped_jobs
        SET domain_profile_id = (
          SELECT dp.id
          FROM user_job_searches ujs
          JOIN domain_profiles dp
            ON dp.user_id = ujs.user_id
            AND dp.is_active = 1
          WHERE LOWER(ujs.search_query) = LOWER(scraped_jobs.search_query)
          LIMIT 1
        )
        WHERE domain_profile_id IS NULL;
      `,
    },
    {
      id: "027_backfill_user_jobs_profile_tag",
      sql: `
        -- Pull domain_profile_id from the scraped_job onto any user_jobs
        -- rows that are still NULL-tagged but whose scraped_job is now tagged.
        UPDATE user_jobs
        SET domain_profile_id = (
          SELECT sj.domain_profile_id
          FROM scraped_jobs sj
          WHERE sj.job_id = user_jobs.job_id
            AND sj.domain_profile_id IS NOT NULL
          LIMIT 1
        )
        WHERE domain_profile_id IS NULL
          AND job_id IN (
            SELECT job_id FROM scraped_jobs WHERE domain_profile_id IS NOT NULL
          );

        -- Remove any remaining NULL-tagged user_jobs that couldn't be matched
        -- and are not applied jobs (safe to drop â€” they'd never appear anyway).
        DELETE FROM user_jobs
        WHERE domain_profile_id IS NULL
          AND job_id NOT IN (
            SELECT job_id FROM job_applications WHERE user_id = user_jobs.user_id
          );
      `,
    },
    {
      id: "028_remove_irrelevant_swe_jobs",
      sql: `
        -- Remove from user_jobs any job tagged to an engineering profile
        -- whose title contains no SWE-relevant keyword. These were incorrectly
        -- inserted when the title relevance filter was broken and then backfilled.
        DELETE FROM user_jobs
        WHERE domain_profile_id IN (
          SELECT id FROM domain_profiles WHERE role_family = 'engineering'
        )
        AND job_id IN (
          SELECT job_id FROM scraped_jobs
          WHERE (
            LOWER(title) NOT LIKE '%engineer%'
            AND LOWER(title) NOT LIKE '%developer%'
            AND LOWER(title) NOT LIKE '%software%'
            AND LOWER(title) NOT LIKE '%programmer%'
            AND LOWER(title) NOT LIKE '%devops%'
            AND LOWER(title) NOT LIKE '%sre%'
            AND LOWER(title) NOT LIKE '%architect%'
            AND LOWER(title) NOT LIKE '%data%'
            AND LOWER(title) NOT LIKE '%machine learning%'
            AND LOWER(title) NOT LIKE '%ml%'
            AND LOWER(title) NOT LIKE '%ai%'
            AND LOWER(title) NOT LIKE '%backend%'
            AND LOWER(title) NOT LIKE '%frontend%'
            AND LOWER(title) NOT LIKE '%fullstack%'
            AND LOWER(title) NOT LIKE '%full stack%'
            AND LOWER(title) NOT LIKE '%platform%'
            AND LOWER(title) NOT LIKE '%infrastructure%'
            AND LOWER(title) NOT LIKE '%cloud%'
            AND LOWER(title) NOT LIKE '%systems%'
            AND LOWER(title) NOT LIKE '%technical%'
            AND LOWER(title) NOT LIKE '%technology%'
            AND LOWER(title) NOT LIKE '%security%'
            AND LOWER(title) NOT LIKE '%analyst%'
            AND LOWER(title) NOT LIKE '%scientist%'
          )
        )
        AND job_id NOT IN (
          SELECT job_id FROM job_applications WHERE user_id = user_jobs.user_id
        );

        -- Also purge from scraped_jobs if no user has applied to them
        DELETE FROM scraped_jobs
        WHERE domain_profile_id IN (
          SELECT id FROM domain_profiles WHERE role_family = 'engineering'
        )
        AND (
          LOWER(title) NOT LIKE '%engineer%'
          AND LOWER(title) NOT LIKE '%developer%'
          AND LOWER(title) NOT LIKE '%software%'
          AND LOWER(title) NOT LIKE '%programmer%'
          AND LOWER(title) NOT LIKE '%devops%'
          AND LOWER(title) NOT LIKE '%architect%'
          AND LOWER(title) NOT LIKE '%data%'
          AND LOWER(title) NOT LIKE '%machine learning%'
          AND LOWER(title) NOT LIKE '%platform%'
          AND LOWER(title) NOT LIKE '%infrastructure%'
          AND LOWER(title) NOT LIKE '%cloud%'
          AND LOWER(title) NOT LIKE '%systems%'
          AND LOWER(title) NOT LIKE '%technical%'
          AND LOWER(title) NOT LIKE '%security%'
          AND LOWER(title) NOT LIKE '%analyst%'
          AND LOWER(title) NOT LIKE '%scientist%'
        )
        AND job_id NOT IN (SELECT DISTINCT job_id FROM job_applications);
      `,
    },
    {
      id: "029_remove_irrelevant_pm_jobs",
      sql: `
        -- Remove from user_jobs any job tagged to a PM profile
        -- whose title contains no PM-relevant keyword.
        DELETE FROM user_jobs
        WHERE domain_profile_id IN (
          SELECT id FROM domain_profiles WHERE role_family = 'pm'
        )
        AND job_id IN (
          SELECT job_id FROM scraped_jobs
          WHERE (
            LOWER(title) NOT LIKE '%project%'
            AND LOWER(title) NOT LIKE '%program%'
            AND LOWER(title) NOT LIKE '%product%'
            AND LOWER(title) NOT LIKE '%manager%'
            AND LOWER(title) NOT LIKE '%coordinator%'
            AND LOWER(title) NOT LIKE '%director%'
            AND LOWER(title) NOT LIKE '%lead%'
            AND LOWER(title) NOT LIKE '%agile%'
            AND LOWER(title) NOT LIKE '%scrum%'
            AND LOWER(title) NOT LIKE '%pmo%'
            AND LOWER(title) NOT LIKE '%delivery%'
            AND LOWER(title) NOT LIKE '%operations%'
          )
        )
        AND job_id NOT IN (
          SELECT job_id FROM job_applications WHERE user_id = user_jobs.user_id
        );
      `,
    },
    {
      id: "030_repair_profile_isolation_contamination",
      sql: `
        -- Repair non-applied profile contamination left by legacy active-profile
        -- and user_job_searches backfills. Applied rows are preserved in
        -- job_applications and hidden from active boards by applied filters.

        DELETE FROM user_jobs
        WHERE applied = 0
          AND (
            domain_profile_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM domain_profiles dp
              WHERE dp.id = user_jobs.domain_profile_id
                AND dp.user_id = user_jobs.user_id
            )
            OR NOT EXISTS (
              SELECT 1 FROM scraped_jobs sj
              WHERE sj.job_id = user_jobs.job_id
                AND sj.domain_profile_id = user_jobs.domain_profile_id
            )
          );

        UPDATE scraped_jobs
        SET domain_profile_id = NULL
        WHERE domain_profile_id IN (SELECT id FROM domain_profiles WHERE role_family = 'engineering')
          AND job_id NOT IN (SELECT DISTINCT job_id FROM job_applications)
          AND LOWER(title) NOT LIKE '%engineer%'
          AND LOWER(title) NOT LIKE '%developer%'
          AND LOWER(title) NOT LIKE '%software%'
          AND LOWER(title) NOT LIKE '%programmer%'
          AND LOWER(title) NOT LIKE '%devops%'
          AND LOWER(title) NOT LIKE '%sre%'
          AND LOWER(title) NOT LIKE '%architect%'
          AND LOWER(title) NOT LIKE '%backend%'
          AND LOWER(title) NOT LIKE '%frontend%'
          AND LOWER(title) NOT LIKE '%fullstack%'
          AND LOWER(title) NOT LIKE '%full stack%'
          AND LOWER(title) NOT LIKE '%platform%'
          AND LOWER(title) NOT LIKE '%infrastructure%'
          AND LOWER(title) NOT LIKE '%cloud%'
          AND LOWER(title) NOT LIKE '%systems%'
          AND LOWER(title) NOT LIKE '%security%';

        UPDATE scraped_jobs
        SET domain_profile_id = NULL
        WHERE domain_profile_id IN (SELECT id FROM domain_profiles WHERE role_family = 'pm')
          AND job_id NOT IN (SELECT DISTINCT job_id FROM job_applications)
          AND LOWER(title) NOT LIKE '%project%'
          AND LOWER(title) NOT LIKE '%program%'
          AND LOWER(title) NOT LIKE '%product%'
          AND LOWER(title) NOT LIKE '%manager%'
          AND LOWER(title) NOT LIKE '%coordinator%'
          AND LOWER(title) NOT LIKE '%director%'
          AND LOWER(title) NOT LIKE '%lead%'
          AND LOWER(title) NOT LIKE '%agile%'
          AND LOWER(title) NOT LIKE '%scrum%'
          AND LOWER(title) NOT LIKE '%pmo%'
          AND LOWER(title) NOT LIKE '%delivery%'
          AND LOWER(title) NOT LIKE '%operations%';

        UPDATE scraped_jobs
        SET domain_profile_id = NULL
        WHERE domain_profile_id IN (SELECT id FROM domain_profiles WHERE role_family = 'data')
          AND job_id NOT IN (SELECT DISTINCT job_id FROM job_applications)
          AND LOWER(title) NOT LIKE '%data%'
          AND LOWER(title) NOT LIKE '%analytics%'
          AND LOWER(title) NOT LIKE '%analyst%'
          AND LOWER(title) NOT LIKE '%scientist%'
          AND LOWER(title) NOT LIKE '%machine learning%'
          AND LOWER(title) NOT LIKE '%ml%'
          AND LOWER(title) NOT LIKE '%ai%'
          AND LOWER(title) NOT LIKE '%business intelligence%'
          AND LOWER(title) NOT LIKE '%bi%'
          AND LOWER(title) NOT LIKE '%research%'
          AND LOWER(title) NOT LIKE '%quantitative%';

        DELETE FROM user_jobs
        WHERE applied = 0
          AND NOT EXISTS (
            SELECT 1 FROM scraped_jobs sj
            WHERE sj.job_id = user_jobs.job_id
              AND sj.domain_profile_id = user_jobs.domain_profile_id
          );
      `,
    },
    // Add future migrations here â€” never edit existing ones
    {
      id: "031_shared_job_role_map",
      sql: `
        CREATE TABLE IF NOT EXISTS job_role_map (
          job_id TEXT NOT NULL REFERENCES scraped_jobs(job_id) ON DELETE CASCADE,
          role_key TEXT NOT NULL,
          role_family TEXT,
          domain TEXT,
          source_profile_id INTEGER REFERENCES domain_profiles(id) ON DELETE SET NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          matched_by TEXT NOT NULL DEFAULT 'profile_scrape',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (job_id, role_key)
        );
        CREATE INDEX IF NOT EXISTS idx_job_role_map_role
          ON job_role_map(role_key, job_id);
        CREATE INDEX IF NOT EXISTS idx_job_role_map_job
          ON job_role_map(job_id);

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, source_profile_id, confidence, matched_by)
        SELECT sj.job_id,
               LOWER(COALESCE(NULLIF(dp.role_family, ''), dp.domain)),
               dp.role_family,
               dp.domain,
               dp.id,
               0.8,
               'legacy_domain_profile_id'
        FROM scraped_jobs sj
        JOIN domain_profiles dp ON dp.id = sj.domain_profile_id;

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id, 'engineering', 'engineering', 'engineering', 0.6, 'title_heuristic'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%engineer%'
           OR LOWER(title) LIKE '%developer%'
           OR LOWER(title) LIKE '%software%'
           OR LOWER(title) LIKE '%devops%'
           OR LOWER(title) LIKE '%sre%'
           OR LOWER(title) LIKE '%backend%'
           OR LOWER(title) LIKE '%frontend%'
           OR LOWER(title) LIKE '%full stack%'
           OR LOWER(title) LIKE '%fullstack%';

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id, 'pm', 'pm', 'pm_general', 0.6, 'title_heuristic'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%project%'
           OR LOWER(title) LIKE '%program%'
           OR LOWER(title) LIKE '%product%'
           OR LOWER(title) LIKE '%scrum%'
           OR LOWER(title) LIKE '%pmo%'
           OR LOWER(title) LIKE '%delivery manager%';

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id, 'data', 'data', 'data', 0.6, 'title_heuristic'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%data%'
           OR LOWER(title) LIKE '%analytics%'
           OR LOWER(title) LIKE '%analyst%'
           OR LOWER(title) LIKE '%scientist%'
           OR LOWER(title) LIKE '%machine learning%'
           OR LOWER(title) LIKE '%business intelligence%';
      `,
    },
    {
      id: "032_password_reset_tokens",
      sql: `
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          email TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          otp_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER,
          requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
          request_ip TEXT,
          user_agent TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_password_reset_user
          ON password_reset_tokens(user_id, used_at, expires_at);
        CREATE INDEX IF NOT EXISTS idx_password_reset_expires
          ON password_reset_tokens(expires_at);
      `,
    },
    {
      id: "033_plan_tiers_and_simple_apply_profile",
      sql: `
        ALTER TABLE users ADD COLUMN plan_tier TEXT NOT NULL DEFAULT 'BASIC';
        UPDATE users
        SET plan_tier = CASE
          WHEN apply_mode = 'CUSTOM_SAMPLER' THEN 'PRO'
          WHEN apply_mode = 'TAILORED' THEN 'PLUS'
          ELSE 'BASIC'
        END;

        CREATE TABLE IF NOT EXISTS plan_upgrade_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          requested_tier TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
          decided_at INTEGER,
          decided_by INTEGER REFERENCES users(id),
          notes TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_plan_upgrade_requests_status
          ON plan_upgrade_requests(status, requested_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_upgrade_one_pending
          ON plan_upgrade_requests(user_id) WHERE status = 'pending';

        CREATE TABLE IF NOT EXISTS simple_apply_profiles (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          titles_json TEXT NOT NULL DEFAULT '[]',
          keywords_json TEXT NOT NULL DEFAULT '[]',
          skills_json TEXT NOT NULL DEFAULT '[]',
          search_terms_json TEXT NOT NULL DEFAULT '[]',
          source_hash TEXT,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `,
    },
    {
      id: "034_plan_reset_and_profile_repair",
      sql: `
        UPDATE users
        SET plan_tier = 'BASIC'
        WHERE plan_tier IS NULL
           OR plan_tier NOT IN ('BASIC','PLUS','PRO');

        UPDATE users
        SET apply_mode = CASE plan_tier
          WHEN 'PRO' THEN 'CUSTOM_SAMPLER'
          WHEN 'PLUS' THEN 'TAILORED'
          ELSE 'SIMPLE'
        END
        WHERE apply_mode IS NULL
           OR apply_mode NOT IN ('SIMPLE','TAILORED','CUSTOM_SAMPLER')
           OR (plan_tier = 'BASIC' AND apply_mode != 'SIMPLE')
           OR (plan_tier = 'PLUS' AND apply_mode != 'TAILORED')
           OR (plan_tier = 'PRO' AND apply_mode != 'CUSTOM_SAMPLER');

        DELETE FROM password_reset_tokens
        WHERE used_at IS NOT NULL
           OR expires_at <= unixepoch() - 86400;

        DELETE FROM user_jobs
        WHERE applied = 0
          AND (
            domain_profile_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM domain_profiles dp
              WHERE dp.id = user_jobs.domain_profile_id
                AND dp.user_id = user_jobs.user_id
            )
          );
      `,
    },
    {
      id: "035_prune_stale_role_maps",
      sql: `
        DELETE FROM job_role_map
        WHERE role_key = 'engineering'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%engineer%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%developer%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%software%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%programmer%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%devops%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%sre%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%architect%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%backend%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%frontend%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%fullstack%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%full stack%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%platform%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%infrastructure%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%cloud%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%systems%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%security%';

        DELETE FROM user_jobs
        WHERE applied = 0
          AND NOT EXISTS (
            SELECT 1 FROM job_role_map jrm
            JOIN domain_profiles dp
              ON dp.id = user_jobs.domain_profile_id
             AND jrm.role_key = LOWER(COALESCE(NULLIF(dp.role_family, ''), dp.domain))
            WHERE jrm.job_id = user_jobs.job_id
          );
      `,
    },
    {
      id: "036_console_tier_profile_repair",
      sql: `
        UPDATE users
        SET plan_tier = 'BASIC'
        WHERE plan_tier IS NULL
           OR plan_tier NOT IN ('BASIC','PLUS','PRO');

        UPDATE users
        SET apply_mode = CASE plan_tier
          WHEN 'PRO' THEN 'CUSTOM_SAMPLER'
          WHEN 'PLUS' THEN 'TAILORED'
          ELSE 'SIMPLE'
        END
        WHERE apply_mode IS NULL
           OR apply_mode NOT IN ('SIMPLE','TAILORED','CUSTOM_SAMPLER')
           OR (plan_tier = 'BASIC' AND apply_mode != 'SIMPLE')
           OR (plan_tier = 'PLUS' AND apply_mode != 'TAILORED')
           OR (plan_tier = 'PRO' AND apply_mode != 'CUSTOM_SAMPLER');

        DELETE FROM job_role_map
        WHERE job_id NOT IN (SELECT job_id FROM scraped_jobs);

        DELETE FROM job_role_map
        WHERE role_key = 'engineering'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%engineer%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%developer%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%software%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%programmer%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%devops%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%sre%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%architect%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%backend%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%frontend%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%fullstack%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%full stack%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%platform%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%infrastructure%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%cloud%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%systems%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%security%';

        DELETE FROM job_role_map
        WHERE role_key = 'pm'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%project%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%program%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%product%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%manager%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%coordinator%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%director%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%agile%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%scrum%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%pmo%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%delivery%';

        DELETE FROM job_role_map
        WHERE role_key = 'data'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%data%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%analytics%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%analyst%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%scientist%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%machine learning%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%ml%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%ai%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%business intelligence%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%bi%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%research%'
          AND LOWER((SELECT title FROM scraped_jobs sj WHERE sj.job_id = job_role_map.job_id)) NOT LIKE '%quantitative%';

        DELETE FROM user_jobs
        WHERE applied = 0
          AND (
            domain_profile_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM domain_profiles dp
              WHERE dp.id = user_jobs.domain_profile_id
                AND dp.user_id = user_jobs.user_id
            )
            OR NOT EXISTS (
              SELECT 1
              FROM domain_profiles dp
              JOIN job_role_map jrm
                ON jrm.job_id = user_jobs.job_id
               AND jrm.role_key = LOWER(COALESCE(NULLIF(dp.role_family, ''), dp.domain))
              WHERE dp.id = user_jobs.domain_profile_id
                AND dp.user_id = user_jobs.user_id
            )
          );
      `,
    },
    {
      id: "037_domain_profile_requests",
      sql: `
        CREATE TABLE IF NOT EXISTS domain_profile_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          desired_title TEXT NOT NULL,
          role_family TEXT,
          target_titles_json TEXT NOT NULL DEFAULT '[]',
          skills_json TEXT NOT NULL DEFAULT '[]',
          tools_json TEXT NOT NULL DEFAULT '[]',
          industries_json TEXT NOT NULL DEFAULT '[]',
          keywords_json TEXT NOT NULL DEFAULT '[]',
          seniority TEXT,
          work_preference TEXT,
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_domain_profile_requests_status
          ON domain_profile_requests(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_domain_profile_requests_user
          ON domain_profile_requests(user_id, created_at);
      `,
    },
    {
      id: "038_role_map_ml_pm_repair",
      sql: `
        DELETE FROM job_role_map
        WHERE role_key = 'engineering'
          AND job_id IN (
            SELECT job_id FROM scraped_jobs
            WHERE LOWER(title) LIKE '%machine learning%'
               OR LOWER(title) LIKE '%ml engineer%'
               OR LOWER(title) LIKE '%ai engineer%'
               OR LOWER(title) LIKE '%artificial intelligence%'
               OR LOWER(title) LIKE '%llm%'
               OR LOWER(title) LIKE '%genai%'
               OR LOWER(title) LIKE '%generative ai%'
               OR LOWER(title) LIKE '%project manager%'
               OR LOWER(title) LIKE '%program manager%'
               OR LOWER(title) LIKE '%product manager%'
               OR LOWER(title) LIKE '%project coordinator%'
               OR LOWER(title) LIKE '%scrum master%'
               OR LOWER(title) LIKE '%pmo%'
          );

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id, 'data', 'data', 'data', 0.95, 'ml_ai_repair'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%machine learning%'
           OR LOWER(title) LIKE '%ml engineer%'
           OR LOWER(title) LIKE '%ai engineer%'
           OR LOWER(title) LIKE '%artificial intelligence%'
           OR LOWER(title) LIKE '%llm%'
           OR LOWER(title) LIKE '%genai%'
           OR LOWER(title) LIKE '%generative ai%';

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id, 'pm', 'pm', 'pm_general', 0.95, 'pm_repair'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%project manager%'
           OR LOWER(title) LIKE '%program manager%'
           OR LOWER(title) LIKE '%product manager%'
           OR LOWER(title) LIKE '%project coordinator%'
           OR LOWER(title) LIKE '%scrum master%'
           OR LOWER(title) LIKE '%pmo%';
      `,
    },
    {
      id: "039_resume_version_tool_artifacts",
      sql: `
        ALTER TABLE resume_versions ADD COLUMN tool_type TEXT NOT NULL DEFAULT 'generate';
        ALTER TABLE resume_versions ADD COLUMN is_kept INTEGER NOT NULL DEFAULT 0;
        UPDATE resume_versions
        SET tool_type = CASE
          WHEN EXISTS (
            SELECT 1 FROM resumes r
            WHERE r.user_id = resume_versions.user_id
              AND r.job_id = resume_versions.job_id
              AND r.apply_mode = 'CUSTOM_SAMPLER'
          ) THEN 'a_plus_resume'
          ELSE 'generate'
        END
        WHERE tool_type IS NULL OR tool_type = '';
      `,
    },
    {
      id: "040_tab_scoped_auth_contexts",
      sql: `
        CREATE TABLE IF NOT EXISTS auth_contexts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER,
          user_agent TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_auth_contexts_user
          ON auth_contexts(user_id, revoked_at, expires_at);
        CREATE INDEX IF NOT EXISTS idx_auth_contexts_expiry
          ON auth_contexts(expires_at, revoked_at);
      `,
    },
    {
      id: "041_resume_ats_cache_metadata",
      sql: `
        ALTER TABLE resumes ADD COLUMN ats_cache_key TEXT;
        ALTER TABLE resumes ADD COLUMN ats_prompt_version TEXT;
        ALTER TABLE resume_versions ADD COLUMN ats_cache_key TEXT;
        ALTER TABLE resume_versions ADD COLUMN ats_prompt_version TEXT;
        CREATE INDEX IF NOT EXISTS idx_resume_versions_ats_cache
          ON resume_versions(user_id, job_id, tool_type, ats_cache_key);
      `,
    },
    {
      id: "042_apply_runs_queue",
      sql: `
        CREATE TABLE IF NOT EXISTS apply_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          mode TEXT NOT NULL DEFAULT 'auto',
          tool_type TEXT,
          status TEXT NOT NULL DEFAULT 'queued',
          total_jobs INTEGER NOT NULL DEFAULT 0,
          submitted_count INTEGER NOT NULL DEFAULT 0,
          held_count INTEGER NOT NULL DEFAULT 0,
          failed_count INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER,
          finished_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS apply_run_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES apply_runs(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          reason_code TEXT,
          reason_detail TEXT,
          ats_score INTEGER,
          resume_id INTEGER,
          resume_file TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          locked_at INTEGER,
          started_at INTEGER,
          finished_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(run_id, job_id)
        );
        CREATE TABLE IF NOT EXISTS apply_job_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER,
          run_job_id INTEGER,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id TEXT,
          level TEXT NOT NULL DEFAULT 'info',
          event TEXT NOT NULL,
          message TEXT,
          details_json TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_apply_runs_user_status ON apply_runs(user_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_apply_run_jobs_user_status ON apply_run_jobs(user_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_apply_logs_run ON apply_job_logs(run_id, run_job_id, created_at);
      `,
    },
    {
      id: "043_user_integrations",
      sql: `
        CREATE TABLE IF NOT EXISTS user_integrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          account_email TEXT,
          status TEXT NOT NULL DEFAULT 'connected',
          scopes_json TEXT NOT NULL DEFAULT '[]',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          secret_enc TEXT,
          iv TEXT,
          auth_tag TEXT,
          expires_at INTEGER,
          last_checked_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, provider)
        );
        CREATE INDEX IF NOT EXISTS idx_user_integrations_user_provider
          ON user_integrations(user_id, provider, status);
      `,
    },
    {
      id: "044_auth_provider_links",
      sql: `
        ALTER TABLE users ADD COLUMN google_auth_id TEXT;
        ALTER TABLE users ADD COLUMN linkedin_auth_id TEXT;
        ALTER TABLE user_integrations ADD COLUMN provider_user_id TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_auth_id
          ON users(google_auth_id) WHERE google_auth_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_linkedin_auth_id
          ON users(linkedin_auth_id) WHERE linkedin_auth_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_user_integrations_provider_identity
          ON user_integrations(provider, provider_user_id);
      `,
    },
    {
      id: "053_github_auth_provider_link",
      sql: `
        ALTER TABLE users ADD COLUMN github_auth_id TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_auth_id
          ON users(github_auth_id) WHERE github_auth_id IS NOT NULL;
      `,
    },
    {
      // Repair: firmware/embedded jobs were bulk-assigned role_key='engineering' by
      // the title_heuristic in migration 031 and were never corrected.  This migration:
      //   1. Adds role_key='engineering_embedded_firmware' for jobs scraped under
      //      firmware domain profiles.
      //   2. Adds role_key='engineering_embedded_firmware' for jobs whose title
      //      clearly indicates firmware/embedded work (title heuristic).
      //   3. Removes the stale role_key='engineering' entries that arrived via the
      //      generic title_heuristic for those same jobs â€” so SWE users never see
      //      them even if roleKeyForProfile returns 'engineering'.
      //   Jobs that were explicitly scraped under a SWE profile (matched_by =
      //   'profile_scrape') keep their 'engineering' entry so they remain visible
      //   to the scraping user; the roleTitleSql firmware exclusions still prevent
      //   them from surfacing in SWE results for other users.
      id: "045_firmware_role_map_repair",
      sql: `
        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT jrm.job_id,
               'engineering_embedded_firmware',
               'engineering',
               'engineering_embedded_firmware',
               0.95,
               'firmware_profile_repair'
        FROM job_role_map jrm
        JOIN domain_profiles dp ON dp.id = jrm.source_profile_id
        WHERE jrm.role_key = 'engineering'
          AND dp.domain = 'engineering_embedded_firmware';

        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id,
               'engineering_embedded_firmware',
               'engineering',
               'engineering_embedded_firmware',
               0.9,
               'firmware_title_repair'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%firmware%'
           OR LOWER(title) LIKE '%embedded%'
           OR LOWER(title) LIKE '%bsp%'
           OR LOWER(title) LIKE '%device driver%'
           OR LOWER(title) LIKE '%silicon validation%'
           OR LOWER(title) LIKE '%post-silicon%'
           OR LOWER(title) LIKE '%post silicon%'
           OR LOWER(title) LIKE '%soc bring%'
           OR LOWER(title) LIKE '%board bring%'
           OR LOWER(title) LIKE '%chip bring%'
           OR LOWER(title) LIKE '%bootloader%'
           OR LOWER(title) LIKE '%rtos%'
           OR LOWER(title) LIKE '% bios %'
           OR LOWER(title) LIKE 'bios %'
           OR LOWER(title) LIKE '%uefi%';

        DELETE FROM job_role_map
        WHERE role_key = 'engineering'
          AND matched_by = 'title_heuristic'
          AND job_id IN (
            SELECT job_id FROM scraped_jobs
            WHERE LOWER(title) LIKE '%firmware%'
               OR LOWER(title) LIKE '%embedded%'
               OR LOWER(title) LIKE '%bsp%'
               OR LOWER(title) LIKE '%device driver%'
               OR LOWER(title) LIKE '%silicon validation%'
               OR LOWER(title) LIKE '%post-silicon%'
               OR LOWER(title) LIKE '%post silicon%'
               OR LOWER(title) LIKE '%soc bring%'
               OR LOWER(title) LIKE '%board bring%'
               OR LOWER(title) LIKE '%chip bring%'
               OR LOWER(title) LIKE '%bootloader%'
               OR LOWER(title) LIKE '%rtos%'
               OR LOWER(title) LIKE '% bios %'
               OR LOWER(title) LIKE 'bios %'
               OR LOWER(title) LIKE '%uefi%'
          );
      `,
    },
    {
      // Repair: data scientist / data engineer / analytics engineer titles
      // were incorrectly assigned role_key='engineering' in two ways:
      //   1. Scraped under an engineering profile (assignJobRoleMap => 'engineering')
      //   2. Title matched '%engineer%' / '%developer%' in migration 031 heuristic
      // Migration 038 already handled ML/AI/PM titles.  This migration extends that
      // repair to cover data-family specialty titles that were missed.
      //
      // Only removes heuristic and profile-scrape engineering entries â€” manual_review
      // entries are preserved (admin override must win).
      id: "046_data_specialty_role_repair",
      sql: `
        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT job_id, 'data', 'data', 'data', 0.95, 'data_specialty_repair'
        FROM scraped_jobs
        WHERE LOWER(title) LIKE '%data scientist%'
           OR LOWER(title) LIKE '%data engineer%'
           OR LOWER(title) LIKE '%analytics engineer%'
           OR LOWER(title) LIKE '%research scientist%'
           OR LOWER(title) LIKE '%applied scientist%'
           OR LOWER(title) LIKE '%ml platform engineer%'
           OR LOWER(title) LIKE '%mlops engineer%';

        DELETE FROM job_role_map
        WHERE role_key = 'engineering'
          AND matched_by IN ('title_heuristic', 'legacy_domain_profile_id',
                             'duplicate_profile_scrape', 'profile_scrape')
          AND job_id IN (
            SELECT job_id FROM scraped_jobs
            WHERE LOWER(title) LIKE '%data scientist%'
               OR LOWER(title) LIKE '%data engineer%'
               OR LOWER(title) LIKE '%analytics engineer%'
               OR LOWER(title) LIKE '%research scientist%'
               OR LOWER(title) LIKE '%applied scientist%'
               OR LOWER(title) LIKE '%ml platform engineer%'
               OR LOWER(title) LIKE '%mlops engineer%'
          );
      `,
    },
    {
      // 047 â€” Repair existing orphaned jobs that have no job_role_map entry.
      //
      // These are jobs that were scraped without a domainProfile (admin scrapes,
      // profiles deleted post-scrape, or pre-046 legacy ingests) and therefore
      // fell through the assignJobRoleMap() guard.  The ingest-time classifier
      // now handles new orphans; this migration back-fills the historical gap
      // using the same high-confidence title patterns.
      //
      // Only assigns role_key when the title strongly matches a single family.
      // Preserves manual_review entries â€” admin overrides are never touched.
      id: "047_orphaned_job_classifier_repair",
      sql: `
        INSERT OR IGNORE INTO job_role_map
          (job_id, role_key, role_family, domain, confidence, matched_by)
        SELECT sj.job_id,
               CASE
                 WHEN LOWER(sj.title) LIKE '%firmware engineer%'
                   OR LOWER(sj.title) LIKE '%embedded systems engineer%'
                   OR LOWER(sj.title) LIKE '%bsp engineer%'
                   OR LOWER(sj.title) LIKE '%uefi engineer%'
                   OR LOWER(sj.title) LIKE '%device driver engineer%'
                   OR LOWER(sj.title) LIKE '%bootloader engineer%'
                   OR LOWER(sj.title) LIKE '%rtos engineer%'
                 THEN 'engineering_embedded_firmware'
                 WHEN LOWER(sj.title) LIKE '%machine learning engineer%'
                   OR LOWER(sj.title) LIKE '%data scientist%'
                   OR LOWER(sj.title) LIKE '%data engineer%'
                   OR LOWER(sj.title) LIKE '%analytics engineer%'
                   OR LOWER(sj.title) LIKE '%ml engineer%'
                   OR LOWER(sj.title) LIKE '%ai engineer%'
                   OR LOWER(sj.title) LIKE '%research scientist%'
                   OR LOWER(sj.title) LIKE '%applied scientist%'
                 THEN 'data'
                 WHEN LOWER(sj.title) LIKE '%product manager%'
                   OR LOWER(sj.title) LIKE '%project manager%'
                   OR LOWER(sj.title) LIKE '%program manager%'
                   OR LOWER(sj.title) LIKE '%scrum master%'
                   OR LOWER(sj.title) LIKE '%product owner%'
                 THEN 'pm'
                 WHEN LOWER(sj.title) LIKE '%software engineer%'
                   OR LOWER(sj.title) LIKE '%backend engineer%'
                   OR LOWER(sj.title) LIKE '%frontend engineer%'
                   OR LOWER(sj.title) LIKE '%full stack engineer%'
                   OR LOWER(sj.title) LIKE '%devops engineer%'
                   OR LOWER(sj.title) LIKE '%site reliability engineer%'
                   OR LOWER(sj.title) LIKE '%software developer%'
                   OR LOWER(sj.title) LIKE '%platform engineer%'
                   OR LOWER(sj.title) LIKE '%mobile engineer%'
                 THEN 'engineering'
               END AS role_key,
               CASE
                 WHEN LOWER(sj.title) LIKE '%firmware engineer%'
                   OR LOWER(sj.title) LIKE '%embedded systems engineer%'
                   OR LOWER(sj.title) LIKE '%bsp engineer%'
                   OR LOWER(sj.title) LIKE '%uefi engineer%'
                   OR LOWER(sj.title) LIKE '%device driver engineer%'
                   OR LOWER(sj.title) LIKE '%bootloader engineer%'
                   OR LOWER(sj.title) LIKE '%rtos engineer%'
                 THEN 'engineering'
                 WHEN LOWER(sj.title) LIKE '%machine learning engineer%'
                   OR LOWER(sj.title) LIKE '%data scientist%'
                   OR LOWER(sj.title) LIKE '%data engineer%'
                   OR LOWER(sj.title) LIKE '%analytics engineer%'
                   OR LOWER(sj.title) LIKE '%ml engineer%'
                   OR LOWER(sj.title) LIKE '%ai engineer%'
                   OR LOWER(sj.title) LIKE '%research scientist%'
                   OR LOWER(sj.title) LIKE '%applied scientist%'
                 THEN 'data'
                 ELSE role_key
               END AS role_family,
               CASE
                 WHEN LOWER(sj.title) LIKE '%firmware engineer%'
                   OR LOWER(sj.title) LIKE '%embedded systems engineer%'
                   OR LOWER(sj.title) LIKE '%bsp engineer%'
                   OR LOWER(sj.title) LIKE '%uefi engineer%'
                   OR LOWER(sj.title) LIKE '%device driver engineer%'
                   OR LOWER(sj.title) LIKE '%bootloader engineer%'
                   OR LOWER(sj.title) LIKE '%rtos engineer%'
                 THEN 'engineering_embedded_firmware'
                 WHEN LOWER(sj.title) LIKE '%software engineer%'
                   OR LOWER(sj.title) LIKE '%backend engineer%'
                   OR LOWER(sj.title) LIKE '%frontend engineer%'
                   OR LOWER(sj.title) LIKE '%full stack engineer%'
                   OR LOWER(sj.title) LIKE '%devops engineer%'
                   OR LOWER(sj.title) LIKE '%site reliability engineer%'
                   OR LOWER(sj.title) LIKE '%software developer%'
                   OR LOWER(sj.title) LIKE '%platform engineer%'
                   OR LOWER(sj.title) LIKE '%mobile engineer%'
                 THEN 'it_digital'
                 ELSE role_key
               END AS domain,
               0.85 AS confidence,
               'orphan_repair' AS matched_by
        FROM scraped_jobs sj
        LEFT JOIN job_role_map jrm ON jrm.job_id = sj.job_id
        WHERE jrm.job_id IS NULL
          AND (
            LOWER(sj.title) LIKE '%firmware engineer%'
            OR LOWER(sj.title) LIKE '%embedded systems engineer%'
            OR LOWER(sj.title) LIKE '%bsp engineer%'
            OR LOWER(sj.title) LIKE '%uefi engineer%'
            OR LOWER(sj.title) LIKE '%device driver engineer%'
            OR LOWER(sj.title) LIKE '%bootloader engineer%'
            OR LOWER(sj.title) LIKE '%rtos engineer%'
            OR LOWER(sj.title) LIKE '%machine learning engineer%'
            OR LOWER(sj.title) LIKE '%data scientist%'
            OR LOWER(sj.title) LIKE '%data engineer%'
            OR LOWER(sj.title) LIKE '%analytics engineer%'
            OR LOWER(sj.title) LIKE '%ml engineer%'
            OR LOWER(sj.title) LIKE '%ai engineer%'
            OR LOWER(sj.title) LIKE '%research scientist%'
            OR LOWER(sj.title) LIKE '%applied scientist%'
            OR LOWER(sj.title) LIKE '%product manager%'
            OR LOWER(sj.title) LIKE '%project manager%'
            OR LOWER(sj.title) LIKE '%program manager%'
            OR LOWER(sj.title) LIKE '%scrum master%'
            OR LOWER(sj.title) LIKE '%product owner%'
            OR LOWER(sj.title) LIKE '%software engineer%'
            OR LOWER(sj.title) LIKE '%backend engineer%'
            OR LOWER(sj.title) LIKE '%frontend engineer%'
            OR LOWER(sj.title) LIKE '%full stack engineer%'
            OR LOWER(sj.title) LIKE '%devops engineer%'
            OR LOWER(sj.title) LIKE '%site reliability engineer%'
            OR LOWER(sj.title) LIKE '%software developer%'
            OR LOWER(sj.title) LIKE '%platform engineer%'
            OR LOWER(sj.title) LIKE '%mobile engineer%'
          );
      `,
    },
    {
      // Migration 048 â€” Re-classify existing job_role_map entries that were assigned
      // role_key='engineering' via automated classifiers but whose title clearly indicates
      // firmware/embedded. Runs in two idempotent steps:
      //
      // Step 1: DELETE stale 'engineering' rows for jobs that already have an
      //   'engineering_embedded_firmware' row â€” these are duplicates from migration 047,
      //   the ingest classifier, or a prior partial run of 048. Updating them would hit
      //   the UNIQUE(job_id, role_key) constraint. Deleting them is safe because the
      //   correct mapping already exists.
      //
      // Step 2: UPDATE remaining 'engineering' firmware-title rows to
      //   'engineering_embedded_firmware'. After Step 1, no conflict is possible.
      //   Both steps are no-ops on a clean or already-processed database.
      id: "048_firmware_reclassify",
      sql: `
        DELETE FROM job_role_map
        WHERE role_key = 'engineering'
          AND matched_by IN ('profile_scrape','orphan_repair','strong_anchor','strong_anchor+desc')
          AND job_id IN (
            SELECT jrm2.job_id FROM job_role_map jrm2
            WHERE jrm2.role_key = 'engineering_embedded_firmware'
          )
          AND job_id IN (
            SELECT sj.job_id FROM scraped_jobs sj
            WHERE LOWER(sj.title) LIKE '%firmware%'
               OR LOWER(sj.title) LIKE '%embedded system%'
               OR LOWER(sj.title) LIKE '% bsp %'
               OR LOWER(sj.title) LIKE 'bsp %'
               OR LOWER(sj.title) LIKE '%bsp engineer%'
               OR LOWER(sj.title) LIKE '% uefi %'
               OR LOWER(sj.title) LIKE '%uefi engineer%'
               OR LOWER(sj.title) LIKE '%device driver%'
               OR LOWER(sj.title) LIKE '%bootloader%'
               OR LOWER(sj.title) LIKE '% rtos %'
               OR LOWER(sj.title) LIKE '%rtos engineer%'
          );

        UPDATE job_role_map
        SET role_key    = 'engineering_embedded_firmware',
            role_family = 'engineering',
            domain      = 'engineering_embedded_firmware',
            confidence  = 0.88,
            matched_by  = 'firmware_reclassify'
        WHERE role_key = 'engineering'
          AND matched_by IN ('profile_scrape','orphan_repair','strong_anchor','strong_anchor+desc')
          AND job_id IN (
            SELECT sj.job_id FROM scraped_jobs sj
            WHERE LOWER(sj.title) LIKE '%firmware%'
               OR LOWER(sj.title) LIKE '%embedded system%'
               OR LOWER(sj.title) LIKE '% bsp %'
               OR LOWER(sj.title) LIKE 'bsp %'
               OR LOWER(sj.title) LIKE '%bsp engineer%'
               OR LOWER(sj.title) LIKE '% uefi %'
               OR LOWER(sj.title) LIKE '%uefi engineer%'
               OR LOWER(sj.title) LIKE '%device driver%'
               OR LOWER(sj.title) LIKE '%bootloader%'
               OR LOWER(sj.title) LIKE '% rtos %'
               OR LOWER(sj.title) LIKE '%rtos engineer%'
          );
      `,
    },
    {
      id: "049_simple_apply_profile_yoe",
      sql: `
        ALTER TABLE simple_apply_profiles ADD COLUMN years_experience INTEGER;
      `,
    },
    {
      id: "050_profile_scoped_resume_signals",
      sql: `
        CREATE TABLE IF NOT EXISTS profile_base_resumes (
          profile_id INTEGER PRIMARY KEY REFERENCES domain_profiles(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT,
          content TEXT NOT NULL,
          enhanced_content TEXT,
          enhanced_at INTEGER,
          enhanced_ats_delta INTEGER,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_profile_base_resumes_user
          ON profile_base_resumes(user_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS profile_simple_apply_profiles (
          profile_id INTEGER PRIMARY KEY REFERENCES domain_profiles(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          titles_json TEXT NOT NULL DEFAULT '[]',
          keywords_json TEXT NOT NULL DEFAULT '[]',
          skills_json TEXT NOT NULL DEFAULT '[]',
          search_terms_json TEXT NOT NULL DEFAULT '[]',
          source_hash TEXT,
          years_experience INTEGER,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_profile_simple_apply_profiles_user
          ON profile_simple_apply_profiles(user_id, updated_at DESC);
      `,
    },
    {
      id: "051_imported_saved_jobs",
      sql: `
        CREATE TABLE IF NOT EXISTS imported_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source_key TEXT NOT NULL,
          source_label TEXT NOT NULL,
          source_platform TEXT NOT NULL,
          external_job_id TEXT,
          dedupe_key TEXT NOT NULL,
          title TEXT NOT NULL,
          company TEXT NOT NULL,
          location TEXT,
          job_url TEXT,
          apply_url TEXT,
          work_type TEXT,
          employment_type TEXT,
          compensation TEXT,
          posted_at TEXT,
          description TEXT,
          company_icon_url TEXT,
          payload_json TEXT,
          visited INTEGER NOT NULL DEFAULT 0,
          starred INTEGER NOT NULL DEFAULT 0,
          disliked INTEGER NOT NULL DEFAULT 0,
          applied INTEGER NOT NULL DEFAULT 0,
          import_count INTEGER NOT NULL DEFAULT 1,
          first_imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, source_key, dedupe_key)
        );
        CREATE INDEX IF NOT EXISTS idx_imported_jobs_user_source
          ON imported_jobs(user_id, source_key, last_imported_at DESC);
        CREATE INDEX IF NOT EXISTS idx_imported_jobs_user_flags
          ON imported_jobs(user_id, disliked, starred, applied);
      `,
    },
    {
      id: "052_profile_enhancement_signals",
      sql: `
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN citizenship_status TEXT;
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN work_authorization TEXT;
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN requires_sponsorship INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN has_clearance INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN clearance_level TEXT;
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN degree_level TEXT;
        ALTER TABLE profile_simple_apply_profiles ADD COLUMN enhancement_notified_at INTEGER;

        CREATE TABLE IF NOT EXISTS profile_signal_suggestions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES domain_profiles(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          signal_key TEXT NOT NULL,
          signal_label TEXT NOT NULL,
          signal_kind TEXT NOT NULL,
          structured_field TEXT,
          frequency INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'inactive',
          first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
          selected_at INTEGER,
          applied_at INTEGER,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(profile_id, signal_key)
        );
        CREATE INDEX IF NOT EXISTS idx_profile_signal_suggestions_profile
          ON profile_signal_suggestions(profile_id, status, signal_kind, frequency DESC);

        CREATE TABLE IF NOT EXISTS profile_resume_enhancements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES domain_profiles(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          base_resume_content TEXT NOT NULL,
          enhanced_content TEXT NOT NULL,
          selected_skills_json TEXT NOT NULL DEFAULT '[]',
          ats_delta INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          adopted_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_profile_resume_enhancements_profile
          ON profile_resume_enhancements(profile_id, created_at DESC);
      `,
    },
    {
      id: "054_aplus_resume_flag",
      sql: `ALTER TABLE users ADD COLUMN aplus_resume INTEGER NOT NULL DEFAULT 0;`,
    },
    {
      id: "055_user_profile_skills",
      sql: `
        ALTER TABLE user_profile ADD COLUMN confirmed_skills TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE user_profile ADD COLUMN target_skills    TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE user_profile ADD COLUMN target_domains   TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE user_profile ADD COLUMN target_locations TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE user_profile ADD COLUMN seniority_level  TEXT;
        ALTER TABLE user_profile ADD COLUMN onboarded        INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      id: "056_company_ats_list",
      sql: `
        CREATE TABLE IF NOT EXISTS company_ats_list (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          company     TEXT NOT NULL,
          ats_type    TEXT NOT NULL,
          ats_slug    TEXT NOT NULL,
          active      INTEGER NOT NULL DEFAULT 1,
          bucket_role TEXT,
          created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(ats_type, ats_slug)
        );
        INSERT OR IGNORE INTO company_ats_list (company, ats_type, ats_slug, bucket_role) VALUES
          ('Stripe',     'greenhouse','stripe',        'software_engineer'),
          ('Airbnb',     'greenhouse','airbnb',        'software_engineer'),
          ('Figma',      'greenhouse','figma',         'software_engineer'),
          ('Notion',     'greenhouse','notionhq',      'software_engineer'),
          ('OpenAI',     'greenhouse','openai',        'software_engineer'),
          ('Anthropic',  'greenhouse','anthropic',     'software_engineer'),
          ('Rippling',   'greenhouse','rippling',      'software_engineer'),
          ('Brex',       'greenhouse','brex',          'software_engineer'),
          ('Duolingo',   'greenhouse','duolingo',      'software_engineer'),
          ('Scale AI',   'greenhouse','scaleai',       'software_engineer'),
          ('Ramp',       'lever',     'ramp',          'software_engineer'),
          ('Mercury',    'lever',     'mercury',       'software_engineer'),
          ('Retool',     'lever',     'retool',        'software_engineer'),
          ('Linear',     'ashby',     'linear',        'software_engineer'),
          ('Vercel',     'ashby',     'vercel',        'software_engineer');
      `,
    },
    {
      id: "057_scraped_jobs_buckets",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN bucket_role      TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN bucket_seniority TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN bucket_domain    TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN direct_apply     INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE scraped_jobs ADD COLUMN source_label     TEXT;
      `,
    },
    {
      id: "058_scraped_jobs_via",
      sql: `ALTER TABLE scraped_jobs ADD COLUMN via TEXT;`,
    },
    {
      // Adds collar + confidence columns to scraped_jobs and the rejected_jobs
      // audit table used by the blue-collar eject gate (Phase 4+).
      // ALTER TABLE ADD COLUMN runs once; idempotency is guaranteed by the
      // schema_migrations tracker (this id is never re-applied).
      // CREATE TABLE/INDEX IF NOT EXISTS are unconditionally idempotent.
      id: "059_jobs_segregation",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN collar TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN classification_confidence REAL;
        CREATE TABLE IF NOT EXISTS rejected_jobs (
          job_id      TEXT    PRIMARY KEY,
          title       TEXT,
          company     TEXT,
          source      TEXT,
          reason      TEXT,
          rejected_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_rejected_at ON rejected_jobs(rejected_at);
      `,
    },
    {
      id: "060_user_profile_extended",
      sql: `
        ALTER TABLE user_profile ADD COLUMN website_url TEXT;
        ALTER TABLE user_profile ADD COLUMN portfolio_url TEXT;
        ALTER TABLE user_profile ADD COLUMN desired_salary INTEGER;
        ALTER TABLE user_profile ADD COLUMN salary_currency TEXT;
        ALTER TABLE user_profile ADD COLUMN available_start_date TEXT;
        ALTER TABLE user_profile ADD COLUMN willing_to_relocate INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE user_profile ADD COLUMN highest_degree TEXT;
        ALTER TABLE user_profile ADD COLUMN field_of_study TEXT;
        ALTER TABLE user_profile ADD COLUMN university TEXT;
        ALTER TABLE user_profile ADD COLUMN graduation_year INTEGER;
        ALTER TABLE user_profile ADD COLUMN current_job_title TEXT;
        ALTER TABLE user_profile ADD COLUMN current_company TEXT;
        ALTER TABLE user_profile ADD COLUMN years_of_experience INTEGER;
        ALTER TABLE user_profile ADD COLUMN custom_answers TEXT NOT NULL DEFAULT '{}';
      `,
    },
    {
      id: "061_scraped_jobs_enrichment",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN normalized_title      TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN summary               TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN experience_level      TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN workplace_type        TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN valid_through         INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN salary_min_usd        INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN salary_max_usd        INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN salary_period         TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN skills_json           TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN is_h1b_sponsor        INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN requires_work_auth    INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN is_clearance_required INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN discovered_at         INTEGER;
        ALTER TABLE scraped_jobs ADD COLUMN updated_at            INTEGER;
      `,
    },
    {
      id: "062_incremental_sync",
      sql: `
        CREATE TABLE IF NOT EXISTS sync_state (
          source         TEXT    PRIMARY KEY,
          cursor         TEXT,
          last_watermark INTEGER,
          updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
        );
        ALTER TABLE scraped_jobs ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
      `,
    },
    {
      id: "063_cross_source_dedup",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN fingerprint   TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN sources_seen  TEXT;
        CREATE INDEX IF NOT EXISTS idx_scraped_jobs_fingerprint ON scraped_jobs(fingerprint);
      `,
    },
    {
      id: "064_job_enrichment",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN content_hash TEXT;
        ALTER TABLE scraped_jobs ADD COLUMN enriched_at  INTEGER;
        CREATE TABLE IF NOT EXISTS company_technographics (
          company        TEXT    NOT NULL,
          skill          TEXT    NOT NULL,
          weight         REAL    NOT NULL DEFAULT 0,
          last_seen      INTEGER NOT NULL,
          posting_count  INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (company, skill)
        );
      `,
    },
    {
      id: "065_req_uid_fingerprint_hardening",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN req_uid TEXT;
        CREATE INDEX IF NOT EXISTS idx_scraped_jobs_req_uid ON scraped_jobs(req_uid);
      `,
    },
    {
      id: "066_company_org_units",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN org_unit_raw TEXT;
        CREATE TABLE IF NOT EXISTS company_org_units (
          company               TEXT    NOT NULL,
          org_unit              TEXT    NOT NULL,
          domain                TEXT,
          stacks_json           TEXT,
          seniority_json        TEXT,
          confidence            REAL    NOT NULL DEFAULT 0,
          corroboration_count   INTEGER NOT NULL DEFAULT 0,
          status                TEXT    NOT NULL DEFAULT 'proposed',
          first_seen            INTEGER NOT NULL,
          last_seen             INTEGER NOT NULL,
          source_postings_json  TEXT,
          PRIMARY KEY (company, org_unit)
        );
        CREATE INDEX IF NOT EXISTS idx_company_org_units_status ON company_org_units(company, status);
      `,
    },
    {
      id: "067_company_hiring_signals",
      sql: `
        CREATE TABLE IF NOT EXISTS company_hiring_signals (
          company               TEXT    NOT NULL,
          window_start          INTEGER NOT NULL,
          window_end            INTEGER NOT NULL,
          open_count            INTEGER NOT NULL DEFAULT 0,
          new_count             INTEGER NOT NULL DEFAULT 0,
          expired_count         INTEGER NOT NULL DEFAULT 0,
          domain_breakdown_json TEXT,
          growth_score          REAL,
          updated_at            INTEGER NOT NULL,
          PRIMARY KEY (company, window_end)
        );
        CREATE INDEX IF NOT EXISTS idx_company_hiring_signals_company ON company_hiring_signals(company);
      `,
    },
    {
      id: "068_profile_tracked_search",
      sql: `
        ALTER TABLE domain_profiles ADD COLUMN tracked_search_json TEXT;
      `,
    },
    {
      id: "069_pipeline_runs",
      sql: `
        CREATE TABLE IF NOT EXISTS pipeline_runs (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          run_kind     TEXT    NOT NULL,
          source       TEXT,
          status       TEXT    NOT NULL,
          started_at   INTEGER NOT NULL,
          finished_at  INTEGER,
          duration_ms  INTEGER,
          fetched      INTEGER NOT NULL DEFAULT 0,
          written      INTEGER NOT NULL DEFAULT 0,
          unchanged    INTEGER NOT NULL DEFAULT 0,
          merged       INTEGER NOT NULL DEFAULT 0,
          dropped      INTEGER NOT NULL DEFAULT 0,
          ejected      INTEGER NOT NULL DEFAULT 0,
          failed       INTEGER NOT NULL DEFAULT 0,
          skipped      INTEGER NOT NULL DEFAULT 0,
          expired      INTEGER NOT NULL DEFAULT 0,
          error_text   TEXT,
          details_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_kind_source ON pipeline_runs(run_kind, source, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started ON pipeline_runs(started_at DESC);
      `,
    },
    {
      // Four of the seeded ATS rows in 056 were wrong. Every company below was re-probed
      // against the live provider APIs before changing anything — no slug is guessed.
      //
      //   Notion    greenhouse/notionhq -> ashby/notion       (gh 404s; ashby returns 128)
      //   OpenAI    greenhouse/openai   -> ashby/openai       (gh 404s; ashby returns 732)
      //   Vercel    ashby/vercel        -> greenhouse/vercel  (ashby board is EMPTY, gh has 83)
      //   Rippling  greenhouse/rippling -> DEACTIVATED        (404 on greenhouse, ashby AND
      //                                                        lever; no board found)
      //
      // Identities confirmed from board content, not just a 200: OpenAI's departments include
      // Research/Safety Systems/Applied AI, and Vercel's postings resolve to
      // job-boards.greenhouse.io/vercel.
      //
      // Vercel is the subtlest of the four: ashby/vercel returns HTTP 200 with zero jobs, so it
      // never raised an error and never even logged the per-company warning a 404 produces — it
      // just silently contributed nothing to the board.
      //
      // Rippling is deactivated rather than deleted or guessed. active=0 is honoured by
      // cacheJobs (`WHERE active = 1`), so it stops costing a failed request every crawl while
      // the row survives as a record to reactivate once someone finds the real board. Guessing
      // a slug is exactly the failure this codebase already learned from twice.
      //
      // Corrected forward rather than by editing 056, which has already run everywhere. Each
      // guard is narrow enough to be idempotent and to not clobber a hand-fixed row.
      id: "070_fix_dead_ats_slugs",
      sql: `
        UPDATE company_ats_list
           SET ats_type = 'ashby', ats_slug = 'openai'
         WHERE company = 'OpenAI' AND ats_type = 'greenhouse';

        UPDATE company_ats_list
           SET ats_type = 'ashby', ats_slug = 'notion'
         WHERE company = 'Notion' AND ats_type = 'greenhouse';

        UPDATE company_ats_list
           SET ats_type = 'greenhouse', ats_slug = 'vercel'
         WHERE company = 'Vercel' AND ats_type = 'ashby';

        UPDATE company_ats_list
           SET active = 0
         WHERE company = 'Rippling' AND ats_type = 'greenhouse' AND ats_slug = 'rippling';
      `,
    },
    {
      // Cleanup 5.9. refresh_log had zero writers, zero readers and zero rows — grep-verified
      // across the repo, its only mention anywhere was its own CREATE TABLE in the bootstrap
      // schema, which this release also removes. Dropping it here clears it from databases that
      // already created it. Safe: no data is lost because none was ever written.
      //
      // NOT dropped, deliberately: scrape_events. Its writer (usageTracker.trackScrape) is gone
      // in the same release, but routes/admin.js still READS it in four analytics queries, so
      // dropping it would break the admin dashboard. Those panels now report a permanent zero,
      // which is accurate rather than broken. See docs/PIPELINE_DIAGNOSIS.md §5.12.
      id: "071_drop_refresh_log",
      sql: `
        DROP TABLE IF EXISTS refresh_log;
      `,
    },
    {
      id: "072_apply_submit_guards",
      sql: `
        CREATE TABLE IF NOT EXISTS app_settings (
          key        TEXT PRIMARY KEY,
          value      TEXT,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS apply_idempotency (
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          idem_key      TEXT    NOT NULL,
          endpoint      TEXT    NOT NULL,
          status_code   INTEGER NOT NULL DEFAULT 200,
          response_json TEXT    NOT NULL,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (user_id, idem_key)
        );
        ALTER TABLE apply_run_jobs ADD COLUMN answers_json TEXT;
        ALTER TABLE apply_run_jobs ADD COLUMN resume_artifact_id INTEGER;
        ALTER TABLE apply_run_jobs ADD COLUMN resume_ats_score INTEGER;
        ALTER TABLE apply_run_jobs ADD COLUMN screenshot_path TEXT;
        ALTER TABLE apply_run_jobs ADD COLUMN submit_verified INTEGER;
        ALTER TABLE apply_run_jobs ADD COLUMN submit_evidence TEXT;
      `,
    },
    {
      id: "073_apply_open_questions",
      sql: `
        ALTER TABLE apply_run_jobs ADD COLUMN open_questions_json TEXT;
      `,
    },
    {
      // Queue-then-approve. approval_mode is left NULL on existing rows deliberately: those runs
      // predate the flow and were never approved by anyone, so backfilling them to 'required' would
      // put a claim in the audit trail that is not true. NULL reads as "predates approval".
      //   'required' — the run previews only and parks each job for a human decision
      //   'auto'     — full-auto, submitted without approval (now opt-in)
      //   'approved' — this run exists BECAUSE a human approved; it submits
      // approved_from_run_job_id points at the preview row whose answers were approved, which is what
      // lets the submitting run refuse if the form has changed since.
      id: "074_apply_approval_flow",
      sql: `
        ALTER TABLE apply_runs     ADD COLUMN approval_mode TEXT;
        ALTER TABLE apply_run_jobs ADD COLUMN approved_at INTEGER;
        ALTER TABLE apply_run_jobs ADD COLUMN approved_from_run_job_id INTEGER;
      `,
    },
    {
      // Cost observability. `purpose` names the FEATURE a model call served, separately from
      // event_type — which stays exactly as it is because services/limitEnforcer.js enforces
      // per-user quotas with `WHERE event_type = ?`, so repurposing that column would silently
      // change what counts against a limit.
      //
      // Additive and nullable on purpose: every row written before this migration was recorded by
      // a call site that had no notion of purpose, and inventing one for them would put a claim in
      // the cost history that nothing verified. NULL reads as "recorded before purpose existed" —
      // routes/admin.js groups it as 'unattributed' rather than dropping it.
      //
      // The 'system' user (id 0) is what background work — enrichment, import extraction, job
      // classification, the unauthenticated standalone endpoints — is attributed to.
      // usage_events.user_id is NOT NULL REFERENCES users(id), and better-sqlite3 turns
      // foreign_keys ON by default, so a bare sentinel id with no row is REJECTED: verified by a
      // real run, where every background insert failed with "FOREIGN KEY constraint failed" and
      // the largest untracked spender stayed untracked.
      // id 0 can never collide with a real account (users.id is AUTOINCREMENT, so it starts at 1)
      // and the password hash is a literal that no hash function can produce, so it is not a
      // login. INSERT OR IGNORE keeps this migration safe to re-run.
      id: "075_usage_events_purpose",
      sql: `
        ALTER TABLE usage_events ADD COLUMN purpose TEXT;
        CREATE INDEX IF NOT EXISTS idx_usage_events_purpose
          ON usage_events(purpose, created_at);
        INSERT OR IGNORE INTO users (id, username, password_hash, is_admin)
          VALUES (0, 'system', '!unusable', 0);
      `,
    },
  ];
