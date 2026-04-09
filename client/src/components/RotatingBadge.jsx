// RotatingBadge.jsx — adapted from RotatingBadge.tsx (SVG only, no img tag)
import { useTheme } from "../styles/theme.jsx";

export function RotatingBadge({ text = "NEW", size = 60, color }) {
  const { theme } = useTheme();
  const c = color || theme.colorPrimary;
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.35;
  const pathId = `rbp-${size}-${text.replace(/\s/g,"")}`;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display:"block", flexShrink:0 }}>
      <defs>
        <path id={pathId}
          d={`M ${cx},${cy} m -${r},0 a ${r},${r} 0 1,1 ${r*2},0 a ${r},${r} 0 1,1 -${r*2},0`}/>
      </defs>
      <g style={{ animation:"spin 20s linear infinite", transformOrigin:`${cx}px ${cy}px` }}>
        <text style={{ fontSize:size*0.12, fontWeight:700, fill:c, letterSpacing:"0.05em" }}>
          <textPath href={`#${pathId}`}>{`${text} · ${text} · ${text} · `}</textPath>
        </text>
      </g>
    </svg>
  );
}
