// Every control the search bar RENDERS must reach the board.
//
// test/jobsBoardParamContract.test.js already guards the chain from buildParams outward: a param
// buildParams emits must be in the refetch effect's dep array, and must be read by the server. That
// test derives its names from buildParams itself, which is what makes it durable — and also what
// makes it structurally blind to this bug:
//
//   UnifiedSearchBar's five controls (keyword, location, Experience, Domain, Status) were wired to
//   `onSearch={() => {}}` / `onLocalFilter={() => {}}` in App.jsx. Nothing they produced ever
//   reached buildParams, so buildParams emitted no param for them, so there was no name for the
//   contract test to follow and it passed on all 1,143 assertions while the app's most prominent
//   surface was completely inert. Measured on the real board before the fix: typing a keyword, the
//   local click, the live click, and each of the three selects produced ZERO /api/jobs requests.
//
// So this file starts from the OTHER end — the rendered controls — and follows each one forward.
// A control added to the bar tomorrow and wired to nothing fails here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const usb     = read("client/src/components/UnifiedSearchBar.jsx");
const app     = read("client/src/App.jsx");
const context = read("client/src/contexts/JobBoardContext.jsx");
const panel   = read("client/src/panels/JobsPanel.jsx");
const server  = read("server.js");

const stripComments = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

test("every field the bar publishes is destructured and mapped by the board", () => {
  // The published shape, read out of the bar rather than listed here, so a sixth field is covered
  // the day it is added.
  const m = stripComments(usb).match(/const params = \{([^}]+)\}/);
  assert.ok(m, "UnifiedSearchBar no longer builds a `params` object on click");
  const published = m[1]
    .split(",")
    .map((f) => f.split(":")[0].trim())
    .filter(Boolean);
  assert.deepEqual(
    [...published].sort(),
    ["domain", "experience", "location", "query", "status"],
    "the bar's published field set changed — the mapping effect in JobsPanel must change with it",
  );

  // Each one has to be destructured by the effect that applies barFilters to the board. A field
  // that is published and never read is the same dead control in a new place.
  const a = panel.indexOf("const { query = \"\", location = \"\", experience = \"\", domain = \"\", status = \"\" } = barFilters");
  assert.notEqual(a, -1, "JobsPanel's bar-filter mapping effect moved or changed shape");
  for (const field of published) {
    assert.ok(
      new RegExp(`\\b${field}\\b`).test(panel.slice(a, a + 1400)),
      `the bar publishes \`${field}\` and the board's mapping effect never reads it`,
    );
  }
});

test("the bar's handlers are real functions that reach the board's one channel", () => {
  // Not "are they present" — they were always present. They were `() => {}`.
  assert.ok(!/onSearch=\{\(\) => \{\}\}/.test(app), "onSearch is a no-op");
  assert.ok(!/onLocalFilter=\{\(\) => \{\}\}/.test(app), "onLocalFilter is a no-op");
  assert.match(app, /applyBarFilters\(params\)/);
  assert.match(app, /applyBarFilters\(params, \{ live: true \}\)/);
  // ...and that channel actually exists on the context both sides share.
  assert.match(context, /const applyBarFilters = useCallback/);
  assert.match(context, /barFilters, applyBarFilters, liveSearchTick,/);
});

test("the bar's wrapper sits inside JobBoardProvider, not above it", () => {
  // AppDashboard RENDERS <JobBoardProvider>, so a useJobBoard() call in AppDashboard itself reads a
  // null context and throws on destructure. The handlers therefore have to come from a component
  // rendered inside the provider — that is the only reason BoardSearchBar exists, and inlining it
  // back into AppDashboard would crash the dashboard.
  assert.match(app, /function BoardSearchBar\(props\) \{\s*const \{ applyBarFilters \} = useJobBoard\(\);/);
  const dashboard = app.slice(app.indexOf("function AppDashboard"));
  assert.ok(
    !/const \{[^}]*\} = useJobBoard\(\)/.test(dashboard.slice(0, dashboard.indexOf("<JobBoardProvider>"))),
    "AppDashboard calls useJobBoard above the provider it renders — that context is null",
  );
});

test("the live half of the double-click is keyed on a counter, not a boolean or the params", () => {
  // Two live searches for the same terms must both run. A boolean latches; keying on barFilters
  // would make an unchanged query a no-op the second time.
  assert.match(context, /const \[liveSearchTick, setLiveSearchTick\] = useState\(0\)/);
  assert.match(context, /if \(live\) setLiveSearchTick\(t => t \+ 1\)/);
  assert.match(panel, /\}, \[liveSearchTick\]\);/);
  // And it must not fire on mount — an aggregator search nobody asked for, on every board load.
  assert.match(panel, /if \(!liveSearchReady\.current\) \{ liveSearchReady\.current = true; return; \}/);
});

test("the bar's select values are vocabularies the database actually stores", () => {
  // Both lists were unmatchable on their face, and it did not show while they were wired to
  // nothing. EXP_OPTIONS held 'entry level' / 'mid level' / 'staff' / 'director' against a column
  // whose values are intern/entry/mid/senior/lead/executive; DOMAIN_OPTIONS held 'ai ml' against a
  // classifier that writes 'ai_ml'.
  const values = (name) => {
    const a = usb.indexOf(`const ${name} = [`);
    assert.notEqual(a, -1, `${name} moved`);
    return [...usb.slice(a, usb.indexOf("];", a)).matchAll(/\{ v: '([^']*)'/g)]
      .map((x) => x[1]).filter(Boolean);
  };

  // scraped_jobs.experience_level — the same vocabulary the FILTERS drawer's pills emit, so the two
  // controls cannot disagree about what "Senior" means.
  const EXPERIENCE_LEVELS = ["intern", "entry", "mid", "senior", "lead", "executive"];
  assert.deepEqual(values("EXP_OPTIONS").sort(), [...EXPERIENCE_LEVELS].sort());

  // classifyJob.js's DOMAIN_PATTERNS is the source of truth for bucket_domain, so read it rather
  // than restating it — an option the classifier cannot emit is a control that returns nothing.
  const classify = read("services/jobs/classifyJob.js");
  const emittable = new Set(
    [...classify.matchAll(/\{ domain: '([^']+)'/g)].map((m) => m[1]),
  );
  assert.ok(emittable.size >= 8, "DOMAIN_PATTERNS moved or shrank unexpectedly");
  for (const v of values("DOMAIN_OPTIONS")) {
    assert.ok(emittable.has(v), `the Domain select offers '${v}', which detectDomain can never emit`);
  }
  // 'general' is detectDomain's "matched nothing" fallback and must not be offered as a choice.
  assert.ok(!values("DOMAIN_OPTIONS").includes("general"));
});

test("Status fans out to three separate dimensions, each reset when it is not selected", () => {
  // One select, three unrelated filters. Switching Starred -> New has to leave the board on New
  // alone; a truthy-only assignment would leave it on both.
  const a = panel.indexOf('setBoardTab(status === "starred" ? "saved" : "all");');
  assert.notEqual(a, -1, "the Status mapping moved");
  const block = panel.slice(a, a + 260);
  assert.match(block, /setAgeFilter\(status === "new" \? "1d" : ""\)/);
  assert.match(block, /setAppliedFilter\(status === "applied" \? "1" : ""\)/);
});

test("the two params the bar newly needs are honoured by the server", () => {
  // jobsBoardParamContract.test.js proves the server READS every param buildParams emits. These two
  // additionally have to produce a real WHERE clause bound to the right column — `starred` was read
  // and unclaused for the whole life of that bug.
  assert.match(server, /const domSql\s+= domain \? `AND \(sj\.bucket_domain IS NULL OR sj\.bucket_domain = \?\)` : '';/);
  assert.match(server, /\$\{domSql\}/, "domSql is built but never spliced into the WHERE clause");
  assert.match(server, /\.\.\.catArgs, \.\.\.domArgs,/, "domArgs must sit with its clause or every later binding shifts");

  // applied reads the per-(user, profile) join, never sj.* — one user's record of what they did.
  assert.match(server, /const appliedSql = applied === '1' \? `AND uj\.applied = 1` : '';/);
  assert.match(server, /\$\{appliedSql\}/, "appliedSql is built but never spliced into the WHERE clause");
  assert.ok(!/appliedArgs/.test(server), "appliedSql must stay parameterless or baseArgs ordering shifts");
});
