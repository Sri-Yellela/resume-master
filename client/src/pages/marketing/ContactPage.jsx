// client/src/pages/marketing/ContactPage.jsx
import { useState } from "react";
import { useTheme } from "../../styles/theme.jsx";
import { MarketingNav } from "../../components/MarketingNav.jsx";
import { Footer } from "../../components/Footer.jsx";
import { api } from "../../lib/api.js";

export function ContactPage() {
  const { theme } = useTheme();
  const [form, setForm] = useState({ name: "", email: "", subject: "", message: "" });
  const [status, setStatus] = useState(null); // "sending" | "ok" | "error"

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async e => {
    e.preventDefault();
    setStatus("sending");
    try {
      await api("/api/contact", { method: "POST", body: JSON.stringify(form) });
      setStatus("ok");
      setForm({ name: "", email: "", subject: "", message: "" });
    } catch {
      setStatus("error");
    }
  };

  const inputStyle = {
    width: "100%", padding: "10px 14px", borderRadius: 10,
    border: `1px solid ${theme.border}`, background: theme.surface,
    color: theme.text, fontSize: 14, fontFamily: "'DM Sans', system-ui",
    outline: "none", boxSizing: "border-box",
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column",
                  background: theme.bg, color: theme.text,
                  fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <MarketingNav/>
      <main style={{ flex: 1, maxWidth: 560, margin: "0 auto", padding: "64px 24px" }}>
        <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 900, letterSpacing: "-1.5px",
                      color: theme.text, marginBottom: 12, lineHeight: 1.1,
                      fontFamily: "'Barlow Condensed', 'DM Sans', system-ui" }}>
          Get in touch
        </h1>
        <p style={{ fontSize: 15, color: theme.textMuted, lineHeight: 1.6, marginBottom: 40 }}>
          We typically respond within 24 hours.
        </p>

        {status === "ok" ? (
          <div style={{ padding: "24px 28px", background: theme.successMuted,
                         border: `1px solid ${theme.success}44`, borderRadius: 16,
                         color: theme.success, fontSize: 15, fontWeight: 600 }}>
            ✓ Message sent. We'll be in touch soon.
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <input style={inputStyle} placeholder="Name *" value={form.name}
              onChange={e => set("name", e.target.value)} required/>
            <input style={inputStyle} placeholder="Email *" type="email" value={form.email}
              onChange={e => set("email", e.target.value)} required/>
            <select style={{ ...inputStyle, appearance: "none" }}
              value={form.subject} onChange={e => set("subject", e.target.value)}>
              <option value="">Subject — select one</option>
              <option value="General inquiry">General inquiry</option>
              <option value="Bug report">Bug report</option>
              <option value="Feature request">Feature request</option>
              <option value="Pricing">Pricing</option>
              <option value="Partnership">Partnership</option>
            </select>
            <textarea style={{ ...inputStyle, minHeight: 160, resize: "vertical", lineHeight: 1.6 }}
              placeholder="Message *" value={form.message}
              onChange={e => set("message", e.target.value)} required/>
            {status === "error" && (
              <div style={{ color: theme.danger, fontSize: 13 }}>
                Something went wrong — please try again.
              </div>
            )}
            <button type="submit" disabled={status === "sending"}
              style={{ padding: "12px 0", borderRadius: 999, border: "none",
                        background: theme.accent, color: theme.accentText,
                        fontWeight: 800, fontSize: 14, cursor: "pointer",
                        opacity: status === "sending" ? 0.7 : 1 }}>
              {status === "sending" ? "Sending…" : "Send message"}
            </button>
          </form>
        )}
      </main>
      <Footer/>
    </div>
  );
}
