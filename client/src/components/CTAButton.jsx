// CTAButton.jsx — adapted from EventRegistration.tsx (no supabase/auth logic)
// Expand-on-hover + arrow-reveal CTA pattern
import { useState } from "react";

export function CTAButton({ label, onClick, disabled, loading, accent = "#ff6b35" }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="group"
      style={{ position:"relative", display:"inline-flex", alignItems:"center",
               cursor: disabled || loading ? "not-allowed" : "pointer" }}
      onMouseEnter={() => !disabled && !loading && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => !disabled && !loading && onClick?.()}
    >
      {/* Expanding background */}
      <div style={{
        position:"relative", overflow:"hidden",
        borderRadius:8,
        background: disabled || loading ? "rgba(255,255,255,0.1)" : accent,
        opacity: disabled || loading ? 0.5 : 1,
        transition:"all 0.3s ease",
        display:"flex", alignItems:"center",
        padding:"10px 20px",
        width: hovered ? "100%" : "auto",
        minWidth:120,
      }}>
        <span style={{
          fontWeight:700, fontSize:13, color:"#000",
          whiteSpace:"nowrap",
          transition:"opacity 0.2s",
          opacity: loading ? 0.7 : 1,
        }}>
          {loading ? "Loading…" : label}
        </span>
      </div>

      {/* Arrow circle */}
      <div style={{
        width:36, height:36, borderRadius:"50%",
        background: accent,
        display:"flex", alignItems:"center", justifyContent:"center",
        marginLeft:6,
        transform: hovered ? "translateX(6px)" : "translateX(0)",
        opacity: hovered ? 0 : 1,
        transition:"all 0.2s ease",
        flexShrink:0,
      }}>
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
          <path d="M3 8h10M9 4l4 4-4 4" stroke="#000" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
    </div>
  );
}
