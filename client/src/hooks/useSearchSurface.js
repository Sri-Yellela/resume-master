import { useEffect, useRef, useState } from "react";

// ── Which search surface is showing: exactly one, always ──────────────────────────────────────
//
// Returns "bar" or "pill". That single value is the ONLY input to the decision, so the two surfaces
// are mutually exclusive by construction rather than by two components agreeing to disagree.
//
// What went wrong before: visibility was decided in two places from two different scroll sources.
// AppDashboard ran `setUiMode(window.scrollY > 80 ? "dock" : "hero")`, while TopBar's collapsed pill
// keyed off `useAppScroll().progress >= 0.5`, which is fed by the job board's INNER scroll container
// via PullToRefresh. Two independent booleans, so "both showing" was reachable — and it was the
// normal state, because on the dashboard `document.documentElement.scrollHeight === innerHeight`:
// the window does not scroll at all, so the first condition could never fire and the main bar could
// never yield. Measured, not inferred.
//
// WHY IntersectionObserver AND NOT A SCROLL THRESHOLD. A threshold has to be told which thing
// scrolls, and on this layout the window does not; the board scrolls inside a nested flex container,
// and which ancestor scrolls changes with the panel arrangement. IntersectionObserver asks the
// question that actually matters — "is the main bar's place in the layout still on screen" —
// and answers it correctly whichever ancestor moves, including none.
//
// WHY A SENTINEL AND NOT THE BAR ITSELF. Observing the bar would be self-referential: the moment the
// surface flips to "pill" the bar unmounts, the observer loses its target, no further callback can
// fire, and the pill is stuck forever. The sentinel is a zero-height element that stays mounted in
// the bar's place regardless of which surface is rendered, so the condition remains observable in
// both states. This is the bug that makes the naive version look like it works until you scroll back.
//
// HYSTERESIS. Two different thresholds, not one: the surface flips to "pill" only once the sentinel
// is essentially gone (<= HIDE_RATIO visible) and back to "bar" only once it is clearly back
// (>= SHOW_RATIO). A single threshold would sit exactly on the boundary while the user rests
// mid-scroll and chatter between the two surfaces every few pixels.
const HIDE_RATIO = 0.01;
const SHOW_RATIO = 0.5;

export function useSearchSurface() {
  const sentinelRef = useRef(null);
  // Seeded to "bar", which is also the correct FIRST PAINT answer: at rest the bar's slot is on
  // screen. IntersectionObserver additionally delivers an initial callback for the current state as
  // soon as it observes, so even a page restored mid-scroll corrects within a frame rather than
  // showing the wrong surface until the first scroll event.
  const [surface, setSurface] = useState("bar");

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return; // stays "bar": never zero surfaces

    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        const ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
        // Deliberately expressed as two guarded transitions rather than `ratio > x ? a : b`, so the
        // band between HIDE_RATIO and SHOW_RATIO leaves the current surface untouched. That gap IS
        // the hysteresis; collapsing this to a single comparison reintroduces boundary flicker.
        setSurface((prev) => {
          if (prev === "bar"  && ratio <= HIDE_RATIO) return "pill";
          if (prev === "pill" && ratio >= SHOW_RATIO) return "bar";
          return prev;
        });
      },
      { threshold: [0, HIDE_RATIO, SHOW_RATIO, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return { surface, sentinelRef };
}
