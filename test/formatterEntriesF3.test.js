// F3 (10-03): the formatter pooled every job's bullets under the first job when a pasted résumé had
// no blank line between jobs — the shape the site's Format tool invites ("one line per heading, role
// or bullet"). A bullet then read as the wrong employer's.
import test from "node:test";
import assert from "node:assert/strict";
import { buildStructuredResume } from "../src/formatting/resumeFormatter.js";

const experience = (structure) => structure.sections.find(s => s.title === "EXPERIENCE").entries;

for (const [shape, raw] of [
  ["plain text", "Jordan Example\nj@example.com\nEXPERIENCE\nNorthwind — Senior Software Engineer\n2021 – 2025\n- Built the ledger.\n- Led the migration.\nFabrikam — Software Engineer\n2018 – 2021\n- Wrote the pipeline."],
  ["generic HTML", "<h1>Jordan Example</h1><p>j@example.com</p><h2>Experience</h2><h3>Northwind — Senior Software Engineer</h3><p>2021 – 2025</p><ul><li>Built the ledger.</li><li>Led the migration.</li></ul><h3>Fabrikam — Software Engineer</h3><p>2018 – 2021</p><ul><li>Wrote the pipeline.</li></ul>"],
]) {
  test(`${shape}: each job keeps its own bullets and its own date, with no blank line between jobs`, () => {
    const jobs = experience(buildStructuredResume(raw));
    assert.equal(jobs.length, 2, JSON.stringify(jobs));
    assert.match(jobs[0].company, /Northwind/);
    assert.equal(jobs[0].date, "2021 – 2025");
    assert.deepEqual(jobs[0].bullets, ["Built the ledger.", "Led the migration."]);
    assert.match(jobs[1].company, /Fabrikam/);
    assert.equal(jobs[1].date, "2018 – 2021");
    assert.deepEqual(jobs[1].bullets, ["Wrote the pipeline."]);
    assert.doesNotMatch(jobs[0].text || "", /Fabrikam/, "a later job's header is never folded into an earlier entry");
  });
}

test("a date on the header line is still read, years or months; a role line is not mistaken for a date", () => {
  const jobs = experience(buildStructuredResume("EXPERIENCE\nAcme | Jan 2020 – Present\nStaff Engineer\n- Ran the platform.\nInitech 2016 – 2019\nAnalyst\n- Wrote reports."));
  assert.deepEqual(jobs.map(j => [j.company, j.date, j.role]), [["Acme", "Jan 2020 – Present", "Staff Engineer"], ["Initech", "2016 – 2019", "Analyst"]]);
});

test("blank-line-separated entries are split exactly as before", () => {
  const jobs = experience(buildStructuredResume("EXPERIENCE\nAcme\nEngineer\n- One.\n\nInitech\nAnalyst\n- Two."));
  assert.deepEqual(jobs.map(j => [j.company, j.role, j.bullets]), [["Acme", "Engineer", ["One."]], ["Initech", "Analyst", ["Two."]]]);
});
