// D157 (draft, owner 11-05 / 11-06): the résumé editor lives HERE and draft embeds it. Sections as real objects
// (detected, edited in place, reordered, name and contact locked on top), the document options, a versioned message
// contract, every chrome colour from the host's theme, and the page's own walls. The real-Chrome walks are
// draft's (test/d157ResumeEditorEmbed.test.js); this file pins the model, the guards and the routes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  EDITOR_CONTRACT, sectionsFromHtml, htmlFromSections, moveSection, placeSection, addSection, sanitizeFragment,
  cleanTheme, isAllowedHost, styleCss, paperCss, kindOfHeading,
} from "../src/editor/sections.js";
import { normalizeResumeHtml, buildStructuredResume } from "../src/formatting/resumeFormatter.js";
import { createApp } from "../src/http/app.js";
import { openStore } from "../src/store/db.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// Ten synthetic résumés, written the ways people write them: headings in caps, title case, with colons, aliases.
const HEAD = "Pat Sample\nSeattle, WA | pat@example.com | linkedin.com/in/pat-sample\n";
const ROLE = "Acme Corp | Seattle, WA  2021 – Present\nSoftware Engineer\n• Built a billing service handling 2M requests a day\n• Led the migration to Postgres 16\n";
const SAMPLES = [
  [`${HEAD}SUMMARY\nEngineer.\nSKILLS\nLanguages: Go, SQL\nEXPERIENCE\n${ROLE}EDUCATION\nState University  2019\nBS Computer Science`, ["header", "summary", "skills", "experience", "education"]],
  [`${HEAD}Professional Summary:\nEngineer.\nWork Experience:\n${ROLE}Education:\nState University  2019\nBS`, ["header", "summary", "experience", "education"]],
  [`${HEAD}TECHNICAL SKILLS\nGo, SQL\nPROFESSIONAL EXPERIENCE\n${ROLE}PROJECTS\nLedger | 2023\n• A double-entry ledger in Go`, ["header", "skills", "experience", "projects"]],
  [`${HEAD}EXPERIENCE\n${ROLE}ACADEMIC PROJECTS\nCompiler | 2020\n• A toy compiler\nEDUCATION\nState University  2019\nBS`, ["header", "experience", "projects", "education"]],
  [`${HEAD}PROFILE\nData engineer.\nCORE COMPETENCIES\nSpark, Airflow\nEXPERIENCE\n${ROLE}`, ["header", "summary", "skills", "experience"]],
  [`${HEAD}SUMMARY\nDesigner turned engineer.\nEXPERIENCE\n${ROLE}${ROLE.replace("Acme Corp", "Globex")}`, ["header", "summary", "experience"]],
  [`${HEAD}EXPERTISE\nKubernetes, Terraform\nEXPERIENCE\n${ROLE}EDUCATION\nCollege  2018\nBA`, ["header", "skills", "experience", "education"]],
  [`${HEAD}ABOUT\nHello.\nSIDE PROJECTS\nApp | 2022\n• A habit tracker\nEXPERIENCE\n${ROLE}`, ["header", "summary", "experience", "projects"]],
  [`${HEAD}QUALIFICATIONS\nMSc Statistics, 2020\nEXPERIENCE\n${ROLE}`, ["header", "experience", "education"]],
  [`${HEAD}Summary\nShort.\nSkills\nPython\nExperience\n${ROLE}Education\nSchool  2017\nBS`, ["header", "summary", "skills", "experience", "education"]],
];

test("d157SectionsDetected: ten résumés, each split into its sections — name and contact locked at the top", () => {
  for (const [text, kinds] of SAMPLES) {
    const doc = sectionsFromHtml(normalizeResumeHtml(text));
    assert.equal(doc.contract, EDITOR_CONTRACT);
    assert.deepEqual(doc.sections.map(s => s.kind), kinds, text.slice(HEAD.length, HEAD.length + 40));
    assert.equal(doc.sections[0].locked, true);
    assert.ok(doc.sections.slice(1).every(s => !s.locked && s.html.length > 0 && s.heading), "every section has a heading and a body");
    assert.match(doc.sections[0].html, /Pat Sample/);
  }
});

test("d157SectionsRoundTrip: a document the editor wrote reads back into the same sections, byte for byte", () => {
  const doc = sectionsFromHtml(normalizeResumeHtml(SAMPLES[0][0]));
  const moved = moveSection(doc, "education", -2);
  const html = htmlFromSections({ ...moved, style: { font: "arial", sizePt: 10, spacing: "airy", margin: "wide" } });
  const back = sectionsFromHtml(html);
  assert.deepEqual(back.sections.map(s => s.id), ["head", "summary", "education", "skills", "experience"]);
  assert.deepEqual(back.style, { font: "arial", sizePt: 10, spacing: "airy", margin: "wide" });
  assert.equal(htmlFromSections(back), html);
  // Everything that already reads a résumé still reads it: the formatter finds the same name and sections.
  const st = buildStructuredResume(html);
  assert.equal(st.header.name, "Pat Sample");
  assert.deepEqual(st.sections.map(s => s.title).sort(), ["EDUCATION", "EXPERIENCE", "SUMMARY", "TECHNICAL SKILLS"]);
});

test("d157SectionReorder: drag, ▲ ▼ — nothing moves above name and contact, and the header can't move", () => {
  const doc = sectionsFromHtml(normalizeResumeHtml(SAMPLES[0][0]));
  assert.deepEqual(moveSection(doc, "summary", -1).sections.map(s => s.id), doc.sections.map(s => s.id));
  assert.equal(moveSection(doc, "head", 1), doc);
  assert.deepEqual(placeSection(doc, "education", "summary").sections.map(s => s.id), ["head", "education", "summary", "skills", "experience"]);
  assert.equal(placeSection(doc, "skills", "head"), doc);
  const { doc: added, id } = addSection(doc, "certifications");
  assert.equal(added.sections.at(-1).id, id);
  assert.match(htmlFromSections(added), /<div class="section-title">CERTIFICATIONS<\/div>/);
  // A header that arrives anywhere is put back on top when the document is written.
  const scrambled = { ...doc, sections: [doc.sections[2], doc.sections[0], doc.sections[1]] };
  assert.equal(sectionsFromHtml(htmlFromSections(scrambled)).sections[0].kind, "header");
});

test("d157Options: font, size, spacing and margins are the formatter's own variables — bounded, ATS-safe fonts only", () => {
  assert.match(styleCss({ sizePt: 99 }), /--fs-body: 12pt/);
  assert.match(styleCss({ sizePt: 1 }), /--fs-body: 7.5pt/);
  assert.doesNotMatch(styleCss({ font: "Comic Sans" }), /font-family/);
  assert.match(styleCss({ font: "calibri" }), /font-family: Calibri, Carlito/);
  const css = paperCss({ margin: "wide" });
  assert.match(css, /\.rm-doc \{/);
  assert.doesNotMatch(css, /(^|[}\s])body\s*\{/, "the paper's stylesheet never styles the editor's own body");
  assert.equal(kindOfHeading("Work Experience:"), "experience");
});

test("d157NoScriptInTheDocument: a section never carries anything that runs or fetches", () => {
  const dirty = '<b onclick="x()">a</b><script>alert(1)</script><iframe src="//evil"></iframe><a href="javascript:x()">l</a>'
    + '<img src="data:text/html,x" onerror=y><style>body{}</style><section>s</section><div contenteditable="true">e</div>';
  const clean = sanitizeFragment(dirty);
  assert.doesNotMatch(clean, /onclick|onerror|<script|<iframe|javascript:|data:text|<style|<section|contenteditable/i);
  assert.match(clean, /<b>a<\/b>/);
  const doc = sectionsFromHtml(`<html><body><div class="header"><div class="name">X</div></div><div class="section-title">SUMMARY</div><div>${dirty}</div></body></html>`);
  assert.doesNotMatch(htmlFromSections(doc), /<script|onerror|onclick|javascript:/i);
});

test("d157EditorColoursFromTheme: no colour literal in the editor's chrome outside its default-theme block", () => {
  const css = read("public/editor/editor.css");
  const firstRoot = css.indexOf(":root {");
  const end = css.indexOf("}", firstRoot);
  const rest = css.slice(0, firstRoot) + css.slice(end + 1);
  const literal = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:white|black|red|blue|green|gray|grey)\b/gi;
  assert.deepEqual(rest.replace(/\/\*[\s\S]*?\*\//g, "").match(literal) || [], []);
  // The script draws its page chrome (the edit outlines, the change marks) from the same variables.
  const js = read("public/editor/editor.js");
  const editCss = js.match(/const EDIT_CSS = `([\s\S]*?)`;/)[1];
  assert.deepEqual(editCss.match(literal) || [], []);
  assert.deepEqual(js.match(/\b(?:rgba?|hsla?)\(\s*\d/gi) || [], []);
  // Every token the host may send restyles the chrome; the paper is not among them (it is the document's).
  for (const v of ["--bg", "--card", "--raise", "--ink", "--body", "--muted", "--accent", "--accent2", "--on-accent"]) {
    assert.ok(read("public/editor/editor.js").includes(`"${v}"`), v);
  }
  assert.doesNotMatch(read("public/editor/editor.js"), /"--paper/);
});

test("d157ThemeMessageIsClean: a host's tokens are values, never CSS that escapes its declaration", () => {
  assert.deepEqual(cleanTheme({ accent: "#FBD3C4", bg: "rgb(27, 27, 27)", card: "red; background:url(x)", ink: "color-mix(in srgb, #fff 50%, #000)",
    font: "'Inter Tight', system-ui", radius: "28px", onAccent: "}", body: "url(http://x)" }),
  { accent: "#FBD3C4", bg: "rgb(27, 27, 27)", ink: "color-mix(in srgb, #fff 50%, #000)", font: "'Inter Tight', system-ui", radius: "28px" });
});

test("d157ContractHosts: only draft's origins (and a developer's localhost) may embed and talk to the editor", () => {
  for (const o of ["https://jobsviadraft.com", "https://www.jobsviadraft.com", "https://draft-production.up.railway.app", "http://localhost:3971", "http://127.0.0.1:5173"]) {
    assert.ok(isAllowedHost(o), o);
  }
  for (const o of ["https://jobsviadraft.com.evil.example", "http://jobsviadraft.com", "https://evil.example", "null", "", undefined]) {
    assert.ok(!isAllowedHost(o), String(o));
  }
  const js = read("public/editor/editor.js");
  assert.match(js, /e\.source !== window\.parent \|\| e\.origin !== host/, "a message is read only from the parent, at the allowed origin");
  assert.match(js, /m\.contract !== EDITOR_CONTRACT/, "and only on this contract");
  assert.match(js, /postMessage\(\{ contract: EDITOR_CONTRACT, type, \.\.\.payload \}, host\)/, "it only ever posts to that origin");
});

test("d157ReviewChangesLabel: the button reads \"Review changes\", text only, no icon", () => {
  const html = read("public/editor/index.html");
  const m = html.match(/<button id="review-changes"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(m);
  assert.equal(m[1], "Review changes");
  assert.doesNotMatch(html, /What we changed/);
});

test("d157Routes: the page with its policy (framed only by draft), its model served from src/, nothing else of src/", async () => {
  const app = createApp({ version: { version: "test" }, log: () => {}, clients: null, store: openStore(":memory:") });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base + "/editor/");
    assert.equal(page.status, 200);
    const csp = page.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'self' https:\/\/jobsviadraft\.com/);
    assert.doesNotMatch(csp, /frame-ancestors[^;]*\s\*(?:\s|;|$)/, "never framed by anyone");
    for (const p of ["/editor/editor.js", "/editor/editor.css", "/lib/editor/sections.js", "/lib/formatting/resumeFormatter.js"]) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      if (p.endsWith(".js")) assert.match(r.headers.get("content-type"), /javascript/, p);
    }
    assert.equal(await (await fetch(base + "/lib/editor/sections.js")).text(), fs.readFileSync("src/editor/sections.js", "utf8"));
    assert.equal((await fetch(base + "/lib/formatting/formattingSystem.js")).status, 404);
  } finally { await new Promise(r => server.close(r)); }
});

test("d157ReadOnlySent: a résumé that was already sent opens read-only — readable, highlighted, downloadable, never changed", () => {
  const js = read("public/editor/editor.js");
  assert.match(js, /readOnly: m\.readOnly === true/);
  assert.match(js, /contenteditable="\$\{!meta\.readOnly\}"/, "the page is not editable");
  assert.match(js, /function changed\(\) \{\n  if \(meta\.readOnly\) return;/, "nothing is ever sent back as a change");
  assert.match(js, /li\.draggable = !s\.locked && !meta\.readOnly/, "nothing reorders");
});
