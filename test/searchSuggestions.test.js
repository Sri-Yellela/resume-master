// Suggestions must come from the DATABASE, and the same role must not occupy three slots.
//
// The requirement is specific: typing "s" suggests "Software Engineer", "SWE" resolves to it as a
// normalised alias, and "Sr. Software Engineer" / "Senior Software Engineer" / "SWE" do NOT appear
// as three separate entries. Everything below is asserted against rows inserted into a real SQLite
// database, so a hand-maintained list of roles could not make these pass.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import {
  suggest, getSuggestionIndex, clearSuggestionCache, baseTitle, canonicalTitle, canonicalLocation,
} from "../services/jobs/searchSuggestions.js";

function db0(rows) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scraped_jobs (
      job_id TEXT PRIMARY KEY, title TEXT, normalized_title TEXT,
      location TEXT, is_active INTEGER DEFAULT 1
    );
    CREATE TABLE job_role_map (job_id TEXT, role_key TEXT);
  `);
  const j = db.prepare("INSERT INTO scraped_jobs (job_id,title,normalized_title,location,is_active) VALUES (?,?,?,?,?)");
  const m = db.prepare("INSERT INTO job_role_map (job_id,role_key) VALUES (?,?)");
  rows.forEach((r, i) => {
    const id = `j${i}`;
    j.run(id, r.title, r.normalized ?? null, r.location ?? null, r.active ?? 1);
    m.run(id, r.role ?? "engineering");
  });
  return db;
}

test.beforeEach(() => clearSuggestionCache());

test('typing "s" suggests Software Engineer, and it leads because it is the most common', () => {
  const db = db0([
    ...Array(5).fill({ title: "Software Engineer" }),
    ...Array(2).fill({ title: "Security Engineer" }),
    { title: "Solutions Architect" },
    { title: "Product Manager" },
  ]);
  const out = suggest(db, { roleKey: "engineering", field: "title", q: "s" });
  assert.equal(out[0], "Software Engineer", `expected Software Engineer first, got ${out.join(" | ")}`);
  assert.ok(out.includes("Security Engineer"));
  // Frequency ranking, not alphabetical: "Security Engineer" (2) must outrank "Solutions
  // Architect" (1), which alphabetical order would reverse.
  assert.ok(out.indexOf("Security Engineer") < out.indexOf("Solutions Architect"));
  // "Product Manager" contains no "s" at a word start and must not be here at all.
  assert.ok(!out.includes("Product Manager"));
});

test("Sr. / Senior / SWE collapse to ONE suggestion, not three", () => {
  // This is the requirement's own example. Each of these is a separate row in the database.
  const db = db0([
    { title: "Sr. Software Engineer" },
    { title: "Senior Software Engineer" },
    { title: "SWE" },
    { title: "Staff Software Engineer, Machine Learning Platform" },
    { title: "software engineer, trust" },
  ]);
  const out = suggest(db, { roleKey: "engineering", field: "title", q: "soft" });
  const hits = out.filter((s) => s.toLowerCase() === "software engineer");
  assert.equal(hits.length, 1, `expected exactly one Software Engineer entry, got: ${out.join(" | ")}`);
  // ...and all five rows counted toward that one entry.
  const idx = getSuggestionIndex(db, "engineering");
  const entry = idx.titles.find((t) => t.value === "Software Engineer");
  assert.equal(entry.count, 5, "the five variants must aggregate into one frequency, not five entries");
});

test('typing the alias "swe" finds the canonical role', () => {
  // The typed text goes through the same normalisation as the stored titles, so an abbreviation
  // reaches an entry built from rows that never contained it. Without that, ROLE_ALIAS_MAP would
  // only affect display.
  const db = db0([{ title: "Software Engineer" }, { title: "Data Scientist" }]);
  const out = suggest(db, { roleKey: "engineering", field: "title", q: "swe" });
  assert.ok(out.includes("Software Engineer"), `"swe" did not resolve; got ${out.join(" | ")}`);
});

test("suggestions are scoped to the active role and to live rows", () => {
  const db = db0([
    { title: "Software Engineer", role: "engineering" },
    { title: "Sales Engineer",    role: "sales" },        // another role's board
    { title: "Systems Engineer",  role: "engineering", active: 0 },  // retired
  ]);
  const out = suggest(db, { roleKey: "engineering", field: "title", q: "s" });
  assert.ok(out.includes("Software Engineer"));
  assert.ok(!out.includes("Sales Engineer"),  "a different role's titles leaked into this board");
  assert.ok(!out.includes("Systems Engineer"), "an inactive row was suggested — the board cannot then show it");
});

test("normalized_title is preferred, with title as the fallback", () => {
  const db = db0([
    { title: "SWE II - Payments (Remote)", normalized: "software engineer, payments" },
    { title: "Platform Engineer",          normalized: null },
    { title: "Ignored",                    normalized: "   " },   // blank normalisation falls back
  ]);
  const idx = getSuggestionIndex(db, "engineering");
  const values = idx.titles.map((t) => t.value);
  assert.ok(values.includes("Software Engineer"));
  assert.ok(values.includes("Platform Engineer"));
  assert.ok(values.includes("Ignored"), "a whitespace-only normalized_title must fall back to title");
});

test("locations are derived from the location column and ranked", () => {
  const db = db0([
    { title: "A", location: "Remote" }, { title: "B", location: "Remote" },
    { title: "C", location: "new york, ny" },
  ]);
  const out = suggest(db, { roleKey: "engineering", field: "location", q: "re" });
  assert.equal(out[0], "Remote");
  const ny = suggest(db, { roleKey: "engineering", field: "location", q: "new" });
  // All-lowercase input is title-cased; mixed case is left as written.
  assert.deepEqual(ny, ["New York, Ny"]);
});

test("zero matches returns an empty array — a normal state, not an error", () => {
  const db = db0([{ title: "Software Engineer" }]);
  assert.deepEqual(suggest(db, { roleKey: "engineering", field: "title", q: "zzzq" }), []);
  // An empty query does not even build an index.
  assert.deepEqual(suggest(db, { roleKey: "engineering", field: "title", q: "   " }), []);
});

test("the index is cached, so typing is not a query per keystroke", () => {
  const db = db0([{ title: "Software Engineer" }, { title: "Security Engineer" }]);
  let queries = 0;
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => { if (/FROM scraped_jobs/.test(sql)) queries++; return realPrepare(sql); };

  // A whole word typed one letter at a time.
  for (const q of ["s", "so", "sof", "soft", "softw", "softwa", "softwar", "software"]) {
    suggest(db, { roleKey: "engineering", field: "title", q });
  }
  assert.equal(queries, 1, `8 keystrokes must cost 1 query against the jobs table, cost ${queries}`);

  // Past the TTL it rebuilds rather than serving a stale board forever.
  suggest(db, { roleKey: "engineering", field: "title", q: "s", now: Date.now() + 6 * 60 * 1000 });
  assert.equal(queries, 2);
});

test("the cache is per role scope — one profile's titles cannot be served to another", () => {
  const db = db0([
    { title: "Software Engineer", role: "engineering" },
    { title: "Sales Director",    role: "sales" },
  ]);
  assert.ok(suggest(db, { roleKey: "engineering", field: "title", q: "s" }).includes("Software Engineer"));
  const sales = suggest(db, { roleKey: "sales", field: "title", q: "s" });
  assert.ok(sales.includes("Sales Director"));
  assert.ok(!sales.includes("Software Engineer"), "the engineering index was served to the sales scope");
});

test("baseTitle strips trailing specialisation but never a leading qualifier's meaning", () => {
  assert.equal(baseTitle("software engineer, machine learning platform"), "software engineer");
  assert.equal(baseTitle("Software Engineer (Remote)"), "Software Engineer");
  assert.equal(baseTitle("Software Engineer - Infrastructure"), "Software Engineer");
  assert.equal(baseTitle("Senior Staff Software Engineer"), "Software Engineer", "stacked seniority");
  // A TRAILING qualifier is a different job. "Engineering Manager" must not become "Engineering".
  assert.equal(canonicalTitle("Engineering Manager"), "Engineering Manager");
  // Too short to be a role.
  assert.equal(canonicalTitle("Sr."), "");
  assert.equal(canonicalLocation(""), "");
});

test("the scraping-era query builder is not wired into this path", () => {
  // buildApifyQueriesFromProfile is explicitly off-limits. Only normaliseRole — a pure string
  // function — is borrowed from that module.
  const src = fs.readFileSync("services/jobs/searchSuggestions.js", "utf8");
  assert.ok(!/buildApifyQueriesFromProfile/.test(src.replace(/\/\/.*$/gm, "")),
    "buildApifyQueriesFromProfile is wired into the suggestion path");
  assert.match(src, /import \{ normaliseRole \} from "\.\.\/searchQueryBuilder\.js"/);
});

test("the endpoint is additive, auth-gated, and never errors at the user", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /app\.get\("\/api\/jobs\/suggest", requireAuth/);
  // No active profile is answered with an empty list, not a 4xx: the board already reports
  // needsProfileSetup properly and a typeahead must not put an error under the input.
  const h = server.slice(server.indexOf('app.get("/api/jobs/suggest"'));
  const body = h.slice(0, h.indexOf("\n});"));
  assert.match(body, /if \(!profile\) return res\.json\(\{ suggestions: \[\] \}\)/);
  assert.match(body, /catch \(err\)[\s\S]*res\.json\(\{ suggestions: \[\] \}\)/);
  // Scoped to the caller's own active profile, never a role key from the query string.
  assert.match(body, /roleKey: roleKeyForProfile\(profile\)/);
  assert.ok(!/req\.query\.roleKey|req\.query\.role_key/.test(body));
});

// ── The input side of the contract ────────────────────────────────────────────────────────────
// Keyboard behaviour a typeahead has to get exactly right, because getting it wrong makes the
// field worse than having no suggestions at all.

const suggestUi = fs.readFileSync("client/src/components/UsbSuggest.jsx", "utf8");
const barUi     = fs.readFileSync("client/src/components/UnifiedSearchBar.jsx", "utf8");

test("Tab accepts the highlighted suggestion, and ONLY when one is highlighted", () => {
  // The requirement is explicit that Tab must not steal focus when nothing is highlighted. `active`
  // starts at -1 and is only moved by an arrow key or the pointer, so a user tabbing THROUGH the
  // field gets a plain Tab.
  assert.match(suggestUi, /if \(e\.key === "Tab"\) \{\s*\n\s*if \(open && active >= 0 && items\[active\]\) \{ e\.preventDefault\(\); accept\(items\[active\]\); \}/);
  assert.match(suggestUi, /const \[active, setActive\] = useState\(-1\)/);
});

test("Escape dismisses without altering the typed text", () => {
  const esc = suggestUi.slice(suggestUi.indexOf('if (e.key === "Escape")'));
  const block = esc.slice(0, esc.indexOf("\n    }"));
  assert.match(block, /dismiss\(\)/);
  assert.ok(!/onChange|accept\(/.test(block), "Escape changes the value — it must only close the list");
});

test("Enter still runs the search when the user is ignoring the list", () => {
  // The bar's Enter handler is what triggers a search. Intercepting Enter unconditionally would
  // make the list swallow it, so it is only taken when a row is actually highlighted...
  assert.match(suggestUi, /if \(active >= 0 && items\[active\]\) \{ e\.preventDefault\(\); accept\(items\[active\]\); \}\s*\n\s*else dismiss\(\);/);
  // ...and the bar chains its own handler behind, guarded on defaultPrevented.
  assert.match(barUi, /sugg\.onKeyDown\(e\); if \(!e\.defaultPrevented && e\.key === 'Enter'\) handleClick\(\)/);
});

test("input is debounced and stale responses cannot overwrite fresh ones", () => {
  assert.match(suggestUi, /const DEBOUNCE_MS = \d+;/);
  assert.match(suggestUi, /setTimeout\(async \(\) => \{/);
  assert.match(suggestUi, /return \(\) => clearTimeout\(timer\)/);
  // A slow response for "so" must not land after a fast one for "soft" and repopulate the list
  // with results for text that is no longer in the box.
  assert.match(suggestUi, /const mine = \+\+seq\.current;/);
  assert.match(suggestUi, /if \(mine !== seq\.current\) return;/);
});

test("zero suggestions renders nothing at all", () => {
  // Not an error, not an empty box: the list element is not in the tree.
  assert.match(suggestUi, /const showList = open && items\.length > 0 && !!rect;/);
  assert.match(suggestUi, /\{showList && \(/);
});

test("the list is portalled, because .usb__bar clips it", () => {
  // Measured: the list rendered with all eight rows and a correct rect and painted nothing,
  // because .usb__bar (overflow: hidden, for the bar's rounded corners) cut it off two levels up.
  const css = fs.readFileSync("client/src/components/UnifiedSearchBar.css", "utf8");
  assert.match(css, /\.usb__bar \{[^}]*overflow: hidden;/s,
    "if .usb__bar no longer clips, revisit the portal — but do not assume it does not");
  assert.match(suggestUi, /import \{ DockPortal \} from "\.\/DockPortal\.jsx"/);
  assert.match(suggestUi, /<DockPortal/);
});

test("accepting a suggestion only fills the box — search behaviour is unchanged", () => {
  // The double-click local->live pattern is the bar's, and must stay the bar's.
  assert.match(barUi, /const DCLICK_MS = 5000;/);
  assert.match(barUi, /if \(clicks\.current === 1\) \{/);
  // UsbSuggest reaches nothing but the caller's own setter.
  assert.ok(!/api\("\/api\/jobs\?|onSearch|onLocalFilter/.test(suggestUi),
    "the typeahead runs a search of its own — it must only propose text");
});

test("both free-text inputs get suggestions, from the field they belong to", () => {
  assert.match(barUi, /<UsbSuggest field="title" value=\{q\} onChange=\{setQ\}>/);
  assert.match(barUi, /<UsbSuggest field="location" value=\{loc\} onChange=\{setLoc\}>/);
});

test("a suggestion request can never force-log-out the app", () => {
  // lib/api.js's api() treats ANY 401 as session expiry: it clears the auth context and dispatches
  // rm:session-expired, which force-logs-out the shell. UnifiedSearchBar also renders on the PUBLIC
  // landing page, so routing the typeahead through api() meant every word typed by a logged-out
  // visitor fired that event. A suggestion that cannot be fetched is not an event in the
  // application's life.
  // Comments stripped: the note above the fetch helper names api() in order to explain why it is
  // NOT used, and a bare substring search would read that explanation as the defect.
  const code = suggestUi
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*(?:\/\/|\*).*$/gm, "");
  assert.ok(!/\bapi\(/.test(code),
    "the typeahead is back on lib/api.js's api(), which force-logs-out on 401");
  assert.match(suggestUi, /if \(r\.status === 401\) return \{ unauthorised: true, suggestions: \[\] \}/);
  // And once told 401, it stops asking — otherwise a logged-out visit spends a request per word.
  assert.match(suggestUi, /if \(unauthorised\.current\) return;/);
  assert.match(suggestUi, /if \(d\.unauthorised\) \{ unauthorised\.current = true;/);
  // Any other failure is silent too.
  assert.match(suggestUi, /if \(!r\.ok\) return \{ suggestions: \[\] \}/);
});
