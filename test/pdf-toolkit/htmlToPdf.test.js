// D157 T6 (draft's WORKLOG 44x owner list, item 5): HTML → PDF, in the browser. The document is previewed in a frame
// that runs no script and fetches nothing, and the browser's own print makes the PDF — so the toolkit's promise
// ("your files never leave this browser") holds. Walked in real Chrome 11-06: the tool's tab opens on its page, the
// preview shows the file, print starts (beforeprint), an inline <script> never runs, a linked stylesheet and picture
// are blocked by the policy (blockedReason "csp" — the same markup without it sends both requests).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { TOOLS, htmlForPrint } from "../../src/pdf-toolkit/ui.js";
import { PDF_PAGES } from "../../scripts/site/buildSite.mjs";

const POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

test("the HTML tool exists, with its own page", () => {
  assert.ok(TOOLS.some(t => t.id === "html" && /HTML/.test(t.label)));
  const page = PDF_PAGES.find(p => p.tool === "html");
  assert.equal(page?.slug, "html-to-pdf");
  assert.ok(fs.existsSync("public/pdf/html-to-pdf/index.html"), "the page is generated (scripts/site/buildSite.mjs)");
});

test("⛔ the policy goes FIRST in the document's head, before anything it could load", () => {
  const out = htmlForPrint('<html><head><link rel="stylesheet" href="https://x.example/a.css"></head><body>Hi</body></html>');
  const meta = out.indexOf(`<meta http-equiv="Content-Security-Policy" content="${POLICY}">`);
  assert.ok(meta > 0, "the policy is in the document");
  assert.ok(meta < out.indexOf("<link"), "before the stylesheet");
  assert.equal(out.match(/Content-Security-Policy/g).length, 1);
});

test("a fragment with no <head> is wrapped with the policy; a <header> is not mistaken for <head>", () => {
  const frag = htmlForPrint("<header>Morgan Vale</header><p>Body</p>");
  assert.match(frag, /^<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/);
  assert.ok(frag.includes("<body><header>Morgan Vale</header><p>Body</p></body>"));
  const withAttrs = htmlForPrint('<html><head lang="en"><title>t</title></head><body></body></html>');
  assert.ok(withAttrs.startsWith('<html><head lang="en"><meta http-equiv="Content-Security-Policy"'));
});

test("⛔ the preview frame never runs script: same-origin for print(), no allow-scripts", () => {
  const ui = fs.readFileSync("src/pdf-toolkit/ui.js", "utf8");
  const sandbox = ui.match(/const HTML_SANDBOX = "([^"]*)"/)?.[1].split(/\s+/) || [];
  assert.ok(sandbox.includes("allow-same-origin") && sandbox.includes("allow-modals"));
  assert.ok(!sandbox.includes("allow-scripts"), "allow-scripts with allow-same-origin would let the document lift its own sandbox");
  assert.match(ui, /html\(\) \{[\s\S]*contentWindow\.print\(\)/);
});
