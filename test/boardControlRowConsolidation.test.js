// The control row is gone as a ROW. Nothing that was in it was deleted.
//
// That distinction is the whole risk of this change, so it is asserted from both directions: each
// control must be ABSENT from the row, and PRESENT at its new home. A test that only checked the
// first half would pass just as happily on a commit that deleted them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SORTS } from "../shared/jobFilterOptions.js";

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
  // A MOVE, not a redesign — still asserted, but no longer by scraping a literal array out of
  // App.jsx. X1 made SORTS in shared/jobFilterOptions.js the one definition of this dimension, and
  // App.jsx maps over it, so the seven pairs are checked against THAT. The old version read a
  // literal `const SORT_OPTIONS = [...]`; that is exactly the second copy X1 removed, and a test
  // that requires the copy to exist is a test that forbids the fix.
  assert.deepEqual(
    SORTS.options.map(o => [o.value, o.label]),
    [["dateDesc", "Newest"], ["dateAsc", "Oldest"],
     ["compHigh", "Pay high to low"], ["compLow", "Pay low to high"],
     ["yoeLow", "Exp low to high"], ["yoeHigh", "Exp high to low"],
     ["atsScore", "ATS Sort"]],
    "the sort menu's values or labels changed");
  // ...and that App.jsx really renders FROM it rather than keeping a copy beside it.
  assert.match(app, /const SORT_OPTIONS = SORTS\.options\.map/,
    "App.jsx holds its own sort list again");
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

test("the filters drawer is on the named tiers and inset clear of the nav", () => {
  // It was `position: fixed; inset: 0; zIndex: 500` — a raw number belonging to no tier in
  // client/src/styles/zLayers.js, and full-height under a TopBar at Z.NAV (1500). Measured at
  // 1440x900 with the drawer open: panel 0 -> 900, header 24 -> 54, close button a 9x27 box at
  // x 1411-1420 / y 26-53 overlapping the avatar at 1389-1419 / y 8-38 — and a hit-test at the
  // close button's own centre returned a nav <div>, not the button. Unclickable, not just cramped.
  //
  // zLayers' rule 2 is explicit that a raw bump is not the fix ("the question is which TIER it
  // belongs to"), and Z.NAV's note records the design: drawers are inset from the top so the nav
  // stays visible and reachable while one is open.
  assert.ok(!/position:"fixed", inset:0, zIndex:500/.test(panel),
    "the drawer is back on a raw z-index outside the scale");
  assert.match(panel, /position:"fixed", inset:0, zIndex:Z\.MODAL_SCRIM/);
  assert.match(panel, /width:320, height:"100%", zIndex:Z\.MODAL/);
  assert.match(panel, /import \{ Z \} from "\.\.\/styles\/zLayers\.js"/);

  // The clearance is padding on the SCRIM, so the dim still covers the whole viewport while the
  // panel inside it starts below the nav — a scrim that stopped at the nav would leave an
  // undimmed strip across the top of a modal surface.
  assert.match(panel, /padding:`\$\{FILTER_DRAWER_TOP\}px 0 \$\{FILTER_DRAWER_BOTTOM\}px`/);
  assert.match(panel, /alignItems:"stretch"/);

  // 80 / 16 are PanelShell's PanelDock values, so the two drawers share a top edge rather than
  // being two nearly-aligned surfaces. Read from PanelShell so they cannot drift apart silently.
  const shell = read("client/src/components/PanelShell.jsx");
  const dock = shell.match(/\{ right: EDGE_GAP, top: (\d+), bottom: (\d+),/);
  assert.ok(dock, "PanelDock's wide geometry moved — re-check the filters drawer against it");
  assert.match(panel, new RegExp(`const FILTER_DRAWER_TOP = ${dock[1]};`),
    `the filters drawer no longer shares PanelDock's top inset (${dock[1]})`);
  assert.match(panel, new RegExp(`const FILTER_DRAWER_BOTTOM = ${dock[2]};`));
});

test("the drawer's close control is a real hit target with a real name", () => {
  // 9x27 was the width of the glyph alone, under the 24x24 minimum, and "x" is not an accessible
  // name.
  assert.match(panel, /aria-label="Close filters"/);
  assert.match(panel, /width:28, height:28, flexShrink:0, borderRadius:6/);
});
