import { useState, useEffect } from "react";

export function useViewport() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const update = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const ar = size.w / size.h;
  // layout mode based on width + aspect ratio
  const mode =
    size.w < 640              ? "mobile"   // phone portrait
    : size.w < 900            ? "tablet"   // tablet / phone landscape
    : ar < 1.2                ? "portrait" // tall monitor / iPad landscape
    : size.w < 1280           ? "laptop"   // 13" laptops
    :                           "wide";    // large monitors
  return { ...size, ar, mode };
}
