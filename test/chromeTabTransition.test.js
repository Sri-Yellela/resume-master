// Y4 — THE CHROME'S HEIGHT VARIES BY TAB, AND THE CHANGE IS ANIMATED.
//
// Moving the tab row into the top bar and dropping the search bar from every tab but Jobs makes the
// in-flow chrome 539px on Jobs (a 386px hero plus a 153px search bar, measured at 1440x900) and 0px
// everywhere else. Switching to or from Jobs therefore moves everything below it by 539px.
//
// THE TRAP THE OBVIOUS IMPLEMENTATION FALLS INTO, and the reason this is worth a test of its own.
// The chrome being wrapped CONTAINS a `position: sticky` element — the search bar, pinned under the
// top bar so its controls stay reachable while the board scrolls — and a sticky box is constrained
// to its PARENT's box. A wrapper around it becomes that constraint, so the bar pins only until the
// wrapper scrolls past and then leaves with it. This was hit for real; the measurement is in the
// test below.
//
// So the wrapper generates NO BOX at rest (`display: contents`) and becomes a real, clipping,
// height-animating box only for the ~320ms it is transitioning. At rest the tree is, to layout,
// exactly what it was before the wrapper existed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const hook = read("client/src/hooks/useCollapsibleHeight.js");
const app  = read("client/src/App.jsx");

test("the height change is animated, and the animation is what the chrome is wrapped in", () => {
  assert.match(app, /const jobsChrome = useCollapsibleHeight\(activeTab === "console"\);/,
    "the Jobs chrome is no longer collapsible — switching tabs jumps");
  assert.match(app, /<div ref=\{jobsChrome\.outerRef\} style=\{jobsChrome\.outerStyle\}>/);
  assert.match(app, /<div ref=\{jobsChrome\.innerRef\} style=\{jobsChrome\.innerStyle\}>/);
  assert.match(app, /\{jobsChrome\.mounted && \(/,
    "the children are not gated on `mounted`, so a collapse animates from nothing");
  // The transition is DECLARED (in outerStyle) rather than set imperatively, so it cannot race the
  // height it animates — an imperative `style.transition` written in the same tick as
  // `style.height` is applied in an undefined order relative to it.
  assert.match(hook, /transition: `height \$\{DURATION_MS\}ms \$\{EASING\}`/);
  assert.match(hook, /const DURATION_MS = 320;/);
});

test("THE WRAPPER GENERATES NO BOX AT REST — the sticky search bar depends on it", () => {
  // MEASURED, NOT REASONED. With a plain always-a-box wrapper and no clipping at all, on the running
  // board:
  //
  //     scrollY      search bar top
  //        0            245        <- at rest, correct
  //      100            145
  //      300            -55        <- gone: it should have pinned at 46
  //     2200          -1955
  //
  // A sticky box is constrained to its PARENT's box, so a wrapper 352px tall lets the bar pin for
  // 352px and then carries it away — taking the All/Saved/Pending tabs, the filter and sort icons
  // and IMPORT out of reach for 2000px of a 2340px board. Caused by the wrapper EXISTING, not by
  // its overflow.
  //
  // `display: contents` is the fix: at rest the wrapper generates no box, so the bar's containing
  // block is the app shell, exactly as before the wrapper was introduced. After the fix, same
  // measurement: bar top 245 at rest, then 46 at scrollY 300 / 700 / 1400 / 2200 — pinned for the
  // whole board, and pinned again after a Jobs -> Database -> Jobs round trip.
  assert.match(hook, /const boxless = \{ display: "contents" \};/);
  assert.match(hook, /outerStyle: animating\s*\n\s*\? \{ transition: `height \$\{DURATION_MS\}ms \$\{EASING\}`, willChange: "height" \}\s*\n\s*: boxless,/,
    "the wrapper generates a box at rest — the sticky bar will unstick mid-board");
  assert.match(hook, /innerStyle: animating \? undefined : boxless,/);

  // `overflow: hidden` traps sticky the same way, so it is confined to the animating phase and set
  // imperatively alongside the height it clips.
  assert.match(hook, /outer\.style\.overflow = "hidden";/);
  assert.match(hook, /o\.style\.overflow = "";/, "the clip is never handed back");

  // And the phase must ALWAYS settle. A transitionend listener would not fire when the box was
  // already at its target height — switching between two non-Jobs tabs, where both are 0 — and a
  // phase that never settles leaves `display: block` and `overflow: hidden` on permanently, which is
  // the trapping state above.
  assert.match(hook, /timer\.current = setTimeout\(\(\) => \{/);
  assert.match(hook, /setPhase\("rest"\);/);
  assert.ok(!/addEventListener\("transitionend"/.test(hook),
    "settling on transitionend leaves the clip on forever when the height did not change");
});

test("prefers-reduced-motion is respected, and re-read when it changes", () => {
  assert.match(hook, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  // Read, not assumed — and re-read, because a user can toggle it without reloading.
  assert.match(hook, /mq\.addEventListener\?\.\("change", on\)/);
  assert.match(hook, /mq\.removeEventListener\?\.\("change", on\)/);
  // With it set: no transition, and no clipping phase at all — mount and unmount immediately.
  assert.match(hook, /if \(reduced\) \{[\s\S]{0,200}setMounted\(open\);[\s\S]{0,80}setPhase\("rest"\);/);
  assert.match(hook, /mounted: reduced \? open : mounted,/);
});

test("BOTH directions measure inside a frame, because one of them did not and snapped", () => {
  // The first version read the CLOSING height synchronously, right after leaving `display: contents`.
  // Measured on the running app: the open transition animated correctly (wrapper 165 -> 293 -> 340
  // -> 352, `<main>` following it 211 -> 339 -> 386 -> 398) and the close did not — at +40ms the
  // wrapper's inline height was already "0px" and `<main>` had already jumped to 46. The synchronous
  // read landed before React had re-rendered with the phase's styles, saw 0, and animated 0 -> 0.
  //
  // After deferring it one frame, same measurement, close: 352 -> 187 -> 59 -> 7 -> 0, with
  // `<main>` at 398 -> 233 -> 105 -> 53 -> 46.
  //
  // So the symmetry is the fix, not tidiness: NEITHER direction may read a height synchronously.
  const effect = hook.slice(hook.indexOf("if (open) {"), hook.indexOf("// Settle on a timer"));
  const reads = [...effect.matchAll(/offsetHeight/g)].length;
  assert.equal(reads, 2, "expected exactly one height read per direction");
  for (const m of effect.matchAll(/offsetHeight/g)) {
    const before = effect.slice(0, m.index);
    const lastRaf = before.lastIndexOf("requestAnimationFrame");
    const lastBrace = before.lastIndexOf("} else {");
    assert.ok(lastRaf > lastBrace,
      "a height is read outside requestAnimationFrame — that read lands before React re-renders");
  }
  // Opening mounts first, so there is a height to animate TO.
  assert.match(effect, /setMounted\(true\);[\s\S]{0,120}enterBoxPhase\(\);/);
  // Closing pins the current height, then goes to 0 on the FOLLOWING frame — setting both in one
  // frame gives the browser no start value to interpolate from.
  assert.match(effect, /requestAnimationFrame\(\(\) => \{[\s\S]{0,300}requestAnimationFrame\(\(\) => \{[\s\S]{0,120}style\.height = "0px"/);
});

test("switching between two NON-Jobs tabs does not animate anything", () => {
  // Y4's requirement 4: "switching between non-Jobs tabs behaves as it does now". The hook's input
  // is `activeTab === "console"`, which is false on both sides of such a switch — and the effect
  // returns early when the value has not changed, so no phase change and no transition.
  assert.match(app, /useCollapsibleHeight\(activeTab === "console"\)/);
  assert.match(hook, /if \(prevOpen\.current === open\) return undefined;/,
    "the effect no longer short-circuits when `open` did not change");
});

test("the wrapper creates no containing block for a fixed overlay", () => {
  // Y2's audit requirement, applied to a wrapper Y4 introduces: transform, filter, backdrop-filter,
  // contain and container-type all trap a fixed-position descendant. `will-change: height` does not
  // (only transform/perspective/filter do), and it is dropped at rest anyway.
  // Stripped: the style block's own comment explains WHY it must not set transform, and matching a
  // comment is how a source-string test fails on the explanation instead of the code.
  const style = hook
    .slice(hook.indexOf("outerStyle: animating"), hook.indexOf("function prefersReduced"))
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(style.length > 40, "the style block could not be isolated");
  for (const trap of ["transform", "filter", "backdropFilter", "contain:", "containerType"]) {
    assert.ok(!style.includes(trap),
      `the collapsible wrapper sets ${trap}, which traps any fixed overlay inside it`);
  }
  // willChange is set only in the animating branch and is `height`, which does not create a
  // containing block (only transform/perspective/filter do). At rest the style is `boxless`,
  // which is display: contents and nothing else.
  assert.match(style, /willChange: "height"/);
  assert.match(style, /: boxless,/);
});
