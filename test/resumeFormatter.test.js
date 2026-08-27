// SCRAPING � SCHEDULED FOR REMOVAL AFTER MIGRATION
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildStructuredResume,
  normalizeResumeHtml,
  renderInlineRichText,
  stripResumeHtml,
} from "../services/resumeFormatter.js";

test("markdown bold is parsed before deterministic HTML rendering", () => {
  assert.equal(renderInlineRichText("Built **Node.js** services"), "Built <strong>Node.js</strong> services");

  const html = normalizeResumeHtml(`
    Jane Doe
    Platform Engineer
    jane@example.com | linkedin.com/in/jane

    SUMMARY
    Built **distributed systems** and **platform tooling**.
  `);

  assert.match(html, /<strong>distributed systems<\/strong>/);
  assert.match(html, /<strong>platform tooling<\/strong>/);
  assert.doesNotMatch(html, /\*\*distributed systems\*\*/);
});

test("formatter sanitizes invalid unicode and strips literal control characters", () => {
  const html = normalizeResumeHtml(`
    Jane Doe\uFFFE
    Engineer
    jane@example.com

    SUMMARY
    Built reliable APIs\u0007 for customers.
  `);

  assert.doesNotMatch(html, /\uFFFE/);
  assert.doesNotMatch(html, /\u0007/);
  assert.match(html, /Built reliable APIs/);
});

test("structured renderer preserves bullets and experience blocks deterministically", () => {
  const structure = buildStructuredResume(`
<html><body>
  <div class="header">
    <div class="name">Jane Doe</div>
    <div class="tagline">Platform Engineer</div>
    <div class="contact">jane@example.com | Boston, MA</div>
  </div>
  <div class="section-title">Experience</div>
  <div class="entry">
    <div class="entry-header">
      <div><span class="entry-org">Acme Corp</span> <span class="entry-meta"><span class="sep">|</span> Platform Team, Boston, MA</span></div>
      <div class="entry-date">Jan 2020 - Present</div>
    </div>
    <div class="entry-role">Senior Engineer</div>
    <ul class="bullets">
      <li>Built **Node.js** services.</li>
      <li>Reduced latency by **37%**.</li>
    </ul>
  </div>
</body></html>
  `);

  const experience = structure.sections.find(section => section.title === "EXPERIENCE");
  assert.ok((experience?.entries?.length || 0) >= 1);
  assert.equal(experience.entries[0].company, "Acme Corp");

  const html = normalizeResumeHtml(`
<html><body>
  <div class="header"><div class="name">Jane Doe</div></div>
  <div class="section-title">Experience</div>
  <div class="entry">
    <div class="entry-header">
      <div><span class="entry-org">Acme Corp</span> <span class="entry-meta"><span class="sep">|</span> Platform Team, Boston, MA</span></div>
      <div class="entry-date">Jan 2020 - Present</div>
    </div>
    <div class="entry-role">Senior Engineer</div>
    <ul class="bullets">
      <li>Built **Node.js** services.</li>
      <li>Reduced latency by **37%**.</li>
    </ul>
  </div>
</body></html>
  `);

  assert.match(html, /<div class="entry-header">[\s\S]*Acme Corp[\s\S]*Jan 2020 - Present/);
  assert.match(html, /<div class="entry-role">Senior Engineer<\/div>/);
  assert.match(html, /<ul class="bullets">[\s\S]*<li>Built <strong>Node\.js<\/strong> services\.<\/li>/i);
  assert.match(html, /<li>Reduced latency by <strong>37%<\/strong>\.<\/li>/);
  assert.doesNotMatch(html, /li::before/);
  assert.match(html, /list-style: disc outside/);
});

test("formatter removes duplicated experience header rows from bullet content", () => {
  const html = normalizeResumeHtml(`
<html><body>
  <div class="header"><div class="name">Jane Doe</div></div>
  <div class="section-title">Experience</div>
  <div class="entry">
    <div class="entry-header">
      <div><span class="entry-org">Acme Corp</span> <span class="entry-meta"><span class="sep">|</span> Platform Team, Boston, MA</span></div>
      <div class="entry-date">Jan 2020 - Present</div>
    </div>
    <div class="entry-role">Senior Engineer</div>
    <ul class="bullets">
      <li>Senior Engineer | Jan 2020 - Present</li>
      <li>Built reliable APIs.</li>
    </ul>
  </div>
</body></html>
  `);

  assert.match(html, /<div class="entry-role">Senior Engineer<\/div>/);
  assert.doesNotMatch(html, /<li>Senior Engineer \| Jan 2020 - Present<\/li>/);
  assert.match(html, /<li>Built reliable APIs\.<\/li>/);
  assert.equal((html.match(/Senior Engineer/g) || []).length, 1);
});

test("formatter emits HTML contract classes and tuned typography", () => {
  const html = normalizeResumeHtml(`
    Jane Doe
    Platform Engineer
    jane@example.com

    SUMMARY
    Platform engineer with **eight years** building systems.

    TECHNICAL SKILLS
    Languages: JavaScript | TypeScript | Python

    EXPERIENCE
    Acme Corp | Platform Team, Boston, MA Jan 2020 - Present
    Senior Engineer
    - Built APIs
  `);

  assert.match(html, /class="header"/);
  assert.match(html, /class="section-title"/);
  assert.match(html, /class="entry"/);
  assert.match(html, /class="bullets"/);
  // The skills section stopped being a <table class="skills-table"> in 8412c9a, whose diff says
  // so outright: "CHANGE 7: skills section now renders as a bullet list instead of a table".
  // A deliberate design change that this assertion was never updated for. Asserting the contract
  // that exists — a labelled bullet, which is also the ATS-friendlier shape (tables extract
  // poorly), consistent with this file's own "selectable-text oriented" test below.
  assert.match(html, /<ul class="bullets">\s*<li><strong>Languages<\/strong>/);
  assert.match(html, /letter-spacing: 0\.08em/);
  assert.match(html, /letter-spacing: 0\.01em/);
  assert.doesNotMatch(html, /letter-spacing: 0\.22em/);
  assert.doesNotMatch(html, /letter-spacing: 0\.18em/);
});

test("ATS text extraction from deterministic HTML remains clean and selectable-text oriented", () => {
  const html = normalizeResumeHtml(`
    Jane Doe
    Platform Engineer
    jane@example.com

    SUMMARY
    Built **distributed systems**.
  `);
  const text = stripResumeHtml(html);

  assert.match(text, /Jane Doe/);
  assert.match(text, /Built distributed systems\./);
  assert.doesNotMatch(text, /<strong>/);

  const server = fs.readFileSync("server.js", "utf8");
  const pdfFn = server.slice(server.indexOf("async function htmlToPdf"), server.indexOf("// â”€â”€ Field normalisers"));
  assert.match(pdfFn, /page\.pdf\(/);
  assert.doesNotMatch(pdfFn, /page\.screenshot\(/);
  assert.doesNotMatch(pdfFn, /canvas/i);
});

// ── HTML entities survive the parse/render round trip ───────────────────────────────────────────
//
// THE DEFECT THIS LOCKS OUT, which reached real PDFs:
// decodeHtmlEntities knew nine entity names. Anything else survived the parse as literal text, and
// escapeHtml on the render side then turned its "&" into "&amp;" — so the reader saw "&middot;"
// printed on the page. That is not an edge case: layer1_global_rules.md tells the model to separate
// skills with a middle dot, so every generated resume carried a row of them into the document an
// employer opens. Reproduced from clean input, which is what proved it a renderer bug and not bad
// stored data.

const skills = body => normalizeResumeHtml(`<html><body>
  <div class="header"><div class="name">A B</div></div>
  <div class="section-title">TECHNICAL SKILLS</div><ul><li>${body}</li></ul>
  <div class="section-title">EXPERIENCE</div>
  <div class="entry"><div class="entry-org">Acme</div><ul class="bullets"><li>Did work.</li></ul></div>
</body></html>`);
const skillLine = body => (skills(body).match(/<li>([\s\S]*?)<\/li>/) || [])[1].trim();

test("the middot separator reaches the document as a middot, not as its own entity name", () => {
  assert.equal(skillLine("Java &middot; Go &middot; SQL"), "Java · Go · SQL");
  assert.doesNotMatch(skills("Java &middot; Go"), /&amp;middot;/,
    "an entity the decoder does not know gets its ampersand escaped and printed verbatim");
});

test("the same character decodes identically however it is written", () => {
  // A model may emit any of these for one separator; three spellings must not give three results.
  for (const form of ["&middot;", "&#183;", "&#xB7;", "&#Xb7;"]) {
    assert.equal(skillLine(`Java ${form} Go`), "Java · Go", form);
  }
});

test("accented letters in a candidate's own name survive", () => {
  // The failure here is a person's name misspelled on their resume, which is worse than a separator.
  const html = normalizeResumeHtml(`<html><body>
    <div class="header"><div class="name">Jos&eacute; Garc&iacute;a-M&uuml;ller</div></div>
    <div class="section-title">EXPERIENCE</div>
    <div class="entry"><div class="entry-org">Acme</div><ul class="bullets"><li>Did work.</li></ul></div>
  </body></html>`);
  assert.match(html, /José García-Müller/);
  assert.doesNotMatch(html, /&amp;/);
});

test("the house normalisations hold, and agree across spellings", () => {
  // These are rewrites, not decodings: layer 1 forbids em and en dashes outright, so an entity that
  // decodes to one must still come out as a hyphen — whichever way the model wrote it.
  assert.equal(skillLine("A &mdash; B"), "A - B");
  assert.equal(skillLine("A &#8212; B"), "A - B", "the numeric form must not disagree with the named one");
  assert.equal(skillLine("A &ndash; B"), "A - B");
  // Escaped on the way out, as every rendered value is — this is `"x" 'y'` on the page.
  assert.equal(skillLine("&ldquo;x&rdquo; &lsquo;y&rsquo;"), "&quot;x&quot; &#39;y&#39;");
  assert.equal(skillLine("a&nbsp;b"), "a b");
});

test("ASCII-named entities decode too — 30&percnt; is the middot defect in another costume", () => {
  assert.equal(skillLine("Cut cost 30&percnt;"), "Cut cost 30%");
  assert.equal(skillLine("C&num; and F&num;"), "C# and F#");
});

test("a genuine ampersand still escapes, and is not read as an entity", () => {
  assert.equal(skillLine("R&amp;D"), "R&amp;D", "the OUTPUT is escaped; it renders as R&D");
  assert.match(stripResumeHtml(skills("R&amp;D")), /R&D/, "and the ATS text sees the real character");
});

test("an entity the decoder does not recognise is left verbatim rather than guessed at", () => {
  // A replacement character would be a silent corruption; the literal text is at least honest.
  assert.equal(skillLine("&notarealentity; here"), "&amp;notarealentity; here");
  assert.equal(skillLine("&#99999999; here"), "&amp;#99999999; here", "out of range");
  assert.equal(skillLine("&#xD800; here"), "&amp;#xD800; here", "a lone surrogate must not be produced");
});

test("decoding never becomes an injection route — the render side still escapes", () => {
  // Decoding runs on the PARSE side and every rendered value goes back through escapeHtml, so a
  // tag arriving in any encoding comes out inert. Asserted because "decode more" is exactly the
  // kind of change that quietly opens this up.
  for (const form of ["&lt;script&gt;alert(1)&lt;/script&gt;", "&#60;script&#62;alert(1)&#60;/script&#62;"]) {
    const out = skills(form);
    assert.doesNotMatch(out, /<script/i, form);
    assert.match(out, /&lt;script/i, form);
  }
});

test("the Latin-1 entity tables are the right length, so the codepoint offsets line up", () => {
  // They are indexed by position from 160 and 192. A single missing or extra name silently shifts
  // every entity after it to the wrong character, which no individual case above would catch.
  const src = fs.readFileSync("services/resumeFormatter.js", "utf8");
  // `;\r?\n` — this file is CRLF, and a bare `;\n` matches nothing and throws on the null.
  const names = (re) => {
    const m = src.match(re);
    assert.ok(m, `table not found: ${re}`);
    return (m[1].match(/[a-zA-Z0-9]+/g) || []).length;
  };
  assert.equal(names(/const LATIN1_PUNCTUATION_ENTITIES =\s*([\s\S]*?);\r?\n/), 32, "U+00A0 to U+00BF");
  assert.equal(names(/const LATIN1_LETTER_ENTITIES =\s*([\s\S]*?);\r?\n/), 64, "U+00C0 to U+00FF");
  // Spot-check both ends and the middle of each range against known codepoints.
  assert.equal(skillLine("&nbsp;|&iquest;|&Agrave;|&yuml;|&times;|&divide;"), "|¿|À|ÿ|×|÷");
});
