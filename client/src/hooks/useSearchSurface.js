import { useEffect, useRef, useState } from "react";

// ── Which search surface is showing: exactly one, always, and stable at the crossing ───────────
//
// Returns "bar" or "pill". That single value is the ONLY input to the decision, so the two surfaces
// are mutually exclusive by construction rather than by two components agreeing to disagree.
//
// What went wrong originally: visibility was decided in two places from two different scroll
// sources, so "both showing" was reachable and was in fact the normal state. That is fixed and
// stays fixed — one value, one owner.
//
// WHAT WAS STILL WRONG, AND HOW IT WAS MEASURED. The crossing itself flickered, with a frame
// showing neither surface. Three causes, all confirmed by instrumenting the running app rather
// than reasoned about:
//
//   1. THE OBSERVER MOVED ITS OWN TARGET. The sentinel sat below the hero, and the hero was
//      rendered only while the surface was "bar". Flipping to "pill" therefore unmounted the hero
//      AND the bar — 386px of layout, measured as document.scrollHeight going 1763 -> 1377 — all of
//      it ABOVE the viewport. Chrome's scroll anchoring compensates for content removed above the
//      fold by subtracting it from the scroll offset, so scrollY fell from 250 to 0, which put the
//      sentinel back on screen, which flipped the surface back to "bar", which restored the 386px.
//      A closed loop: the observer's condition was a function of the state the observer set.
//   2. THE HYSTERESIS WAS INERT. Two ratio thresholds were written (0.01 and 0.5) but the sentinel
//      is a ZERO-HEIGHT element, and IntersectionObserver reports a zero-area target as ratio 1
//      when intersecting and 0 when not — never anything between. Instrumenting the real observer
//      across a full scroll returned exactly two distinct ratios: [1, 0]. So both comparisons
//      tested the same instant, and there was one threshold, not two.
//   3. A DEAD FRAME AT THE SWAP. The bar unmounts synchronously; the pill mounted with a
//      `slideDown` keyframe running opacity 0 -> 1 over 200ms. Captured at the crossing:
//      `bar: null, pill: { opacity: 0 }` — neither surface visible. That is the reported gap.
//
// THE FIX HAS THREE PARTS, ONE PER CAUSE.
//
//   1. The bar and the hero are no longer unmounted; they are hidden with `visibility` and keep
//      their space (see App.jsx). The document height stops changing at the threshold, so scroll
//      anchoring never fires and the loop has nothing to feed on. This costs nothing visually: at
//      the moment of the flip those elements are, by definition, scrolled out of view — that is
//      why we are flipping.
//   2. The condition is read as a DISTANCE IN PIXELS from the sentinel's own rect, not as an
//      intersection ratio, so two thresholds can actually be two thresholds. Reading the rect keeps
//      the property that made an observer the right instrument here — it asks "where is the bar's
//      place in the layout now", and answers correctly whichever ancestor moved, or none.
//   3. The swap is INSTANT. Either surface is fully opaque or fully absent; nothing crossfades, so
//      there is no window in which the incoming one has not arrived. The pill still slides in, but
//      on `transform` only, at full opacity from its first frame.
//
// THE THRESHOLDS. The bar is `position: sticky; top: 56px`, so the bar itself never leaves — its
// SLOT does, and the sentinel is that slot. Its top edge sits at 245 and decreases as the page
// scrolls, reaching the top chrome at 56.
const HIDE_ABOVE = 40;    // slot has passed under the top chrome -> hand over to the pill
const SHOW_BELOW = 120;   // slot is clearly back in view       -> hand back to the bar
// 80px of dead band. Anything the user does inside it — resting mid-scroll, trackpad momentum
// overshoot, a jittery wheel — leaves the current surface exactly where it is. A single value
// cannot do that at any threshold, however well chosen.

export function useSearchSurface() {
  const sentinelRef = useRef(null);
  // Seeded to "bar", which is also the correct FIRST PAINT answer: at rest the bar's slot is on
  // screen. The first measurement runs immediately on mount, so a page restored mid-scroll corrects
  // within a frame rather than showing the wrong surface until the user scrolls.
  const [surface, setSurface] = useState("bar");

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return undefined;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const node = sentinelRef.current;
      if (!node) return;
      const top = node.getBoundingClientRect().top;
      // Two guarded transitions, never `top < x ? a : b`. The band between the thresholds leaves
      // the current surface untouched — that gap IS the hysteresis, and collapsing this to one
      // comparison puts the boundary chatter straight back.
      setSurface((prev) => {
        if (prev === "bar"  && top <= HIDE_ABOVE) return "pill";
        if (prev === "pill" && top >= SHOW_BELOW) return "bar";
        return prev;
      });
    };
    // rAF-coalesced: a scroll fires far more often than the screen refreshes, and reading a rect
    // per event would both thrash layout and set state dozens of times between paints.
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };

    measure();
    // Capture phase, so a scroll inside a nested container is seen too — the sentinel's rect moves
    // whichever ancestor did the scrolling, and this is what keeps the reading source-agnostic.
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return { surface, sentinelRef };
}

export { HIDE_ABOVE, SHOW_BELOW };
