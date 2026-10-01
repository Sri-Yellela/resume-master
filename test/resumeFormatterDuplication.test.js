// AG4 — nothing renders twice because its styling changed.
//
// THE REPORT
// "Software Development Engineer, Supply Chain & Internal Developer Tools | Hyderabad" rendered
// TWICE — once styled, once as italic body text immediately beneath — and the bullet text ran on
// from it. Reported at several places, wherever a different font or style was intended.
//
// WHICH LAYER WAS AT FAULT
// Both base resumes in the database were checked line by line and neither duplicates anything, so
// the "the source was already duplicated and generation reproduced it faithfully" hypothesis is
// ruled out: the formatter was manufacturing the second copy. Three distinct mechanisms did it,
// and each has its own test here because each would have been fixed differently. The fix is in
// parseEntryBlockFromHtml — where content is CLASSIFIED — and not in the renderer: a renderer that
// strips duplicates hides whichever layer is producing them.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeResumeHtml } from "../src/formatting/resumeFormatter.js";

/**
 * Every line appearing more than once WITHIN a single entry.
 *
 * Scoped per entry on purpose. Two roles at the same employer legitimately name that employer
 * twice, and a document-wide check would call that a defect — which is how a real duplication gets
 * lost among false alarms.
 */
function duplicatedLinesPerEntry(html) {
  const found = [];
  const entries = String(html).split('<div class="entry">').slice(1);
  for (const entry of entries) {
    const body = entry.split('<div class="section-title">')[0];
    const lines = body.replace(/<[^>]+>/g, "\n").split("\n")
      .map(line => line.trim()).filter(line => line.length > 8);
    const counts = new Map();
    for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
    for (const [line, n] of counts) if (n > 1) found.push({ line, n });
  }
  return found;
}

const wrapEntry = inner => `<html><body>
<div class="section-title">EXPERIENCE</div>
<div class="entry">${inner}</div>
</body></html>`;

test("AG4: a bullet list without class=bullets is not rendered twice", () => {
  // MECHANISM 1 — the leftover-text removal required class="bullets", so a plain <ul> from the
  // model was read into entry.bullets AND left in the free text. Every bullet rendered twice.
  const html = normalizeResumeHtml(wrapEntry(`
  <div class="entry-header"><div><span class="entry-org">Amazon</span></div></div>
  <div class="entry-role">Software Development Engineer</div>
  <ul>
    <li>Built cloud-native microservices on AWS processing 500K daily queries.</li>
    <li>Developed Java backend services with PostgreSQL and DynamoDB.</li>
  </ul>`));
  assert.deepEqual(duplicatedLinesPerEntry(html), []);
  assert.equal((html.match(/Built cloud-native microservices/g) || []).length, 1);
});

test("AG4: a nested entry-header does not leak its date into the body", () => {
  // MECHANISM 2 — `<div class="entry-header">[\s\S]*?</div>` is non-greedy and an entry header
  // contains a nested div, so the delete stopped inside it and entry-date survived into the
  // leftover text, to be rendered a second time as body copy.
  const html = normalizeResumeHtml(wrapEntry(`
  <div class="entry-header">
    <div><span class="entry-org">Stripe</span> <span class="entry-meta">Payments Infrastructure, Bangalore</span></div>
    <div class="entry-date">Aug 2022 - Dec 2023</div>
  </div>
  <div class="entry-role">Software Development Engineer</div>
  <ul class="bullets"><li>Built scalable microservices for real-time payment processing.</li></ul>`));
  assert.deepEqual(duplicatedLinesPerEntry(html), []);
  assert.equal((html.match(/Aug 2022 - Dec 2023/g) || []).length, 1);
});

test("AG4: a model's plain-text restatement of the header and bullets is read, not reprinted", () => {
  // MECHANISM 3 — the shape actually found in the stored artifact: a plain <div> restating the
  // role/date line and then every bullet as "• ..." text, beside the <ul> that also held them.
  // cleanEntryHeaderDupes only caught this when the div held the header line and nothing else, and
  // isDuplicateEntryHeaderLine could not recognise the line at all because entry-date was empty
  // and the dates had been folded into the meta.
  const html = normalizeResumeHtml(wrapEntry(`
  <div class="entry-header">
    <div><span class="entry-org">College of Engineering, University Near You</span> <span class="entry-meta"><span class="sep">|</span> Technical Assistant | Jul 2016 - Present</span></div>
  </div>
  <div class="entry-role">Technical Assistant</div>
  <div>Technical Assistant | Jul 2016 - Present

• Coordinated technical support delivery for large-scale annual events.

• Directed and mentored a rotating team of student workers and volunteers.</div>
  <ul class="bullets">
    <li>Coordinated technical support delivery for large-scale annual events.</li>
    <li>Directed and mentored a rotating team of student workers and volunteers.</li>
  </ul>`));
  assert.deepEqual(duplicatedLinesPerEntry(html), []);
  assert.equal((html.match(/Technical Assistant \| Jul 2016 - Present/g) || []).length, 1);
  assert.equal((html.match(/Coordinated technical support/g) || []).length, 1);
});

test("AG4: a styled separator is styling, not content, and is never doubled", () => {
  // renderEntry writes the "|" itself. Reading the sep span back as part of the meta meant every
  // pass through the formatter added another one — "| | Technical Assistant".
  const once = normalizeResumeHtml(wrapEntry(`
  <div class="entry-header"><div><span class="entry-org">Amazon</span> <span class="entry-meta">Supply Chain, Hyderabad</span></div></div>
  <div class="entry-role">Software Development Engineer</div>
  <ul class="bullets"><li>Built and operated cloud-native microservices on AWS.</li></ul>`));
  const twice = normalizeResumeHtml(once);
  assert.doesNotMatch(twice, /\|\s*\|/, "a second pass must not add another separator");
  assert.equal((twice.match(/Supply Chain, Hyderabad/g) || []).length, 1);
});

test("AG4: formatting is idempotent — a second pass adds nothing and loses nothing", () => {
  // The real regression risk. A stored artifact IS formatter output, and it is re-formatted on the
  // enhance and adopt paths. If one pass is not a fixed point, duplicates accumulate silently.
  const source = wrapEntry(`
  <div class="entry-header">
    <div><span class="entry-org">Stripe</span> <span class="entry-meta">Payments Infrastructure, Bangalore</span></div>
    <div class="entry-date">Aug 2022 - Dec 2023</div>
  </div>
  <div class="entry-role">Software Development Engineer</div>
  <div class="tech-line">Go, Kubernetes, PostgreSQL</div>
  <ul class="bullets">
    <li>Built scalable microservices for real-time payment processing.</li>
    <li>Designed fault-tolerant distributed systems using GCP Pub/Sub.</li>
  </ul>`);
  const first = normalizeResumeHtml(source);
  const second = normalizeResumeHtml(first);
  assert.equal(second, first, "normalizeResumeHtml must be a fixed point");
  assert.deepEqual(duplicatedLinesPerEntry(second), []);
  for (const kept of [
    "Stripe", "Payments Infrastructure, Bangalore", "Aug 2022 - Dec 2023",
    "Software Development Engineer", "Go, Kubernetes, PostgreSQL",
    "Built scalable microservices", "Designed fault-tolerant distributed systems",
  ]) {
    assert.ok(second.includes(kept), `the fix must not drop content: ${kept}`);
  }
});

test("AG4: a bullet the list does NOT already hold is promoted, not discarded", () => {
  // Dropping every leftover line would trade a duplication defect for a data-loss one. A "• " line
  // that is not in the <ul> is the model's only copy of that bullet.
  const html = normalizeResumeHtml(wrapEntry(`
  <div class="entry-header"><div><span class="entry-org">Amazon</span></div></div>
  <div class="entry-role">Software Development Engineer</div>
  <div>• Applied object-oriented design across core services, cutting defect rates by 30 percent.</div>`));
  assert.match(html, /Applied object-oriented design across core services/);
  assert.deepEqual(duplicatedLinesPerEntry(html), []);
});

test("AG4: a skills row survives a round-trip without gaining a bullet or an empty bold run", () => {
  // The same fault one section over, found while screenshotting the PDF. renderSection emits
  // `<li><strong>Languages</strong> Java · C++</li>`; re-parsing that turned "<li>" into a literal
  // "• ", found no colon to split on, and produced an empty label — so a second pass rendered
  // `<li><strong></strong> • Languages Java · C++`: a bullet glyph inside a bullet, and bold
  // nothing. Content altered by a style round-trip, which is what AG4 is about.
  const source = `<html><body>
<div class="section-title">TECHNICAL SKILLS</div>
<ul class="bullets">
  <li><strong>Languages</strong> <strong>Java</strong> &middot; <strong>C++</strong> &middot; JavaScript</li>
  <li><strong>Cloud Platforms</strong> Microsoft Azure &middot; AWS &middot; GCP</li>
</ul>
</body></html>`;
  const first = normalizeResumeHtml(source);
  const second = normalizeResumeHtml(first);
  assert.doesNotMatch(second, /<strong><\/strong>/, "an empty bold run is styling applied to nothing");
  assert.doesNotMatch(second, /<li>[^<]*[•*‣▪]/, "a list item must not also carry a bullet glyph");
  assert.match(second, /<strong>Languages<\/strong>/);
  assert.match(second, /<strong>Cloud Platforms<\/strong>/);
  assert.ok(second.includes("Microsoft Azure"));
  assert.equal(second, first, "the skills section must be a fixed point too");
});

test("AG4: prose that is not an echo is kept as prose", () => {
  const html = normalizeResumeHtml(wrapEntry(`
  <div class="entry-header"><div><span class="entry-org">Meridian Systems</span></div></div>
  <div class="entry-role">Consultant</div>
  <div>Engaged on a six-month retainer to review the payments ledger architecture.</div>
  <ul class="bullets"><li>Delivered a migration plan adopted by three teams.</li></ul>`));
  assert.match(html, /Engaged on a six-month retainer/);
  assert.match(html, /Delivered a migration plan adopted by three teams/);
  assert.deepEqual(duplicatedLinesPerEntry(html), []);
});

// ── G3 — the shape the MODEL writes, not the shape the renderer writes ─────────────────────────
//
// WHY EVERY TEST ABOVE STAYED GREEN WHILE THIS SHIPPED
// Two reasons, and both are in this file rather than in the code under test:
//  1. Every fixture above is written in renderEntry's OWN vocabulary — entry-date as a div,
//     entry-role as a sibling of the header, entry-meta inside it. The prompt names the classes and
//     never the structure, and the model does not write that structure. The fixtures exercised a
//     parser reading its own output.
//  2. duplicatedLinesPerEntry only counts lines that are IDENTICAL. "Stripe | Software Development
//     Engineer" and "Software Development Engineer" are different lines, so a role printed in the
//     header and again beneath it reads as clean. And nothing asserted that content was KEPT, so a
//     date dropped outright was invisible to a duplication check by construction.
// So these assert the behaviour itself — every field of the source shows exactly ONCE — against
// entries copied from real generations captured 09-30 through the live prompt.

/** The visible text of the first entry, as one string. */
function entryText(html) {
  const entry = String(html).split('<div class="entry">')[1] || "";
  return entry.split('<div class="section-title">')[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** Each field of the source entry renders exactly once — neither lost nor repeated. */
function assertEachFieldOnce(html, fields) {
  const text = entryText(html);
  for (const field of fields) {
    assert.equal(occurrences(text, field), 1, `"${field}" should render once; rendered ${occurrences(text, field)} times in: ${text.slice(0, 200)}`);
  }
}

test("G3: a role nested INSIDE entry-org is read as the role, not printed in the header too", () => {
  // Captured verbatim (bullets trimmed) from a real generation on the owner's résumé, 09-30.
  const html = normalizeResumeHtml(wrapEntry(`
<div class="entry-header">
<span class="entry-org">Stripe <span class="sep">|</span> <span class="entry-role">Software Development Engineer</span></span>
<span class="entry-date">Aug 2022 - Dec 2023</span>
</div>
<div class="entry-meta">Payments Infrastructure, Bangalore</div>
<ul class="bullets">
<li>Built scalable <b>microservices</b> for real-time payment processing handling <b>1M+ daily transactions</b></li>
</ul>`));
  assertEachFieldOnce(html, ["Stripe", "Software Development Engineer", "Aug 2022 - Dec 2023", "Payments Infrastructure, Bangalore"]);
  assert.match(html, /<span class="entry-org">Stripe<\/span>/, "the org is the org alone");
  assert.equal(normalizeResumeHtml(html), html, "and the result is a fixed point");
});

test("G3: a date written as a <span class=entry-date> is kept — it was dropped from every entry", () => {
  // Captured from a real generation on a synthetic résumé, 09-30. Every date in BOTH captured
  // documents was lost (10 of 10, 3 of 3) because the date was only ever looked for in a div.
  const html = normalizeResumeHtml(wrapEntry(`
<div class="entry-header">
<span class="entry-org">Stripe</span>
<span class="entry-date">2021 - 2025</span>
</div>
<div class="entry-meta">Austin, TX</div>
<div class="entry-role">Software Engineer</div>
<ul class="bullets"><li>Built payment services in Go handling 2k requests/second</li></ul>`));
  assertEachFieldOnce(html, ["Stripe", "Software Engineer", "2021 - 2025", "Austin, TX"]);
  assert.match(html, /<div class="entry-date">2021 - 2025<\/div>/);
});

test("G3: a field outside the header is read once, and a SECOND one of the same class is kept", () => {
  // The date as a sibling AFTER the header must be read as the date, not left as body copy. And a
  // second entry-meta, which no field holds, must survive: removing every element of a field's class
  // would trade a duplication for a loss.
  const html = normalizeResumeHtml(wrapEntry(`
<div class="entry-header"><span class="entry-org">Amazon <span class="entry-meta">Supply Chain</span></span></div>
<span class="entry-date">Jan 2021 - Jul 2022</span>
<div class="entry-meta">Supply Chain &amp; Internal Developer Tools, Hyderabad</div>
<div class="entry-role">Software Development Engineer</div>
<ul class="bullets"><li>Built and operated cloud-native microservices on AWS.</li></ul>`));
  assertEachFieldOnce(html, ["Amazon", "Jan 2021 - Jul 2022", "Software Development Engineer", "Internal Developer Tools, Hyderabad"]);
  assert.match(html, /<span class="entry-org">Amazon<\/span>/, "a meta nested in the org is not part of the org");
  assert.match(html, /<div class="entry-date">Jan 2021 - Jul 2022<\/div>/, "the date is the date, not body copy");
});
