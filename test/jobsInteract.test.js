import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { at } from "../test-support/sourceAnchors.js";

/**
 * PATCH /api/jobs/interact — the star/dislike fallback that never once worked.
 *
 * It was added in a55151d selecting a `status` column user_jobs has never had, in any migration.
 * Every call threw SqliteError("no such column: status") and returned 500, and JobCard's caller
 * wrapped it in `catch { console.warn(...) }` — so the star filled in optimistically, the write
 * failed, and the flag reverted on the next load with nothing said.
 *
 * IT IS REACHABLE. JobsPanel passes onStar so the board uses its own handler, but both JobCard call
 * sites in DatabasePanel pass only onDislike. Starring on the Database panel, and unstarring a job
 * in Saved Jobs, went here and did nothing.
 *
 * THE SECOND DEFECT, which deleting the `status` reference would have shipped: the insert used the
 * URL as the job_id. Every other writer of user_jobs uses a real job_id, so the endpoint would have
 * started writing a parallel, URL-keyed row for the same job — one no board query joins to and no
 * user could ever see. A loud crash traded for a silent one.
 */

const SERVER = fs.readFileSync("server.js", "utf8");
const handler = SERVER.slice(
  at(SERVER, 'app.patch("/api/jobs/interact"'),
  at(SERVER, '// GET /api/jobs/poll'));

// ── the crash ────────────────────────────────────────────────────────────────────────────────

test("user_jobs has no `status` column, in any migration — so nothing may select one", () => {
  // The premise. If a migration ever adds one this test should fail and be reconsidered, rather
  // than the endpoint quietly starting to read a column whose meaning nobody decided.
  const migrations = fs.readFileSync("scripts/migrations.js", "utf8");
  assert.doesNotMatch(migrations, /ALTER TABLE user_jobs ADD COLUMN status\b/);
  const created = migrations.slice(at(migrations, "CREATE TABLE IF NOT EXISTS user_jobs"));
  assert.doesNotMatch(created.slice(0, at(created, ");")), /\bstatus\b/);
});

test("the handler no longer selects a column that does not exist", () => {
  assert.doesNotMatch(handler, /SELECT starred, disliked, status FROM user_jobs/);
  assert.match(handler, /SELECT starred, disliked FROM user_jobs/);
});

test("the dead inputs are gone rather than wired up", () => {
  // status, title, company and source were all destructured and never used — status was read into
  // a `newStatus` that nothing referenced. There is no column for any of them, and inventing one
  // to justify a parameter nobody sends is the wrong direction.
  assert.match(handler, /const \{ jobId, url, starred, disliked \} = req\.body \|\| \{\};/);
  assert.doesNotMatch(handler, /newStatus/);
});

// ── the job is resolved, never invented ──────────────────────────────────────────────────────

test("the row is keyed on a real job_id, never on a URL", () => {
  assert.match(handler, /SELECT job_id FROM scraped_jobs WHERE job_id=\?/);
  assert.match(handler, /SELECT job_id FROM scraped_jobs WHERE url=\? OR apply_url=\? LIMIT 1/);
  assert.match(handler, /if \(!resolved\?\.job_id\) return res\.status\(404\)/);
  assert.match(handler, /\.run\(req\.user\.id, resolvedJobId, profileId, newStarred, newDisliked\)/);
  // The old shape: the URL going straight into the insert.
  assert.doesNotMatch(handler, /\.run\(req\.user\.id, url,/);
});

test("it uses the same profile resolution as its sibling endpoints", () => {
  // The board filters on domain_profile_id, so a row written under a different one is a star the
  // user cannot see. /api/jobs/:id/starred and /disliked both go through this function.
  assert.match(handler, /resolveUserJobDomainProfileId\(req\.user\.id, resolvedJobId\)/);
  assert.doesNotMatch(handler, /SELECT id FROM domain_profiles WHERE user_id=\? AND is_active=1 LIMIT 1/);
});

test("and it emits the same sync event, so other tabs do not go stale", () => {
  // AH2 made several tabs on one session an ordinary thing to do. The siblings already did this.
  assert.match(handler, /emitToUser\(req\.user\.id, \{ type: "job_flag", jobId: resolvedJobId, starred: !!newStarred \}\)/);
});

// ── behaviour, against a real database ───────────────────────────────────────────────────────

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, url TEXT, apply_url TEXT);
    CREATE TABLE user_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, job_id TEXT,
      visited INTEGER DEFAULT 0, applied INTEGER DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0,
      disliked INTEGER NOT NULL DEFAULT 0, domain_profile_id INTEGER,
      created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(user_id, job_id));
  `);
  db.prepare("INSERT INTO scraped_jobs VALUES (?,?,?)")
    .run("ashby::abc", "https://example.invalid/posting", "https://example.invalid/apply");
  return db;
}

/** The endpoint's resolution and write, exactly as the handler performs them. */
function interact(db, { userId = 1, jobId, url, starred, disliked, profileId = 7 } = {}) {
  const resolved = jobId
    ? db.prepare("SELECT job_id FROM scraped_jobs WHERE job_id=?").get(String(jobId))
    : db.prepare("SELECT job_id FROM scraped_jobs WHERE url=? OR apply_url=? LIMIT 1").get(url, url);
  if (!resolved?.job_id) return { status: 404 };
  const id = resolved.job_id;
  const existing = db.prepare("SELECT starred, disliked FROM user_jobs WHERE user_id=? AND job_id=?")
    .get(userId, id);
  const newStarred = starred != null ? (starred ? 1 : 0) : (existing?.starred ?? 0);
  const newDisliked = disliked != null ? (disliked ? 1 : 0) : (existing?.disliked ?? 0);
  db.prepare(`
    INSERT INTO user_jobs (user_id, job_id, domain_profile_id, starred, disliked, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(user_id, job_id) DO UPDATE SET
      starred = excluded.starred, disliked = excluded.disliked, updated_at = unixepoch()
  `).run(userId, id, profileId, newStarred, newDisliked);
  return { status: 200, jobId: id, starred: !!newStarred, disliked: !!newDisliked };
}

test("starring by jobId writes one row, keyed on the job", () => {
  const db = fixture();
  const r = interact(db, { jobId: "ashby::abc", starred: true });
  assert.equal(r.status, 200);
  const rows = db.prepare("SELECT * FROM user_jobs").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].job_id, "ashby::abc");
  assert.equal(rows[0].starred, 1);
  db.close();
});

test("a URL resolves to the SAME row — not a second, parallel one", () => {
  // This is the defect that deleting the `status` reference alone would have shipped.
  const db = fixture();
  interact(db, { jobId: "ashby::abc", starred: true });
  interact(db, { url: "https://example.invalid/posting", starred: false });
  const rows = db.prepare("SELECT * FROM user_jobs").all();
  assert.equal(rows.length, 1, "a URL created a second row for the same job");
  assert.equal(rows[0].starred, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM user_jobs WHERE job_id LIKE 'http%'").get().c, 0);
  db.close();
});

test("the apply URL resolves too — a card carries whichever it has", () => {
  const db = fixture();
  const r = interact(db, { url: "https://example.invalid/apply", starred: true });
  assert.equal(r.jobId, "ashby::abc");
  db.close();
});

test("a job we do not know is a 404, not a phantom row", () => {
  const db = fixture();
  assert.equal(interact(db, { jobId: "nope::nope", starred: true }).status, 404);
  assert.equal(interact(db, { url: "https://somewhere-else.invalid/x", starred: true }).status, 404);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM user_jobs").get().c, 0);
  db.close();
});

test("the flag you did not send is preserved, not reset to zero", () => {
  // starred and disliked are independent, and a card sends one at a time.
  const db = fixture();
  interact(db, { jobId: "ashby::abc", disliked: true });
  interact(db, { jobId: "ashby::abc", starred: true });
  const row = db.prepare("SELECT starred, disliked FROM user_jobs").get();
  assert.equal(row.starred, 1);
  assert.equal(row.disliked, 1, "sending starred must not clear disliked");
  db.close();
});

test("two users starring the same job keep separate rows", () => {
  const db = fixture();
  interact(db, { userId: 1, jobId: "ashby::abc", starred: true });
  interact(db, { userId: 2, jobId: "ashby::abc", starred: false });
  const rows = db.prepare("SELECT user_id, starred FROM user_jobs ORDER BY user_id").all();
  assert.deepEqual(rows, [{ user_id: 1, starred: 1 }, { user_id: 2, starred: 0 }]);
  db.close();
});

// ── the caller ───────────────────────────────────────────────────────────────────────────────

test("JobCard sends the jobId it already has", () => {
  const card = fs.readFileSync("client/src/components/JobCard.jsx", "utf8");
  const fn = card.slice(at(card, "async function interact(patch)"), at(card, "// Fallback handlers"));
  assert.match(fn, /jobId: job\.jobId \|\| job\.id/);
  // The three parameters the endpoint discarded are gone.
  assert.doesNotMatch(fn, /title: job\.title/);
  assert.doesNotMatch(fn, /company: job\.company/);
  assert.doesNotMatch(fn, /source: job\.source/);
  // Still through api(), so the tab's own identity is what the write lands on (AH1).
  assert.match(fn, /await api\("\/api\/jobs\/interact"/);
  // And a failure now names the job and the message, rather than logging a bare object — that
  // console.warn is the reason a permanently-500ing endpoint went unnoticed.
  assert.match(fn, /interact failed for \$\{job\.jobId \|\| job\.id\}: \$\{e\.message\}/);
});
