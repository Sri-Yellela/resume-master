// A68 (owner, 10-03): the old Resume Master look — option C, the last build before the rebrand — with
// a STATIC sky and ONE accent the owner picks. These pin what makes it that look, and the two changes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { staleFiles, NAV, FOOTER, STAMP, PDF_PAGES } from "../scripts/site/buildSite.mjs";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const CSS = read("public/site.css");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const PAGES = ["public/index.html", "public/privacy.html", "public/pdf/index.html", ...PDF_PAGES.map(p => `public/pdf/${p.slug}/index.html`)];

test("the generated parts are current — run node scripts/site/buildSite.mjs", () => {
  assert.deepEqual(staleFiles(), []);
});

test("the white boxed stamp: white box, black 2.5 px border, tilted 2°, Barlow Condensed 800 italic capitals", () => {
  assert.match(STAMP(), /<span class="stamp__box"><span>R<\/span><span class="stamp__fold">esume<\/span><span>M<\/span><span class="stamp__fold">aster<\/span><\/span>/);
  const box = CSS.slice(CSS.indexOf(".stamp__box {"), CSS.indexOf("}", CSS.indexOf(".stamp__box {")));
  for (const rule of [/background: #ffffff/, /border: 2\.5px solid #0f0f0f/, /transform: rotate\(-2deg\)/,
                      /font: italic 800 15px\/1 var\(--font-display\)/, /text-transform: uppercase/]) {
    assert.match(box, rule);
  }
  assert.match(CSS, /\.nav--scrolled \.stamp__fold \{ max-width: 0; opacity: 0; \}/, "it folds to RM on scroll, as the old site's did");
  assert.match(CSS, /--font-display: "Barlow Condensed"/);
  assert.match(CSS, /--font-body: "DM Sans"/);
  assert.match(CSS, /url\("\/fonts\/barlow-condensed-latin-800-italic\.woff2"\)/);
});

test("ONE accent, for the owner to pick: defined once, and the old site's four options are written beside it", () => {
  assert.equal((CSS.match(/^\s*--accent:/gm) || []).length, 1);
  for (const hex of ["#A8D8EA", "#F0EF8A", "#88C87A", "#FFB07A"]) assert.ok(CSS.includes(hex), `${hex} is listed`);
  assert.doesNotMatch(CSS, /--star\b/, "the A54 accent is gone, not kept beside the new one");
});

test("⛔ the sky is STATIC and local: no video anywhere, one generated image", () => {
  for (const f of walk("public")) {
    if (/\.(mp4|webm|mov)$/i.test(f)) assert.fail(`${f}: no video`);
    if (/\.(html|css|js)$/.test(f)) assert.doesNotMatch(read(f), /<video|\.mp4|\.webm|cloudfront/i, f);
  }
  assert.match(CSS, /url\("\/sky\.svg"\)/);
  assert.match(read("public/sky.svg"), /^<svg[^>]+>.*<circle/s);
});

test("every page carries the same header and footer — one definition, no drift", () => {
  for (const p of PAGES) {
    const html = read(p);
    assert.ok(html.includes(NAV), `${p}: the shared header`);
    assert.ok(html.includes(FOOTER), `${p}: the shared footer`);
    assert.match(html, /<script src="\/chrome\.js" defer><\/script>/, p);
  }
});
