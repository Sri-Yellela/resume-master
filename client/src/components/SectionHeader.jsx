// SectionHeader.jsx — adapted from EventHeader.tsx
import { useTheme } from "../styles/theme.jsx";

export function SectionHeader({ title, subtitle, divider = false }) {
  const { theme } = useTheme();

  return (
    <div style={{ marginBottom: divider ? 0 : 16 }}>
      {title && (
        <h2 style={{
          fontSize:15, fontWeight:800, color:theme.colorPrimary,
          margin:0, letterSpacing:"-0.2px",
        }}>
          {title}
        </h2>
      )}
      {subtitle && (
        <p style={{
          fontSize:12, color:theme.colorMuted, margin:"4px 0 0",
          lineHeight:1.5,
        }}>
          {subtitle}
        </p>
      )}
      {divider && (
        <div style={{
          height:1, background:theme.colorBorder,
          margin:"12px 0 0",
        }}/>
      )}
    </div>
  );
}
