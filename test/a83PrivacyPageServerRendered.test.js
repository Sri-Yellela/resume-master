// A83 (agent-raised 10-04): the privacy page was rendered in the browser — "Loading…" until a script
// fetched the document, so a no-JS reader (an app-directory review reads the URL) saw no policy — and
// that script made one paragraph per LINE, so every hard-wrapped paragraph and bullet came out broken.
// It is now rendered on the server, from docs/PRIVACY.md, on every request.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createApp } from "../src/http/app.js";
import { renderPrivacyMarkdown, renderPrivacyPage } from "../src/http/privacyPage.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";

loadAllPrompts();

const MD = fs.readFileSync("docs/PRIVACY.md", "utf8");
const text = (html) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

async function serve() {
  const app = createApp({ version: { version: "test" }, log: () => {} });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test("⛔ GET /privacy.html carries the WHOLE policy in its HTML — no script needed, no 'Loading…'", async () => {
  const s = await serve();
  try {
    for (const p of ["/privacy.html", "/privacy"]) {
      const r = await fetch(s.base + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get("content-type"), /^text\/html/);
      const html = await r.text();
      assert.doesNotMatch(html, /Loading…/);
      assert.doesNotMatch(html, /fetch\("\/v1\/site\/privacy"\)/, "nothing renders it in the browser");
      for (const h of MD.match(/^#{1,3} .+$/gm)) {
        const title = h.replace(/^#+ /, "").replace(/[*`]/g, "").trim();
        assert.ok(text(html).includes(title), `${p}: the heading "${title}" is in the served HTML`);
      }
      assert.match(html, /<!-- chrome:nav -->/, "inside the site's shared frame");
      assert.match(html, /privacy@jobsviadraft\.com/);
    }
  } finally { await s.close(); }
});

test("⛔ hard-wrapped lines are JOINED: every paragraph of the document is ONE <p>, every bullet ONE <li>", () => {
  const html = renderPrivacyMarkdown(MD);
  // Every paragraph block in the source (a run of non-blank, non-table, non-heading, non-bullet lines).
  const blocks = MD.replace(/\r\n/g, "\n").split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
    .filter(b => !/^(#|\||- )/.test(b));
  const paras = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => text(m[1]));
  for (const b of blocks) {
    const want = text(b.replace(/\*\*|`/g, "").replace(/\*([^*]+)\*/g, "$1").replace(/\n\s*/g, " "));
    assert.ok(paras.includes(want), `one paragraph: "${want.slice(0, 70)}…"`);
  }
  const wrappedBullet = MD.replace(/\r\n/g, "\n").match(/^- \*\*No content is logged\.\*\*[\s\S]*?(?=\n- )/m)[0];
  const li = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => text(m[1]));
  assert.ok(li.includes(text(wrappedBullet.slice(2).replace(/\*\*|`/g, "").replace(/\n\s*/g, " "))), "a wrapped bullet is one item");
  assert.equal(li.length, (MD.match(/^- /gm) || []).length, "one <li> per bullet, not per line");
});

test("the renderer: paragraphs, bullets, tables, headings, inline marks — and escapes the rest", () => {
  const html = renderPrivacyMarkdown([
    "# Title", "", "One line", "and its wrap.", "", "- a bullet", "  that wraps", "- **two**", "",
    "| A | B |", "|---|---|", "| `x` | *y* |", "", "<script>alert(1)</script> [home](/) [bad](javascript:void)",
  ].join("\r\n"));
  assert.equal(html, [
    "<h2>Title</h2>",
    "<p>One line and its wrap.</p>",
    "<ul><li>a bullet that wraps</li><li><strong>two</strong></li></ul>",
    `<table class="ledger"><tr><th>A</th><th>B</th></tr><tr><td><code>x</code></td><td><em>y</em></td></tr></table>`,
    `<p>&lt;script&gt;alert(1)&lt;/script&gt; <a href="/">home</a> bad</p>`,
  ].join("\n"));
});

test("the page cannot drift from the document: it is rendered from docs/PRIVACY.md at request time", () => {
  const page = renderPrivacyPage({ md: "# Sentinel policy\n\nSentinel line one\nsentinel line two." });
  assert.match(page, /<h2>Sentinel policy<\/h2>\n<p>Sentinel line one sentinel line two\.<\/p>/);
  assert.throws(() => renderPrivacyPage({ template: "<html></html>" }), /privacy:body/);
  const tpl = fs.readFileSync("public/privacy.html", "utf8");
  assert.doesNotMatch(tpl, /<script>(?![\s\S]*src=)/, "no inline script renders the policy");
  assert.match(fs.readFileSync("src/http/app.js", "utf8"), /PRIVACY_PATHS = new Set\(\["\/privacy\.html", "\/privacy"\]\)[\s\S]*?renderPrivacyPage\(\)[\s\S]*?app\.use\(express\.static\(PUBLIC_DIR/,
    "the rendered route is registered before the static files, so the bare frame is never what is served");
});
