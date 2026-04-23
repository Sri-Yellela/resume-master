const SECTION_ORDER = [
  "SUMMARY",
  "TECHNICAL SKILLS",
  "EXPERIENCE",
  "ACADEMIC PROJECTS",
  "PROJECTS",
  "EDUCATION",
];

const SECTION_ALIASES = new Map([
  ["WORK EXPERIENCE", "EXPERIENCE"],
  ["PROFESSIONAL EXPERIENCE", "EXPERIENCE"],
  ["EXPERIENCE", "EXPERIENCE"],
  ["TECHNICAL SKILLS", "TECHNICAL SKILLS"],
  ["SKILLS", "TECHNICAL SKILLS"],
  ["CORE COMPETENCIES", "TECHNICAL SKILLS"],
  ["EXPERTISE", "TECHNICAL SKILLS"],
  ["SUMMARY", "SUMMARY"],
  ["PROFESSIONAL SUMMARY", "SUMMARY"],
  ["PROFILE", "SUMMARY"],
  ["ABOUT", "SUMMARY"],
  ["EDUCATION", "EDUCATION"],
  ["ACADEMIC BACKGROUND", "EDUCATION"],
  ["QUALIFICATIONS", "EDUCATION"],
  ["PROJECTS", "PROJECTS"],
  ["PERSONAL PROJECTS", "PROJECTS"],
  ["SIDE PROJECTS", "PROJECTS"],
  ["ACADEMIC PROJECTS", "ACADEMIC PROJECTS"],
  ["GRADUATE PROJECTS", "ACADEMIC PROJECTS"],
  ["RESEARCH PROJECTS", "ACADEMIC PROJECTS"],
]);

export const RESUME_STYLE_BLOCK = `<style>
:root {
  --color-bg: #ffffff;
  --color-text: #1a1a1a;
  --color-muted: #3d3d3d;
  --color-rule: #6b6b6b;
  --fs-body: 8.5pt;
  --fs-name: 9pt;
  --fs-section: 8pt;
  --page-w: 8.5in;
  --margin-x: 0.55in;
  --margin-top: 0.45in;
  --margin-bot: 0.45in;
  --gap-section: 9pt;
  --gap-entry: 6pt;
  --gap-inline: 2pt;
  --lh-body: 1.42;
  --lh-bullets: 1.38;
}
body { background: var(--color-bg); color: var(--color-text); font-family: 'Garamond','EB Garamond',Georgia,serif; font-size: var(--fs-body); line-height: var(--lh-body); margin: var(--margin-top) var(--margin-x) var(--margin-bot); max-width: var(--page-w); }
.header { text-align: center; margin-bottom: 6pt; }
.header .name { font-size: var(--fs-name); font-weight: bold; text-transform: uppercase; letter-spacing: 0.08em; line-height: 1.1; }
.header .tagline { color: var(--color-muted); letter-spacing: 0.01em; font-size: var(--fs-body); }
.header .contact { font-size: var(--fs-body); letter-spacing: normal; }
.header .contact a { color: inherit; text-decoration: none; }
.section-title { font-size: var(--fs-section); font-weight: bold; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text); border-bottom: 0.5pt solid var(--color-rule); padding-bottom: 1pt; margin-top: var(--gap-section); margin-bottom: 4pt; }
.entry { margin-bottom: var(--gap-entry); page-break-inside: avoid; }
.entry-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8pt; }
.entry-org { font-weight: bold; }
.entry-meta { font-style: italic; color: var(--color-muted); font-weight: normal; }
.sep { font-style: normal; font-weight: normal; color: var(--color-muted); }
.entry-date { color: var(--color-muted); white-space: nowrap; margin-left: 8pt; flex-shrink: 0; font-size: var(--fs-body); }
.entry-role { font-style: italic; color: var(--color-muted); margin-bottom: var(--gap-inline); }
.tech-line { font-size: calc(var(--fs-body) - 0.4pt); color: var(--color-muted); margin-bottom: var(--gap-inline); }
ul.bullets { list-style: disc outside; padding-left: 1.1em; margin: var(--gap-inline) 0 0 0; }
ul.bullets li { font-size: var(--fs-body); line-height: var(--lh-bullets); margin: 0 0 1.6pt 0; padding-left: 0.1em; text-align: left; }
.skills-table { width: 100%; border-collapse: collapse; font-size: var(--fs-body); }
.skill-label { font-weight: bold; white-space: nowrap; padding-right: 12pt; width: 1%; vertical-align: top; padding: 1.2pt 12pt 1.2pt 0; }
.skill-values { color: var(--color-text); padding: 1.2pt 0; }
@media print {
  body { margin: var(--margin-top) var(--margin-x) var(--margin-bot); }
  .entry { page-break-inside: avoid; }
  .section-title { page-break-after: avoid; }
}
</style>`;

function stripInvalidUnicode(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g, "")
    .replace(/\r\n?/g, "\n");
}

function collapseWhitespace(value) {
  return stripInvalidUnicode(value)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function classAttrPattern(className) {
  const escapedClass = String(className || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `class=(?:"[^"<>]*\\b${escapedClass}\\b[^"<>]*"|'[^'<>]*\\b${escapedClass}\\b[^'<>]*')`;
}

function findTagStartsByClass(html, tagName, className) {
  const starts = [];
  const regex = new RegExp(`<${tagName}([^>]*)>`, "gi");
  let match;
  while ((match = regex.exec(String(html || "")))) {
    const classMatch = match[1].match(/class=(["'])(.*?)\1/i);
    const classes = String(classMatch?.[2] || "").split(/\s+/).filter(Boolean);
    if (classes.includes(className)) starts.push(match.index || 0);
  }
  return starts;
}

export function renderInlineRichText(value) {
  const escaped = escapeHtml(collapseWhitespace(value));
  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function stripTagsToText(value) {
  return collapseWhitespace(
    decodeHtmlEntities(
      String(value || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>|<\/div>|<\/li>|<\/tr>|<\/h\d>/gi, "\n")
        .replace(/<li[^>]*>/gi, "• ")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

function extractBodyHtml(html) {
  const match = String(html || "").match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return match ? match[1] : String(html || "");
}

function extractClassBlock(html, className) {
  const source = String(html || "");
  const regex = /<([a-z0-9]+)([^>]*)>/gi;
  let match;
  while ((match = regex.exec(source))) {
    const tagName = String(match[1] || "").toLowerCase();
    const classes = String(match[2].match(/class=(["'])(.*?)\1/i)?.[2] || "")
      .split(/\s+/)
      .filter(Boolean);
    if (!classes.includes(className)) continue;
    const innerStart = regex.lastIndex;
    const tagPattern = new RegExp(`</?${tagName}\\b[^>]*>`, "gi");
    tagPattern.lastIndex = innerStart;
    let depth = 1;
    let token;
    while ((token = tagPattern.exec(source))) {
      const tokenText = token[0];
      const isClosing = tokenText.startsWith("</");
      const isSelfClosing = /\/>$/.test(tokenText);
      if (!isClosing && !isSelfClosing) depth += 1;
      if (isClosing) depth -= 1;
      if (depth === 0) {
        return source.slice(innerStart, token.index);
      }
    }
    return "";
  }
  return "";
}

function extractElementsByClass(html, tagName, className) {
  const source = String(html || "");
  const matches = [];
  const regex = new RegExp(`<${tagName}([^>]*)>`, "gi");
  let match;
  while ((match = regex.exec(source))) {
    const classes = String(match[1].match(/class=(["'])(.*?)\1/i)?.[2] || "")
      .split(/\s+/)
      .filter(Boolean);
    if (!classes.includes(className)) continue;
    const start = match.index;
    const innerStart = regex.lastIndex;
    const tagPattern = new RegExp(`</?${tagName}\\b[^>]*>`, "gi");
    tagPattern.lastIndex = innerStart;
    let depth = 1;
    let token;
    while ((token = tagPattern.exec(source))) {
      const tokenText = token[0];
      const isClosing = tokenText.startsWith("</");
      const isSelfClosing = /\/>$/.test(tokenText);
      if (!isClosing && !isSelfClosing) depth += 1;
      if (isClosing) depth -= 1;
      if (depth === 0) {
        matches.push(source.slice(start, tagPattern.lastIndex));
        break;
      }
    }
  }
  return matches;
}

function extractLeafClassText(html, tagName, className) {
  const pattern = new RegExp(
    `<${tagName}[^>]*${classAttrPattern(className)}[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "i"
  );
  return stripTagsToText((String(html || "").match(pattern) || [])[1] || "");
}

function normalizeSectionName(raw) {
  const key = collapseWhitespace(stripTagsToText(raw)).toUpperCase();
  return SECTION_ALIASES.get(key) || key;
}

function splitSectionsFromHtml(bodyHtml) {
  const sectionRegex = new RegExp(`<(?:div|h1|h2|h3|h4|section)[^>]*${classAttrPattern("section-title")}[^>]*>([\\s\\S]*?)<\\/(?:div|h1|h2|h3|h4|section)>`, "gi");
  const sections = [];
  let match;
  let lastIndex = 0;
  while ((match = sectionRegex.exec(bodyHtml))) {
    const start = match.index;
    if (sections.length) {
      sections[sections.length - 1].contentHtml = bodyHtml.slice(lastIndex, start);
    }
    sections.push({
      title: normalizeSectionName(match[1]),
      contentHtml: "",
    });
    lastIndex = sectionRegex.lastIndex;
  }
  if (sections.length) {
    sections[sections.length - 1].contentHtml = bodyHtml.slice(lastIndex);
  }
  return sections;
}

function parseHeaderFromHtml(bodyHtml) {
  const headerStart = findTagStartsByClass(bodyHtml, "div", "header")[0] ?? -1;
  if (headerStart === -1) return null;
  const sectionStart = String(bodyHtml || "").search(new RegExp(`<(?:div|h1|h2|h3|h4|section)[^>]*${classAttrPattern("section-title")}`, "i"));
  const headerHtml = bodyHtml.slice(headerStart, sectionStart > headerStart ? sectionStart : undefined);
  if (!headerHtml) return null;
  const name = stripTagsToText(extractClassBlock(headerHtml, "name")) || "";
  const tagline = stripTagsToText(extractClassBlock(headerHtml, "tagline")) || "";
  const contact = stripTagsToText(extractClassBlock(headerHtml, "contact")) || "";
  return { name, tagline, contact };
}

function parseSkillsRows(contentHtml) {
  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(contentHtml))) {
    const labelMatch = rowMatch[1].match(/class="[^"]*\bskill-label\b[^"]*"[^>]*>([\s\S]*?)<\/t[dh]>/i);
    const valueMatch = rowMatch[1].match(/class="[^"]*\bskill-values\b[^"]*"[^>]*>([\s\S]*?)<\/t[dh]>/i);
    if (!labelMatch && !valueMatch) continue;
    rows.push({
      label: stripTagsToText(labelMatch?.[1] || ""),
      values: stripTagsToText(valueMatch?.[1] || ""),
    });
  }
  if (rows.length) return rows;

  return collapseWhitespace(stripTagsToText(contentHtml))
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const idx = line.indexOf(":");
      if (idx === -1) return { label: "", values: line };
      return {
        label: line.slice(0, idx).trim(),
        values: line.slice(idx + 1).trim(),
      };
    });
}

function parseEntryBlockFromHtml(entryHtml) {
  const org = stripTagsToText(extractClassBlock(entryHtml, "entry-org")) || "";
  const meta = stripTagsToText(extractClassBlock(entryHtml, "entry-meta")) || "";
  const date = extractLeafClassText(entryHtml, "div", "entry-date") || "";
  const role = stripTagsToText(extractClassBlock(entryHtml, "entry-role")) || "";
  const tech = stripTagsToText(extractClassBlock(entryHtml, "tech-line")) || "";
  const bullets = [...String(entryHtml || "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map(match => stripTagsToText(match[1]))
    .filter(Boolean);
  const paragraphs = collapseWhitespace(
    stripTagsToText(
      String(entryHtml || "")
        .replace(/<ul[^>]*class="[^"]*\bbullets\b[^"]*"[\s\S]*?<\/ul>/gi, "")
        .replace(/<div[^>]*class="[^"]*\bentry-header\b[^"]*"[\s\S]*?<\/div>/i, "")
        .replace(/<div[^>]*class="[^"]*\bentry-role\b[^"]*"[\s\S]*?<\/div>/i, "")
        .replace(/<div[^>]*class="[^"]*\btech-line\b[^"]*"[\s\S]*?<\/div>/i, "")
    )
  );
  return {
    company: org,
    meta,
    date,
    role,
    tech,
    bullets,
    text: paragraphs,
  };
}

function parseEntriesFromHtml(contentHtml) {
  const html = String(contentHtml || "");
  const chunks = extractElementsByClass(html, "div", "entry");
  if (chunks.length) {
    return chunks.map(chunk => parseEntryBlockFromHtml(chunk)).filter(entry => (
      entry.company || entry.role || entry.date || entry.bullets.length || entry.text
    ));
  }
  return parseEntriesFromText(stripTagsToText(contentHtml));
}

function parseEntriesFromText(contentText) {
  const blocks = collapseWhitespace(contentText).split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  return blocks.map(block => {
    const lines = block.split("\n").map(line => line.trim()).filter(Boolean);
    const bullets = lines.filter(line => /^[-•*]\s+/.test(line)).map(line => line.replace(/^[-•*]\s+/, ""));
    const nonBullet = lines.filter(line => !/^[-•*]\s+/.test(line));
    const header = nonBullet[0] || "";
    const role = nonBullet[1] || "";
    const text = nonBullet.slice(2).join(" ");
    const dateMatch = header.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\s*[-–]\s*(?:Present|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i);
    const date = dateMatch?.[0] || "";
    const headerWithoutDate = date ? header.replace(date, "").trim().replace(/[|,-]\s*$/, "").trim() : header;
    const pieces = headerWithoutDate.split(/\s+\|\s+|,\s+(?=[A-Z][a-z])/);
    return {
      company: pieces[0] || headerWithoutDate,
      meta: pieces.slice(1).join(" | "),
      date,
      role,
      tech: "",
      bullets,
      text,
    };
  }).filter(entry => entry.company || entry.role || entry.bullets.length || entry.text);
}

function parseSummary(contentHtml) {
  return collapseWhitespace(stripTagsToText(contentHtml));
}

function parseResumeFromHtml(html) {
  const bodyHtml = extractBodyHtml(html);
  const header = parseHeaderFromHtml(bodyHtml);
  const sections = splitSectionsFromHtml(bodyHtml).map(section => {
    if (section.title === "SUMMARY") {
      return { type: "summary", title: section.title, text: parseSummary(section.contentHtml) };
    }
    if (section.title === "TECHNICAL SKILLS") {
      return { type: "skills", title: section.title, rows: parseSkillsRows(section.contentHtml) };
    }
    return { type: "entries", title: section.title, entries: parseEntriesFromHtml(section.contentHtml) };
  });
  return { header, sections };
}

function splitSectionsFromText(text) {
  const lines = collapseWhitespace(text).split("\n");
  const sections = [];
  let current = null;
  for (const line of lines) {
    const title = normalizeSectionName(line);
    if (SECTION_ORDER.includes(title)) {
      current = { title, lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
  }
  return sections;
}

function parseHeaderFromText(text) {
  const lines = collapseWhitespace(text).split("\n").map(line => line.trim()).filter(Boolean);
  const stopIndex = lines.findIndex(line => SECTION_ORDER.includes(normalizeSectionName(line)));
  const headerLines = (stopIndex === -1 ? lines.slice(0, 3) : lines.slice(0, stopIndex)).slice(0, 3);
  return {
    name: headerLines[0] || "",
    tagline: headerLines[1] || "",
    contact: headerLines[2] || "",
  };
}

function parseResumeFromText(text) {
  const header = parseHeaderFromText(text);
  const sections = splitSectionsFromText(text).map(section => {
    const content = section.lines.join("\n");
    if (section.title === "SUMMARY") {
      return { type: "summary", title: section.title, text: collapseWhitespace(content) };
    }
    if (section.title === "TECHNICAL SKILLS") {
      return { type: "skills", title: section.title, rows: parseSkillsRows(content) };
    }
    return { type: "entries", title: section.title, entries: parseEntriesFromText(content) };
  });
  return { header, sections };
}

function normalizeStructure(structure = {}) {
  const header = {
    name: collapseWhitespace(structure.header?.name || ""),
    tagline: collapseWhitespace(structure.header?.tagline || ""),
    contact: collapseWhitespace(structure.header?.contact || ""),
  };
  const sections = (structure.sections || [])
    .filter(section => section && section.title)
    .map(section => {
      if (section.type === "summary") {
        return { type: "summary", title: section.title, text: collapseWhitespace(section.text || "") };
      }
      if (section.type === "skills") {
        return {
          type: "skills",
          title: section.title,
          rows: (section.rows || []).map(row => ({
            label: collapseWhitespace(row.label || ""),
            values: collapseWhitespace(row.values || ""),
          })).filter(row => row.label || row.values),
        };
      }
      return {
        type: "entries",
        title: section.title,
        entries: mergeEntryFragments((section.entries || []).map(entry => ({
          company: collapseWhitespace(entry.company || ""),
          meta: collapseWhitespace(entry.meta || ""),
          date: collapseWhitespace(entry.date || ""),
          role: collapseWhitespace(entry.role || ""),
          tech: collapseWhitespace(entry.tech || ""),
          text: collapseWhitespace(entry.text || ""),
          bullets: (entry.bullets || []).map(bullet => collapseWhitespace(bullet)).filter(Boolean),
        })).filter(entry => entry.company || entry.role || entry.date || entry.text || entry.bullets.length)),
      };
    });
  return { header, sections };
}

function mergeEntryFragments(entries = []) {
  const merged = [];
  for (const entry of entries) {
    const current = {
      company: entry.company || "",
      meta: entry.meta || "",
      date: entry.date || "",
      role: entry.role || "",
      tech: entry.tech || "",
      text: entry.text || "",
      bullets: [...(entry.bullets || [])],
    };
    const last = merged[merged.length - 1];
    const looksLikeRoleOnlyFragment = !!last
      && !current.date
      && !current.meta
      && !current.role
      && !!current.company
      && current.bullets.length > 0;
    const startsNewEntry = !last || (
      (current.company || current.date || (current.meta && current.role))
      && !looksLikeRoleOnlyFragment
    );
    if (startsNewEntry) {
      merged.push(current);
      continue;
    }
    if (!last.role && current.role) last.role = current.role;
    if (!last.role && looksLikeRoleOnlyFragment) last.role = current.company;
    if (!last.tech && current.tech) last.tech = current.tech;
    if (current.text) {
      last.text = [last.text, current.text].filter(Boolean).join(" ").trim();
    }
    if (current.bullets.length) {
      last.bullets.push(...current.bullets);
    }
  }
  return merged;
}

export function buildStructuredResume(raw) {
  const normalized = collapseWhitespace(String(raw || ""));
  if (!normalized) return { header: { name: "", tagline: "", contact: "" }, sections: [] };
  const looksHtml = /<html[\s>]|<body[\s>]|<div[\s>]|<p[\s>]|<section[\s>]/i.test(normalized);
  const structure = looksHtml ? parseResumeFromHtml(normalized) : parseResumeFromText(normalized);
  const normalizedStructure = normalizeStructure(structure);
  if (looksHtml && !normalizedStructure.sections.length) {
    return normalizeStructure(parseResumeFromText(stripTagsToText(normalized)));
  }
  return normalizedStructure;
}

function renderHeader(header) {
  if (!header.name && !header.tagline && !header.contact) return "";
  return `<div class="header">
  ${header.name ? `<div class="name">${renderInlineRichText(header.name)}</div>` : ""}
  ${header.tagline ? `<div class="tagline">${renderInlineRichText(header.tagline)}</div>` : ""}
  ${header.contact ? `<div class="contact">${renderInlineRichText(header.contact)}</div>` : ""}
</div>`;
}

function renderEntry(entry) {
  const metaText = [entry.company, entry.meta].filter(Boolean).join(entry.meta ? ` <span class="sep">|</span> ` : "");
  const bulletsHtml = entry.bullets.length
    ? `<ul class="bullets">
${entry.bullets.map(bullet => `  <li>${renderInlineRichText(bullet)}</li>`).join("\n")}
</ul>`
    : "";
  return `<div class="entry">
  <div class="entry-header">
    <div>${metaText ? `<span class="entry-org">${renderInlineRichText(entry.company)}</span>${entry.meta ? ` <span class="entry-meta"><span class="sep">|</span> ${renderInlineRichText(entry.meta)}</span>` : ""}` : ""}</div>
    ${entry.date ? `<div class="entry-date">${renderInlineRichText(entry.date)}</div>` : ""}
  </div>
  ${entry.role ? `<div class="entry-role">${renderInlineRichText(entry.role)}</div>` : ""}
  ${entry.tech ? `<div class="tech-line">${renderInlineRichText(entry.tech)}</div>` : ""}
  ${entry.text ? `<div>${renderInlineRichText(entry.text)}</div>` : ""}
  ${bulletsHtml}
</div>`;
}

function renderSection(section) {
  if (section.type === "summary") {
    return `<div class="section-title">${section.title}</div>
<div>${renderInlineRichText(section.text)}</div>`;
  }
  if (section.type === "skills") {
    return `<div class="section-title">${section.title}</div>
<table class="skills-table">
  <tbody>
${section.rows.map(row => `    <tr><td class="skill-label">${renderInlineRichText(row.label)}</td><td class="skill-values">${renderInlineRichText(row.values)}</td></tr>`).join("\n")}
  </tbody>
</table>`;
  }
  return `<div class="section-title">${section.title}</div>
${section.entries.map(renderEntry).join("\n")}`;
}

export function renderStructuredResume(structure) {
  const normalized = normalizeStructure(structure);
  const orderedSections = SECTION_ORDER
    .map(title => normalized.sections.find(section => section.title === title))
    .filter(Boolean);
  const body = [
    renderHeader(normalized.header),
    ...orderedSections.map(renderSection),
  ].filter(Boolean).join("\n");
  return `<html><head>${RESUME_STYLE_BLOCK}</head><body>
${body}
<!-- Save and submit as PDF (print to PDF from browser). Do not submit as image PDF, Google Docs link, or scanned document. -->
</body></html>`;
}

export function normalizeResumeHtml(raw) {
  const cleaned = stripInvalidUnicode(String(raw || ""))
    .replace(/```html|```/gi, "")
    .replace(/<!-- A_PLUS SELECTION[\s\S]*?-->/gi, "")
    .replace(/<!-- CUSTOM_SAMPLER SELECTION[\s\S]*?-->/gi, "")
    .trim();
  return renderStructuredResume(buildStructuredResume(cleaned));
}

export function stripResumeHtml(html) {
  return collapseWhitespace(
    decodeHtmlEntities(
      String(html || "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<!-- A_PLUS SELECTION[\s\S]*?-->/gi, "")
        .replace(/<!-- CUSTOM_SAMPLER SELECTION[\s\S]*?-->/gi, "")
        .replace(/<[^>]+>/g, " ")
    )
  ).replace(/\s+([,.;:!?])/g, "$1");
}
