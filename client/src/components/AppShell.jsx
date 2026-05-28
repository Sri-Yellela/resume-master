import { useTheme } from "../styles/theme.jsx";

export default function AppShell({ children }) {
  const { themeId, availableThemes } = useTheme();
  const activeTheme = availableThemes.find(t => t.id === themeId);
  const Wrapper = activeTheme?.Wrapper;
  return (
    <>
      {Wrapper && <Wrapper />}
      <div className="relative z-10 min-h-screen">{children}</div>
    </>
  );
}
