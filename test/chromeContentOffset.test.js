// Y3 — NOTHING SLIDES UNDER THE CHROME.
//
// This is layout, not stacking. Y2 fixed which surface paints on top; this fixes where content
// STARTS. They are separate bugs on the same pair of elements, and a z fix cannot repair an offset.
//
// MEASURED PER TAB BEFORE THE FIX, at 1440x900 — and the four non-Jobs tabs turned out to share one
// cause that is NEITHER of the two the report proposed:
//
//   tab            top bar   search bar paints   search bar reserves   <main>   first content   overlap
//   Jobs           0->46     245->398            245->398              398      422             0
//   Auto Apply     0->46      56->209              0->153              153      177            32
//   Job Profiles   0->46      56->209              0->153              153      177            32
//   Database       0->46      56->209              0->153              153      177            32
//   Recruiter      0->46      56->209              0->153              153      177            32
//
// Not missing offset: `<main>` starts at 153, exactly after the 153px the bar reserves. Not a wrong
// container bound either. The cause is `position: sticky; top: 56px` on an element whose STATIC
// position on those tabs is 0 — the hero renders only on Jobs, so the bar is the first in-flow child.
// A sticky box already above its threshold paints displaced from the space it reserves, by the full
// 56px, and those 56px land on content that reserved correctly for the unshifted box.
//
// Jobs escaped it by accident: its 386px hero puts the bar's static position at 245, far below the
// threshold, so sticky is not engaged at rest.
//
// AFTER, same measurement: every tab 0px overlap, and Jobs is unchanged to the pixel (bar 245->398,
// main 398, first content 422).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const strip = (t) => t
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*(?:\/\/|\*).*$/gm, "");

const hook = read("client/src/hooks/useChromeHeight.js");
const app  = read("client/src/App.jsx");
const bar  = read("client/src/components/TopBar.jsx");
const css  = read("client/src/components/UnifiedSearchBar.css");

test("the chrome's height is MEASURED off the real element, not declared", () => {
  // Y3's requirement 2 verbatim: "measured rather than hardcoded — the chrome's height changes
  // between Jobs (with search bar) and other tabs (without, after Y4)".
  assert.match(hook, /getBoundingClientRect\(\)\.height/,
    "the chrome height is not read off the element");
  assert.match(hook, /querySelector\("\[data-app-chrome\]"\)/);
  assert.match(bar, /data-app-chrome=""/, "the top bar is not marked as the measured chrome");
  // Exactly one element carries the marker: two would make "the chrome's height" ambiguous, and
  // querySelector would silently pick whichever came first in the DOM.
  assert.equal((strip(bar).match(/data-app-chrome/g) || []).length, 1);

  // A ResizeObserver, because the height moves with font loading, zoom, a badge appearing, and
  // (after Y4) which tab is showing. None of those fire a resize event.
  assert.match(hook, /new ResizeObserver\(apply\)/);
  assert.match(hook, /ro\?\.disconnect\(\)/, "the observer leaks");
  // Subscribed once. With no dep array the effect would re-subscribe every render, and since it
  // also sets state that is a resubscribe loop rather than a measurement.
  assert.match(hook, /\}, \[\]\);/, "the measurement effect is not subscribed exactly once");
});

test("the in-flow column RESERVES that height, which is what removes the overlap", () => {
  // The top bar is position:fixed and reserves nothing. Before this, two unrelated things absorbed
  // it by accident — the hero's 80px top padding on Jobs, the search bar's own reserved box on the
  // others — and the second was wrong by 56px.
  assert.match(app, /const chromeHeight = useChromeHeight\(\);/);
  assert.match(app, /paddingTop: chromeHeight,/,
    "the shell no longer reserves the chrome's height, so content starts underneath it again");
  // On the same element that owns the app's children, so every tab inherits the reserve rather than
  // each panel remembering to add it.
  const shellAt = app.indexOf("<div data-app-shell");
  assert.ok(shellAt > 0, "the app shell element moved");
  assert.ok(app.slice(shellAt, shellAt + 400).includes("paddingTop: chromeHeight"),
    "the reserve is not on the shell — a per-panel offset is what four tabs would each get wrong");
});

test("the sticky search bar's threshold IS the reserve, so it cannot be displaced", () => {
  // The 56px literal was wrong twice over. Wrong VALUE: its own comment said "pins under the 56px
  // TopBar" while the app's bar is 46px — 56 is the MARKETING NavBar's height, copied onto app
  // chrome of a different size. And wrong SHAPE: any threshold above the element's static position
  // displaces the painted box by the difference.
  assert.match(css, /top: var\(--app-chrome-height, 46px\);/,
    "the sticky offset is a literal again");
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\.usb--inline[^{]*\{[^}]*top:\s*56px/.test(cssCode),
    "the inline search bar is pinned to a hardcoded 56px again");
  // The var is published from the SAME measurement the shell reserves, which is what makes the
  // static position and the threshold equal by construction.
  assert.match(hook, /CHROME_HEIGHT_VAR = "--app-chrome-height"/);
  assert.match(hook, /setProperty\(CHROME_HEIGHT_VAR, `\$\{h\}px`\)/);
});

test("the hero's offset became a distance BELOW the chrome, not an absolute one", () => {
  // 80px cleared a 46px bar only by coincidence and would stop clearing it the moment the bar grew.
  // 34 + the reserved 46 is the same 80px from the viewport top the hero has always had, which is
  // why the Jobs tab measures pixel-identical before and after.
  assert.match(app, /padding:"34px 20px 40px"/);
  assert.ok(!strip(app).includes('padding:"80px 20px 40px"'),
    "the hero is back on an absolute offset that clears the chrome by coincidence");
});

test("THE TOP BAR IS FIXED, DELIBERATELY, AND THAT DECISION IS RECORDED", () => {
  // Y3's requirement 4 asks for an explicit decision rather than an inherited one. It is FIXED, so
  // content scrolls beneath it by design and the offset only has to be correct at rest.
  //
  // Why fixed and not scrolled-away: after Y4 the TAB ROW lives in this bar. A tab row that scrolls
  // out of reach is worse than postings passing behind one — the tabs are how you leave the board,
  // and 2340px of scrollable Jobs board would put them out of reach for most of it.
  assert.match(bar, /position: "fixed",/);
  const barAt = bar.indexOf("data-app-chrome");
  const decl = bar.slice(Math.max(0, barAt - 1200), barAt + 600);
  assert.match(decl, /data-app-chrome marks the element whose HEIGHT the in-flow column has to reserve/,
    "the reason the bar is measured rather than assumed is no longer written down");
});
