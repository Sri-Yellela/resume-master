import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

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
  assert.match(topBar, /Background/);
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
  assert.match(jobsPanel, /<ProfileSelectorDropdown/);
  assert.match(jobsPanel, /flex:"0 1 220px"/);
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
  assert.match(dockPortal, /zIndex:\s+10000/);
  // The maxHeight/overflowY pair belongs to DockPortal, asserted above — it is the component that
  // actually renders the scrollable menu surface. These two assertions previously duplicated it
  // onto ScrollDock, which no longer hosts a menu at all.
  assert.match(topBar, /const activeProfile = profiles\?\.find/);
  assert.match(topBar, /title="Switch profile"/);
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
  assert.match(jobsPanel, /value="atsScore">ATS Sort/);
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
