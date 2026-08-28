// The board's param contract, asserted by DERIVATION rather than by a hand-maintained list.
//
// Two bugs of the same family have shipped repeatedly here, and each time the fix was to add the
// newly-forgotten names to a list — which is why they kept recurring: the list is the thing that
// gets forgotten. These tests read the names out of buildParams itself, so a filter added tomorrow
// is covered without anyone remembering to update this file.
//
//   1. THE REFETCH DEPENDENCY ARRAY. FE-2 added filter fields to buildParams and left them out of
//      the refetch effect's dep array, so changing only a new filter built the right querystring
//      and never sent it. FE-3 fixed FE-2's fields; the tier work then added four more and pinned
//      exactly those four in test/jobsUiTierFilters.test.js. That test cannot catch a fifth, because
//      its NEW_FIELDS list is written by hand. This one can.
//
//   2. THE SERVER SIDE OF THE SAME CONTRACT. `starred` was emitted by buildParams for the Saved ★
//      tab from the day that tab existed, and GET /api/jobs destructured it nowhere and built no
//      clause for it — so the Saved tab silently returned the entire unfiltered board (measured: 27
//      of 27 rows for a user with zero starred rows). A param the client sends that the server does
//      not read is a dead control, and nothing failed when it happened.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const panel    = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
const server   = fs.readFileSync("server.js", "utf8");
const jobQuery = fs.readFileSync("services/jobs/jobQuery.js", "utf8");

const stripComments = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The contents of the dep array that immediately follows `anchor`. */
function depsAfter(anchor) {
  const a = panel.indexOf(anchor);
  assert.notEqual(a, -1, `anchor moved: ${anchor}`);
  const s = panel.indexOf("}, [", a);
  const e = panel.indexOf("]);", s);
  assert.ok(s !== -1 && e !== -1, `could not read the dep array after: ${anchor}`);
  return panel.slice(s + 4, e);
}

const identifiers = (t) => new Set(
  stripComments(t).split(/[^A-Za-z0-9_$]+/).filter(Boolean)
);

const BUILD_PARAMS_ANCHOR = "const buildParams = useCallback((page = 1";
const REFETCH_ANCHOR      = "// Re-fetch when server-side filters/sort/tab change";

/** Every querystring key buildParams can emit, read out of its body. */
function emittedParams() {
  const a = panel.indexOf(BUILD_PARAMS_ANCHOR);
  assert.notEqual(a, -1, "buildParams moved");
  const body = stripComments(panel.slice(a, panel.indexOf("}, [", a)));
  const params = [...body.matchAll(/p\.set\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(params.length > 20, `expected buildParams to emit many params, found ${params.length}`);
  return [...new Set(params)];
}

// `localSearch` is the ONE documented exemption: it feeds buildParams but is deliberately absent
// from the refetch effect, because it has its own 300ms-debounced effect right below it (which also
// has to call through fetchJobsRef rather than the captured fetchJobs — see the note there). Adding
// it to the refetch array would fire an extra unthrottled request per keystroke. Anything else
// appearing here is the FE-2/FE-3 bug returning, not a new exemption — extend this only with the
// reason written down.
const REFETCH_DEP_EXEMPT = new Set(["localSearch"]);

test("every state buildParams depends on is in the refetch effect's dep array (derived, not listed)", () => {
  const bp = identifiers(depsAfter(BUILD_PARAMS_ANCHOR));
  const rf = identifiers(depsAfter(REFETCH_ANCHOR));

  const missing = [...bp].filter((d) => !rf.has(d) && !REFETCH_DEP_EXEMPT.has(d));
  assert.deepEqual(
    missing, [],
    `these feed buildParams but are missing from the refetch effect's dep array, so changing only ` +
    `one of them builds a correct querystring that is never sent — the control looks dead: ` +
    missing.join(", "),
  );
});

test("the refetch effect and buildParams are both still findable by their anchors", () => {
  // If either anchor is renamed, both tests above go quietly green while guarding nothing. Pin them.
  assert.notEqual(panel.indexOf(BUILD_PARAMS_ANCHOR), -1);
  assert.notEqual(panel.indexOf(REFETCH_ANCHOR), -1);
});

test("every param buildParams emits is actually read by the server (the `starred` bug)", () => {
  // Deliberately NOT "does this word appear in the handler". `starred` appeared there throughout the
  // bug's whole life — as `uj.starred` in the SELECT list and in the response row — while being read
  // from req.query nowhere. A substring search over the handler passes on the broken code, so this
  // collects only the places a param can actually ARRIVE from:
  //   - the handler's `} = req.query;` destructuring block
  //   - explicit `req.query.<name>` reads
  //   - `params.<name>` reads in jobQuery.js, which is handed the merged query object
  const handlerStart = server.indexOf('app.get("/api/jobs", requireAuth');
  assert.notEqual(handlerStart, -1, "GET /api/jobs handler moved");
  const handler = stripComments(
    server.slice(handlerStart, server.indexOf('app.get("/api/jobs/generic"', handlerStart)),
  );

  const destructureEnd = handler.indexOf("} = req.query;");
  assert.notEqual(destructureEnd, -1, "the handler no longer destructures req.query");
  const destructured = identifiers(handler.slice(handler.indexOf("const {"), destructureEnd));

  const readNames = new Set([
    ...destructured,
    ...[...handler.matchAll(/req\.query\.([A-Za-z0-9_$]+)/g)].map((m) => m[1]),
    ...[...stripComments(jobQuery).matchAll(/params\.([A-Za-z0-9_$]+)/g)].map((m) => m[1]),
  ]);

  const unread = emittedParams().filter((p) => !readNames.has(p));
  assert.deepEqual(
    unread, [],
    `buildParams emits these but nothing reads them out of the query — they are dead controls that ` +
    `silently do nothing: ` + unread.join(", "),
  );
});

test("the Saved tab's starred param is bound to the requesting user's own flag", () => {
  // Specifically: it must read uj.starred (the per-user, per-profile LEFT JOIN), never sj.*, or the
  // Saved tab would show rows starred by somebody else.
  // `starred === '1'` now reads through the named `savedTab` flag, because the same condition also
  // exempts the tab from the role_key join, profileTitleSql and the profile bridge — one name, so
  // the four cannot drift apart. The invariant asserted here is unchanged: uj.starred, not sj.*.
  assert.match(server, /const savedTab = starred === '1';/);
  assert.match(server, /const starredSql = savedTab \? `AND uj\.starred = 1` : '';/);
  assert.match(server, /\$\{starredSql\}/, "starredSql is built but never spliced into the WHERE clause");
  // It binds no parameter, which is why it can sit anywhere in the clause without shifting baseArgs.
  assert.ok(!/starredArgs/.test(server), "starredSql must stay parameterless or baseArgs ordering shifts");
});

test("the three formerly-hard-NULL board columns use the soft-null pattern", () => {
  // work_type / employment_type / category are NULL on every ATS-crawled row, so a hard `= ?` took
  // the board to zero and read as "none exist" rather than "not classified yet". Same decision, and
  // deliberately the same shape, as jobQuery.js's workplace_type / experience_level / skills_json.
  assert.match(server, /AND \(sj\.work_type IS NULL OR sj\.work_type = \?\)/);
  assert.match(server, /AND \(sj\.employment_type IS NULL OR sj\.employment_type IN \(/);
  assert.match(server, /AND \(sj\.category IS NULL OR sj\.category = \?\)/);
  // `source` must NOT be soft-nulled — every writer sets it, and an escape there would make the
  // filter unable to exclude anything. jobQuery.js's sources_include comment records the same call.
  assert.ok(!/sj\.source\s+IS NULL OR/.test(server), "source must stay a hard match");
});

test("a multi-select employmentType is bound as an IN list, not a comma string against `=`", () => {
  // buildParams sends employmentTypePrefs.join(","), so a scalar `= ?` could never match
  // "full-time,contract" even with data present.
  assert.match(server, /const etValues = String\(employmentType\)\.split\(','\)/);
  assert.ok(
    !/AND sj\.employment_type = \?/.test(server),
    "the scalar employment_type comparison is back — a multi-select can never match it",
  );
});

test("the boot effect does not fetch /api/jobs — buildParams is the only param builder", () => {
  // The boot effect used to open with a hardcoded querystring, which is a second param builder: it
  // ignored every committed filter, carried neither of fetchJobs' staleness guards, and re-ran on
  // any ancestor re-render (its dep array is [user], and JobsConsole rebuilt `user` every render).
  // That combination is what reset the board to its first-load state on trivial interaction.
  const a = panel.indexOf("// -- Boot ---");
  assert.notEqual(a, -1, "the boot effect's comment anchor moved");
  const bootEffect = panel.slice(a, panel.indexOf("}, [user]);", a));
  assert.ok(
    !/api\("\/api\/jobs\?/.test(stripComments(bootEffect)),
    "the boot effect fetches /api/jobs with a hardcoded querystring again — that is the reset bug",
  );
});

test("every committed filter survives a reload (the persisted-key-list bug)", () => {
  // Fourth instance of the same family: writeProfileUiCache spelled out 15 key names and stopped at
  // ageFilter, so every filter added afterwards was dropped on reload. Measured in a browser: apply
  // Onsite, board 27 -> 4, reload, board back to 27 with the filter gone while the drawer still
  // showed it. Both the persist and the restore side are now derived from defaultFilterSnapshot, and
  // this asserts that derivation rather than a list of names.
  assert.match(panel, /\.\.\.Object\.keys\(defaultFilterSnapshot\(\)\)/,
    "writeProfileUiCache must derive its persisted keys from defaultFilterSnapshot, not re-list them");
  // The snapshot that feeds the cache has to carry the filters too, or there is nothing to persist.
  const makeStart = panel.indexOf("const makeProfileSnapshot = useCallback");
  assert.notEqual(makeStart, -1, "makeProfileSnapshot moved");
  const make = panel.slice(makeStart, panel.indexOf("const applyProfileSnapshot", makeStart));
  assert.match(make, /\.\.\.activeFilterSnapshot\(\)/,
    "makeProfileSnapshot must spread activeFilterSnapshot, or newer filters are never cached");
  // ...and the restore side must go through the shared writer.
  const restoreStart = panel.indexOf("const applyProfileSnapshot = useCallback");
  const restore = panel.slice(restoreStart, panel.indexOf("const fileRef", restoreStart));
  assert.match(restore, /applyFilterSnapshot\(snapshot\)/,
    "applyProfileSnapshot must restore through the shared writer, or reload drops newer filters");
});

test("an empty board always says which kind of empty it is", () => {
  // Three distinct causes, three distinct messages. A blank board has twice meant a NULL bug here,
  // so it must never again be ambiguous.
  assert.match(panel, /function FilteredEmptyState/);
  assert.match(panel, /Your filters exclude all jobs/);
  assert.match(panel, /function RoleScopedEmptyState/);
  assert.match(panel, /No jobs in your profile/);
  assert.match(panel, /Search for a role above/);
  assert.match(panel, /emptyBecauseFiltered/);
  assert.match(panel, /emptyBecauseRole/);
  // A board emptied only by the search box must land on the filtered message, not on "search above".
  assert.match(panel, /const narrowingCount\s+= activeFilterCount \+ \(searchActive \? 1 : 0\);/);
});

// ── The third end of the same contract: a saved search must restore what it saved ─────────────
//
// A tracked search stores buildParams' raw querystring. So a param buildParams emits and
// applyTrackedSearch never reads is silently dropped on apply, and the saved search comes back
// SUBTLY WIDER than the one that was saved — a filter the user set, saved, and then lost, with
// nothing anywhere reporting it. That comment is already in applyTrackedSearch for the four
// provider/tier params it happened to bite. This derives the check instead of listing it, for the
// same reason the two tests above do.
const TRACKED_SEARCH_EXEMPT = new Map([
  // Pagination, not a filter. A saved search restores a filter SET and always starts at page 1
  // (applyTrackedSearch sets currentPage itself).
  ["page", "pagination"],
  ["pageSize", "pagination"],
  // Pagination too, and the one it would be most damaging to restore. A cursor is bound to the
  // ORDERING it was issued under, so replaying a saved one would resume someone else's feed at a
  // position that no longer means anything — the server answers 400 cursor_sort_mismatch for
  // exactly this. A saved search restores a FILTER SET and starts at the beginning.
  ["cursor", "pagination, and bound to the ordering it was issued under"],
  // Derived from ageFilter, which IS restored — buildParams recomputes it from the same value, so
  // restoring it separately would be a second source of truth for one control.
  ["posted_after", "derived from ageFilter, which is restored"],
  // The Saved ★ tab is a VIEW, not a filter: it comes from boardTab. Applying a saved search must
  // not silently move the user to a different tab than the one they are looking at.
  ["starred", "boardTab is a view, not part of the filter set"],
  // A per-request opt-out of profile curation that is deliberately reset on every profile switch
  // (see the effect that clears it). Persisting it into a saved search would make it survive the
  // thing it is scoped to.
  ["curate", "per-request, and reset on profile switch by design"],
]);

test("every filter buildParams emits is restored by applyTrackedSearch (derived, not listed)", () => {
  const a = panel.indexOf("const applyTrackedSearch = useCallback");
  assert.notEqual(a, -1, "applyTrackedSearch moved");
  const body = stripComments(panel.slice(a, panel.indexOf("}, [activeDomainProfile]);", a)));
  const readKeys = new Set([
    ...[...body.matchAll(/p\.get\("([^"]+)"\)/g)].map((m) => m[1]),
    ...[...body.matchAll(/csv\("([^"]+)"\)/g)].map((m) => m[1]),
  ]);

  const dropped = emittedParams().filter((k) => !readKeys.has(k) && !TRACKED_SEARCH_EXEMPT.has(k));
  assert.deepEqual(
    dropped, [],
    `buildParams emits these and applyTrackedSearch does not restore them, so a saved search comes ` +
    `back wider than the one that was saved: ` + dropped.join(", "),
  );
});
