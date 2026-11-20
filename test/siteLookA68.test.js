// A68 (owner, 10-03): the old Resume Master look — the stamp, self-hosted fonts, ONE accent. A203 (3) (owner 11-13) moved the
// site onto draft's Dusk; rm-audit M20 (draft D192, owner 11-19 "approving all open items") moved every colour into ONE token
// source, public/tokens.css (draft's four themes), and retired the A68 night sky (M21). These pin what is left of the look.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { staleFiles, NAV, FOOTER, STAMP, PDF_PAGES } from "../scripts/site/buildSite.mjs";
import { THEMES } from "../scripts/site/themes.mjs";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const CSS = read("public/site.css");
const TOKENS = read("public/tokens.css");

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
  // Moved on purpose (M20): the stamp's white and black are the stamp tokens — the brand's own, the same in every theme
  for (const rule of [/background: var\(--stamp-paper\)/, /border: 2\.5px solid var\(--stamp-ink\)/, /transform: rotate\(-2deg\)/,
                      /font: italic 800 15px\/1 var\(--font-stamp\)/, /text-transform: uppercase/]) {
    assert.match(box, rule);
  }
  assert.match(TOKENS, /--stamp-paper: #ffffff;/); assert.match(TOKENS, /--stamp-ink: #0f0f0f;/);
  assert.match(CSS, /\.nav--scrolled \.stamp__fold \{ max-width: 0; opacity: 0; \}/, "it folds to RM on scroll, as the old site's did");
  assert.match(CSS, /--font-stamp: "Barlow Condensed"/);
  assert.match(CSS, /--font-display: "Instrument Serif"/);
  assert.match(TOKENS, /--font: "DM Sans"/);
  assert.match(CSS, /url\("\/fonts\/barlow-condensed-latin-800-italic\.woff2"\)/);
});

test("ONE accent per theme, defined once — in the token source, not in any stylesheet", () => {
  // Moved on purpose (M20): the A68 "one accent the owner picks" is each theme's accent in public/tokens.css
  assert.equal((TOKENS.match(/^\s*--accent:/gm) || []).length, Object.keys(THEMES).length);
  for (const f of ["public/site.css", "public/workspace/workspace.css", "public/editor/editor.css", "public/ats-panel.css", "public/assistant/tiny.css"]) {
    assert.doesNotMatch(read(f), /^\s*--accent:/m, `${f} defines no accent of its own`);
  }
  assert.doesNotMatch(CSS, /--star\b/);
});

test("⛔ no video anywhere; the A68 night sky is retired (M21)", () => {
  for (const f of walk("public")) {
    if (/\.(mp4|webm|mov)$/i.test(f)) assert.fail(`${f}: no video`);
    if (/\.(html|css|js)$/.test(f)) assert.doesNotMatch(read(f), /<video|\.mp4|\.webm|cloudfront/i, f);
  }
  assert.ok(!fs.existsSync("public/sky.svg"), "sky.svg is gone");
  assert.doesNotMatch(CSS.replace(/\/\*[\s\S]*?\*\//g, ""), /sky\.svg|body::before|#00466e/);
});

// ⭐ A203 (3) (owner 11-13) → M20: draft's Dusk is the default theme; depth boxes and no capsules on any control.
test("a203(3) + M20: Dusk dark is the default theme, from draft's values; every control a depth box", () => {
  for (const [k, v] of [["--accent", "#FBD3C4"], ["--bg", "#1B1B1B"], ["--card", "#262626"], ["--raise", "#2E2E2E"], ["--body", "#A3A3A3"]]) {
    assert.match(TOKENS.slice(0, TOKENS.indexOf('[data-theme="dusk-light"]')), new RegExp(`${k}: ${v};`), `${k} is draft's Dusk ${v}`);
  }
  assert.match(CSS, /body \{[^}]*background: var\(--bg\);/, "the flat canvas");
  assert.match(CSS, /\.btn, \.tab, \.nav__menu summary \{\n[^}]*border-radius: 11px;[^}]*box-shadow: var\(--rest\)/);
  assert.match(CSS, /\.pdf-tools \.pt-tab, \.pdf-tools \.pt-btn, \.pdf-tools \.pt-mini \{\n  border-radius: 11px;/);
  assert.match(read("public/editor/editor.html".replace("editor.html", "index.html")), /href="\/tokens\.css"/, "the editor reads the same tokens");
});

test("every page carries the same header and footer — one definition, no drift", () => {
  for (const p of PAGES) {
    const html = read(p);
    assert.ok(html.includes(NAV), `${p}: the shared header`);
    assert.ok(html.includes(FOOTER), `${p}: the shared footer`);
    assert.match(html, /<script src="\/chrome\.js" defer><\/script>/, p);
  }
});
