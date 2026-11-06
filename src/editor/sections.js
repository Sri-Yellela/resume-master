// ── D157 (draft) · the résumé as SECTIONS — one model for the editor, the server and draft ─────────────────────────
//
// The owner (11-05): "identified sections, which can then be edited individually … swapped off their places".
// A résumé is a list of sections — name and contact (locked at the top), then summary, skills, experience, … — each
// its own block of HTML under its printed heading, plus the few document options the editor changes (font, size,
// line spacing, margins).
//
// THE HTML CARRIES THE SECTIONS. `htmlFromSections` writes each section as
//   <section class="rm-sec" data-rm-section="<id>" data-rm-kind="<kind>" data-rm-title="<menu name>">…</section>
// and the options as <body data-rm-style="{json}">, so a document that went through the editor reads back into the
// same sections, byte for byte (`sectionsFromHtml`). The document is still the formatter's own markup inside those
// wrappers (class="header", class="section-title", ul.bullets …), so everything that already reads a résumé — the
// formatter, the ATS scorer, PDF export, draft's storage of `html` — keeps working on it unchanged.
// A document that never went through the editor (a generation, a pasted résumé) is split from the formatter's
// markup; anything else is normalised by the formatter first.
//
// Isomorphic: no DOM, no Node API — the editor page imports this same file from /lib/editor/sections.js.
import { RESUME_STYLE_BLOCK, normalizeResumeHtml } from "../formatting/resumeFormatter.js";

/** The message contract between the embedded editor and its host. A host checks it on `ready`. */
export const EDITOR_CONTRACT = "rm-editor/1";

/** ATS-safe families only: each is a system font or has a metric-compatible stand-in. */
export const FONTS = [
  { id: "garamond", label: "Garamond", css: "Garamond, 'EB Garamond', Georgia, serif" },
  { id: "georgia", label: "Georgia", css: "Georgia, 'Times New Roman', serif" },
  { id: "arial", label: "Arial", css: "Arial, Helvetica, sans-serif" },
  { id: "calibri", label: "Calibri", css: "Calibri, Carlito, Arial, sans-serif" },
  { id: "helvetica", label: "Helvetica", css: "Helvetica, Arial, sans-serif" },
];
export const LINE_SPACINGS = { tight: { body: 1.25, bullets: 1.22 }, normal: { body: 1.42, bullets: 1.38 }, airy: { body: 1.6, bullets: 1.55 } };
export const MARGINS = { narrow: { x: "0.4in", y: "0.32in" }, normal: { x: "0.55in", y: "0.45in" }, wide: { x: "0.75in", y: "0.6in" } };
export const SIZE = { min: 7.5, max: 12, step: 0.5, base: 8.5 };
/** The options a document starts with: null = the formatter's own value. */
export const DEFAULT_STYLE = Object.freeze({ font: null, sizePt: null, spacing: "normal", margin: "normal" });

const KIND_BY_HEADING = new Map([
  ["SUMMARY", "summary"], ["PROFESSIONAL SUMMARY", "summary"], ["PROFILE", "summary"],
  ["TECHNICAL SKILLS", "skills"], ["SKILLS", "skills"], ["CORE COMPETENCIES", "skills"],
  ["EXPERIENCE", "experience"], ["WORK EXPERIENCE", "experience"], ["PROFESSIONAL EXPERIENCE", "experience"],
  ["PROJECTS", "projects"], ["ACADEMIC PROJECTS", "projects"], ["PERSONAL PROJECTS", "projects"],
  ["EDUCATION", "education"], ["CERTIFICATIONS", "certifications"], ["LICENSES AND CERTIFICATIONS", "certifications"],
  ["AWARDS", "awards"], ["HONORS AND AWARDS", "awards"], ["VOLUNTEERING", "volunteering"], ["VOLUNTEER EXPERIENCE", "volunteering"],
  ["LANGUAGES", "languages"], ["PUBLICATIONS", "publications"],
]);
const NAME_BY_KIND = { summary: "Summary", skills: "Skills", experience: "Experience", projects: "Projects", education: "Education",
  certifications: "Certifications", awards: "Awards", volunteering: "Volunteering", languages: "Languages", publications: "Publications" };

/** The sections a person can add, with the heading printed and a starting line to replace. */
export const ADDABLE = [
  { kind: "certifications", heading: "CERTIFICATIONS", html: "<ul class=\"bullets\">\n  <li>Certification name, issuer, year</li>\n</ul>" },
  { kind: "projects", heading: "PROJECTS", html: "<div class=\"entry\">\n  <div class=\"entry-header\"><div><span class=\"entry-org\">Project name</span></div><div class=\"entry-date\">Year</div></div>\n  <ul class=\"bullets\">\n  <li>What you built and what it did</li>\n</ul>\n</div>" },
  { kind: "awards", heading: "AWARDS", html: "<ul class=\"bullets\">\n  <li>Award, who gave it, year</li>\n</ul>" },
  { kind: "volunteering", heading: "VOLUNTEERING", html: "<ul class=\"bullets\">\n  <li>Role, organisation, year</li>\n</ul>" },
  { kind: "languages", heading: "LANGUAGES", html: "<div>Language (level)</div>" },
  { kind: "other", heading: "ADDITIONAL", html: "<div>Anything else worth knowing</div>" },
];

export function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function unescapeAttr(value) {
  return String(value ?? "").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function textOf(html) {
  return unescapeAttr(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function kindOfHeading(heading) {
  const key = String(heading || "").replace(/\s*[:：]\s*$/, "").replace(/\s+/g, " ").trim().toUpperCase();
  return KIND_BY_HEADING.get(key) || "other";
}
export function nameOfHeading(heading, kind = kindOfHeading(heading)) {
  if (NAME_BY_KIND[kind] && kind !== "projects") return NAME_BY_KIND[kind];
  const t = String(heading || "").replace(/\s*[:：]\s*$/, "").trim().toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : "Section";
}

/**
 * A section's HTML is the résumé's own markup, edited in a browser. It never carries anything that runs or fetches:
 * scripts, frames, embeds, forms, styles, event handlers and javascript: / data: links are dropped (the editor page's
 * Content-Security-Policy refuses inline script as well — this is the document's own guarantee, wherever it goes).
 * A nested <section> becomes a <div> so the wrappers stay one level deep.
 */
export function sanitizeFragment(html) {
  return String(html || "")
    .replace(/<(script|style|iframe|object|embed|template|noscript|textarea|select|button|form)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(script|style|iframe|object|embed|link|meta|base|form|input|button|select|textarea|template|noscript|html|head|body)\b[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(href|src|xlink:href|action|formaction)\s*=\s*("\s*(?:javascript|vbscript|data):[^"]*"|'\s*(?:javascript|vbscript|data):[^']*'|(?:javascript|vbscript|data):[^\s>]*)/gi, "")
    .replace(/\s+(contenteditable|spellcheck|data-rm-[a-z-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/<section\b/gi, "<div").replace(/<\/section\s*>/gi, "</div>")
    .trim();
}

function bodyOf(html) {
  const m = String(html || "").match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
  return m ? { attrs: m[1], inner: m[2] } : { attrs: "", inner: String(html || "") };
}

/** The end index (exclusive) of the element whose opening tag starts at `start` — div nesting only. */
function elementEnd(html, start) {
  const re = /<(\/?)div\b[^>]*>/gi;
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return re.lastIndex;
  }
  return html.length;
}

function readStyle(bodyAttrs) {
  const m = String(bodyAttrs || "").match(/\sdata-rm-style\s*=\s*"([^"]*)"/i);
  if (!m) return { ...DEFAULT_STYLE };
  try { return normalizeStyle(JSON.parse(unescapeAttr(m[1]))); } catch { return { ...DEFAULT_STYLE }; }
}

export function normalizeStyle(style = {}) {
  const font = FONTS.some(f => f.id === style.font) ? style.font : null;
  const n = Number(style.sizePt);
  const sizePt = Number.isFinite(n) && style.sizePt != null ? Math.min(SIZE.max, Math.max(SIZE.min, Math.round(n / SIZE.step) * SIZE.step)) : null;
  const spacing = LINE_SPACINGS[style.spacing] ? style.spacing : "normal";
  const margin = MARGINS[style.margin] ? style.margin : "normal";
  return { font, sizePt, spacing, margin };
}

function uniqueId(kind, taken) {
  let id = kind, i = 2;
  while (taken.has(id)) id = `${kind}-${i++}`;
  taken.add(id);
  return id;
}

/**
 * html → { contract, style, sections: [{ id, kind, title, heading, locked, html }] }.
 * `heading` is the section's printed title (as written); `title` is its name in the section menu.
 */
export function sectionsFromHtml(html) {
  const source = String(html || "");
  const { attrs, inner } = bodyOf(source);
  const style = readStyle(attrs);
  const taken = new Set();

  // A document the editor wrote: read its wrappers back exactly.
  if (/data-rm-section\s*=/.test(inner)) {
    const sections = [];
    const re = /<section\b([^>]*\bdata-rm-section\s*=[^>]*)>([\s\S]*?)<\/section\s*>/gi;
    let m;
    while ((m = re.exec(inner))) {
      const a = m[1];
      const attr = (name) => unescapeAttr((a.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i")) || [])[1] || "");
      const kind = attr("data-rm-kind") || "other";
      let body = m[2];
      if (kind === "header") {
        sections.push({ id: uniqueId("head", taken), kind: "header", title: "Name and contact", heading: "", locked: true, html: sanitizeFragment(body) });
        continue;
      }
      let heading = "";
      const h = body.match(/^\s*<div\b[^>]*class\s*=\s*"[^"]*\bsection-title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      if (h) { heading = textOf(h[1]); body = body.slice(h[0].length); }
      const id = uniqueId(attr("data-rm-section") || kind, taken);
      sections.push({ id, kind, title: attr("data-rm-title") || nameOfHeading(heading, kind), heading, locked: false, html: sanitizeFragment(body) });
    }
    return { contract: EDITOR_CONTRACT, style, sections: lockHeaderFirst(sections) };
  }

  // Anything else: the formatter's markup — normalised first when it isn't already.
  let body = inner;
  if (!/class\s*=\s*"[^"]*\bsection-title\b/i.test(body)) body = bodyOf(normalizeResumeHtml(source)).inner;
  body = body.replace(/<!--[\s\S]*?-->/g, "");
  const sections = [];
  const headerAt = body.search(/<div\b[^>]*class\s*=\s*"[^"]*\bheader\b[^"]*"/i);
  const firstTitle = body.search(/<div\b[^>]*class\s*=\s*"[^"]*\bsection-title\b[^"]*"/i);
  if (headerAt !== -1 && (firstTitle === -1 || headerAt < firstTitle)) {
    const end = elementEnd(body, headerAt);
    sections.push({ id: uniqueId("head", taken), kind: "header", title: "Name and contact", heading: "", locked: true, html: sanitizeFragment(body.slice(headerAt, end)) });
  }
  const titleRe = /<div\b[^>]*class\s*=\s*"[^"]*\bsection-title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  const marks = [];
  let t;
  while ((t = titleRe.exec(body))) marks.push({ start: t.index, end: titleRe.lastIndex, heading: textOf(t[1]) });
  marks.forEach((mk, i) => {
    const content = body.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : body.length);
    const kind = kindOfHeading(mk.heading);
    sections.push({ id: uniqueId(kind, taken), kind, title: nameOfHeading(mk.heading, kind), heading: mk.heading, locked: false, html: sanitizeFragment(content) });
  });
  return { contract: EDITOR_CONTRACT, style, sections: lockHeaderFirst(sections) };
}

/** Name and contact stay at the top, whatever order arrives. */
function lockHeaderFirst(sections) {
  const head = sections.filter(s => s.kind === "header");
  return [...head.slice(0, 1).map(s => ({ ...s, locked: true })), ...sections.filter(s => s.kind !== "header")];
}

/** The document options as CSS over the formatter's own variables — appended after its style block. */
export function styleCss(style) {
  const s = normalizeStyle(style);
  const font = FONTS.find(f => f.id === s.font);
  const sp = LINE_SPACINGS[s.spacing], mg = MARGINS[s.margin];
  const vars = [
    s.sizePt != null ? `--fs-body: ${s.sizePt}pt; --fs-name: ${(s.sizePt + 0.5).toFixed(1)}pt; --fs-section: ${(s.sizePt - 0.5).toFixed(1)}pt;` : "",
    `--lh-body: ${sp.body}; --lh-bullets: ${sp.bullets};`,
    `--margin-x: ${mg.x}; --margin-top: ${mg.y}; --margin-bot: ${mg.y};`,
  ].join(" ");
  return `:root { ${vars} }${font ? `\nbody { font-family: ${font.css}; }` : ""}`;
}

/** { style, sections } → the full résumé document. Name and contact first; every section in its wrapper. */
export function htmlFromSections(doc) {
  const style = normalizeStyle(doc?.style || {});
  const sections = lockHeaderFirst((doc?.sections || []).filter(Boolean));
  const taken = new Set();
  const parts = sections.map(s => {
    const kind = s.kind === "header" ? "header" : (s.kind || "other");
    const id = uniqueId(kind === "header" ? "head" : (s.id || kind), taken);
    const html = sanitizeFragment(s.html);
    if (kind === "header") return `<section class="rm-sec" data-rm-section="${escapeHtml(id)}" data-rm-kind="header">\n${html}\n</section>`;
    const heading = String(s.heading || s.title || "").replace(/\s+/g, " ").trim();
    return `<section class="rm-sec" data-rm-section="${escapeHtml(id)}" data-rm-kind="${escapeHtml(kind)}" data-rm-title="${escapeHtml(s.title || nameOfHeading(heading, kind))}">\n<div class="section-title">${escapeHtml(heading)}</div>\n${html}\n</section>`;
  });
  return `<html><head><meta charset="utf-8">${RESUME_STYLE_BLOCK}<style data-rm-style>${styleCss(style)}</style></head><body data-rm-style="${escapeHtml(JSON.stringify(style))}">
${parts.join("\n")}
<!-- Save and submit as PDF (print to PDF from browser). Do not submit as image PDF, Google Docs link, or scanned document. -->
</body></html>`;
}

/** Move one section by `delta` places; the locked header never moves and nothing moves above it. */
export function moveSection(doc, id, delta) {
  const list = [...doc.sections];
  const i = list.findIndex(s => s.id === id);
  if (i < 0 || list[i].locked) return doc;
  const floor = list.findIndex(s => !s.locked);
  const j = Math.max(floor < 0 ? 0 : floor, Math.min(list.length - 1, i + delta));
  if (j === i) return doc;
  const [it] = list.splice(i, 1);
  list.splice(j, 0, it);
  return { ...doc, sections: list };
}

/** Put `id` where `beforeId` is (drag and drop). */
export function placeSection(doc, id, beforeId) {
  const list = [...doc.sections];
  const from = list.findIndex(s => s.id === id), to = list.findIndex(s => s.id === beforeId);
  if (from < 0 || to < 0 || from === to || list[from].locked || list[to].locked) return doc;
  const [it] = list.splice(from, 1);
  list.splice(to, 0, it);
  return { ...doc, sections: list };
}

export function addSection(doc, kind) {
  const spec = ADDABLE.find(a => a.kind === kind) || ADDABLE[ADDABLE.length - 1];
  const taken = new Set(doc.sections.map(s => s.id));
  const id = uniqueId(spec.kind, taken);
  return { doc: { ...doc, sections: [...doc.sections, { id, kind: spec.kind, title: nameOfHeading(spec.heading, spec.kind), heading: spec.heading, locked: false, html: spec.html }] }, id };
}

export function removeSection(doc, id) {
  return { ...doc, sections: doc.sections.filter(s => s.id !== id || s.locked) };
}

/**
 * The paper's stylesheet: the formatter's own style block, scoped to `.rm-doc` so it styles the page inside the editor
 * (and nothing of the editor itself). The body's margins become the page's padding — the page is the sheet of paper.
 */
export function paperCss(style) {
  const scope = (css) => css
    .replace(/<\/?style[^>]*>/gi, "")
    .replace(/:root\s*\{/g, ".rm-doc {")
    .replace(/(^|[}\s])body\s*\{([^}]*)\}/g, (_m, pre, decl) => `${pre}.rm-doc {${decl.replace(/\bmargin\s*:/g, "padding:").replace(/max-width\s*:[^;]*;?/g, "")}}`);
  return `${scope(RESUME_STYLE_BLOCK)}\n${scope(`<style>${styleCss(style)}</style>`)}`;
}

/** The host origins allowed to embed the editor and talk to it. */
export const HOST_ORIGINS = [
  /^https:\/\/(?:[a-z0-9-]+\.)?jobsviadraft\.com$/,
  /^https:\/\/[a-z0-9-]+\.up\.railway\.app$/,
  /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/,
];
export function isAllowedHost(origin) {
  return typeof origin === "string" && HOST_ORIGINS.some(re => re.test(origin));
}

/** The theme tokens a host may send, and the value shapes accepted for each (never a `;`, `}` or url()). */
export const THEME_TOKENS = ["bg", "card", "raise", "raise2", "line", "ink", "body", "muted", "accent", "accent2", "onAccent", "font", "radius"];
const COLOUR = /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\([0-9a-z.,%\s/#()-]*\)|[a-z]{3,20})$/i;
const FONT = /^[a-z0-9 ,'"-]{1,160}$/i;
const LENGTH = /^\d{1,3}(?:\.\d+)?(?:px|rem|em)$/;
export function cleanTheme(tokens = {}) {
  const out = {};
  for (const k of THEME_TOKENS) {
    const v = String(tokens?.[k] ?? "").trim();
    if (!v || /url\(|[;{}<>\\]/i.test(v)) continue;
    if (k === "font" ? FONT.test(v) : k === "radius" ? LENGTH.test(v) : COLOUR.test(v)) out[k] = v;
  }
  return out;
}
