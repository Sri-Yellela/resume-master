import { useEffect, useState } from "react";

// ── useChromeHeight — how much vertical space the FIXED app chrome occupies, measured ──────────
//
// THE DEFECT THIS EXISTS FOR. The top bar is `position: fixed`, so it reserves no space in the
// document. Nothing below it reserved space for it either; two unrelated things happened to absorb
// it, and one of them did the sum wrong.
//
// Measured at 1440x900 before this, per tab:
//
//   tab            top bar   search bar paints   search bar reserves   <main>   first content   overlap
//   Jobs           0->46     245->398            245->398              398      422             0
//   Auto Apply     0->46      56->209              0->153              153      177            32
//   Job Profiles   0->46      56->209              0->153              153      177            32
//   Database       0->46      56->209              0->153              153      177            32
//   Recruiter      0->46      56->209              0->153              153      177            32
//
// SO THE FOUR NON-JOBS TABS SHARE ONE CAUSE, AND IT IS NEITHER OF THE TWO THE REPORT SUGGESTED.
// It is not missing offset — `<main>` correctly starts at 153, immediately after the 153px the
// search bar reserves. And it is not a wrong container bound. It is that the search bar is
// `position: sticky; top: 56px` whose STATIC position on those tabs is 0: the hero is rendered only
// on Jobs, so the bar is the first in-flow child. A sticky element whose static position is already
// above its threshold paints DISPLACED from the space it reserves — here by the full 56px — so it
// reserves 0->153 and paints 56->209, and those last 56px land on content that reserved space
// correctly for the unshifted box. The visible overlap is 32px because `<main>` adds 24px of its own
// padding before the first content box.
//
// Jobs escapes it for an accidental reason: the hero is 386px tall, so the bar's static position
// there is 245, far below the 56px threshold, sticky is not engaged at rest, and displacement is 0.
// A layout that is correct on one tab because a decorative element happens to be tall enough is not
// correct.
//
// THE 56 WAS ALSO JUST WRONG. Its comment says "sit directly below 56px NavBar" and "pins under the
// 56px TopBar" — but the app's top bar is 46px tall. 56 is the MARKETING NavBar's height, copied
// onto app chrome of a different size, which is the same class of error as a hardcoded
// cross-reference to another component's z-index.
//
// THE FIX, per Y3's requirement that the offset be measured rather than hardcoded: read the real
// height off the real element and publish it as a custom property, so
//
//   - the in-flow column reserves exactly the chrome's height, which puts the sticky bar's static
//     position AT its threshold and reduces the displacement to zero, and
//   - the sticky `top` and the reserve are the SAME number by construction, so they cannot disagree
//     the way 56 and 46 did.
//
// It is measured rather than read from a constant because Y4 makes the chrome's height vary by tab
// (the search bar renders only on Jobs), and because a bar whose height depends on font loading,
// zoom, or a badge appearing cannot be a constant. ResizeObserver sees all of those; a number does
// not.
export const CHROME_HEIGHT_VAR = "--app-chrome-height";

/**
 * Observes `[data-app-chrome]` — the fixed top bar — and returns its height in px.
 *
 * Publishes the same value as CHROME_HEIGHT_VAR on the document element, because two consumers need
 * it from different places: the shell's in-flow padding (JS) and UnifiedSearchBar.css's sticky `top`
 * (CSS). Publishing from one measurement is what keeps them equal; a JS number plus a CSS literal is
 * exactly the pair that was 46 and 56.
 */
export function useChromeHeight() {
  // Seeded from the DOM when possible so the FIRST paint reserves the right space. A 0 seed would
  // put every tab's content under the bar for one frame and then jump it down, which reads as a
  // layout shift on every tab switch.
  const [height, setHeight] = useState(() => measure());

  useEffect(() => {
    if (typeof document === "undefined") return undefined;

    const apply = () => {
      const h = measure();
      setHeight((prev) => (prev === h ? prev : h));
      document.documentElement.style.setProperty(CHROME_HEIGHT_VAR, `${h}px`);
    };
    apply();

    const el = document.querySelector("[data-app-chrome]");
    // Observe the ELEMENT for its own size, and the document element for the case that matters after
    // Y4: switching tabs swaps which chrome is mounted without resizing anything that already exists.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    if (el && ro) ro.observe(el);
    if (ro) ro.observe(document.documentElement);
    window.addEventListener("resize", apply, { passive: true });
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", apply);
    };
    // Empty deps deliberately: the observers are the subscription and they outlive any render. With
    // no dep array this effect would re-subscribe on every render, and since it also SETS state
    // that is a resubscribe loop rather than a measurement.
  }, []);

  return height;
}

/**
 * The chrome's height right now, or a 0 fallback.
 *
 * 0 rather than a guessed 46: a wrong non-zero guess produces a layout that looks deliberate and is
 * off by the difference, which is the failure mode this whole hook replaces. 0 is visibly wrong for
 * the one frame before the measurement lands, and the seed above means that frame normally does not
 * happen at all.
 */
function measure() {
  if (typeof document === "undefined") return 0;
  const el = document.querySelector("[data-app-chrome]");
  if (!el) return 0;
  return Math.round(el.getBoundingClientRect().height);
}

export default useChromeHeight;
