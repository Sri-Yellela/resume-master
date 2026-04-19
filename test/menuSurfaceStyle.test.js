import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("floating menus use near-opaque readable surfaces", () => {
  const theme = fs.readFileSync("client/src/styles/theme.jsx", "utf8");
  const dockPortal = fs.readFileSync("client/src/components/DockPortal.jsx", "utf8");
  const scrollDock = fs.readFileSync("client/src/components/ScrollDock.jsx", "utf8");
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(theme, /--bg-menu:\s+rgba\(255,255,255,0\.98\)/);
  assert.match(theme, /--bg-menu:\s+rgba\(28,28,30,0\.98\)/);
  assert.match(theme, /--popover:\s+0 0% 100%/);
  assert.match(theme, /--popover:\s+240 4% 11%/);
  assert.match(dockPortal, /theme\?\.menuSurface/);
  assert.match(scrollDock, /theme\.menuSurface \|\| theme\.surface/);
  assert.match(jobsPanel, /theme\.menuSurface \|\| theme\.surface/);
  assert.match(jobsPanel, /theme\.modalSurface \|\| theme\.surface/);
});

test("plans entry lives in profile menu, not main app tabs", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");

  assert.doesNotMatch(app, /id:"plans"|id:\s*"plans"/);
  assert.match(topBar, /onTabChange\?\.\("plans"\)/);
});

test("top-right account controls are consolidated into avatar menu", () => {
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
  const scrollDock = fs.readFileSync("client/src/components/ScrollDock.jsx", "utf8");
  const consoles = fs.readFileSync("client/src/consoles/PlanConsoles.jsx", "utf8");

  assert.match(topBar, /function UserAvatarMenu/);
  assert.match(topBar, /Job Profile/);
  assert.match(topBar, /onActivateProfile\?\.\(p\.id\)/);
  assert.match(topBar, /Accent Color/);
  assert.match(topBar, /Background/);
  assert.match(topBar, /Apify Token/);
  assert.match(topBar, /onTabChange\?\.\("profile"\)/);
  assert.doesNotMatch(topBar, /function SettingsGear|<SettingsGear|function ProfileSwitcher|<ProfileSwitcher/);
  assert.doesNotMatch(scrollDock, /<ProfileSwitcher|<DockSettingsPanel/);
  assert.match(scrollDock, /Job Profile/);
  assert.doesNotMatch(consoles, /Shared console|title="Jobs"|eyebrow=/);
});

test("legacy light dark mode toggle is removed while bg themes remain", () => {
  const theme = fs.readFileSync("client/src/styles/theme.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");

  assert.doesNotMatch(theme, /localStorage\.getItem\("rm_theme_mode"\)|localStorage\.setItem\("rm_theme_mode"/);
  assert.doesNotMatch(theme, /toggleMode|setTheme|themeName/);
  assert.match(theme, /isDarkBgMode/);
  assert.match(theme, /BG_MODES/);
  assert.doesNotMatch(topBar, /Light Mode|Dark Mode|toggleMode/);
});

test("light theme surfaces and text tokens are readable", () => {
  const theme = fs.readFileSync("client/src/styles/theme.jsx", "utf8");

  assert.match(theme, /text:\s+"#111827"/);
  assert.match(theme, /textMuted:\s+"#374151"/);
  assert.match(theme, /border:\s+"#d1d5db"/);
  assert.match(theme, /--bg-card:\s+rgba\(255,255,255,0\.68\)/);
  assert.match(theme, /--bg-card:\s+rgba\(255,255,255,0\.58\)/);
  assert.match(theme, /--bg-panel:\s+rgba\(245,248,252,0\.64\)/);
  assert.match(theme, /--bg-input:\s+rgba\(255,255,255,0\.72\)/);
  assert.match(theme, /--bg-card:\s+#ffffff/);
});

test("tool access is plan-owned and local match UI is removed", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");
  const scrollDock = fs.readFileSync("client/src/components/ScrollDock.jsx", "utf8");
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(server, /Plans control tool access/);
  assert.doesNotMatch(topBar, /APPLY_MODES|Apply Mode|\/api\/settings\/apply-mode/);
  assert.doesNotMatch(topBar, /Best match|bestMatch/);
  assert.doesNotMatch(scrollDock, /Best match|bestMatch/);
  assert.doesNotMatch(jobsPanel, /Best Match|bestMatch|\/api\/jobs\/best-match|atsLocal/);
  assert.match(jobsPanel, /value="atsScore">ATS Sort/);
});
