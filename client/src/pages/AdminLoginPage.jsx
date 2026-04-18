// client/src/pages/AdminLoginPage.jsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

export default function AdminLoginPage({ onLogin }) {
  const { theme } = useTheme();
  const [form,    setForm]    = useState({ username:"", password:"" });
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async e => {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      const d = await api("/api/auth/login", {
        method:"POST",
        body:JSON.stringify({ username:form.username, password:form.password }),
      });
      if (d.user) {
        if (!d.user.isAdmin) {
          setError("This login is for admin access only. Use the main login page.");
        } else {
          onLogin(d.user);
        }
      } else {
        setError(d.error || "Login failed");
      }
    } catch(err) { setError(err.message); }
    setLoading(false);
  };

  const inputStyle = {
    width:"100%", height:42, padding:"0 14px",
    borderRadius:10, border:`1px solid ${theme.border}`,
    background:theme.surface, color:theme.text,
    fontFamily:"'DM Sans',system-ui", fontSize:13,
    outline:"none", boxSizing:"border-box",
    transition:"border-color 0.15s",
  };

  return (
    <div style={{
      minHeight:"100vh", display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"center",
      background:theme.bg, fontFamily:"'DM Sans',system-ui,sans-serif",
      padding:24,
    }}>
      <div style={{
        width:"100%", maxWidth:380,
        background:theme.surface, borderRadius:24,
        padding:"36px 32px", boxShadow:theme.shadowXl,
        border:`1px solid ${theme.border}`,
      }}>
        {/* Lock icon + title */}
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <div style={{ fontSize:32, marginBottom:10 }}>🔒</div>
          <div style={{ fontWeight:800, fontSize:18, color:theme.text, letterSpacing:"-0.3px" }}>
            Resume Master
          </div>
          <div style={{ fontSize:11, color:theme.textMuted, marginTop:4, fontWeight:700,
                        textTransform:"uppercase", letterSpacing:"0.1em" }}>
            Admin Access
          </div>
        </div>

        <form onSubmit={handleLogin} style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <input style={inputStyle} placeholder="Username or email" value={form.username}
            onChange={e => setForm(f => ({ ...f, username:e.target.value }))} autoFocus/>
          <input style={inputStyle} placeholder="Password" type="password" value={form.password}
            onChange={e => setForm(f => ({ ...f, password:e.target.value }))}/>
          {error && (
            <div style={{ fontSize:12, color:theme.danger, padding:"8px 12px",
                          background:theme.surfaceHigh, borderRadius:8,
                          border:`1px solid ${theme.dangerMuted||"rgba(220,38,38,0.2)"}`,
                          lineHeight:1.5 }}>
              {error}
            </div>
          )}
          <button type="submit" disabled={loading}
            style={{ width:"100%", padding:"12px 0", borderRadius:999, border:"none",
                     background:theme.gradAccent, color:"white", fontWeight:800,
                     fontSize:14, cursor:"pointer", marginTop:4,
                     opacity:loading?0.7:1, transition:"opacity 0.2s" }}>
            {loading ? "Signing in…" : "Sign In →"}
          </button>
        </form>

        <div style={{ textAlign:"center", marginTop:20 }}>
          <Link to="/login"
            style={{ fontSize:12, color:theme.textMuted, textDecoration:"none",
                     transition:"color 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.color = theme.text}
            onMouseLeave={e => e.currentTarget.style.color = theme.textMuted}>
            ← Back to main site
          </Link>
        </div>
      </div>
    </div>
  );
}
