// A SCORE IS A STATEMENT ABOUT (RÉSUMÉ, POSTING). IT WAS STORED PER POSTING.
//
// `scraped_jobs.ats_score` / `ats_report` are ONE CELL PER JOB. Three writers filled them — the
// scrape scorer, adopt-enhanced, and the keywords route — each from a runtime basis built out of
// ONE user's base résumé, their signal profile and their claims. Four readers served them back:
// the board's `matchScore`, the poll shape's `baseAtsScore`/`baseAtsReport`, the keywords route's
// priority-2 cache, and the stamp written onto an application at apply time.
//
// So one candidate's matched and missing terms were served to any other user who opened the same
// posting, and pressing "adopt enhanced résumé" rewrote the score every other user saw on every job
// that candidate had saved. The apply stamp was the worst of the four: `job_applications` is the
// only table that can ever correlate a score with whether an employer replied, and it recorded
// strangers' scores with a provenance version attached.
//
// CC5's rule, which is what this file pins:
//
//   EVERY stored ATS number is keyed (user_id, domain_profile_id, job_id), or it does not exist.
//
// The per-job cell has no writer and no reader left. Migration 108 widened the per-user cache's key
// to include the profile and gave it `scorer_version`/`scored_at`, because a stored score with
// neither is unfalsifiable.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../scripts/migrations.js";
// `at` rather than a bare indexOf for every region carved below: a missing anchor is -1, and slice
// reads -1 as an offset from the END, so the region silently widens to most of the file and the
// assertion keeps passing over the wrong text. See test/sourceAnchorGuard.test.js.
import { at } from "../test-support/sourceAnchors.js";

const SERVER = fs.readFileSync("server.js", "utf8");
const JOB_CARD = fs.readFileSync("client/src/components/JobCard.jsx", "utf8");
const JOBS_PANEL = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
const ATS_REPORT_PANEL = fs.readFileSync("client/src/panels/AtsReportPanel.jsx", "utf8");
const APPLY = fs.readFileSync("routes/apply.js", "utf8");

// ⛔ EVERY ASSERTION BELOW THAT A STATEMENT IS GONE HAS TO IGNORE THE COMMENTS QUOTING IT.
//
// The deleted reads and writes are quoted verbatim in the notes that explain why they went — that
// is how the reasoning survives a later reader who wonders whether the cache was merely an
// oversight. A bare `doesNotMatch` over the whole file therefore fails on the explanation rather
// than on the defect, and the obvious fix — loosening the pattern until it passes — throws the
// check away. It is also the failure mode that dumps a 200KB source file into the test output.
//
// So: find every line that matches and require each to be inside a comment. Re-adding the statement
// fails. Documenting it does not. And deleting the comment does not widen what is allowed, because
// the pattern still has to find nothing live.
function noLiveMatch(src, pattern, what) {
  const offenders = src.split(/\r?\n/)
    .filter(line => pattern.test(line))
    .filter(line => !/^\s*(\/\/|\*|\/\*|--)/.test(line))
    .map(line => line.trim());
  assert.deepEqual(offenders, [], what);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE WRITERS
// ════════════════════════════════════════════════════════════════════════════════════════════

test("⛔ NOTHING writes a score onto the posting any more", () => {
  // The single string all three writers shared. Pinned as a source scan because the thing being
  // asserted is that a statement does not exist — there is no behaviour to execute for an absence.
  noLiveMatch(SERVER, /UPDATE\s+scraped_jobs\s+SET\s+ats_(score|report)/i,
    "a per-job cell cannot hold a per-résumé number; there is no correct way to write this");
});

test("all three scoring paths write through the one per-profile writer", () => {
  // The scrape scorer, adopt-enhanced and the keywords route. One writer means the next mistake
  // gets made once rather than three times — which is how this defect survived: it was three
  // copies of the same UPDATE, and fixing any one of them looked complete.
  assert.match(SERVER, /function storeAtsReportForProfile\(\{ userId, profileId = null, jobId, report \}\)/);
  // Minus the declaration the previous line just matched: three call sites, no more and no fewer.
  // A fourth would mean a new scoring path nobody reviewed; a second would mean one of the three
  // went back to writing its own SQL, which is the shape the defect had.
  assert.equal((SERVER.match(/storeAtsReportForProfile\(\{/g) || []).length - 1, 3,
    "every path that computes a score must store it through the same writer");
});

test("the writer is DELETE-then-INSERT, because ON CONFLICT cannot see a NULL profile", () => {
  // Not a style preference. The behavioural half is the test below; this pins that the code took
  // the branch that survives it.
  const start = at(SERVER, "function storeAtsReportForProfile(");
  const body = SERVER.slice(start, at(SERVER, "\n}", start));
  assert.match(body, /DELETE FROM ats_only_reports WHERE user_id=\? AND job_id=\? AND domain_profile_id IS \?/,
    "`IS` rather than `=`, or the delete silently matches nothing for a NULL profile");
  assert.doesNotMatch(body, /ON CONFLICT/,
    "an upsert on a key containing a nullable column does not dedupe the NULL rows");
});

test("SQLite really does let duplicate NULL-profile rows through that UNIQUE", () => {
  // The fact the writer is shaped around, asserted against SQLite itself rather than believed.
  // If a future SQLite changed this, the DELETE would merely be redundant — but the reasoning in
  // the writer would be wrong, and a comment that is wrong is worse than no comment.
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  db.prepare("INSERT INTO users (id,username,password_hash) VALUES (1,'ada','x')").run();
  const ins = () => db.prepare(
    "INSERT INTO ats_only_reports (user_id,domain_profile_id,job_id,ats_report) VALUES (1,NULL,'j','{}')"
  ).run();
  ins(); ins();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ats_only_reports").get().n, 2,
    "two rows for one (user, job) with a NULL profile — the unique index does not constrain them");
  // And the delete-then-insert shape collapses them to one, which is what the writer relies on.
  db.prepare("DELETE FROM ats_only_reports WHERE user_id=1 AND job_id='j' AND domain_profile_id IS NULL").run();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ats_only_reports").get().n, 0);
  db.close();
});

test("a profile's score does not suppress scoring for a different profile", () => {
  // The quieter half of the leak. The scrape scorer skipped any posting whose `ats_score` was
  // already set — a marker shared by every user — so the second user to crawl a job was skipped for
  // having a score they did not have. The replacement asks per (user, profile).
  assert.match(SERVER, /!hasAtsReportForProfile\(\{ userId, profileId: domainProfile\?\.id \?\? null, jobId: item\.jobId \}\)/);
  assert.match(SERVER, /FROM ats_only_reports WHERE user_id=\? AND job_id=\? AND domain_profile_id IS \?/);

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  db.prepare("INSERT INTO users (id,username,password_hash) VALUES (1,'ada','x')").run();
  db.prepare("INSERT INTO users (id,username,password_hash) VALUES (2,'bob','x')").run();
  db.prepare("INSERT INTO ats_only_reports (user_id,domain_profile_id,job_id,ats_report,ats_score) VALUES (1,NULL,'j',?,55)")
    .run(JSON.stringify({ score: 55 }));
  const asked = (userId) => db.prepare(
    "SELECT 1 FROM ats_only_reports WHERE user_id=? AND job_id=? AND domain_profile_id IS ? LIMIT 1"
  ).get(userId, "j", null);
  assert.ok(asked(1), "user 1 has a score for this posting");
  assert.ok(!asked(2), "user 2 does not, and must not be skipped for user 1's");
  db.close();
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE READERS
// ════════════════════════════════════════════════════════════════════════════════════════════

test("⛔ no read path serves the per-job cell as somebody's score", () => {
  // Board: joins the caller's own cache. Poll: the two fields are hard nulls. Keywords: the
  // priority-2 read is gone. Apply: the third source is gone.
  assert.match(SERVER, /LEFT JOIN ats_only_reports aor/);
  assert.doesNotMatch(SERVER, /sj\.ats_score AS matchScore/);
  assert.match(SERVER, /baseAtsScore:\s*null/);
  assert.match(SERVER, /baseAtsReport:\s*null/);
  noLiveMatch(SERVER, /SELECT ats_report FROM scraped_jobs/,
    "the keywords route's priority-2 cache was a cross-user read and must stay deleted");
  noLiveMatch(APPLY, /SELECT ats_report FROM scraped_jobs/,
    "the apply stamp may not read the per-job cell — it would write a stranger's score into the "
    + "only dataset that can ever validate this number");
});

test("both surviving apply sources are scoped to the profile, NULL last", () => {
  // `resumes` and `ats_only_reports` both carry domain_profile_id and both reads ignored it, so a
  // user with two profiles stamped whichever report happened to exist first. Rows predating the
  // column are a fallback, never a winner — see test/atsRankingHonesty.test.js for the behaviour.
  assert.match(APPLY, /WHERE user_id = \? AND job_id = \?\s*\n\s*AND \(domain_profile_id IS NULL OR domain_profile_id = \?\)/);
  assert.match(APPLY, /ORDER BY \(domain_profile_id IS NULL\) ASC/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE ROUTE TO THE TERM LIST — the data gap, and why it is not a backfill
// ════════════════════════════════════════════════════════════════════════════════════════════

test("an unscored row still offers a way into its ATS report", () => {
  // 0 of 2,458 active postings carry a stored score, and BOTH halves of the only route were shut:
  // the badge renders nothing without a score (correctly — a card must not report an absent score
  // as a verdict) and the handler behind it was gated on the same value. Two right decisions
  // composing into a dead end on 100% of rows.
  assert.match(JOB_CARD, /function AtsSlot\(\{ score, onClick \}\)/,
    "a card needs a control that exists when there is no score");
  assert.match(JOB_CARD, /if \(score != null && !Number\.isNaN\(score\)\) return <ATSBadge/,
    "with a score it is still the band badge, unchanged");
  assert.match(JOB_CARD, /if \(!onClick\) return null;/,
    "and nothing at all when there is nowhere to go");
  // The band must not be faked for an unscored row: no band label, no band colour.
  const slot = JOB_CARD.slice(at(JOB_CARD, "function AtsSlot("), at(JOB_CARD, "function ATSBadge("));
  assert.doesNotMatch(slot, /atsBandFor|atsBandLabel/,
    "the neutral control may not consult the band vocabulary — there is no band to report");

  // Both call sites go through it, or the two rows of one card disagree about when it appears.
  assert.equal((JOBS_PANEL.match(/onAts=\{\(\) => openAtsPanel\(buildAtsPayload\(job, g\)\)\}/g) || []).length, 1);
  noLiveMatch(JOBS_PANEL, /if \(g\?\.atsReport \|\| g\?\.atsScore != null/,
    "the handler may not require the report it exists to go and fetch");
  assert.equal((JOB_CARD.match(/<AtsSlot score=/g) || []).length, 2);
  noLiveMatch(JOB_CARD, /<ATSBadge score=\{g\?\.atsScore/,
    "no call site may reach past the slot to the badge");
});

test("the report payload names its own job, so the panel fetches the right one", () => {
  // ATSPanel scores on demand when it is handed no report — that is the answer to "backfill or per
  // request": per request, for the one posting being looked at, ~7ms. But it can only do that if it
  // knows WHICH posting, and it used to take that from `selectedJob`, the JD drawer's state. A card
  // click on a board with nothing selected therefore fetched nothing at all.
  assert.match(JOBS_PANEL, /jobId: job\?\.jobId \|\| job\?\.id \|\| null,/);
  assert.match(ATS_REPORT_PANEL, /const reportJobId = activeAts\?\.jobId \?\? jobId;/);
  assert.match(ATS_REPORT_PANEL, /jobId=\{reportJobId\}/);
});
