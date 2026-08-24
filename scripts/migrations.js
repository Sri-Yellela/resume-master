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
    {
      // Persisted tracking failures. The in-process counters added with 075 reset on restart, so
      // a failure that happened and was then followed by a deploy left no trace at all: the cost
      // panel would report healthy coverage for a gap that really occurred.
      //
      // user_id carries NO foreign key, deliberately. The first real run of the wrapper failed
      // with "FOREIGN KEY constraint failed" on usage_events.user_id — an FK violation is one of
      // the reasons a usage insert fails, so putting an FK here would make the failure record
      // itself fail for exactly the cases most worth recording. Every column except created_at is
      // nullable for the same reason: a partial record beats no record.
      //
      // This still cannot capture a database that is entirely unreachable — that case degrades to
      // the in-process counter and the error log, and routes/admin.js says so rather than
      // implying the persisted count is complete.
      id: "076_usage_tracking_failures",
      sql: `
        CREATE TABLE IF NOT EXISTS usage_tracking_failures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model TEXT,
          purpose TEXT,
          user_id INTEGER,
          error_text TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_usage_tracking_failures_created
          ON usage_tracking_failures(created_at);
      `,
    },
    {
      // Distinguishes a failure recorded LIVE from one recovered out of the out-of-process sink
      // (services/trackingFailureSink.js) after the database came back. Conflating them would hide
      // the more serious fact: a sink-recovered row means the database itself was unreachable at
      // the time, not merely that one insert was rejected.
      //
      // Nullable: rows written by 076 predate the distinction, and NULL reads as "recorded live,
      // before this column existed" rather than being backfilled with a claim nothing verified.
      id: "077_tracking_failure_source",
      sql: `
        ALTER TABLE usage_tracking_failures ADD COLUMN source TEXT;
      `,
    },
    {
      // Automation tier — what the candidate will face at the apply destination, decided at
      // browse time. services/jobs/automationTier.js owns the mapping; this column stores its
      // output so services/jobs/jobQuery.js can filter on it in SQL. Deriving it at read time
      // instead would force that mapping to be re-expressed as a CASE expression here, and a
      // second copy of a mapping is exactly what left model ids half-migrated across the
      // codebase.
      //
      // NULLABLE, AND NOT BACKFILLED BY THIS MIGRATION — deliberately. The backfill needs
      // deriveAutomationTier(), which is JavaScript; writing it as a SQL CASE would create the
      // duplicate this column exists to avoid. Existing rows are populated instead by the
      // boot-time backfill immediately below this runner and by
      // scripts/recomputeAutomationTier.js, both of which call that one function.
      //
      // So NULL is a state the board must survive: it means "written before this column
      // existed and not yet recomputed", which is indistinguishable from 'unknown' as far as
      // any promise to the user goes. jobQuery.js's tiers_include/tiers_exclude therefore
      // COALESCE it to 'unknown' rather than letting `NULL IN (...)` (which is NULL, not
      // false) silently drop the row from BOTH directions of the filter.
      id: "078_scraped_jobs_automation_tier",
      sql: `
        ALTER TABLE scraped_jobs ADD COLUMN automation_tier TEXT;
        CREATE INDEX IF NOT EXISTS idx_scraped_jobs_automation_tier
          ON scraped_jobs(automation_tier, is_active);
      `,
    },
    {
      // The prepared packet for a gated portal (docs/GATED_HANDOFF_ARCHITECTURE.md §3 step 3). A run
      // that hits a login wall or a CAPTCHA cannot finish on the server, so everything already
      // decided is parked here for the human who will cross that gate, and handed to the extension
      // in exchange for a single-use token.
      //
      // expected_origin is stored SEPARATELY from apply_url rather than derived at read time. It is
      // the value the extension target-matches before releasing anything, and this packet carries a
      // home address and work-authorization answers — so the thing being compared has to be a stored
      // fact, decided once when the run observed the gate, not a re-parse of a URL that may have been
      // rewritten since.
      //
      // token_hash, not the token: a database read must not yield a usable credential. The token
      // exists only in the response that mints it. consumed_at is what makes it single-use, and it is
      // set in the same statement that claims the packet, so two concurrent exchanges cannot both win.
      //
      // exchange_attempts counts every attempt including rejected ones, so a packet being probed is
      // visible on the row itself and not only in the log.
      id: "079_apply_gate_packets",
      sql: `
        CREATE TABLE IF NOT EXISTS apply_gate_packets (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          run_id             INTEGER,
          run_job_id         INTEGER REFERENCES apply_run_jobs(id) ON DELETE CASCADE,
          job_id             TEXT    NOT NULL,
          apply_url          TEXT    NOT NULL,
          expected_origin    TEXT    NOT NULL,
          gate_reason        TEXT    NOT NULL,
          answers_json       TEXT    NOT NULL,
          resume_artifact_id INTEGER,
          token_hash         TEXT    NOT NULL UNIQUE,
          expires_at         INTEGER NOT NULL,
          consumed_at        INTEGER,
          exchange_attempts  INTEGER NOT NULL DEFAULT 0,
          created_at         INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_gate_packets_user_job
          ON apply_gate_packets(user_id, job_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_gate_packets_origin
          ON apply_gate_packets(user_id, expected_origin, consumed_at);
      `,
    },
    {
      // What a human actually saw before an application went out (TASK G3, §4's review-as-provenance).
      // The audit trail already records what was ANSWERED and with what provenance; this records what
      // was REVIEWED — which fields the candidate approved as-is, which they corrected, and which
      // low-confidence guesses they had to acknowledge before the overlay would call itself ready.
      //
      // Separate from answers_json rather than merged into it: those are two different claims made at
      // two different times by two different parties, and collapsing them would make it impossible to
      // say afterwards whether a value was the resolver's or the candidate's. For a gated application
      // this is the ONLY record of human review, because the submission itself happens in a browser we
      // never see.
      //
      // Nullable, not backfilled: a NULL means the application predates the overlay or was never
      // reviewed through it, which is not the same as "reviewed and nothing changed".
      id: "080_apply_gate_review",
      sql: `
        ALTER TABLE apply_run_jobs ADD COLUMN gate_review_json TEXT;
      `,
    },
    {
      // A company's application form, as a KB fact (TASK G4). Behind a gate is a place the server
      // can never reach, but the extension is standing inside it — so the form's STRUCTURE comes
      // back and the next candidate's packet arrives pre-mapped. It is the mechanism that replaces
      // hand-writing platformDetector's PLATFORM_LABEL_MAPS one ATS at a time.
      //
      // KEYED BY APPLY HOST, not by job. One careers page serves every posting behind it, so a
      // schema captured once from any of them serves all the others — which is the only reason this
      // compounds rather than being a per-application cache.
      //
      // STRUCTURE ONLY. fields_json holds labels, types, required flags, option lists and order.
      // Never a value, never anything about the candidate. discoverFields returns current_value and
      // this store must never receive it, which is enforced by a whitelist in formSchemaLayer.js and
      // asserted by test rather than promised by a comment.
      //
      // shape_hash is what makes a CHANGED form observable. Forms change; a stale schema that is
      // trusted is worse than no schema, so a differing hash is treated as a new claim about the
      // form — corroboration resets and a confirmed schema drops back to proposed. That last part
      // deliberately DIVERGES from company_org_units, which never demotes: an org unit that stops
      // appearing may simply not be hiring, whereas a form that comes back different is positive
      // evidence the stored one is now wrong.
      //
      // `source` distinguishes a capture made by a candidate standing behind a gate from one our own
      // crawl of a public careers page produced. Both write the same shape on purpose — this is the
      // store imported-careers-page support needs too, and a gated-only variant would have to be
      // merged into it later.
      //
      // users.form_schema_capture is the consent switch, DEFAULT 0. Capture reports on a page behind
      // that candidate's own authenticated session, and opt-in is the only answer to "what does it
      // send from behind my login?" that does not rest on trusting our filter.
      id: "081_company_form_schemas",
      sql: `
        CREATE TABLE IF NOT EXISTS company_form_schemas (
          apply_host           TEXT    NOT NULL PRIMARY KEY,
          company              TEXT,
          platform             TEXT,
          fields_json          TEXT    NOT NULL,
          field_count          INTEGER NOT NULL DEFAULT 0,
          unmapped_json        TEXT,
          unmapped_count       INTEGER NOT NULL DEFAULT 0,
          shape_hash           TEXT    NOT NULL,
          confidence           REAL    NOT NULL DEFAULT 0,
          corroboration_count  INTEGER NOT NULL DEFAULT 0,
          status               TEXT    NOT NULL DEFAULT 'proposed',
          source               TEXT    NOT NULL,
          first_seen           INTEGER NOT NULL,
          last_seen            INTEGER NOT NULL,
          changed_at           INTEGER,
          previous_shape_hash  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_company_form_schemas_company
          ON company_form_schemas(company, status);
        ALTER TABLE users ADD COLUMN form_schema_capture INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      // H-1B sponsorship as a COMPANY fact, from DOL/OFLC LCA disclosure data (TASK X3).
      //
      // WHY THIS IS NOT ON scraped_jobs. The posting-level is_h1b_sponsor experiment is over and it
      // failed on the evidence: of 1,261 postings, 0 mention "H-1B", 36 mention sponsorship at all,
      // and the LLM backfill produced 3 non-null values, all false. The signal is not in the source
      // material. Every H-1B-sponsoring employer, by contrast, MUST file a Labor Condition
      // Application, and those filings are public and quarterly. So this is a fact the company emits
      // about itself, and it belongs beside company_technographics and company_org_units.
      //
      // is_h1b_sponsor SURVIVES UNCHANGED and is not populated from here. Two different claims:
      // "this employer filed 47 petitions last quarter" is not "this role sponsors". Nothing in this
      // migration touches scraped_jobs, by design and by test
      // (test/lcaPostingFlagUntouched.test.js).
      //
      // THREE TABLES, because they answer to three different owners:
      //
      //   lca_source_files     — the import ledger. One row per quarterly file, so a re-import
      //                          RECONCILES (delete-then-insert that period) instead of doubling
      //                          the counts, same discipline as the job pipeline's req_uid.
      //   lca_employer_periods — LCA employers as filed, one row per (employer, FEIN, quarter).
      //                          Keeping the whole employer universe rather than only the companies
      //                          we happen to know today is what lets a company added tomorrow be
      //                          matched without re-downloading ~2 GB of spreadsheets.
      //   company_lca_sponsorship — the derived KB fact for one of OUR company strings, carrying
      //                          the match tier and confidence, provenance and last_seen like every
      //                          other KB store.
      //
      // fein is NOT NULL with a '' sentinel rather than nullable: it is in a PRIMARY KEY, and SQLite
      // permits NULLs in a non-INTEGER primary key, which would silently stop de-duplicating the
      // rows this table exists to de-duplicate.
      //
      // match_status is the integrity mechanism, not decoration. 'ambiguous' means two or more
      // distinct FEINs answer to the same brand name (measured: 2.3% of reachable brands — Mercury
      // Insurance vs Mercury Technologies, and Mercury Insurance also files for "Senior Software
      // Engineer", so no title heuristic can separate them). An 'ambiguous' row renders NOTHING —
      // not a zero, not "no data" — because a wrong sponsor claim is worse than a missing one.
      //
      // periods_covered vs periods_with_filings is how staleness stays honest. Quora filed 1
      // certified LCA in FY2025 Q4 and 0 in FY2026 Q1; a single-quarter snapshot cannot tell "does
      // not sponsor" from "did not file last quarter", so the store records how many quarters were
      // SEARCHED alongside how many had filings, and latest_period carries the recency the UI
      // decays against.
      id: "082_company_lca_sponsorship",
      sql: `
        CREATE TABLE IF NOT EXISTS lca_source_files (
          file_name       TEXT    NOT NULL PRIMARY KEY,
          fiscal_period   TEXT    NOT NULL,
          fiscal_year     INTEGER NOT NULL,
          fiscal_quarter  INTEGER NOT NULL,
          period_start    INTEGER,
          period_end      INTEGER,
          sheet_rows      INTEGER NOT NULL DEFAULT 0,
          case_rows       INTEGER NOT NULL DEFAULT 0,
          employer_rows   INTEGER NOT NULL DEFAULT 0,
          byte_size       INTEGER,
          source_url      TEXT,
          ingested_at     INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lca_employer_periods (
          employer_key    TEXT    NOT NULL,
          fein            TEXT    NOT NULL,
          fiscal_period   TEXT    NOT NULL,
          employer_name   TEXT    NOT NULL,
          dba_keys_json   TEXT,
          state           TEXT,
          certified       INTEGER NOT NULL DEFAULT 0,
          denied          INTEGER NOT NULL DEFAULT 0,
          withdrawn       INTEGER NOT NULL DEFAULT 0,
          positions       INTEGER NOT NULL DEFAULT 0,
          top_titles_json TEXT,
          last_decision   INTEGER,
          PRIMARY KEY (employer_key, fein, fiscal_period)
        );
        CREATE INDEX IF NOT EXISTS idx_lca_employer_periods_key
          ON lca_employer_periods(employer_key);
        CREATE INDEX IF NOT EXISTS idx_lca_employer_periods_period
          ON lca_employer_periods(fiscal_period);
        CREATE TABLE IF NOT EXISTS company_lca_sponsorship (
          company              TEXT    NOT NULL PRIMARY KEY,
          match_status         TEXT    NOT NULL,
          match_tier           TEXT,
          match_confidence     REAL    NOT NULL DEFAULT 0,
          match_key            TEXT,
          match_reason         TEXT,
          matched_entities_json TEXT,
          candidate_count      INTEGER NOT NULL DEFAULT 0,
          certified_total      INTEGER NOT NULL DEFAULT 0,
          denied_total         INTEGER NOT NULL DEFAULT 0,
          positions_total      INTEGER NOT NULL DEFAULT 0,
          by_period_json       TEXT,
          by_fiscal_year_json  TEXT,
          top_titles_json      TEXT,
          latest_period        TEXT,
          latest_filing_at     INTEGER,
          periods_covered      INTEGER NOT NULL DEFAULT 0,
          periods_with_filings INTEGER NOT NULL DEFAULT 0,
          source               TEXT    NOT NULL DEFAULT 'dol_oflc_lca',
          provenance_json      TEXT,
          first_seen           INTEGER NOT NULL,
          last_seen            INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_company_lca_sponsorship_status
          ON company_lca_sponsorship(match_status, certified_total);
      `,
    },
    {
      // The OFLC record layout CHANGED, and the corpus has to be able to say where (TASK X3).
      //
      // EMPLOYER_FEIN does not exist in the FY2021, FY2022 or FY2023 disclosure files. Those sheets
      // are 96 columns with no employer tax ID anywhere in them; FY2024 Q1 onward is 98 columns with
      // it. That matters because FEIN is what services/kb/lcaMatch.js counts to decide whether a
      // brand-prefix (tier C) match is unambiguous — and counting FEINs over a file that has none
      // returns zero, which would have read as "one employer" and switched the ambiguity guard OFF
      // for twelve of the twenty-one available quarters. countDistinctEntities() falls back to
      // counting distinct legal names instead, which is strictly more cautious.
      //
      // Stored rather than derived. It IS derivable ("do all this period's rows have fein = ''?"),
      // but a derived answer cannot distinguish a file that had no FEIN column from a file whose
      // FEIN column happened to be empty, and the second would be a parser bug we would want to see
      // rather than absorb. One column in the import ledger, written from the header row itself.
      //
      // Nullable with no default: rows written before this migration predate the check and must not
      // claim either answer. Re-running the ingester for those periods fills them in.
      id: "083_lca_source_fein_presence",
      sql: `
        ALTER TABLE lca_source_files ADD COLUMN has_employer_fein INTEGER;
      `,
    },
    {
      // OFLC CHANGED WHAT A QUARTERLY FILE MEANS, and the corpus has to survive both conventions
      // (TASK X3). Measured from the decision dates in the files themselves:
      //
      //   FY2021 Q1   2020-10-01 → 2020-12-31     one quarter
      //   FY2021 Q2   2020-10-01 → 2021-03-31     TWO quarters — contains Q1
      //   FY2021 Q3   2020-10-01 → 2021-06-30     THREE quarters — contains Q2
      //   FY2025 Q1   2024-10-01 → 2024-12-31     one quarter
      //   FY2025 Q2   2025-01-01 → 2025-03-31     one quarter — disjoint from Q1
      //
      // The old files are FISCAL-YEAR CUMULATIVE; the new ones are per-quarter. Migration 082's
      // ingester summed across periods on the strength of the FY2025/FY2026 evidence, which is
      // correct there and TRIPLE-COUNTS FY2021 Q1. Nothing about the filename says which convention
      // a file follows, so the ingester now derives each file's true window from its own decision
      // dates and drops any period whose window is contained in another's.
      //
      // quarters_covered is that window expressed in quarters, and it is stored because two things
      // need it and neither can recompute it: periods_covered ("how long did we look?") must count
      // QUARTERS rather than files, or a four-year corpus reports as nine; and the per-period chips
      // must not label a full fiscal year "FY2021 Q4", which would claim a year's filings happened
      // in one quarter.
      //
      // Nullable: rows written before this migration have not had their window measured, and
      // guessing 1 would silently reassert the bug this exists to fix.
      id: "084_lca_period_span",
      sql: `
        ALTER TABLE lca_source_files ADD COLUMN quarters_covered INTEGER;
      `,
    },
    {
      // TASK AC4: a USER-SIDE DELETE that is a soft hide, and the index the dated history reads on.
      //
      // WHY SOFT, AND WHY FOR EVERYTHING. The requirement asks for the decision to be made and
      // stated. A submitted application is evidence that reached a real employer; that record is
      // exactly what the candidate needs when an interview lands three weeks later, and a hard
      // delete would destroy it on a click made while tidying up. So submitted rows are never
      // hard-deleted — and rather than two code paths, NOTHING is: `hidden_at` is set on any row
      // the user removes, and every user-facing feed filters it out. Three things fall out of that
      // which a DELETE would have cost:
      //
      //   - apply_job_logs.run_job_id and apply_gate_packets.run_job_id both cascade on DELETE, so
      //     hard-deleting one run-job would silently take its whole audit trail and its prepared
      //     handoff with it.
      //   - apply_runs.submitted_count / held_count / failed_count are stored counters, not
      //     derived. Removing a row would leave the run claiming work that no longer exists.
      //   - It is reversible. `UPDATE apply_run_jobs SET hidden_at=NULL` restores anything an
      //     operator is asked to restore; a DELETE is a support ticket that cannot be answered.
      //
      // Nullable with no default and no backfill: NULL means visible, which is what every existing
      // row is. A row written before this migration cannot have been hidden.
      //
      // The index is what makes the dated view a lookup rather than a scan. AC4 requirement 5 says
      // the history must be date-scoped AND user-scoped on the SERVER — "do not fetch all history
      // and filter client-side" — and (user_id, created_at) is the exact shape of that query. The
      // existing idx_apply_run_jobs_user_status leads with status, so it cannot serve a date range.
      id: "085_apply_run_jobs_hidden",
      sql: `
        ALTER TABLE apply_run_jobs ADD COLUMN hidden_at INTEGER;
        CREATE INDEX IF NOT EXISTS idx_apply_run_jobs_user_created
          ON apply_run_jobs(user_id, created_at);
      `,
    },
    {
      // The sponsorship SITUATION, replacing a stored ANSWER. `requires_sponsorship` is one
      // boolean, and the standard Greenhouse question is "do you NOW OR IN THE FUTURE require
      // sponsorship" — two tenses that disagree for anyone on a time-limited status. An F-1 STEM
      // OPT candidate needs no sponsorship today and will need H-1B when OPT expires, so the
      // boolean answered the future-tense question "No": a false material attestation, submitted
      // at confidence 1.0. See docs/auto-apply-a5-live-run.md §4.1.
      //
      // NULLABLE ON PURPOSE, with no default. 'none' is not a safe default — it is precisely the
      // wrong guess for the population this exists to protect — and resolveSponsorshipNeed refuses
      // (holding the run for a human) rather than inventing a situation it cannot derive. The
      // legacy boolean is left in place: it still answers the present tense, and it is what the
      // derivation falls back to.
      id: "086_user_profile_sponsorship_need",
      sql: `
        ALTER TABLE user_profile ADD COLUMN sponsorship_need TEXT;
      `,
    },
    {
      // Per-company overrides for a `{company}`-templated custom answer (AF1).
      //
      // A separate column rather than a reserved key inside custom_answers, because buildAnswers
      // iterates that map's values and stringifies them: a nested object there would be typed into
      // a real employer's form as "[object Object]". Shape is {companyKey: {question: answer}}.
      id: "087_user_profile_answer_overrides",
      sql: `
        ALTER TABLE user_profile ADD COLUMN custom_answer_overrides TEXT NOT NULL DEFAULT '{}';
      `,
    },
  ];
