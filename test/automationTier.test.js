import test from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import {
  deriveAutomationTier, isAutomatable, uncoveredDirectAtsSources, AUTOMATION_TIERS,
} from "../services/jobs/automationTier.js";
import { backfillAutomationTier } from "../services/jobs/backfillAutomationTier.js";
import { mapJobRow } from "../services/jobs/mapJobRow.js";

// ── The mapping ────────────────────────────────────────────────────────────────

test("the three single-page ATSes classify as direct", () => {
  assert.equal(deriveAutomationTier("greenhouse", "https://boards.greenhouse.io/figma/jobs/6037719004"), "direct");
  assert.equal(deriveAutomationTier("lever",      "https://jobs.lever.co/acme/abc123"), "direct");
  assert.equal(deriveAutomationTier("jobo",       "https://jobs.ashbyhq.com/epianeuro/15fc/application"), "direct");
});

test("a workday tenant classifies as account, not direct", () => {
  // The tier has to agree with what classifyFlowState reports at runtime: workday holds on
  // 'login_required', so calling it direct would be a promise the run cannot keep.
  assert.equal(deriveAutomationTier("workday", "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/123"), "account");
  assert.equal(deriveAutomationTier("icims",   "https://careers-acme.icims.com/jobs/4567/login"), "account");
  assert.equal(deriveAutomationTier("taleo",   "https://acme.taleo.net/careersection/jobdetail.ftl"), "account");
});

test("workday is a DIRECT_ATS_SOURCE and is still `account`", () => {
  // directApplyFilter's set means "the company's own ATS", used for dedup priority. That is not
  // the same claim as "no login", and conflating them is how a tier would end up lying.
  assert.equal(deriveAutomationTier("workday", "https://acme.wd1.myworkdayjobs.com/x"), "account");
  assert.equal(isAutomatable("account"), false);
});

test("aggregator middlemen classify as gated and are not automatable", () => {
  assert.equal(deriveAutomationTier("linkedin", "https://www.linkedin.com/jobs/view/12345"), "gated");
  assert.equal(deriveAutomationTier("adzuna",   "https://www.indeed.com/rc/clk?jk=abc"), "gated");
  assert.equal(deriveAutomationTier("adzuna",   "https://www.glassdoor.com/job-listing/x"), "gated");
  assert.equal(isAutomatable("gated"), false);
});

test("an unrecognised careers page is unknown, never direct", () => {
  assert.equal(deriveAutomationTier("adzuna", "https://careers.example.com/openings/42"), "unknown");
  assert.equal(deriveAutomationTier("serpapi", "https://example.com/jobs"), "unknown");
  assert.equal(isAutomatable("unknown"), false);
});

test("no apply destination at all is unknown, in both argument shapes", () => {
  assert.equal(deriveAutomationTier("greenhouse", null), "unknown");
  assert.equal(deriveAutomationTier("greenhouse", ""), "unknown");
  assert.equal(deriveAutomationTier("greenhouse", "   "), "unknown");
  assert.equal(deriveAutomationTier(null, null), "unknown");
});

test("source decides when the URL is company-hosted and carries no provider hostname", () => {
  // Production's real greenhouse shape: stripe.com/jobs/search?gh_jid=… has no greenhouse.io in it.
  assert.equal(deriveAutomationTier("greenhouse", "https://stripe.com/jobs/search?gh_jid=8077887"), "direct");
});

test("the URL wins over the source when they disagree, because the URL is where the user lands", () => {
  assert.equal(deriveAutomationTier("greenhouse", "https://acme.wd1.myworkdayjobs.com/x"), "account");
  assert.equal(deriveAutomationTier("jobo", "https://jobs.ashbyhq.com/x/y/application"), "direct");
});

test("every tier it can return is in the declared vocabulary", () => {
  const cases = [
    ["greenhouse", "https://boards.greenhouse.io/x"], ["workable", "https://apply.workable.com/x"],
    ["workday", "https://x.myworkdayjobs.com/y"], ["linkedin", "https://linkedin.com/jobs/view/1"],
    ["adzuna", "https://example.com"], [null, null],
  ];
  for (const [s, u] of cases) assert.ok(AUTOMATION_TIERS.includes(deriveAutomationTier(s, u)));
});

test("every trusted direct-ATS source has a tier — onboarding one without a tier is caught here", () => {
  assert.deepEqual(uncoveredDirectAtsSources(), [],
    "a source in directApplyFilter.js's DIRECT_ATS_SOURCES has no PLATFORM_TIER entry, so it " +
    "would silently classify as `unknown` despite being a provider we do have a mapping for");
});

// ── mapJobRow exposes it (the whitelist is the binding constraint) ─────────────

test("the column is projectable, so mapJobRow can actually receive it", async () => {
  // ALLOWED_FIELDS is a whitelist, and it is the binding constraint: a caller using
  // include_fields would otherwise never get the column no matter what mapJobRow exposes.
  const { ALLOWED_FIELDS } = await import("../services/jobs/jobQuery.js");
  assert.ok(ALLOWED_FIELDS.has("automation_tier"));
});

test("mapJobRow exposes automationTier, and null stays null", () => {
  assert.equal(mapJobRow({ job_id: "a", automation_tier: "account" }).automationTier, "account");
  assert.equal(mapJobRow({ job_id: "a" }).automationTier, null);
  // A row that predates 078 must not be mapped to a promise.
  assert.notEqual(mapJobRow({ job_id: "a", automation_tier: null }).automationTier, "direct");
});

// ── The write path (the shared writer for cacheJobs / cacheJoboFeed / importJob) ──────────────

test("the shared canonical write populates automation_tier, and a re-crawl re-derives it", async () => {
  const { upsertCanonicalJob, reconcileFingerprint } = await import("../services/jobs/aggregator.js");
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, search_query TEXT, _hash TEXT, title TEXT, company TEXT,
      location TEXT, url TEXT, source TEXT, source_label TEXT, posted_at TEXT, scraped_at INTEGER,
      bucket_role TEXT, bucket_seniority TEXT, bucket_domain TEXT, direct_apply INTEGER,
      description TEXT, company_icon_url TEXT, via TEXT, collar TEXT,
      classification_confidence REAL, normalized_title TEXT, summary TEXT, experience_level TEXT,
      workplace_type TEXT, valid_through INTEGER, salary_min_usd INTEGER, salary_max_usd INTEGER,
      salary_period TEXT, salary_min INTEGER, salary_max INTEGER, salary_currency TEXT,
      skills_json TEXT, is_h1b_sponsor INTEGER, requires_work_auth INTEGER,
      is_clearance_required INTEGER, discovered_at INTEGER, updated_at INTEGER,
      is_active INTEGER DEFAULT 1, fingerprint TEXT, sources_seen TEXT, req_uid TEXT,
      automation_tier TEXT,
      -- Source-owned column now written by aggregator's upsertStmt (six sources parse an
      -- employment type; none of it was persisted before). Hand-rolled fixtures have to track the
      -- real schema or the upsert fails against them — the same way automation_tier surfaced.
      employment_type TEXT
    );
    -- source_profile_id: upsertCanonicalJob retires superseded classifier buckets by this column.
    CREATE TABLE job_role_map (job_id TEXT PRIMARY KEY, role_key TEXT, role_family TEXT, domain TEXT, source_profile_id INTEGER, confidence REAL, matched_by TEXT);
    CREATE TABLE rejected_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT, source TEXT, reason TEXT, rejected_at INTEGER);
  `);
  const verdict = { roleKey: "engineering", seniority: "mid", domain: "software", collar: "white", confidence: 0.9 };
  const write = (canonical) => {
    const dedup = reconcileFingerprint(db, { id: "j1", ...canonical });
    upsertCanonicalJob(db, {
      jobId: "j1", canonical, verdict, contentHash: "h", searchQuery: "q",
      sourceLabel: "", matchedBy: "test", dedup, now: 1,
    });
    return db.prepare("SELECT automation_tier t FROM scraped_jobs WHERE job_id='j1'").get().t;
  };

  assert.equal(write({ title: "E", company: "A", location: "US", source: "greenhouse",
                       url: "https://boards.greenhouse.io/a/jobs/1" }), "direct");
  // The posting moves to a workday tenant. The tier is a source column on the upsert, so the
  // re-crawl must re-derive it rather than pinning the first crawl's value.
  assert.equal(write({ title: "E", company: "A", location: "US", source: "workday",
                       url: "https://a.wd1.myworkdayjobs.com/x" }), "account");
  db.close();
});

test("backfill reads apply_url in preference to url, matching every writer", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, source TEXT, url TEXT, apply_url TEXT, automation_tier TEXT);
    INSERT INTO scraped_jobs VALUES ('x', 'LinkedIn', 'https://linkedin.com/jobs/view/9',
                                     'https://boards.greenhouse.io/acme/jobs/1', NULL);
  `);
  backfillAutomationTier(db);
  assert.equal(db.prepare("SELECT automation_tier t FROM scraped_jobs WHERE job_id='x'").get().t, "direct");
  db.close();
});
