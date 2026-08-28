import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import {
  SORT_KEYS, RECENCY, TOTAL_ORDER_COLUMN,
  buildOrderKeys, orderByClause, cursorProjection, cursorPredicate,
  encodeCursor, decodeCursor, cursorColumn, assertTotalOrder, KEY,
} from "../services/jobs/jobCursor.js";

/**
 * KEYSET PAGINATION FOR /api/jobs.
 * ================================================================================================
 *
 * THE DEFECT, and it is not a performance argument.
 *
 * `LIMIT ? OFFSET ?` assumes a stable result set. The board is not stable, and the swipe feed makes
 * that structural: a dislike writes `disliked = 1`, and the default board EXCLUDES disliked rows.
 * So the set shrinks BEHIND the reader while they page through it, and offset paging skips exactly
 * as many rows as were removed. The user never sees them, `total` still counts them, and nothing
 * reports the loss.
 *
 * `page 2 skips what page 1 removed` below is the test that matters. It asserts the bug FIRST —
 * offset paging really does lose rows on this fixture — and then that the cursor does not. Without
 * the first half the second proves nothing: a cursor walk over an unchanging board would pass
 * trivially and the test would be measuring its own fixture.
 */

// ── A board with the properties that break naive cursors ───────────────────────────────────────
//
// Deliberately hostile in three ways, each of which has its own failure mode:
//
//   TIES on the leading key      a crawl writes its whole batch in one second, so discovered_at
//                                has a handful of distinct values across thousands of rows. If the
//                                cursor only compared the leading key it would loop or skip.
//   NULLs in a sorted column     posted_at is NULL for a third of rows. `=` yields NULL in SQLite,
//                                so a cursor using `=` for equality stops dead partway down the
//                                feed — reporting the end of the board in the middle of it.
//   an ENTIRELY NULL column      ats_score/salary/min_years_exp are never populated on a crawled
//                                board, so those sorts degenerate to the tie-break alone.
function board({ rows = 60 } = {}) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT,
      scraped_at INTEGER, discovered_at INTEGER, posted_at TEXT,
      is_active INTEGER DEFAULT 1,
      ats_score INTEGER, salary_min INTEGER, salary_max INTEGER,
      min_years_exp INTEGER, experience_level TEXT, applicant_count INTEGER
    );
    CREATE TABLE user_jobs (job_id TEXT PRIMARY KEY, disliked INTEGER DEFAULT 0);
  `);
  const ins = db.prepare(`INSERT INTO scraped_jobs
    (job_id,title,company,scraped_at,discovered_at,posted_at,experience_level,salary_max)
    VALUES (?,?,?,?,?,?,?,?)`);
  const LEVELS = ["intern", "entry", "mid", "senior", "lead", "executive"];
  for (let i = 0; i < rows; i++) {
    const batch = 1786000000 + (i % 3);          // three distinct timestamps across the whole board
    ins.run(
      `j${String(i).padStart(3, "0")}`, `Engineer ${i}`, `Co${i % 5}`,
      batch, batch,
      i % 3 === 0 ? null : `2026-0${1 + (i % 9)}-1${i % 10}T00:00:0${i % 10}Z`,
      i % 4 === 0 ? null : LEVELS[i % LEVELS.length],
      i % 5 === 0 ? null : 100000 + (i % 7) * 1000,
    );
    db.prepare("INSERT INTO user_jobs (job_id, disliked) VALUES (?, 0)").run(`j${String(i).padStart(3, "0")}`);
  }
  return db;
}

const WHERE = "WHERE sj.is_active = 1 AND COALESCE(uj.disliked,0) = 0";
const JOIN  = "FROM scraped_jobs sj LEFT JOIN user_jobs uj ON uj.job_id = sj.job_id";

/** The full ordering, as the board would render it in one shot. */
function fullOrder(db, keys) {
  const ob = orderByClause(keys), proj = cursorProjection(keys);
  return db.prepare(`SELECT sj.job_id ${proj.sql} ${JOIN} ${WHERE} ORDER BY ${ob.sql}`)
    .all(...proj.params, ...ob.params).map(r => r.job_id);
}

/** One page by cursor. Mirrors the server: fetch ps+1, trim, issue the next cursor. */
function cursorPage(db, keys, cursor, ps) {
  const ob = orderByClause(keys), proj = cursorProjection(keys);
  const pred = cursor ? cursorPredicate(keys, decodeCursor(cursor, keys).values) : null;
  const fetched = db.prepare(
    `SELECT sj.job_id ${proj.sql} ${JOIN} ${WHERE} ${pred ? "AND " + pred.sql : ""} ORDER BY ${ob.sql} LIMIT ?`
  ).all(...proj.params, ...(pred ? pred.params : []), ...ob.params, ps + 1);
  const hasMore = fetched.length > ps;
  const rows = hasMore ? fetched.slice(0, ps) : fetched;
  return { ids: rows.map(r => r.job_id), next: hasMore && rows.length ? encodeCursor(keys, rows[rows.length - 1]) : null };
}

/** One page by offset, exactly as the endpoint did before. */
function offsetPage(db, keys, pageNo, ps) {
  const ob = orderByClause(keys);
  return db.prepare(`SELECT sj.job_id ${JOIN} ${WHERE} ORDER BY ${ob.sql} LIMIT ? OFFSET ?`)
    .all(...ob.params, ps, (pageNo - 1) * ps).map(r => r.job_id);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE DEFECT
// ════════════════════════════════════════════════════════════════════════════════════════════

test("THE BUG: page 2 skips exactly what page 1 removed, and the cursor does not", () => {
  const keys = buildOrderKeys("dateDesc", []);
  const PS = 10;

  // ── offset paging, with a swipe between pages ──────────────────────────────────────────────
  const a = board();
  try {
    const expected = fullOrder(a, keys);          // what the user should eventually see, in order
    const page1 = offsetPage(a, keys, 1, PS);
    // The user swipes away 4 of the 10 they just saw. This is the ordinary case, not a stress test.
    const swiped = page1.slice(0, 4);
    for (const id of swiped) a.prepare("UPDATE user_jobs SET disliked=1 WHERE job_id=?").run(id);

    const page2 = offsetPage(a, keys, 2, PS);
    const seen = new Set([...page1, ...page2]);
    // Everything that WOULD have been on page 2 had nothing been removed.
    const shouldHaveSeen = expected.slice(0, PS * 2).filter(id => !swiped.includes(id));
    const skipped = shouldHaveSeen.filter(id => !seen.has(id));

    assert.equal(skipped.length, swiped.length,
      `precondition: offset paging must lose one row per removal. Swiped ${swiped.length}, ` +
      `skipped ${skipped.length}. If this ever reads 0 the fixture stopped reproducing the bug ` +
      `and the assertion below proves nothing.`);
  } finally { a.close(); }

  // ── the same swipe, paged by cursor ────────────────────────────────────────────────────────
  const b = board();
  try {
    const expected = fullOrder(b, keys);
    const p1 = cursorPage(b, keys, null, PS);
    const swiped = p1.ids.slice(0, 4);
    for (const id of swiped) b.prepare("UPDATE user_jobs SET disliked=1 WHERE job_id=?").run(id);

    const p2 = cursorPage(b, keys, p1.next, PS);
    const seen = new Set([...p1.ids, ...p2.ids]);
    const shouldHaveSeen = expected.slice(0, PS * 2).filter(id => !swiped.includes(id));
    const skipped = shouldHaveSeen.filter(id => !seen.has(id));

    assert.deepEqual(skipped, [],
      `the cursor skipped ${skipped.length} job(s) the user should have been shown: ${skipped.join(", ")}`);
  } finally { b.close(); }
});

test("a whole feed swiped away start to finish shows every job exactly once", () => {
  // The end-to-end version: swipe EVERY row as it is seen, which is the worst case for offset
  // paging (the set halves under the reader) and the normal case for a swipe feed.
  const db = board();
  try {
    const keys = buildOrderKeys("dateDesc", []);
    const all = new Set(fullOrder(db, keys));
    const seen = [];
    let cursor = null, guard = 0;
    while (guard++ < 200) {
      const { ids, next } = cursorPage(db, keys, cursor, 7);
      if (!ids.length) break;
      seen.push(...ids);
      for (const id of ids) db.prepare("UPDATE user_jobs SET disliked=1 WHERE job_id=?").run(id);
      if (!next) break;
      cursor = next;
    }
    assert.equal(new Set(seen).size, seen.length, "a job was shown twice");
    assert.equal(seen.length, all.size,
      `${all.size - seen.length} job(s) were never shown — the feed ended early`);
  } finally { db.close(); }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// EQUIVALENCE — the cursor must not change what the board shows, only how it is walked
// ════════════════════════════════════════════════════════════════════════════════════════════

test("on an UNCHANGING board a cursor walk equals the full ordering, for every sort", () => {
  for (const sort of Object.keys(SORT_KEYS)) {
    const db = board();
    try {
      const keys = buildOrderKeys(sort, []);
      const expected = fullOrder(db, keys);
      const seen = [];
      let cursor = null, guard = 0;
      while (guard++ < 200) {
        const { ids, next } = cursorPage(db, keys, cursor, 7);
        seen.push(...ids);
        if (!next) break;
        cursor = next;
      }
      assert.deepEqual(seen, expected, `sort "${sort}": cursor walk differs from the full ordering`);
      assert.equal(new Set(seen).size, seen.length, `sort "${sort}": a row appeared twice`);
    } finally { db.close(); }
  }
});

test("a NULL in a sorted column does not end the feed early", () => {
  // The `=` vs `IS` bug, isolated. SQLite's `=` yields NULL when either side is NULL, so a
  // lexicographic chain written with `=` evaluates to NULL — falsy — on the first row whose
  // posted_at is NULL. The feed would stop there and report the end of the board partway down it.
  // A third of this fixture has posted_at NULL, and they sort LAST, so the truncation lands in the
  // tail where it is easiest to mistake for a correct ending.
  const db = board();
  try {
    const keys = buildOrderKeys("dateDesc", []);
    const total = fullOrder(db, keys).length;
    const nulls = db.prepare("SELECT COUNT(*) n FROM scraped_jobs WHERE posted_at IS NULL").get().n;
    assert.ok(nulls > 5, "fixture must contain NULLs for this to test anything");

    const seen = [];
    let cursor = null, guard = 0;
    while (guard++ < 200) {
      const { ids, next } = cursorPage(db, keys, cursor, 7);
      seen.push(...ids);
      if (!next) break;
      cursor = next;
    }
    assert.equal(seen.length, total,
      `the walk returned ${seen.length} of ${total} rows — it stopped inside the NULL group`);
  } finally { db.close(); }
});

test("an entirely NULL sort column still walks the whole board", () => {
  // ats_score is never populated on a crawled board, so `atsScore` degenerates to the tie-break
  // alone. Every row is in the same NULL partition and the comparison rests entirely on RECENCY.
  const db = board();
  try {
    const keys = buildOrderKeys("atsScore", []);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM scraped_jobs WHERE ats_score IS NOT NULL").get().n, 0);
    const expected = fullOrder(db, keys);
    const seen = [];
    let cursor = null, guard = 0;
    while (guard++ < 200) {
      const { ids, next } = cursorPage(db, keys, cursor, 9);
      seen.push(...ids);
      if (!next) break;
      cursor = next;
    }
    assert.deepEqual(seen, expected);
  } finally { db.close(); }
});

test("the relevance prefix participates in the cursor, and only on the default sort", () => {
  // The derived profile-relevance keys lead the DEFAULT order. They carry BOUND PARAMS, and those
  // params appear in the SELECT projection, in the cursor predicate (twice per key, for the
  // comparison and the equality) and in the ORDER BY. Placeholder binding is positional, so a
  // mis-ordered param list here would not throw — it would return plausible wrong rows.
  const db = board();
  try {
    const rankKeys = [{ sql: "CASE WHEN sj.company = ? THEN 0 ELSE 1 END", params: ["Co2"] }];
    const keys = buildOrderKeys("dateDesc", rankKeys);
    assert.equal(keys.length, rankKeys.length + RECENCY.length, "the prefix was not applied");

    const expected = fullOrder(db, keys);
    // The relevance key really leads: every Co2 row comes before every non-Co2 row.
    const companyOf = (id) => db.prepare("SELECT company FROM scraped_jobs WHERE job_id=?").get(id).company;
    const firstOther = expected.findIndex(id => companyOf(id) !== "Co2");
    const lastCo2 = expected.map(companyOf).lastIndexOf("Co2");
    assert.ok(firstOther > 0 && lastCo2 < firstOther, "the relevance prefix did not lead the order");

    const seen = [];
    let cursor = null, guard = 0;
    while (guard++ < 200) {
      const { ids, next } = cursorPage(db, keys, cursor, 6);
      seen.push(...ids);
      if (!next) break;
      cursor = next;
    }
    assert.deepEqual(seen, expected, "the cursor lost track once relevance led the ordering");

    // A user-set sort is an instruction about ORDER and wins outright, so relevance must NOT lead.
    assert.equal(buildOrderKeys("compHigh", rankKeys).length, SORT_KEYS.compHigh.length,
      "relevance leaked into a user-chosen sort, which would rank an in-band $80k role above an " +
      "out-of-band $300k one and read as a broken control");
  } finally { db.close(); }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE CURSOR AS CLIENT INPUT
// ════════════════════════════════════════════════════════════════════════════════════════════

test("a cursor issued for one sort is REJECTED by another, rather than silently resuming", () => {
  // The dangerous case: reusing a cursor after changing the sort compares values that no longer
  // mean the same thing. Nothing errors at the SQL level — it returns an arbitrary slice. The
  // signature turns that into something the client can act on.
  const db = board();
  try {
    const byDate = buildOrderKeys("dateDesc", []);
    const p = cursorPage(db, byDate, null, 5);
    assert.ok(p.next, "fixture must produce a next cursor");

    const byPay = buildOrderKeys("compHigh", []);
    const decoded = decodeCursor(p.next, byPay);
    assert.equal(decoded.ok, false);
    assert.equal(decoded.error, "cursor_sort_mismatch");

    // And the same cursor is still valid for the ordering it was issued for.
    assert.equal(decodeCursor(p.next, byDate).ok, true);
  } finally { db.close(); }
});

test("a cursor is rejected when the relevance keys change, not just when the sort does", () => {
  // Relevance is derived from the user's profile. If the profile changes mid-feed the rank keys
  // change, the ordering changes, and a cursor issued under the old one is meaningless — but the
  // SORT is still 'dateDesc', so a signature keyed on the sort name alone would have accepted it.
  const db = board();
  try {
    const before = buildOrderKeys("dateDesc", [{ sql: "CASE WHEN sj.company = ? THEN 0 ELSE 1 END", params: ["Co2"] }]);
    const after  = buildOrderKeys("dateDesc", [{ sql: "CASE WHEN sj.bucket_domain = ? THEN 0 ELSE 1 END", params: ["saas"] }]);
    const p = cursorPage(db, before, null, 5);
    assert.equal(decodeCursor(p.next, after).error, "cursor_sort_mismatch");
  } finally { db.close(); }
});

test("malformed client input is a rejection, never a throw", () => {
  const keys = buildOrderKeys("dateDesc", []);
  for (const bad of ["", "not-base64!!", "e30", Buffer.from("null").toString("base64url"),
                     Buffer.from(JSON.stringify({ v: 99, k: [] })).toString("base64url"),
                     Buffer.from(JSON.stringify({ v: 1, s: "x", k: "nope" })).toString("base64url")]) {
    const out = decodeCursor(bad, keys);
    assert.equal(out.ok, false, `"${bad}" should have been rejected`);
    assert.ok(["cursor_malformed", "cursor_sort_mismatch"].includes(out.error), `unexpected: ${out.error}`);
  }
  // A cursor with the right signature but the wrong number of values must not build a predicate
  // with a mismatched param count, which would throw at query time rather than answer 400.
  assert.throws(() => cursorPredicate(keys, [1, 2]), /has 2 values but this ordering has/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE INVARIANT THE WHOLE THING RESTS ON
// ════════════════════════════════════════════════════════════════════════════════════════════

test("every ordering is TOTAL, and a sort that is not fails at import", () => {
  for (const [name, keys] of Object.entries(SORT_KEYS)) {
    assert.equal(keys[keys.length - 1].sql, TOTAL_ORDER_COLUMN,
      `sort "${name}" does not end in the primary key`);
  }
  // The guard is not merely documentation. jobCursor.js runs assertTotalOrder over every sort at
  // MODULE LOAD, so a future sort that ties cannot reach a request at all — the server fails to
  // start instead of paginating wrongly. Proven by calling it directly rather than trusting the
  // comment, since a loop that silently stopped running is the exact failure mode this repo's
  // harness runner exists to catch.
  assert.throws(
    () => assertTotalOrder([KEY("sj.company", "ASC")], "madeUpSort"),
    /does not end in sj\.job_id/,
    "a sort that does not end in the primary key must throw, not be accepted");
  // And the real ones pass it, so the guard is not vacuous.
  for (const [name, keys] of Object.entries(SORT_KEYS)) {
    assert.doesNotThrow(() => assertTotalOrder(keys, name));
  }
});

test("the ORDER BY and the cursor predicate are generated from ONE declaration", () => {
  // The property that makes this safe. If the ORDER BY were written separately from the cursor's
  // key list they would drift, and a cursor that disagrees with its ORDER BY does not error — it
  // returns wrong rows. So server.js must not contain a second copy of the ordering.
  const server = fs.readFileSync("server.js", "utf8");
  assert.ok(!/const RECENCY\s*=/.test(server),
    "server.js still declares its own RECENCY — the ordering must come from jobCursor.js alone");
  assert.ok(!/const chosenSort\s*=/.test(server),
    "server.js still builds its own ORDER BY chain");
  assert.match(server, /buildOrderKeys\(sort, richFilters\.rank\.keys\)/,
    "the handler must derive its ordering from the shared key lists");
  assert.match(server, /orderByClause\(orderKeys\)/);
  assert.match(server, /cursorProjection\(orderKeys\)/);

  // And the cursor values must come from the DATABASE evaluating the sort expressions, not from a
  // JS reimplementation of COALESCE/CASE — a second copy of the ordering by another name.
  assert.match(server, /\$\{cursorCols\.sql\}/,
    "the sort keys must be projected into the SELECT so SQLite computes the cursor's values");
});

test("the endpoint keeps offset paging working, and says which mode answered", () => {
  const server = fs.readFileSync("server.js", "utf8");
  // Offset paging is what client/ and extension/ use. Cursors are additive; removing OFFSET would
  // be a breaking change to two shipped consumers to fix a third that does not exist yet.
  assert.match(server, /OFFSET \?/, "offset paging must still work for the existing clients");
  assert.match(server, /paging: rawCursor \? 'cursor' : 'offset'/,
    "the response must say which mode answered — `page` is meaningless under a cursor, and a " +
    "client rendering 'page 1 of 34' on every cursor page is quietly wrong");
  assert.match(server, /nextCursor/, "the response must carry the next cursor");
  // ps + 1 is how hasMore becomes a fact rather than an inference.
  assert.match(server, /ps \+ 1/,
    "hasMore must be established by over-fetching one row; comparing rows.length to ps cannot " +
    "tell a full last page from a full page with more behind it");
});
