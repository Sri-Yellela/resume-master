// THE ONE SURFACE Y2'S AUDIT COULD NOT MEASURE.
//
// components/ui/toast.jsx carried the Tailwind literal `z-[100]`. 100 is below Z.NAV (250), so a
// toast would have painted UNDER the top bar and under every overlay tier in the app. Nobody had
// noticed, and nobody could have: `toast()` and `useToast()` existed and nothing called them, and
// nothing rendered <Toaster/>, so the surface had no observable behaviour to audit. Mounting it is
// what made the number falsifiable.
//
// Two things were wrong, and the second is why fixing the number alone was not enough:
//
//   1. the tier — 100, below the bar. Now Z.TOAST, read as a CSS variable so this file holds no copy.
//   2. the STACKING CONTEXT — components/AppShell.jsx wraps the app in `relative z-10 min-h-screen`.
//      A z-index only orders an element against its siblings inside the nearest stacking context, so
//      11000 ordered the toast within that div and the whole subtree competed with the filters
//      drawer at z-index 10. Measured before the portal: viewport z-index 11000, drawer 600, and
//      document.elementFromPoint at the toast's own centre returned the drawer. No value would have
//      fixed it — this is zLayers.js rule 2's "a raw bump is not a fix".
//
// Verified in a real browser after both fixes: hit-test at the toast centre returns the toast, with
// the filters drawer open and again on the plain board.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Z } from "../client/src/styles/zLayers.js";

const read = (p) => fs.readFileSync(p, "utf8");
// Matching a comment is how a source-string test passes while the code says something else — and
// both files below explain themselves by QUOTING the literal they no longer use, so every negative
// assertion here has to read stripped source. Same helper shape as panelPeers.test.js.
const code = (src) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")   // JSX comments
  .replace(/\/\*[\s\S]*?\*\//g, "")         // block comments
  .replace(/^\s*\/\/.*$/gm, "");             // line comments
const toast = read("client/src/components/ui/toast.jsx");
const toaster = read("client/src/components/ui/toaster.jsx");
const app = read("client/src/App.jsx");

test("TOAST is a named tier at the top of the scale, above menus", () => {
  assert.equal(typeof Z.TOAST, "number");
  // Above every app surface INCLUDING POPOVER, which used to be the top. The asymmetry that earns
  // the exception: every other surface can be dismissed by the user, a toast cannot be summoned.
  // A covered toast is not an annoyance, it is a message that never arrived.
  for (const tier of ["NAV", "PANEL_POPOVER", "SEARCH", "SEARCH_DROPDOWN",
                      "DRAWER_SCRIM", "DRAWER", "MODAL_SCRIM", "MODAL", "POPOVER"]) {
    assert.ok(Z.TOAST > Z[tier], `Z.TOAST must outrank Z.${tier} (${Z.TOAST} vs ${Z[tier]})`);
  }
  // Also above the 9000-series full-screen modals listed as off-scale in zLayers.js: "your resume
  // was generated" has to be visible over the modal that generated it.
  assert.ok(Z.TOAST > 9998);
});

test("the viewport reads the tier as a variable and holds no copy of the number", () => {
  assert.match(toast, /z-\[var\(--z-toast\)\]/);
  assert.ok(!/z-\[100\]/.test(code(toast)), "the literal z-[100] is back");
  // installZLayerVars publishes --z-toast from Z.TOAST, so the variable cannot name a tier that
  // does not exist.
  const zl = read("client/src/styles/zLayers.js");
  assert.match(zl, /TOAST:\s*\d+/);
  assert.match(zl, /doc\.documentElement\.style\.setProperty\(`--z-\$\{name\.toLowerCase\(\)/);
});

test("the viewport is portalled to body, or its tier is confined to AppShell's stacking context", () => {
  assert.match(toast, /import \{ createPortal \} from "react-dom";/);
  assert.match(toast, /createPortal\(/);
  assert.match(toast, /document\.body/);
  // The ancestor that made this necessary. If this class ever stops creating a stacking context the
  // portal is still correct, but the reason recorded above would no longer apply — so it is pinned.
  const shell = read("client/src/components/AppShell.jsx");
  assert.match(shell, /relative z-10 min-h-screen/,
    "AppShell no longer creates the stacking context this portal exists to escape — re-check the note");
});

test("Toaster is mounted exactly once, and OUTSIDE the subtree useBoardLock inerts", () => {
  assert.match(app, /import \{ Toaster \}\s+from "\.\/components\/ui\/toaster\.jsx";/);
  const mounts = code(app).match(/<Toaster\s*\/>/g) || [];
  assert.equal(mounts.length, 1, "Toaster must be mounted once");

  // Placement matters as much as presence. useBoardLock inerts the CHILDREN of [data-app-shell]
  // while a panel or the filters drawer is open; a toast reporting the result of an action taken
  // inside that panel must not be inerted with the board behind it.
  const appCode = code(app);
  const shellOpen = appCode.indexOf("<div data-app-shell");
  const shellClose = appCode.indexOf("</div>", appCode.indexOf("{importOpen && ("));
  const toasterAt = code(app).indexOf("<Toaster />");
  assert.ok(toasterAt > shellClose,
    "<Toaster /> is inside [data-app-shell] — useBoardLock would inert it along with the board");
  assert.ok(shellOpen > 0 && shellClose > shellOpen);
});

test("the toaster renders the viewport inside the provider, so Radix context still reaches it", () => {
  // createPortal preserves React context, which is what makes portalling the viewport safe. If the
  // viewport were moved outside <ToastProvider> the toasts would render nowhere and this file's
  // other assertions would still pass.
  const providerAt = toaster.indexOf("<ToastProvider>");
  const viewportAt = toaster.indexOf("<ToastViewport />");
  const closeAt = toaster.indexOf("</ToastProvider>");
  assert.ok(providerAt >= 0 && viewportAt > providerAt && closeAt > viewportAt);
});
