// U2: one search surface at a time, and a search surface that genuinely floats above panel content.
//
// TWO BUGS, and each had a measured cause rather than a guessed one.
//
// (i) BOTH SURFACES VISIBLE. Visibility was decided in two places from two unrelated scroll sources:
//     AppDashboard ran setUiMode(window.scrollY > 80 ? "dock" : "hero"), while TopBar's collapsed
//     filter pill keyed off useAppScroll().progress >= 0.5, which is fed by the job board's INNER
//     scroll container via PullToRefresh. Two independent booleans, so "both showing" was reachable.
//     It was also the permanent state, because on the dashboard
//     document.documentElement.scrollHeight === window.innerHeight — the window does not scroll at
//     all, so the main bar's condition could never fire and it could never yield.
//
// (ii) THE SEARCH SURFACE UNDERLAPPED PANEL CONTENT. .usb--inline was z-index 50, below several
//      panel-internal values (DatabasePanel's date popover at 300, its detail modal at 1000), and the
//      job-detail drawer was at 30/40 — i.e. UNDER the search bar, which is the one relationship the
//      panel spec needs inverted. Separately, that date popover is position:absolute inside a sheet
//      whose root is `flex:1; overflow:hidden`, so it was CLIPPED by its ancestor. No z-index can fix
//      clipping; only leaving the clipping ancestor can.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
// Some assertions here are "this mechanism is GONE", and this file's own explanatory notes quote the
// very strings being asserted absent ("window.scrollY", "onClick={onClose}"). Read stripped source
// for those, or a comment describing a removed mechanism reads as the mechanism still being present.
const code = (p) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const app        = read("client/src/App.jsx");
const topbar     = read("client/src/components/TopBar.jsx");
const hook       = read("client/src/hooks/useSearchSurface.js");
const zLayers    = read("client/src/styles/zLayers.js");
const usbCss     = read("client/src/components/UnifiedSearchBar.css");
const usb        = read("client/src/components/UnifiedSearchBar.jsx");
const jdPanel    = read("client/src/components/JobDetailPanel.jsx");
const dockPortal = read("client/src/components/DockPortal.jsx");
const dbPanel    = read("client/src/panels/DatabasePanel.jsx");

// ── (i) One source of truth ────────────────────────────────────────────────────────────────────

test("the two surfaces are chosen by ONE derived value, not two booleans", () => {
  assert.match(app, /const \{ surface: searchSurface, sentinelRef \} = useSearchSurface\(\)/);
  // The bar is VISIBLE for only one value of it. It is no longer unmounted for the other: doing
  // that removed 386px of above-the-fold layout at the threshold (scrollHeight 1763 -> 1377), and
  // Chrome's scroll anchoring compensated by pulling scrollY back across the same threshold. One
  // value still decides, but it now decides paint, not existence.
  assert.match(app, /hidden=\{searchSurface !== "bar"\}/);
  assert.match(app, /visibility: searchSurface === "bar" \? "visible" : "hidden"/);
  assert.match(usb, /style=\{hidden \? \{ visibility: 'hidden' \} : undefined\}/);
  // ...and TopBar is TOLD which surface is showing rather than deciding again.
  assert.match(app, /searchSurface=\{searchSurface\}/);
  assert.match(topbar, /searchSurface = "bar",/);
  assert.match(topbar, /const pillIsTheSearchSurface = searchSurface === "pill";/);
  // The pill's contents are BOARD controls — All/★/⏳, the sort, the profile switcher,
  // "Filter jobs…" — so it is additionally gated on the board being the panel on screen. Without
  // that it floated over Database, Recruiter, Job Profiles and Auto Apply, offering controls for a
  // board that is not there. Measured before the gate: every tab EXCEPT Jobs opened with the pill
  // showing at scrollY 0, because only Jobs renders the hero and so only Jobs has a document taller
  // than the viewport.
  assert.match(topbar, /\{pillIsTheSearchSurface && boardIsActive && boardTab !== undefined && \(/);
  assert.match(app, /boardIsActive=\{activeTab === "console"\}/);
});

test("the second, unrelated scroll source is gone", () => {
  // uiMode + its window.scrollY listener were the other half of the pair. Neither may come back:
  // window.scrollY is permanently 0 on this layout, so anything keyed to it is dead code that also
  // re-rendered the whole dashboard on every scroll event.
  const appCode = code("client/src/App.jsx");
  assert.ok(!/\buiMode\b/.test(appCode),
    "uiMode is back — visibility is being decided in a second place again");
  assert.ok(!/DOCK_THRESHOLD/.test(appCode), "the scroll threshold is back");
  assert.ok(!/window\.scrollY/.test(appCode), "window.scrollY does not change on this layout");
});

test("hover is not resurrected as a second input to pill visibility", () => {
  // The pill's old gate was `scrolled && hovered && ...`. Both extra inputs are independent booleans;
  // requirement was a single source, so neither may gate whether the pill EXISTS.
  const gate = topbar.slice(topbar.indexOf("{pillIsTheSearchSurface"), topbar.indexOf("{pillIsTheSearchSurface") + 120);
  assert.ok(!/hovered/.test(gate), "hover is gating pill existence again");
  assert.ok(!/\bscrolled\b/.test(gate), "a local scroll boolean is gating pill existence again");
});

// ── (i) The observed condition ─────────────────────────────────────────────────────────────────

test("the condition is read from a sentinel, in pixels, with real hysteresis", () => {
  // A sentinel, not the bar: the bar is `position: sticky` and never leaves the viewport, so it
  // cannot be its own condition. The sentinel holds the bar's SLOT and does leave.
  assert.match(app, /<div ref=\{sentinelRef\} aria-hidden="true" style=\{\{ height: 0 \}\}\/>/);

  // PIXELS, not intersectionRatio. The sentinel is zero-height, and IntersectionObserver reports a
  // zero-area target as ratio 1 when intersecting and 0 when not — never anything between.
  // Instrumenting the real observer across a full scroll returned exactly two distinct ratios,
  // [1, 0], so the two ratio thresholds tested the same instant and the hysteresis was inert.
  assert.ok(!/intersectionRatio/.test(hook), "the ratio test is back; on a zero-height target it cannot have two thresholds");
  assert.match(hook, /const HIDE_ABOVE = 40;/);
  assert.match(hook, /const SHOW_BELOW = 120;/);
  assert.ok(/prev === "bar"\s+&& top <= HIDE_ABOVE/.test(hook), "missing bar -> pill transition guard");
  assert.ok(/prev === "pill" && top >= SHOW_BELOW/.test(hook), "missing pill -> bar transition guard");
  assert.ok(HIDE_BAND_IS_WIDE(), "the two thresholds must be meaningfully apart, not adjacent");
  function HIDE_BAND_IS_WIDE() {
    const hide = Number(/const HIDE_ABOVE = (\d+);/.exec(hook)[1]);
    const show = Number(/const SHOW_BELOW = (\d+);/.exec(hook)[1]);
    return show - hide >= 40;
  }

  // rAF-coalesced, and listening in the capture phase so a scroll inside a nested container counts.
  assert.match(hook, /frame = requestAnimationFrame\(measure\)/);
  assert.match(hook, /"scroll", schedule, \{ capture: true, passive: true \}/);
});

test("the surface cannot move the geometry it is decided from", () => {
  // The loop that produced the flicker: the sentinel sat below the hero, the hero rendered only
  // while the surface was "bar", so flipping unmounted it and the scroll offset followed. Both the
  // hero and the bar now keep their space whichever surface is showing, so the sentinel's position
  // is a function of the scroll offset alone.
  assert.match(app, /\{activeTab === "console" && \(/);
  assert.ok(!/activeTab === "console" && searchSurface === "bar" && \(/.test(app),
    "the hero is being unmounted by the surface again — that is the feedback loop");
});

test("first paint shows exactly one surface, and never zero", () => {
  // Seeded to "bar", which is the correct answer at rest, so there is no frame with no surface.
  assert.match(hook, /useState\("bar"\)/);
  // And measured once immediately, so a page restored mid-scroll corrects within a frame rather
  // than showing the wrong surface until the user scrolls.
  // `\r?` because the working tree is checked out CRLF on Windows (core.autocrlf=true) while git
  // stores LF — an assertion anchored to a bare \n passes or fails depending on how the file was
  // last written, which is not a property of the code under test.
  assert.match(hook, /\n\s*measure\(\);\r?\n/);
});

test("a page that cannot scroll is always the bar, checked before the thresholds", () => {
  // The collapsed pill exists for one reason: the bar scrolled away and its controls need somewhere
  // to live. On a page with nothing to scroll the bar has not gone anywhere — and the thresholds
  // handed over anyway, because a short page's sentinel sits at top 0, which is under HIDE_ABOVE
  // from the first frame. Measured at 1440x900, only the Jobs tab renders the hero:
  //
  //   tab           docH   winH   sentinelTop at scrollY 0   surface
  //   jobs          3228   900    245                        bar    <- correct
  //   auto-apply     900   900      0                        pill   <- wrong
  //   database       900   900      0                        pill   <- wrong
  assert.match(hook, /const canScroll = doc\.scrollHeight - window\.innerHeight > 2;/);
  assert.match(hook, /if \(!canScroll\) \{ setSurface\("bar"\); return; \}/);
  // Switching tabs changes the document height with no scroll and no resize event, so the
  // measurement has to re-run on layout change or the surface keeps the previous tab's answer
  // until the user happens to scroll — the same wrong-surface bug by another route.
  assert.match(hook, /new ResizeObserver\(schedule\)/);
  assert.match(hook, /ro\?\.disconnect\(\)/);
});

test("there is no dead frame at the swap: the incoming surface never fades in", () => {
  // The bar disappears synchronously. An incoming pill that animated opacity 0 -> 1 therefore left a
  // window with neither surface visible — captured at the crossing as
  // `bar: null, pill: { opacity: 0 }`, which is the reported gap. The pill still slides in, but on
  // transform only, at full opacity from its first frame.
  const kf = topbar.slice(topbar.indexOf("@keyframes slideDown"), topbar.indexOf("@keyframes slideDown") + 220);
  assert.ok(!/opacity/.test(kf), "the pill fades in again — that is the gap between the two surfaces");
  assert.match(kf, /transform: translateX\(-50%\) translateY\(-8px\)/);
  // And the motion itself is optional.
  assert.match(topbar, /@media \(prefers-reduced-motion: reduce\) \{\s*@keyframes slideDown/);
});

// ── (ii) The z-index scale ─────────────────────────────────────────────────────────────────────

test("the scale is named constants in one file, ordered as the panel spec requires", async () => {
  const { Z } = await import("../client/src/styles/zLayers.js");
  assert.ok(Z.CONTENT < Z.PANEL_POPOVER, "panel popovers must sit above in-flow content");
  assert.ok(Z.PANEL_POPOVER < Z.SEARCH, "the search surface must float above panel content");
  assert.ok(Z.SEARCH < Z.MODAL_SCRIM && Z.MODAL_SCRIM < Z.MODAL,
    "a drawer and its scrim must cover the search surface — the old 40-vs-50 had this inverted");
  assert.ok(Z.MODAL < Z.NAV, "nav chrome stays reachable while a drawer is open, as today");
  assert.ok(Z.NAV < Z.POPOVER, "a transient dropdown must never be underlapped, even by a drawer");
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
  assert.match(dockPortal, /zIndex: Z\.POPOVER/);
});

// ── (ii) The clipping, and the click ──────────────────────────────────────────────────────────

test("the clipped panel popover is portalled out of its overflow:hidden ancestor", () => {
  assert.match(dbPanel, /import \{ DockPortal \} from "\.\.\/components\/DockPortal\.jsx";/);
  // Both calendars — the sheet-level date filter and the per-row cell editor — go through the portal.
  assert.equal((dbPanel.match(/<DockPortal anchorRect=/g) || []).length, 2,
    "both date popovers must be portalled; the per-cell one is inside a scrolling table");
  // And the popover no longer frames or positions itself, because the portal does.
  assert.ok(!/position:"absolute", zIndex:300/.test(dbPanel),
    "the calendar is self-positioning again, which puts it back inside the clipping ancestor");
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
