// A54 (owner, 10-02): the domain gets a front door. "/" serves the site from public/; its own files
// are pages; everything else is still JSON. The site makes no third-party request (fonts are
// self-hosted — a font CDN would hand every visitor's address to a recipient the privacy page does
// not name), and every write it makes carries the header the server requires.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createApp } from "../src/http/app.js";
import { openStore } from "../src/store/db.js";

async function serve(store = openStore(":memory:")) {
  const app = createApp({ version: { version: "test" }, log: () => {}, clients: null, store });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test("/ is the site: HTML — the Documents home first, Settings (appearance + account) from the header", async () => {
  // moved on purpose (rm-audit M2 / M4 / M16 / M17, 46y): the home page's four tool tabs and its five in-flow account panels
  // are retired — the tools live in the workspace and the editor; the account is the Settings dialog on every page
  const s = await serve();
  try {
    const r = await fetch(s.base + "/");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/html/);
    const html = await r.text();
    for (const id of ['data-docs-home=""', 'data-open-settings=""', 'href="/workspace/?panel=resume"', 'href="/editor/?paste=1"', 'href="/privacy.html"']) {
      assert.ok(html.includes(id), `the page has ${id}`);
    }
    for (const gone of ['data-panel=', 'data-dialog=', 'class="tabs"', '/site.js']) assert.ok(!html.includes(gone), `no ${gone}`);
    for (const f of ["/site.css", "/chrome.js", "/site-settings.js", "/account-panel.js", "/settings-panel.js", "/settings.css", "/privacy.html", "/tokens.css", "/theme.js", "/ats-panel.js", "/fonts/dm-sans-latin-400-normal.woff2"]) {
      assert.equal((await fetch(s.base + f)).status, 200, f);
    }
    assert.equal((await fetch(s.base + "/nope.html")).status, 404);
  } finally { await s.close(); }
});

test("the privacy page IS docs/PRIVACY.md, served — it cannot drift from the document", async () => {
  const s = await serve();
  try {
    const j = await (await fetch(s.base + "/v1/site/privacy")).json();
    assert.equal(j.markdown, fs.readFileSync("docs/PRIVACY.md", "utf8"));
    assert.match(j.markdown, /What an account keeps/);
  } finally { await s.close(); }
});

test("⛔ the site makes no third-party request, and every write sends X-RM-Client: web", () => {
  const pdfPages = fs.readdirSync("public/pdf", { withFileTypes: true }).filter(d => d.isDirectory()).map(d => `public/pdf/${d.name}/index.html`);
  const files = ["public/index.html", "public/account-panel.js", "public/site-settings.js", "public/editor/editor-side.js", "public/site.css", "public/privacy.html", "public/chrome.js", "public/ats-panel.js", "public/settings-panel.js", "public/docs-home.js",
                 "public/pdf/index.html", ...pdfPages].map(f => [f, fs.readFileSync(f, "utf8")]);
  for (const [f, src] of files) {
    const urls = [...src.matchAll(/(?:src|href|url\()\s*=?\s*["']?(https?:\/\/[^"')\s]+)/g)].map(m => m[1]);
    // Its own origin (canonical links) and draft are links, not loads.
    const external = urls.filter(u => !/^https:\/\/(jobsviadraft\.com|resumemaster\.one)/.test(u));
    assert.deepEqual(external, [], `${f} loads from another origin: ${external.join(", ")}`);
    assert.doesNotMatch(src, /fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg|jsdelivr/, `${f} uses a CDN`);
  }
  // moved on purpose (46y): site.js is retired; each module that writes has ONE fetch helper with the header
  for (const f of ["public/account-panel.js", "public/editor/editor-side.js", "public/ats-panel.js"]) {
    const js = fs.readFileSync(f, "utf8");
    assert.match(js, /headers: \{ "content-type": "application\/json", "x-rm-client": "web" \}/, f);
    assert.equal((js.match(/fetch\(/g) || []).length, 1, `${f}: one fetch helper — every call goes through it`);
  }
  for (const f of fs.readdirSync("public/fonts").filter(f => f.endsWith(".woff2"))) {
    const family = f.replace(/-latin-.*$/, "");
    assert.ok(fs.existsSync(`public/fonts/LICENSE-${family}.txt`), `${f} ships with its licence`);
  }
});

test("bands on the site are draft's cutpoints, and 'not enough signal' is never shown as a low score", () => {
  // Moved on purpose (draft D192 (3d), 46y): the ATS card is one module, public/ats-panel.js, which the site's check and the
  // workspace's Résumé tab both draw from; the band is the number's colour class, the same cutpoints.
  const js = fs.readFileSync("public/ats-panel.js", "utf8");
  assert.match(js, /s >= 44 \? "strong" : s >= 26 \? "moderate" : "weak"/);
  assert.match(js, /<strong>Not enough signal<\/strong>/);
  assert.match(js, /This is not a low score/);
});

test("⛔ Format and Tailor results open IN the editor — no one-shot preview frame is left (rm-audit M6 / M7; was D157 T6's preview)", () => {
  // moved on purpose (46y): the preview iframe (and its print()) left with the home tabs; the result is a document to edit
  const side = fs.readFileSync("public/editor/editor-side.js", "utf8");
  assert.match(side, /const r = await call\("\/tools\/format", \{ html: toHtml\(paste\.text\.value\), title: "Résumé" \}\);\s+err\.textContent = ""; load\(r\.html, \{ filename: "resume\.html" \}\);/);
  assert.match(side, /const r = await call\("\/tools\/generate", \{ mode: "GENERATE", baseResumeText: getText\(\),/);
  assert.match(side, /load\(r\.html, \{ filename: `resume-/);
  for (const f of ["public/editor/editor-side.js", "public/account-panel.js", "public/index.html"]) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /<iframe class="preview"/, f);
  // the editor mounts it only by itself — never when draft embeds it (rm-editor/1 unchanged)
  const ed = fs.readFileSync("public/editor/editor.js", "utf8");
  const at = ed.indexOf('import("/editor/editor-side.js")');
  assert.ok(at > ed.indexOf("} else if (embedded) {"), "inside the standalone branch");
});
