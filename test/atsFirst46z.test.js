// ⭐ 46z (owner 11-20: "clicking ats on resume master is opening pdf editor blank") · the site's "ATS check" link lands on
// /workspace/?panel=resume. With no document open that showed the empty PDF editor, the check squeezed into the 240–290 px
// properties column — and on a phone (≤ 820 px) the properties are a closed bottom sheet, so nothing of the check showed.
// Now the check IS the page until a document opens (then it returns to the Résumé tab). Walked in real Chrome at
// 1440 / 1024 / 400 (draft's tmp/rmAtsWalk.mjs, 21 / 21: shown, no blank editor, scored through the paste box, moves back).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

test("46z · every ATS check link still opens the workspace's check", () => {
  assert.match(read("public/index.html"), /href="\/workspace\/\?panel=resume" data-nav="ats"/);
  assert.match(read("public/chrome.js"), /"#ats": "\/workspace\/\?panel=resume"/);
});

test("46z · with no document, ?panel=resume puts the check in the canvas (data-ats=first) and a document moves it back", () => {
  const html = read("public/workspace/index.html"), js = read("public/workspace/workspace.js"), css = read("public/workspace/workspace.css");
  assert.match(html, /<main class="ws-canvas"[^>]*>\s*(<!--[\s\S]*?-->\s*)?<section class="ws-atsfirst" id="ws-atsfirst"/, "the slot sits first in the canvas");
  assert.match(html, /id="ws-atsfirst-slot"/);
  assert.match(js, /ws\.dataset\.ats = "first"; if \(home\.parentElement !== first\) first\.append\(home\)/);
  assert.match(js, /if \(open\) \{ delete ws\.dataset\.ats; if \(home\.parentElement !== propsSlot\.parentElement\) propsSlot\.before\(home\); \}/);
  assert.match(js, /new MutationObserver\(place\)\.observe\(ws, \{ attributes: true, attributeFilter: \["data-state"\] \}\)/);
  for (const hidden of ["ws-empty", "ws-strip", "ws-props", "ws-tools", "ws-sheetbar"]) {
    assert.match(css, new RegExp(String.raw`\.ws\[data-ats="first"\]\[data-state="empty"\] \.${hidden}[,\s{]`), `${hidden} is out of the way`);
  }
  assert.match(css, /\.ws\[data-ats="first"\]\[data-state="empty"\] \.ws-body \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});
