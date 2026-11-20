// A69 (owner, 10-03): the PDF tools are Resume Master's own product, so each one has its own page —
// findable by what people search for ("merge pdf", "compress pdf") — and the hub links them all.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createApp } from "../src/http/app.js";
import { PDF_PAGES, ORIGIN, WORKSPACE_MODE } from "../scripts/site/buildSite.mjs";

async function serve() {
  const app = createApp({ log: () => {} });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test("every tool has a page: served, titled, canonical, and mounting THAT tool", async () => {
  // moved on purpose (rm-audit M14 / M15, 46y): the 16-tab toolkit is retired; every page opens the workspace with its tool
  assert.equal(PDF_PAGES.length, 16, "the sixteen tool pages the sitemap lists");
  assert.deepEqual(PDF_PAGES.map(p => p.tool).filter(t => !WORKSPACE_MODE[t]), [], "every tool has a workspace mode");
  const s = await serve();
  try {
    for (const p of PDF_PAGES) {
      const r = await fetch(`${s.base}/pdf/${p.slug}/`);
      assert.equal(r.status, 200, p.slug);
      const html = await r.text();
      assert.match(html, new RegExp(`<title>${p.h1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — free, in your browser`));
      assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}/pdf/${p.slug}/">`), p.slug);
      // D189 P4 changed this on purpose: a tool the workspace carries opens the WORKSPACE with that tool on (a landing page);
      // the others still mount their own quick tool
      assert.ok(html.includes(`data-workspace-mode="${WORKSPACE_MODE[p.tool]}"`) && html.includes(`data-tool="${p.tool}"`), `${p.slug} opens the workspace with its tool`);
      assert.ok(!html.includes('id="pdf-tools"') && !html.includes("/pdf-tools.js"), `${p.slug}: no old toolkit`);
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
  // moved on purpose (46y): the workspace carries them — Compress's smallest (every page a picture) is offered when the
  // file is still over the limit; Excel and OCR are Convert tools
  const ws = fs.readFileSync("public/workspace/workspace.js", "utf8");
  assert.match(ws, /render\.flattenToImages\(lib, pdfjs, b/, "Compress offers the smallest file");
  assert.match(ws, /\["excel", "▦", "Excel"\]/); assert.match(ws, /\["searchable", "⌕", "Searchable \(OCR\)"\]/);
  assert.doesNotMatch(ws + fs.readFileSync("public/pdf/index.html", "utf8"), /do not do|not offered/i);
});

test("the product stands alone: no page or script depends on draft", () => {
  for (const f of ["public/workspace/workspace.js", "src/pdf-toolkit/html.js", "src/pdf-toolkit/core.js", "public/pdf/index.html"]) {
    assert.doesNotMatch(fs.readFileSync(f, "utf8"), /@draft\/|jobsviadraft|draft mounts/i, f);
  }
});
