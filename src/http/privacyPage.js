// A83 (agent-raised 10-04): the privacy page is rendered HERE, on the server, from docs/PRIVACY.md.
//
// It used to be rendered in the browser: public/privacy.html said "Loading…" until a script fetched
// /v1/site/privacy, so a reader without JavaScript — an app-directory reviewer reading the URL, a
// crawler — saw no policy at all. And that script made one paragraph per LINE, so every hard-wrapped
// paragraph and bullet in the document came out broken into fragments.
//
// Now GET /privacy.html is public/privacy.html (the shared chrome and the page's frame) with the
// rendered document written between its <!-- privacy:body --> markers, on every request — so the page
// still cannot say something the document does not. Blocks follow ordinary Markdown: a paragraph is a
// run of non-blank lines joined into one; a bullet continues onto its following lines until a blank line
// or the next bullet; a table is a run of `|` rows. Only what docs/PRIVACY.md uses is supported.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PRIVACY_MD = path.join(ROOT, "docs", "PRIVACY.md");
export const PRIVACY_TEMPLATE = path.join(ROOT, "public", "privacy.html");
const MARKERS = /(<!-- privacy:body -->)[\s\S]*?(<!-- \/privacy:body -->)/;

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/\*([^*\s][^*]*)\*/g, "<em>$1</em>")
  .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => (/^(https?:|mailto:|\/)/.test(u) ? `<a href="${u}">${t}</a>` : t));

/** docs/PRIVACY.md → HTML. Wrapped lines are joined; never one paragraph per line. */
export function renderPrivacyMarkdown(md) {
  const out = [];
  let para = null, list = null, table = null;
  const flush = () => {
    if (para) { out.push(`<p>${inline(para.join(" "))}</p>`); para = null; }
    if (list) { out.push(`<ul>${list.map(li => `<li>${inline(li.join(" "))}</li>`).join("")}</ul>`); list = null; }
    if (table) { out.push(`<table class="ledger">${table.join("")}</table>`); table = null; }
  };
  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flush(); continue; }
    if (/^\|/.test(line)) {
      if (!table) flush();
      if (/^\|[\s|:-]+\|$/.test(line)) continue;                   // the header rule
      table = table || [];
      const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => inline(c.trim()));
      const tag = table.length === 0 ? "th" : "td";
      table.push(`<tr>${cells.map(c => `<${tag}>${c}</${tag}>`).join("")}</tr>`);
      continue;
    }
    const h = line.match(/^(#{1,3}) (.*)$/);
    if (h) { flush(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    const item = line.match(/^[-*] (.*)$/);
    if (item) {
      if (!list) flush();
      list = list || [];
      list.push([item[1].trim()]);
      continue;
    }
    if (list) { list[list.length - 1].push(line.trim()); continue; }   // a wrapped bullet
    if (table) flush();
    para = para || [];
    para.push(line.trim());                                           // a wrapped paragraph
  }
  flush();
  return out.join("\n");
}

/** The whole page: the template's frame with the rendered document between its markers. */
export function renderPrivacyPage({ md = fs.readFileSync(PRIVACY_MD, "utf8"),
                                    template = fs.readFileSync(PRIVACY_TEMPLATE, "utf8") } = {}) {
  if (!MARKERS.test(template)) throw new Error("public/privacy.html has no <!-- privacy:body --> markers");
  const body = renderPrivacyMarkdown(md);
  return template.replace(MARKERS, (_m, open, close) => `${open}\n${body}\n${close}`);
}
