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

// CHANGE 1: .header .name — removed text-transform:uppercase and letter-spacing
// CHANGE 2: .entry-meta — changed to font-style:normal and color:var(--color-text)
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
.header .name { font-size: var(--fs-name); font-weight: bold; text-transform: none; letter-spacing: normal; line-height: 1.1; }
.header .tagline { color: var(--color-muted); letter-spacing: 0.01em; font-size: var(--fs-body); }
.header .contact { font-size: var(--fs-body); letter-spacing: normal; }
.header .contact a { color: inherit; text-decoration: none; }
.section-title { font-size: var(--fs-section); font-weight: bold; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text); border-bottom: 0.5pt solid var(--color-rule); padding-bottom: 1pt; margin-top: var(--gap-section); margin-bottom: 4pt; }
.entry { margin-bottom: var(--gap-entry); page-break-inside: avoid; }
.entry-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8pt; }
.entry-org { font-weight: bold; }
.entry-meta { font-style: normal; color: var(--color-text); font-weight: normal; }
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

// CHANGE 3: added common HTML entities the LLM outputs; &amp; kept last so
// it does not double-encode entities decoded earlier in the chain
function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&ast;/gi, "*")
    .replace(/&bull;/gi, "•")
    .replace(/&mdash;/gi, "-")
    .replace(/&ndash;/gi, "-")
    .replace(/&ldquo;/gi, '"')
    .replace(/&rdquo;/gi, '"')
    .replace(/&lsquo;/gi, "'")
    .replace(/&rsquo;/gi, "'")
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

// CHANGE 4: convert <strong> and <b> to **...** BEFORE stripping tags so
// bold survives the parse-render round-trip when the LLM uses HTML bold tags
function stripTagsToText(value) {
  return collapseWhitespace(
    decodeHtmlEntities(
      String(value || "")
        .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
        .replace(/<b(?:\s[^>]*)?>([\s\S]*?)<\/b>/gi, "**$1**")
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

/**
 * Remove whole ELEMENTS, nesting and all (AG4).
 *
 * WHY THIS REPLACED A LIST OF REGEXES
 * parseEntryBlockFromHtml built an entry's free text by deleting the blocks it had already read —
 * the header, the role, the bullet list — and keeping whatever was left. It deleted them with
 * `<div class="entry-header">[\s\S]*?</div>`, which is non-greedy and therefore stops at the FIRST
 * `</div>`. An entry header contains a nested div, so the delete ended inside it and the date div
 * survived into the "leftover" text. renderEntry then rendered the date twice: once styled by
 * entry-date, once as body text. The bullet list had the same failure for a different reason — the
 * pattern required class="bullets", so a plain <ul> from the model was read into entry.bullets AND
 * left in the text, and every bullet rendered twice.
 *
 * Both are the same mistake: matching an element with a regex that cannot count. This walks the
 * tag depth like extractClassBlock and extractElementsByClass already do, so an element is removed
 * with everything inside it, however deeply that nests.
 *
 * @param {string} html
 * @param {(tagName: string, classes: string[]) => boolean} shouldRemove
 */
function removeElements(html, shouldRemove) {
  let source = String(html || "");
  // Bounded: each pass removes one element, and a resume entry has nowhere near this many.
  for (let guard = 0; guard < 500; guard += 1) {
    const openPattern = /<([a-z0-9]+)([^>]*)>/gi;
    let match;
    let removedOne = false;
    while ((match = openPattern.exec(source))) {
      const tagName = String(match[1] || "").toLowerCase();
      const attrs = String(match[2] || "");
      if (/\/$/.test(attrs)) continue; // self-closing carries nothing to remove
      const classes = String(attrs.match(/class=(["'])(.*?)\1/i)?.[2] || "")
        .split(/\s+/)
        .filter(Boolean);
      if (!shouldRemove(tagName, classes)) continue;

      const start = match.index;
      const tagPattern = new RegExp(`</?${tagName}\\b[^>]*>`, "gi");
      tagPattern.lastIndex = openPattern.lastIndex;
      let depth = 1;
      let end = -1;
      let token;
      while ((token = tagPattern.exec(source))) {
        const text = token[0];
        if (/\/>$/.test(text)) continue;
        depth += text.startsWith("</") ? -1 : 1;
        if (depth === 0) { end = tagPattern.lastIndex; break; }
      }
      // An unclosed tag owns the rest of the block, which is what a browser would render too.
      source = `${source.slice(0, start)} ${source.slice(end === -1 ? source.length : end)}`;
      removedOne = true;
      break;
    }
    if (!removedOne) break;
  }
  return source;
}

/** True for any element whose content parseEntryBlockFromHtml has already read into a field. */
function isAlreadyReadBlock(tagName, classes) {
  if (tagName === "ul" || tagName === "ol" || tagName === "li") return true;
  return classes.includes("entry-header") || classes.includes("entry-role") || classes.includes("tech-line");
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

  // The shape renderSection ITSELF emits: <li><strong>Label</strong> values</li> (AG4).
  //
  // Parsing our own output has to round-trip, because a stored artifact is re-formatted on the
  // enhance and adopt paths. It did not: stripTagsToText turns "<li>" into "• ", the line then had
  // no colon to split on, so the whole row became the VALUES with an empty label — rendering as
  // `<li><strong></strong> • Languages Java ...`, a bullet glyph inside a bullet and an empty bold
  // run. The style round-trip was altering the content, which is the same fault as the duplicated
  // entry text, one section over.
  const items = [...String(contentHtml || "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(m => m[1]);
  if (items.length) {
    return items
      .map(item => {
        // A leading <strong> is the label. Later ones are emphasis inside the values.
        const lead = item.match(/^\s*<strong[^>]*>([\s\S]*?)<\/strong>\s*([\s\S]*)$/i);
        if (lead) return { label: stripTagsToText(lead[1]), values: stripTagsToText(lead[2]) };
        const text = stripTagsToText(item).replace(/^[-•*·‣▪]\s+/, "");
        const idx = text.indexOf(":");
        if (idx === -1) return { label: "", values: text };
        return { label: text.slice(0, idx).trim(), values: text.slice(idx + 1).trim() };
      })
      .filter(row => row.label || row.values);
  }

  return collapseWhitespace(stripTagsToText(contentHtml))
    .split("\n")
    .map(line => line.trim().replace(/^[-•*·‣▪]\s+/, ""))
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
  // The separator span is STYLING, not content. renderEntry writes the "|" itself, so reading it
  // back as part of the meta made every re-format add another one — "| | Technical Assistant".
  const meta = stripTagsToText(
    removeElements(extractClassBlock(entryHtml, "entry-meta"), (_tag, classes) => classes.includes("sep")),
  ).replace(/^[\s|]+/, "") || "";
  const date = extractLeafClassText(entryHtml, "div", "entry-date") || "";
  const role = stripTagsToText(extractClassBlock(entryHtml, "entry-role")) || "";
  const tech = stripTagsToText(extractClassBlock(entryHtml, "tech-line")) || "";
  const bullets = [...String(entryHtml || "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map(match => stripTagsToText(match[1]))
    .filter(Boolean);
  // Whatever is left once every field above has been read. Removing those elements PROPERLY is the
  // whole of the AG4 fix — see removeElements. Note the list removal is not limited to
  // class="bullets": the <li> scan above reads bullets out of ANY list, so any list left behind
  // here would be a second copy of them.
  const leftover = collapseWhitespace(
    stripTagsToText(removeElements(entryHtml, isAlreadyReadBlock)),
  );
  const draft = { company: org, meta, date, role, tech, bullets, text: "" };
  const { paragraphs, extraBullets } = classifyLeftover(leftover, draft);
  return { ...draft, bullets: [...bullets, ...extraBullets], text: paragraphs };
}

/** Compare two lines as a reader would — ignoring case, bullet glyphs and punctuation spacing. */
function comparableLine(value) {
  return normalizeHeaderComparable(value).replace(/\s+/g, "");
}

/**
 * Sort an entry's leftover text into prose and bullets, dropping what is already on screen (AG4).
 *
 * WHY THE LEFTOVER CANNOT SIMPLY BE TREATED AS PROSE
 * Models routinely emit a plain <div> that restates the entry's header line and then lists the
 * bullets again as "• ..." text, alongside the <ul> they also emitted. The old code read that div
 * wholesale into entry.text, so renderEntry printed the role, the dates and every bullet a second
 * time as body copy — which is precisely the "renders TWICE, then the bullet text runs on from it"
 * report. cleanEntryHeaderDupes only caught it when the div held the header line and NOTHING else.
 *
 * So each line is classified once: an echo of the header is dropped because the header already
 * renders it, a bullet already in the list is dropped for the same reason, and a bullet that is
 * NOT in the list is PROMOTED rather than discarded. Nothing is deduplicated after rendering and
 * nothing is thrown away — a line the entry does not already show still gets shown.
 */
function classifyLeftover(text, entry) {
  const seen = new Set((entry.bullets || []).map(comparableLine).filter(Boolean));
  const paragraphs = [];
  const extraBullets = [];

  for (const rawLine of String(text || "").split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const isBullet = /^[-•*·‣▪]\s+/.test(line);
    const body = isBullet ? line.replace(/^[-•*·‣▪]\s+/, "").trim() : line;
    const key = comparableLine(body);
    if (!key) continue;
    if (seen.has(key)) continue;                          // the bullet list already shows this
    if (isDuplicateEntryHeaderLine(body, entry)) continue; // the header already shows this
    seen.add(key);
    if (isBullet) extraBullets.push(body);
    else paragraphs.push(body);
  }

  return { paragraphs: paragraphs.join("\n\n"), extraBullets };
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

function normalizeHeaderComparable(value) {
  return collapseWhitespace(stripTagsToText(value || ""))
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[|,;:()[\]{}]/g, " ")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

// CHANGE 5: added date+meta check to catch the LLM's duplicate plain <div>
// that contains the date and location after entry-role (e.g. "Jul 2025 – Present\n\nBentonville, AR")
function isDuplicateEntryHeaderLine(line, entry) {
  const text = normalizeHeaderComparable(line);
  if (!text) return false;
  const company = normalizeHeaderComparable(entry.company);
  const meta = normalizeHeaderComparable(entry.meta);
  const role = normalizeHeaderComparable(entry.role);
  const date = normalizeHeaderComparable(entry.date);
  const headerParts = [company, meta, role, date].filter(Boolean);
  if (!headerParts.length) return false;
  const headerText = normalizeHeaderComparable(headerParts.join(" "));
  const compactText = text.replace(/\s+/g, "");
  const compactHeader = headerText.replace(/\s+/g, "");
  if (compactHeader && compactText === compactHeader) return true;

  // A line that IS one of the header's own fields, exactly (AG4). The date-based rules below all
  // require entry.date, and the model frequently leaves entry-date empty and folds the dates into
  // the meta instead — "Technical Assistant | Jul 2016 - Present". That line then matched nothing
  // and rendered a second time, in italics, directly beneath the header that already showed it.
  // An exact match against a field the header renders is an echo by definition, not prose.
  for (const part of headerParts) {
    if (compactText === part.replace(/\s+/g, "")) return true;
  }
  // The same fields written back as one line, in the two orders a model actually writes them.
  if (role && meta && (
    compactText === normalizeHeaderComparable(`${role} ${meta}`).replace(/\s+/g, "") ||
    compactText === normalizeHeaderComparable(`${meta} ${role}`).replace(/\s+/g, "")
  )) return true;
  if (company && meta && compactText === normalizeHeaderComparable(`${company} ${meta}`).replace(/\s+/g, "")) return true;
  if (date && text.includes(date) && (role && text.includes(role))) return true;
  if (date && text.includes(date) && (company && text.includes(company))) return true;
  if (date && meta && text.includes(date) && text.includes(meta)) return true;
  if (role && date && text === normalizeHeaderComparable(`${role} ${date}`)) return true;
  return false;
}

function cleanEntryHeaderDupes(entry) {
  const cleaned = {
    ...entry,
    bullets: [...(entry.bullets || [])],
  };
  while (cleaned.bullets.length && isDuplicateEntryHeaderLine(cleaned.bullets[0], cleaned)) {
    cleaned.bullets.shift();
  }
  if (cleaned.text && isDuplicateEntryHeaderLine(cleaned.text, cleaned)) {
    cleaned.text = "";
  }
  return cleaned;
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
        entries: mergeEntryFragments((section.entries || []).map(entry => cleanEntryHeaderDupes({
          company: collapseWhitespace(entry.company || ""),
          meta: collapseWhitespace(entry.meta || ""),
          date: collapseWhitespace(entry.date || ""),
          role: collapseWhitespace(entry.role || ""),
          tech: collapseWhitespace(entry.tech || ""),
          text: collapseWhitespace(entry.text || ""),
          bullets: (entry.bullets || []).map(bullet => collapseWhitespace(bullet)).filter(Boolean),
        })).filter(entry => entry.company || entry.role || entry.date || entry.text || entry.bullets.length))
          .map(cleanEntryHeaderDupes),
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

// CHANGE 6: broadened looksHtml to catch LLM output that uses <ul>, <li>,
// <span>, <strong>, or <table> without a <div>, <p>, <body>, or <html> wrapper
export function buildStructuredResume(raw) {
  const normalized = collapseWhitespace(String(raw || ""));
  if (!normalized) return { header: { name: "", tagline: "", contact: "" }, sections: [] };
  const looksHtml = /<html[\s>]|<body[\s>]|<div[\s>]|<p[\s>]|<section[\s>]|<ul[\s>]|<li[\s>]|<span[\s>]|<strong[\s>]|<table[\s>]/i.test(normalized);
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

// CHANGE 7: skills section now renders as a bullet list instead of a table
// for better ATS compatibility and to match the Twilio format
function renderSection(section) {
  if (section.type === "summary") {
    return `<div class="section-title">${section.title}</div>
<div>${renderInlineRichText(section.text)}</div>`;
  }
  if (section.type === "skills") {
    return `<div class="section-title">${section.title}</div>
<ul class="bullets">
${section.rows.map(row => `  <li>${row.label ? `<strong>${renderInlineRichText(row.label)}</strong> ` : ""}${renderInlineRichText(row.values)}</li>`).join("\n")}
</ul>`;
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