import { useState, useEffect } from 'react';

// Returns true when window width >= breakpoint (default 768px).
// Drives the RM ↔ RESUME MASTER stamp logo transition.
export function useLogoSize(breakpoint = 768) {
  const [isWide, setIsWide] = useState(
    typeof window !== 'undefined' && window.innerWidth >= breakpoint
  );
  useEffect(() => {
    const handler = () => setIsWide(window.innerWidth >= breakpoint);
    window.addEventListener('resize', handler, { passive: true });
    return () => window.removeEventListener('resize', handler);
  }, [breakpoint]);
  return isWide;
}
