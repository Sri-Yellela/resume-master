import { useEffect } from "react";
import { Z } from "../styles/zLayers.js";

// ── useBoardLock — the board is INERT and FROZEN while any panel is open ───────────────────────
//
// A scrim that only dims is a picture of a modal, not a modal. Three things were still reachable
// behind it, and each is a separate mechanism:
//
//   1. FOCUS. `pointer-events: none` stops the mouse and nothing else — Tab walked straight into
//      the board's twenty-odd controls behind the scrim, and the focus ring landed on a dimmed
//      element the user could not see. `inert` is the only thing that removes a subtree from the
//      tab order, the accessibility tree and hit-testing at once.
//   2. SCROLL. The page scrolled behind the scrim: opening a panel and spinning the wheel moved
//      the board under it. Note this is NOT scroll chaining out of a panel — the panel bodies
//      already set `overscroll-behavior: contain` and were verified not to chain. It is the page's
//      own scroll, which nothing was stopping.
//   3. SCROLL POSITION. The obvious lock, `overflow: hidden` on body, is the one that loses it:
//      the document stops being scrollable, the browser clamps scrollTop to 0, and closing the
//      panel drops the user at the top of a board they had scrolled halfway down. So the scroll
//      offset is captured first and re-applied on release.
//
// WHY position:fixed AND NOT overflow:hidden. Pinning the body at `top: -scrollY` keeps the page
// looking exactly as it did — the content does not jump — and the offset is a number we hold, so
// restoring it is exact rather than best-effort. The cost is that the document stops overflowing
// and the scrollbar disappears, which shifts every left edge in the app sideways by the scrollbar's
// width at the instant a panel opens. That gutter is measured BEFORE locking and paid back as
// padding, so the board does not move.
//
// WHAT STAYS ALIVE. Every child of [data-app-shell] is inerted EXCEPT those painting at or above
// Z.NAV. The nav renders above the scrim and is therefore undimmed and visibly clickable; inerting
// it would leave a control that looks live and is not. This is the same relationship the z-scale
// already declares (NAV > MODAL > MODAL_SCRIM), read at runtime instead of restated as a list of
// component names.
export function useBoardLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    if (typeof document === "undefined") return undefined;

    const body = document.body;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    // Measured while the document still overflows — after the lock there is no scrollbar left to
    // measure, and reading it then would always give 0 and never compensate.
    const gutter = Math.max(0, window.innerWidth - document.documentElement.clientWidth);

    const prior = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      paddingRight: body.style.paddingRight,
      overscrollBehavior: body.style.overscrollBehavior,
    };

    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overscrollBehavior = "none";
    if (gutter > 0) {
      const priorPad = parseFloat(getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${priorPad + gutter}px`;
    }

    // ── inert everything under the scrim ──────────────────────────────────────────────────────
    const shell = document.querySelector("[data-app-shell]");
    const inerted = [];
    if (shell) {
      for (const child of Array.from(shell.children)) {
        const z = parseInt(getComputedStyle(child).zIndex, 10);
        if (Number.isFinite(z) && z >= Z.NAV) continue;   // paints above the scrim — stays live
        if (child.hasAttribute("inert")) continue;        // someone else owns it; don't fight them
        child.setAttribute("inert", "");
        inerted.push(child);
      }
    }

    return () => {
      body.style.position = prior.position;
      body.style.top = prior.top;
      body.style.left = prior.left;
      body.style.right = prior.right;
      body.style.width = prior.width;
      body.style.paddingRight = prior.paddingRight;
      body.style.overscrollBehavior = prior.overscrollBehavior;
      // Restore BEFORE the browser has a chance to paint a scrolled-to-top board.
      window.scrollTo(0, scrollY);
      for (const el of inerted) el.removeAttribute("inert");
    };
  }, [active]);
}

export default useBoardLock;
