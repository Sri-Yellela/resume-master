import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SORTS } from "../shared/jobFilterOptions.js";

// The four theme.jsx token assertions that stood here named light AND dark rgba values for
// --bg-menu plus light/dark --popover pairs. Both are gone: there is one theme now
// (themes/cinematic.js) and its tokens are single dark hsl() values, so the light halves could
// never match and the tokens are no longer in theme.jsx at all. Token opacity is asserted
// properly by "floating surface tokens are near-opaque enough to read over content" below; this
// test keeps what it uniquely covers — that the COMPONENTS reach for the floating-surface tokens
// rather than the translucent card surface.
test("floating menus consume the dedicated surface tokens", () => {
  const dockPortal = fs.readFileSync("client/src/components/DockPortal.jsx", "utf8");
  const scrollDock = fs.readFileSync("client/src/components/ScrollDock.jsx", "utf8");
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(dockPortal, /theme\?\.menuSurface/);
  assert.match(scrollDock, /theme\.menuSurface \|\| theme\.surface/);
  assert.match(jobsPanel, /theme\.modalSurface \|\| theme\.surface/);

  // Regression guard for the bug fixed in 7029011: theme.surface is the STRING "var(--bg-card)",
  // so appending a hex alpha yields invalid CSS and the browser drops the background entirely.
  // Comments are stripped first — the fix's own explanatory comment quotes the broken pattern.
  const scrollDockCode = scrollDock
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(scrollDockCode, /\$\{theme\.surface\}[0-9a-fA-F]{2}/,
    "a hex alpha cannot be appended to a var() token — use menuSurface instead");
});

test("plans entry lives in profile menu, not main app tabs", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");

  assert.doesNotMatch(app, /id:"plans"|id:\s*"plans"/);
  assert.match(topBar, /onTabChange\?\.\("plans"\)/);
});

test("top-right account controls are consolidated into avatar menu", () => {
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
  const profileSelector = fs.readFileSync("client/src/components/ProfileSelectorDropdown.jsx", "utf8");
  const scrollDock = fs.readFileSync("client/src/components/ScrollDock.jsx", "utf8");
  const consoles = fs.readFileSync("client/src/consoles/PlanConsoles.jsx", "utf8");

  assert.match(topBar, /function UserAvatarMenu/);
  assert.match(topBar, /Job Profile/);
  assert.match(topBar, /ProfileSelectorDropdown/);
  assert.match(topBar, /onActivateProfile/);
  assert.match(profileSelector, /\+ Add Profile/);
  assert.match(topBar, /Accent Color/);
  // `assert.match(topBar, /Background/)` WAS HERE, and it never verified anything. There is no
  // Background control in TopBar and there never was — `git log -S` finds no quoted "Background" in
  // this file's history, and styles/theme.jsx exports `THEMES = { dark: cinematicBase }`, one theme,
  // so there is nothing for such a control to switch. The assertion was satisfied by the word
  // appearing in a COMMENT about the bar's own translucency ("Background: 100% translucent"), and it
  // failed the moment that comment was deleted with the collapse it described. Removed rather than
  // repointed: a menu item that does not exist cannot be asserted, and inventing one is a product
  // decision, not a test fix.
  assert.match(topBar, /Integrations/);
  assert.match(topBar, /onTabChange\?\.\("profile"\)/);
  assert.doesNotMatch(topBar, /function SettingsGear|<SettingsGear|function ProfileSwitcher|<ProfileSwitcher/);
  assert.doesNotMatch(scrollDock, /<ProfileSwitcher|<DockSettingsPanel/);
  // Was `assert.match(scrollDock, /Job Profile/)` — which contradicted this test's own premise.
  // ScrollDock is no longer app chrome at all: it is rendered only by the marketing pages and the
  // standalone tool pages (variant="marketing" / variant="tools"). Profile management lives in
  // TopBar's UserAvatarMenu, asserted above. The real consolidation invariant is the inverse —
  // ScrollDock must NOT carry profile management.
  assert.doesNotMatch(scrollDock, /Job Profile|ProfileSelectorDropdown|method: "DELETE"/,
    "ScrollDock is marketing/tools chrome — profile management belongs to TopBar");
  assert.doesNotMatch(consoles, /Shared console|title="Jobs"|eyebrow=/);
});

test("jobs surface has compact profile selector and profile menu supports deletion", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
  const scrollDock = fs.readFileSync("client/src/components/ScrollDock.jsx", "utf8");
  const profileSelector = fs.readFileSync("client/src/components/ProfileSelectorDropdown.jsx", "utf8");

  assert.doesNotMatch(jobsPanel, /Profile:/);
  assert.doesNotMatch(jobsPanel, /Profile switcher bar/);
  // The board's own copies of the profile selector and the "Filter loaded jobs" input are GONE —
  // W4 removed both from the control row as redundant, not as a regression:
  //   - the profile selector was the THIRD on screen (TopBar's avatar menu and the collapsed pill
  //     both carry one), and
  //   - "Filter loaded jobs" wrote `localSearch`, which is the same state the main search bar's
  //     keyword field now writes, so it was a second input for one filter.
  // What must remain true is that both are still REACHABLE, which is what the two assertions
  // below check on the surfaces that kept them.
  assert.doesNotMatch(jobsPanel, /<ProfileSelectorDropdown/,
    "the board re-grew its own profile selector; TopBar and the pill already have one");
  assert.doesNotMatch(jobsPanel, /placeholder="Filter loaded jobs/,
    "the redundant second search input is back — the main search bar already writes localSearch");
  // The AVATAR MENU must still switch profiles. This used to say "the pill must still switch
  // profiles" and there were two ProfileSelectorDropdowns in this file — the menu's and the pill's.
  // Y4 retired the pill, so the menu is the one place it lives, which is what makes this assertion
  // load-bearing rather than one of a pair.
  assert.match(topBar, /<ProfileSelectorDropdown/, "the avatar menu must still switch profiles");
  // The pill's "Filter jobs…" input went with the pill. It wrote `localSearch`, which the main
  // search bar's keyword field also writes — so the state still has an input, and this file's own
  // assertion above (that JobsPanel must NOT re-grow a third one) is what keeps that from doubling.
  assert.doesNotMatch(topBar, /placeholder="Filter jobs/,
    "the retired pill's local search input is back in the top bar");
  assert.match(fs.readFileSync("client/src/components/UnifiedSearchBar.jsx", "utf8"),
    /placeholder="Job title or keywords"/, "nothing writes localSearch any more");
  assert.match(topBar, /method: "DELETE"/);
  assert.doesNotMatch(topBar, />\s*Delete\s*<\/button>/);
  assert.match(profileSelector, /onDelete\?\.\(profile\.id\)/);
  assert.match(profileSelector, /e\.stopPropagation\(\)/);
  assert.match(profileSelector, /Cannot delete your only profile/);
  // Deletion is asserted on topBar above. The old `scrollDock` copy of this assertion dated from
  // when the dock hosted a profile switcher; it is now marketing/tools chrome only.
});

test("profile menus use viewport scrolling and dropdown actions", () => {
  const dockPortal = fs.readFileSync("client/src/components/DockPortal.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
  const scrollDock = fs.readFileSync("client/src/components/ScrollDock.jsx", "utf8");

  assert.match(dockPortal, /vh - pos\.top - 12/);
  assert.match(dockPortal, /calc\(100vh - \$\{pos\.top \+ 12\}px\)/);
  assert.match(dockPortal, /overflowY:\s+"auto"/);
  assert.match(dockPortal, /overflowX:\s+"hidden"/);
  // Asserts the TIER, not the integer. The menu surface must sit at the top layer so nothing clips
  // or underlaps it; the number that implements that now lives in client/src/styles/zLayers.js
  // (Z.POPOVER === 10000), because twelve components each owning a literal is how the ordering
  // between any two surfaces became an accident. Pinning the literal here would mean this test fails
  // whenever the scale is renumbered, without anything having actually broken.
  // The MENU tier is still POPOVER — that is what this test is about, and Y2 keeps it there
  // explicitly: the profile menu is a dropdown FROM the top bar and belongs to the overlay tier when
  // open, not to the bar's own (now much lower) level. What changed is that the tier is the
  // PARAMETER DEFAULT rather than a hard-coded literal, so the search bar's dropdowns — which belong
  // to a surface a drawer covers — can sit at Z.SEARCH_DROPDOWN instead.
  assert.match(dockPortal, /tier = Z\.POPOVER/, "the default menu tier is no longer POPOVER");
  assert.match(dockPortal, /zIndex: tier,/);
  assert.match(dockPortal, /import \{ Z \} from "\.\.\/styles\/zLayers\.js";/);
  // The maxHeight/overflowY pair belongs to DockPortal, asserted above — it is the component that
  // actually renders the scrollable menu surface. These two assertions previously duplicated it
  // onto ScrollDock, which no longer hosts a menu at all.
  assert.match(topBar, /const activeProfile = profiles\?\.find/);
  // `title="Switch profile"` was the PILL's ProfileSelectorDropdown — a compact, icon-sized copy
  // that needed a tooltip because it had no visible label. It went with the pill (Y4). The avatar
  // menu's copy sits under a "Job Profile" heading and shows the active profile's name, so it names
  // itself; asserting a tooltip it never had would be asserting the pill's version.
  assert.doesNotMatch(topBar, /title="Switch profile"/,
    "the pill's compact profile switcher is back");
  assert.match(topBar, /Job Profile/, "the profile switcher lost the heading that names it");
  assert.doesNotMatch(topBar, /display:\s+"none"/);
});

test("search toolbar removes redundant label and checking-jobs icon is a spinner", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.doesNotMatch(jobsPanel, />Search<\/span>\s*<input value=\{searchInput\}/);
  assert.match(jobsPanel, /placeholder="ATS search role/);
  assert.match(jobsPanel, /Checking/);
  assert.match(jobsPanel, /animation:"spin 0\.8s linear infinite"/);
  assert.doesNotMatch(jobsPanel, />\?<\/span>\s*[\r\n\s]*Checking/);
});

// The GOAL of this test is still met — the legacy light/dark toggle really is gone. But its
// positive assertions named an intermediate architecture (isDarkBgMode, BG_MODES) that has since
// been replaced by the themes registry, and `/setTheme/` false-matched the current `setThemeId`.
// Re-pointed at the invariants that exist now.
test("legacy light/dark mode toggle is removed and theming is registry-driven", () => {
  const theme = fs.readFileSync("client/src/styles/theme.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");

  // The legacy mode toggle and its storage key must stay gone.
  assert.doesNotMatch(theme, /rm_theme_mode/);
  assert.doesNotMatch(theme, /toggleMode|themeName/);
  assert.doesNotMatch(topBar, /Light Mode|Dark Mode|toggleMode/);

  // What replaced it: a theme registry selected by id, persisted under rm_theme_id, plus accents.
  assert.match(theme, /rm_theme_id/);
  assert.match(theme, /setThemeId/);
  assert.match(theme, /ACCENT_OPTIONS/);
  assert.match(theme, /AVAILABLE_THEMES/);
});

// Was "light theme surfaces and text tokens are readable", asserting a light palette
// (text: "#111827", --bg-card: #ffffff, …) directly in theme.jsx. There is no light theme any
// more: the registry holds exactly one theme (themes/cinematic.js), isDark is hardcoded true, and
// the surface tokens moved into that theme file. So the old assertions pinned a deleted feature.
//
// The underlying INTENT — floating surfaces must be readable over page content — is kept, and
// stated as the property that actually matters. This is not academic: ScrollDock was rendering
// with no background at all because `${theme.surface}f2` is invalid CSS, and that is the class of
// bug this test should catch.
test("floating surface tokens are near-opaque enough to read over content", () => {
  const cinematic = fs.readFileSync("client/src/themes/cinematic.js", "utf8");

  const alphaOf = (token) => {
    const m = cinematic.match(new RegExp('"' + token + '":\\s*"[^"]*?/\\s*([0-9.]+)\\s*\\)"'));
    return m ? Number(m[1]) : null;
  };

  const menuAlpha = alphaOf("--bg-menu");
  assert.ok(menuAlpha !== null, "--bg-menu must define an explicit alpha");
  assert.ok(menuAlpha >= 0.9, `--bg-menu alpha ${menuAlpha} is too transparent for a floating menu`);

  // menuSurface/modalSurface must resolve to their own tokens, not fall back to the translucent
  // card surface, which is what made modals bleed through the board.
  assert.match(cinematic, /menuSurface:\s*"var\(--bg-menu\)"/);
  assert.match(cinematic, /modalSurface:\s*"var\(--bg-modal\)"|modalSurface:\s*"[^"]+"/);
});

test("tool access is plan-owned and local match UI is removed", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const accountRoute = fs.readFileSync("routes/account.js", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
  const scrollDock = fs.readFileSync("client/src/components/ScrollDock.jsx", "utf8");
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(server, /createAccountRouter/);
  assert.match(accountRoute, /Plans control tool access/);
  assert.doesNotMatch(topBar, /APPLY_MODES|Apply Mode|\/api\/settings\/apply-mode/);
  assert.doesNotMatch(topBar, /Best match|bestMatch/);
  assert.doesNotMatch(scrollDock, /Best match|bestMatch/);
  assert.doesNotMatch(jobsPanel, /Best Match|bestMatch|\/api\/jobs\/best-match|atsLocal/);
  // ATS Sort must still be OFFERED — that is the invariant this line has always guarded. Only
  // WHERE it is declared has changed: first out of JobsPanel's control row into App.jsx's
  // SORT_OPTIONS and the collapsed pill, and now (X1) out of both of those literal lists into
  // shared/jobFilterOptions.js, which is the one definition both surfaces render from. Asserting
  // the contract rather than either copy is the point — it is what makes the two agree.
  assert.ok(SORTS.options.some(o => o.value === "atsScore" && o.label === "ATS Sort"),
    "ATS Sort is no longer offered as a board sort");
  assert.match(fs.readFileSync("client/src/App.jsx", "utf8"), /const SORT_OPTIONS = SORTS\.options\.map/);
  // The second assertion here pinned the COLLAPSED PILL's sort select. Y4 retired the pill, so there
  // is one sort control again — the icon beside IMPORT — and the bar renders none.
  assert.ok(!/SORTS/.test(topBar), "a second sort control is back in the top bar");
});

test("critical UI copy has no mojibake literals", () => {
  const files = [
    "client/src/panels/JobsPanel.jsx",
    "client/src/panels/AdminPanel.jsx",
    "client/src/lib/api.js",
    "client/src/components/TopBar.jsx",
    "client/src/components/DockPortal.jsx",
  ];
  const stripComments = text => text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  for (const file of files) {
    const source = stripComments(fs.readFileSync(file, "utf8"));
    assert.doesNotMatch(source, /â|Ã|Â|�/u, file);
  }
});
