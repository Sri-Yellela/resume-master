// client/src/components/AdminLayout.jsx
import { useTheme } from "../styles/theme.jsx";
import { AdminPanel } from "../panels/AdminPanel.jsx";

export default function AdminLayout({ user, onLogout, children }) {
  const { theme } = useTheme();

  return (
    <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13,
                  background:theme.bg, minHeight:"100vh", color:theme.text }}>
      {/* Header */}
      <div style={{
        height:56, background:theme.surface,
        borderBottom:`3px solid ${theme.accent}`,
        display:"flex", alignItems:"center",
        padding:"0 24px", gap:16, flexShrink:0,
        position:"sticky", top:0, zIndex:100,
      }}>
        <span style={{ fontFamily:"'Barlow Condensed','DM Sans',sans-serif",
                       fontWeight:800, fontSize:17, letterSpacing:"0.06em",
                       textTransform:"uppercase", color:theme.text, fontStyle:"italic" }}>
          Resume Master
        </span>
        <span style={{ fontSize:11, color:theme.textMuted,
                       borderLeft:`1px solid ${theme.border}`, paddingLeft:16,
                       fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em" }}>
          Admin Panel
        </span>
        <div style={{ flex:1 }}/>
        <span style={{ fontSize:12, color:theme.textMuted }}>
          Logged in as{" "}
          <strong style={{ color:theme.text }}>{user?.username}</strong>
        </span>
        <button
          onClick={onLogout}
          style={{
            background:"transparent", border:`1px solid ${theme.border}`,
            borderRadius:999, padding:"5px 16px", cursor:"pointer",
            fontSize:12, color:theme.textMuted, fontWeight:600,
            fontFamily:"'DM Sans',system-ui", transition:"all 0.15s",
          }}
          onMouseEnter={e => {
            e.currentTarget.style.color = "#dc2626";
            e.currentTarget.style.borderColor = "#dc2626";
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = theme.textMuted;
            e.currentTarget.style.borderColor = theme.border;
          }}
        >
          Sign Out
        </button>
      </div>

      {/* Admin content */}
      {children ?? <AdminPanel/>}
    </div>
  );
}
