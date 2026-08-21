// THE FILTER OPTION CONTRACT, RECONCILED IN BOTH DIRECTIONS.
//
// A board filter is a contract with two sides: the `value` a control emits, and the value the
// column actually holds. When they do not meet, nothing errors — the filter returns zero rows,
// which reads to the user as "there are no such jobs". Three of those have shipped:
//
//     the control said       the writer emits        lifetime
//     'mid level'            'mid'                   until W1
//     'ai ml'                'ai_ml'                 until W1
//     'LinkedIn'             'linkedin_extension'    until X1 (this test found it)
//
// So this is the guard, not the documentation. It is the same shape as
// test/privacyReconciliation.test.js: the join is asserted, and an ORPHAN IN EITHER DIRECTION
// FAILS —
//
//     a UI option with no possible DB value     -> a control that can never match
//     a DB value in use with no UI option       -> rows the user cannot filter for or against
//
// "No possible DB value" is deliberately about the WRITERS, not about today's row counts. Several
// providers have zero rows on this database and are still offered, with a live "(0)" beside them
// from jobQuery.js's `sources` facet — an empty provider is a fact about the data, not a dead
// control, and a test keyed on row counts would fail every time the board emptied.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  FILTER_DIMENSIONS, EXPERIENCE_LEVELS, DOMAINS, WORK_MODELS, EMPLOYMENT_TYPES,
  SOURCES, AUTOMATION_TIERS, SORTS, POSTING_AGE, VISITED, BOARD_STATUS,
  values, allValues, dbOnlyValues, valueSet, labelFor, labelMap, isValid, invalidEntries,
  ageDays, ageDaysMap, EXPERIENCE_LEVEL_ORDER,
} from "../shared/jobFilterOptions.js";

const read = (p) => fs.readFileSync(p, "utf8");

// ── Shape ──────────────────────────────────────────────────────────────────────────────────────

test("every dimension is registered, and every registered dimension is well formed", () => {
  // A dimension defined but not registered in FILTER_DIMENSIONS would be unguarded by everything
  // below AND unvalidated by the server, which is the worst of both.
  const exported = { EXPERIENCE_LEVELS, DOMAINS, WORK_MODELS, EMPLOYMENT_TYPES, SOURCES,
                     AUTOMATION_TIERS, SORTS, POSTING_AGE, VISITED, BOARD_STATUS };
  const registered = new Set(Object.values(FILTER_DIMENSIONS));
  for (const [name, dim] of Object.entries(exported)) {
    assert.ok(registered.has(dim), `${name} is exported but not in FILTER_DIMENSIONS`);
  }
  assert.equal(Object.keys(FILTER_DIMENSIONS).length, Object.keys(exported).length);

  for (const [name, dim] of Object.entries(FILTER_DIMENSIONS)) {
    assert.ok(Array.isArray(dim.options) && dim.options.length, `${name} has no options`);
    assert.ok(typeof dim.param === "string" && dim.param, `${name} has no query param`);
    const seen = new Set();
    for (const o of dim.options) {
      assert.equal(typeof o.value, "string", `${name} option value is not a string`);
      assert.ok(o.label, `${name} option "${o.value}" has no label`);
      assert.ok(!seen.has(o.value), `${name} lists "${o.value}" twice`);
      seen.add(o.value);
    }
    // dbOnly carries a REASON, in data. Rule 3 of the contract: "why is this not a filter?" has to
    // have an answer next to it, or the exemption is indistinguishable from an oversight.
    for (const d of dim.dbOnly || []) {
      assert.ok(d.value, `${name} has a dbOnly entry with no value`);
      assert.ok(d.label, `${name} dbOnly "${d.value}" has no label`);
      assert.ok(d.why && d.why.length > 40,
        `${name} dbOnly "${d.value}" has no real reason — an unexplained exemption is an oversight`);
      assert.ok(!seen.has(d.value),
        `${name} lists "${d.value}" as BOTH an option and dbOnly — it is one or the other`);
    }
  }
});

test("no option value is a humanised string", () => {
  // This is the 'mid level' / 'ai ml' shape itself: a value with a space in it is a label that got
  // into the value column. Underscores are fine — `ai_ml` and `linkedin_extension` are real
  // writer values. `full-time` is real too. A SPACE never is.
  for (const [name, dim] of Object.entries(FILTER_DIMENSIONS)) {
    for (const v of allValues(dim)) {
      assert.ok(!/\s/.test(v), `${name} value "${v}" contains whitespace — that is a label`);
    }
  }
});

// ── Direction 1: a UI option with no DB counterpart ────────────────────────────────────────────

test("experience level: every option is a value the WRITERS can store", () => {
  // schema.js's normalizeExperienceLevel and enrichJob.js's coerceEnum both take their enum from
  // the contract now, so the join is by construction — but assert the return trip, because the
  // point is that a future edit to either writer cannot silently narrow it.
  const schema  = read("services/jobs/schema.js");
  const enrich  = read("services/jobs/enrichJob.js");
  assert.match(schema, /const VALID_EXPERIENCE_LEVELS = valueSet\(EXPERIENCE_LEVELS\)/,
    "schema.js re-typed the experience-level enum instead of reading the contract");
  assert.match(enrich, /const VALID_EXPERIENCE_LEVELS = valueSet\(EXPERIENCE_LEVELS\)/,
    "enrichJob.js re-typed the experience-level enum instead of reading the contract");

  // normalizeExperienceLevel's own return values are literals in its regex ladder, so they are a
  // real second vocabulary and have to be reconciled rather than assumed.
  const ladder = schema.slice(schema.indexOf("function normalizeExperienceLevel"),
                             schema.indexOf("const VALID_WORKPLACE_TYPES"));
  const returned = [...ladder.matchAll(/return '([a-z_]+)'/g)].map(m => m[1]);
  assert.ok(returned.length >= 6, `expected the ladder's returns, found ${returned.length}`);
  for (const level of returned) {
    assert.ok(valueSet(EXPERIENCE_LEVELS).has(level),
      `normalizeExperienceLevel can return "${level}", which no control offers`);
  }
  // And the other direction: every offered level is one the ladder or an explicit source value can
  // produce. `executive` and `intern` come from the ladder; all six are in VALID_EXPERIENCE_LEVELS,
  // which is the set an explicit source value is accepted against.
  for (const v of values(EXPERIENCE_LEVELS)) {
    assert.ok(valueSet(EXPERIENCE_LEVELS).has(v), `"${v}" is offered but not storable`);
  }
});

test("domain: the control and classifyJob's DOMAIN_PATTERNS name the same domains", () => {
  // DOMAIN_PATTERNS keeps its own table because a domain is inseparable from the regex that detects
  // it. That makes this a genuine two-sided join rather than a tautology — and it is the join that
  // 'ai ml' vs 'ai_ml' failed.
  const classify = read("services/jobs/classifyJob.js");
  const block = classify.slice(classify.indexOf("const DOMAIN_PATTERNS"),
                              classify.indexOf("function detectDomain"));
  const detected = [...block.matchAll(/domain: '([a-z_]+)'/g)].map(m => m[1]);
  assert.ok(detected.length >= 8, `expected DOMAIN_PATTERNS entries, found ${detected.length}`);

  const offered = new Set(values(DOMAINS));
  for (const d of detected) {
    assert.ok(offered.has(d) || dbOnlyValues(DOMAINS).includes(d),
      `classifyJob writes bucket_domain="${d}", which no control offers and which is not ` +
      `declared dbOnly — rows carrying it cannot be filtered for or against`);
  }
  for (const d of offered) {
    assert.ok(detected.includes(d),
      `the Domain select offers "${d}", which detectDomain can never write — the option can only ` +
      `ever return zero rows, exactly as 'ai ml' did`);
  }

  // detectDomain's fallback specifically. It IS a value in use (714 rows), so it must be declared.
  assert.match(classify, /return 'general';/);
  assert.ok(dbOnlyValues(DOMAINS).includes("general"),
    "detectDomain falls back to 'general' — it has to be declared dbOnly or offered");
});

test("work model: the control and the two writers agree", () => {
  for (const [file, src] of [["schema.js", read("services/jobs/schema.js")],
                             ["enrichJob.js", read("services/jobs/enrichJob.js")]]) {
    assert.match(src, /VALID_WORKPLACE_TYPES\s*=\s*valueSet\(WORK_MODELS\)/,
      `${file} re-typed the workplace-type enum instead of reading the contract`);
  }
  // normalizeWorkplaceType's ladder is a second vocabulary, same as the experience one.
  const schema = read("services/jobs/schema.js");
  const ladder = schema.slice(schema.indexOf("function normalizeWorkplaceType"),
                              schema.indexOf("function normalizeSalaryPeriod"));
  const returned = [...ladder.matchAll(/return '([a-z]+)'/g)].map(m => m[1]);
  for (const v of returned) {
    assert.ok(valueSet(WORK_MODELS).has(v),
      `normalizeWorkplaceType can return "${v}", which no control offers`);
  }
});

test("employment type: the control matches what the synonym table maps ONTO", () => {
  // The canonical set is the set of VALUES in EMPLOYMENT_TYPE_SYNONYMS, not its keys. `temporary`
  // is a KEY that maps to `contract`, so the column can never hold it — and server.js's dead
  // VALID_EMP_TYPES listed it as valid anyway, which is what a validation set nothing reads
  // decays into.
  const schema = read("services/jobs/schema.js");
  const block = schema.slice(schema.indexOf("const EMPLOYMENT_TYPE_SYNONYMS"),
                             schema.indexOf("function normalizeEmploymentType"));
  const canonical = new Set([...block.matchAll(/:\s*'([a-z-]+)'/g)].map(m => m[1]));
  assert.ok(canonical.size >= 4, `expected canonical employment types, found ${canonical.size}`);

  for (const v of canonical) {
    assert.ok(valueSet(EMPLOYMENT_TYPES).has(v),
      `the synonym table can store "${v}", which no control offers`);
  }
  for (const v of values(EMPLOYMENT_TYPES)) {
    assert.ok(canonical.has(v),
      `the Employment Type control offers "${v}", which the synonym table can never produce`);
  }
  assert.ok(!valueSet(EMPLOYMENT_TYPES).has("temporary"),
    "'temporary' is a synonym key that folds into 'contract' — the column cannot hold it");
});

test("provider: the control and every registered source plugin agree", async () => {
  // THIS IS THE ONE THAT FOUND THE THIRD 'mid level'. The drawer offered `LinkedIn`; the writer
  // value is `linkedin_extension`. It also omitted four registered plugins outright.
  const { SOURCE_LABELS } = await import("../services/jobs/aggregator.js");

  // SOURCE_LABELS is derived from the contract now, so assert that rather than a value list — a
  // re-typed literal map is what let the two drift.
  assert.match(read("services/jobs/aggregator.js"),
    /export const SOURCE_LABELS = labelMap\(SOURCES_DIMENSION\)/,
    "aggregator.js re-typed the provider labels instead of deriving them");
  assert.deepEqual(SOURCE_LABELS, labelMap(SOURCES));

  // The plugin files are the writers. Every `source:` literal they emit must be filterable.
  const emitted = new Set();
  for (const f of fs.readdirSync("services/jobs/sources")) {
    if (!f.endsWith(".js") || f === "base.js") continue;
    for (const m of read(`services/jobs/sources/${f}`).matchAll(/source:\s*'([a-z_]+)'/g)) {
      emitted.add(m[1]);
    }
  }
  for (const m of read("services/jobs/importJob.js").matchAll(/source:\s*'([a-z_]+)'/g)) {
    emitted.add(m[1]);
  }
  assert.ok(emitted.size >= 10, `expected source plugin values, found ${[...emitted].join(",")}`);

  for (const v of emitted) {
    assert.ok(valueSet(SOURCES).has(v),
      `a source plugin writes source="${v}", which the provider control neither offers nor ` +
      `declares dbOnly — those rows cannot be filtered for or against`);
  }
  for (const v of values(SOURCES)) {
    assert.ok(emitted.has(v) || v === "linkedin_extension",
      `the provider control offers "${v}", which no writer emits — it can only return zero rows. ` +
      `('linkedin_extension' is written by the extension's capture path, not by a plugin file.)`);
  }
  assert.ok(!values(SOURCES).includes("LinkedIn"),
    "the provider control offers 'LinkedIn' again — no writer has ever emitted that");
});

test("automation tier: the control and automationTier.js are one list, in one order", async () => {
  const mod = await import("../services/jobs/automationTier.js");
  assert.deepEqual(mod.AUTOMATION_TIERS, values(AUTOMATION_TIERS),
    "the tier vocabulary and the tier control disagree, or have drifted in ORDER — the order is " +
    "decreasing confidence and the drawer renders it directly");
  assert.match(read("services/jobs/automationTier.js"),
    /const AUTOMATION_TIERS = values\(AUTOMATION_TIER_OPTIONS\)/,
    "automationTier.js re-typed the tier list");
  // Every tier PLATFORM_TIER can assign must be one the control offers.
  const mapped = new Set(Object.values(mod.PLATFORM_TIER));
  for (const t of mapped) {
    assert.ok(valueSet(AUTOMATION_TIERS).has(t),
      `PLATFORM_TIER assigns "${t}", which no control offers`);
  }
  // The hints are load-bearing, not decoration — "account" is the one that changes what the user
  // has to do. A tier without one is a tier the user cannot act on.
  for (const o of AUTOMATION_TIERS.options) {
    assert.ok(o.hint && o.hint.length > 10, `tier "${o.value}" lost its explanation`);
  }
});

test("sort: every option is an ordering the handler implements", () => {
  const server = read("server.js");
  const chain = server.slice(server.indexOf("const orderBy = sort ==="),
                             server.indexOf("const offset  = (pg - 1) * ps;"));
  assert.ok(chain.length > 100, "the ORDER BY chain moved");
  const implemented = new Set([...chain.matchAll(/sort === '([A-Za-z]+)'/g)].map(m => m[1]));
  // dateDesc is the chain's FALL-THROUGH default, not a branch, so it is implemented without
  // appearing as a comparison.
  implemented.add(SORTS.default);

  for (const v of values(SORTS)) {
    assert.ok(implemented.has(v),
      `the Sort control offers "${v}", which the ORDER BY chain does not implement — it would ` +
      `silently fall through to ${SORTS.default}`);
  }
  for (const v of implemented) {
    assert.ok(valueSet(SORTS).has(v),
      `the handler implements sort="${v}", which no control offers and which is not declared ` +
      `dbOnly — either expose it or say why not`);
  }
  assert.ok(dbOnlyValues(SORTS).includes("applicantCount"),
    "applicantCount is implemented server-side; it must be declared rather than left unexplained");
  assert.ok(values(SORTS).includes(SORTS.default), "the default sort is not an offered option");
});

test("posting age: one table, and both consumers derive from it", () => {
  // This was a literal in server.js's AGE_MAP and a second literal in JobsPanel's AGE_DAYS_MAP —
  // two copies of "how many days is a week", applied by two different clauses on the same request.
  assert.match(read("server.js"), /const AGE_MAP = ageDaysMap\(\);/,
    "server.js re-typed the age table");
  assert.match(read("client/src/panels/JobsPanel.jsx"), /const AGE_DAYS_MAP = ageDaysMap\(\);/,
    "JobsPanel re-typed the age table");
  assert.deepEqual(ageDaysMap(), { "1d": 1, "2d": 2, "3d": 3, "1w": 7, "1m": 30 });
  assert.equal(ageDays("1w"), 7);
  assert.equal(ageDays(""), null);
  assert.equal(ageDays("nonsense"), null);
  // Every non-empty option carries a day count, or it is a control that cannot filter.
  for (const o of POSTING_AGE.options) {
    if (o.value === "") continue;
    assert.ok(Number.isInteger(o.days) && o.days > 0, `age option "${o.value}" has no day count`);
  }
});

// ── Direction 2: no literal option list survives outside the contract ──────────────────────────

test("NO UI SITE HOLDS A LITERAL OPTION LIST ANY MORE", () => {
  // The requirement this file exists to enforce. Every one of these sites had its own copy; a copy
  // is what lets 'mid level' and 'mid' coexist without anything failing.
  const sites = {
    "client/src/components/UnifiedSearchBar.jsx": [
      /const EXP_OPTIONS\s*=\s*toSelect\(EXPERIENCE_LEVELS/,
      /const DOMAIN_OPTIONS\s*=\s*toSelect\(DOMAINS/,
      /const STATUS_OPTIONS\s*=\s*BOARD_STATUS\.options/,
    ],
    "client/src/panels/JobsPanel.jsx": [
      /const EMP_TYPE_OPTIONS\s*=\s*EMPLOYMENT_TYPES\.options;/,
      /const WORK_MODEL_OPTIONS\s*=\s*WORK_MODELS\.options;/,
      /const EXPERIENCE_LEVEL_OPTIONS\s*=\s*EXPERIENCE_LEVELS\.options;/,
      /const SOURCE_OPTIONS\s*=\s*SOURCES\.options;/,
      /const TIER_OPTIONS\s*=\s*AUTOMATION_TIERS\.options;/,
      /POSTING_AGE\.options\.map/,
      /VISITED\.options\.map/,
    ],
    "client/src/App.jsx": [/const SORT_OPTIONS\s*=\s*SORTS\.options\.map/],
    // TopBar was here, for the collapsed pill's own sort <select>. Y4 retired the pill, so there is
    // one sort control again; the bar rendering from the contract is not a property it can have when
    // it renders no sort at all. Asserted the other way round below instead.
  };
  for (const [file, patterns] of Object.entries(sites)) {
    const src = read(file);
    for (const re of patterns) {
      assert.match(src, re, `${file} no longer renders from the contract (${re})`);
    }
  }

  // And the negative: the specific literals that used to live at these sites are gone. Comments in
  // these files legitimately QUOTE the old values to explain the defect, so strip comments first —
  // matching a comment is how a source-string test passes while the code says something else.
  const strip = (t) => t
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*(?:\/\/|\*).*$/gm, "");

  const usb = strip(read("client/src/components/UnifiedSearchBar.jsx"));
  for (const dead of ["'intern'", "'ai_ml'", "'healthtech'", "'starred'"]) {
    assert.ok(!usb.includes(dead),
      `UnifiedSearchBar still holds the literal ${dead} — it must come from the contract`);
  }
  const panel = strip(read("client/src/panels/JobsPanel.jsx"));
  for (const dead of ['value:"remote"', 'value:"greenhouse"', 'value:"direct"',
                       'value="1w"', 'value="full-time"']) {
    assert.ok(!panel.includes(dead), `JobsPanel still holds the literal ${dead}`);
  }
  // TopBar renders NO sort control at all now — Y4 retired the pill that held one. Both directions
  // are asserted: no literal, and no reference to the contract either, because a second sort surface
  // in the chrome is the two-lists situation regardless of where its values come from.
  const topbar = strip(read("client/src/components/TopBar.jsx"));
  assert.ok(!topbar.includes('value="dateDesc"'), "TopBar still holds its own sort literals");
  assert.ok(!/SORTS/.test(topbar), "a second sort control is back in the top bar");
  const app = strip(read("client/src/App.jsx"));
  assert.ok(!app.includes('v: "dateDesc"'), "App.jsx still holds its own sort literals");
});

test("the dead Apify validation sets are gone, not left as a decoy", () => {
  // Three sets DECLARED AND NEVER READ. They mattered because they looked exactly like the
  // validation the endpoint was missing: one said "office" where every live definition says
  // "onsite", the other listed "temporary", which the column cannot hold.
  const server = read("server.js");
  assert.ok(!/const VALID_EMP_TYPES\s*=/.test(server), "the dead VALID_EMP_TYPES is back");
  assert.ok(!/const VALID_WORKPLACE_TYPES\s*=\s*new Set/.test(server),
    "the dead VALID_WORKPLACE_TYPES is back");
  assert.ok(!/const VALID_POSTED_LIMITS\s*=/.test(server), "the dead VALID_POSTED_LIMITS is back");
});

// ── The server rejects loudly ──────────────────────────────────────────────────────────────────

test("GET /api/jobs validates every enumerated dimension, under every param it answers to", () => {
  const server = read("server.js");
  assert.match(server, /function rejectInvalidFilterValues\(query\)/,
    "the validator is gone — an unknown value is back to being an empty board");
  // It must be called BEFORE the query is built, and it must 400.
  const handler = server.slice(server.indexOf('app.get("/api/jobs", requireAuth'));
  const guardAt = handler.indexOf("rejectInvalidFilterValues(req.query)");
  const buildAt = handler.indexOf("buildJobFilters(filterParams)");
  assert.ok(guardAt > 0 && buildAt > guardAt,
    "the filter guard does not run before the query is built");
  assert.match(handler.slice(guardAt, guardAt + 400), /res\.status\(400\)/,
    "an unknown filter value does not produce a 400");
  // Every param name, including the exclude and legacy aliases — sources_exclude=LinkedIn has to
  // be caught as surely as sources_include=LinkedIn.
  assert.match(server, /\[dim\.param, dim\.excludeParam, dim\.legacyParam\]/,
    "the validator only checks a dimension's primary param");
});

test("invalidEntries names the offending value, and lets absence through", () => {
  // Absence and emptiness are "no opinion on this dimension" and must never 400 — that is the
  // default board.
  for (const raw of ["", null, undefined]) {
    assert.deepEqual(invalidEntries(WORK_MODELS, raw), [], `"${raw}" should be allowed`);
  }
  assert.deepEqual(invalidEntries(WORK_MODELS, "remote,hybrid"), []);
  // A single bad entry inside an otherwise valid list is reported BY NAME. "invalid work_models"
  // with no indication of which one is the same dead end as the silent empty board.
  assert.deepEqual(invalidEntries(WORK_MODELS, "remote,office"), ["office"]);
  assert.deepEqual(invalidEntries(SOURCES, "greenhouse,LinkedIn"), ["LinkedIn"]);
  assert.deepEqual(invalidEntries(EXPERIENCE_LEVELS, "mid level"), ["mid level"]);
  assert.deepEqual(invalidEntries(DOMAINS, "ai ml"), ["ai ml"]);
  // dbOnly values are VALID to send even though no control offers them — they are real column
  // values, and an API caller asking for them is asking a sensible question.
  assert.deepEqual(invalidEntries(DOMAINS, "general"), []);
  assert.deepEqual(invalidEntries(SOURCES, "import"), []);
  assert.deepEqual(invalidEntries(SORTS, "applicantCount"), []);
  // Whitespace between entries is the client's `.join(", ")`, not an unknown value.
  assert.deepEqual(invalidEntries(WORK_MODELS, "remote, hybrid"), []);
});

// ── The profile bridge derives only values the contract knows ──────────────────────────────────

test("the profile bridge can only derive experience levels the board offers", async () => {
  // The bridge is OUR code, so an invalid derived value is an internal bug rather than a bad
  // request — which is why the server does not 400 on it and why this direction is a test instead.
  // It is also the direction that actually bit: a derived experience_levels=['mid','senior'] is
  // what hid the Quora entry-level posting.
  const bridge = read("services/jobs/profileFilterBridge.js");
  assert.match(bridge, /const LEVEL_ORDER = EXPERIENCE_LEVEL_ORDER;/,
    "the bridge re-typed the level vocabulary — its widening walks this list BY INDEX");

  const block = bridge.slice(bridge.indexOf("const EXPERIENCE_LEVEL_THRESHOLDS"),
                             bridge.indexOf("const LEVEL_ORDER"));
  const derived = [...block.matchAll(/level: '([a-z]+)'/g)].map(m => m[1]);
  assert.ok(derived.length >= 5, `expected the threshold table, found ${derived.length}`);
  for (const level of derived) {
    assert.ok(valueSet(EXPERIENCE_LEVELS).has(level),
      `the bridge can derive experience_level="${level}", which no control offers — the user ` +
      `would see a narrowed board with no filter explaining it`);
  }

  // widenOneLevelUp walks LEVEL_ORDER by index, so the order has to be the contract's order or the
  // widening lands on the wrong level.
  assert.deepEqual(EXPERIENCE_LEVEL_ORDER, values(EXPERIENCE_LEVELS));
  const mod = await import("../services/jobs/profileFilterBridge.js");
  assert.ok(typeof mod.deriveProfileFilters === "function");
});

// ── Behaviour is unchanged for the values that already worked ─────────────────────────────────

test("de-duplication changed no value that already worked", () => {
  // X1 is de-duplication, not a redesign. These are the post-W1 vocabularies verbatim; if this
  // fails, the refactor moved a value and the board's meaning changed with it.
  assert.deepEqual(values(EXPERIENCE_LEVELS), ["intern", "entry", "mid", "senior", "lead", "executive"]);
  assert.deepEqual(values(WORK_MODELS), ["remote", "hybrid", "onsite"]);
  assert.deepEqual(values(DOMAINS),
    ["saas", "fintech", "healthtech", "ai_ml", "ecommerce", "climate", "devtools", "edtech"]);
  assert.deepEqual(values(EMPLOYMENT_TYPES), ["full-time", "contract", "internship", "part-time"]);
  assert.deepEqual(values(AUTOMATION_TIERS), ["direct", "guest", "account", "gated", "unknown"]);
  assert.deepEqual(values(SORTS),
    ["dateDesc", "dateAsc", "compHigh", "compLow", "yoeLow", "yoeHigh", "atsScore"]);
  assert.deepEqual(values(VISITED), ["0", "1"]);
  assert.deepEqual(values(BOARD_STATUS), ["new", "starred", "applied"]);

  // Labels the user reads, for the controls whose labels were asserted elsewhere before.
  assert.equal(labelFor(DOMAINS, "ai_ml"), "AI / ML");
  assert.equal(labelFor(EXPERIENCE_LEVELS, "mid"), "Mid");
  assert.equal(labelFor(SORTS, "dateDesc"), "Newest");
  // A db-only value still labels, because an imported job's chip has to say something.
  assert.equal(labelFor(SOURCES, "import"), "Imported");
  // isValid's contract: "" always passes, an unknown never does.
  assert.ok(isValid(DOMAINS, ""));
  assert.ok(isValid(DOMAINS, "ai_ml"));
  assert.ok(!isValid(DOMAINS, "ai ml"));
});

test("BOARD_STATUS carries the params each option emits, rather than a switch elsewhere", () => {
  // One control over three unrelated predicates. Flattening it to a single param is what would put
  // a translation layer somewhere else, where it could disagree with this list.
  const byValue = Object.fromEntries(BOARD_STATUS.options.map(o => [o.value, o.emits]));
  assert.equal(byValue[""], null);
  assert.deepEqual(byValue.new, { visited: "0" });
  assert.deepEqual(byValue.starred, { starred: "1" });
  assert.deepEqual(byValue.applied, { applied: "1" });
  // Each emitted param must be one the handler actually reads.
  const handler = read("server.js");
  for (const emits of Object.values(byValue)) {
    for (const key of Object.keys(emits || {})) {
      assert.match(handler, new RegExp(`\\b${key}\\s+=\\s+''`),
        `GET /api/jobs does not destructure "${key}", which a Status option emits`);
    }
  }
});
