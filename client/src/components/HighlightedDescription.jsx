// client/src/components/HighlightedDescription.jsx — shared keyword highlighter
const TECH_RE = /\b(python|javascript|typescript|java|golang|go|rust|c\+\+|c#|react|vue|angular|node\.?js|django|flask|fastapi|spring|docker|kubernetes|k8s|aws|gcp|azure|terraform|postgresql|mysql|mongodb|redis|kafka|spark|tensorflow|pytorch|sklearn|sql|git|linux|bash|rest|graphql|ml|ai|llm|nlp|cuda|hadoop|airflow|dbt|snowflake|bigquery|pandas|numpy|scipy|scikit|jupyter|excel|tableau|looker|powerbi|figma|jira|scrum|agile|ci\/cd|jenkins|github|gitlab|bitbucket|microservices|grpc|oauth|jwt|html|css|sass|webpack|vite|next\.?js|nuxt|svelte|flutter|swift|kotlin|ios|android|unity|unreal)\b/gi;

export function HighlightedDescription({ text, baseResumeSkills, theme, maxChars = 2000 }) {
  if (!text) return null;
  const trimmed = text.slice(0, maxChars);
  const parts = [];
  let last = 0;
  let match;
  TECH_RE.lastIndex = 0;
  while ((match = TECH_RE.exec(trimmed)) !== null) {
    if (match.index > last) parts.push({ type:"text", content: trimmed.slice(last, match.index) });
    const word = match[0];
    const hasSkill = baseResumeSkills && baseResumeSkills.has(word.toLowerCase());
    parts.push({ type:"kw", content: word, has: hasSkill });
    last = match.index + word.length;
  }
  if (last < trimmed.length) parts.push({ type:"text", content: trimmed.slice(last) });
  return (
    <p style={{ fontSize:12, color:theme.textMuted, lineHeight:1.7, margin:0, whiteSpace:"pre-wrap" }}>
      {parts.map((p, i) =>
        p.type === "text" ? p.content :
        <mark key={i} style={{
          background: p.has ? "#dcfce7" : "#fee2e2",
          color: p.has ? "#166534" : "#991b1b",
          padding:"0 2px", borderRadius:2, fontWeight:600,
        }}>{p.content}</mark>
      )}
      {text.length > maxChars && <span style={{ color:theme.textDim }}> … (truncated)</span>}
    </p>
  );
}