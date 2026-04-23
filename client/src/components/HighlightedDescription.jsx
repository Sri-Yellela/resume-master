// client/src/components/HighlightedDescription.jsx — plain text renderer
// Keyword highlighting sourced from ATS analysis (ATSPanel) — not client-side matching.
export function HighlightedDescription({ text, theme, maxChars = 2000, truncate = true }) {
  if (!text) return null;
  const shouldTruncate = truncate && Number.isFinite(maxChars);
  const trimmed = shouldTruncate ? text.slice(0, maxChars) : text;
  return (
    <p style={{ fontSize:12, color:theme.textMuted, lineHeight:1.7, margin:0, whiteSpace:"pre-wrap" }}>
      {trimmed}
      {shouldTruncate && text.length > maxChars && <span style={{ color:theme.textDim }}> … (truncated)</span>}
    </p>
  );
}
