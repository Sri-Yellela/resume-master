#!/usr/bin/env node
// ── CC5 · TWO USERS, TWO PROFILES, ONE POSTING — AGAINST THE REAL SERVER ────────────────────────
//
// The brief's VERIFY list, executed rather than reasoned about:
//
//   "Two users, same job: each gets their own score, neither sees the other's.
//    Two profiles, same user, same job: different reports.
//    A row with no stored score still offers a route to the term list."
//
// WHY A HARNESS AND NOT A UNIT TEST. The defect was never in one function. It was that four caches
// answered the same question with four different keys, and a test that mounts one of them proves
// nothing about the other three — which is exactly how `scraped_jobs.ats_report` stayed a
// cross-user read through two rounds of work on this code. This drives the running app over HTTP:
// real auth, real profile resolution, real migration-108 schema, real SQL.
//
// ⛔ NO MODEL CALLS AND NO SPEND. The scorer is local and deterministic. The only network traffic
// is to localhost:3001.
//
// It MUTATES the fixture users: it creates a throwaway second domain profile for user A, activates
// it, and deletes it again at the end, restoring whichever profile was active on entry. The teardown
// runs in a finally so a mid-run failure still restores it.
//
//   node server.js                       # in another terminal
//   node scripts/cc5PerProfileScores.mjs
//
import Database from "better-sqlite3";

const BASE = process.env.CC5_BASE || "http://localhost:3001";
const PASSWORD = process.env.CC5_PASSWORD || "A5-fixture-pass!";
const DB_PATH = "data/resume_master.db";

// Two résumés with deliberately DISJOINT vocabularies. If the cache were shared at any level the
// second caller would be served the first's terms, and "kubernetes" appearing in the data
// scientist's matched list is what that looks like.
const RESUME_BACKEND = `
ALEX BACKEND — Senior Backend Engineer
Built distributed systems in Python and Go handling 40k requests per second.
Designed REST and GraphQL APIs; owned API design, versioning and backwards compatibility.
Migrated a monolith to microservices on Kubernetes and Docker running on AWS.
Built data pipelines with Kafka and Airflow feeding PostgreSQL and Redis.
Terraform, CI/CD, on-call, incident response. Mentored four engineers.
SKILLS: Python, Go, SQL, PostgreSQL, Redis, Kafka, Kubernetes, Docker, AWS, Terraform,
distributed systems, microservices, API design, system design, data pipelines
`;

const RESUME_DATA = `
DANA DATA — Data Scientist
Built forecasting models in R and Python using scikit-learn and statsmodels.
Ran A/B tests and causal inference studies; owned experiment design and power analysis.
Built dashboards in Tableau and Looker; wrote SQL against Snowflake and BigQuery.
Published on hypothesis testing, regression, clustering and time series.
SKILLS: R, Python, scikit-learn, pandas, statistics, regression, clustering, time series,
experimentation, A/B testing, causal inference, Tableau, Looker, Snowflake, BigQuery
`;

let failures = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

// ⛔ A BEARER TOKEN, NOT A COOKIE, AND THAT IS NOT A STYLE CHOICE. This deployment's .env sets
// NODE_ENV=production, so the session cookie is minted `secure: true` — and locally the login
// response carries no Set-Cookie at all. A cookie-jar harness against localhost therefore reads as
// "every request is logged out", which looks exactly like an empty board. The app's own clients
// already authenticate with the `authContext` token the login returns; this sends it the same way.
async function call(pathname, { method = "GET", token = null, body = null } = {}) {
  const headers = {};
  if (token) headers["x-rm-auth-context"] = token;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, raw: text, setCookie: res.headers.getSetCookie?.() ?? [] };
}

/** The auth-context token for a fixture user, or null with a reason printed. */
async function signIn(username) {
  const res = await call("/api/auth/login", { method: "POST", body: { username, password: PASSWORD } });
  if (res.status !== 200) {
    console.log(`      login for ${username} returned ${res.status}: ${res.raw.slice(0, 160)}`);
    return null;
  }
  return res.json?.authContext || null;
}

const termsOf = (report) => new Set([
  ...(report?.tier1_matched || []), ...(report?.tier2_matched || []),
  ...(report?.matched_keywords || []), ...(report?.skills_matched || []),
].map(t => String(t).toLowerCase()));

async function main() {
  const health = await call("/api/health");
  if (health.status !== 200) {
    console.error(`The app is not answering on ${BASE}. Start it with: node server.js`);
    process.exit(1);
  }

  // Read-only view of the same database the server has open, used to assert on the STORED shape —
  // the response alone cannot show that two rows exist under two different keys.
  const db = new Database(DB_PATH, { readonly: true });

  const users = db.prepare(`
    SELECT u.id, u.username, dp.id AS profile_id
    FROM users u JOIN domain_profiles dp ON dp.user_id = u.id AND dp.is_active = 1
    WHERE u.username NOT IN ('admin','system')
    ORDER BY u.id
  `).all();
  if (users.length < 2) {
    console.error(`Need two users with an active domain profile; found ${users.length}.`);
    console.error("Seed them with: node scripts/a5SeedFixture.mjs");
    process.exit(1);
  }
  const [A, B] = users;

  console.log(`\nCC5 — per-(user, profile) ATS scores, against ${BASE}`);
  console.log(`  user A : ${A.username} (id ${A.id}, profile ${A.profile_id})`);
  console.log(`  user B : ${B.username} (id ${B.id}, profile ${B.profile_id})`);

  const tokenA = await signIn(A.username);
  const tokenB = await signIn(B.username);
  if (!tokenA || !tokenB) {
    console.error(`Could not sign both fixture users in. Set CC5_PASSWORD if it is not the default.`);
    process.exit(1);
  }

  // ── PICKING THE POSTING, WHICH IS THE ONE PART OF THIS THAT CAN MEASURE ITSELF ────────────────
  //
  // ⛔ THE FIRST VERSION TOOK `ORDER BY job_id LIMIT 1` AND DREW A CONCLUSION FROM IT. That is
  // `HRBP, Consumer Devices @ OpenAI` on this board: an HR role, which neither of these résumés has
  // a single term in common with. Both users scored 20 with zero matched terms — identical reports,
  // which the run then read as "the cache is shared". It was not; the POSTING could not tell the
  // two candidates apart, so the test had nothing to observe.
  //
  // So: a posting from the intersection of the two BOARDS (which also lets the board assertion at
  // the end run at all), preferring an engineering title, and the run REFUSES rather than passing
  // if the chosen posting turns out not to discriminate. A fixture that cannot fail is not evidence.
  const boardIds = async (token) => {
    const r = await call("/api/jobs?limit=200", { token });
    return (r.json?.jobs || []).map(j => ({ id: j.id, title: j.title || "" }));
  };
  const [listA, listB] = [await boardIds(tokenA), await boardIds(tokenB)];
  const idsB = new Set(listB.map(j => j.id));
  const common = listA.filter(j => idsB.has(j.id));
  const ENGINEERING = /engineer|developer|software|backend|full.?stack|platform|infrastructure/i;
  const onBoard = common.find(j => ENGINEERING.test(j.title)) || common[0] || null;

  const job = onBoard
    ? db.prepare("SELECT job_id, title, company FROM scraped_jobs WHERE job_id=?").get(onBoard.id)
    // Nothing on both boards — still worth running the cache assertions, because the keywords route
    // does not require board membership. The board assertion at the end will report SKIP.
    : db.prepare(`
        SELECT job_id, title, company FROM scraped_jobs
        WHERE is_active = 1 AND description IS NOT NULL AND LENGTH(description) > 1500
          AND LOWER(title) LIKE '%engineer%'
        ORDER BY job_id LIMIT 1`).get();
  if (!job) { console.error("No posting both users can see, and no fallback."); process.exit(1); }

  console.log(`  job    : ${job.job_id} — ${job.title} @ ${job.company}`);
  console.log(`           (${common.length} of A's ${listA.length} board rows are on B's board too`
    + `${onBoard ? "" : "; FELL BACK to a posting off both boards"})\n`);

  const rowsFor = (userId) => db.prepare(
    "SELECT domain_profile_id, ats_score, scorer_version, scored_at FROM ats_only_reports WHERE user_id=? AND job_id=? ORDER BY domain_profile_id"
  ).all(userId, job.job_id);

  const keywords = (token, resumeText) =>
    call(`/api/jobs/${encodeURIComponent(job.job_id)}/keywords`, {
      method: "POST", token, body: { resumeText },
    });

  let tempProfileId = null;
  try {
    // ── 1 · TWO USERS, SAME JOB ────────────────────────────────────────────────────────────────
    const rA = await keywords(tokenA, RESUME_BACKEND);
    const rB = await keywords(tokenB, RESUME_DATA);
    ok(rA.status === 200 && rB.status === 200, "both users get a report", `${rA.status} / ${rB.status}`);

    const tA = termsOf(rA.json), tB = termsOf(rB.json);
    // ⛔ THE FIXTURE HAS TO BE ABLE TO FAIL. If the posting matches neither résumé, both reports are
    // the same empty shape and "they are identical" says nothing about cache keys — see the note on
    // posting selection. Assert the discrimination exists BEFORE reading anything into it.
    ok(tA.size > 0 || tB.size > 0,
      "the chosen posting discriminates between the two résumés at all",
      `A ${tA.size} matched terms, B ${tB.size}`);
    ok(rA.json?.score !== rB.json?.score || [...tA].sort().join() !== [...tB].sort().join(),
      "the two reports are DIFFERENT — neither user is being served the other's",
      `A score ${rA.json?.score} (${tA.size} matched), B score ${rB.json?.score} (${tB.size} matched)`);

    // The specific leak, named. A term that is only in the backend résumé must not appear as
    // matched for the data scientist, and vice versa.
    const backendOnly = ["kubernetes", "kafka", "terraform", "microservices"];
    const dataOnly = ["scikit-learn", "tableau", "snowflake", "clustering"];
    ok(!backendOnly.some(t => tB.has(t)),
      "no backend-only term is reported as MATCHED for the data scientist",
      backendOnly.filter(t => tB.has(t)).join(", ") || "none");
    ok(!dataOnly.some(t => tA.has(t)),
      "no data-only term is reported as MATCHED for the backend engineer",
      dataOnly.filter(t => tA.has(t)).join(", ") || "none");

    // ── 2 · THE STORED SHAPE ───────────────────────────────────────────────────────────────────
    const storedA = rowsFor(A.id), storedB = rowsFor(B.id);
    ok(storedA.length === 1 && storedB.length === 1,
      "one cached row per user, not one shared row", `A ${storedA.length}, B ${storedB.length}`);
    ok(storedA[0]?.domain_profile_id === A.profile_id && storedB[0]?.domain_profile_id === B.profile_id,
      "each row is keyed to its own user's ACTIVE profile",
      `A -> ${storedA[0]?.domain_profile_id}, B -> ${storedB[0]?.domain_profile_id}`);
    ok(!!storedA[0]?.scorer_version && !!storedA[0]?.scored_at,
      "a stored score carries the engine that produced it and when",
      `${storedA[0]?.scorer_version} @ ${storedA[0]?.scored_at}`);

    const scrapedCell = db.prepare("SELECT ats_score, ats_report FROM scraped_jobs WHERE job_id=?").get(job.job_id);
    ok(scrapedCell.ats_score === null && scrapedCell.ats_report === null,
      "scoring this posting wrote NOTHING to the shared per-job cell");

    // ── 3 · THE CACHE SERVES THE CALLER, NOT WHOEVER ASKED FIRST ───────────────────────────────
    const again = await keywords(tokenA, RESUME_BACKEND);
    ok(again.json?.score === rA.json?.score,
      "A asking twice gets A's report back from cache, not B's",
      `${again.json?.score} vs A ${rA.json?.score} / B ${rB.json?.score}`);

    // ── 4 · TWO PROFILES, SAME USER ────────────────────────────────────────────────────────────
    const made = await call("/api/domain-profiles", {
      method: "POST", token: tokenA,
      body: {
        profile_name: "CC5 verification (temporary)", role_family: "data_science",
        domain: "data", seniority: "mid", target_titles: ["Data Scientist"],
      },
    });
    if (made.status !== 200 || !made.json?.id) {
      ok(false, "could create a second profile for user A", `${made.status} ${made.raw.slice(0, 120)}`);
    } else {
      tempProfileId = made.json.id;
      const act = await call(`/api/domain-profiles/${tempProfileId}/activate`, { method: "POST", token: tokenA });
      ok(act.status === 200, "and activate it");

      const second = await keywords(tokenA, RESUME_DATA);
      ok(second.status === 200, "the same user, same job, on a second profile gets a report");
      ok(second.json?.score !== rA.json?.score || [...termsOf(second.json)].join() !== [...tA].join(),
        "and it is DIFFERENT from the first profile's — the profile is part of the key",
        `profile ${A.profile_id} -> ${rA.json?.score}, profile ${tempProfileId} -> ${second.json?.score}`);

      const twoRows = rowsFor(A.id);
      ok(twoRows.length === 2, "two cached rows for one user and one job, one per profile",
        twoRows.map(r => `${r.domain_profile_id}:${r.ats_score}`).join(" "));

      // And switching back serves the FIRST profile's report again, unchanged by the second.
      const back = await call(`/api/domain-profiles/${A.profile_id}/activate`, { method: "POST", token: tokenA });
      ok(back.status === 200, "switch back to the original profile");
      const first = await keywords(tokenA, RESUME_BACKEND);
      ok(first.json?.score === rA.json?.score,
        "the original profile's report survived the other profile being scored",
        `${first.json?.score} vs ${rA.json?.score}`);
    }

    // ── 5 · THE BOARD SHOWS EACH CALLER THEIR OWN SCORE ────────────────────────────────────────
    const boardOf = async (token) => {
      const r = await call("/api/jobs?limit=200", { token });
      const row = (r.json?.jobs || []).find(j => j.id === job.job_id);
      return { status: r.status, found: !!row, matchScore: row?.matchScore ?? null, total: r.json?.jobs?.length ?? 0 };
    };
    const bA = await boardOf(tokenA), bB = await boardOf(tokenB);
    if (bA.found && bB.found) {
      ok(bA.matchScore === rA.json?.score && bB.matchScore === rB.json?.score,
        "each board serves the caller their OWN cached score as matchScore",
        `A ${bA.matchScore} (own ${rA.json?.score}), B ${bB.matchScore} (own ${rB.json?.score})`);
    } else {
      // Not a failure of CC5: board membership is CC1's join, and this posting need not be on
      // either curated board. Reported so the run is not read as covering something it did not.
      console.log(`SKIP  board matchScore — the posting is not on ${bA.found ? "B" : "A"}'s board `
        + `(A ${bA.total} rows, B ${bB.total} rows); membership is CC1's rule, not this one`);
    }
  } finally {
    if (tempProfileId) {
      await call(`/api/domain-profiles/${A.profile_id}/activate`, { method: "POST", token: tokenA });
      const del = await call(`/api/domain-profiles/${tempProfileId}`, { method: "DELETE", token: tokenA });
      console.log(`\n  cleanup: temporary profile ${tempProfileId} deleted (${del.status}), `
        + `profile ${A.profile_id} reactivated`);
    }
    db.close();
    // The cached reports this run created are real rows against two real users, computed from two
    // invented résumés — so they would put a wrong band on one posting of somebody's actual board
    // until they next opened it. A second, WRITABLE handle (the read-only one above cannot delete)
    // removes exactly the rows for the posting this run touched, and nothing else.
    try {
      const w = new Database(DB_PATH);
      const n = w.prepare("DELETE FROM ats_only_reports WHERE job_id=? AND user_id IN (?,?)")
        .run(job.job_id, A.id, B.id).changes;
      w.close();
      console.log(`  cleanup: ${n} cached report row(s) for ${job.job_id} removed`);
    } catch (e) {
      console.log(`  cleanup: could not remove this run's cached rows — ${e.message}`);
    }
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
