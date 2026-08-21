// Source-contract tests for the provider + automation-tier filters in JobsPanel's FiltersPanel
// drawer, in the same read-the-source idiom the other client-surface tests here use.
//
// The one that matters most is the dependency-array test. FE-2 added filter fields to buildParams
// and left them out of the refetch effect's dep array, so changing only a new filter built the
// right querystring and never sent it; FE-3 fixed that for FE-2's fields. This asserts the same
// property for the four fields added with the tier work, so the third occurrence is caught by a
// test rather than by a user finding a dead control.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The tier FILTERS are still the board's, but the apply QUEUE's tier warning moved to
// panels/AutoApplyPanel.jsx with the rest of the pipeline (W5). Both are read so each
// assertion keeps covering the thing it was written for.
const panel = [
  "client/src/panels/JobsPanel.jsx",
  "client/src/panels/AutoApplyPanel.jsx",
].map(f => fs.readFileSync(f, "utf8")).join("\n");
const card  = fs.readFileSync("client/src/components/JobCard.jsx", "utf8");

const NEW_FIELDS = ["sourcesInclude", "sourcesExclude", "tiersInclude", "tiersExclude"];

/** The dep array of the "Re-fetch when server-side filters/sort/tab change" effect. */
function refetchDeps() {
  const anchor = panel.indexOf("// Re-fetch when server-side filters/sort/tab change");
  assert.notEqual(anchor, -1, "the refetch effect's comment anchor moved");
  const depsStart = panel.indexOf("}, [", anchor);
  const depsEnd = panel.indexOf("]);", depsStart);
  return panel.slice(depsStart, depsEnd);
}

/** The dep array of buildParams' useCallback. */
function buildParamsDeps() {
  const anchor = panel.indexOf("const buildParams = useCallback((page = 1");
  assert.notEqual(anchor, -1, "buildParams moved");
  const depsStart = panel.indexOf("}, [", anchor);
  const depsEnd = panel.indexOf("]);", depsStart);
  return panel.slice(depsStart, depsEnd);
}

test("every new filter field is in the refetch effect's dependency array (the FE-3 bug)", () => {
  const deps = refetchDeps();
  for (const f of NEW_FIELDS) {
    assert.ok(new RegExp(`\\b${f}\\b`).test(deps),
      `${f} feeds buildParams but is missing from the refetch dep array — changing only that ` +
      `filter would build the right querystring and never fetch it`);
  }
});

test("every new filter field is in buildParams' own dependency array", () => {
  const deps = buildParamsDeps();
  for (const f of NEW_FIELDS) {
    assert.ok(new RegExp(`\\b${f}\\b`).test(deps), `${f} missing from buildParams deps — it would emit a stale value`);
  }
});

test("the four params are emitted only when non-empty, so the default querystring is unchanged", () => {
  for (const [field, param] of [
    ["sourcesInclude", "sources_include"], ["sourcesExclude", "sources_exclude"],
    ["tiersInclude", "tiers_include"],     ["tiersExclude", "tiers_exclude"],
  ]) {
    assert.match(panel, new RegExp(`if \\(${field}\\.length\\)\\s+p\\.set\\("${param}"`),
      `${param} must be guarded by a .length check, or it appears in the default querystring`);
  }
});

test("a saved search round-trips all four params", () => {
  // buildParams writes them; applyTrackedSearch must read them back or an applied saved search
  // silently comes back wider than the one that was saved.
  const anchor = panel.indexOf("const applyTrackedSearch = useCallback");
  assert.notEqual(anchor, -1);
  const body = panel.slice(anchor, panel.indexOf("}, [activeDomainProfile]);", anchor));
  for (const param of ["sources_include", "sources_exclude", "tiers_include", "tiers_exclude"]) {
    assert.ok(body.includes(param), `applyTrackedSearch never reads ${param} back`);
  }
});

test("filter state, the staged snapshot and the commit path all know the four fields", () => {
  const snapshot = panel.slice(panel.indexOf("function defaultFilterSnapshot"), panel.indexOf("// â\"€â\"€ Filters panel"));
  for (const f of NEW_FIELDS) {
    assert.ok(snapshot.includes(f), `${f} missing from defaultFilterSnapshot — Reset All would not clear it`);
  }

  // The commit path is now applyPendingFilters -> applyFilterSnapshot, one writer shared with the
  // profile-switch/reload restore and with Clear All. Those three used to set the filter states by
  // hand, and only the first had been taught about these four fields — so applying a work model and
  // reloading came back unfiltered. Asserting the routing plus "the writer covers every key of
  // defaultFilterSnapshot" is strictly stronger than looking for four names in Apply's body: it
  // fails for a FIFTH field too, which a hardcoded list never would.
  const apply = panel.slice(panel.indexOf("const applyPendingFilters = useCallback"), panel.indexOf("const resetPendingFilters"));
  assert.match(apply, /applyFilterSnapshot\(pendingFilters\)/,
    "Apply must commit through the shared filter writer");

  const writerStart = panel.indexOf("const applyFilterSnapshot = useCallback");
  assert.notEqual(writerStart, -1, "applyFilterSnapshot moved");
  const writer = panel.slice(writerStart, panel.indexOf("const applyPendingFilters = useCallback", writerStart));
  const defaultKeys = [...snapshot.matchAll(/^\s{4}([A-Za-z0-9_$]+):/gm)].map((m) => m[1]);
  assert.ok(defaultKeys.length >= 21, `expected defaultFilterSnapshot to declare many keys, saw ${defaultKeys.length}`);
  for (const key of defaultKeys) {
    const setter = "set" + key[0].toUpperCase() + key.slice(1);
    assert.ok(writer.includes(setter),
      `${key} is in defaultFilterSnapshot but ${setter} is never called by applyFilterSnapshot — ` +
      `it would not be committed on Apply, restored on reload, or cleared by Clear All`);
  }
});

test("an empty board caused by filters says so, and never reads as 'no jobs available'", () => {
  assert.match(panel, /function FilteredEmptyState/);
  assert.match(panel, /Your filters exclude all jobs/);
  assert.match(panel, /Clear all filters/);
  // The generic "search for a role" state must still exist for the genuinely-unfiltered case —
  // the point is that the two are distinguished, not that one replaced the other.
  assert.match(panel, /Search for a role above/);
  assert.match(panel, /emptyBecauseFiltered/);
});

test("the tier chip stays silent on `direct` and never promises anything on `unknown`", () => {
  assert.match(card, /function TierChip/);
  assert.match(card, /if \(tier === "direct"\) return null;/);
  // null and unrecognised values fall back to the unknown rendering, not to a tier that claims something.
  assert.match(card, /TIER_CHIP\[tier\] \|\| TIER_CHIP\.unknown/);
  assert.ok(!/TIER_CHIP\s*=\s*\{[^}]*\bdirect:/s.test(card), "`direct` must have no chip entry at all");
  assert.match(card, /<TierChip tier=\{job\.automationTier\}\/>/);
});

test("the queue names what an `account` or `gated` job needs before the run starts", () => {
  assert.match(panel, /automationTier === "account"/);
  assert.match(panel, /automationTier === "gated"/);
  assert.match(panel, /cannot be automated/);
  // Nothing here may attempt to get past the challenge — it is handed to the user.
  assert.match(panel, /apply to \{cannotAuto\.length === 1 \? "that one" : "those"\} yourself/);
});
