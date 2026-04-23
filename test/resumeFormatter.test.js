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
  assert.match(html, /class="skills-table"/);
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
