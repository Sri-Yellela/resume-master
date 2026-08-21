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
// WHAT STAYS ALIVE. Every child of [data-app-shell] is inerted EXCEPT those painting AT OR ABOVE
// THE SCRIM. The rule is unchanged in intent — "anything the scrim does not cover stays live, and
// anything it covers goes inert, so nothing ever looks live while being inert" — but the threshold
// it is expressed against had to move.
//
// It used to read `z >= Z.NAV`, which was the same line as "at or above the scrim" only because
// NAV was 1500 and the scrim was 800. Y2 lowered NAV to 250: the top bar now sits BELOW every
// overlay so it can never occlude one. Left as `>= Z.NAV`, this loop would have started sparing
// every child at 250 or more — including the search surface at Z.SEARCH (400), which is exactly the
// defect 7f687bd fixed: a live, tab-reachable search surface underneath an open modal.
//
// So the threshold is now the scrim itself, which is what it always meant. Reading Z.MODAL_SCRIM
// instead of Z.NAV also makes it immune to the next renumbering of the chrome, because the question
// is about the scrim and never was about the nav.
//
// The consequence, stated rather than discovered: the top bar is now inerted with the board while a
// panel is open, and dimmed by the scrim that covers it. That is the coherent pairing. The panel's
// own close control and a click on the scrim both still dismiss it.
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
        if (Number.isFinite(z) && z >= Z.MODAL_SCRIM) continue;  // at or above the scrim — stays live
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
