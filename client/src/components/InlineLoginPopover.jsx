import { useState, useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import { api, setAuthContext } from "../lib/api.js";

const OAUTH_PROVIDERS = ["google", "linkedin", "github"];

export default function InlineLoginPopover({ trigger, onLogin, align = "end", sideOffset = 8 }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [oauthStatus, setOauthStatus] = useState(null);

  useEffect(() => {
    if (!open) return;
    api("/api/auth/oauth/status").then(setOauthStatus).catch(() => {});
  }, [open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const d = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      // The server returns { user, authContext } on success (no `success` field).
      // Match AuthScreen's check exactly: presence of d.user means logged in.
      if (d.user) {
        if (d.authContext) setAuthContext(d.authContext);
        setOpen(false);
        onLogin?.(d.user);
      } else {
        setError(d.error || "Login failed");
      }
    } catch (err) {
      setError(err?.message || "Network error");
    } finally {
      setLoading(false);
    }
  };

  const handleOAuth = (provider) => {
    window.location.href = `/api/auth/oauth/${provider}/start`;
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align={align} sideOffset={sideOffset}
          className="liquid-panel"
          style={{ width: 320, padding: 20, borderRadius: 16, zIndex: 1000, color: "var(--color-text)" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 20, marginBottom: 4 }}>
            Welcome back
          </div>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 16 }}>
            Sign in to your account
          </div>
          <form onSubmit={handleSubmit}>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)}
              placeholder="Username or email" autoComplete="username" required
              style={{ width: "100%", height: 38, padding: "0 12px", marginBottom: 8,
                background: "var(--bg-input)", border: "1px solid var(--border-glass)",
                borderRadius: 8, color: "var(--color-text)", fontSize: 13, outline: "none",
                boxSizing: "border-box" }}/>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Password" autoComplete="current-password" required
              style={{ width: "100%", height: 38, padding: "0 12px", marginBottom: 8,
                background: "var(--bg-input)", border: "1px solid var(--border-glass)",
                borderRadius: 8, color: "var(--color-text)", fontSize: 13, outline: "none",
                boxSizing: "border-box" }}/>
            {error && (
              <div style={{ color: "var(--color-warning, #f59e0b)", fontSize: 11, marginBottom: 8 }}>
                {error}
              </div>
            )}
            <button type="submit" disabled={loading} className="liquid-glass"
              style={{ width: "100%", height: 40, borderRadius: 999, fontSize: 13, fontWeight: 600,
                cursor: "pointer", color: "var(--color-text)", opacity: loading ? 0.6 : 1,
                marginBottom: 12, border: "none" }}>
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
          {oauthStatus && OAUTH_PROVIDERS.some(p => oauthStatus[p]?.configured) && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10,
                color: "var(--color-text-faint)", textTransform: "uppercase",
                letterSpacing: "0.1em", marginBottom: 10 }}>
                <div style={{ flex: 1, height: 1, background: "var(--border-glass)" }}/>
                or
                <div style={{ flex: 1, height: 1, background: "var(--border-glass)" }}/>
              </div>
              {OAUTH_PROVIDERS.filter(p => oauthStatus[p]?.configured).map(p => (
                <button key={p} onClick={() => handleOAuth(p)} type="button"
                  className="liquid-glass"
                  style={{ width: "100%", height: 36, borderRadius: 999, fontSize: 12, fontWeight: 500,
                    cursor: "pointer", color: "var(--color-text)", marginBottom: 6,
                    textTransform: "capitalize", border: "none" }}>
                  Continue with {p}
                </button>
              ))}
            </>
          )}
          <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 12, textAlign: "center" }}>
            No account?{" "}
            <a href="/register" style={{ color: "var(--color-primary)", textDecoration: "none" }}>
              Create one
            </a>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
