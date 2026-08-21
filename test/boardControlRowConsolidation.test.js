// The control row is gone as a ROW. Nothing that was in it was deleted.
//
// That distinction is the whole risk of this change, so it is asserted from both directions: each
// control must be ABSENT from the row, and PRESENT at its new home. A test that only checked the
// first half would pass just as happily on a commit that deleted them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const panel   = read("client/src/panels/JobsPanel.jsx");
const app     = read("client/src/App.jsx");
const topBar  = read("client/src/components/TopBar.jsx");
const context = read("client/src/contexts/JobBoardContext.jsx");

test("the filter and sort triggers sit beside IMPORT, in the search bar's actions slot", () => {
  assert.match(app, /function BoardControlIcons\(\)/);
  // In the actions slot, next to the Import button — one row, not a new one.
  const actions = app.slice(app.indexOf("actions={activeTab === \"console\""), app.indexOf("</main>"));
  assert.match(actions, /<BoardControlIcons \/>/);
  assert.match(actions, /Import\s*\n?\s*<\/button>/);
  // And inside the provider, for the same reason BoardSearchBar is: AppDashboard renders
  // JobBoardProvider and cannot read it.
  assert.match(app, /function BoardControlIcons\(\) \{\s*\n\s*const \{[^}]*\} = useJobBoard\(\);/);
});

test("every sort option moved across intact — same values, same labels", () => {
  // A MOVE, not a redesign. The seven options the removed "Newest" select carried are exactly the
  // seven here, and the collapsed pill's own list must agree with them (asserted in
  // test/boardOrderingTieBreak.test.js, which also checks the server handles each).
  const block = app.slice(app.indexOf("const SORT_OPTIONS = ["), app.indexOf("];", app.indexOf("const SORT_OPTIONS = [")));
  for (const [v, l] of [
    ["dateDesc", "Newest"], ["dateAsc", "Oldest"],
    ["compHigh", "Pay high to low"], ["compLow", "Pay low to high"],
    ["yoeLow", "Exp low to high"], ["yoeHigh", "Exp high to low"],
    ["atsScore", "ATS Sort"],
  ]) {
    assert.ok(block.includes(`v: "${v}"`), `the sort menu lost ${v}`);
    assert.ok(block.includes(`l: "${l}"`), `the sort menu lost the label "${l}"`);
  }
  // Reuses the bar's dropdown rather than being a second implementation.
  assert.match(app, /<UsbSelect\s*\n?\s*iconOnly/);
});

test("NEW IN 24H and Save Search moved INTO the filters panel, and still exist", () => {
  // Absent from the row...
  // The region is taken from AFTER the explanatory comment closes, not from inside it. That note
  // NAMES every control that moved, so a region that began mid-comment would read the explanation
  // as the controls themselves — and no amount of comment-stripping fixes a slice that starts
  // after the opening delimiter.
  const marker = panel.indexOf("The control ROW is gone");
  assert.notEqual(marker, -1, "the note explaining the removed row is gone");
  const rowStart = panel.indexOf("*/}", marker) + 3;
  const rowRegion = panel.slice(rowStart, panel.indexOf("Background loading indicator"));
  const rowCode = rowRegion.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const gone of [/New in 24h/i, /Save Search/i, /Filter loaded jobs/i, /ProfileSelectorDropdown/, /Pay high to low/]) {
    assert.ok(!gone.test(rowCode), `${gone} is back in the control row`);
  }
  // ...present in the panel, wired to the same things they always were.
  assert.match(panel, /<div style=\{labelStyle\}>Quick<\/div>/);
  assert.match(panel, /onClick=\{\(\) => setAgeFilter\(ageFilter === "1d" \? "" : "1d"\)\}/);
  assert.match(panel, /onSaveSearch=\{saveTrackedSearch\}/);
  assert.match(panel, /onApplySearch=\{applyTrackedSearch\}/);
  assert.match(panel, /onClearSearch=\{clearTrackedSearch\}/);
  assert.match(panel, /trackedSearch=\{activeDomainProfile\?\.tracked_search \|\| null\}/);
});

test("the two redundant controls are removed, and both are still reachable elsewhere", () => {
  // "Filter loaded jobs" wrote localSearch — the same state the main search bar's keyword field
  // now writes. The pill keeps its own, for when the bar has scrolled away.
  assert.ok(!/placeholder="Filter loaded jobs/.test(panel));
  assert.match(topBar, /placeholder="Filter jobs/);
  // The profile selector here was the third on screen.
  assert.ok(!/<ProfileSelectorDropdown/.test(panel));
  assert.match(topBar, /<ProfileSelectorDropdown/);
});

test("the result count and the active-filter indicator stay visible on the board", () => {
  // With the filters behind an icon these are the only things that can explain a narrow board, and
  // unlike the badge they do not scroll away with the search bar.
  assert.match(panel, /job\{totalJobs !== 1 \? "s" : ""\}/);
  assert.match(panel, /\{activeFilterCount\} filter\{activeFilterCount === 1 \? "" : "s"\} active/);
  // The banner is load-bearing and stays.
  assert.match(panel, /Show all|Showing/);
});

test("the badge counts the same filters the empty-board notice counts", () => {
  // One number, one derivation. If the badge and the notice could disagree, a board could be
  // filtered while the icon said it was not — which is exactly the state the badge exists to
  // prevent. Derived from defaultFilterSnapshot rather than a list, so a filter added later counts.
  assert.match(panel, /const activeFilterCount = useMemo\(\(\) => \{/);
  assert.match(panel, /const base = defaultFilterSnapshot\(\);/);
  assert.match(panel, /useEffect\(\(\) => \{ setActiveFilterCount\(activeFilterCount\); \}/);
  // Including the two committed filters the drawer does not own (the bar's Domain and Status).
  assert.match(panel, /\+ \(domainFilter \? 1 : 0\)/);
  assert.match(panel, /\+ \(appliedFilter \? 1 : 0\)/);
  assert.match(context, /const \[activeFilterCount, setActiveFilterCount\] = useState\(0\)/);
});

test("opening the panel still stages the committed filters and fetches facets", () => {
  // This used to be openFilterPanel(), called by the FILTERS button. The icon that replaced it can
  // only flip a shared flag — App.jsx has no access to pendingFilters or the facet fetch — so the
  // staging moved to an effect ON the flag, which means it cannot be bypassed by a trigger added
  // later. Keyed on the transition into `true`, or restaging would wipe in-progress edits.
  assert.match(panel, /useEffect\(\(\) => \{\s*\n\s*if \(!filtersOpen\) return;\s*\n\s*setPendingFilters\(activeFilterSnapshot\(\)\);\s*\n\s*fetchFacets\(\);/);
  assert.match(panel, /\}, \[filtersOpen\]\);/);
  assert.ok(!/openFilterPanel\(\)/.test(panel.replace(/^\s*\/\/.*$/gm, "")),
    "a second open path is back — staging must have exactly one");
  assert.match(panel, /const filtersOpen = filterPanelOpen;/);
});
