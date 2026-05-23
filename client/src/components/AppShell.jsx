import CinematicBackground from "./CinematicBackground.jsx";

/**
 * Root layout wrapper — mounts CinematicBackground once so the video
 * persists across client-side navigation without restarting.
 * Uses {children} (not <Outlet/>) because App.jsx uses BrowserRouter + Routes.
 */
export default function AppShell({ children }) {
  return (
    <>
      <CinematicBackground />
      <div className="relative z-10 min-h-screen">
        {children}
      </div>
    </>
  );
}
