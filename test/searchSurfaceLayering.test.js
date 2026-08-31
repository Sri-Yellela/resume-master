// THE Z-INDEX SCALE, THE CLIPPING, AND THE PILL'S RETIREMENT.
//
// This file was "U2: one search surface at a time, and a search surface that genuinely floats above
// panel content" — two bugs, each with a measured cause rather than a guessed one:
//
// (i) BOTH SURFACES VISIBLE. Visibility was decided in two places from two unrelated scroll sources:
//     AppDashboard ran setUiMode(window.scrollY > 80 ? "dock" : "hero"), while TopBar's collapsed
//     filter pill keyed off useAppScroll().progress >= 0.5, fed by the job board's INNER scroll
//     container. Two independent booleans, so "both showing" was reachable, and was in fact normal.
//
// (ii) THE SEARCH SURFACE UNDERLAPPED PANEL CONTENT. .usb--inline was z-index 50, below several
//      panel-internal values (DatabasePanel's date popover at 300, its detail modal at 1000), and
//      the job-detail drawer was at 30/40 — i.e. UNDER the search bar, which is the one relationship
//      the panel spec needs inverted. Separately, that date popover is position:absolute inside a
//      sheet whose root is `flex:1; overflow:hidden`, so it was CLIPPED by its ancestor. No z-index
//      fixes clipping; only leaving the clipping ancestor can.
//
// HALF OF (i) IS RETIRED WITH THE PILL (Y4). There is one search surface now, so there is no
// crossing to stabilise: no threshold, no hysteresis pair, no sentinel, no crossfade. The eight
// tests that pinned that machinery went with it — the pixels-not-intersectionRatio reading, the
// two-guarded-transitions hysteresis, the "cannot move the geometry it is decided from" feedback
// loop, the transform-only keyframe that closed the dead frame at the swap, the short-page guard and
// the first-paint seed. That is Y4's instruction: retire the pill's tests rather than leave them
// asserting a removed surface. It was a real suite over a real defect, verified over 132 samples
// across the threshold; it is not being disowned, it is being retired with the thing it guarded.
//
// WHAT DID NOT GO WITH IT, deliberately, because it covers behaviour that still exists:
//   - that there is no SECOND scroll source in the dashboard. A window.scrollY listener here
//     re-rendered the whole dashboard on every scroll event, which is how a trivial scroll reset the
//     job board. Kept below.
//   - the double-click local -> live search pattern, and its two handlers being real rather than
//     no-ops. Kept below.
//   - all of (ii). It is Y2's guard and has nothing to do with the pill.
//
// What REPLACES the retired half is a test that the machinery is gone — Y4's requirement to
// grep-prove each mechanism has no remaining caller, asserted rather than done once by hand — plus
// one that every control the pill carried is still reachable.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { at } from "../test-support/sourceAnchors.js";

const read = (p) => fs.readFileSync(p, "utf8");
// Some assertions here are "this mechanism is GONE", and both this file's notes and the source
// files' own notes about what they removed quote the very strings being asserted absent. Read
// STRIPPED source for those, or a comment describing a removed mechanism reads as the mechanism
// still being present.
const code = (p) => read(p)
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*(?:\/\/|\*).*$/gm, "");
const app        = read("client/src/App.jsx");
const topbar     = read("client/src/components/TopBar.jsx");
const zLayers    = read("client/src/styles/zLayers.js");
const usbCss     = read("client/src/components/UnifiedSearchBar.css");
const jdPanel    = read("client/src/components/JobDetailPanel.jsx");
const dockPortal = read("client/src/components/DockPortal.jsx");
const dbPanel    = read("client/src/panels/DatabasePanel.jsx");

// ── The pill, and every mechanism that existed only to drive it ────────────────────────────────

test("THE FLOATING PILL IS GONE, AND SO IS EVERYTHING THAT ONLY DROVE IT", () => {
  const appCode = code("client/src/App.jsx");
  const barCode = code("client/src/components/TopBar.jsx");
  const usbCode = code("client/src/components/UnifiedSearchBar.jsx");

  // The container itself.
  assert.ok(!/pillIsTheSearchSurface/.test(barCode), "the pill's gate is back");
  assert.ok(!/Filter jobs/.test(barCode), "the pill's local search input is back in the top bar");
  assert.ok(!/pill2Bg/.test(barCode), "the pill's glass gradient is back");
  assert.ok(!/searchSurface/.test(barCode + appCode), "the two-surface switch is back");
  assert.ok(!/boardIsActive/.test(barCode + appCode), "the pill's board gate is back");

  // The threshold, the hysteresis pair, and the rAF-coalesced scroll handler that fed them. The
  // whole hook is DELETED, not merely unused — an unused hook is one caller away from being used.
  assert.ok(!fs.existsSync("client/src/hooks/useSearchSurface.js"),
    "hooks/useSearchSurface.js is back; it existed only to choose between two surfaces");
  assert.ok(!/useSearchSurface|HIDE_ABOVE|SHOW_BELOW/.test(appCode),
    "the threshold pair is back in App.jsx");
  assert.ok(!/sentinelRef/.test(appCode), "the sentinel the threshold was measured from is back");

  // The crossfade. Transform-only was the fix for a frame showing neither surface; with one surface
  // there is no crossing, so the keyframe goes with it.
  assert.ok(!/slideDown/.test(barCode), "the pill's entrance keyframe is back");
  assert.ok(!/injectKeyframes/.test(barCode), "the keyframe injector is back");

  // The hover machinery. `hovered` was WRITE-ONLY: two handlers set it and nothing ever read it.
  for (const dead of ["hovered", "setHovered", "hoverTimerRef", "handleMouseEnter",
                      "handleMouseLeave", "searchFocused"]) {
    assert.ok(!new RegExp("\\b" + dead + "\\b").test(barCode),
      `${dead} is back — it belonged to the pill's hover grace period`);
  }

  // The `hidden` prop, which existed so the caller could keep ONE of two surfaces in the layout
  // while paying nothing for the other. There is nothing to hide from any more.
  assert.ok(!/hidden = false/.test(usbCode), "UnifiedSearchBar's `hidden` prop is back");
  assert.ok(!/visibility: 'hidden'/.test(usbCode), "the visibility swap is back");
});

test("EVERY CONTROL THE PILL CARRIED IS STILL REACHABLE", () => {
  // Y4's requirement 2: a control that lived only on the pill MOVES onto the Jobs chrome; it is not
  // deleted with the container. Inventoried off the running pill before the removal:
  //
  //   the pill carried             where it is now
  //   All / star / hourglass tabs  App.jsx's BoardTabs, in the Jobs search bar's actions row.
  //                                THE ONLY ONE THAT HAD TO MOVE — JobsPanel's own boardTabs strip
  //                                is behind `{false && ...}`, so the pill was the only place these
  //                                three existed. Measured on the running app: 0 occurrences of
  //                                each as a button anywhere outside the pill.
  //   sort select                  already on the Jobs chrome, as BoardControlIcons' UsbSelect
  //   profile switcher             already in TopBar's avatar menu (ProfileSelectorDropdown)
  //   "Filter jobs…" input         already the main search bar's keyword field — both write the
  //                                same `localSearch`, which is why the board's third copy went in W4
  assert.match(app, /function BoardTabs\(\)/, "the board's All/Saved/Pending tabs are gone");
  assert.match(app, /const \{ boardTab, setBoardTab \} = useJobBoard\(\);/,
    "BoardTabs no longer writes the board's own state");
  for (const id of ['"all"', '"saved"', '"pending"']) {
    assert.ok(app.includes(id), `the ${id} board view is gone`);
  }
  assert.match(app, /<BoardTabs \/>/, "BoardTabs is defined but never rendered");
  // ...and the three that did NOT need moving are still where they were.
  assert.match(app, /<BoardControlIcons \/>/);
  assert.match(app, /ariaLabel="Sort"/);
  assert.match(topbar, /<ProfileSelectorDropdown/, "the profile switcher left the avatar menu");
  assert.match(read("client/src/components/UnifiedSearchBar.jsx"),
    /placeholder="Job title or keywords"/);
});

test("the second, unrelated scroll source is still gone", () => {
  // uiMode + its window.scrollY listener were the other half of the two-boolean pair. Neither may
  // come back: a window.scrollY listener here re-rendered the whole dashboard on every scroll event.
  const appCode = code("client/src/App.jsx");
  assert.ok(!/\buiMode\b/.test(appCode), "uiMode is back — a second place deciding chrome visibility");
  assert.ok(!/DOCK_THRESHOLD/.test(appCode), "the scroll threshold is back");
  assert.ok(!/window\.scrollY/.test(appCode), "a window.scrollY listener is back in the dashboard");
});

// ── (ii) The z-index scale ─────────────────────────────────────────────────────────────────────

test("the scale is named constants in one file, ordered as the panel spec requires", async () => {
  const { Z } = await import("../client/src/styles/zLayers.js");

  // Y2 REVISED THE TOP OF THIS ORDER. The assertion here used to be `Z.MODAL < Z.NAV`, with the
  // reason "nav chrome stays reachable while a drawer is open, as today". That is precisely the
  // arrangement that made the top bar occlude the overlays it floated over — the filters drawer's
  // only close control sat under it, and a hit-test at the button's centre returned a nav <div>.
  // The bar is now at the BOTTOM of the overlay stack, one step above page content.
  //
  // The required order, asserted as a chain so a single reordered tier fails rather than being
  // absorbed by a looser pairwise check:
  const order = [
    ["CONTENT",         Z.CONTENT],
    ["NAV",             Z.NAV],
    ["PANEL_POPOVER",   Z.PANEL_POPOVER],
    ["SEARCH",          Z.SEARCH],
    ["SEARCH_DROPDOWN", Z.SEARCH_DROPDOWN],
    ["DRAWER_SCRIM",    Z.DRAWER_SCRIM],
    ["DRAWER",          Z.DRAWER],
    ["MODAL_SCRIM",     Z.MODAL_SCRIM],
    ["MODAL",           Z.MODAL],
    ["POPOVER",         Z.POPOVER],
  ];
  for (let i = 1; i < order.length; i++) {
    const [prevName, prev] = order[i - 1];
    const [name, cur] = order[i];
    assert.ok(Number.isFinite(cur), `${name} is missing from the scale`);
    assert.ok(prev < cur, `${prevName} (${prev}) must sit below ${name} (${cur})`);
  }

  // The relationships that carry a defect behind them, named individually so a failure says which
  // bug came back rather than only that the chain broke.
  assert.ok(Z.CONTENT < Z.NAV,
    "the top bar must stay above page content — it has to remain usable while the board scrolls");
  assert.ok(Z.NAV < Z.PANEL_POPOVER && Z.NAV < Z.SEARCH && Z.NAV < Z.DRAWER &&
            Z.NAV < Z.MODAL_SCRIM && Z.NAV < Z.MODAL && Z.NAV < Z.POPOVER,
    "the top bar is occluding an overlay surface again — that is the Y2 defect");
  assert.ok(Z.SEARCH < Z.SEARCH_DROPDOWN,
    "a dropdown must cover the control that opened it");
  assert.ok(Z.SEARCH_DROPDOWN < Z.DRAWER,
    "the filters drawer covers the search bar, so a dropdown from that bar must not paint over it");
  assert.ok(Z.DRAWER < Z.MODAL_SCRIM,
    "opening a JD/PDF/ATS panel must cover the filters drawer, not race it on render order");
  assert.ok(Z.SEARCH < Z.MODAL_SCRIM && Z.MODAL_SCRIM < Z.MODAL,
    "a drawer and its scrim must cover the search surface — the old 40-vs-50 had this inverted");

  // No two tiers may share a number: equal z means DOM order decides, which is the accident the
  // scale exists to remove. This is what caught JobsPanel's resume-enhance modal sitting on the
  // literal 600, the same value as DRAWER_SCRIM.
  const nums = order.map(([, v]) => v);
  assert.equal(new Set(nums).size, nums.length, "two tiers share a z value");
});

test("no surface on the scale carries a literal any more", () => {
  // CSS reads the same numbers through custom properties published from the one definition, so the
  // stylesheet cannot drift from the module.
  assert.match(zLayers, /installZLayerVars/);
  assert.match(usbCss, /z-index: var\(--z-search, 400\);/);
  assert.ok(!/z-index: 50;/.test(usbCss), "the app search bar is back below panel content");
  // The drawer's tiers moved into PanelShell when JD, PDF and ATS were unified onto it — one
  // primitive means one place that decides the tier, which is the whole point of extracting it.
  const shell = read("client/src/components/PanelShell.jsx");
  assert.match(shell, /zIndex: Z\.MODAL_SCRIM/);
  // The modal tier is carried by the DOCK — the one fixed overlay surface the panels tile inside —
  // rather than by each panel. That is what made tiling internal, and it also means the tier is
  // declared once for the group instead of once per peer. Ordering BETWEEN peers is then a local
  // z-index within the dock's stacking context, which is a 0/1 by construction and not a scale
  // value competing with the app's.
  assert.match(shell, /zIndex: Z\.MODAL,/);
  assert.match(shell, /export function PanelDock/);
  assert.match(shell, /zIndex: focused \? 1 : 0,/);
  assert.ok(!/zIndex:30,/.test(shell) && !/zIndex:40,/.test(shell),
    "a drawer is back under the search surface");
  // And JD must not have grown its own drawer chrome back.
  assert.ok(!/position:"fixed", inset:0, zIndex:/.test(jdPanel),
    "JobDetailPanel is hand-rolling its own scrim again instead of using the shared primitive");
  assert.match(topbar, /zIndex: Z\.NAV/);
  // DockPortal takes its tier from the CALLER now, defaulting to POPOVER. One portal serves two
  // kinds of surface with different ownership: a MENU is invoked from chrome that stays live over a
  // modal, and the search bar's dropdowns belong to a surface a drawer covers. Hard-coding POPOVER
  // put a dropdown from a covered control above the thing covering it.
  assert.match(dockPortal, /tier = Z\.POPOVER/, "DockPortal's default tier is no longer POPOVER");
  assert.match(dockPortal, /zIndex: tier,/, "DockPortal ignores its caller's tier again");
  for (const f of ["client/src/components/UsbSelect.jsx", "client/src/components/UsbSuggest.jsx"]) {
    assert.match(read(f), /tier=\{Z\.SEARCH_DROPDOWN\}/,
      `${f} is back at the menu tier — it belongs to the search surface`);
  }
  // The MENUS keep the default, which is the tier Y2 explicitly assigns them: the profile menu is a
  // dropdown FROM the bar and belongs to the overlay tier when open, not to the bar's own level.
  for (const f of ["client/src/components/TopBar.jsx", "client/src/components/ProfileSelectorDropdown.jsx"]) {
    assert.ok(!/tier=\{/.test(read(f)), `${f} should take DockPortal's default menu tier`);
  }
  // And no surface on the scale may carry a raw number that collides with a tier.
  const NUMS = new Set([250, 300, 400, 500, 600, 650, 800, 850]);
  for (const f of ["client/src/panels/JobsPanel.jsx", "client/src/panels/AutoApplyPanel.jsx",
                   "client/src/panels/DatabasePanel.jsx", "client/src/components/PanelShell.jsx"]) {
    for (const m of code(f).matchAll(/zIndex:\s*(\d+)/g)) {
      assert.ok(!NUMS.has(Number(m[1])),
        `${f} carries the raw z-index ${m[1]}, which collides with a named tier`);
    }
  }
});

// ── (ii) The clipping, and the click ──────────────────────────────────────────────────────────

test("the clipped panel popover is portalled out of its overflow:hidden ancestor", () => {
  // RE-PINNED FOR AD1, not relaxed. Both of this panel's date popovers are still portalled; one of
  // them just stopped being written here. AD1 extracted the sheet-level "Filter by date" control —
  // pill, portal and calendar as one piece — into components/ui/PanelControls.jsx so the Auto Apply
  // panel could adopt this layout by rendering it rather than by copying it. Counting DockPortal
  // call sites in this ONE file would now report a regression for a refactor that moved the call
  // site, so the assertion follows it: one portal still written here (the per-row cell editor,
  // which is inside a scrolling table and has no shared pill to belong to) and one in the extracted
  // control this panel renders.
  //
  // RE-PINNED AGAIN FOR AK1, and again not relaxed. This panel now has TWO per-cell popovers, not
  // one: the date calendar and the employer-outcome picker. Both sit inside the same scrolling,
  // clipping table and both must be portalled for the same reason. The count moved 1 -> 2, so the
  // count alone would now be satisfied by a build where the outcome picker is portalled and the
  // calendar is not — the assertions below therefore name each one rather than trusting the total.
  assert.match(dbPanel, /import \{ DockPortal \} from "\.\.\/components\/DockPortal\.jsx";/);
  assert.equal((dbPanel.match(/<DockPortal anchorRect=/g) || []).length, 2,
    "the per-cell date and outcome popovers must both be portalled; they are inside a scrolling table");
  const dateCell = dbPanel.slice(at(dbPanel, "if (c.isDate)"), at(dbPanel, "if (c.isAtsAtApply)"));
  assert.match(dateCell, /<DockPortal anchorRect=\{calCell\.rect\}/,
    "the date calendar is still portalled out of the table");
  const outcomeCellSrc = dbPanel.slice(at(dbPanel, "if (c.isOutcome)"), at(dbPanel, 'if (c.key === "ats_score")'));
  assert.match(outcomeCellSrc, /<DockPortal anchorRect=\{outcomeCell\.rect\}/,
    "the outcome picker is inside the same clipping table and must be portalled too");
  assert.match(dbPanel, /<DateFilterButton/,
    "the sheet-level date filter is gone from this panel entirely");
  const panelControls = read("client/src/components/ui/PanelControls.jsx");
  assert.equal((panelControls.match(/<DockPortal anchorRect=/g) || []).length, 1,
    "the extracted date filter stopped portalling its calendar — it is clipped again in BOTH panels");
  // And the popover no longer frames or positions itself, because the portal does.
  for (const [where, src] of [["DatabasePanel", dbPanel], ["PanelControls", panelControls]]) {
    assert.ok(!/position:"absolute", zIndex:300/.test(src),
      `${where}'s calendar is self-positioning again, which puts it back inside the clipping ancestor`);
  }
});

test("outside-click closes the dropdown WITHOUT swallowing the click", () => {
  // The old full-screen backdrop div ate the click: dismissing a menu and pressing a button beneath
  // took two presses and the first silently did nothing.
  const portalCode = code("client/src/components/DockPortal.jsx");
  assert.ok(!/inset: 0/.test(portalCode), "the full-screen click-capturing backdrop is back");
  assert.ok(!/onClick=\{onClose\}/.test(portalCode), "the backdrop is capturing clicks again");
  assert.match(dockPortal, /document\.addEventListener\("pointerdown", onPointerDown, true\)/);
  // The trigger's own rect is excluded, or clicking the trigger to close would close-then-reopen.
  assert.match(dockPortal, /if \(x >= anchorRect\.left && x <= anchorRect\.right/);
  // And a click inside the panel is not an outside click.
  assert.match(dockPortal, /panelRef\.current\?\.contains\(e\.target\)/);
});

test("DatabasePanel's duplicate outside-click handler is gone", () => {
  // It tested calRef.contains(e.target). Once the calendar is portalled to body it is not a
  // descendant of calRef, so that handler would have read every click INSIDE the calendar as an
  // outside click and dismissed it on the first day you picked.
  assert.ok(!/calRef\.current && !calRef\.current\.contains\(e\.target\)/.test(dbPanel),
    "the stale handler would now close the calendar when you click inside it");
});

// ── Behaviour must not change ──────────────────────────────────────────────────────────────────

test("the double-click local -> live search pattern is untouched", () => {
  const usb = read("client/src/components/UnifiedSearchBar.jsx");
  assert.match(usb, /const DCLICK_MS = 5000;/);
  assert.match(usb, /clicks\.current \+= 1;/);
  assert.match(usb, /if \(clicks\.current === 1\) \{/);
  assert.match(usb, /onLocalFilter\?\.\(params\)/);
  assert.match(usb, /onSearch\?\.\(params\)/);

  // The two assertions that used to stand here pinned `onSearch={() => {}}` and
  // `onLocalFilter={() => {}}` in App.jsx, on the correct reasoning at the time that U2 was
  // visibility and layering only and must not disturb the handlers. What that froze, though, was a
  // pair of NO-OPS: measured on the real board, typing a keyword, both Search clicks and all three
  // selects produced zero /api/jobs requests between them. So the shape is now asserted the other
  // way round — the handlers must be real, and must both route through the one channel the board
  // reads (applyBarFilters), with `live` distinguishing the second click from the first.
  assert.ok(!/onSearch=\{\(\) => \{\}\}/.test(app),
    "the search bar's onSearch is a no-op again — every control on the bar is inert");
  assert.ok(!/onLocalFilter=\{\(\) => \{\}\}/.test(app),
    "the search bar's onLocalFilter is a no-op again — every control on the bar is inert");
  assert.match(app, /onLocalFilter=\{params => applyBarFilters\(params\)\}/);
  assert.match(app, /onSearch=\{params => applyBarFilters\(params, \{ live: true \}\)\}/);
});
