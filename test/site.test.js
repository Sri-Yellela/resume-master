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

test("/ is the site: HTML, with the tools and the account surfaces", async () => {
  const s = await serve();
  try {
    const r = await fetch(s.base + "/");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/html/);
    const html = await r.text();
    for (const id of ['data-panel="ats"', 'data-panel="format"', 'data-panel="generate"', 'data-panel="pdf"',
                      'data-dialog="signin"', 'data-dialog="signup"', 'data-dialog="account"', 'href="/privacy.html"']) {
      assert.ok(html.includes(id), `the page has ${id}`);
    }
    for (const f of ["/site.css", "/site.js", "/chrome.js", "/privacy.html", "/sky.svg", "/fonts/dm-sans-latin-400-normal.woff2"]) {
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
  const files = ["public/index.html", "public/site.js", "public/site.css", "public/privacy.html", "public/chrome.js", "public/pdf-tools.js",
                 "public/pdf/index.html", ...pdfPages].map(f => [f, fs.readFileSync(f, "utf8")]);
  for (const [f, src] of files) {
    const urls = [...src.matchAll(/(?:src|href|url\()\s*=?\s*["']?(https?:\/\/[^"')\s]+)/g)].map(m => m[1]);
    // Its own origin (canonical links) and draft are links, not loads.
    const external = urls.filter(u => !/^https:\/\/(jobsviadraft\.com|resumemaster\.one)/.test(u));
    assert.deepEqual(external, [], `${f} loads from another origin: ${external.join(", ")}`);
    assert.doesNotMatch(src, /fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg|jsdelivr/, `${f} uses a CDN`);
  }
  const js = fs.readFileSync("public/site.js", "utf8");
  assert.match(js, /headers: \{ "content-type": "application\/json", "x-rm-client": "web" \}/);
  assert.equal((js.match(/fetch\(/g) || []).length, 1, "one fetch helper — every call goes through it");
  for (const f of fs.readdirSync("public/fonts").filter(f => f.endsWith(".woff2"))) {
    const family = f.replace(/-latin-.*$/, "");
    assert.ok(fs.existsSync(`public/fonts/LICENSE-${family}.txt`), `${f} ships with its licence`);
  }
});

test("bands on the site are draft's cutpoints, and 'not enough signal' is never shown as a low score", () => {
  const js = fs.readFileSync("public/site.js", "utf8");
  assert.match(js, /if \(s >= 44\) return \{ cls: "strong"/);
  assert.match(js, /if \(s >= 26\) return \{ cls: "moderate"/);
  assert.match(js, /if \(out\.outcome !== "scored"\) return \{ cls: "nosignal", label: "Not enough signal"/);
  assert.match(js, /This is not a low score/);
});
