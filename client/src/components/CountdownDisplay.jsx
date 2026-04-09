// CountdownDisplay.jsx — adapted from EventCountdown.tsx (no supabase, no RotatingBadge)
// Props: slots (array of {value, unit})
export function CountdownDisplay({ slots = [] }) {
  return (
    <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
      {slots.map((s, i) => (
        <div key={i} style={{
          display:"flex", flexDirection:"column", alignItems:"center",
          background:"rgba(0,0,0,0.3)", border:"1px solid rgba(255,255,255,0.1)",
          borderRadius:8, padding:"8px 12px", minWidth:52,
        }}>
          <span style={{ fontSize:24, fontWeight:800, lineHeight:1 }}>{s.value}</span>
          <span style={{ fontSize:9, color:"rgba(255,255,255,0.5)", textTransform:"uppercase",
                         letterSpacing:"0.08em", marginTop:2 }}>{s.unit}</span>
        </div>
      ))}
    </div>
  );
}
