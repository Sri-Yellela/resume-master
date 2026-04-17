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
