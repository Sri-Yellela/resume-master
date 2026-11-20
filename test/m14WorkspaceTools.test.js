// ⭐ rm-audit M14 / M15 / M8 / M9 / M21 (draft D192, owner 11-19 "approving all open items"): the six tools only the old 16-tab
// toolkit had — Split, Watermark, Unlock, JPG → PDF, PDF → Excel, HTML → PDF — are in the ONE workspace; their pages are
// landing pages like the other ten; the toolkit's UI, the home page's PDF tab and its "Everything here" cards are retired;
// no route the sitemap lists 404s. Tool options sit in the properties panel — no native prompt() (M11 (b)).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PDF_PAGES, WORKSPACE_MODE, renderSitemap } from "../scripts/site/buildSite.mjs";
import { createApp } from "../src/http/app.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const WS = read("public/workspace/workspace.js");

test("m14 · the six old-toolkit tools are workspace tools", () => {
  assert.match(WS, /\["split", "✂", "Split"\]\]/, "Pages → Split");
  assert.match(WS, /\["watermark", "◪", "Watermark"\]\]/, "Annotate → Watermark");
  assert.match(WS, /\["excel", "▦", "Excel"\]/, "Convert → Excel");
  assert.match(WS, /\["fromimages", "▣→", "From pictures"\], \["fromhtml", "<\/>", "From HTML"\]/, "Convert → start from pictures / HTML");
  assert.match(WS, /const STARTERS = new Set\(\["fromword", "fromimages", "fromhtml"\]\);/, "the starters work with nothing open");
  assert.match(WS, /const parts = await core\.split\(lib, await currentBytes\(\), v\.ranges\.trim\(\) \|\| "each"\);/);
  assert.match(WS, /const b = await core\.watermark\(lib, await currentBytes\(\), v\.text\);/);
  assert.match(WS, /office\.toXlsx\(zipSync, sheets\)/);
  assert.match(WS, /const bytes = await core\.imagesToPdf\(lib, images\);/);
  assert.match(WS, /const \{ htmlForPrint, HTML_SANDBOX \} = await import\("\/lib\/pdf-toolkit\/html\.js"\);/);
  // Unlock is a step: a locked PDF asks for its password where it was dropped
  assert.match(WS, /if \(\/password-protected\/i\.test\(e\?\.message \|\| ""\)\) return askPassword\(bytes, fileName, \{ id, openMode \}\);/);
  assert.match(WS, /const open = await core\.unlock\(lib, bytes, pw\.value\);/);
});

test("m11 (b) · tool options in the properties panel — no prompt(); Compress offers the smallest file here (m11 (c))", () => {
  assert.doesNotMatch(WS, /\bprompt\(["'`]/, "no native prompt() call");
  assert.match(read("public/workspace/index.html"), /<section class="ws-panel ws-opts" id="ws-opts" hidden><\/section>/);
  assert.match(WS, /function showOpts\(title, lede, fields, action, run\)/);
  assert.doesNotMatch(WS, /PDF tools page at Maximum/, "no longer sends people to the retired toolkit");
  assert.match(WS, /"Make it smallest", \(\) => convert\("compress", \{ limit, flatten: true \}\)/);
});

test("m14 · every tool page is a workspace landing page; the starters' pages take pictures / HTML and open the tool", () => {
  assert.equal(PDF_PAGES.length, 16);
  for (const p of PDF_PAGES) {
    const html = read(`public/pdf/${p.slug}/index.html`);
    assert.ok(WORKSPACE_MODE[p.tool], p.slug);
    assert.match(html, new RegExp(`data-tool="${p.tool}" data-workspace-mode="${WORKSPACE_MODE[p.tool]}"`), p.slug);
  }
  assert.match(read("public/pdf/jpg-to-pdf/index.html"), /accept="image\/jpeg,image\/png,\.jpg,\.jpeg,\.png" multiple hidden/);
  assert.match(read("public/pdf/jpg-to-pdf/index.html"), /href="\/workspace\/\?mode=convert&amp;tool=fromimages"/);
  assert.match(read("public/pdf/html-to-pdf/index.html"), /accept="\.html,\.htm,text\/html" hidden/);
  assert.match(read("public/docs-home.js"), /drop\.dataset\.tool === "images"/);
  assert.match(WS, /if \(core\.sniffImage\(h\.bytes\)\) await openPictures/, "a handed-over picture becomes a PDF");
});

test("m15 / m8 / m9 / m21 · the second PDF UI, the home PDF tab, the Everything cards and the dead code are gone", () => {
  for (const f of ["src/pdf-toolkit/ui.js", "src/pdf-toolkit/textEditor.js", "public/pdf-tools.js", "public/sky.svg"]) assert.ok(!fs.existsSync(f), f);
  const home = read("public/index.html");
  assert.doesNotMatch(home, /data-panel="pdf"|data-tab="pdf"|id="pdf-tools"|class="everything"|card__num/);
  assert.ok(!fs.existsSync("public/site.js"), "site.js (the home tabs, the dead PDF → text handler) is retired with M4 / M21");
  assert.doesNotMatch(read("src/http/siteRoutes.js"), /r\.post\("\/tools\/enhance"/, "the site's enhance route had no caller");
  const st = read("src/pdf-toolkit/styles.css");
  assert.doesNotMatch(st, /\.pt-sb|\.pt-promise|\.pt-panel \{|\.pt-grid/, "the 16-tab UI layer's styles");
  assert.match(st, /\.pt-ed-maker \{/, "the page layer the workspace draws stays");
});

test("no route the sitemap lists 404s", async () => {
  const urls = [...renderSitemap().matchAll(/<loc>https:\/\/resumemaster\.one([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.ok(urls.length >= 19);
  const app = createApp({ log: () => {} });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const u of urls) { const r = await fetch(base + u); assert.equal(r.status, 200, u); await r.arrayBuffer(); }
    for (const f of ["/lib/pdf-toolkit/html.js", "/lib/pdf-toolkit/session.js"]) assert.equal((await fetch(base + f)).status, 200, f);
  } finally { await new Promise(r => { server.close(r); server.closeAllConnections?.(); }); }
});
