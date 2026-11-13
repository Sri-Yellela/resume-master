// D189 P2 (owner 11-13: "approved, build P2") — the workspace shell: one document session for the workspace AND the toolkit's
// Edit tab, the approved zones, modes that swap the tools and never the layout, the font substitution disclosed (D188 (4)),
// colours from tokens only and the page in its own colours. The browser half is walked in a real Chrome (46k log).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { substitution, readableFont, faceOf } from "../src/pdf-toolkit/session.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

test("d188FontSubstitutionDisclosed: the standard face drawn in place of the PDF's own is named; the same family is not", () => {
  assert.equal(readableFont("ABCDEF+Calibri-Bold"), "Calibri Bold");
  assert.equal(readableFont("BCDEFG+GaramondPremrPro"), "Garamond Premr");
  assert.equal(substitution({ family: "serif" }, "ABCDEF+EBGaramond-Regular"), "Times for EB Garamond Regular");
  assert.equal(substitution({ family: "sans" }, "XYZABC+Calibri"), "Helvetica for Calibri");
  assert.equal(substitution({ family: "sans" }, "Helvetica"), null, "Helvetica is Helvetica");
  assert.equal(substitution({ family: "sans" }, "ArialMT"), null, "Arial draws as Helvetica — the standard pair");
  assert.equal(substitution({ family: "serif" }, "Times-Roman"), null);
  assert.equal(substitution({ family: "sans" }, null), null, "no name, nothing to say");
  assert.equal(substitution({ family: "sans" }, "g_d0_f1"), null, "pdf.js's internal name is not a font name");
  assert.deepEqual(faceOf("ABCDEF+Garamond-BoldItalic"), { family: "serif", bold: true, italic: true });
});

test("d189OneWorkspaceComponent: the workspace and the toolkit's Edit tab run ONE session — the engine is not copied", () => {
  const editTab = read("src/pdf-toolkit/textEditor.js");
  const ws = read("public/workspace/workspace.js");
  assert.match(editTab, /import \{ createPdfSession, FACES, hex, rgbOf \} from "\.\/session\.js";/);
  assert.match(ws, /import\("\/lib\/pdf-toolkit\/session\.js"\)/);
  for (const engine of [/function makeField\(/, /async function ocrPages\(/, /function guessFace\(/, /applyTextEdits\(/]) {
    assert.doesNotMatch(editTab, engine, `the Edit tab keeps no ${engine} of its own`);
    assert.doesNotMatch(ws, engine, `the workspace keeps no ${engine} of its own`);
  }
  const session = read("src/pdf-toolkit/session.js");
  for (const engine of [/function makeField\(/, /async function ocrPages\(/, /function guessFace\(/, /core\.applyTextEdits\(/, /core\.applyEdits\(/]) assert.match(session, engine);
});

test("d189Shell: the approved zones — top bar, modes, tool bar, page strip, canvas + navigator, properties", () => {
  const html = read("public/workspace/index.html");
  for (const id of ["ws-name", "ws-kind", "ws-saved", "ws-undo", "ws-redo", "ws-download", "ws-print", "ws-to-resume", "ws-done", "ws-tools", "ws-strip", "ws-canvas", "ws-nav", "ws-pageno", "ws-pct", "ws-fitw", "ws-fitp", "ws-props"]) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id}`);
  }
  assert.match(html, /data-mode="edit"[^>]*>Edit</);
  assert.match(html, /data-mode="sign"[^>]*>Fill &amp; sign</);
});

test("d189ModesSwapToolsNotLayout: a mode changes the tool bar only — no style keyed to the mode moves the workspace", () => {
  const ws = read("public/workspace/workspace.js");
  assert.match(ws, /const TOOLS = \{\n  edit: \[/);
  assert.match(ws, /mode = b\.dataset\.mode;[\s\S]{0,200}drawTools\(\);/);
  const css = read("public/workspace/workspace.css");
  assert.doesNotMatch(css, /data-mode[^\n]*\{[^}]*(grid-template|width|display)/, "no layout rule keyed to the mode");
});

test("d189TokensOnly + d189PageAlwaysPaperColours: the workspace's colours are its tokens; the page is white paper", () => {
  const css = read("public/workspace/workspace.css");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  const rest = css.replace(root, "");
  // outside the tokens, only the paper's white, the stamp's black-on-white and translucent scrims / shadows
  const literals = (rest.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter(h => !/^#(fff|ffffff|0f0f0f|111)$/i.test(h));
  assert.deepEqual(literals, [], "every colour comes from :root");
  assert.match(css, /\.ws-thumb img \{[^}]*background: #fff;/, "a page is drawn on white whatever the theme");
});
