/**
 * BOARD ORDERING AND KEYSET PAGINATION — one definition, used for both.
 * ================================================================================================
 *
 * WHY OFFSET PAGING WAS WRONG HERE, AND IT IS NOT A PERFORMANCE ARGUMENT
 *
 * `LIMIT ? OFFSET ?` assumes the result set is STABLE between requests. The board is not, and the
 * swipe feed makes that structural rather than incidental: every dislike writes `disliked = 1`, and
 * the default board EXCLUDES disliked rows. So the set shrinks BEHIND the cursor while the user is
 * paging through it.
 *
 *   page 1 (offset 0, size 10)   rows 1..10       user swipes away 4 of them
 *   page 2 (offset 10)           was rows 11..20
 *                                is now rows 15..24    <- 11, 12, 13, 14 ARE NEVER SHOWN
 *
 * Four jobs vanished. Not filtered, not marked seen — skipped. The user never sees them, the count
 * still says they exist, and nothing reports the loss. A desktop board never hits this because it
 * does not mutate membership while paging; a swipe feed does nothing else.
 *
 * A keyset cursor asks a different question. Instead of "skip 10 rows" it asks "give me the rows
 * that sort strictly AFTER this one", anchored to the last row's own sort values. Deletions behind
 * the anchor cannot shift it, because the anchor is not a position — it is a value.
 *
 * THE PRECONDITION, AND WHY IT ALREADY HELD
 *
 * Keyset paging requires a TOTAL order: no two rows may tie on the full key list, or the cursor
 * cannot say where to resume. Every board sort already ends in `sj.job_id`, the primary key —
 * see test/boardOrderingTieBreak.test.js, which exists because the board once ordered by a bare
 * `scraped_at DESC` that tied across 1,275 rows. That fix is what makes this one possible, and the
 * dependency is now enforced rather than assumed (`assertTotalOrder` below).
 *
 * WHY THE ORDER BY MOVED HERE
 *
 * The cursor predicate must match the ORDER BY key-for-key and direction-for-direction. If they are
 * written twice they will disagree, and the failure is silent: a mismatched cursor does not error,
 * it just returns the wrong rows. That is the same defect shape as every other one this codebase
 * has hit — mapJobRow vs normalizeApiJob, three hardcoded tab lists, `tool` vs `toolType`.
 *
 * So the sorts are declared ONCE, as data, and both the ORDER BY string and the cursor predicate
 * are generated from that declaration. They cannot drift because there is nothing to drift from.
 */
"use strict";

/** One ORDER BY term. `sql` may be any expression; `params` binds placeholders inside it. */
const KEY = (sql, dir = "ASC", params = []) => ({ sql, dir, params });

/**
 * The "NULLs last" guard that precedes every keyed sort.
 *
 * It is a KEY in its own right, not a decoration, and that matters to the cursor: `(x IS NULL)` is
 * 0 or 1 and is never itself NULL, so it partitions the rows into a non-null group and a null group
 * before the comparison on `x` is ever reached. Within either group the comparison is well-defined.
 * Dropping it from the cursor key list — while leaving it in the ORDER BY — would resume in the
 * wrong partition.
 */
const NULLS_LAST = (sql) => KEY(`(${sql} IS NULL)`, "ASC");

// ── The orderings ────────────────────────────────────────────────────────────────────────────
//
// Transcribed from the strings these replace, term for term. The generated SQL is character-
// equivalent apart from an explicit `ASC` on the final job_id key, which was previously implicit.
//
// The leading key is discovered_at (FIRST SEEN), not scraped_at (last touched by a writer):
// upsertCanonicalJob rewrites scraped_at on every write, so the nightly crawl would otherwise sink
// every job that did not arrive in that batch — including a user's own import, measured at page 34
// of 34 minutes after they added it. COALESCE onto scraped_at because pre-pivot rows can lack
// discovered_at.
const RECENCY = [
  KEY("COALESCE(sj.discovered_at, sj.scraped_at)", "DESC"),
  NULLS_LAST("sj.posted_at"),
  KEY("sj.posted_at", "DESC"),
  KEY("sj.job_id", "ASC"),
];

// Undated postings stay last in BOTH directions: leading the "oldest" list with them would be an
// ordering by absence rather than by age.
const OLDEST = [
  KEY("COALESCE(sj.discovered_at, sj.scraped_at)", "ASC"),
  NULLS_LAST("sj.posted_at"),
  KEY("sj.posted_at", "ASC"),
  KEY("sj.job_id", "ASC"),
];

const LEVEL_RANK = `CASE sj.experience_level
        WHEN 'intern' THEN 0 WHEN 'entry' THEN 1 WHEN 'mid' THEN 2
        WHEN 'senior' THEN 3 WHEN 'lead' THEN 4 WHEN 'executive' THEN 5 END`;

// min_years_exp is written only by the extension capture, so on a crawled board it is entirely
// NULL and sorting on it alone would be a silent no-op. experience_level IS populated, by
// enrichment, from a fixed ordered vocabulary — so rank that, and let the precise number win
// wherever it exists.
const EXP = (dir) => [
  NULLS_LAST("sj.min_years_exp"),
  KEY("sj.min_years_exp", dir),
  NULLS_LAST(`(${LEVEL_RANK})`),
  KEY(`(${LEVEL_RANK})`, dir),
  ...RECENCY,
];

/**
 * Every sort the board offers, as key lists. Reconciled against shared/jobFilterOptions.js's SORTS
 * by test/filterOptionContract.test.js — an option with no entry here would silently fall through
 * to the default and read to the user as a dead control, which is what happened to compHigh,
 * compLow and dateAsc before they were implemented.
 */
const SORT_KEYS = {
  dateDesc:       RECENCY,
  dateAsc:        OLDEST,
  atsScore:       [NULLS_LAST("sj.ats_score"),       KEY("sj.ats_score", "DESC"),       ...RECENCY],
  applicantCount: [NULLS_LAST("sj.applicant_count"), KEY("sj.applicant_count", "ASC"),  ...RECENCY],
  compHigh:       [NULLS_LAST("sj.salary_max"),      KEY("sj.salary_max", "DESC"),      ...RECENCY],
  compLow:        [NULLS_LAST("sj.salary_min"),      KEY("sj.salary_min", "ASC"),       ...RECENCY],
  yoeLow:         EXP("ASC"),
  yoeHigh:        EXP("DESC"),
};

/** The column the ordering is guaranteed to end on. Nothing here works without it. */
const TOTAL_ORDER_COLUMN = "sj.job_id";

/**
 * Fail loudly rather than paginate wrongly.
 *
 * If a future sort is added that does NOT end in the primary key, its order is not total: rows tie,
 * SQLite is free to return a tie group in any order between queries, and a cursor built on it will
 * both repeat and skip rows — silently, because there is no error to raise at read time. Checking
 * it here turns that into a startup-time throw.
 */
function assertTotalOrder(keys, label) {
  const last = keys[keys.length - 1];
  if (!last || last.sql !== TOTAL_ORDER_COLUMN) {
    throw new Error(
      `sort "${label}" does not end in ${TOTAL_ORDER_COLUMN}, so its order is not total and a ` +
      `keyset cursor over it would repeat and skip rows`);
  }
  return keys;
}
for (const [name, keys] of Object.entries(SORT_KEYS)) assertTotalOrder(keys, name);

/**
 * The full key list for a request: the derived profile-relevance prefix (default sort only) then
 * the chosen sort.
 *
 * `rankKeys` are the INDIVIDUAL relevance expressions, not the pre-joined ORDER BY fragment. The
 * cursor has to compare them one at a time, so it needs them separately — which is why
 * buildJobFilters now exports `rank.keys` alongside `rank.sql`, with `rank.sql` derived FROM
 * `rank.keys` so the two cannot disagree.
 *
 * Relevance leads the DEFAULT order only. Choosing "Pay high to low" is a user-set instruction
 * about ORDER, so it wins outright; leaving the sort alone is not an instruction, so a derived key
 * may lead there. The client always sends a sort and its initial value is 'dateDesc', so absence
 * and 'dateDesc' are the same state.
 */
function buildOrderKeys(sort, rankKeys = []) {
  const chosen = SORT_KEYS[sort] || SORT_KEYS.dateDesc;
  const sortIsDefault = !sort || sort === "dateDesc";
  const prefix = sortIsDefault
    ? rankKeys.map(k => KEY(`(${k.sql})`, "ASC", k.params || []))
    : [];
  return [...prefix, ...chosen];
}

/** `expr DIR, expr DIR, ...` plus the params bound inside those expressions, in text order. */
function orderByClause(keys) {
  return {
    sql: keys.map(k => `${k.sql} ${k.dir}`).join(", "),
    params: keys.flatMap(k => k.params || []),
  };
}

/** Alias for the i-th sort key when projected into the SELECT. */
const cursorColumn = (i) => `__cursor_k${i}`;

/**
 * Project every sort key into the SELECT so the DATABASE computes the cursor's values.
 *
 * Deliberately not re-derived in JavaScript from the row. `COALESCE(discovered_at, scraped_at)` and
 * the experience-level CASE are SQL expressions; a JS reimplementation would be a second copy of
 * the ordering, which is the exact thing this module exists to prevent. Asking SQLite for the value
 * it actually sorted by makes the cursor correct by construction.
 */
function cursorProjection(keys) {
  return {
    sql: keys.map((k, i) => `, ${k.sql} AS ${cursorColumn(i)}`).join(""),
    params: keys.flatMap(k => k.params || []),
  };
}

/**
 * "Strictly after this row in this ordering", as a lexicographic expansion:
 *
 *     k0 OP v0
 *  OR (k0 IS v0 AND (k1 OP v1
 *  OR (k1 IS v1 AND (... kn OP vn))))
 *
 * OP is `>` for an ASC key and `<` for a DESC key.
 *
 * EQUALITY IS `IS`, NOT `=`, AND THAT IS LOAD-BEARING. SQLite's `=` yields NULL when either side is
 * NULL, so on a row whose posted_at is NULL the chain would evaluate to NULL — falsy — and the
 * cursor would silently stop mid-feed, reporting the end of the board partway down it. `IS` is
 * SQLite's null-safe equality: NULL IS NULL is true. The comparison operators keep `>`/`<`, where
 * NULL correctly yields "not after" and lets the next key decide.
 *
 * The final key is the primary key, so the deepest branch always resolves and no row can be
 * returned twice.
 */
function cursorPredicate(keys, values) {
  if (keys.length !== values.length) {
    throw new Error(`cursor has ${values.length} values but this ordering has ${keys.length} keys`);
  }
  const params = [];
  // Built from the innermost key outwards, then emitted outermost-first, so the params below land
  // in the same order the SQL text reads them — placeholder binding is positional, and getting this
  // backwards is the kind of bug that returns plausible-looking wrong rows.
  const build = (i) => {
    const k = keys[i];
    const op = k.dir === "DESC" ? "<" : ">";
    const after = `${k.sql} ${op} ?`;
    if (i === keys.length - 1) return { sql: after, params: [...(k.params || []), values[i]] };
    const rest = build(i + 1);
    return {
      sql: `(${after} OR (${k.sql} IS ? AND ${rest.sql}))`,
      params: [
        ...(k.params || []), values[i],      // the OP comparison
        ...(k.params || []), values[i],      // the IS equality
        ...rest.params,
      ],
    };
  };
  const built = build(0);
  params.push(...built.params);
  return { sql: built.sql, params };
}

/**
 * A cursor is opaque to the client and self-describing to the server.
 *
 * It carries a SIGNATURE of the ordering it was issued for. Reusing a cursor after changing the
 * sort — or after the profile's derived relevance changed, which alters the rank keys — would
 * otherwise resume against a different ordering and return an arbitrary slice with no error. The
 * signature turns that into a 400 the client can act on: re-request the first page.
 */
function orderSignature(keys) {
  return keys.map(k => `${k.sql}|${k.dir}`).join("~~");
}

function encodeCursor(keys, row) {
  const values = keys.map((_, i) => row[cursorColumn(i)]);
  const payload = { v: 1, s: hashSignature(orderSignature(keys)), k: values };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * @returns {{ ok: true, values: any[] } | { ok: false, error: string }}
 * Never throws on client input: a malformed cursor is a 400, not a 500.
 */
function decodeCursor(token, keys) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(token), "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "cursor_malformed" };
  }
  if (!payload || payload.v !== 1 || !Array.isArray(payload.k)) {
    return { ok: false, error: "cursor_malformed" };
  }
  if (payload.s !== hashSignature(orderSignature(keys))) {
    return { ok: false, error: "cursor_sort_mismatch" };
  }
  if (payload.k.length !== keys.length) {
    return { ok: false, error: "cursor_sort_mismatch" };
  }
  return { ok: true, values: payload.k };
}

/** Short, stable, and not a security boundary — a cursor is not a capability. */
function hashSignature(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export {
  SORT_KEYS, RECENCY, OLDEST, TOTAL_ORDER_COLUMN,
  buildOrderKeys, orderByClause, cursorProjection, cursorPredicate,
  encodeCursor, decodeCursor, cursorColumn, orderSignature, assertTotalOrder,
  KEY, NULLS_LAST,
};
