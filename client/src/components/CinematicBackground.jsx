import { useEffect, useRef, useState } from "react";

/**
 * Fullscreen looping video that mounts once at AppShell and persists across
 * navigation. Falls back to a deep-navy radial gradient on reduced-motion,
 * Save-Data, or video error. Pauses when the tab is hidden.
 */
export default function CinematicBackground({
  src = "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260314_131748_f2ca2a28-fed7-44c8-b9a9-bd9acdd5ec31.mp4",
  poster,
  gradient = "radial-gradient(ellipse at 50% 30%, hsl(201 70% 22%) 0%, hsl(201 100% 13%) 45%, hsl(201 100% 8%) 100%)",
  className = "",
}) {
  const videoRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [skipVideo, setSkipVideo] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const saveData = navigator.connection?.saveData === true;
    if (reduce || saveData) setSkipVideo(true);
  }, []);

  useEffect(() => {
    if (skipVideo) return;
    const onVis = () => {
      const v = videoRef.current;
      if (!v) return;
      if (document.hidden) v.pause();
      else v.play().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [skipVideo]);

  return (
    <div
      aria-hidden="true"
      role="presentation"
      className={"pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-background " + className}
    >
      <div className="absolute inset-0" style={{ background: gradient }} />
      {!skipVideo && (
        <video
          ref={videoRef}
          className={"absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ease-out " + (ready ? "opacity-100" : "opacity-0")}
          src={src}
          poster={poster}
          autoPlay loop muted playsInline preload="metadata"
          onCanPlay={() => setReady(true)}
          onError={() => {
            if (!window.__rmHeroErrorLogged) {
              window.__rmHeroErrorLogged = true;
              console.warn("[CinematicBackground] video failed; using gradient fallback");
            }
            setSkipVideo(true);
          }}
        />
      )}
      <div
        className="absolute inset-0"
        style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 30%, rgba(0,0,0,0.35) 75%, rgba(0,0,0,0.55) 100%)" }}
      />
    </div>
  );
}
