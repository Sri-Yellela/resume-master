import { useEffect, useRef, useState } from "react";

// ── useCollapsibleHeight — animate a block of chrome in and out by its own measured height ─────
//
// Y4 moves the tab row into the top bar and drops the search bar from every tab but Jobs. That makes
// the in-flow chrome's height DIFFERENT PER TAB — measured at 1440x900, the Jobs chrome is 539px
// (a 386px hero plus a 153px search bar) and every other tab's is 0 — so switching to or from Jobs
// moves everything below it by 539px. Unanimated, that is a jump; Y4 asks for the height change to
// be animated so the content below moves smoothly.
//
// WHY THIS IS A HOOK AND NOT A CSS TRANSITION ON `height: auto`. `auto` is not an animatable value.
// The standard resolution is to transition between two explicit pixel values and hand back once
// settled, which needs a measurement and a settle event — i.e. state.
//
// ── THE TRAP, WHICH THIS HIT FOR REAL BEFORE `display: contents` ──────────────────────────────
//
// The chrome being wrapped CONTAINS a `position: sticky` element: the search bar, pinned under the
// top bar so its controls stay reachable while the board scrolls. A sticky box is constrained to its
// PARENT's box. Put a wrapper around it and the wrapper becomes that constraint.
//
// Measured on the running board, with a plain wrapper and no clipping at all:
//
//     scrollY      search bar top
//        0            245        <- at rest, correct
//      100            145
//      300            -55        <- gone: it should have pinned at 46
//     2200          -1955
//
// So the bar scrolled away instead of pinning, and every control on it — the All/Saved/Pending
// tabs, the filter and sort icons, IMPORT — became unreachable for 2000px of a 2340px board. That is
// a feature loss, not a cosmetic one, and it is caused by the wrapper EXISTING, not by its overflow.
//
// THE FIX: the wrapper generates NO BOX at rest. `display: contents` makes its children lay out as
// though they were the grandparent's, so the sticky bar's containing block is the app shell again
// and the tree is, to layout, exactly what it was before the wrapper was introduced. The wrapper
// becomes a real box — `display: block`, an explicit height, and `overflow: hidden` — only for the
// ~320ms it is animating, when there is something to clip and a height to interpolate.
//
// `overflow: hidden` on an ancestor has the same trapping problem for sticky, which is the second
// reason it is confined to the animating phase; during those 320ms the user has just switched tabs
// and pinning is not what they are looking at.
//
// prefers-reduced-motion: no transition, no clipping phase, and mount/unmount immediately. The media
// query is READ rather than assumed, and re-read on change, because a user can toggle it without
// reloading.
const DURATION_MS = 320;
const EASING = "cubic-bezier(0.25, 0.46, 0.45, 0.94)";   // the easing .usb already uses

/**
 * @param {boolean} open  whether the chrome should be shown
 * @returns {{ outerRef, innerRef, outerStyle, innerStyle, mounted }}
 *   `mounted` is true while the children must exist in the DOM — `open`, PLUS the collapse
 *   animation's duration, because a box cannot animate down from the height of content that has
 *   already been unmounted.
 */
export function useCollapsibleHeight(open) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const [reduced, setReduced] = useState(() => prefersReduced());
  // "rest"      = display: contents. No box, no clipping, no transition — layout as if unwrapped.
  // "animating" = display: block with an explicit height, a transition, and clipping.
  const [phase, setPhase] = useState("rest");
  const [mounted, setMounted] = useState(open);
  const timer = useRef(0);
  const prevOpen = useRef(open);

  useEffect(() => {
    const mq = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    if (!mq) return undefined;
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  useEffect(() => {
    if (prevOpen.current === open) return undefined;
    prevOpen.current = open;
    clearTimeout(timer.current);

    if (reduced) {
      // No animation: mount/unmount immediately and never enter the clipping phase.
      setMounted(open);
      setPhase("rest");
      return undefined;
    }

    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) { setMounted(open); return undefined; }

    // Take both boxes out of `display: contents` IMPERATIVELY, before measuring. React has not
    // re-rendered yet, so at this instant they are still boxless — and offsetHeight of a
    // `display: contents` element is 0, which would make a collapse animate from 0 to 0.
    const enterBoxPhase = () => {
      outer.style.display = "block";
      outer.style.overflow = "hidden";
      inner.style.display = "block";
    };

    // BOTH DIRECTIONS MEASURE INSIDE A FRAME, and that symmetry is load-bearing rather than tidiness.
    //
    // The first version measured the closing height SYNCHRONOUSLY, right after enterBoxPhase().
    // Measured on the running app, the open transition animated correctly (wrapper height 165 -> 293
    // -> 340 -> 352, `<main>` following it 211 -> 339 -> 386 -> 398) and the close did not: at +40ms
    // the wrapper's inline height was already "0px" and `<main>` had already jumped to 46. The
    // synchronous read landed before React had re-rendered with this phase's styles, so it saw 0 and
    // the box animated 0 -> 0, i.e. snapped. Deferring the read one frame — exactly where the open
    // path already read it — makes both paths read a laid-out box.
    if (open) {
      // OPENING. Mount first so there is a height to animate TO.
      setMounted(true);
      setPhase("animating");
      enterBoxPhase();
      outer.style.height = "0px";
      requestAnimationFrame(() => {
        if (!outerRef.current || !innerRef.current) return;
        outerRef.current.style.height = `${innerRef.current.offsetHeight}px`;
      });
    } else {
      // CLOSING. Pin the CURRENT height first: going straight to 0 from an unset height does not
      // animate, because there is no start value to interpolate from — it just snaps, which is the
      // jump this hook exists to remove.
      setPhase("animating");
      enterBoxPhase();
      requestAnimationFrame(() => {
        if (!outerRef.current || !innerRef.current) return;
        outerRef.current.style.height = `${innerRef.current.offsetHeight}px`;
        requestAnimationFrame(() => {
          if (outerRef.current) outerRef.current.style.height = "0px";
        });
      });
    }

    // Settle on a timer rather than transitionend. transitionend does not fire when the box was
    // already at the target height — switching between two non-Jobs tabs, where both are 0 — and a
    // phase that never settles would leave `display: block` and `overflow: hidden` on permanently,
    // which is exactly the sticky-trapping state the whole design avoids.
    timer.current = setTimeout(() => {
      setPhase("rest");
      const o = outerRef.current, i = innerRef.current;
      // Hand layout back. Clearing the inline properties is what returns the tree to "as if there
      // were no wrapper"; leaving any of them set is the trap.
      if (o) { o.style.height = ""; o.style.display = ""; o.style.overflow = ""; }
      if (i) { i.style.display = ""; }
      if (!open) setMounted(false);
    }, DURATION_MS + 30);

    return () => clearTimeout(timer.current);
  }, [open, reduced]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const animating = phase === "animating";
  const boxless = { display: "contents" };
  return {
    outerRef,
    innerRef,
    mounted: reduced ? open : mounted,
    // At rest and OPEN: no box at all, so the sticky search bar inside is constrained by the app
    // shell exactly as it was before this wrapper existed.
    // At rest and CLOSED: the children are unmounted, so there is nothing to lay out either way;
    //   `display: contents` on an empty element occupies nothing.
    // While ANIMATING: the imperative styles above own display/height/overflow. Only the transition
    //   is declared here, because a transition set imperatively would race the height it animates.
    outerStyle: animating
      ? { transition: `height ${DURATION_MS}ms ${EASING}`, willChange: "height" }
      : boxless,
    innerStyle: animating ? undefined : boxless,
  };
}

function prefersReduced() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export { DURATION_MS as CHROME_TRANSITION_MS };
export default useCollapsibleHeight;
