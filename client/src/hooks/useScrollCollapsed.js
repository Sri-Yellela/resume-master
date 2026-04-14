import { useState, useEffect } from "react";

/**
 * Returns true when window.scrollY >= threshold.
 * Pass disabled=true to skip the listener (e.g. app variant that never scrolls).
 */
export function useScrollCollapsed(threshold = 60, disabled = false) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (disabled) return;
    const onScroll = () => setCollapsed(window.scrollY >= threshold);
    // Check immediately in case page loads scrolled
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold, disabled]);

  return disabled ? false : collapsed;
}
