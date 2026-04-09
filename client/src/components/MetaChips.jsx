// MetaChips.jsx — adapted from EventMeta.tsx
// Two connected chips: left filled, right bordered
import { useTheme } from "../styles/theme.jsx";

export function MetaChips({
  left, right,
  leftBg, leftColor,
  rightBg, rightColor,
}) {
  const { theme } = useTheme();

  const lBg    = leftBg    || theme.colorText;
  const lColor = leftColor || "#000";
  const rBg    = rightBg   || "transparent";
  const rColor = rightColor || theme.colorText;

  return (
    <div style={{ display:"inline-flex", alignItems:"stretch", borderRadius:6, overflow:"hidden" }}>
      {left && (
        <div style={{
          background:lBg, color:lColor,
          padding:"4px 10px", fontSize:11, fontWeight:700,
          display:"flex", alignItems:"center",
        }}>
          {left}
        </div>
      )}
      {right && (
        <div style={{
          background:rBg, color:rColor,
          border:`1px solid ${theme.colorBorder}`,
          borderLeft: left ? "none" : undefined,
          padding:"4px 10px", fontSize:11, fontWeight:500,
          display:"flex", alignItems:"center",
        }}>
          {right}
        </div>
      )}
    </div>
  );
}
