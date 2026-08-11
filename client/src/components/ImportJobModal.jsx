import { useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

// ─── BYO-1 site-side front door ──────────────────────────────────────────────
// POST /api/import/job has existed since BYO-1 but had no UI: it was reachable
// only from the extension's capture hotkey or curl. This modal is that missing
// front door — paste a job URL, or paste the job text directly.
//
// Login-walled hosts (LinkedIn) are handled by the server WITHOUT any outbound
// fetch: it returns { needsClientCapture: true } instead. That is not an error,
// it's the designed path — so we present it as a next step (capture with the
// extension, or paste the text) and flip the form to text mode with the URL
// preserved, rather than surfacing a red failure.

const MODES = { URL: "url", TEXT: "text" };

export default function ImportJobModal({ onClose, onImported }) {
  const { theme } = useTheme();
  const [mode, setMode]           = useState(MODES.URL);
  const [url, setUrl]             = useState("");
  const [text, setText]           = useState("");
  const [busy, setBusy]           = useState(false);
  const [error, setError]         = useState("");
  const [notice, setNotice]       = useState("");
  const [imported, setImported]   = useState(null);

  const canSubmit = !busy && (mode === MODES.URL ? url.trim() : text.trim());

  async function submit() {
    if (!canSubmit) return;
    setBusy(true); setError(""); setNotice(""); setImported(null);

    // Send url and text together when both are present: importJob() treats
    // provided text as the fallback that satisfies a login-walled URL, so the
    // capture retry keeps the original link attached to the row.
    const body = {};
    if (url.trim())  body.url  = url.trim();
    if (mode === MODES.TEXT && text.trim()) body.text = text.trim();

    try {
      const d = await api("/api/import/job", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (d?.needsClientCapture) {
        setMode(MODES.TEXT);
        setNotice(d.message || "Open this job and capture it with the Resume Master extension, or paste the job text below.");
        return;
      }

      const job = d?.job || null;
      setImported(job);
      if (job && typeof onImported === "function") onImported(job);
    } catch (e) {
      setError(e?.message || "Could not import this job.");
    } finally {
      setBusy(false);
    }
  }

  const overlay = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 9000,
    display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
  };
  const modal = {
    background: theme.surface, border: `1px solid ${theme.border}`,
    borderRadius: 12, width: "100%", maxWidth: 480, maxHeight: "85vh",
    display: "flex", flexDirection: "column", overflow: "hidden",
    boxShadow: "0 24px 80px rgba(0,0,0,0.35)",
  };
  const hdr = {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 18px", borderBottom: `1px solid ${theme.border}`, flexShrink: 0,
  };
  const field = {
    width: "100%", background: theme.surfaceHigh, color: theme.text,
    border: `1px solid ${theme.border}`, borderRadius: 8,
    padding: "9px 11px", fontSize: 13, fontFamily: "inherit", outline: "none",
  };
  const tab = (active) => ({
    background: "none", border: "none", cursor: "pointer", padding: "4px 2px",
    fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase",
    color: active ? theme.text : theme.textMuted,
    borderBottom: `2px solid ${active ? theme.accent : "transparent"}`,
  });

  return createPortal(
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={modal}>
        <div style={hdr}>
          <div style={{ fontWeight: 800, fontSize: 15, color: theme.text }}>Import a job</div>
          <button onClick={onClose} aria-label="Close"
            style={{ background: "none", border: "none", cursor: "pointer",
                     color: theme.textMuted, fontSize: 18, lineHeight: 1 }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px",
                      display: "flex", flexDirection: "column", gap: 14 }}>

          {imported ? (
            <>
              <div style={{ background: "#dcfce7", color: "#166534", borderRadius: 6,
                            padding: "8px 12px", fontSize: 12, fontWeight: 700 }}>
                Imported into your board.
              </div>
              <div style={{ fontSize: 13, color: theme.text, fontWeight: 700 }}>
                {imported.title || "Untitled role"}
              </div>
              <div style={{ fontSize: 12, color: theme.textMuted }}>
                {[imported.company, imported.location].filter(Boolean).join(" · ") || "—"}
              </div>
              <button onClick={onClose}
                style={{ ...field, cursor: "pointer", fontWeight: 700, textAlign: "center",
                         background: theme.surfaceHigh }}>
                Done
              </button>
            </>
          ) : (
            <>
              <div style={{ display: "flex", gap: 16, borderBottom: `1px solid ${theme.border}` }}>
                <button style={tab(mode === MODES.URL)}  onClick={() => setMode(MODES.URL)}>Link</button>
                <button style={tab(mode === MODES.TEXT)} onClick={() => setMode(MODES.TEXT)}>Paste text</button>
              </div>

              {notice && (
                <div style={{ background: theme.surfaceHigh, color: theme.text,
                              border: `1px solid ${theme.border}`, borderRadius: 6,
                              padding: "8px 12px", fontSize: 12, lineHeight: 1.45 }}>
                  {notice}
                </div>
              )}
              {error && (
                <div style={{ background: "#fee2e2", color: "#991b1b", borderRadius: 6,
                              padding: "8px 12px", fontSize: 12 }}>
                  {error}
                </div>
              )}

              <input
                style={field}
                placeholder="https://boards.greenhouse.io/…"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === "Enter" && mode === MODES.URL && submit()}
              />

              {mode === MODES.TEXT && (
                <textarea
                  style={{ ...field, minHeight: 150, resize: "vertical", lineHeight: 1.5 }}
                  placeholder="Paste the job description here…"
                  value={text}
                  onChange={e => setText(e.target.value)}
                />
              )}

              <div style={{ fontSize: 11, color: theme.textMuted, lineHeight: 1.5 }}>
                {mode === MODES.URL
                  ? "Known job boards import directly. Other pages are read and structured automatically."
                  : "The link is optional here — pasted text is enough to import."}
              </div>

              <button
                onClick={submit}
                disabled={!canSubmit}
                style={{ ...field, cursor: canSubmit ? "pointer" : "not-allowed",
                         fontWeight: 700, textAlign: "center",
                         opacity: canSubmit ? 1 : 0.55 }}>
                {busy ? "Importing…" : "Import"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
