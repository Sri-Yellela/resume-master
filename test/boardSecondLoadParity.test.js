// THE SECOND LOAD MUST RETURN THE SAME BOARD AS THE FIRST.
//
// Reported symptom: a second /app load in the same browser context showed an empty board over a
// server that had rows for it. It has now happened twice from two unrelated causes, and both times
// the empty board was indistinguishable from a legitimately empty one:
//
//   1. SOCKET STARVATION (fixed in 2e74e34 / 51792a8). Long-lived SSE connections spent the
//      browser's ~6-connections-per-origin HTTP/1.1 budget, so /api/jobs was ISSUED and never got a
//      socket — no response, no error, no timeout. test/syncEventsSingleConnection.test.js records
//      the measurement: loads 2, 6, 7 and 8 of eight showed 0 jobs over a 241-row board. The pool is
//      keyed by HOST and shared across TABS, so it latched and un-latched as a previous document's
//      sockets were reaped — which reads as "the second load" and sends you hunting for state that
//      persists between loads.
//   2. THE PERSISTED-KEY LIST (fixed earlier). writeProfileUiCache spelled out 15 key names and
//      stopped at ageFilter, so filters added afterwards were dropped on reload and the second load
//      queried a DIFFERENT filter set than the first.
//
// Every existing guard is on a CAUSE — connection counts, dep arrays, key derivation. Nothing
// asserted the SYMPTOM-level contract that both bugs violated: load the board twice in one context
// and the second load returns the same rows as the first. This file does, from the real pieces.
//
// Verified in a real browser against the production bundle on :3001 at the commit that adds this
// file: 8 concurrent documents on one origin, 1 SSE connection total, every /api/jobs started AND
// finished, 25 of 25 cards in all 8 — plus 5 sequential same-tab reloads, a hard reload, and an
// in-app navigation away and back, all 25.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { buildJobFilters } from "../services/jobs/jobQuery.js";
import { deriveProfileFilters } from "../services/jobs/profileFilterBridge.js";

// Normalised to LF on the way in. core.autocrlf is true here and there is no .gitattributes, so a
// fresh checkout gets CRLF in the working tree — and the slicing below looks for "\n}\n", which
// would silently become unfindable. That failure mode has already cost this project once (source
// text read by a test, git showing no diff, the test failing anyway), so it is handled at the read.
const panel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8").replace(/\r\n/g, "\n");

// ── The client's REAL persistence, executed rather than pattern-matched ───────────────────────
//
// readProfileUiCache / writeProfileUiCache / defaultFilterSnapshot are module-scope pure functions
// whose only dependency is localStorage, so the actual shipping code can be run here. Asserting the
// round trip BEHAVIOURALLY is what catches the persisted-key-list bug in its next form; a regex over
// the source only catches the spelling it was written for.
function loadPersistence() {
  const sliceFn = (header) => {
    const a = panel.indexOf(header);
    assert.notEqual(a, -1, `anchor moved: ${header}`);
    const e = panel.indexOf("\n}\n", a);
    assert.notEqual(e, -1, `could not find the end of: ${header}`);
    return panel.slice(a, e + 3);
  };
  const src = [
    `const PROFILE_UI_CACHE_KEY = "rm_jobs_profile_ui_v1";`,
    sliceFn("function defaultFilterSnapshot() {"),
    sliceFn("function readProfileUiCache(profileId) {"),
    sliceFn("function writeProfileUiCache(profileId, snapshot) {"),
  ].join("\n");
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  return new Function("localStorage", `${src}
    return { defaultFilterSnapshot, readProfileUiCache, writeProfileUiCache };`)(localStorage);
}

// The four non-filter board keys writeProfileUiCache persists alongside the filter set.
const BOARD_KEYS = ["boardTab", "localSearch", "sortBy", "currentPage"];

/** A non-default value for every filter, so a dropped key cannot pass by matching the default. */
function nonDefaultFilters(defaults) {
  const out = {};
  for (const [k, v] of Object.entries(defaults)) {
    if (Array.isArray(v)) out[k] = ["x-probe"];
    else if (typeof v === "boolean") out[k] = !v;
    else out[k] = "x-probe";
  }
  // employmentTypePrefs is the one key with a non-empty default, and buildParams treats
  // exactly ["full-time"] as "off" — so the probe has to differ from that, not merely be truthy.
  out.employmentTypePrefs = ["contract"];
  return out;
}

// ── A real board, so row COUNTS are real ─────────────────────────────────────────────────────
const NOW = 1_787_000_000;

function boardDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, company TEXT, location TEXT, source TEXT,
      normalized_title TEXT, summary TEXT, skills_json TEXT,
      experience_level TEXT, workplace_type TEXT, employment_type TEXT, automation_tier TEXT,
      salary_min_usd INTEGER, salary_max_usd INTEGER,
      is_h1b_sponsor INTEGER, requires_work_auth INTEGER, is_clearance_required INTEGER,
      posted_at TEXT, discovered_at INTEGER, scraped_at INTEGER, is_active INTEGER DEFAULT 1
    );
  `);
  // A deliberately bottom-heavy, mostly-unenriched board — the shape the real inventory has.
  const rows = [
    { job_id: "j-mid-1",    title: "Software Engineer",        experience_level: "mid" },
    { job_id: "j-mid-2",    title: "Backend Engineer",         experience_level: "mid" },
    { job_id: "j-mid-3",    title: "Platform Engineer",        experience_level: "mid" },
    { job_id: "j-senior-1", title: "Senior Software Engineer", experience_level: "senior" },
    { job_id: "j-exec-1",   title: "VP of Engineering",        experience_level: "executive" },
    { job_id: "j-null-1",   title: "Software Engineer II",     experience_level: null },
    { job_id: "j-null-2",   title: "Infrastructure Engineer",  experience_level: null },
  ];
  const insert = db.prepare(`INSERT INTO scraped_jobs
    (job_id, title, company, location, source, experience_level, discovered_at, scraped_at, is_active)
    VALUES (?,?,?,?,?,?,?,?,1)`);
  for (const r of rows) {
    insert.run(r.job_id, r.title, "Acme", "Remote", "ashby", r.experience_level, NOW, NOW);
  }
  return db;
}

/** One board load: build the fragment from these params and read the rows back. */
function load(db, params, opts = {}) {
  const f = buildJobFilters(params, opts);
  const ids = db
    .prepare(`SELECT sj.job_id FROM scraped_jobs sj WHERE sj.is_active = 1 ${f.sql} ORDER BY sj.job_id`)
    .all(...f.params)
    .map((r) => r.job_id);
  return { ids, count: ids.length, sql: f.sql, params: f.params };
}

// ── 1. The headline contract ─────────────────────────────────────────────────────────────────

test("two consecutive board loads in one context return the same rows", () => {
  const db = boardDb();
  const profile = { target_titles: JSON.stringify(["Software Engineer"]) };
  const simple  = { titles: ["Software Engineer"], skills: ["Python"], yearsExperience: 3 };
  const derivedKeys = ["q", "skills_include", "experience_levels"];

  // Each load re-derives from the profile exactly as GET /api/jobs does per request — nothing is
  // carried over, which is the property that makes a second load reproducible.
  const first  = load(db, deriveProfileFilters(profile, simple), { derivedKeys });
  const second = load(db, deriveProfileFilters(profile, simple), { derivedKeys });

  assert.ok(first.count > 0, "premise: the first load must return rows, or this test is vacuous");
  assert.equal(second.count, first.count,
    `the second load returned ${second.count} rows where the first returned ${first.count} — ` +
    "a second load must never return a different board than the first");
  assert.deepEqual(second.ids, first.ids, "the second load returned a different row SET");
  assert.equal(second.sql, first.sql, "the second load built different SQL from identical inputs");
  assert.deepEqual(second.params, first.params, "the second load bound different params");
});

// ── 2. The client half: the second load's filters are the first load's filters ────────────────

test("every filter survives the persist/restore round trip a reload performs", () => {
  const { defaultFilterSnapshot, readProfileUiCache, writeProfileUiCache } = loadPersistence();
  const defaults = defaultFilterSnapshot();
  assert.ok(Object.keys(defaults).length >= 20,
    `premise: expected the full filter vocabulary, found ${Object.keys(defaults).length}`);

  const board = { boardTab: "saved", localSearch: "engineer", sortBy: "relevance", currentPage: 4 };
  const snapshot = { ...board, ...nonDefaultFilters(defaults) };

  writeProfileUiCache(5, snapshot);
  const restored = readProfileUiCache(5);
  assert.ok(restored, "nothing was restored — the second load would start from defaults");

  // Derived from defaultFilterSnapshot, so a filter added tomorrow is covered without editing this.
  const dropped = [...Object.keys(defaults), ...BOARD_KEYS].filter(
    (k) => JSON.stringify(restored[k]) !== JSON.stringify(snapshot[k]),
  );
  assert.deepEqual(dropped, [],
    `these keys did not survive a reload: ${dropped.join(", ")}. The second load would query a ` +
    "different filter set than the first, so the board silently comes back different — that is " +
    "the persisted-key-list bug, whose whole history is being fixed by adding names to a list.");
});

test("the restore is scoped to its own profile, so a second load cannot inherit another's board", () => {
  const { defaultFilterSnapshot, readProfileUiCache, writeProfileUiCache } = loadPersistence();
  writeProfileUiCache(5, { ...defaultFilterSnapshot(), boardTab: "saved", localSearch: "five" });
  writeProfileUiCache(6, { ...defaultFilterSnapshot(), boardTab: "all",   localSearch: "six"  });
  assert.equal(readProfileUiCache(5).localSearch, "five");
  assert.equal(readProfileUiCache(6).localSearch, "six");
  assert.equal(readProfileUiCache(7), null,
    "an unknown profile must restore nothing, not another profile's board");
});

// ── 3. X2 provenance has to survive the reload too ───────────────────────────────────────────

test("a filter derived for the user still only RANKS after a reload — it never starts excluding", () => {
  // X2's rule: a filter the USER set excludes rows; a filter DERIVED for them ranks them. The
  // client persists only its own committed (explicit) filter state, and the server re-derives from
  // the profile on every request — so provenance cannot be laundered by a round trip. Guarded here
  // because a persisted derived value would come back as an explicit one, and an explicit
  // experience_levels on this bottom-heavy board is exactly what used to empty it.
  const { defaultFilterSnapshot } = loadPersistence();
  const persistedKeys = new Set([...Object.keys(defaultFilterSnapshot()), ...BOARD_KEYS]);
  for (const derivedOnly of ["q", "skills_include", "experience_levels", "sponsorship_friendly"]) {
    assert.equal(persistedKeys.has(derivedOnly), false,
      `${derivedOnly} is a BRIDGE-derived dimension and must not be persisted as a client filter — ` +
      "restoring it would promote a guess about relevance into a statement of intent");
  }

  // And the consequence, measured rather than asserted from the rule: the same value ranks when
  // derived and excludes when explicit.
  const db = boardDb();
  const asDerived  = load(db, { experience_levels: ["executive"] }, { derivedKeys: ["experience_levels"] });
  const asExplicit = load(db, { experience_levels: ["executive"] });
  assert.equal(asDerived.count, 7, "a DERIVED experience level must keep every row and only reorder");
  assert.ok(asExplicit.count < asDerived.count,
    "premise: an EXPLICIT experience level must actually narrow, or this test proves nothing");
});

// ── 4. The tripwire for the cause that actually produced the reported symptom ─────────────────

test("the app opens at most one long-lived connection per origin", () => {
  // The reported empty board was a starved socket, not an empty answer. The budget is ~6 per HOST
  // and is shared across TABS, so ANY new permanently-open connection anywhere in the client can
  // reintroduce it — and the symptom (issued, never socketed) is invisible to the app: no response,
  // no error, no timeout. syncEventsSingleConnection.test.js guards useSyncEvents' own accounting;
  // this guards the thing that guard cannot see, namely a SECOND long-lived connection added
  // somewhere else entirely.
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(js|jsx)$/.test(e.name)) files.push(p);
    }
  };
  walk("client/src");
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const opens = (re) => files.filter((f) => re.test(stripComments(fs.readFileSync(f, "utf8"))));

  const eventSourceOwners = opens(/new\s+EventSource\s*\(/);
  assert.deepEqual(eventSourceOwners, ["client/src/hooks/useSyncEvents.js"],
    `EventSource is constructed in ${eventSourceOwners.length} modules: ${eventSourceOwners.join(", ")}. ` +
    "Exactly one module may own it — a per-caller or per-tab stream spends the origin's socket " +
    "budget and /api/jobs is left queued for a socket that never comes free.");

  const socketOwners = opens(/new\s+WebSocket\s*\(/);
  assert.deepEqual(socketOwners, [],
    `a WebSocket was added in ${socketOwners.join(", ")} — it is permanently open and counts against ` +
    "the same ~6-per-host budget as the SSE stream. Relay over the existing BroadcastChannel instead.");

  // The stream must be elected origin-wide, not opened per document. Without the lock, six tabs is
  // six streams and the seventh document cannot even fetch its HTML.
  const hook = fs.readFileSync("client/src/hooks/useSyncEvents.js", "utf8");
  assert.match(hook, /navigator\.locks/,
    "the single stream is elected with a Web Lock; without it the limit is one stream per TAB, " +
    "which starved the origin at six tabs");
  assert.match(hook, /BroadcastChannel/,
    "follower documents must be RELAYED the events, not disconnected — a hidden tab that misses " +
    "job_flag/profile_switched comes back silently wrong");
});
