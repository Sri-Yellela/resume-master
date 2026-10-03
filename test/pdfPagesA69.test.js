// A69 (owner, 10-03): the PDF tools are Resume Master's own product, so each one has its own page —
// findable by what people search for ("merge pdf", "compress pdf") — and the hub links them all.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createApp } from "../src/http/app.js";
import { PDF_PAGES, ORIGIN } from "../scripts/site/buildSite.mjs";
import { TOOLS } from "../src/pdf-toolkit/ui.js";

async function serve() {
  const app = createApp({ log: () => {} });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test("every tool has a page: served, titled, canonical, and mounting THAT tool", async () => {
  const ids = new Set(TOOLS.map(t => t.id));
  assert.equal(PDF_PAGES.length, TOOLS.length, "a page per tool, no more and no fewer");
  const s = await serve();
  try {
    for (const p of PDF_PAGES) {
      assert.ok(ids.has(p.tool), `${p.slug} names a real tool`);
      const r = await fetch(`${s.base}/pdf/${p.slug}/`);
      assert.equal(r.status, 200, p.slug);
      const html = await r.text();
      assert.match(html, new RegExp(`<title>${p.h1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — free, in your browser`));
      assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}/pdf/${p.slug}/">`), p.slug);
      assert.ok(html.includes(`data-initial="${p.tool}"`), `${p.slug} opens on its own tool`);
      assert.match(html, /<meta name="description" content="[^"]{40,}">/);
    }
    const bare = await fetch(`${s.base}/pdf/merge-pdf`, { redirect: "manual" });
    assert.equal(bare.status, 301, "no trailing slash → the page, not a 404");
  } finally { await s.close(); }
});

test("the hub links every page; the sitemap lists every page; robots keeps crawlers out of the API", async () => {
  const s = await serve();
  try {
    const hub = await (await fetch(`${s.base}/pdf/`)).text();
    const sitemap = await (await fetch(`${s.base}/sitemap.xml`)).text();
    for (const p of PDF_PAGES) {
      assert.ok(hub.includes(`href="/pdf/${p.slug}/"`), `hub → ${p.slug}`);
      assert.ok(sitemap.includes(`<loc>${ORIGIN}/pdf/${p.slug}/</loc>`), `sitemap → ${p.slug}`);
    }
    const robots = await (await fetch(`${s.base}/robots.txt`)).text();
    assert.match(robots, /^Disallow: \/v1\/$/m);
    assert.match(robots, /^Sitemap: https:\/\/resumemaster\.one\/sitemap\.xml$/m);
  } finally { await s.close(); }
});

test("everything is offered: Word, Excel, OCR and Maximum compress, and no 'do not do' list (owner, 10-03)", () => {
  const slugs = PDF_PAGES.map(p => p.slug);
  for (const s of ["pdf-to-word", "pdf-to-excel", "ocr-pdf"]) assert.ok(slugs.includes(s), s);
  const ui = fs.readFileSync("src/pdf-toolkit/ui.js", "utf8");
  assert.match(ui, /value: "flatten"/, "Compress offers Maximum");
  assert.doesNotMatch(ui + fs.readFileSync("public/pdf/index.html", "utf8"), /do not do|not offered/i);
  const loader = fs.readFileSync("public/pdf-tools.js", "utf8");
  assert.match(loader, /zipSync, loadOcr/, "the page hands the component the Office and OCR libraries");
});

test("the product stands alone: no page or script depends on draft", () => {
  for (const f of ["public/pdf-tools.js", "src/pdf-toolkit/ui.js", "src/pdf-toolkit/core.js", "public/pdf/index.html"]) {
    assert.doesNotMatch(fs.readFileSync(f, "utf8"), /@draft\/|jobsviadraft|draft mounts/i, f);
  }
});
