// client/src/hooks/useInactivityLogout.js
// Logs the user out after IDLE_MS of inactivity OR when returning to a tab
// that has been invisible for more than IDLE_MS.
import { useEffect, useRef } from "react";

const IDLE_MS = 30 * 60 * 1000; // 30 minutes
const EVENTS  = ["mousemove", "keydown", "pointerdown", "scroll", "touchstart"];

export function useInactivityLogout(onLogout, enabled = true) {
  const timerRef    = useRef(null);
  const hiddenAtRef = useRef(null);

  useEffect(() => {
    if (!enabled) return;

    const reset = () => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(onLogout, IDLE_MS);
    };

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
      } else {
        // Tab became visible again — check how long it was hidden
        if (hiddenAtRef.current !== null) {
          const elapsed = Date.now() - hiddenAtRef.current;
          hiddenAtRef.current = null;
          if (elapsed >= IDLE_MS) { onLogout(); return; }
        }
        reset();
      }
    };

    EVENTS.forEach(e => window.addEventListener(e, reset, { passive: true }));
    document.addEventListener("visibilitychange", handleVisibility);
    reset(); // start timer immediately

    return () => {
      clearTimeout(timerRef.current);
      EVENTS.forEach(e => window.removeEventListener(e, reset));
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled, onLogout]);
}
