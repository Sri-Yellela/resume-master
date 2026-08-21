// The search bar's dropdowns must not fall back to browser/OS chrome.
//
// They rendered near-white text on a near-white surface, invisible until hover, which then showed
// the OS highlight — purple on cyan. Probed on the running board, the cause was not a wrong colour
// in our CSS but the ABSENCE of one: the <option> elements had no rule at all, so they inherited
// `color` from the select (--color-text, correct for the closed control on the dark glass bar) and
// their background stayed transparent, because a native option list is painted by the browser and
// the OS. Our text, their surface.
//
// The route taken was replacement, not extra CSS: `.usb__sel option { background }` holds on
// Windows and Linux Chrome and is silently ignored on macOS, where the popup is a native AppKit
// menu — so patching it would have produced a dropdown that looked right only where it was tested.
// UsbSelect renders a real listbox through DockPortal, the primitive ProfileSelectorDropdown,
// TopBar and DatabasePanel already use.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const stripComments = (t) => t
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

// Comments stripped: this file's own notes talk ABOUT <select>, and a substring search would read
// the explanation of the bug as the bug.
const usb    = stripComments(read("client/src/components/UnifiedSearchBar.jsx"));
const select = read("client/src/components/UsbSelect.jsx");
const css    = read("client/src/components/UnifiedSearchBar.css");

test("the bar renders no native <select> — the element whose popup we cannot style", () => {
  assert.ok(!/<select/.test(usb), "a native <select> is back in the search bar");
  assert.ok(!/<option/.test(usb), "a native <option> is back in the search bar");
  // All three dropdowns go through the one replacement, so they cannot drift apart.
  const uses = [...usb.matchAll(/<UsbSelect\b/g)].length;
  assert.equal(uses, 3, `expected 3 UsbSelect dropdowns (Experience, Domain, Status), found ${uses}`);
  for (const label of ["Experience", "Domain", "Status"]) {
    assert.match(usb, new RegExp(`ariaLabel="${label}"`), `the ${label} dropdown lost its label`);
  }
});

test("it reuses DockPortal rather than being a fourth popup implementation", () => {
  // DockPortal already solves, and documents, the things a hand-rolled popup gets wrong here:
  // dismiss-on-outside-pointerdown without EATING the click, Escape, the POPOVER z tier, and
  // portalling to document.body so .usb (position:fixed, transformed) cannot clip it.
  assert.match(select, /import \{ DockPortal \} from "\.\/DockPortal\.jsx"/);
  assert.match(select, /<DockPortal/);
});

test("every colour in the open list comes from a design token, never a literal or the OS", () => {
  const block = css.slice(css.indexOf("/* ── The open list"));
  assert.ok(block.length > 200, "the open-list style block moved");
  // No hex/rgb literal may appear except as the second argument of var(), which is the fallback
  // this stylesheet already uses everywhere for when the theme bridge has not painted yet.
  const withoutFallbacks = block.replace(/var\([^)]*\)/g, "");
  const literals = withoutFallbacks.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g) || [];
  assert.deepEqual(literals, [], `hard-coded colours in the dropdown: ${literals.join(", ")}`);
  for (const token of ["--color-text-muted", "--color-text", "--color-primary"]) {
    assert.ok(block.includes(token), `the open list does not use ${token}`);
  }
  // The rows must paint their OWN background. That is the entire fix: a transparent row is a row
  // whose legibility depends on whatever the OS drew behind it.
  assert.match(block, /\.usb__opt--active \{\s*background:/);
});

test("hover and focus are ours, and focus is visible for keyboard users", () => {
  // The native control had a UA focus ring; replacing the element removes it, so it has to come
  // back explicitly or the bar becomes unusable by keyboard.
  assert.match(css, /\.usb__sel--btn:focus-visible \{\s*outline: 2px solid var\(--color-primary/);
  assert.match(css, /\.usb__sel--btn:hover\s*\{\s*color: var\(--color-primary/);
  // One highlight class, whether it was reached by mouse or by arrow key — two would let the
  // pointer and the keyboard cursor disagree and paint two highlighted rows.
  assert.match(select, /onMouseMove=\{\(\) => setActive\(i\)\}/);
  assert.match(select, /isActive\s*\?\s*" usb__opt--active"/);
});

test("the listbox is navigable and announced", () => {
  assert.match(select, /role="combobox"/);
  assert.match(select, /aria-haspopup="listbox"/);
  assert.match(select, /aria-expanded=\{open\}/);
  assert.match(select, /role="listbox"/);
  assert.match(select, /role="option"/);
  assert.match(select, /aria-selected=\{isSelected\}/);
  // Focus stays on the trigger and aria-activedescendant names the highlighted row, so the arrows
  // are followed by a screen reader without focus moving into a list portalled elsewhere in the DOM.
  assert.match(select, /aria-activedescendant=/);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Enter"]) {
    assert.ok(select.includes(`"${key}"`), `the listbox does not handle ${key}`);
  }
});

test("Tab is not swallowed, and Escape does not alter the value", () => {
  // A dropdown that traps Tab is worse for a keyboard user than one that is merely ugly.
  assert.match(select, /if \(e\.key === "Tab"\) \{ if \(open\) close\(\{ refocus: false \}\); return; \}/);
  // Escape closes only. `active` is the keyboard cursor and is deliberately separate from `value`;
  // nothing is committed until Enter, so an arrow press cannot fire a board refetch either.
  const escStart = select.indexOf('case "Escape":');
  const esc = select.slice(escStart, select.indexOf("break;", escStart));
  assert.ok(!/onChange|commit\(/.test(esc), "Escape commits a value — it must only close");
});

test("an open list closes on scroll instead of floating away from its anchor", () => {
  // The bar is position:fixed and swaps with the collapsed pill on scroll (see useSearchSurface).
  // DockPortal positions from a rect captured at open time and does not follow anything, so a list
  // left open across that swap would be anchored to an element that is no longer showing.
  assert.match(select, /window\.addEventListener\("scroll", onScroll, true\)/);
  assert.match(select, /window\.removeEventListener\("scroll", onScroll, true\)/);
});

test("the closed control is unchanged — only the open list was ever wrong", () => {
  // The bar's own layout must not shift: same class on the field wrapper, same flex sizing, same
  // font size and text colour on the control itself.
  assert.match(usb, /<div className="usb__field usb__field--sel">/);
  assert.match(css, /\.usb__field--sel\s*\{ flex: 0 0 auto; \}/);
  const closed = css.slice(css.indexOf(".usb__sel {"), css.indexOf(".usb__sel-label"));
  assert.match(closed, /font-size: \.875rem;/);
  assert.match(closed, /color: var\(--color-text, #cdccca\);/);
  assert.match(closed, /background: transparent;/);
});

test("the chevron animation respects prefers-reduced-motion", () => {
  const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(rm, /\.usb__chev \{ transition: none; \}/);
});
