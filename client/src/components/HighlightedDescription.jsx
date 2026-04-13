// client/src/components/HighlightedDescription.jsx — plain text renderer
// Keyword highlighting sourced from ATS analysis (ATSPanel) — not client-side matching.
export function HighlightedDescription({ text, theme, maxChars = 2000 }) {
  if (!text) return null;
  const trimmed = text.slice(0, maxChars);
  return (
    <p style={{ fontSize:12, color:theme.textMuted, lineHeight:1.7, margin:0, whiteSpace:"pre-wrap" }}>
      {trimmed}
      {text.length > maxChars && <span style={{ color:theme.textDim }}> … (truncated)</span>}
    </p>
  );
}
