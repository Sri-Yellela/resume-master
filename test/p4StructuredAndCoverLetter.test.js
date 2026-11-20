// ⭐ draft D192 P4 (owner 11-19 "approving all open items"): the résumé editor is the workspace's structured-editor mode (its
// sixth mode tab hands the open PDF's text over as sections), and the cover letter is a document type in the same editor —
// built on the editor's own section model, so it is edited, reordered, styled, kept and downloaded like a résumé.
// ⛔ rm-editor/1 is unchanged: the cover letter and the side column exist only when the editor stands alone.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sectionsFromHtml, htmlFromSections } from "../src/editor/sections.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const SIDE = read("public/editor/editor-side.js");
const LETTER = SIDE.match(/export const COVER_LETTER = `([\s\S]*?)`;/)[1].replace(/\$\{new Date\(\)[^}]*\}\)\}/, "November 19, 2026");

test("p4CoverLetterIsADocument: the template reads as the editor's sections — the header locked first, then date, letter, closing", () => {
  const doc = sectionsFromHtml(LETTER);
  assert.deepEqual(doc.sections.map(s => s.title), ["Name and contact", "Date and recipient", "The letter", "Closing"]);
  assert.equal(doc.sections[0].locked, true);
  assert.ok(doc.sections.slice(1).every(s => !s.locked), "the rest move like a résumé's sections");
  const again = sectionsFromHtml(htmlFromSections(doc));
  assert.deepEqual(again.sections.map(s => s.title), doc.sections.map(s => s.title), "it round-trips (kept, reopened, downloaded)");
  assert.match(LETTER, /Your Name/, "a placeholder person, never a real one");
});

test("p4CoverLetterEntrances + the editor's labels: a start button, /editor/?doc=cover-letter, Documents home's Start from; the menu names it", () => {
  assert.match(SIDE, /"Start a cover letter"/);
  assert.match(SIDE, /if \(params\.get\("doc"\) === "cover-letter"\) startCover\(\);/);
  assert.match(read("public/index.html"), /href="\/editor\/\?doc=cover-letter">A cover letter</);
  const ed = read("public/editor/editor.js");
  assert.match(ed, /kind: m\.kind === "cover-letter" \? "cover-letter" : "resume",/, "a host never sends kind — rm-editor/1 reads as before");
  assert.match(ed, /letter \? "Your cover letter" : "Your résumé"/);
});

test("p4StructuredMode: the workspace's sixth mode tab hands the open document to the structured editor", () => {
  assert.match(read("public/workspace/index.html"), /id="ws-structured" data-structured=""[^>]*>Structured ↗</);
  assert.match(read("public/workspace/workspace.js"), /\$\("#ws-structured"\)\.addEventListener\("click", \(\) => \(session\.bytes \? \$\("#ws-to-resume"\)\.click\(\) : \(location\.href = "\/editor\/"\)\)\);/);
  // the embedded editor (draft's focused mode) mounts none of it
  const ed = read("public/editor/editor.js");
  assert.ok(ed.indexOf('import("/editor/editor-side.js")') > ed.indexOf("} else if (embedded) {"));
});

// ── round 2 (46y, coordinator): the shell, the kind across a reload, Tailor and letters, the editor's ATS text ──
test("p4EditorInWorkspaceShell: by itself the editor wears the workspace's top bar, mode tabs (Structured selected) and its bar as the tool bar", () => {
  assert.match(SIDE, /export function mountShell\(\)/);
  assert.match(SIDE, /\["edit", "Edit"\], \["annotate", "Annotate"\], \["sign", "Fill & sign"\], \["pages", "Pages"\], \["convert", "Convert"\]\]/);
  assert.match(SIDE, /"data-mode": "structured" \}, "Structured"\)/);
  assert.match(SIDE, /href: `\/workspace\/\?mode=\$\{m\}`/, "a PDF mode opens the workspace");
  assert.match(SIDE, /"Download ▾"/);
  assert.match(read("public/editor/editor.css"), /html\[data-shell\] \.bar \{ position: sticky; top: 0; width: 100%;/);
});

test("p4CoverLetterKeptAcrossReload: the kind is kept beside the document in this browser, standalone only", () => {
  const ed = read("public/editor/editor.js");
  assert.match(ed, /const KIND_KEY = "rm-editor:kind";/);
  assert.match(ed, /if \(!embedded\) \{ document\.documentElement\.dataset\.kind = meta\.kind; try \{ localStorage\.setItem\(KIND_KEY, meta\.kind\); \}/);
  assert.match(ed, /else if \(saved\) \{ let kind = null; try \{ kind = localStorage\.getItem\(KIND_KEY\); \}[^\n]*load\(saved, \{ kind \}\); \}/);
});

test("p4TailorAndLetters: Tailor sends no letter through the résumé prompt — a letter would need a new model prompt, which is not added (D190)", () => {
  assert.match(SIDE, /if \(window\.__rmEditorKind\?\.\(\) === "cover-letter"\) \{ put\(out, el\("p", \{ class: "note", "data-tailor-letter": "" \}/);
  assert.equal((SIDE.match(/call\("\/tools\/generate"/g) || []).length, 1, "still the one existing Tailor call — no new model route");
});

test("editorAtsReadsTheDocument: the editor hands the ATS panel the document's own words — not the shadow-rooted page (#paper.innerText is empty) with its section labels", () => {
  const ed = read("public/editor/editor.js");
  assert.match(ed, /const d = new DOMParser\(\)\.parseFromString\(currentHtml\(\) \|\| "", "text\/html"\);/, "the document's sections, not the page's edit labels");
  assert.match(ed, /getText: documentText, params/);
  assert.doesNotMatch(ed, /\$\("#paper"\)\?\.innerText/);
});
