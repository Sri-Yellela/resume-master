// client/src/contexts/AppScrollContext.jsx
//
// WHAT IS LEFT, AND WHAT WAS REMOVED.
//
// This provided `progress` (0-1 scroll fraction), `update()`, and a `pinned`/`pin()`/`unpin()`
// trio, all of which are gone. `progress` was PERMANENTLY 0 and had been for its whole existence:
// its only writer was JobsPanel's PullToRefresh `onScroll`, on that component's own inner container
// — and nothing ever scrolls that container. Measured on the running app: zero elements have
// `overflowY: auto|scroll` with content taller than their client box, the WINDOW is what scrolls,
// and forcing every candidate container's scrollTop to 900 changed nothing. So `update()` never
// fired.
//
// Six things were keyed to it and had therefore never run once: the top bar's width/radius/offset
// collapse, its glass gradient, its accent border, its drop shadow, both of its dividers, the
// logo's "esume Master" collapse, and JobsPanel's `scrollProgress < 0.5` toolbar guard (always
// true, so the toolbar was always shown). Each is removed at its own site rather than left reading
// a constant.
//
// `pinned` went with it, not because it was broken but because it became WRITE-ONLY the moment
// `progress` left: its only reader was TopBar's `p = pinned ? 1 : rawProgress`, so `pin()` would
// have been setting state nobody observes — the same defect as Y4's `hovered`.
//
// scrollToTopRef SURVIVES and is the whole remaining purpose: PullToRefresh registers a
// scroll-to-top function and JobsPanel's goPage calls it on pagination. Both live in JobsPanel.jsx
// but in different components, so they need somewhere to meet.
//
// REPORTED, NOT FIXED: that function sets `scrollRef.current.scrollTop = 0` on the same container
// that never scrolls, so it is a no-op today for the same reason `progress` was. It is left in
// place because it is correct code pointed at the right element — if the board's inner container
// ever becomes the scroller, it starts working — and because removing it is a different change from
// this one. Named here so it is not rediscovered as a surprise.
import { createContext, useContext, useRef } from "react";

const AppScrollContext = createContext({
  scrollToTopRef: { current: null },
});

export function AppScrollProvider({ children }) {
  const scrollToTopRef = useRef(null);
  return (
    <AppScrollContext.Provider value={{ scrollToTopRef }}>
      {children}
    </AppScrollContext.Provider>
  );
}

export function useAppScroll() {
  return useContext(AppScrollContext);
}
