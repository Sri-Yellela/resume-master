// client/src/contexts/AppScrollContext.jsx
// Provides scroll progress (0–1) and pagination-pin state to AppDockBar.
// JobsPanel's PullToRefresh updates `progress` on scroll.
// JobsPanel's goPage calls `pin()` so the dock collapses on pagination even
// when the container's scrollTop is still 0.
// Scrolling back to the top of the job list auto-unpins.
import { createContext, useContext, useState, useCallback, useRef } from "react";

const AppScrollContext = createContext({
  progress:      0,
  update:        () => {},
  pinned:        false,
  pin:           () => {},
  unpin:         () => {},
  scrollToTopRef: { current: null },
});

export function AppScrollProvider({ children }) {
  const [progress, setProgress] = useState(0);
  const [pinned,   setPinned]   = useState(false);
  // PullToRefresh registers a scrollToTop fn here so goPage can use it
  const scrollToTopRef = useRef(null);

  const update = useCallback((p) => {
    const clamped = Math.min(Math.max(p, 0), 1);
    setProgress(clamped);
    // Scrolled back near top → clear the pagination pin
    if (clamped < 0.05) setPinned(false);
  }, []);

  const pin   = useCallback(() => setPinned(true),  []);
  const unpin = useCallback(() => setPinned(false), []);

  return (
    <AppScrollContext.Provider value={{ progress, update, pinned, pin, unpin, scrollToTopRef }}>
      {children}
    </AppScrollContext.Provider>
  );
}

export function useAppScroll() {
  return useContext(AppScrollContext);
}
