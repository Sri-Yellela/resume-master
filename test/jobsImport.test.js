import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  detectKnownAtsMatch, isLoginWalled, isPrivateOrLoopbackIp, findMatchingPosting, importJob,
} from "../services/jobs/importJob.js";

test("detectKnownAtsMatch parses Greenhouse, Lever, Ashby, SmartRecruiters URLs", () => {
  assert.deepEqual(
    detectKnownAtsMatch("https://boards.greenhouse.io/stripe/jobs/12345"),
    { type: "greenhouse", slug: "stripe", externalId: "12345" }
  );
  assert.deepEqual(
    detectKnownAtsMatch("https://jobs.lever.co/acme/abcdef12-3456-7890-abcd-ef1234567890"),
    { type: "lever", slug: "acme", externalId: "abcdef12-3456-7890-abcd-ef1234567890" }
  );
  assert.deepEqual(
    detectKnownAtsMatch("https://jobs.ashbyhq.com/notion/abcdef12-3456-7890-abcd-ef1234567890"),
    { type: "ashby", slug: "notion", externalId: "abcdef12-3456-7890-abcd-ef1234567890" }
  );
  assert.deepEqual(
    detectKnownAtsMatch("https://jobs.smartrecruiters.com/Acme/12345-senior-engineer"),
    { type: "smartrecruiters", slug: "Acme", externalId: "12345" }
  );
});

test("detectKnownAtsMatch handles both Workable URL forms — only one carries the slug", () => {
  assert.deepEqual(
    detectKnownAtsMatch("https://apply.workable.com/acme/j/ABC123DEF/"),
    { type: "workable", slug: "acme", externalId: "ABC123DEF" }
  );
  // jobs.workable.com/view/{shortcode} has no account slug anywhere in the URL — must fall
  // through to the generic path rather than guessing one.
  assert.equal(
    detectKnownAtsMatch("https://jobs.workable.com/view/ABC123DEF/senior-engineer"),
    null
  );
});

test("detectKnownAtsMatch parses Recruitee (subdomain slug) and Workday (tenant/wd# only)", () => {
  assert.deepEqual(
    detectKnownAtsMatch("https://acme.recruitee.com/o/senior-engineer"),
    { type: "recruitee", slug: "acme", externalId: null }
  );
  // Workday deliberately never returns a usable `site` — that's resolved later against
  // company_ats_list, not guessed from the URL.
  assert.deepEqual(
    detectKnownAtsMatch("https://acme.wd5.myworkdayjobs.com/external/job/Remote/Senior-Engineer_R12345"),
    { type: "workday", tenant: "acme", wdNumber: "5", externalId: null }
  );
});

test("detectKnownAtsMatch returns null for unknown hosts and invalid URLs", () => {
  assert.equal(detectKnownAtsMatch("https://careers.somecompany.com/job/123"), null);
  assert.equal(detectKnownAtsMatch("not a url"), null);
});

test("isLoginWalled flags linkedin.com hosts only", () => {
  assert.equal(isLoginWalled("https://www.linkedin.com/jobs/view/1234567"), true);
  assert.equal(isLoginWalled("https://linkedin.com/jobs/view/1234567"), true);
  assert.equal(isLoginWalled("https://boards.greenhouse.io/stripe/jobs/12345"), false);
  assert.equal(isLoginWalled("not a url"), false);
});

test("isPrivateOrLoopbackIp rejects loopback/private/link-local ranges, accepts public IPs", () => {
  assert.equal(isPrivateOrLoopbackIp("127.0.0.1"), true);
  assert.equal(isPrivateOrLoopbackIp("10.0.0.5"), true);
  assert.equal(isPrivateOrLoopbackIp("172.16.0.1"), true);
  assert.equal(isPrivateOrLoopbackIp("192.168.1.1"), true);
  assert.equal(isPrivateOrLoopbackIp("169.254.1.1"), true);
  assert.equal(isPrivateOrLoopbackIp("::1"), true);
  assert.equal(isPrivateOrLoopbackIp("fe80::1"), true);
  assert.equal(isPrivateOrLoopbackIp("8.8.8.8"), false);
  assert.equal(isPrivateOrLoopbackIp("1.1.1.1"), false);
});

test("findMatchingPosting matches by normalized URL equality first", () => {
  const jobs = [
    { url: "https://boards.greenhouse.io/stripe/jobs/111", req_id: "111" },
    { url: "https://boards.greenhouse.io/stripe/jobs/222", req_id: "222" },
  ];
  const match = findMatchingPosting(jobs, { url: "https://boards.greenhouse.io/stripe/jobs/222/", externalId: null });
  assert.equal(match.req_id, "222");
});

test("findMatchingPosting falls back to req_id when URL doesn't match", () => {
  const jobs = [
    { url: "https://boards.greenhouse.io/stripe/jobs/111", req_id: "111" },
    { url: "https://boards.greenhouse.io/stripe/jobs/222", req_id: "222" },
  ];
  const match = findMatchingPosting(jobs, { url: "https://some-redirector.example.com/x", externalId: "222" });
  assert.equal(match.req_id, "222");
});

test("findMatchingPosting returns null when nothing matches", () => {
  const jobs = [{ url: "https://boards.greenhouse.io/stripe/jobs/111", req_id: "111" }];
  const match = findMatchingPosting(jobs, { url: "https://boards.greenhouse.io/stripe/jobs/999", externalId: "999" });
  assert.equal(match, null);
});

// ── Import ownership ──────────────────────────────────────────────────────────
// Imports land in the GLOBAL scraped_jobs pool. Before this, nothing recorded WHO imported a
// job, so the importer had no guarantee of ever seeing it again — visibility depended on their
// profile filters happening to match the classification — while every other user with a
// matching profile got it on their board. Starring in user_jobs is the same mechanism the star
// button already writes, so an import shows up under the existing "starred" filter.

function importDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, location TEXT, url TEXT,
      source TEXT, source_label TEXT, description TEXT, summary TEXT, normalized_title TEXT,
      experience_level TEXT, workplace_type TEXT, skills_json TEXT,
      salary_min INTEGER, salary_max INTEGER, salary_currency TEXT,
      salary_min_usd INTEGER, salary_max_usd INTEGER, salary_period TEXT,
      is_h1b_sponsor INTEGER, requires_work_auth INTEGER, is_clearance_required INTEGER,
      org_unit_raw TEXT, posted_at TEXT, discovered_at INTEGER, scraped_at INTEGER,
      updated_at INTEGER, is_active INTEGER DEFAULT 1, enriched_at INTEGER, content_hash TEXT,
      sources_seen TEXT, req_uid TEXT, fingerprint TEXT, _hash TEXT
    );
    CREATE TABLE user_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, job_id TEXT NOT NULL,
      visited INTEGER DEFAULT 0, applied INTEGER DEFAULT 0, starred INTEGER DEFAULT 0,
      disliked INTEGER DEFAULT 0, resume_generated INTEGER DEFAULT 0,
      domain_profile_id INTEGER, created_at INTEGER, updated_at INTEGER,
      UNIQUE (user_id, job_id)
    );
    CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, is_active INTEGER DEFAULT 0);
  `);
  return db;
}

test("a re-import inside the freshness window still attaches the job to the NEW importer", async () => {
  // The fast path exists to avoid re-fetching, but a second user importing the same URL is a
  // real import for them. Returning someone else's row without adding it to their board would
  // make the feature look silently broken for the second user.
  const db = importDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,url,source,updated_at,is_active,description)
              VALUES ('greenhouse::1','Eng','Acme','https://boards.greenhouse.io/acme/jobs/1','greenhouse',?,1,'text')`).run(now);
  db.prepare(`INSERT INTO domain_profiles (id,user_id,is_active) VALUES (7,42,1)`).run();

  const res = await importJob(
    { url: "https://boards.greenhouse.io/acme/jobs/1" },
    { db, anthropic: null, userId: 42 }
  );
  assert.equal(res.job.id, "greenhouse::1", "the fresh existing row is reused, not refetched");

  const link = db.prepare("SELECT * FROM user_jobs WHERE user_id=42 AND job_id='greenhouse::1'").get();
  assert.ok(link, "the importer must be attached to the row");
  assert.equal(link.starred, 1, "an import is starred so it lands in the user's saved jobs");
  assert.equal(link.domain_profile_id, 7, "the active profile is recorded on the interaction");
});

test("two different users importing the same URL each get their own attachment", async () => {
  const db = importDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,url,source,updated_at,is_active,description)
              VALUES ('greenhouse::1','Eng','Acme','https://boards.greenhouse.io/acme/jobs/1','greenhouse',?,1,'text')`).run(now);

  const url = "https://boards.greenhouse.io/acme/jobs/1";
  await importJob({ url }, { db, anthropic: null, userId: 1 });
  await importJob({ url }, { db, anthropic: null, userId: 2 });

  const rows = db.prepare("SELECT user_id FROM user_jobs WHERE job_id='greenhouse::1' ORDER BY user_id").all();
  assert.deepEqual(rows.map(r => r.user_id), [1, 2], "one shared row, two separate attachments");
});

test("re-importing a job you already starred stays starred and does not duplicate", async () => {
  const db = importDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,url,source,updated_at,is_active,description)
              VALUES ('greenhouse::1','Eng','Acme','https://boards.greenhouse.io/acme/jobs/1','greenhouse',?,1,'text')`).run(now);

  const url = "https://boards.greenhouse.io/acme/jobs/1";
  await importJob({ url }, { db, anthropic: null, userId: 1 });
  await importJob({ url }, { db, anthropic: null, userId: 1 });

  const rows = db.prepare("SELECT starred FROM user_jobs WHERE user_id=1 AND job_id='greenhouse::1'").all();
  assert.equal(rows.length, 1, "the UNIQUE(user_id, job_id) upsert must not create a second row");
  assert.equal(rows[0].starred, 1);
});

test("an anonymous import still succeeds and simply records no attachment", async () => {
  // attachImportToUser must never be able to fail the import itself.
  const db = importDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO scraped_jobs (job_id,title,company,url,source,updated_at,is_active,description)
              VALUES ('greenhouse::1','Eng','Acme','https://boards.greenhouse.io/acme/jobs/1','greenhouse',?,1,'text')`).run(now);

  const res = await importJob(
    { url: "https://boards.greenhouse.io/acme/jobs/1" },
    { db, anthropic: null, userId: null }
  );
  assert.equal(res.job.id, "greenhouse::1");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM user_jobs").get().n, 0);
});

test("a LinkedIn URL is refused with needsClientCapture and NO outbound request is made", async () => {
  // The point of the login-walled branch is not just its return value — it is that the server never
  // touches linkedin.com. Asserting the response alone would keep passing if someone moved the check
  // below the fetch, so this proves the network was not used at all: every outbound path in this
  // module goes through axios (fetchGenericPosting, and each ATS source's fetchCompanyJobs), and
  // DNS resolution happens in assertFetchable before any socket is opened.
  const db = importDb();
  const axios = (await import("axios")).default;
  const dns = await import("dns/promises");
  const realGet = axios.get;
  const realLookup = dns.default.lookup;
  const calls = [];
  axios.get = (...args) => { calls.push(args[0]); throw new Error(`outbound fetch attempted: ${args[0]}`); };
  dns.default.lookup = (...args) => { calls.push(`dns:${args[0]}`); throw new Error(`dns lookup attempted: ${args[0]}`); };
  try {
    const res = await importJob(
      { url: "https://www.linkedin.com/jobs/view/4141234567" },
      { db, anthropic: null, userId: 1 }
    );
    assert.equal(res.needsClientCapture, true);
    assert.equal(res.reason, "login_walled");
    assert.ok(res.message.includes("extension"), "the message must name the way forward");
    assert.deepEqual(calls, [], "nothing may be requested for a login-walled host");
    // And it must not have written anything either — a refusal is not a partial import.
    assert.equal(db.prepare("SELECT COUNT(*) n FROM scraped_jobs").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM user_jobs").get().n, 0);
  } finally {
    axios.get = realGet;
    dns.default.lookup = realLookup;
  }
});

test("a LinkedIn URL WITH pasted text is imported from that text, still without fetching", async () => {
  // The fallback the refusal message describes. Same no-network guarantee: the text is already here.
  const db = importDb();
  const axios = (await import("axios")).default;
  const realGet = axios.get;
  const calls = [];
  axios.get = (...args) => { calls.push(args[0]); throw new Error(`outbound fetch attempted: ${args[0]}`); };
  try {
    const anthropic = {}; // callModel is never reached: extraction is stubbed out by the throw below
    await assert.rejects(
      () => importJob(
        { url: "https://www.linkedin.com/jobs/view/4141234567", text: "Senior Engineer at Acme" },
        { db, anthropic: null, userId: 1 }
      ),
      /AI client/,
      "with text present it takes the extraction path (which needs a model), not the refusal path"
    );
    assert.deepEqual(calls, [], "still nothing fetched from linkedin.com");
    void anthropic;
  } finally {
    axios.get = realGet;
  }
});
