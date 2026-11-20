// ⭐ rm-audit M20 (draft D192, owner 11-19 "approving all open items") · ONE token source and NO PILLS — the Resume Master
// counterpart of draft's colorLiteralGuard + d181PlainTokensOnly + d60NoPills. The site had four hand-copied Dusk palettes
// (site.css, workspace.css, editor.css, the toolkit's .pt-sb), eight shadowed capsule rules and a near-capsule in the editor
// (radius 13 on 34 px). Now: public/tokens.css (generated from draft's four themes) is the only place a UI colour is written.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { THEMES, renderTokens, renderThemeScript } from "../scripts/site/themes.mjs";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const SHEETS = ["public/site.css", "public/workspace/workspace.css", "public/editor/editor.css", "public/ats-panel.css", "public/assistant/tiny.css"];
const LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi;

test("m20OneTokenSource: draft's four themes, the same keys in each, generated into public/tokens.css", () => {
  assert.deepEqual(Object.keys(THEMES).sort(), ["dusk-dark", "dusk-light", "plain-dark", "plain-light"]);
  const keys = Object.keys(THEMES["dusk-dark"]).sort();
  for (const [n, t] of Object.entries(THEMES)) assert.deepEqual(Object.keys(t).sort(), keys, `${n} has every token`);
  assert.equal(read("public/tokens.css"), renderTokens());
  assert.equal(read("public/theme.js"), renderThemeScript());
  for (const n of ["dusk-light", "plain-dark", "plain-light"]) assert.match(read("public/tokens.css"), new RegExp(`:root\\[data-theme="${n}"\\] \\{`));
  // the rm-editor/1 names draft already sends the embedded editor
  for (const k of ["bg", "card", "raise", "raise2", "line", "ink", "body", "muted", "accent", "accent2", "on-accent"]) assert.ok(keys.includes(k), k);
});

test("m20TokensOnly: no stylesheet writes a colour — every one is a token (the paper and stamp are tokens too)", () => {
  for (const f of SHEETS) {
    const hits = noComments(read(f)).match(LITERAL) || [];
    assert.deepEqual(hits, [], `${f}: ${hits.join(", ")}`);
  }
  // the toolkit's old Edit sandbox: its palette is the site's tokens now, not a fourth Dusk copy
  const st = read("src/pdf-toolkit/styles.css");
  const sb = st.slice(st.indexOf(".pt-sb {"), st.indexOf("}", st.indexOf(".pt-sb {")));
  assert.deepEqual(noComments(sb).match(LITERAL) || [], []);
  assert.doesNotMatch(st, /"Inter Tight"/, "not a font this site ships");
});

test("m20NoPills: no capsule rule left in any stylesheet, shadowed or not; 50% only on a perfect square; no near-capsule in the editor", () => {
  for (const f of [...SHEETS, "src/pdf-toolkit/styles.css"]) {
    const css = noComments(read(f));
    assert.doesNotMatch(css, /border-radius:\s*(999|9999)px/, `${f}: a 999px capsule`);
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*border-radius:\s*50%[^{}]*)\}/g)) {
      const w = m[2].match(/(?:^|[;\s])width: (\d+)px/)?.[1], h = m[2].match(/(?:^|[;\s])height: (\d+)px/)?.[1];
      assert.ok(w && w === h, `${f}: ${m[1].trim()} is round but not a square (${w} × ${h})`);
    }
  }
  const ed = read("public/editor/editor.css");
  assert.match(ed, /\.grp select, \.grp button \{ all: unset; cursor: pointer; padding: 7px 10px; border-radius: 9px;/, "was 13 on a 34 px control");
  assert.match(ed, /\.grp label\.color \{[^}]*border-radius: 9px;/);
  assert.doesNotMatch(ed, /\.(grp\.cta button|btnlike\.cta) \{[^}]*linear-gradient/, "the call to action is a depth box, not a glowing gradient lozenge");
  const site = noComments(read("public/site.css"));
  assert.doesNotMatch(site, /\.band\b|\.chip\b/, "the shadowed band / chip capsules are removed, not overridden");
  assert.deepEqual(site.match(/[^\n]*!important[^\n]*/g), ["[hidden] { display: none !important; }"], "no override layer left");
});

test("m20EveryPageThemed: theme.js runs first and tokens.css loads before every other stylesheet; Settings offers the four themes", () => {
  const pages = ["public/index.html", "public/privacy.html", "public/pdf/index.html", "public/pdf/merge-pdf/index.html", "public/workspace/index.html", "public/editor/index.html"];
  for (const p of pages) {
    const html = read(p);
    const t = html.indexOf('<script src="/theme.js"></script>'), k = html.indexOf('<link rel="stylesheet" href="/tokens.css">');
    const first = html.indexOf('<link rel="stylesheet"');
    assert.ok(t > 0 && k > t && k === first, `${p}: theme.js, then tokens.css first`);
  }
  const s = read("public/settings-panel.js");
  assert.match(s, /\["dusk", "Dusk"\], \["plain", "Plain"\]/);
  assert.match(s, /\["system", "Match this device"\], \["light", "Light"\], \["dark", "Dark"\]/);
  assert.match(read("public/workspace/index.html"), /id="ws-settings"[^>]*aria-label="Settings"/);
  assert.match(read("public/theme.js"), /localStorage\.setItem\(KEY, pref\)/);
});
